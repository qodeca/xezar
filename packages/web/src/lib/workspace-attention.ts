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
 * Known limit: the index carries each project's newest 200 runs (`perProjectLimit`). A task
 * older than that which is still waiting is not counted. That needs a project with more than 200
 * newer tasks than it, so the model accepts it rather than fetching every full run list.
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
export function summarizeAttention(rows: readonly AttentionRow[]): WorkspaceAttention {
  const byProject = new Map<string, number>()
  let total = 0
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
  return summarizeAttention(index.runs)
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
