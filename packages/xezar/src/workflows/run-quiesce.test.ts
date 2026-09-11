import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * `RunManager.quiesce()` — "stop, then dispose" — and the guarantee `dispose()` deliberately
 * does NOT give (#200).
 *
 * The failure this file exists for is a teardown that deletes a data root while the engine is
 * still writing into it: `ENOTEMPTY` from `rmSync`, because two runs the case had dequeued were
 * still mid-spawn (`git worktree add`, the run's temp directory) when it returned. `dispose()`
 * cannot fix that on its own — it is documented as not a run-stopper, and because it clears
 * `active`/`starting`/`queue` FIRST, a run left behind afterwards cannot even be cancelled:
 * `cancel()` looks only in `queue` then `active`, and both are empty by then. Order is the fix,
 * and `quiesce()` is that order made reusable.
 *
 * Which artifact is which, and — because a green-either-way test is how the same regression ships
 * twice — what each one was proved red against:
 *   - REGRESSION `returns only after every run it owns is terminal` / `leaves no worktree-retention
 *     sweep writing` — the original pair; red without the tracking and the cancel-then-drain order.
 *   - REGRESSION `stops a continuation that has not registered anywhere yet` — red with the
 *     `starting.add` in `continueRun`'s direct path removed (the run finishes its turn: `done`,
 *     not `cancelled`).
 *   - REGRESSION `absorbs an agent turn enrolled after the drain had already taken its snapshot` —
 *     red with the fixpoint loop collapsed to a single `allSettled` pass.
 *   - REGRESSION `starts nothing new while it drains — an auto-resume whose window has reopened`
 *     — red with the `quiescing` bail removed from BOTH `pump()` and `fireAutoResume()`.
 *     Removing either one alone leaves it green, because on THIS path the two gates really do
 *     sit at different depths: nothing is armed when `quiesce()` is called, so the only route to
 *     a fire is a pump reconciling the record mid-drain, and either gate stops it.
 *   - REGRESSION `starts nothing new while it drains — a queued run the drain has already swept`
 *     — red with the `quiescing` bail removed from `pump()` (all three of its re-check sites; see
 *     below).
 *   - REGRESSION `starts nothing new while it drains — a resume armed before it` — red with the
 *     `quiescing` bail removed from `fireAutoResume()` ALONE.
 *   - REGRESSION `starts nothing new while it drains — a queue-watchdog sweep` — red with the
 *     `quiescing` bail removed from `rescueStalledQueue()` ALONE.
 *   - REGRESSION `terminates when its own cancel lands between the step loop and the live
 *     session` — red with `publishSession`'s trailing `if (state.cancelled) session.interrupt()`
 *     removed: the drain never returns at all (#199), which is why that case carries a ceiling of
 *     its own rather than leaning on the hook timeout.
 *
 * The last three exist because the case above them pinned no gate on its own, and because the
 * gates are NOT one check at three depths — that reading is wrong and it is what a future edit
 * would delete one of them on. Each guards a path the others cannot see:
 *
 *   - `pump()` guards work the DRAIN itself would start. Every settling run pumps the whole
 *     workspace on its way out (`dropActive` → `releaseSlot` → `semaphore.release()`), and an
 *     external `startRun`/`continueRun` is deliberately not refused during a drain, so without
 *     this gate the drain dequeues and spawns.
 *   - `fireAutoResume()` guards a timer armed BEFORE `quiescing` was set. `quiesce()` disposes
 *     LAST, so an already-armed resume fires inside the drain with no pump anywhere in its
 *     causal chain — `pump()`'s gate cannot reach it at any depth. It would then write a
 *     `continue-N` step, flip a user's `failed` run to `queued` and stamp `autoResumeAttempts`,
 *     three writes into a data root the caller is tearing down.
 *   - `rescueStalledQueue()` guards the queue watchdog, an unref'd 60 s interval and therefore
 *     invisible in a short drain and certain in a long one. It re-adopts `queued` records the
 *     engine holds no work item for: NDJSON, `pendingJobs`, a `queue` push.
 *
 * One thing the pump case cannot prove and should not pretend to: `pump()` spells its gate three
 * times (the head check, then after each await the loop crosses), which is the file's own
 * re-read-after-every-await discipline rather than three gates. Removing any ONE of the three
 * leaves the case green because the next one catches it; the case is red when `quiescing` leaves
 * `pump()` altogether.
 *   - GUARD `dispose() is not a run-stopper` — it pins the behaviour that must NOT change, and it
 *     passes both with and without the fix. Keeping it is the point; mistaking it for a regression
 *     proof is not.
 */

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const TERMINAL = ['done', 'failed', 'cancelled', 'review'];

/** These cases drive real Git, real worktrees and real child processes. */
const TEST_TIMEOUT_MS = 40_000;

/**
 * Ceiling on the gate-blocked step, and it is deliberately longer than the test timeout.
 *
 * A hold that could expire on its own would turn every assertion below into a bet that
 * `quiesce()` returned before the timer did — the bet `run-lease.test.ts` records losing under
 * load (#797). Here the hold ends because the run was cancelled, or the case times out. The
 * escape hatch is teardown's gate write, not a sleep.
 */
const HOLD_CEILING_MS = 120_000;

/** Appended to the gate path for the marker `uncancellableGate`'s child writes once its SIGTERM
 *  listener is installed. Under `.local/xezar` with the gate, so it is never repository content. */
const ARMED_SUFFIX = '.armed';

/** POSIX single-quote escaping — a check step is a command string handed to `bash -lc`, so the
 *  fixture's temp path has to reach node verbatim whatever `TMPDIR` contains. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A workflow whose single check step blocks until `gate` appears on disk — the same shape
 *  `run-lease.test.ts` uses, and for the same reason: the step is still running because nothing
 *  has released it, which no amount of machine load can change. */
function gateBlocked(gate: string): WorkflowDef {
  const hold = [
    'const fs = require("fs");',
    'const gate = process.argv[1];',
    `const deadline = Date.now() + ${HOLD_CEILING_MS};`,
    'const poll = () => { if (fs.existsSync(gate) || Date.now() > deadline) return; setTimeout(poll, 10); };',
    'poll();',
  ].join(' ');
  return {
    name: 'gate-blocked',
    source: 'built-in',
    steps: [{ id: 'hold', command: `node -e '${hold}' ${shellQuote(gate)}` }],
  };
}

/**
 * The same hold, minus the one thing `cancel()` can do to it: `state.interrupt()` for a check
 * step is `child.kill('SIGTERM')`, and this child listens for SIGTERM instead of dying on it.
 * `exec` so the process xezar spawned IS node — with a bare command `bash -lc` usually execs
 * anyway, but "usually" is not a property a case may rest on.
 *
 * Why any case wants that: a drain's length is otherwise a coin toss against the engine's own
 * latencies. `pump()` opens with `getRepoInfo`, which is three or four sequential `git`
 * spawns; an ordinary gate-blocked run is cancelled and settles in one child-process death.
 * Measured, the drain finished FIRST and the pump then bailed on `disposed` — so a case built
 * on the ordinary hold passes with the `quiescing` gate deleted, which is worse than no case.
 * Here the hold ends when the case writes the gate and at no other moment, so "the drain is
 * still open" stops being a bet.
 *
 * `step-start` is NOT enough to wait for, and getting that wrong is how this device silently
 * stops working: it is emitted before the spawn, so a cancel issued on the strength of it
 * reaches a `bash`/`node` that is still starting up — before the handler exists, where SIGTERM
 * has its default disposition and kills the hold after all. The case then passes and fails for
 * timing reasons rather than for the gate. `armed` is the handshake: written by the child
 * itself, on the line after the listener is installed.
 */
function uncancellableGate(gate: string): WorkflowDef {
  const hold = [
    'const fs = require("fs");',
    'process.on("SIGTERM", () => {});',
    'const gate = process.argv[1];',
    // Written only after the handler is installed — see ARMED_SUFFIX.
    `fs.writeFileSync(gate + "${ARMED_SUFFIX}", "");`,
    `const deadline = Date.now() + ${HOLD_CEILING_MS};`,
    'const poll = () => { if (fs.existsSync(gate) || Date.now() > deadline) return; setTimeout(poll, 10); };',
    'poll();',
  ].join(' ');
  return {
    name: 'uncancellable-gate',
    source: 'built-in',
    steps: [{ id: 'hold', command: `exec node -e '${hold}' ${shellQuote(gate)}` }],
  };
}

/**
 * Ceiling on the ONE case that asserts the drain terminates at all, and it is a fail-fast bound
 * on a hang rather than a performance budget: without the fix the drain never returns, and
 * without a bound of its own the case would report as a 40 s hook timeout in cleanup instead of
 * as the failed assertion it is. Comfortably above the milliseconds a cancelled mock turn
 * actually takes, comfortably below `TEST_TIMEOUT_MS`.
 */
const DRAIN_CEILING_MS = 20_000;

/**
 * One AGENT step, so a case can reach the turn-end bookkeeping a check step never touches:
 * `recordTurnEnd` → `worktreeShortstat` → the `diffStat` write. `mock:done` ends the turn with
 * the `XEZ:DONE` marker, so the run finishes on its own instead of parking at `waiting`.
 *
 * Under `XEZ_DRY_RUN=1` the backend is the bundled mock — no login, no network, no real CLI.
 */
const agentWorkflow: WorkflowDef = {
  name: 'agent-turn',
  source: 'built-in',
  steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
};

interface Fixture {
  root: string;
  store: RunStore;
  manager: RunManager;
  /** The workspace semaphore this manager registered with. `release()` is the only PUBLIC way
   *  to drive a `pump()` to completion and await it — every other pump in the engine is
   *  floated — which is what lets a case assert on a pump's decision instead of sleeping. */
  semaphore: WorkspaceSemaphore;
  workflow: WorkflowDef;
  /** `workflow`, but its hold survives the cancel `quiesce()` issues (see `uncancellableGate`). */
  uncancellable: WorkflowDef;
  /** True once an `uncancellable` hold has installed its SIGTERM listener. */
  holdArmed: () => boolean;
  /** Let every blocked step exit — teardown's escape hatch, never a test's timing device. */
  release: () => void;
  /** `manager.startRun`, recording the id so teardown can wait for it. */
  start: (input: Parameters<RunManager['startRun']>[1]) => ReturnType<RunManager['startRun']>;
  /** The same, on a workflow of the case's choosing (the agent one). */
  startWith: (
    workflow: WorkflowDef,
    input: Parameters<RunManager['startRun']>[1],
  ) => ReturnType<RunManager['startRun']>;
  started: string[];
}

const fixtures: Fixture[] = [];

/** Most steps here are CHECK steps, so no agent CLI is involved — except the run namer, which
 *  `startRun` floats on its own and which would otherwise spawn a real backend for a fixture with
 *  nothing to name. Off, so the only child processes in this file are the ones under test.
 *
 *  `XEZ_DRY_RUN=1` covers the one case that DOES want an agent turn: it pins the backend to the
 *  bundled mock. It is set file-wide rather than per case because a leaked value would otherwise
 *  reach a real CLI, and the check-step cases do not consult it at all. */
let savedAutoName: string | undefined;
let savedDryRun: string | undefined;
beforeEach(() => {
  savedAutoName = process.env.XEZ_AUTONAME;
  savedDryRun = process.env.XEZ_DRY_RUN;
  process.env.XEZ_AUTONAME = '0';
  process.env.XEZ_DRY_RUN = '1';
});

function fixtureRepo(options: { maxParallel: number; worktreeRetention?: number }): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'xez-quiesce-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  if (options.worktreeRetention !== undefined) {
    mkdirSync(join(root, '.xezar'), { recursive: true });
    writeFileSync(
      join(root, '.xezar', 'config.json'),
      `${JSON.stringify({ worktreeRetention: options.worktreeRetention }, null, 2)}\n`,
    );
  }
  const store = RunStore.open(join(root, '.local/xezar'));
  const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: options.maxParallel } });
  const manager = new RunManager(store, root, { semaphore });
  // Under `.local/xezar` on purpose: nothing treats that directory as repository content, so the
  // gate can never turn up in a worktree diff.
  const gate = join(root, '.local/xezar', 'quiesce-gate');
  const started: string[] = [];
  const fixture: Fixture = {
    root,
    store,
    manager,
    semaphore,
    workflow: gateBlocked(gate),
    uncancellable: uncancellableGate(gate),
    holdArmed: () => existsSync(`${gate}${ARMED_SUFFIX}`),
    release: () => writeFileSync(gate, ''),
    start: (input) => fixture.startWith(fixture.workflow, input),
    startWith: (workflow, input) => {
      const run = manager.startRun(workflow, input);
      started.push(run.id);
      return run;
    },
    started,
  };
  fixtures.push(fixture);
  return fixture;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Block until the run is demonstrably inside its gate-blocked step. */
function inHoldStep(fixture: Fixture, runId: string): Promise<void> {
  return waitFor(
    () =>
      fixture.store
        .readEvents(runId)
        .some((event) => event.type === 'step-start' && event.stepId === 'hold'),
    `run ${runId} to enter its blocked step`,
  );
}

const unsettled = (fixture: Fixture): string[] =>
  fixture.started.filter((id) => !TERMINAL.includes(fixture.store.getRun(id)?.status ?? ''));

afterEach(async () => {
  try {
    await teardownFixtures();
  } finally {
    if (savedAutoName === undefined) delete process.env.XEZ_AUTONAME;
    else process.env.XEZ_AUTONAME = savedAutoName;
    if (savedDryRun === undefined) delete process.env.XEZ_DRY_RUN;
    else process.env.XEZ_DRY_RUN = savedDryRun;
  }
}, TEST_TIMEOUT_MS);

async function teardownFixtures(): Promise<void> {
  for (const fixture of fixtures.splice(0)) {
    // Open the gate first: a failed assertion skips the case's own `quiesce()`, and teardown must
    // not sit out `HOLD_CEILING_MS` waiting for a blocked step to give up on its own.
    fixture.release();
    let straggler: string | undefined;
    try {
      await waitFor(() => unsettled(fixture).length === 0, 'every started run to settle', 15_000);
    } catch {
      straggler = unsettled(fixture)[0];
    }
    await fixture.manager.quiesce();
    fixture.store.flush();
    if (straggler) {
      throw new Error(
        `run ${straggler} was still ${fixture.store.getRun(straggler)?.status} at teardown — ` +
          `${fixture.root} deliberately leaked rather than deleted under a live run`,
      );
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

describe('RunManager.quiesce', () => {
  it(
    'returns only after every run it owns is terminal and isActive() is false',
    async () => {
      // REGRESSION (#200). One slot, two isolated runs: the first is `active` and blocked inside
      // its step, the second is `queued`. Both registries `cancel()` knows about, and both
      // populations a teardown has to cover — the queued one would otherwise be started by the
      // pump the first one's exit triggers, into a directory the caller is deleting.
      const fixture = fixtureRepo({ maxParallel: 1 });
      const held = fixture.start({ task: 'hold the slot', worktree: true });
      const waiting = fixture.start({ task: 'wait for the slot', worktree: true });
      await inHoldStep(fixture, held.id);

      expect(fixture.manager.isActive(held.id)).toBe(true);
      expect(fixture.manager.isActive(waiting.id)).toBe(true);
      expect(fixture.store.getRun(waiting.id)?.status).toBe('queued');

      // The gate is never written. If `quiesce()` waited instead of cancelling, the blocked step
      // would outlive this case's timeout — the assertion is the return itself.
      await fixture.manager.quiesce();

      for (const id of [held.id, waiting.id]) {
        expect(fixture.store.getRun(id)?.status).toBe('cancelled');
        expect(fixture.manager.isActive(id)).toBe(false);
      }

      // …and nothing is still writing into the data root. A quiet window is a weak probe on its
      // own; it is here because the ENOTEMPTY this fixes was a write that landed AFTER the case
      // believed it was finished, and the strong form of the same claim is the retention case
      // below.
      const before = [held.id, waiting.id].map((id) => fixture.store.readEvents(id).length);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect([held.id, waiting.id].map((id) => fixture.store.readEvents(id).length)).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves no worktree-retention sweep writing after it returns',
    async () => {
      // REGRESSION (#200), and the half that is not test-only: `enforceRetention` used to be a
      // floating promise nobody tracked, so a DISPOSED manager could still be spawning
      // `git worktree remove` / `git worktree prune` inside a root its caller was deleting — the
      // same hazard for a project context a live multi-project server has just removed.
      //
      // `worktreeRetention: 1` with two finished worktrees gives the sweep real work: exactly one
      // directory to reclaim, and a `worktreeReclaimedAt` stamp to write for it. `dropActive`
      // fires the sweep as the last synchronous act of the run body, so it is always in flight at
      // the moment teardown begins. The assertion is therefore about the WINDOW AFTER the
      // teardown promise resolves: nothing may change in it.
      //
      // Untracked and unguarded, the sweep outlives that promise by the length of two git spawns
      // and stamps a record — a write into a data root whose owner has been told it is finished.
      // Tracked, it either completed before the promise resolved or bailed at the `disposed`
      // re-check; either way the window is quiet, which is the only property a caller about to
      // `rm -rf` the root can act on.
      const fixture = fixtureRepo({ maxParallel: 2, worktreeRetention: 1 });
      const first = fixture.start({ task: 'first worktree', worktree: true });
      const second = fixture.start({ task: 'second worktree', worktree: true });
      await inHoldStep(fixture, first.id);
      await inHoldStep(fixture, second.id);
      const ids = [first.id, second.id];
      const paths = ids.map((id) => fixture.store.getRun(id)?.worktreePath);
      expect(paths.every((path) => path && existsSync(path))).toBe(true);

      // Everything the sweep could still touch: the records it stamps and the directories it
      // removes.
      const snapshot = (): string =>
        JSON.stringify(
          ids.map((id) => ({
            reclaimedAt: fixture.store.getRun(id)?.worktreeReclaimedAt ?? null,
            worktree: existsSync(fixture.store.getRun(id)?.worktreePath ?? ''),
            events: fixture.store.readEvents(id).length,
          })),
        );

      await fixture.manager.quiesce();

      const atReturn = snapshot();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(snapshot()).toBe(atReturn);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops a continuation that has not registered anywhere yet, mid agent turn',
    async () => {
      // REGRESSION (#200), and the only case here that drives a real AGENT turn. Every other case
      // uses a check step, which never reaches `recordTurnEnd` — the turn-end bookkeeping that
      // spawns `git diff --shortstat` in the worktree and writes `diffStat` back onto the record,
      // and the one write that is fired from INSIDE a run body rather than by the scheduler.
      //
      // The window under test is the one `cancel()` could not see. `continueRun`'s direct path
      // floats `runContinuation`, which awaits `rematerializeReclaimedWorktree` before it builds
      // its `ActiveRun` — so between the two the run was in NEITHER `active` NOR `starting`:
      // invisible to `activeRunIds()`, refused by `cancel()`, and therefore a full agent turn
      // that `quiesce()` would start waiting for without ever having been able to stop it. The
      // `quiesce()` below is called in the SAME TICK as the Continue, which puts it deterministic-
      // ally inside that window rather than racing it.
      //
      // Without the fix this case does not fail on a timing assertion — it fails on the outcome:
      // the run finishes its turn (`done`) instead of stopping (`cancelled`), and the turn's
      // `diffStat`/events land after the caller was told nothing was writing any more.
      const fixture = fixtureRepo({ maxParallel: 1 });
      const run = fixture.startWith(agentWorkflow, { task: 'mock:done first turn', worktree: true });

      // A real turn first, so the Continue below has a session to resume and the worktree holds
      // the mock's commit — i.e. `recordTurnEnd` had actual work to do.
      await waitFor(
        () => TERMINAL.includes(fixture.store.getRun(run.id)?.status ?? ''),
        `run ${run.id} to finish its agent turn`,
      );
      const finished = fixture.store.getRun(run.id);
      expect(finished?.steps.some((step) => step.sessionId !== undefined)).toBe(true);
      expect(finished?.worktreePath && existsSync(finished.worktreePath)).toBe(true);

      const snapshot = (): string =>
        JSON.stringify({
          status: fixture.store.getRun(run.id)?.status ?? null,
          diffStat: fixture.store.getRun(run.id)?.diffStat ?? null,
          events: fixture.store.readEvents(run.id).length,
          worktree: existsSync(fixture.store.getRun(run.id)?.worktreePath ?? ''),
        });

      expect(fixture.manager.continueRun(run.id, { text: 'mock:done second turn' })).toEqual({
        ok: true,
      });
      // Same tick, deliberately: `runContinuation` has not crossed its first await, so this is
      // exactly the moment the old `cancel()` answered "no such run".
      await fixture.manager.quiesce();

      expect(fixture.store.getRun(run.id)?.status).toBe('cancelled');
      expect(fixture.manager.isActive(run.id)).toBe(false);
      const atReturn = snapshot();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(snapshot()).toBe(atReturn);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'absorbs an agent turn enrolled after the drain had already taken its snapshot',
    async () => {
      // REGRESSION (#200) for the FIXPOINT itself. `Promise.allSettled` freezes the set at the
      // instant it is spread, so a single pass waits for the generation of work that existed when
      // `quiesce()` was called and for nothing enrolled after it. The loop is what turns "wait
      // for what was running" into "wait until nothing is running".
      //
      // The trigger is an external Continue landing INSIDE the drain — the shape a live server
      // has whenever `POST /runs/:id/continue` and a project teardown cross. Ordering is the
      // whole case and it is deterministic, not a race: `quiesce()` runs synchronously up to its
      // first await, so by the time the next statement executes the cancel pass is done and the
      // snapshot is taken; the Continue then enrols a body that snapshot cannot contain. The
      // gate-blocked run exists only to keep the drain alive long enough for that to matter — it
      // is cancelled immediately and settles in milliseconds, while the continuation is a real
      // mock agent turn.
      //
      // Collapsed to one pass, `quiesce()` returns while that turn is still running and the
      // window after it is anything but quiet: the run reaches a terminal status and
      // `recordTurnEnd` stamps `diffStat` — writes into a data root whose owner has been told it
      // is finished.
      const fixture = fixtureRepo({ maxParallel: 2 });
      const continued = fixture.startWith(agentWorkflow, {
        task: 'mock:done first turn',
        worktree: true,
      });
      await waitFor(
        () => TERMINAL.includes(fixture.store.getRun(continued.id)?.status ?? ''),
        `run ${continued.id} to finish its agent turn`,
      );
      const held = fixture.start({ task: 'keep the drain open', worktree: true });
      await inHoldStep(fixture, held.id);

      const snapshot = (): string =>
        JSON.stringify({
          status: fixture.store.getRun(continued.id)?.status ?? null,
          diffStat: fixture.store.getRun(continued.id)?.diffStat ?? null,
          events: fixture.store.readEvents(continued.id).length,
        });

      const drain = fixture.manager.quiesce();
      expect(fixture.manager.continueRun(continued.id, { text: 'mock:done second turn' })).toEqual({
        ok: true,
      });
      await drain;

      expect(fixture.store.getRun(continued.id)?.status).toBe('cancelled');
      const atReturn = snapshot();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(snapshot()).toBe(atReturn);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'starts nothing new while it drains — an auto-resume whose window has reopened stays put',
    async () => {
      // REGRESSION (#200). `quiesce()` used to be able to START work: every settling run releases
      // its slot, `WorkspaceSemaphore.release()` awaits `pump()` on every registered participant
      // INCLUDING this one, and a pump reconciles auto-resumes from the records. A record whose
      // `autoResumeAt` has already passed arms at zero delay, fires inside the drain, and hands
      // `continueRun` a fresh agent turn — into the very repo root the caller is deleting, which
      // `quiesce()` would then dutifully wait for. Bounded by `MAX_AUTO_RESUMES`, and the exact
      // opposite of what the method promises.
      //
      // The `continue-N` step is the tell, and it is written SYNCHRONOUSLY by `continueRun`
      // before any capacity decision — so the assertion does not depend on whether the resumed
      // turn got a slot, spawned, or was cancelled a pass later. Without the `quiescing` gate the
      // step is there; with it, the deadline stays on the record for the next process to honour.
      const fixture = fixtureRepo({ maxParallel: 2 });
      const limited = fixture.startWith(agentWorkflow, {
        task: 'mock:done a turn to resume',
        worktree: true,
      });
      await waitFor(
        () => TERMINAL.includes(fixture.store.getRun(limited.id)?.status ?? ''),
        `run ${limited.id} to finish its agent turn`,
      );
      // Two things for the drain to actually drain, and two is the minimum that makes this
      // observable: the FIRST one's exit is what pumps the manager (and, ungated, arms the
      // resume at zero delay), while the second is still settling — a real `git commit` for its
      // turn-end autosave — which is what gives that zero-delay timer a macrotask to fire in.
      // With a single run the drain ends in microtasks and the armed timer is cleared by
      // `dispose()` before it ever fires, so the bug hides.
      const held = [
        fixture.start({ task: 'release a slot on the way out', worktree: true }),
        fixture.start({ task: 'still settling when it does', worktree: true }),
      ];
      for (const run of held) await inHoldStep(fixture, run.id);

      // The shape a usage-limited run rests in once its window has reopened — hand-written for
      // the same reason `auto-resume.test.ts` writes it, so the FIRE is exercised without waiting
      // out a real timer. Recent enough not to be retired as a missed window.
      //
      // Written LAST, and `quiesce()` follows in the same tick: an armed timer is a fair
      // scheduler decision taken before the teardown began, and this case is about the one taken
      // DURING it. Set the deadline any earlier and an ordinary pump arms it first, which proves
      // nothing about the drain.
      fixture.store.updateRun(limited.id, {
        status: 'failed',
        autoResumeAt: new Date(Date.now() - 1_000).toISOString(),
      });
      await fixture.manager.quiesce();

      const record = fixture.store.getRun(limited.id);
      expect(record?.steps.some((step) => step.id.startsWith('continue-'))).toBe(false);
      expect(record?.status).toBe('failed');
      // The promise is kept, not cancelled: the deadline is durable state and the next manager
      // rebuilds the timer from it (`reconcileAutoResumes`).
      expect(record?.autoResumeAt).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'starts nothing new while it drains — a queued run the drain has already swept stays put',
    async () => {
      // REGRESSION (#200) for `pump()`'s gate ALONE. The auto-resume case above needs BOTH gates
      // removed to fail, so on its own it would let either be deleted green.
      //
      // What `pump()` guards that `fireAutoResume()` cannot: work the drain itself would start.
      // Every settling run pumps the whole workspace on its way out, and an external enqueue is
      // deliberately not refused during a drain — so without this gate the drain dequeues, spawns
      // `git worktree add` and an agent CLI into the repo root the caller is deleting, and then
      // waits for the turn it just started.
      //
      // Two devices make this deterministic instead of a race, and both are necessary:
      //
      //  1. The hold survives cancellation (`uncancellableGate`), so the drain is provably still
      //     open while the assertions run — it ends when this case writes the gate and at no other
      //     moment. Without that the drain finishes before a pump's opening `getRepoInfo` returns,
      //     and the case passes with the gate deleted.
      //  2. The queued run is enrolled through the DEFERRED `continueRun`, the one enqueue in the
      //     engine that does not float a pump of its own. That leaves `semaphore.release()` as the
      //     only pump in the case — and it awaits `pump()` on every participant, so when it
      //     resolves the pump has had its whole turn and either started this run or refused it.
      //     No sleep, and nothing to lose a race to.
      //
      // Ordering is deterministic too: `quiesce()` runs synchronously to its first await, so by
      // the time the next statement executes the first cancel pass is done and the queue is empty.
      // This run therefore enters a queue the drain has already swept.
      const fixture = fixtureRepo({ maxParallel: 2 });
      const continued = fixture.startWith(agentWorkflow, {
        task: 'mock:done first turn',
        worktree: true,
      });
      await waitFor(
        () => TERMINAL.includes(fixture.store.getRun(continued.id)?.status ?? ''),
        `run ${continued.id} to finish its agent turn`,
      );
      const held = fixture.startWith(fixture.uncancellable, {
        task: 'holds the drain open',
        worktree: true,
      });
      await inHoldStep(fixture, held.id);
      // …and, unlike every other case here, wait for the hold to be ARMED. `step-start` only
      // means the spawn is about to happen; cancelling on it would race the child's startup.
      await waitFor(fixture.holdArmed, `run ${held.id} to arm its uncancellable hold`);

      const drain = fixture.manager.quiesce();
      expect(
        fixture.manager.continueRun(continued.id, { text: 'mock:done second turn' }, true),
      ).toEqual({ ok: true });
      await fixture.semaphore.release();

      // The pump has had its whole turn, and it had it INSIDE the drain — asserted, not assumed.
      // Without this the case could pass by reading state the drain had already tidied up, which
      // is the same green-either-way failure the gate itself is being pinned against.
      expect(fixture.store.getRun(held.id)?.status).toBe('running');
      expect(fixture.manager.isActive(held.id)).toBe(true);

      // Let the hold go and settle the drain. The tell is the STEP, and it is read here rather
      // than above because a dequeue is invisible on the record for as long as it takes
      // `runContinuation` to cross its first await: both `queued` and `starting` read as `queued`
      // with a `pending` step. What separates them is what happens NEXT. Gated, nothing ever
      // dequeued this run, so the trailing cancel pass ends it where it stands — `cancel()` finds
      // it in the queue, marks the RECORD and never touches the step. Ungated, `runContinuation`
      // ran: it re-materialized the worktree, adopted the cancellation and stamped the step
      // `cancelled` on its way out — and had the drain been one pass longer, a whole agent turn.
      fixture.release();
      await drain;
      const step = () =>
        fixture.store.getRun(continued.id)?.steps.find((s) => s.id.startsWith('continue-'));
      expect(step()?.status).toBe('pending');
      expect(
        fixture.store.readEvents(continued.id).some((event) => event.type === 'step-start'
          && typeof event.stepId === 'string' && event.stepId.startsWith('continue-')),
      ).toBe(false);
      expect(
        fixture.store
          .readEvents(continued.id)
          .some((event) => event.message === 'cancelled while queued'),
      ).toBe(true);
      // …and it ends honestly rather than being silently forgotten.
      expect(fixture.store.getRun(continued.id)?.status).toBe('cancelled');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'starts nothing new while it drains — a resume armed before it does not fire inside it',
    async () => {
      // REGRESSION (#200) for `fireAutoResume()`'s gate ALONE, and the path that shows the two
      // gates are not one check at two depths: there is no pump anywhere in this chain.
      //
      // The timer is armed BEFORE `quiescing` is set — a fair scheduler decision, taken while
      // the manager was healthy — and comes due DURING the drain, because `quiesce()` disposes
      // last and `dispose()` is the only thing that clears the timers. A live server reaches
      // this whenever a project teardown overlaps a resume deadline; the drain only has to
      // outlast it, and a session that will not close is bounded by the runner's 30-minute
      // default.
      //
      // Arming it is deterministic rather than timed, and the mechanism is worth naming because
      // the obvious one does not work: `scheduleAutoResumeIfLimited` can never arm at zero
      // delay (`parseUsageLimit` clamps a stale reset instant to now, and the grace is added on
      // top), so the zero-delay route is `reconcileAutoResumes` reading a past deadline off the
      // record. That runs in `pump()`'s SYNCHRONOUS prefix, before its first await — so the
      // `startRun` below arms the timer and returns, and `quiesce()` follows in the same tick.
      // A zero-delay timer armed in this tick fires in the next timers phase, which is inside a
      // drain that cannot finish without waiting out a child process.
      const fixture = fixtureRepo({ maxParallel: 2 });
      const limited = fixture.startWith(agentWorkflow, {
        task: 'mock:done a turn to resume',
        worktree: true,
      });
      await waitFor(
        () => TERMINAL.includes(fixture.store.getRun(limited.id)?.status ?? ''),
        `run ${limited.id} to finish its agent turn`,
      );
      // Something for the drain to actually drain — cancelled in the first pass, but its body
      // takes a child-process death to settle, which is the window the timer fires in.
      const held = fixture.start({ task: 'keep the drain open', worktree: true });
      await inHoldStep(fixture, held.id);

      // From here to `quiesce()` is one tick, deliberately.
      fixture.store.updateRun(limited.id, {
        status: 'failed',
        autoResumeAt: new Date(Date.now() - 1_000).toISOString(),
      });
      fixture.start({ task: 'arms the pending resume on its way in', worktree: true });
      const drain = fixture.manager.quiesce();
      await drain;

      const record = fixture.store.getRun(limited.id);
      // Ungated, `fireAutoResume` writes all three of these before anything can stop it, and
      // the trailing cancel pass then marks a run the user left `failed` as `cancelled`.
      expect(record?.steps.some((step) => step.id.startsWith('continue-'))).toBe(false);
      expect(record?.status).toBe('failed');
      expect(record?.autoResumeAttempts).toBeUndefined();
      // The promise is kept, not cancelled: the next manager rebuilds the timer from it.
      expect(record?.autoResumeAt).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'starts nothing new while it drains — a queue-watchdog sweep re-adopts nothing',
    async () => {
      // REGRESSION (#200) for `rescueStalledQueue()`'s gate ALONE — the third self-starting
      // entry point, and the one a design note had recorded as not existing. Its schedule is
      // what makes it easy to miss rather than harmless: an unref'd 60 s interval never lands
      // in a drain that takes milliseconds and always lands in one that takes minutes, which a
      // session refusing to close makes routine.
      //
      // Deterministic with no scaffolding at all on the pump side, because the method is public
      // and awaited ("public so a test can drive the wedge directly instead of waiting out the
      // interval"). The hold keeps the drain open around it; see `uncancellableGate`.
      const fixture = fixtureRepo({ maxParallel: 2 });
      const lost = fixture.startWith(agentWorkflow, { task: 'mock:done a turn', worktree: true });
      await waitFor(
        () => TERMINAL.includes(fixture.store.getRun(lost.id)?.status ?? ''),
        `run ${lost.id} to finish its agent turn`,
      );
      const held = fixture.startWith(fixture.uncancellable, {
        task: 'holds the drain open',
        worktree: true,
      });
      await inHoldStep(fixture, held.id);
      await waitFor(fixture.holdArmed, `run ${held.id} to arm its uncancellable hold`);

      // The worst shape the watchdog exists for, written by hand for the same reason the
      // auto-resume cases hand-write a deadline: a record that says `queued` while the engine
      // holds no job, no continuation and no queue entry for it. `pump()` cannot see such a run
      // — it iterates the queue — so the sweep is the only thing that would touch it.
      fixture.store.updateRun(lost.id, { status: 'queued', finishedAt: undefined });
      const eventsBefore = fixture.store.readEvents(lost.id).length;

      const drain = fixture.manager.quiesce();
      await fixture.manager.rescueStalledQueue();

      expect(fixture.store.getRun(held.id)?.status).toBe('running'); // the drain is still open
      expect(fixture.manager.isActive(lost.id)).toBe(false);
      expect(fixture.store.readEvents(lost.id).length).toBe(eventsBefore);
      expect(fixture.store.getRun(lost.id)?.status).toBe('queued');

      fixture.release();
      await drain;
      // Nothing re-adopted it, so nothing cancels it either — the record is still the
      // impossible one this case wrote, and the next process's `recover()` is what ends it.
      // Put it back so the shared teardown's straggler check reads a run, not a fixture.
      expect(fixture.store.getRun(lost.id)?.status).toBe('queued');
      fixture.store.updateRun(lost.id, {
        status: 'done',
        finishedAt: new Date().toISOString(),
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'terminates when its own cancel lands between the step loop and the live session',
    async () => {
      // REGRESSION (#199). The drain hung for good on a 2-core CI runner and passed on every
      // developer machine, which is what a window measured in `await`s looks like.
      //
      // `cancel()` stops a running turn by calling `state.interrupt()`. That function only points
      // at the agent session from the moment `publishSession` installs it; between the step
      // loop's own `if (state.cancelled) break` and that assignment it is the `() => undefined`
      // placeholder, and everything in between — `configuredModelProvider`, `agentEnvForStep`, a
      // team skill's `materializeSkillDir` — is awaited. A cancel landing in that gap used to set
      // the flag and deliver nothing, and the run then had no exit at all: the session spawned
      // regardless, an interactive step passes `timeoutMs: 0` so the runner has no wall clock,
      // and the turn-end handler reads `sessionOpen` as `!state.cancelled && session.open` — so
      // the run neither parked at `waiting` nor closed on its own `XEZ:DONE`. The body sat in
      // `await session.result` while `quiesce()`, which re-issues its cancel only AFTER the
      // `Promise.allSettled` that body is holding open, waited for it forever.
      //
      // Deterministic, not a race, and deliberately not load-dependent: `appendEvent` fans out to
      // its listeners synchronously, `step-start` is emitted from the step loop one statement
      // after the cancel check it just passed, and `quiesce()` runs synchronously up to its first
      // await — so the cancel pass is guaranteed to land inside the window rather than merely
      // likely to. (The opposite of what `uncancellableGate` needs from `step-start`, for the
      // same underlying reason: it is emitted BEFORE the child exists.)
      const fixture = fixtureRepo({ maxParallel: 1 });
      let drain: Promise<void> | undefined;
      const quiesceOnStepStart = (payload: { runId: string; event: { type: string } }): void => {
        if (drain !== undefined || payload.event.type !== 'step-start') return;
        drain = fixture.manager.quiesce();
      };
      fixture.store.on('event', quiesceOnStepStart);
      // In place, like the reported run: the repository-root lease is one more await between the
      // cancel check and the session, and `worktree: false` is the shape #199 was reported on.
      const run = fixture.startWith(agentWorkflow, {
        task: 'mock:done ship it',
        worktree: false,
      });
      try {
        await waitFor(() => drain !== undefined, `run ${run.id} to start its agent step`);
      } finally {
        fixture.store.off('event', quiesceOnStepStart);
      }

      const outcome = await Promise.race([
        (drain as Promise<void>).then(() => 'drained' as const),
        new Promise<'hung'>((resolve) => {
          const timer = setTimeout(() => resolve('hung'), DRAIN_CEILING_MS);
          timer.unref?.();
        }),
      ]);
      // A second cancel DOES reach the session by now, so a red run tears its own child down
      // instead of leaving teardown to wait out the same stuck body (and report as a timeout in
      // cleanup rather than as this assertion).
      if (outcome === 'hung') fixture.manager.cancel(run.id);
      expect(outcome).toBe('drained');

      expect(fixture.store.getRun(run.id)?.status).toBe('cancelled');
      expect(fixture.manager.isActive(run.id)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'GUARD: dispose() is not a run-stopper — the record stays running while isActive() goes false',
    async () => {
      // This one passes with AND without the fix, on purpose. It pins the documented
      // non-guarantee that `quiesce()` exists precisely because of: `dispose()` empties the
      // registries without stopping anything, which is why a caller that has to end the runs must
      // not reach for it, and why doing so leaves runs that `cancel()` can no longer see.
      const fixture = fixtureRepo({ maxParallel: 1 });
      const held = fixture.start({ task: 'survives dispose', worktree: true });
      await inHoldStep(fixture, held.id);

      await fixture.manager.dispose();

      expect(fixture.store.getRun(held.id)?.status).toBe('running');
      expect(fixture.manager.isActive(held.id)).toBe(false);
      // …and it is now unstoppable: the run is in neither `queue` nor `active`, the only two
      // places `cancel()` looks.
      expect(fixture.manager.cancel(held.id)).toBe(false);
      // Teardown releases the gate and waits it out — the leak this documents, handled by the
      // shared hook rather than by deleting the repository under a live process.
    },
    TEST_TIMEOUT_MS,
  );
});
