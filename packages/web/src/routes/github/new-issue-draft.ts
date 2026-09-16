/**
 * The New issue brief, persisted — localStorage-backed like `hand-to-agent-draft.ts` and
 * `new-task-draft.ts`, the same store-per-file convention.
 *
 * It is a store rather than component state because every state of the dialog has to keep what
 * was typed: closing it, pressing Escape, reloading the page, a start the server refused, and the
 * skill turning out not to be installed. Component state survives none of those.
 *
 * Keyed by PROJECT, because the task is created in that project and two projects share one
 * `localhost:<port>` origin and therefore this storage. Empty text removes the entry, so a dialog
 * opened and closed without typing leaves no trace.
 *
 * Degrades to "nothing remembered" in private mode or on a full quota — never a throw.
 */

const KEY_PREFIX = 'xez-new-issue-brief:'

const key = (projectId: string | null): string => `${KEY_PREFIX}${projectId ?? 'default'}`

/** '' when nothing is stored — a dialog never touched, or one whose task has been started. */
export function readIssueBrief(projectId: string | null): string {
  try {
    return localStorage.getItem(key(projectId)) ?? ''
  } catch {
    return ''
  }
}

export function writeIssueBrief(projectId: string | null, brief: string): void {
  try {
    if (brief === '') localStorage.removeItem(key(projectId))
    else localStorage.setItem(key(projectId), brief)
  } catch {
    // Storage disabled or full — the box still works this session, it is just not remembered.
  }
}
