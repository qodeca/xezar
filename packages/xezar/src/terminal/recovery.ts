/**
 * Boot-recovery accounting for the terminal (#467, NB-2).
 *
 * The snapshot is taken before `RunManager.recover()` and inspected only after that promise
 * resolves. That distinction is load-bearing: a waiting task deliberately settled by recovery
 * is history, while a running task's temporary `failed` write is an implementation detail that
 * must never be reported as a new outcome.
 */

import type { RunRecord, RunStatus } from '../runs/store.ts';

const RECOVERY_CANDIDATE_STATUSES: ReadonlySet<RunStatus> = new Set([
  'queued',
  'waiting',
  'running',
]);

export interface RecoveryCandidate {
  readonly id: string;
  readonly status: 'queued' | 'waiting' | 'running';
}

/** Capture only the records this boot may recover, including their original status. */
export function snapshotRecoveryCandidates(runs: readonly RunRecord[]): RecoveryCandidate[] {
  return runs
    .filter((run): run is RunRecord & { status: RecoveryCandidate['status'] } =>
      RECOVERY_CANDIDATE_STATUSES.has(run.status),
    )
    .map(({ id, status }) => ({ id, status }));
}

/** Count the originally-waiting records that recovery deliberately settled successfully. */
export function countSettledRecovery(
  candidates: readonly RecoveryCandidate[],
  currentRuns: readonly RunRecord[],
): number {
  const currentStatuses = new Map(currentRuns.map((run) => [run.id, run.status]));
  return candidates.filter(
    (candidate) =>
      candidate.status === 'waiting' &&
      ['done', 'review'].includes(currentStatuses.get(candidate.id) ?? ''),
  ).length;
}

/** Await the real recovery before publishing its one successful historical summary. */
export async function recoverAndReport(
  listRuns: () => readonly RunRecord[],
  recover: () => Promise<void>,
  report: (count: number, settled: number) => void,
): Promise<void> {
  const candidates = snapshotRecoveryCandidates(listRuns());
  await recover();
  report(candidates.length, countSettledRecovery(candidates, listRuns()));
}
