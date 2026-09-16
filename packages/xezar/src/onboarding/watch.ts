import { recordChecked } from './state.ts';
import { observedIdentity, ONBOARDING_WORKFLOW_ID } from './status.ts';

import type { RunRecord, RunStore } from '../runs/store.ts';

/**
 * The transition OUT of "a check is running" (#464 P2, review round 1 finding 1).
 *
 * `recordChecked` is the one write that may claim a project was checked, and until this module
 * existed nothing in a running xezar called it: `carriedCheck` could only ever answer `null`, so
 * `set-up`, `changed` and the whole post-update offer were unreachable states. AGENTS.md
 * § *Changing a mechanism that already works* names the shape exactly — *"Enumerate the
 * transitions out of every state you add or keep. Who fires this?"*. This is the answer to
 * "who fires this": **a setup run reaching `done` with every step done**, and nothing else.
 *
 * Its own module, and its own function, for the reason `runs/arm-repo-handle.ts` is one: the
 * fire-and-forget is written ONCE, so the three `RunStore` construction sites cannot drift on it,
 * and `store.ts` stays free of any onboarding import. The store owns the event; this owns the rule.
 *
 * Attached to the store's `run` event rather than to the twenty-odd `updateRun` call sites in
 * `workflows/run.ts`: `touch()` is the single funnel every one of them goes through, which is the
 * "grep the TYPE, not the field" rule applied to a transition instead of to a field.
 */

/**
 * Did this run finish the scope a setup task PROMISES? The definition of "promised scope" against
 * a `RunRecord`, in one place:
 *
 * - it is a run of the bundled launch definition (`project-setup`) — an ordinary task that merely
 *   *mentions* setup is not a check, and never stamps one;
 * - the run reached `done`. Not `failed`, not `cancelled` — a check that stopped early has not
 *   covered anything, and `AC-12` rests on that. Not `review` either: a run parked at `review` is
 *   waiting for a person to accept its changes, and accepting flips it to `done`, which comes
 *   back through this same predicate. Not `waiting`, which is still an active run;
 * - and EVERY step reached `done`. A run whose last step was skipped or cancelled reached the end
 *   of the chain without doing the work, which is the difference between "it finished" and "it
 *   finished what it promised".
 *
 * A run with no steps at all is not a finished check; it is a record that never ran one.
 */
export function setupRunFinishedScope(
  run: Pick<RunRecord, 'workflow' | 'status' | 'steps'>,
): boolean {
  if (run.workflow !== ONBOARDING_WORKFLOW_ID) return false;
  if (run.status !== 'done') return false;
  if (run.steps.length === 0) return false;
  return run.steps.every((step) => step.status === 'done');
}

/** One attachment per store, whatever order the construction sites call it in. */
const watched = new WeakMap<RunStore, SetupWatch>();

/**
 * The handle an attachment answers with.
 *
 * `idle()` exists for the same reason `RunManager.dispose()` is async: the write outlives the
 * event that started it, so anything that needs to know it landed — a teardown, a test — needs
 * something to await. Without it the only way to observe the write is a timer, and a timer is how
 * a fire-and-forget write becomes a flaky suite.
 */
export interface SetupWatch {
  /** Detach. The writes already started still settle through `idle()`. */
  stop(): void;
  /** Resolves when every write this watcher has started so far has settled. */
  idle(): Promise<void>;
}

/**
 * Stamp `lastChecked` when a setup run finishes its promised scope. Idempotent per store.
 *
 * Two things it deliberately does NOT do:
 *
 * - **It never stamps a run that was already finished when the store opened.** Those are history,
 *   not a transition: a `touch()` on such a record (an archive, a pin, a retention sweep) would
 *   otherwise move "last successfully checked" to today for a check that finished last month.
 *   Seeding from `listRuns()` is what makes this an edge rather than a level.
 * - **It never invents the moment.** The stamp is the run's own `finishedAt`, so the record says
 *   when the check finished rather than when this process happened to notice.
 *
 * The write is fire-and-forget for the reason the record is disposable scratch: a read-only disk
 * costs the memory of one check and must not take a run down with it.
 */
export function watchSetupCompletion(store: RunStore, engineVersion: string): SetupWatch {
  const existing = watched.get(store);
  if (existing) return existing;
  const stamped = new Set(store.listRuns().filter(setupRunFinishedScope).map((run) => run.id));
  let writes: Promise<unknown> = Promise.resolve();
  const onRun = (run: RunRecord): void => {
    if (stamped.has(run.id)) return;
    if (!setupRunFinishedScope(run)) return;
    stamped.add(run.id);
    const at = run.finishedAt;
    writes = writes.then(() =>
      recordChecked(store.dataDir, observedIdentity(engineVersion), at ? () => at : undefined)
        .catch(() => {
          // The record is scratch (see `state.ts`): losing this write loses the memory of one
          // check and nothing else, and it must never take a finishing run down with it.
        }),
    );
  };
  store.on('run', onRun);
  const watch: SetupWatch = {
    stop: () => {
      store.off('run', onRun);
      watched.delete(store);
    },
    idle: async () => {
      await writes;
    },
  };
  watched.set(store, watch);
  return watch;
}
