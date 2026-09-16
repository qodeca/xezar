import type { RunRecord } from './store.ts';

/**
 * A run's decision projection (D-06 § 4.3).
 *
 * D-06 proposed `status`, `archived`, `pinned`, `title`, `titleOrigin`, `autoResumeAt`,
 * `queuedMessages[].id`, `steps[].id`/`steps[].status`, `branch` and `workflow`, and left the list
 * to be reviewed against `runRecordSchema`. Reviewed against it, two additions follow from the
 * rule itself — every field a leader mutation of a run WRITES:
 *
 *  - `task`: a queued run's brief stays editable until the scheduler picks it up, and a human
 *    editing it is the "edits its brief" case § 4.1 names;
 *  - `queuedMessages[].text`, not only the id: a queued follow-up is editable in the same way.
 *
 * Left out on purpose: telemetry (`tokensUsed`, `inputTokens`, `outputTokens`, `costUsd`,
 * `peakRssBytes`, `peakProcCount`, `diffStat`, the per-step counters), presentation (`seenAt`, and
 * the `archivedAt`/`pinnedAt` stamps whose flags ARE covered), and everything derived by the server
 * for display (`titleSummary`, the referenced PR/issue tiers).
 */
export function runDecisionProjection(run: RunRecord): unknown {
  return {
    status: run.status,
    archived: run.archived,
    pinned: run.pinned,
    title: run.title,
    titleOrigin: run.titleOrigin,
    autoResumeAt: run.autoResumeAt,
    task: run.task,
    queuedMessages: run.queuedMessages?.map((message) => ({ id: message.id, text: message.text })),
    steps: run.steps.map((step) => ({ id: step.id, status: step.status })),
    branch: run.branch,
    workflow: run.workflow,
  };
}

