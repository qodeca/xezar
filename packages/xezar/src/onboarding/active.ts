import { ONBOARDING_WORKFLOW_ID } from './status.ts';

/**
 * "Is a setup task already in flight for this project?" — in ONE place (#464 P2).
 *
 * `GET /onboarding` reports the answer (`state: "checking"`, `checkingRunId`) and `POST /runs`
 * enforces it, and those two must never be able to disagree: a route that refuses a second check
 * while the read says nothing is running is a button that does nothing for no visible reason.
 *
 * Typed structurally rather than against `RunStore`/`RunManager` so the predicate is a pure
 * function of the two facts it needs, and so a test can drive it without a store on disk. `isActive`
 * is the same liveness test every other route uses — `active ∪ starting ∪ queue` — which is what
 * makes it true the instant `startRun` returns, before the run has reached an agent.
 */
export interface SetupRunIndex {
  listRuns(): readonly { readonly id: string; readonly workflow: string }[];
}

export interface SetupRunLiveness {
  isActive(runId: string): boolean;
}

export function activeSetupRunId(store: SetupRunIndex, manager: SetupRunLiveness): string | null {
  for (const run of store.listRuns()) {
    if (run.workflow !== ONBOARDING_WORKFLOW_ID) continue;
    if (manager.isActive(run.id)) return run.id;
  }
  return null;
}
