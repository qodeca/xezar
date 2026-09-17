import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'

import { queryKeys, useRunDiff } from '@/api/queries'
import { Diff, type DiffFileChange } from '@/components/diff'

/**
 * A run's worktree diff (`GET /api/runs/:id/diff`) — shared by the review gate and the variants
 * compare view, so "the same diff rendering" is one component rather than a convention.
 *
 * A thin compatibility facade over the ONE diff engine (#453 B6, G-09): the public API is still
 * just a run id, and the rendering — gutters, word marks, copied/renamed/binary badges, every
 * line of every file — is `<Diff>` from `@/components/diff`, exactly what the Git tabs render.
 * The only thing this module does itself is cut the endpoint's unified text into the facade's
 * per-file `DiffFileChange` shape; hunk parsing, highlighting and line rendering stay in the
 * engine, never here.
 */

/** `worktreeDiff`'s whole-diff cap marker (src/git-worktree.ts). */
const DIFF_TRUNCATION_MARKER = '… (diff truncated)'
/** The engine's per-file cap marker (`parse-patch.ts`), which it turns into an honest note. */
const PATCH_TRUNCATION_MARKER = '… (patch truncated)'

export function RunDiff({ runId }: { runId: string }) {
  const queryClient = useQueryClient()
  const diff = useRunDiff(runId)
  // Legacy parity (web/app.js: the review panel "(re)loads the diff on each entry"): both
  // consumers mount this exactly when the reader enters the surface — marking the cached diff
  // stale here refetches it on every re-entry, never showing a pre-send-back diff after the
  // agent worked again.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.runs.diff(runId) })
  }, [queryClient, runId])

  const split = useMemo(() => splitRunDiff(diff.data ?? ''), [diff.data])

  if (diff.isPending) {
    return <p className="px-1 text-xs text-soft-foreground">Loading diff…</p>
  }
  if (diff.isError) {
    return (
      <p role="alert" className="px-1 text-xs text-danger">
        {diff.error.message}
      </p>
    )
  }
  if (split.files.length === 0) {
    // Not a diff: the server's own sentence ("(no worktree — …)", "(diff failed …)") or an
    // empty answer. Show its words — they were written for the reader.
    return (
      <p data-slot="run-diff-empty" className="px-1 font-mono text-xs text-soft-foreground">
        {diff.data.trim() || '(no changes)'}
      </p>
    )
  }

  return (
    <div data-slot="run-diff" className="flex min-w-0 flex-col gap-row">
      {split.truncated ? (
        <p data-slot="run-diff-truncated" className="px-1 text-xs text-soft-foreground">
          The server cut this diff short — the counts cover only the part shown.
        </p>
      ) : null}
      <Diff files={split.files} className="min-w-0" />
    </div>
  )
}

/**
 * The endpoint's `git diff` text → the facade's files. Exported for its tests only.
 *
 * Reads each `diff --git` section's extended header — rename, copy, new, deleted, binary — and
 * counts its `+`/`-` hunk lines, then hands the section text over untouched as `patch`. Anything
 * before the first header (or text with no header at all: the server's "(no worktree — …)"
 * sentence) is not a diff and yields no files.
 */
export function splitRunDiff(text: string): { files: DiffFileChange[]; truncated: boolean } {
  const lines = text.split('\n')
  // git ends the diff with a newline; the split leaves a phantom ''.
  if (lines.at(-1) === '') lines.pop()
  let truncated = false
  if (lines.at(-1) === DIFF_TRUNCATION_MARKER) {
    truncated = true
    lines[lines.length - 1] = PATCH_TRUNCATION_MARKER
  }

  const files: DiffFileChange[] = []
  let current: { file: DiffFileChange; lines: string[]; inHunks: boolean } | null = null
  const close = () => {
    if (current) current.file.patch = `${current.lines.join('\n')}\n`
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      close()
      current = { file: { path: pathFromHeader(line), status: 'modified', adds: 0, dels: 0, patch: '' }, lines: [line], inHunks: false }
      files.push(current.file)
      continue
    }
    if (!current) continue
    current.lines.push(line)
    const { file } = current
    if (current.inHunks || line.startsWith('@@')) {
      current.inHunks = true
      if (line.startsWith('+')) file.adds += 1
      else if (line.startsWith('-')) file.dels += 1
      continue
    }
    // Extended header: rename/copy/mode/binary metadata plus the ---/+++ markers.
    if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
      file.status = line.startsWith('rename') ? 'renamed' : 'copied'
      file.oldPath = unquote(line.slice(line.indexOf(' from ') + 6))
    } else if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      file.status = line.startsWith('rename') ? 'renamed' : 'copied'
      file.path = unquote(line.slice(line.indexOf(' to ') + 4))
    } else if (line.startsWith('new file mode')) {
      file.status = 'added'
    } else if (line.startsWith('deleted file mode')) {
      file.status = 'deleted'
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      file.binary = true
    } else if (line.startsWith('+++ ')) {
      const path = pathFromMarker(line)
      if (path !== undefined) file.path = path
    } else if (line.startsWith('--- ')) {
      // A deletion has `+++ /dev/null`; the honest display path is the old one.
      const path = pathFromMarker(line)
      if (path !== undefined && file.status === 'deleted') file.path = path
    }
  }
  close()
  // A section with no hunks carries no text diff: the engine shows its metadata-only note.
  for (const file of files) if (!/^@@/m.test(file.patch)) file.patch = ''
  return { files, truncated }
}

/** `diff --git a/old b/new` → the `b/` path. Paths with spaces make the split ambiguous — this
 *  is the last resort; `+++ b/…`, `rename to` and `copy to` are read first where present. */
function pathFromHeader(header: string): string {
  const rest = header.slice('diff --git '.length)
  const bIndex = rest.lastIndexOf(' b/')
  return unquote(bIndex >= 0 ? rest.slice(bIndex + 3) : rest)
}

/** Git quotes paths with special characters (`"a/with \"quote\".txt"`). */
function unquote(path: string): string {
  const trimmed = path.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  return trimmed
}

/** `+++ b/path` / `--- a/path` → path, or undefined for `/dev/null`. */
function pathFromMarker(line: string): string | undefined {
  const raw = unquote(line.slice(4))
  if (raw === '/dev/null') return undefined
  return raw.replace(/^[ab]\//, '')
}
