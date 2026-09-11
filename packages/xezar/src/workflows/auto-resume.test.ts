import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import {
  AUTO_RESUME_GRACE_MS,
  AUTO_RESUME_MISSED_WINDOW_MS,
  AUTO_RESUME_PROOF_MS,
  MAX_AUTO_RESUMES,
  RunManager,
} from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
/** The statuses a run can stop at. Shared by `settle` and by teardown's straggler check, which
 *  must ask the same question the cases do. */
const TERMINAL = new Set(['done', 'review', 'failed', 'cancelled']);
/**
 * Teardown now WAITS for run bodies, so vitest's 10 s hook default is no longer the right budget:
 * `settle` alone gives one run 20 s, and the cases below run to 40, 60 and 90. A hook that times
 * out is the worst of both worlds — the `rmSync` is skipped, the manager is never disposed, and
 * the deliberate "temp dir leaked" message never prints, so the fault reads as a timeout in
 * cleanup rather than as the live run it is. Sized like the file's own longest case, not like its
 * shortest. (`run-quiesce.test.ts` gives its hook 40 s for exactly this reason.)
 */
const TEARDOWN_TIMEOUT_MS = 90_000;

/**
 * Auto-resume after a provider usage limit, end to end through the real engine
 * (spec 2026-08-03-auto-resume-after-usage-limit).
 *
 * The trigger is the bundled mock's `mock:limit` reply — the exact `is_error` result envelope
 * Claude Code emits when the subscription window is exhausted — so what is proven here is the
 * whole chain the feature actually depends on: the CLI's wire shape reaching the record's `error`,
 * the parse, the schedule, and the restart re-arm. Asserting on a hand-written record would prove
 * only the last two, and the first two are where this can silently stop working.
 *
 * The FIRE is exercised through `recover()` with an elapsed deadline rather than by waiting out a
 * real timer: same code path, no 30-second test.
 */
describe('a run stopped by a usage limit resumes itself', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  const workflow: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  /** Drive one real run to a terminal status. */
  async function settle(runId: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!TERMINAL.has(store.getRun(runId)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeEach(async () => {
    savedEnv.XEZ_DRY_RUN = process.env.XEZ_DRY_RUN;
    savedEnv.XEZ_MOCK_LIMIT_RESET_SECONDS = process.env.XEZ_MOCK_LIMIT_RESET_SECONDS;
    process.env.XEZ_DRY_RUN = '1';
    // Far enough out that the schedule is unambiguous and the timer never fires mid-test.
    process.env.XEZ_MOCK_LIMIT_RESET_SECONDS = '3600';
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-auto-resume-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.local/xezar'));
  });

  /**
   * Stop the engine, THEN delete its repository — in that order, which is the whole fix (#200).
   *
   * This hook used to call `manager?.dispose()` and delete immediately, and all three parts of
   * that were wrong. `dispose()` is async and was not awaited; it is not a run-stopper by design;
   * and doing it FIRST is unrecoverable, because it clears `active`/`starting`/`queue` while
   * `cancel()` looks only in `queue` then `active` — so a run left behind could no longer be
   * stopped at all. The runs it left behind were the two the last case dequeues in its closing
   * assertion and never joins: `startedAt` is stamped BEFORE `getRepoInfo`, `createWorktree` and
   * the run's temp directory, so a poll on `startedAt` returns while the engine is still creating
   * directories under `repoRoot` — and `git worktree add` racing `rmSync` is the reported
   * `ENOTEMPTY`.
   *
   * `quiesce()` is that order: cancel everything the manager owns (queued runs included — one
   * case deliberately ends with four of them), wait for every run body to reach a terminal state,
   * then dispose. It is a wait on the bodies themselves, not a sleep, so it costs nothing when
   * there is nothing to wait for.
   */
  afterEach(async () => {
    // Ask the ENGINE which runs it still owns, before `quiesce()` empties its registries. Asking
    // the STORE instead does not work here and the difference is the whole subtlety: several
    // cases hand-write a status onto a record the engine has long since finished with — one ends
    // by setting `waiting` explicitly, "done here as the state change" — so "the record is not
    // terminal" and "something is still writing" are different questions, and only the second one
    // may block the delete. `isActive` is `active ∪ starting ∪ queue`, which is exactly the
    // population `quiesce()` is responsible for.
    const owned = manager
      ? store.listRuns().filter((record) => manager?.isActive(record.id) === true)
      : [];
    await manager?.quiesce();
    manager = undefined;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    // A survivor means `quiesce()` came back while the engine was still going, so the repository
    // is LEAKED rather than deleted: leaking a temp directory is strictly better than removing
    // one out from under a live run, and it keeps the cleanup from ever being the thing that
    // reports the fault. (A run left behind by a manager a CASE constructed and disposed itself
    // is outside this hook's reach — every case settles those inline before disposing.)
    const straggler = owned
      .map((record) => store.getRun(record.id))
      .find((record) => record && !TERMINAL.has(record.status));
    if (straggler) {
      throw new Error(
        `run ${straggler.id} was still ${straggler.status} at teardown — the case returned ` +
          `before the engine stopped writing into ${repoRoot} (temp dir deliberately leaked)`,
      );
    }
    rmSync(repoRoot, { recursive: true, force: true });
  }, TEARDOWN_TIMEOUT_MS);

  it('schedules the resume for the provider\'s reset instant plus the grace', async () => {
    manager = new RunManager(store, repoRoot);
    const record = manager.startRun(workflow, { task: 'mock:limit ship it', worktree: false });
    await settle(record.id);

    const failed = store.getRun(record.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('Claude AI usage limit reached|');
    // Read the reset instant back out of the message the provider actually sent, and require the
    // schedule to be exactly that plus the grace. Anchoring on the message rather than on
    // wall-clock windows is both the real contract and the only stable assertion — how long the
    // run itself took is a property of the machine, not of this feature.
    const epochSeconds = Number(/usage limit reached\|(\d+)/.exec(failed?.error ?? '')?.[1]);
    expect(Number.isFinite(epochSeconds)).toBe(true);
    expect(Date.parse(failed?.autoResumeAt ?? '')).toBe(epochSeconds * 1_000 + AUTO_RESUME_GRACE_MS);
    // The transcript says so too — the cockpit is not the only place this is auditable.
    const events = store.readEvents(record.id);
    expect(events.some((event) => String(event.message ?? '').includes('resuming automatically at'))).toBe(true);
  }, 30_000);

  it('leaves the run plainly failed when the setting is off', async () => {
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { autoResumeOnUsageLimit: false } }),
    });
    const record = manager.startRun(workflow, { task: 'mock:limit ship it', worktree: false });
    await settle(record.id);

    expect(store.getRun(record.id)?.status).toBe('failed');
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
  }, 30_000);

  it('schedules the next window when the resumed turn hits the limit again, and counts up', async () => {
    const first = new RunManager(store, repoRoot);
    const record = first.startRun(workflow, { task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    first.dispose();

    // The task text stays `mock:limit`, so the resumed turn walks straight back into a limit —
    // the pathological shape the cap exists for. It must schedule the NEXT window rather than
    // give up or spin.
    store.updateRun(record.id, { autoResumeAt: new Date(Date.now() - 1_000).toISOString() });
    manager = new RunManager(store, repoRoot);
    await manager.recover();

    await expect
      .poll(() => store.getRun(record.id)?.autoResumeAttempts, { timeout: 20_000 })
      .toBe(1);
    await expect
      .poll(() => store.getRun(record.id)?.autoResumeAt, { timeout: 20_000 })
      .toBeDefined();
    expect(store.getRun(record.id)?.status).toBe('failed');
  }, 40_000);

  it('never leaves a deadline behind: a record with no armed timer heals on the next sweep', async () => {
    // The shape every "timer lost" case reduces to — a restart between the write and the arm, a
    // rebuilt project context, a manager disposed mid-wait. The record is the durable half, so
    // an elapsed deadline nobody is holding must not sit in the cockpit promising a resume.
    const first = new RunManager(store, repoRoot);
    const record = first.startRun(workflow, { task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    first.dispose(); // drops the timer, keeps the record

    store.updateRun(record.id, {
      autoResumeAt: new Date(Date.now() - 1_000).toISOString(),
      task: 'mock:done ship it',
    });
    // A manager that never runs `recover()` — the reconcile rides the ordinary pump.
    manager = new RunManager(store, repoRoot);
    manager.startRun(workflow, { task: 'mock:done unrelated', worktree: false });

    await expect
      .poll(
        () => store.getRun(record.id)?.steps.find((step) => step.id === 'continue-1')?.status,
        { timeout: 20_000 },
      )
      .toBe('done');
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
  }, 40_000);

  it('retires the deadline when the resume is refused, instead of promising a past time', async () => {
    const first = new RunManager(store, repoRoot);
    const record = first.startRun(workflow, { task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    first.dispose();

    // A due deadline on a run with no session left to resume: the reconcile arms it from the
    // record, `continueRun` refuses with "no agent session to resume", and the promise has to go
    // — a hint counting down to an instant that has passed is worse than no hint.
    for (const step of store.getRun(record.id)?.steps ?? []) {
      store.updateStep(record.id, step.id, { sessionId: undefined });
    }
    store.updateRun(record.id, { autoResumeAt: new Date(Date.now() - 1_000).toISOString() });
    manager = new RunManager(store, repoRoot);
    await manager.recover();

    await expect
      .poll(() => store.getRun(record.id)?.autoResumeAt, { timeout: 20_000 })
      .toBeUndefined();
  }, 40_000);

  it('holds the queue while the account is limited — the rest never start', async () => {
    // The reported scenario: five tasks, two slots. The two that start hit the limit and become
    // `scheduled`; the other three must not be walked into the same wall just to be marked
    // scheduled too. Before the hold existed this drained the whole queue in ~500 ms.
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }),
    });
    // Isolated worktrees — the default, and the shape that matters here: an in-place run parks
    // on the repo-root lease (#438) instead of holding a slot, which is a different queue rule
    // altogether and would mask what this test is about.
    const runs = [1, 2, 3, 4, 5].map((n) =>
      manager!.startRun(workflow, { task: `mock:limit task ${n}` }),
    );

    // Two schedules is the whole story: exactly the two that had slots ever ran.
    await expect
      .poll(
        () => runs.filter((r) => store.getRun(r.id)?.autoResumeAt !== undefined).length,
        { timeout: 20_000 },
      )
      .toBe(2);
    // Give a stampede every chance to happen before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const started = runs.filter((r) => store.getRun(r.id)?.startedAt !== undefined);
    expect(started).toHaveLength(2);
    expect(runs.filter((r) => store.getRun(r.id)?.status === 'queued')).toHaveLength(3);

    // …and the hold is exactly as wide as the limit, with no restart and no timer needed:
    // cancelling both schedules releases the queue, the next pair takes their slots — and then
    // promptly holds it again by hitting the same limit, which is the mechanism working rather
    // than failing. One task never runs at all, which is the entire point.
    for (const run of started) manager.cancelAutoResume(run.id);
    await expect
      .poll(
        () => runs.filter((r) => store.getRun(r.id)?.startedAt !== undefined).length,
        { timeout: 20_000 },
      )
      .toBe(4);
    // The mirror of the guard above, and this case's headline rests on it: the poll returns the
    // instant the FOURTH `startedAt` lands, so a fifth dequeue a millisecond later would never be
    // observed and "one task never runs at all" would pass against a queue that had already
    // drained.
    //
    // The wait is a POLL on the re-established hold rather than the guard above's bare sleep,
    // because there is a real signal here and it is load-independent: the two tasks that just
    // started meet the same limit and schedule their own resumes, and `scheduleAutoResumeIfLimited`
    // publishes that deadline BEFORE releasing the slot (deliberately — a pump reads the hold off
    // the records). Two fresh deadlines therefore means the second stampede has run its course and
    // the account is held again, which no amount of machine load can fake.
    //
    // The short settle after it is NOT redundant and cannot be polled away: the last pump of the
    // stampede is floated after that record write and still has `getRepoInfo` to cross, so the
    // only remaining way for a fifth task to appear is a pump that has already been fired and has
    // not finished. Nothing observable marks its end. It is a give-the-bug-a-chance guard, so it
    // can only ever fail in the safe direction — but the poll is what keeps its budget spent on
    // that window instead of on waiting out a mock agent turn.
    await expect
      .poll(
        () => runs.filter((r) => store.getRun(r.id)?.autoResumeAt !== undefined).length,
        { timeout: 20_000 },
      )
      .toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(runs.filter((r) => store.getRun(r.id)?.startedAt !== undefined)).toHaveLength(4);
    expect(runs.filter((r) => store.getRun(r.id)?.status === 'queued')).toHaveLength(1);
  }, 60_000);

  it('holds in-place runs too, which dequeue long before they spawn', async () => {
    // The reported case. A `worktree: false` run parks on the exclusive repo-root lease (#438),
    // and a run parked there holds no slot (#347) — so the queue advances behind it and the
    // dequeue-time gate is long past by the time it spawns. Measured before the spawn-time
    // check: four of five started. In-place runs serialize on that lease, so exactly ONE gets
    // as far as the limit and the rest never start.
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }),
    });
    const runs = [1, 2, 3, 4, 5].map((n) =>
      manager!.startRun(workflow, { task: `mock:limit inplace ${n}`, worktree: false }),
    );

    await expect
      .poll(
        () => runs.filter((r) => store.getRun(r.id)?.autoResumeAt !== undefined).length,
        { timeout: 20_000 },
      )
      .toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(runs.filter((r) => store.getRun(r.id)?.startedAt !== undefined)).toHaveLength(1);
    // Handed back untouched — plain `queued`, no half-started record left behind.
    expect(runs.filter((r) => store.getRun(r.id)?.status === 'queued')).toHaveLength(4);
  }, 60_000);

  it('keeps the account held while a resume is in flight, until a turn proves the window', async () => {
    manager = new RunManager(store, repoRoot);
    const record = manager.startRun(workflow, { task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    const account = `claude:default`;
    expect([...manager.accountHolds().deadline]).toContain(account);

    // The moment the resume fires, `autoResumeAt` is gone — and if the hold ended there, every
    // queued task would dequeue and walk to the lease on EVERY cycle. That churn is what the
    // in-flight clause exists to stop, so the hold has to survive this state.
    store.updateRun(record.id, {
      status: 'queued',
      autoResumeAt: undefined,
      autoResumeAttempts: 1,
    });
    // …now an IN-FLIGHT hold rather than a deadline one: it blocks fresh work, but not another
    // resume (see `accountHeldFor`).
    expect([...manager.accountHolds().inFlight]).toContain(account);
    store.updateRun(record.id, { status: 'running' });
    expect([...manager.accountHolds().inFlight]).toContain(account);

    // A completed turn is the only evidence the window reopened — that clears the counter and
    // the hold with it. (The engine does this at every turn end; done here as the state change.)
    store.updateRun(record.id, { status: 'waiting', autoResumeAttempts: undefined });
    const settled = manager.accountHolds();
    expect(settled.deadline.size + settled.inFlight.size).toBe(0);
  }, 30_000);

  it('a resumed turn live past the proof window stops holding its account; one still inside it holds (#285)', async () => {
    // The field shape: the resume fired, its turn is running and has been for hours, and the
    // counter is still on the record because only a COMPLETED turn retires it. Every other task
    // on that account sat `queued` behind it with free slots. The hold is for the window where a
    // resume is testing whether the limit has lifted — a doomed turn dies in well under a second —
    // not for the whole of a long turn that has already proven it.
    manager = new RunManager(store, repoRoot);
    const record = manager.startRun(workflow, { task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    const account = 'claude:default';
    // Waiting out the limit: a deadline hold, whatever the clock says up to that deadline.
    expect([...manager.accountHolds().deadline]).toContain(account);

    const startedAt = Date.now();
    store.addStep(record.id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
    store.updateStep(record.id, 'continue-1', {
      status: 'running',
      startedAt: new Date(startedAt).toISOString(),
    });
    store.updateRun(record.id, {
      status: 'running',
      currentStepId: 'continue-1',
      autoResumeAt: undefined,
      autoResumeAttempts: 1,
    });
    // Still testing the window: the hold MUST stand — this is the guard the stampede needed.
    expect([...manager.accountHolds(startedAt + 1_000).inFlight]).toContain(account);
    // Live past the proof window: the window is proven, and the hold must lift.
    const proven = manager.accountHolds(startedAt + AUTO_RESUME_PROOF_MS);
    expect(proven.deadline.size + proven.inFlight.size).toBe(0);
    // …while the counter stays for the cap, which is its other reader.
    expect(store.getRun(record.id)?.autoResumeAttempts).toBe(1);

    // Derived from the durable record, so a restarted engine gives the same two answers.
    const restarted = new RunManager(store, repoRoot);
    expect([...restarted.accountHolds(startedAt + 1_000).inFlight]).toContain(account);
    expect(restarted.accountHolds(startedAt + AUTO_RESUME_PROOF_MS).inFlight.size).toBe(0);
    await restarted.dispose();

    // A resume still QUEUED for a slot has proven nothing, however long it has waited.
    store.updateRun(record.id, { status: 'queued', currentStepId: undefined });
    expect([...manager.accountHolds(startedAt + 10 * AUTO_RESUME_PROOF_MS).inFlight]).toContain(account);
  }, 30_000);

  it('the queue behind a live resume starts once the proof window passes, and not before (#285)', async () => {
    // End to end through the real scheduler: one account, a task queued behind a resume. The
    // queued task must not start while the account waits out the limit, nor while the resume is
    // testing the window — and must start once the resumed turn has stayed live past the proof
    // window, WHILE that turn is still running. Nothing else pumps here: the resumed run holds a
    // slot, so the watchdog stays out of it, and the only wake-up is the proof window's own.
    const proofMs = 4_000;
    const first = new RunManager(store, repoRoot);
    const record = first.startRun(workflow, { task: 'mock:limit resume me' });
    await settle(record.id);
    await first.dispose();
    // The next window opens in two seconds, and the resumed turn is a long one.
    store.updateRun(record.id, {
      task: 'mock:slow resume me',
      autoResumeAt: new Date(Date.now() + 2_000).toISOString(),
    });

    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }),
      resumeProofMs: proofMs,
    });
    const queued = manager.startRun(workflow, { task: 'mock:done fresh work' });
    // Half one: the account is waiting out the limit, so the fresh task is held.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(store.getRun(queued.id)?.status).toBe('queued');
    expect([...manager.accountHolds().deadline]).toContain('claude:default');

    // The resume fires and its turn goes live.
    await expect
      .poll(() => store.getRun(record.id)?.steps.find((s) => s.id === 'continue-1')?.status, {
        timeout: 15_000,
        interval: 20,
      })
      .toBe('running');
    // Half two: inside the proof window the resume is still testing — the hold stands.
    expect(store.getRun(queued.id)?.startedAt).toBeUndefined();
    expect([...manager.accountHolds().inFlight]).toContain('claude:default');

    // …and once it has stayed live past the window, the queue moves while the resume still runs.
    await expect
      .poll(() => store.getRun(queued.id)?.startedAt, { timeout: 12_000 })
      .toBeDefined();
    expect(store.getRun(record.id)?.status).toBe('running');
    expect(store.getRun(record.id)?.autoResumeAttempts).toBe(1);
    await settle(queued.id);
  }, 60_000);

  it('cancelling a live resume lifts its hold at once — the queue behind it starts (#285)', async () => {
    // A resumed run that is already `running` has no deadline and no armed timer — `continueRun`
    // retired both — so cancelling it used to clear the counter without pumping, and the queue
    // behind it stayed still until some unrelated event happened to pump it.
    const first = new RunManager(store, repoRoot);
    const record = first.startRun(workflow, { task: 'mock:limit resume me' });
    await settle(record.id);
    await first.dispose();
    store.addStep(record.id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
    store.updateStep(record.id, 'continue-1', { status: 'running', startedAt: new Date().toISOString() });
    store.updateRun(record.id, {
      status: 'running',
      currentStepId: 'continue-1',
      autoResumeAt: undefined,
      autoResumeAttempts: 1,
    });

    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }),
    });
    const queued = manager.startRun(workflow, { task: 'mock:done fresh work' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(store.getRun(queued.id)?.status).toBe('queued');

    expect(manager.cancelAutoResume(record.id)).toBe(true);
    await expect
      .poll(() => store.getRun(queued.id)?.startedAt, { timeout: 10_000 })
      .toBeDefined();
    await settle(queued.id);
    // The hand-written `running` record is not the engine's — settle it so teardown's straggler
    // check asks only about runs the engine really owns.
    store.updateRun(record.id, { status: 'failed' });
  }, 40_000);

  it('lets two resumes on one account both run — they must not hold each other', async () => {
    // The deadlock this exists to prevent, seen live: two tasks hit the limit together, both
    // schedule, both fire — and if a resume in flight holds the account, each waits for the
    // other to prove a window neither will ever get to test. Everything in the workspace stops.
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2 } });
    const first = new RunManager(store, repoRoot, { semaphore });
    const runs = [1, 2].map((n) => first.startRun(workflow, { task: `mock:limit pair ${n}` }));
    for (const run of runs) await settle(run.id);
    expect(runs.every((r) => store.getRun(r.id)?.autoResumeAt !== undefined)).toBe(true);
    first.dispose();

    // Both windows reopen together — the exact state the live deadlock started from. The task
    // text is swapped so the resumed turns can finish instead of re-limiting (that loop is
    // covered above); what is under test is whether they run AT ALL.
    for (const run of runs) {
      store.updateRun(run.id, {
        autoResumeAt: new Date(Date.now() - 1_000).toISOString(),
        task: 'mock:done pair',
      });
    }
    manager = new RunManager(store, repoRoot, { semaphore });
    await manager.recover();

    await expect
      .poll(
        () =>
          runs.filter((r) => store.getRun(r.id)?.steps.some((s) => s.id === 'continue-1' && s.status === 'done'))
            .length,
        { timeout: 25_000 },
      )
      .toBe(2);
  }, 60_000);

  it('watchdog: an idle queue with no appointment behind the hold starts work anyway', async () => {
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }),
    });
    const limited = manager.startRun(workflow, { task: 'mock:limit holder' });
    await settle(limited.id);
    const waiting = manager.startRun(workflow, { task: 'mock:done work' });
    await expect.poll(() => store.getRun(waiting.id)?.status, { timeout: 10_000 }).toBe('queued');

    // While a real appointment is ahead, sitting still is CORRECT and the watchdog must not
    // touch it — otherwise the failsafe becomes the stampede.
    await manager.rescueStalledQueue();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(store.getRun(waiting.id)?.startedAt).toBeUndefined();

    // Now the wedge: the holder keeps holding but has no deadline anyone is waiting for, and
    // nothing is running. Whatever caused it, the queue must not be stuck there.
    store.updateRun(limited.id, {
      status: 'queued',
      autoResumeAt: undefined,
      autoResumeAttempts: 1,
    });
    expect(manager.accountHolds().inFlight.size).toBe(1);

    await manager.rescueStalledQueue();
    await expect
      .poll(() => store.getRun(waiting.id)?.startedAt, { timeout: 20_000 })
      .toBeDefined();
    // startedAt is written before worktree/session setup finishes. Let the owned
    // mock task finish before teardown deletes the directory it is still writing.
    await settle(waiting.id);
  }, 60_000);

  it('watchdog: an in-place run it forces through is not handed back at the repo-root gate', async () => {
    // The same wedge as above, but the rescued run is `worktree: false` — and that is the case
    // the spawn path asks the hold question TWICE for: once at the top of `execute`, and again
    // after the exclusive repo-root lease is granted. A force override consumed by the first gate
    // leaves the second one to hand the run straight back, `dropActive` releases the slot, an
    // ordinary pump starts nothing, and sixty seconds later the watchdog repeats the whole cycle
    // — the queue never unwedges and the transcript fills with identical held-in-the-queue notes.
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }),
    });
    const limited = manager.startRun(workflow, { task: 'mock:limit holder', worktree: false });
    await settle(limited.id);
    const waiting = manager.startRun(workflow, { task: 'mock:done work', worktree: false });
    await expect.poll(() => store.getRun(waiting.id)?.status, { timeout: 10_000 }).toBe('queued');

    // Wedge it: the holder holds with no deadline anyone is waiting for, and nothing is running.
    store.updateRun(limited.id, {
      status: 'queued',
      autoResumeAt: undefined,
      autoResumeAttempts: 1,
    });
    expect(manager.accountHolds().inFlight.size).toBe(1);

    await manager.rescueStalledQueue();
    await expect.poll(() => store.getRun(waiting.id)?.startedAt, { timeout: 20_000 }).toBeDefined();
    // …and it STAYS started. A bounce at the second gate shows up as a return to `queued` with
    // `startedAt` cleared, which is exactly what the first assertion alone would miss.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(store.getRun(waiting.id)?.status).not.toBe('queued');
    expect(
      store
        .readEvents(waiting.id)
        .some((event) => String(event.message ?? '').includes('held in the queue')),
    ).toBe(false);
  }, 60_000);

  it('retires a deadline no timer is holding when the setting is off', async () => {
    // The population `reconcileAutoResumes` exists for — a record promising a resume that no
    // timer is holding — met by the setting being off: xezar restarted while it was off, the
    // config was hand-edited, or the project context was disposed mid-wait. Sweeping only the
    // armed timers leaves the deadline on the record, and a live `autoResumeAt` is not cosmetic:
    // `accountHolds()` reads it as a hold, so nothing new starts on that account, and the cockpit
    // shows a `scheduled` row for a resume that will never come.
    const first = new RunManager(store, repoRoot);
    const record = first.startRun(workflow, { task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    expect(store.getRun(record.id)?.autoResumeAt).toBeDefined();
    first.dispose(); // the timer is gone; the deadline is not

    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { autoResumeOnUsageLimit: false } }),
    });
    await manager.recover();

    await expect
      .poll(() => store.getRun(record.id)?.autoResumeAt, { timeout: 5_000 })
      .toBeUndefined();
    expect(manager.accountHolds().deadline.size).toBe(0);
    expect(
      store
        .readEvents(record.id)
        .some((event) => String(event.message ?? '').includes('automatic resume cancelled')),
    ).toBe(true);
  }, 40_000);

  it('watchdog: re-adopts a queued record the engine has no work item for', async () => {
    // The worst shape a queue can be in — and the one a live workspace ended up in: every record
    // says `queued`, several with a pending `continue-N` step, and the engine holds nothing for
    // any of them. `pump()` iterates its own queue, so such a run is invisible to it and would
    // sit there for good: neither running, nor failed, nor ever going to happen.
    const first = new RunManager(store, repoRoot);
    const record = first.startRun(workflow, { task: 'mock:done orphan', worktree: false });
    await settle(record.id);
    first.dispose();
    // Back to `queued` with nobody holding the work item — exactly what the engine sees after
    // losing one, and what a restart would otherwise be the only cure for.
    store.updateRun(record.id, { status: 'queued', finishedAt: undefined, startedAt: undefined });

    manager = new RunManager(store, repoRoot); // deliberately NO recover()
    await manager.rescueStalledQueue();

    await expect
      .poll(() => store.getRun(record.id)?.status, { timeout: 20_000 })
      .not.toBe('queued');
  }, 60_000);

  it('a re-limited resume holds the other resumes back', async () => {
    // What the live workspace showed: several windows reopen together, every resume is let
    // through, and each one re-limits — four `scheduled` where two was the answer. The moment one
    // probe meets the limit again its DEADLINE hold binds everyone on that account, resumes
    // included; only an IN-FLIGHT hold (nothing proven yet) leaves other resumes alone.
    //
    // One slot, so "who got to spawn" is unambiguous. Two scheduled runs have to be built in
    // sequence, because the hold — correctly — stops the second from ever starting otherwise.
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
    const first = new RunManager(store, repoRoot, { semaphore });
    const a = first.startRun(workflow, { task: 'mock:limit probe a' });
    await settle(a.id);
    first.cancelAutoResume(a.id); // release the hold so b can take its turn
    const b = first.startRun(workflow, { task: 'mock:limit probe b' });
    await settle(b.id);
    first.dispose();

    const runs = [a, b];
    for (const run of runs) {
      store.updateRun(run.id, { autoResumeAt: new Date(Date.now() - 1_000).toISOString() });
    }
    manager = new RunManager(store, repoRoot, { semaphore });
    await manager.recover();

    // Exactly one probe spawns and meets the limit; the other's continuation never runs.
    const spawned = () =>
      runs.filter((r) =>
        store.getRun(r.id)?.steps.some((s) => s.id.startsWith('continue-') && s.status === 'failed'),
      ).length;
    await expect.poll(spawned, { timeout: 30_000 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(spawned()).toBe(1);
  }, 90_000);

  it('holds only the limited account — other accounts keep running', async () => {
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }),
    });
    const limited = manager.startRun(workflow, { task: 'mock:limit claude work', worktree: false });
    await settle(limited.id);
    expect(store.getRun(limited.id)?.autoResumeAt).toBeDefined();

    // A second login on the same backend is a second budget (spec 2026-07-29-agent-profiles), so
    // a limit on one must not stall the other. Same shape as a different backend entirely.
    const other = manager.startRun(workflow, {
      task: 'mock:done other account',
      worktree: false,
      agentProfile: 'second',
    });
    await expect
      .poll(() => store.getRun(other.id)?.startedAt, { timeout: 20_000 })
      .toBeDefined();
  }, 60_000);

  it('never resumes a task the user resigned from — archived is archived', async () => {
    manager = new RunManager(store, repoRoot);
    const resigned = manager.startRun(workflow, { task: 'mock:limit ship it', worktree: false });
    await settle(resigned.id);
    expect(store.getRun(resigned.id)?.autoResumeAt).toBeDefined();

    // What the archive route does, and what `cancelAutoResume` guarantees on its own.
    expect(manager.cancelAutoResume(resigned.id)).toBe(true);
    store.setArchived(resigned.id, true);
    expect(store.getRun(resigned.id)?.autoResumeAt).toBeUndefined();

    // …and no later sweep may bring it back, however the deadline got there.
    store.updateRun(resigned.id, { autoResumeAt: new Date(Date.now() - 1_000).toISOString() });
    const second = new RunManager(store, repoRoot);
    await second.recover();
    await expect
      .poll(() => store.getRun(resigned.id)?.autoResumeAt, { timeout: 10_000 })
      .toBeUndefined();
    expect(store.getRun(resigned.id)?.steps.some((step) => step.id === 'continue-1')).toBe(false);
    second.dispose();
  }, 40_000);

  it('lets a long-missed deadline expire instead of reviving a task from another era', async () => {
    const first = new RunManager(store, repoRoot);
    const record = first.startRun(workflow, { task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    first.dispose();

    // Overnight is the case the feature is for and still resumes (covered above); a deadline
    // this old is not that promise any more.
    store.updateRun(record.id, {
      autoResumeAt: new Date(Date.now() - AUTO_RESUME_MISSED_WINDOW_MS - 60_000).toISOString(),
    });
    manager = new RunManager(store, repoRoot);
    await manager.recover();

    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
    expect(store.getRun(record.id)?.steps.some((step) => step.id === 'continue-1')).toBe(false);
    const events = store.readEvents(record.id);
    expect(events.some((event) => String(event.message ?? '').includes('automatic resume expired'))).toBe(true);
  }, 40_000);

  it('cancels one task without touching another that is waiting out the same window', async () => {
    manager = new RunManager(store, repoRoot);
    const kept = manager.startRun(workflow, { task: 'mock:limit keep this one', worktree: false });
    await settle(kept.id);
    // A second ACCOUNT, so the first one's hold does not park this run in the queue — the two
    // mechanisms are independent and this test is about the per-task cancel.
    const dropped = manager.startRun(workflow, {
      task: 'mock:limit drop this one',
      worktree: false,
      agentProfile: 'second',
    });
    await settle(dropped.id);
    expect(store.getRun(kept.id)?.autoResumeAt).toBeDefined();
    expect(store.getRun(dropped.id)?.autoResumeAt).toBeDefined();

    manager.cancelAutoResume(dropped.id);

    expect(store.getRun(dropped.id)?.autoResumeAt).toBeUndefined();
    expect(store.getRun(kept.id)?.autoResumeAt).toBeDefined();
  }, 40_000);

  it('cancels an armed resume when the setting is switched off mid-wait', async () => {
    // The real seam: a config PUT refreshes the shared semaphore, which pumps every manager.
    let enabled = true;
    const semaphore = new WorkspaceSemaphore({
      initial: { autoResumeOnUsageLimit: true },
      load: async () => ({ maxParallel: 2, memoryLimitMb: null, autoResumeOnUsageLimit: enabled }),
    });
    manager = new RunManager(store, repoRoot, { semaphore });
    const record = manager.startRun(workflow, { task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    expect(store.getRun(record.id)?.autoResumeAt).toBeDefined();

    enabled = false;
    await semaphore.refresh();
    expect(semaphore.autoResumeOnUsageLimit()).toBe(false);

    // The deadline is gone from the record too — leaving it would keep the thread promising a
    // resume that will never come.
    await expect.poll(() => store.getRun(record.id)?.autoResumeAt, { timeout: 5_000 }).toBeUndefined();
    const events = store.readEvents(record.id);
    expect(events.some((event) => String(event.message ?? '').includes('automatic resume cancelled'))).toBe(true);
  }, 30_000);

  it('stops scheduling once the consecutive-resume cap is spent, and says why', async () => {
    manager = new RunManager(store, repoRoot);
    const record = manager.startRun(workflow, { task: 'mock:limit ship it', worktree: false });
    // Pre-load the counter so THIS failure is the one past the cap.
    store.updateRun(record.id, { autoResumeAttempts: MAX_AUTO_RESUMES });
    await settle(record.id);

    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
    const events = store.readEvents(record.id);
    expect(events.some((event) => String(event.message ?? '').includes('automatic resume cap reached'))).toBe(true);
  }, 30_000);

  it('re-arms across a restart and resumes the task from its last session', async () => {
    const first = new RunManager(store, repoRoot);
    const record = first.startRun(workflow, { task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    expect(store.getRun(record.id)?.autoResumeAt).toBeDefined();
    first.dispose();

    // xezar was down when the window reopened — the deadline is already in the past, which the
    // re-arm floors to "fire now". The task text is swapped because a continuation carries the
    // run's own task back into the prompt (`hydrateQueuedContinuation`), and the mock replies to
    // `mock:limit` wherever it appears — this test is about the resume completing, not looping
    // (which the case below covers).
    store.updateRun(record.id, {
      autoResumeAt: new Date(Date.now() - 1_000).toISOString(),
      task: 'mock:done ship it',
    });
    manager = new RunManager(store, repoRoot);
    await manager.recover();

    // Not just "a continuation was enqueued": a deferred continuation sits at `queued` until
    // something pumps the manager, so the resume is only real once its step RUNS and settles.
    await expect
      .poll(
        () => store.getRun(record.id)?.steps.find((step) => step.id === 'continue-1')?.status,
        { timeout: 20_000 },
      )
      .toBe('done');
    expect(['done', 'review']).toContain(store.getRun(record.id)?.status);
    const events = store.readEvents(record.id);
    expect(events.some((event) => String(event.message ?? '').includes('resuming automatically (1/12)'))).toBe(true);
  }, 40_000);
});
