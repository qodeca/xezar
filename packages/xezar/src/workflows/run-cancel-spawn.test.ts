import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * A cancel that lands while an agent session is still being spawned (#229).
 *
 * `cancel()` stops a live turn through `state.interrupt()`, and that function points at the
 * session only from the moment `publishSession` installs it. Between the step loop's own
 * `if (state.cancelled) break` and that moment it is the `() => undefined` placeholder, and the
 * code in between is awaited (`configuredModelProvider`, `agentEnvForStep`, a team skill's
 * `materializeSkillDir`). A cancel landing there set the flag and delivered nothing; the session
 * spawned anyway, an interactive step has no wall clock, and the turn-end handler reads
 * `sessionOpen` as `!state.cancelled && session.open` — so the run neither parked at `waiting` nor
 * ended. It reported `running` until a second cancel. That is the stuck task #229 describes, and
 * it is what 0.13.1 does: `publishSession` and its trailing re-check arrived after that release, in
 * #249 (`c889f03`).
 *
 * `run-quiesce.test.ts` already pins the re-check on the fresh-step site, through `quiesce()` and
 * a `mock:done` turn. This file pins what that case does not reach: the plain `cancel()` the
 * cockpit's Cancel button sends, on a session that would otherwise stay open, at BOTH
 * construction sites `publishSession` serves — `runAgentStep` and `runContinuation`.
 *
 * Which case is which, and what each was proved red against:
 *   - REGRESSION `a cancel that lands while the step's session spawns ends the run` — red with
 *     `publishSession`'s trailing `if (state.cancelled) session.interrupt()` removed, and red with
 *     `runAgentStep`'s `publishSession` call replaced by the pre-#249 inline assignment.
 *   - REGRESSION `a cancel that lands while a Continue session spawns ends the run` — red with the
 *     same trailing re-check removed, and red with ONLY `runContinuation`'s call replaced by the
 *     inline assignment (the fresh-step case stays green then, so each site has its own proof).
 *   - GUARD `a cancel before the agent step starts still stops it` — the step loop's own check.
 *     Passes with and without the re-check, on purpose: it pins behaviour that must not change.
 *   - GUARD `a cancel one tick after the session opens closes it` — the ordinary path. Passes
 *     with and without the re-check. It pins the other direction of the race: a cancel arriving
 *     just after `publishSession` must go through the `state.interrupt` it installed, and the
 *     session it closes must not be left behind as a live process.
 *
 * Every agent session here is the bundled mock (`XEZ_DRY_RUN=1`) behind a two-line wrapper that
 * records its pid, so "the session did not leak" is an assertion about a real process rather than
 * about a record.
 */

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const TERMINAL = ['done', 'failed', 'cancelled', 'review'];
const TEST_TIMEOUT_MS = 40_000;

/**
 * How long a cancelled run may take to settle. Without the fix it never does, so this is a
 * fail-fast bound on a hang, not a performance budget: comfortably above the milliseconds a
 * cancelled mock session takes, comfortably below `TEST_TIMEOUT_MS`, so a red run reports the
 * stuck status as the failed assertion rather than as a hook timeout.
 */
const SETTLE_CEILING_MS = 15_000;

const MOCK_CLAUDE = join(import.meta.dirname, '../../scripts/mock-claude.mjs');

/** One agent step and nothing after it, so the step is interactive: its session has no wall
 *  clock and, once a turn ends, stays open for follow-ups. That is the shape the stuck runs had. */
const interactiveAgent: WorkflowDef = {
  name: 'interactive-agent',
  source: 'built-in',
  steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
};

/** A check step that runs until it is killed, then the agent step. `exec` so the process xezar
 *  spawned IS node and a SIGTERM reaches it directly. */
const checkThenAgent: WorkflowDef = {
  name: 'check-then-agent',
  source: 'built-in',
  steps: [
    { id: 'hold', command: `exec node -e 'setTimeout(() => {}, ${TEST_TIMEOUT_MS})'` },
    { id: 'work', name: 'Work', prompt: '{{task}}' },
  ],
};

interface Fixture {
  root: string;
  binDir: string;
  store: RunStore;
  manager: RunManager;
  started: string[];
  start: (workflow: WorkflowDef, input: Parameters<RunManager['startRun']>[1]) => string;
  /** Every mock `claude` pid spawned for this fixture, in spawn order. */
  pids: () => number[];
}

const fixtures: Fixture[] = [];
const saved: Record<string, string | undefined> = {};
const PINNED = ['XEZ_DRY_RUN', 'XEZ_AUTONAME', 'XEZ_CLAUDE_BIN'] as const;

beforeEach(() => {
  for (const key of PINNED) saved[key] = process.env[key];
  process.env.XEZ_DRY_RUN = '1';
  // The run namer is floated by `startRun`; off, so the only agent processes are the ones under test.
  process.env.XEZ_AUTONAME = '0';
});

afterEach(async () => {
  try {
    for (const f of fixtures.splice(0)) {
      // A red case leaves its session live. A second cancel reaches it by now — the mitigation
      // #226 had to use — so teardown can drain instead of waiting on a stuck body forever.
      await waitFor(() => {
        for (const id of f.started) if (f.manager.isActive(id)) f.manager.cancel(id);
        return f.started.every((id) => !f.manager.isActive(id));
      }, 'every run to stop at teardown').catch(() => undefined);
      await f.manager.quiesce();
      f.store.flush();
      rmSync(f.root, { recursive: true, force: true });
      rmSync(f.binDir, { recursive: true, force: true });
    }
  } finally {
    for (const key of PINNED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}, TEST_TIMEOUT_MS);

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'xez-cancel-spawn-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  // Outside the repository, so nothing the wrapper writes can appear in a diff.
  const binDir = mkdtempSync(join(tmpdir(), 'xez-cancel-spawn-bin-'));
  const pidFile = join(binDir, 'pids');
  const wrapper = join(binDir, 'claude.mjs');
  writeFileSync(
    wrapper,
    [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');`,
      `await import(${JSON.stringify(pathToFileURL(MOCK_CLAUDE).href)});`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  process.env.XEZ_CLAUDE_BIN = wrapper;
  const store = RunStore.open(join(root, '.local/xezar'));
  const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2 } });
  const manager = new RunManager(store, root, { semaphore });
  const started: string[] = [];
  const f: Fixture = {
    root,
    binDir,
    store,
    manager,
    started,
    start: (workflow, input) => {
      const id = manager.startRun(workflow, input).id;
      started.push(id);
      return id;
    },
    pids: () =>
      existsSync(pidFile)
        ? readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number)
        : [],
  };
  fixtures.push(f);
  return f;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = SETTLE_CEILING_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The run's status once it is terminal AND the engine has let go of it, or whatever it still
 *  says when the ceiling runs out — so a red case fails on `expected 'running' to be
 *  'cancelled'`, the symptom itself. Both halves matter: a continued run still reads its old
 *  terminal `done` until `runContinuation` rewrites it, and `isActive()` is what is true from
 *  `continueRun`'s return onwards. */
async function statusAfterSettling(f: Fixture, runId: string): Promise<string | undefined> {
  await waitFor(
    () => !f.manager.isActive(runId) && TERMINAL.includes(f.store.getRun(runId)?.status ?? ''),
    `run ${runId} to settle`,
  ).catch(() => undefined);
  return f.store.getRun(runId)?.status;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Cancel a run from inside the store's synchronous event fan-out, the moment `match` sees the
 *  event it is waiting for. Deterministic rather than likely: `appendEvent` calls its listeners
 *  before it returns, so the cancel lands at an exact point in the run body. */
function cancelOn(f: Fixture, match: (event: { type: string; stepId?: unknown }) => boolean): () => void {
  let fired = false;
  const listener = (payload: { runId: string; event: { type: string; stepId?: unknown } }): void => {
    if (fired || !match(payload.event)) return;
    fired = true;
    f.manager.cancel(payload.runId);
  };
  f.store.on('event', listener);
  return () => f.store.off('event', listener);
}

describe('a cancel that lands while an agent session is being spawned (#229)', () => {
  it(
    'REGRESSION: a cancel that lands while the step\'s session spawns ends the run',
    async () => {
      const f = fixture();
      // `step-start` is emitted one statement after the loop's cancel check and before every await
      // on the way to the spawn, so this cancel is guaranteed to land inside the window.
      const off = cancelOn(f, (e) => e.type === 'step-start' && e.stepId === 'work');
      try {
        const runId = f.start(interactiveAgent, { task: 'stay open for follow-ups', worktree: false });
        expect(await statusAfterSettling(f, runId)).toBe('cancelled');
        expect(f.manager.isActive(runId)).toBe(false);
        // Supplementary: SIGTERM can beat the wrapper's first line, so an empty list is possible
        // here and proves nothing. The populated case is the post-open guard below.
        await waitFor(() => f.pids().every((pid) => !alive(pid)), 'the mock session to exit');
      } finally {
        off();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'REGRESSION: a cancel that lands while a Continue session spawns ends the run',
    async () => {
      const f = fixture();
      // A finished run with a session to resume; `mock:done` closes the first session on its own.
      const runId = f.start(interactiveAgent, { task: 'mock:done first turn', worktree: false });
      await waitFor(() => ['done', 'review'].includes(f.store.getRun(runId)?.status ?? ''), 'the first turn to finish');
      await waitFor(() => !f.manager.isActive(runId), 'the first turn to release the run');

      // `runContinuation` emits `step-start` after adopting its `ActiveRun` and before the awaits
      // that lead to its own `startSession` — the same window, at the second construction site.
      const off = cancelOn(f, (e) => e.type === 'step-start' && e.stepId === 'continue-1');
      try {
        expect(f.manager.continueRun(runId, { text: 'stay open for follow-ups' })).toEqual({ ok: true });
        expect(await statusAfterSettling(f, runId)).toBe('cancelled');
        expect(f.manager.isActive(runId)).toBe(false);
        await waitFor(() => f.pids().every((pid) => !alive(pid)), 'the mock sessions to exit');
      } finally {
        off();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'GUARD: a cancel before the agent step starts still stops it',
    async () => {
      const f = fixture();
      const runId = f.start(checkThenAgent, { task: 'never reached', worktree: false });
      // Wait on the event, then cancel from a LATER tick: the check's child is spawned in the
      // same tick as `step-start`, so this cancel meets a live check step, as a user's would.
      await waitFor(
        () => f.store.readEvents(runId).some((e) => e.type === 'step-start' && e.stepId === 'hold'),
        'the check step to start',
      );
      expect(f.manager.cancel(runId)).toBe(true);

      expect(await statusAfterSettling(f, runId)).toBe('cancelled');
      const work = f.store.getRun(runId)?.steps.find((s) => s.id === 'work');
      expect(work?.status).toBe('pending');
      expect(work?.sessionId).toBeUndefined();
      expect(f.pids()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'GUARD: a cancel one tick after the session opens closes it',
    async () => {
      const f = fixture();
      // `session.started` comes from the runner reading the mock's `init` line, which can only
      // happen after `startSession` returned and `publishSession` ran: this cancel is the first
      // thing to reach a published session, and it must take the ordinary path.
      const off = cancelOn(f, (e) => e.type === 'session.started' && e.stepId === 'work');
      try {
        const runId = f.start(interactiveAgent, { task: 'stay open for follow-ups', worktree: false });
        expect(await statusAfterSettling(f, runId)).toBe('cancelled');
        expect(f.manager.isActive(runId)).toBe(false);
        // Populated by construction: the wrapper records its pid before the mock prints `init`.
        expect(f.pids().length).toBeGreaterThan(0);
        await waitFor(() => f.pids().every((pid) => !alive(pid)), 'the mock session to exit');
      } finally {
        off();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
