import type { RunIndexEntry, RunsIndexResponse } from '@qodeca/xezar-api-client'

/**
 * The workspace attention read model: "which tasks, in which project, want a person right now".
 *
 * ONE model for every surface that answers that question across projects — the sidebar's
 * per-project badges (expanded AND collapsed groups), the "All tasks" badge, the browser tab
 * title and the browser notifications. Before it, each surface read whatever run list happened
 * to be cached for it, and only the project on screen was ever kept live: another project's
 * badge froze at its expand-time fetch, a collapsed group fetched nothing, and a notification
 * could only fire for the project the tab opened in.
 *
 * Built from the cross-project runs index (`GET /api/v1/workspace/runs-index`), which is the
 * one answer that spans the registry in one request. It is kept live by the global event stream
 * (`api/global-events.tsx`): every project's `run` event patches the matching row in place
 * (`applyRunToIndex` in `api/events.ts`) and schedules a debounced refetch, and `reconcile()`
 * refetches it on reconnect and when the tab comes back.
 *
 * Pure and React-free so the counting rule is table-testable; the hook lives in `api/queries.ts`.
 *
 * Complete beyond the row cap: the index carries only each project's newest `perProjectLimit`
 * rows, so the server also sends `attention[project].beyondLimit` — the tasks that need you among
 * the runs it did NOT ship as rows. The count is the live rows plus that tail.
 *
 * When the index cannot be read, `resolveAttentionCounts` falls back to the active project's own
 * run list for that project and marks every other count stale rather than showing a zero.
 */

/** The fields of an index row this model reads. `Pick`ed so a test (or a future source) can
 *  build rows without the whole `RunIndexEntry`. */
export type AttentionRow = Pick<
  RunIndexEntry,
  'projectId' | 'id' | 'status' | 'activity' | 'autoResumeAt' | 'archived' | 'title' | 'titleSummary'
>

/** The counts every badge and the tab title render. */
export interface WorkspaceAttention {
  /** Tasks that need you across every project in the index. */
  total: number
  /** Project id → tasks that need you there. A project with none has no entry. */
  byProject: ReadonlyMap<string, number>
}

/**
 * Whether a row counts toward a "needs you" badge.
 *
 * The same rule as `listCounts().waiting` (`lib/task-groups.ts`), which the sidebar badge used
 * before this model: a `waiting` or `review` task that is not archived. Deliberately narrower
 * than `wantsAttention` (it leaves `failed` out): a failed task is worth a notification, but a
 * badge counts things you can act on, and the per-project Tasks tab's dot already uses this rule.
 * Keeping the two identical is what stops the group badge and the tab dot from disagreeing.
 *
 * @param row - One index row.
 * @returns True when the task is waiting for an answer or a review.
 */
export function needsYou(row: Pick<AttentionRow, 'status' | 'archived'>): boolean {
  return !row.archived && (row.status === 'waiting' || row.status === 'review')
}

/**
 * Count the tasks that need you, in total and per project.
 *
 * @param rows - Index rows, any order. Duplicate ids are not expected (the server emits one row
 *   per run) and would be counted twice.
 * @returns The workspace attention counts. Zero and an empty map for no rows.
 *
 * @example
 * ```ts
 * const attention = summarizeAttention(index.runs)
 * attention.total                    // 3
 * attention.byProject.get('web-app') // 2
 * ```
 */
export function summarizeAttention(
  rows: readonly AttentionRow[],
  /** Per project, tasks that need you among runs NOT in `rows` (the index's `beyondLimit`). */
  beyondLimit: Readonly<Record<string, { beyondLimit: number }>> = {},
): WorkspaceAttention {
  const byProject = new Map<string, number>()
  let total = 0
  for (const [projectId, { beyondLimit: extra }] of Object.entries(beyondLimit)) {
    if (extra <= 0) continue
    total += extra
    byProject.set(projectId, extra)
  }
  for (const row of rows) {
    if (!needsYou(row)) continue
    total += 1
    byProject.set(row.projectId, (byProject.get(row.projectId) ?? 0) + 1)
  }
  return { total, byProject }
}

/**
 * `select` for the runs-index query: the index answer → attention counts.
 *
 * Module-level (a stable reference) so TanStack Query memoizes it and every reader re-renders
 * only when the index data itself changes.
 *
 * @param index - The cached `GET /workspace/runs-index` answer.
 * @returns The workspace attention counts for that answer.
 */
export function selectWorkspaceAttention(index: RunsIndexResponse): WorkspaceAttention {
  // `?? {}`: tolerate a cached answer from before the field existed (a long-lived tab across a
  // server upgrade) — it then counts the rows alone, as it always did.
  return summarizeAttention(index.runs, index.attention ?? {})
}

/** What the badges and the tab title render, after the failed-index fallback. */
export interface AttentionCounts {
  /** Tasks that need you in one project; null when unknown (render no number). */
  countFor(projectId: string): number | null
  /** Tasks that need you across the workspace; null when unknown. When `stale`, a lower bound. */
  total: number | null
  /** The workspace index could not be refreshed: every count except the active project's is the
   *  last known answer (or unknown). The UI shows the "stale" marker instead of a silent zero. */
  stale: boolean
  /** The project whose count comes from its own live run list while the index is stale. */
  activeProjectId: string | null
}

/**
 * Combine the workspace index with the active project's own run list.
 *
 * - Index answered and current: every count comes from it (`stale: false`).
 * - Index failed (its latest fetch errored): the active project's count comes from its own run
 *   list — fetched separately and patched by the stream, so it is still the truth — and every
 *   other count keeps its last known value, or is unknown when there never was one. `stale`
 *   tells the UI to say so.
 * - Index still loading: unknown everywhere, not stale.
 *
 * @param input.index - The index's attention counts, or undefined when it never answered.
 * @param input.indexFailed - True when the index's latest fetch failed.
 * @param input.activeProjectId - The project the scope-led run list belongs to.
 * @param input.activeCount - That project's needs-you count from its own list, or undefined.
 * @returns The counts to render.
 */
export function resolveAttentionCounts(input: {
  index: WorkspaceAttention | undefined
  indexFailed: boolean
  activeProjectId: string | null
  activeCount: number | undefined
}): AttentionCounts {
  const { index, indexFailed, activeProjectId, activeCount } = input
  const fallback = indexFailed && activeProjectId !== null && activeCount !== undefined
  const countFor = (projectId: string): number | null => {
    if (fallback && projectId === activeProjectId) return activeCount ?? null
    return index ? (index.byProject.get(projectId) ?? 0) : null
  }
  let total: number | null = index ? index.total : null
  if (fallback && activeProjectId !== null) {
    total = (total ?? 0) - (index?.byProject.get(activeProjectId) ?? 0) + (activeCount ?? 0)
  }
  return { countFor, total, stale: indexFailed, activeProjectId }
}

/**
 * The identity a notification tracks a run under. Run ids come from different projects' stores,
 * so the project is part of the key: two projects can never shadow each other's transitions.
 *
 * @param row - The row's project and run id.
 * @returns A key unique across the workspace.
 */
export function attentionKey(row: Pick<AttentionRow, 'projectId' | 'id'>): string {
  return `${row.projectId}\u0000${row.id}`
}
