import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * #155 — accepting the review gate right after it opens must not be lost.
 *
 * `finish()` is the ✓ Accept action, and on a run resting at `review` it refuses while
 * `isActive(runId)` still holds. That guard is right: a send-back continuation spends a
 * few awaits spinning up (`acquireRepoRoot`, `discoverSkills`) before it flips the status
 * off `review`, and a Finish landing in THAT window must not steal the run into `done`.
 *
 * The defect was on the other side of the same guard. `runContinuation` published its
 * terminal status FIRST (`settleSuccess` → `review`) and only then, in its `finally`, ran
 * the turn-end teardown — including `autosaveCommit`, which spawns up to four git
 * processes. For the whole width of that commit the run advertised the review gate to the
 * API and the cockpit while still sitting in `active`, so a ✓ Accept arriving in the window
 * answered `409 no open session`, showed a red toast, and left the run parked at `review`
 * with nothing to wake it. `execute` never had the bug — it autosaves (`run finalize`),
 * then settles, then drops, with no await between the last two — which makes this the
 * "two near-identical turn-end handlers" asymmetry AGENTS.md names.
 *
 * The assertion below is timing-free by construction. It watches for the exact
 * `updateRun` that publishes `review` and then accepts from a `setTimeout(…, 0)` — the
 * earliest turn of the event loop an HTTP handler could possibly run in. Before the fix
 * the pending `autosaveCommit` guarantees the run is still active in that turn and the
 * accept returns false; after it, the settle → drop pair shares one synchronous
 * continuation and the accept is honoured.
 *
 * Guard test, deliberately kept: the FIRST park comes through `execute`, which was always
 * correct, so it pins the behaviour this change must not alter.
 */
describe('accepting the review gate the instant it opens (#155)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-155-'));
    savedEnv.XEZ_DRY_RUN = process.env.XEZ_DRY_RUN;
    savedEnv.XEZ_REVIEW_GATE = process.env.XEZ_REVIEW_GATE;
    process.env.XEZ_DRY_RUN = '1';
    // This suite is ABOUT the gate, which is opt-in and default OFF (#489), so the fixture
    // pins it rather than depending on whatever the operator exported.
    process.env.XEZ_REVIEW_GATE = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    manager = new RunManager(store, repoRoot);
    currentId = undefined;
  });

  afterEach(() => {
    if (currentId) manager.cancel(currentId);
    manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) {
        throw new Error(`#155 fixture: run ${id} stuck at "${store.getRun(id)?.status}"`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  /**
   * Accept the moment the store publishes `review`, from the first event-loop turn after
   * it — which is exactly where a real ✓ Accept request would be dispatched. Returns what
   * `finish()` answered, i.e. whether the cockpit got `{ finished: true }` or a 409.
   */
  const acceptAsSoonAsItParks = (id: string): Promise<boolean> => {
    const patched = store as unknown as {
      updateRun: (runId: string, patch: Partial<RunRecord>) => unknown;
    };
    const original = patched.updateRun.bind(store);
    return new Promise<boolean>((settleAccept) => {
      patched.updateRun = (runId: string, patch: Partial<RunRecord>) => {
        const result = original(runId, patch);
        if (runId === id && patch.status === 'review') {
          patched.updateRun = original;
          setTimeout(() => settleAccept(manager.finish(id)), 0);
        }
        return result;
      };
    });
  };

  /** Park a fresh run at `review` through `execute` — the always-correct path. */
  const parkAtReview = async (): Promise<string> => {
    const record = manager.startRun(SINGLE_STEP, { task: 'Improve the project notes.' });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(manager.finish(record.id)).toBe(true); // closes the open session
    await waitFor(record.id, (r) => r?.status === 'review' || r?.status === 'done');
    // The mock's `notes.md` write is what makes the diff non-empty and the gate open at all.
    expect(store.getRun(record.id)?.status).toBe('review');
    return record.id;
  };

  it('honours ✓ Accept in the first event-loop turn after a CONTINUATION parks at review', async () => {
    const id = await parkAtReview();

    // Send back — the review exit that reopens the same session. The second park therefore
    // comes through `runContinuation`, which is the path that carried the defect.
    expect(manager.continueRun(id, { text: 'Review feedback:\nmention the port' }).ok).toBe(true);
    await waitFor(id, (r) => r?.status === 'waiting');

    const accepted = acceptAsSoonAsItParks(id);
    expect(manager.finish(id)).toBe(true); // close the reopened session → it settles at review
    expect(await accepted).toBe(true); // ← false before the fix: 409 "no open session"

    await waitFor(id, (r) => r?.status === 'done');
    expect(store.getRun(id)?.status).toBe('done');
  }, 60_000);

  it('honours ✓ Accept in that same turn when the FIRST park came through execute (guard)', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'Improve the project notes.' });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');

    const accepted = acceptAsSoonAsItParks(record.id);
    expect(manager.finish(record.id)).toBe(true);
    expect(await accepted).toBe(true);

    await waitFor(record.id, (r) => r?.status === 'done');
  }, 60_000);

  it('still refuses a finish that has nothing to close — the accept did not become permissive', async () => {
    // The control for the change above: making ✓ Accept reachable sooner must not make
    // `finish()` answer yes to everything. A run that has already been accepted has no open
    // session and is no longer at `review`, so a second Finish is still the 409 the route
    // reports — which is what stops a stale cockpit tab from re-finishing a closed run.
    const id = await parkAtReview();
    expect(manager.finish(id)).toBe(true);
    await waitFor(id, (r) => r?.status === 'done');
    expect(manager.finish(id)).toBe(false);
    expect(store.getRun(id)?.status).toBe('done');
  }, 60_000);
});
