/**
 * Which file a task's Files tab was showing, per run, for THIS browser tab (#453 B8, G-40).
 *
 * Picking a file, stepping over to Changes or Session and coming back used to reset the preview to
 * "Select a file": the selection lived in `useState` in a route the navigation unmounts. Every
 * other Git tab keeps what the reader was looking at, so this keeps the reader's place.
 *
 * `sessionStorage`, not the workspace file and not `localStorage`, and that choice is the whole
 * design: "the file I was just looking at" describes ONE browsing session in ONE tab, the same
 * stance `lib/last-location.ts` takes for the remembered location. It needs no server round trip,
 * no contract field and no migration — a reader who closes the tab starts clean, which is what
 * they would expect.
 *
 * Every read is validated and every write is best-effort: private mode, a full quota or a
 * hand-edited value must never break the Files tab, so a bad value reads as "no selection".
 */

const KEY_PREFIX = 'xez-files-tab-selection:'

/** A worktree-relative path. Long enough for a deep tree, short enough not to be a payload. */
const MAX_PATH_LENGTH = 1_024

function storageKey(runId: string): string {
  return `${KEY_PREFIX}${runId}`
}

/**
 * A stored path is usable only if it still looks like the relative path the tree hands out. An
 * absolute path or a `..` segment is not something the tree can select, so it is not something
 * this helper will hand back — it would put the preview into a permanent error state that the
 * reader cannot clear by picking another file.
 */
export function isSelectablePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !value.startsWith('/') &&
    !value.split('/').includes('..')
  )
}

export function readFilesTabSelection(runId: string): string | null {
  try {
    const raw = sessionStorage.getItem(storageKey(runId))
    return isSelectablePath(raw) ? raw : null
  } catch {
    // No storage at all (private mode, a sandboxed frame) — the tab simply does not remember.
    return null
  }
}

/** `null` clears the remembered file, so closing a preview is remembered as "nothing picked". */
export function writeFilesTabSelection(runId: string, path: string | null): void {
  try {
    if (path === null) sessionStorage.removeItem(storageKey(runId))
    else if (isSelectablePath(path)) sessionStorage.setItem(storageKey(runId), path)
  } catch {
    // Quota or private mode — the selection still works for as long as the route stays mounted.
  }
}
