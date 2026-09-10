import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * failure. `run.test.ts` sits ~7 s under the line and this block needs ~13 s, so
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
 * ⚠ THE NUDGE IS CURRENTLY DEAD CODE, at BOTH sites, in complementary ways —
 * the exact #811 shape, mirrored. `execute` sets `autonomous` on the `ActiveRun`
 * it builds (`run.ts:2596`) but its turn-end handler (`runAgentStep`,
 * `run.ts:3014`) never reads it; `runContinuation`'s turn-end handler
 * (`run.ts:2376`) DOES read `state.autonomous`, but the `ActiveRun` it builds
 * (`run.ts:2247`) never sets it. So `state.autonomous === true` is written at one
 * site and read only at the other, and the nudge fires nowhere. An autonomous run
 * therefore stops after one turn and parks — no error, no failed status, and to
 * the user it looks exactly like an agent that decided it was finished.
 *
 * That defect is tracked as **#141**. Two tests below therefore PIN the current
 * broken behaviour instead of asserting the intent: they are named
 * `(pinned defect)` and every pinned expectation carries the value it must take
 * once #141 is fixed, marked `INTENDED:`. Fixing #141 turns them red on purpose —
 * they are the executable specification for that fix, and updating them to the
 * `INTENDED:` values is part of it. Fixing only the `execute` half leaves the
 * `runContinuation` test green, which is exactly the asymmetry #59 asks to have
 * asserted.
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

  /**
   * A turn-end reached, with nothing left in flight. The two settled shapes a
   * NON-nudged turn-end can take: parked `waiting` (the ball is with the user)
   * or the run already finished (`done`/`review`).
   */
  const settled = (r: RunRecord | undefined): boolean =>
    r?.status === 'waiting' || r?.status === 'done' || r?.status === 'review';

  it('an autonomous run started through execute is NOT nudged at turn end — it parks as waiting (pinned defect)', async () => {
    // #141. INTENDED: the turn-end nudges itself, records `… (1/40)` and stays
    // out of `waiting`. ACTUAL: `runAgentStep`'s turn-end handler has no
    // autonomous branch at all, so the run hands the ball straight back to the
    // user after ONE turn. Wiring the nudge into `execute` turns the three
    // `INTENDED:` expectations below.
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
    expect(state?.autonomous).toBe(true); // `execute` DOES populate the state…

    // …and the turn-end handler that would use it does not exist.
    expect(nudgeNotes(record.id)).toHaveLength(0); // INTENDED (#141): one `… (1/40)` note
    expect(inbound().some((text) => text.includes(NUDGE_TEXT))).toBe(false); // INTENDED (#141): true
    expect(store.getRun(record.id)?.status).toBe('waiting'); // INTENDED (#141): still `running`
    // Whatever the outcome, the engine never fabricates a user turn — the same
    // rule the monitoring wake follows. This half is not a defect and must hold
    // before AND after #141: a nudge is the engine's own message.
    expect(readEvents(record.id).filter((e) => e.type === 'user-message')).toHaveLength(0);
  }, 30_000);

  it('a non-autonomous run at the same turn end is not nudged — it parks as waiting', async () => {
    // The control, and it must keep passing after #141 is fixed: a plain run
    // still hands the ball back to the user.
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

  it('an autonomous run that emitted XEZ:DONE is finished, not nudged', async () => {
    // Also unchanged by #141: `XEZ:DONE` closes the session before the nudge
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

  it('an autonomous run resumed through runContinuation is NOT nudged either — the second construction site (pinned defect)', async () => {
    // #141, the #811 half. `runContinuation` is the ONE site whose turn-end
    // handler does read `state.autonomous` — but the `ActiveRun` it builds omits
    // the field, so the read is always `undefined`. Continue and every restart
    // recovery therefore lose autonomy silently, exactly the way registry
    // `/skill` expansion did. Fixing only `execute` leaves this test GREEN,
    // which is the asymmetry #59 asks to have asserted.
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

    expect(nudgeNotes(record.id)).toHaveLength(beforeContinue); // INTENDED (#141): one more
    expect(inbound().some((text) => text.includes(NUDGE_TEXT))).toBe(false); // INTENDED (#141): true
    expect(store.getRun(record.id)?.status).toBe('waiting'); // INTENDED (#141): still `running`
    // The cause, pinned beside the symptom: the RECORD says autonomous, the
    // rebuilt `ActiveRun` the turn-end handler actually reads does not.
    expect(store.getRun(record.id)?.autonomous).toBe(true);
    expect(
      (manager as unknown as { active: Map<string, { autonomous?: boolean }> })
        .active.get(record.id)?.autonomous,
    ).toBeUndefined(); // INTENDED (#141): true
  }, 30_000);

  it('an autonomous run skips the review gate end to end, even with a real diff', async () => {
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
