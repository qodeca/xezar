import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { MAX_AUTO_CONTINUES, RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * #59 (coverage gap R20) — the third and last way a parked run wakes itself.
 * A parked run has exactly three wake sources: a user message, the monitoring
 * wake timer, and the autonomous turn-end nudge (#489) asserted here. The first
 * two are covered by the `XEZ:MONITORING` block in `run.test.ts`; this file is
 * that block's other half.
 *
 * WHY IT IS A SEPARATE FILE, and not sitting beside its twin where it belongs:
 * a leaked `RunManager` in `run.test.ts` keeps its 60 s queue watchdog
 * (`QUEUE_WATCHDOG_MS`) ticking after its temp root is deleted (#125), so once
 * that file's TOTAL runtime crosses ~60 s the watchdog writes into a directory
 * that is gone and `npm test` exits non-zero. The trip-wire is a property of
 * that file's runtime, not of any test in it: appending a no-op test that only
 * sleeps 16 s to `run.test.ts`, otherwise unchanged, reproduces the identical
 * failure. `run.test.ts` sits ~7 s under the line and this block needs ~25 s (it
 * grew when #141 made the nudge real and added two guard tests), so
 * it gets its own vitest worker and its own clock. Fold it back into
 * `run.test.ts` once #125 is fixed — there is no other reason for the split.
 *
 * WHAT IT PINS. `AUTONOMOUS_NUDGE` is `run.ts`'s answer to "who fires this?" for
 * an autonomous run: at turn end, instead of handing the ball back to the user,
 * the manager sends the agent a canned "keep going" message (bounded by
 * `MAX_AUTO_CONTINUES = 40`) and records an `autonomous — continuing without
 * pausing (n/40)` note. `ActiveRun` is built at TWO sites and both are exercised
 * here, because AGENTS.md names that asymmetry (incident #811) as the shape this
 * defect takes: `execute` (a freshly started run) and `runContinuation`
 * (Continue, and every restart-recovery resume).
 *
 * ⚠ THE NUDGE USED TO BE DEAD CODE, at BOTH sites, in complementary ways — the
 * exact #811 shape, mirrored. `execute` set `autonomous` on the `ActiveRun` it
 * builds but its turn-end handler never read it; `runContinuation`'s turn-end
 * handler DID read `state.autonomous`, but the `ActiveRun` it builds never set
 * it. So `state.autonomous === true` was written at one site and read only at
 * the other, and the nudge fired nowhere: an autonomous run stopped after one
 * turn and parked — no error, no failed status, and to the user it looked
 * exactly like an agent that decided it was finished.
 *
 * **#141 fixed both halves** and the two tests that used to pin the defect now
 * assert the intent instead (their `INTENDED:` markers are gone, replaced by the
 * real expectation). One helper — `autoContinueTurn` — is the single sender of
 * `AUTONOMOUS_NUDGE`, called from BOTH turn-end handlers, and `runContinuation`
 * reads `autonomous` off the run record when it rebuilds its `ActiveRun`.
 * Reverting either half alone turns exactly one of those two tests red, which is
 * the asymmetry #59 asked to have asserted.
 *
 * ON COUNTING NUDGES. The dry-run mock answers every message and never volunteers
 * `XEZ:DONE`, so a nudged autonomous run legitimately keeps going: nudge, turn,
 * nudge, … until `MAX_AUTO_CONTINUES`. The tests therefore assert the FIRST note
 * is `… (1/40)` and that at least one fired, rather than an exact total that only
 * describes how fast the machine happened to be. The cap itself has its own guard
 * test below.
 *
 * GUARD TESTS (must pass before AND after #141 — they pin what must NOT change):
 * `a non-autonomous run …`, `an autonomous run that emitted XEZ:DONE …`,
 * `a paused autonomous run …`, `the nudge stops at MAX_AUTO_CONTINUES` and
 * `an autonomous run skips the review gate …`.
 */
describe('the autonomous turn-end nudge (#489, gap R20)', () => {
  // Same isolation rule as the #490 block in `run.test.ts`: these runs PARK or
  // auto-continue, and a `worktree:false` run holds the exclusive repo-root
  // lock, so a shared manager would starve the next test.
  let repoRoot: string;
  let logDir: string;
  let stdinLog: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };
  /** The note `run.ts` writes for every delivered nudge. */
  const NUDGE_NOTE = 'autonomous — continuing without pausing';
  /** A distinctive slice of `AUTONOMOUS_NUDGE` itself, as it reaches the CLI. */
  const NUDGE_TEXT = 'Continue working autonomously until the task is fully complete';

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-59-'));
    // The stdin capture lives OUTSIDE the repo: these runs work in the repo
    // working tree (`worktree: false`), and a growing log inside it would show
    // up as a diff in the review-gate case below.
    logDir = mkdtempSync(join(tmpdir(), 'xez-59-log-'));
    stdinLog = join(logDir, 'stdin.ndjson');
    savedEnv.XEZ_DRY_RUN = process.env.XEZ_DRY_RUN;
    savedEnv.XEZ_MOCK_STDIN_FILE = process.env.XEZ_MOCK_STDIN_FILE;
    savedEnv.XEZ_REVIEW_GATE = process.env.XEZ_REVIEW_GATE;
    process.env.XEZ_DRY_RUN = '1';
    process.env.XEZ_MOCK_STDIN_FILE = stdinLog;
    delete process.env.XEZ_REVIEW_GATE;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    manager = new RunManager(store, repoRoot);
    currentId = undefined;
  });

  afterEach(() => {
    if (currentId) manager.cancel(currentId); // release the session + repo lock
    // This file disposes its own managers, so it adds no new instance of the
    // leaked-watchdog shape #125 describes. It does not fix the existing ones.
    manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const readEvents = (id: string): Array<Record<string, unknown>> => {
    const path = join(repoRoot, '.local/xezar/runs', `${id}.ndjson`);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };

  /** Every message the mock CLI actually received, in order. */
  const inbound = (): string[] =>
    existsSync(stdinLog)
      ? readFileSync(stdinLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => String((JSON.parse(l) as { userText?: string }).userText ?? ''))
      : [];

  const nudgeNotes = (id: string): Array<Record<string, unknown>> =>
    readEvents(id).filter((e) => e.type === 'note' && String(e.message ?? '').includes(NUDGE_NOTE));

  /** The live `ActiveRun` the turn-end handler reads, once the run has built it. */
  type LiveState = { autonomous?: boolean; autoContinues?: number };
  const waitForActiveRun = async (id: string, ms = 10_000): Promise<LiveState> => {
    const states = (manager as unknown as { active: Map<string, LiveState> }).active;
    const deadline = Date.now() + ms;
    for (;;) {
      const state = states.get(id);
      if (state) return state;
      if (Date.now() > deadline) throw new Error('ActiveRun not built in time');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  /**
   * A turn-end reached, with nothing left in flight. The two settled shapes a
   * NON-nudged turn-end can take: parked `waiting` (the ball is with the user)
   * or the run already finished (`done`/`review`).
   */
  const settled = (r: RunRecord | undefined): boolean =>
    r?.status === 'waiting' || r?.status === 'done' || r?.status === 'review';

  it('an autonomous run started through execute IS nudged at turn end — it keeps going instead of parking (#141)', async () => {
    // #141, the `execute` half: the handler now reads the `autonomous` this site
    // has always set, so the turn-end nudges itself, records `… (1/40)` and stays
    // out of `waiting`. Revert `execute`'s call to `autoContinueTurn` and this
    // test goes red while the `runContinuation` one below stays green.
    const record = manager.startRun(SINGLE_STEP, {
      task: 'keep going on the login bug',
      worktree: false,
      autonomous: true,
    });
    currentId = record.id;
    await waitFor(record.id, (r) => nudgeNotes(record.id).length > 0 || settled(r));
    // Give a nudge that fired late the same wall clock a delivered one needs.
    await new Promise((r) => setTimeout(r, 750));

    // The flag really is on — this is an autonomous run, not a mis-set fixture.
    expect(store.getRun(record.id)?.autonomous).toBe(true);
    const state = (manager as unknown as {
      active: Map<string, { autonomous?: boolean }>;
    }).active.get(record.id);
    expect(state?.autonomous).toBe(true); // `execute` populates the state…

    // …and the turn-end handler now reads it.
    expect(nudgeNotes(record.id).length).toBeGreaterThan(0);
    expect(String(nudgeNotes(record.id)[0]?.message)).toContain(`(1/${MAX_AUTO_CONTINUES})`);
    expect(inbound().some((text) => text.includes(NUDGE_TEXT))).toBe(true);
    expect(store.getRun(record.id)?.status).toBe('running'); // never parked
    // Whatever the outcome, the engine never fabricates a user turn — the same
    // rule the monitoring wake follows. This half is not a defect and must hold
    // before AND after #141: a nudge is the engine's own message.
    expect(readEvents(record.id).filter((e) => e.type === 'user-message')).toHaveLength(0);
  }, 30_000);

  it('a non-autonomous run at the same turn end is not nudged — it parks as waiting (guard)', async () => {
    // GUARD, and the behaviour most at risk from #141: a plain run still hands
    // the ball back to the user, exactly as before the fix. Passes both ways.
    const record = manager.startRun(SINGLE_STEP, {
      task: 'keep going on the login bug',
      worktree: false,
    });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    // Give the (absent) nudge the same wall clock the autonomous case needs.
    await new Promise((r) => setTimeout(r, 750));

    expect(nudgeNotes(record.id)).toHaveLength(0);
    expect(inbound().some((text) => text.includes(NUDGE_TEXT))).toBe(false);
    expect(store.getRun(record.id)?.status).toBe('waiting');
  }, 30_000);

  it('an autonomous run that emitted XEZ:DONE is finished, not nudged (guard)', async () => {
    // GUARD, unchanged by #141: `XEZ:DONE` closes the session before the nudge
    // branch is reached, so the completion marker still outranks autonomy.
    const record = manager.startRun(SINGLE_STEP, {
      task: 'mock:done ship the fix',
      worktree: false,
      autonomous: true,
    });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'done' || r?.status === 'review');

    expect(store.getRun(record.id)?.status).toBe('done');
    expect(nudgeNotes(record.id)).toHaveLength(0);
    expect(inbound().some((text) => text.includes(NUDGE_TEXT))).toBe(false);
  }, 30_000);

  it('an autonomous run resumed through runContinuation IS nudged too — the second construction site (#141)', async () => {
    // #141, the #811 half. `runContinuation` is the site whose turn-end handler
    // always read `state.autonomous` — the `ActiveRun` it builds now carries the
    // field, read off the run record, so Continue and every restart recovery keep
    // autonomy instead of losing it silently the way registry `/skill` expansion
    // did. Fixing only `execute` leaves THIS test red: that is the asymmetry #59
    // asked to have asserted, and it is the experiment #141 demands.
    const record = manager.startRun(SINGLE_STEP, {
      task: 'mock:done first pass',
      worktree: false,
      autonomous: true,
    });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'done' || r?.status === 'review');
    const beforeContinue = nudgeNotes(record.id).length;

    // Continue builds a SECOND ActiveRun. The follow-up carries no marker, so
    // the turn ends with the session open — the nudge's whole reason to exist.
    expect(manager.continueRun(record.id, { text: 'now do the second half' }).ok).toBe(true);
    // `continueRun` schedules; the status only leaves `done` once the
    // continuation is really under way. Wait for that BEFORE waiting for the
    // turn to settle, or the still-`done` record reads as an ended turn.
    await waitFor(record.id, (r) => r?.status === 'running');
    await waitFor(record.id, (r) => nudgeNotes(record.id).length > beforeContinue || settled(r));
    await new Promise((r) => setTimeout(r, 750));

    expect(nudgeNotes(record.id).length).toBeGreaterThan(beforeContinue);
    // The continuation's own `ActiveRun` starts a fresh budget, so its first
    // nudge is `(1/40)` — proof `autoContinues` is initialised here, not left
    // `undefined` for `MAX_AUTO_CONTINUES` to compare against.
    expect(String(nudgeNotes(record.id)[beforeContinue]?.message)).toContain(
      `(1/${MAX_AUTO_CONTINUES})`,
    );
    expect(inbound().some((text) => text.includes(NUDGE_TEXT))).toBe(true);
    expect(store.getRun(record.id)?.status).toBe('running'); // never parked
    // The cause, asserted beside the symptom: the RECORD says autonomous, and so
    // now does the rebuilt `ActiveRun` the turn-end handler actually reads.
    expect(store.getRun(record.id)?.autonomous).toBe(true);
    expect(
      (manager as unknown as { active: Map<string, { autonomous?: boolean }> })
        .active.get(record.id)?.autonomous,
    ).toBe(true);
  }, 30_000);

  it('a paused autonomous run is not nudged — the pause holds and it parks (guard)', async () => {
    // GUARD for the suppression in `enforceMemoryLimits`: a run paused over the
    // memory limit clears `state.autonomous` precisely so the auto-continue
    // cannot undo the pause. This reproduces that one write on the live
    // `ActiveRun` and asserts the turn end honours it. Red the moment
    // `autoContinueTurn` stops checking the flag.
    const record = manager.startRun(SINGLE_STEP, {
      task: 'keep going on the login bug',
      worktree: false,
      autonomous: true,
    });
    currentId = record.id;
    const state = await waitForActiveRun(record.id);
    state.autonomous = false; // exactly what the memory-limit pause writes
    await waitFor(record.id, (r) => r?.status === 'waiting');
    await new Promise((r) => setTimeout(r, 750));

    expect(nudgeNotes(record.id)).toHaveLength(0);
    expect(inbound().some((text) => text.includes(NUDGE_TEXT))).toBe(false);
    expect(store.getRun(record.id)?.status).toBe('waiting');
  }, 30_000);

  it('the nudge stops at MAX_AUTO_CONTINUES — a spent budget parks (guard)', async () => {
    // GUARD for the safety cap. Spending the budget up front is the whole test:
    // an autonomous run whose `autoContinues` has reached the cap must park like
    // any other run instead of nudging forever. Both construction sites read the
    // same counter through the same helper, so this bounds both paths.
    const record = manager.startRun(SINGLE_STEP, {
      task: 'keep going on the login bug',
      worktree: false,
      autonomous: true,
    });
    currentId = record.id;
    const state = await waitForActiveRun(record.id);
    expect(state.autoContinues).toBe(0); // initialised, never `undefined`
    state.autoContinues = MAX_AUTO_CONTINUES;
    await waitFor(record.id, (r) => r?.status === 'waiting');
    await new Promise((r) => setTimeout(r, 750));

    expect(state.autonomous).toBe(true); // still autonomous — only the budget ran out
    expect(nudgeNotes(record.id)).toHaveLength(0);
    expect(inbound().some((text) => text.includes(NUDGE_TEXT))).toBe(false);
    expect(store.getRun(record.id)?.status).toBe('waiting');
  }, 30_000);

  it('an autonomous run skips the review gate end to end, even with a real diff (guard)', async () => {
    // The unit-level twin lives in `run.test.ts`'s `settleSuccess` block; this
    // pins the same rule through the whole `execute` spine, where `autonomous`
    // has to survive from the composer input to the terminal transition. Not
    // affected by #141 — it reads the RECORD, which is populated correctly.
    process.env.XEZ_REVIEW_GATE = '1';
    const record = manager.startRun(SINGLE_STEP, {
      task: 'mock:done touch a file',
      worktree: true,
      autonomous: true,
    });
    currentId = record.id;
    await waitFor(record.id, (r) => ['done', 'review', 'failed'].includes(r?.status ?? ''));

    expect(store.getRun(record.id)?.status).toBe('done'); // never `review`
  }, 30_000);
});
