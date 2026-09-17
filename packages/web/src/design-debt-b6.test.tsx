import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { useState, type ComponentProps, type ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { Diff, type DiffFileChange } from '@/components/diff'
import { ImagePreview } from '@/components/diff/image-preview'
import { RunDiff, splitRunDiff } from '@/components/run-diff'
import { resetToasts, Toaster } from '@/components/ui/toaster'
import type { ApiRun } from '@qodeca/xezar-api-client'
import { formatBytes } from '@/lib/tasks-table'
import { CommitDialog } from '@/routes/task-git/commit-dialog'
import { CommitList } from '@/routes/task-git/commit-list'
import { formatFileSize } from '@/routes/task-git/worktree-files'
import { ReviewPanel } from '@/routes/task-thread/review-panel'

/**
 * Design-debt batch B6 — Git tabs and the shared diff renderer (#453, AC-6 / T-6). The ONE diff
 * engine behind `RunDiff`, the patch shapes it must keep (copied, renamed, binary, empty,
 * malformed, longer than the old 300-line clamp), split and word rendering, file-size precision,
 * the commit dialog's cancel path and the Git pages' class contracts, in jsdom. jsdom has no
 * layout: the 44 px geometry at every density is measured in `packages/web/e2e/design-debt-b6.e2e.ts`.
 */

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

const SRC = resolve(import.meta.dirname)
const source = (rel: string) => readFileSync(join(SRC, rel), 'utf8')
const classes = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/)
const PHONE_ROW = ['min-h-tap', 'md:min-h-0']

/** Every file this batch owns, for the source contracts below. */
const B6_FILES = [
  'components/diff/diff-view.tsx',
  'lib/page-header-offset.ts',
  'components/diff/image-preview.tsx',
  'components/run-diff.tsx',
  'routes/repo-git/repo-branches.tsx',
  'routes/repo-git/repo-changes.tsx',
  'routes/repo-git/repo-commits.tsx',
  'routes/repo-git/repo-git.tsx',
  'routes/repo-git/repo-git-loading.tsx',
  'routes/task-git/changes-tree.tsx',
  'routes/task-git/commit-dialog.tsx',
  'routes/task-git/commit-list.tsx',
  'routes/task-git/diff-controls.tsx',
  'routes/task-git/files-tree.tsx',
  'routes/task-git/git-tab-loading.tsx',
  'routes/task-git/git-toolbar.tsx',
  'routes/task-git/task-changes.tsx',
  'routes/task-git/task-commits.tsx',
  'routes/task-git/task-files.tsx',
  'routes/task-git/worktree-files.ts',
]
/** The Git pages restyled onto the #424 rhythm (the diff engine's own internals are not a page). */
const GIT_PAGES = B6_FILES.filter((rel) => rel.startsWith('routes/'))

// ---- fixtures -----------------------------------------------------------------------------------

const header = (path: string, ...meta: string[]) => [`diff --git a/${path} b/${path}`, ...meta]

/** A copy, a rename, a binary, an addition, a deletion, a mode-only change and a plain edit. */
const MIXED = [
  'diff --git a/src/base.ts b/src/copy.ts',
  'similarity index 90%',
  'copy from src/base.ts',
  'copy to src/copy.ts',
  'index 1111111..2222222 100644',
  '--- a/src/base.ts',
  '+++ b/src/copy.ts',
  '@@ -1,2 +1,2 @@',
  ' export const kind = "base"',
  '-export const size = 1',
  '+export const size = 2',
  'diff --git a/old/name.ts b/new/name.ts',
  'similarity index 100%',
  'rename from old/name.ts',
  'rename to new/name.ts',
  ...header('logo.png', 'index 3333333..4444444 100644', 'Binary files a/logo.png and b/logo.png differ'),
  ...header('NEW.md', 'new file mode 100644', 'index 0000000..5555555', '--- /dev/null', '+++ b/NEW.md', '@@ -0,0 +1 @@', '+hello'),
  ...header('gone.txt', 'deleted file mode 100644', 'index 6666666..0000000', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye'),
  ...header('run.sh', 'old mode 100644', 'new mode 100755'),
  '',
].join('\n')

/** One file whose hunk is longer than the old renderer's 300-line clamp. */
const LONG_LINES = 420
const LONG = [
  ...header('big.txt', 'index 7777777..8888888 100644', '--- a/big.txt', '+++ b/big.txt', `@@ -0,0 +1,${LONG_LINES} @@`),
  ...Array.from({ length: LONG_LINES }, (_, index) => `+line ${index + 1}`),
  '',
].join('\n')

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubDiff(answer: () => Response) {
  const sent: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      sent.push(`${init?.method ?? 'GET'} ${path}`)
      if (path === '/api/v1/runs/r1/diff') return answer()
      if (path === '/api/v1/runs') return json([])
      return json({})
    }),
  )
  return sent
}

function renderWithProviders(ui: ReactElement) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        {ui}
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const run = (extra: Partial<ApiRun> = {}): ApiRun =>
  ({
    id: 'r1',
    title: 'Batch six',
    workflow: 'quick-task',
    task: 'Batch six',
    status: 'review',
    createdAt: '2026-09-17T12:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    branch: 'xez/b6',
    worktreePath: '/tmp/wt',
    steps: [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 's-1' }],
    ...extra,
  }) as ApiRun

// ---- C1: the one engine ---------------------------------------------------------------------------

describe('C1 / G-09 RunDiff is a facade over the one diff engine', () => {
  it('keeps its public API: a component taking exactly a run id', () => {
    const props: ComponentProps<typeof RunDiff> = { runId: 'r1' }
    expect(Object.keys(props)).toEqual(['runId'])
    expect(RunDiff.length).toBeLessThanOrEqual(1)
  })

  it('renders through `Diff` and parses no hunks, highlights nothing and clamps nothing itself', () => {
    const facade = source('components/run-diff.tsx')
    expect(facade).toMatch(/import \{ Diff, type DiffFileChange \} from '@\/components\/diff'/)
    expect(facade).toMatch(/<Diff /)
    const code = facade.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
    expect(code).not.toMatch(/from '[^']*(highlighter|unified-diff|parse-patch|word-diff|diff-view)'|bg-diff-|DIFF_CLAMP|FILE_CAP|\.slice\(0, /)
    // The old whole-diff parser is gone, so nothing can drift back onto it.
    expect(existsSync(join(SRC, 'lib/unified-diff.ts'))).toBe(false)
  })

  it('no module outside the engine reaches past its public surface', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !path.includes(`${SRC}/components/diff/`)) {
          if (/from '@\/components\/diff\/(parse-patch|word-diff|diff-view)'/.test(readFileSync(path, 'utf8'))) offenders.push(path.slice(SRC.length + 1))
        }
      }
    }
    walk(SRC)
    expect(offenders).toEqual([])
  })

  it('both B5 consumers still mount RunDiff (unmodified) and nothing else diff-shaped', () => {
    for (const rel of ['routes/task-thread/review-panel.tsx', 'routes/compare-variants.tsx']) {
      const text = source(rel)
      expect(text, rel).toMatch(/import \{ RunDiff \} from '@\/components\/run-diff'/)
      expect(text, rel).not.toMatch(/@\/components\/diff'|unified-diff/)
    }
  })
})

describe('C2 / T-6 the patch shapes survive the split', () => {
  it('copied, renamed, binary, added, deleted, mode-only and edited files', () => {
    const { files, truncated } = splitRunDiff(MIXED)
    expect(truncated).toBe(false)
    expect(files.map(({ path, oldPath, status, adds, dels, binary }) => ({ path, oldPath, status, adds, dels, binary }))).toEqual([
      { path: 'src/copy.ts', oldPath: 'src/base.ts', status: 'copied', adds: 1, dels: 1, binary: undefined },
      { path: 'new/name.ts', oldPath: 'old/name.ts', status: 'renamed', adds: 0, dels: 0, binary: undefined },
      { path: 'logo.png', oldPath: undefined, status: 'modified', adds: 0, dels: 0, binary: true },
      { path: 'NEW.md', oldPath: undefined, status: 'added', adds: 1, dels: 0, binary: undefined },
      { path: 'gone.txt', oldPath: undefined, status: 'deleted', adds: 0, dels: 1, binary: undefined },
      { path: 'run.sh', oldPath: undefined, status: 'modified', adds: 0, dels: 0, binary: undefined },
    ])
    // The section text is handed over whole, for the engine to parse; no hunks means no text diff.
    expect(files[0]!.patch).toContain('@@ -1,2 +1,2 @@')
    expect(files[0]!.patch.startsWith('diff --git a/src/base.ts b/src/copy.ts\n')).toBe(true)
    expect(files[1]!.patch).toBe('')
    expect(files[5]!.patch).toBe('')
  })

  it('a hunk line that looks like a header still counts as content', () => {
    const { files } = splitRunDiff([...header('a.md', '--- a/a.md', '+++ b/a.md', '@@ -1,2 +1,2 @@'), '--- rule', '+++ rule', ''].join('\n'))
    expect(files[0]).toMatchObject({ path: 'a.md', adds: 1, dels: 1 })
  })

  it('the server’s own sentences and malformed text are not a diff', () => {
    expect(splitRunDiff('(no worktree — this task ran directly in the repo working tree)').files).toEqual([])
    expect(splitRunDiff('(diff failed: fatal: bad revision)').files).toEqual([])
    expect(splitRunDiff('').files).toEqual([])
    expect(splitRunDiff('@@ -1 +1 @@\n-orphan hunk with no file header\n+x').files).toEqual([])
  })

  it('a quoted path and a whole-diff cap', () => {
    const { files, truncated } = splitRunDiff(['diff --git "a/with space.txt" "b/with space.txt"', '--- "a/with space.txt"', '+++ "b/with space.txt"', '@@ -1 +1 @@', '-a', '+b', '… (diff truncated)'].join('\n'))
    expect(truncated).toBe(true)
    expect(files[0]!.path).toBe('with space.txt')
    // Handed to the engine as ITS truncation marker, never as a line of content.
    expect(files[0]!.patch).toContain('… (patch truncated)')
    expect(files[0]!.adds).toBe(1)
  })
})

describe('C3 / T-6 the review gate renders the engine: every line, badges, words', () => {
  it('all lines of a patch longer than the old 300-line clamp, with gutters and no “Show all” toggle', async () => {
    stubDiff(() => new Response(LONG, { status: 200 }))
    renderWithProviders(<RunDiff runId="r1" />)
    await waitFor(() => expect(document.querySelectorAll('[data-slot="diff-line"]')).toHaveLength(LONG_LINES))
    const last = [...document.querySelectorAll('[data-slot="diff-line"]')].at(-1)!
    expect(last.textContent).toContain(`line ${LONG_LINES}`)
    expect(last.textContent).toContain(String(LONG_LINES)) // the new-side gutter number
    expect(document.querySelector('[data-slot="run-diff"]')?.textContent).toContain('1 file changed')
    expect(screen.queryByText(/Show all \d+ lines/)).toBeNull()
  })

  it('copied, renamed and binary badges; word marks on a changed pair; the metadata-only note', async () => {
    stubDiff(() => new Response(MIXED, { status: 200 }))
    renderWithProviders(<ReviewPanel run={run()} />)
    await waitFor(() => expect(document.querySelectorAll('[data-slot="diff-file"]')).toHaveLength(6))
    const card = (path: string) => [...document.querySelectorAll('[data-slot="diff-file"]')].find((el) => (el as HTMLElement).dataset.path === path)!
    expect(card('src/copy.ts').textContent).toContain('src/base.ts → src/copy.ts')
    expect(card('src/copy.ts').querySelector('header')?.textContent).toContain('copied')
    expect(card('new/name.ts').querySelector('header')?.textContent).toContain('renamed')
    expect(card('logo.png').textContent).toContain('binary')
    expect(card('logo.png').textContent).toContain('Binary file — no text diff.')
    expect(card('run.sh').textContent).toContain('No content changes (metadata only).')
    expect(card('src/copy.ts').querySelector('[data-word="add"]')?.textContent).toBe('2')
    expect(card('src/copy.ts').querySelector('[data-word="del"]')?.textContent).toBe('1')
  })

  it('a failed load is an error, never an empty diff', async () => {
    stubDiff(() => json({ error: 'this task belongs to another project' }, 409))
    renderWithProviders(<RunDiff runId="r1" />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('this task belongs to another project')
    expect(document.querySelector('[data-slot="run-diff-empty"]')).toBeNull()
  })

  it('a capped diff says the counts are partial', async () => {
    stubDiff(() => new Response(`${LONG}… (diff truncated)`, { status: 200 }))
    renderWithProviders(<RunDiff runId="r1" />)
    expect((await screen.findByText(/cut this diff short/)).textContent).toContain('counts cover only the part shown')
  })
})

describe('C4 / T-6 split and word rendering on the engine', () => {
  it('split mode pairs the changed lines side by side and keeps the word marks', async () => {
    const [copy] = splitRunDiff(MIXED).files
    render(<Diff files={[copy!]} mode="split" />)
    await waitFor(() => expect(document.querySelector('[data-slot="diff-pair"]')).not.toBeNull())
    const changed = [...document.querySelectorAll('[data-slot="diff-pair"]')].find((pair) => pair.querySelector('[data-line="del"]'))!
    expect(changed.querySelector('[data-line="add"]')).not.toBeNull()
    expect(changed.querySelector('[data-word="del"]')?.textContent).toBe('1')
    expect(changed.querySelector('[data-word="add"]')?.textContent).toBe('2')
  })
})

// ---- C5: byte precision ------------------------------------------------------------------------------

describe('C5 / G-18 file sizes keep their own precision through the one formatter', () => {
  it('the Files tab formats through `formatBytes(…, "file")`, byte for byte', () => {
    for (const bytes of [0, 1, 312, 1023, 1024, 1536, 4700, 1024 ** 2 - 1, 1024 ** 2 + 200_000, 5 * 1024 ** 3]) {
      expect(formatFileSize(bytes), String(bytes)).toBe(formatBytes(bytes, 'file'))
    }
    expect(source('routes/task-git/worktree-files.ts')).toMatch(/formatBytes\(bytes, 'file'\)/)
  })

  it('sub-kB bytes and one decimal survive — never the memory rounding', () => {
    expect([formatFileSize(312), formatFileSize(4700), formatFileSize(1536), formatFileSize(1024 ** 2 + 200_000)]).toEqual(['312 B', '4.6 kB', '1.5 kB', '1.2 MB'])
    expect(formatBytes(4700, 'memory')).toBe('5 kB')
  })
})

// ---- C6: phone targets, rhythm, motion, copy ---------------------------------------------------------

describe('C6 / Q07–Q73 phone targets in the diff and the Git tabs', () => {
  it('the diff file header and an expandable gap are 44 px rows on a phone', async () => {
    const [copy] = splitRunDiff(MIXED).files
    render(<Diff files={[{ ...copy!, patch: copy!.patch.replace('@@ -1,2 +1,2 @@', '@@ -5,2 +5,2 @@') }]} loadFileText={async () => null} />)
    const toggle = await screen.findByRole('button', { name: /src\/copy\.ts/ })
    expect(toggle.dataset.slot).toBe('diff-file-header')
    expect(classes(toggle)).toEqual(expect.arrayContaining(PHONE_ROW))
    expect(classes(document.querySelector('button[data-slot="diff-gap"]'))).toEqual(expect.arrayContaining(PHONE_ROW))
  })

  it('the image preview’s “Open in default app” is a 44 px target', () => {
    const file: DiffFileChange = { path: 'logo.png', status: 'modified', adds: 0, dels: 0, binary: true, image: true, patch: '' }
    render(<ImagePreview file={file} imageSrc={() => '/raw/logo.png'} onOpenInApp={() => {}} />)
    expect(classes(screen.getByRole('button', { name: 'Open in default app' }))).toEqual(
      expect.arrayContaining(['min-h-tap', 'min-w-tap', 'md:min-h-0', 'md:min-w-0']),
    )
  })

  it('a commit row is a 44 px link on a phone', () => {
    render(
      <MemoryRouter>
        <CommitList slot="commits" commits={[{ sha: 'abc', shaLabel: 'abc', subject: 'One', author: 'me', when: 'now', href: '/c/abc' }]} />
      </MemoryRouter>,
    )
    expect(classes(screen.getByRole('link', { name: /One/ }))).toEqual(expect.arrayContaining(PHONE_ROW))
  })

  it('the file tree rows, the PR rows and the base-branch select carry the phone floor', () => {
    expect(source('routes/task-git/files-tree.tsx').match(/min-h-tap w-full min-w-0 items-center/g)).toHaveLength(2)
    expect(source('routes/repo-git/repo-branches.tsx')).toMatch(/const rowClass = 'flex min-h-tap .* md:min-h-0'/)
    // G-11: the shared native-field string, not a hand-copied one.
    expect(source('routes/repo-git/repo-branches.tsx')).toMatch(/className=\{cn\(nativeFieldClass, /)
  })
})

describe('C7 / G-01 D-03 the Git pages sit on the #424 rhythm', () => {
  it('no hand-set gutter, gap or header variant is left', () => {
    const offenders = GIT_PAGES.flatMap((rel) =>
      [...source(rel).matchAll(/\b(?:md:px-6|md:px-4|px-4 py-4|gap-5|gap-6|gap-x-2\.5|mt-2\.5|pt-3|backdrop-blur|text-lg)\b/g)].map((m) => `${rel}: ${m[0]}`),
    )
    expect(offenders).toEqual([])
  })

  it('page bodies use the canonical body spelling and toolbars the section gutter', () => {
    for (const rel of ['routes/repo-git/repo-changes.tsx', 'routes/task-git/task-changes.tsx', 'routes/task-git/task-files.tsx', 'routes/repo-git/repo-branches.tsx']) {
      expect(source(rel), rel).toMatch(/p-4 .*md:p-section/)
    }
    for (const rel of ['routes/task-git/git-toolbar.tsx', 'routes/repo-git/repo-changes.tsx', 'routes/repo-git/repo-commits.tsx', 'routes/task-git/task-commits.tsx']) {
      expect(source(rel), rel).toMatch(/px-4 py-2 md:px-section/)
    }
    expect(source('routes/repo-git/repo-git.tsx')).toMatch(/md:px-section md:pt-group/)
    expect(source('routes/repo-git/repo-git.tsx')).toMatch(/<h1 className="sr-only text-base font-semibold md:not-sr-only">Git<\/h1>/)
  })
})

describe('C8 reduced motion, honest clipboard, copy', () => {
  it('no chevron turns under reduced motion', () => {
    const bare = B6_FILES.flatMap((rel) => [...source(rel).matchAll(/(?<![\w:-])transition-transform\b/g)].map(() => rel))
    expect(bare).toEqual([])
  })

  it('diff line numbers wear full ink, not a washed-out alpha (contrast)', () => {
    const gutter = source('components/diff/diff-view.tsx').match(/function Gutter[\s\S]*?className="([^"]+)"/)
    expect(gutter?.[1]).toContain('text-soft-foreground')
    expect(gutter?.[1]).not.toMatch(/text-soft-foreground\/\d+/)
  })

  it('the Git tabs copy only through the shared helper', () => {
    expect(B6_FILES.filter((rel) => /navigator\.clipboard/.test(source(rel)))).toEqual([])
  })

  it('apostrophes in the copy are curly', () => {
    const offenders = B6_FILES.flatMap((rel) =>
      source(rel)
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .filter((line) => /&apos;|(?:subtitle|title)="[^"]*\w'\w/.test(line))
        .map((line) => `${rel}: ${line.trim()}`),
    )
    expect(offenders).toEqual([])
  })
})

// ---- C9: cancel -----------------------------------------------------------------------------------

describe('C9 the commit dialog cancels without committing', () => {
  it('Cancel closes and sends nothing; Escape does the same', async () => {
    const sent = stubDiff(() => new Response('', { status: 200 }))
    const onOpenChange = vi.fn()
    renderWithProviders(<CommitDialog run={run()} open onOpenChange={onOpenChange} />)
    const field = await screen.findByRole('textbox', { name: 'Commit message' })
    expect((field as HTMLTextAreaElement).value).toBe('Batch six')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(sent.filter((request) => request.startsWith('POST'))).toEqual([])
    expect(screen.getByText(/Stages everything in the task’s worktree/)).not.toBeNull()
  })

  it('hands keyboard focus back to the button that opened it', async () => {
    stubDiff(() => new Response('', { status: 200 }))
    function Opener() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Commit
          </button>
          <CommitDialog run={run()} open={open} onOpenChange={setOpen} />
        </>
      )
    }
    renderWithProviders(<Opener />)
    const opener = screen.getByRole('button', { name: 'Commit' })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(opener)
  })
})
