import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUN_MARKER_ENV, RunProcessSweeper, type RunProcessSweeperDeps } from '../runs/run-process-sweeper.ts';
import { FakeMachine } from '../runs/run-process-sweeper.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { closeStoreAndRemove } from '../runs/store.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * #943 wiring: `RunManager` hands a paused, cancelled, closed or timed-out run – and one whose CLI
 * the EOF watchdog had to stop – to its `RunProcessSweeper`, waits for a pending sweep before a
 * new life of the run starts anything (R2), enrols every sweep so `quiesce()` waits for it (R3), and lets a cancel that lands during
 * a timeout sweep end the run cancelled (R6). The sweeper runs over a fake Linux machine here –
 * no real process is touched; `memory-limit-pause.test.ts` proves the real thing.
 */

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const ONE_STEP: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] };
/** A read-only step: its tools name neither Edit nor Write (`isReadOnlyStep`). */
const READ_ONLY: WorkflowDef = {
  name: 'review',
  source: 'built-in',
  steps: [{ id: 'review', name: 'Review', prompt: '{{task}}', allowedTools: ['Read', 'Grep', 'Glob', 'Bash'] }],
};
const TIMED: WorkflowDef = {
  name: 'timed',
  source: 'built-in',
  steps: [
    { id: 'work', name: 'Work', prompt: '{{task}}', timeout: '2s' },
    { id: 'wrap', name: 'Wrap up', prompt: 'wrap up' },
  ],
};
const SERVER_PID = 4121;
const OTHER_RUN_PID = 5001;
/** 0.001 minutes = 60 ms: the idle close fires almost at once after the session parks. */
const IDLE_MINUTES = 0.001;
/** A `claude` that finishes its turn with `XEZ:DONE` and then never exits on its own. */
const DONE_THEN_HANGS = fileURLToPath(new URL('../core/__fixtures__/claude/stub-done-ignores-eof.mjs', import.meta.url));

/** A promise the test opens by hand, and a flag that says someone is waiting on it. */
class Gate {
  entered = false;
  private open!: () => void;
  readonly opened = new Promise<void>((resolve) => {
    this.open = resolve;
  });
  release(): void {
    this.open();
  }
}

/** The sweeper with one extra seam: `hold` makes the next `pending()` answer a gate, as if an
 *  earlier life of the run were still being swept. */
class HoldingSweeper extends RunProcessSweeper {
  hold: Promise<void> | undefined;
  override pending(runId: string): Promise<void> | undefined {
    const held = this.hold;
    this.hold = undefined;
    return held ?? super.pending(runId);
  }
}

describe('RunManager and the run-process sweep (#943)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let machine: FakeMachine;
  let sweeper: HoldingSweeper;
  let tableGate: Gate | undefined;
  let argsFile: string;
  const savedEnv: Record<string, string | undefined> = {};

  function build(resources: { idleTimeoutMinutes?: number } = {}): void {
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2, memoryLimitMb: 100_000, ...resources } }),
      runProcesses: (hooks) => {
        const deps: RunProcessSweeperDeps = machine.deps({
          readTable: async () => {
            const gate = tableGate;
            if (gate) {
              gate.entered = true;
              await gate.opened;
            }
            return machine.table();
          },
        });
        sweeper = new HoldingSweeper(hooks, deps);
        return sweeper;
      },
    });
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-943-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: repoRoot });
    for (const key of ['XEZ_DRY_RUN', 'XEZ_MOCK_ARGS_FILE', 'XEZ_CLAUDE_BIN']) savedEnv[key] = process.env[key];
    process.env.XEZ_DRY_RUN = '1';
    delete process.env.XEZ_CLAUDE_BIN;
    argsFile = join(repoRoot, 'mock-args.ndjson');
    process.env.XEZ_MOCK_ARGS_FILE = argsFile;
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    machine = new FakeMachine('linux', process.pid);
    tableGate = undefined;
    build();
  });

  afterEach(async () => {
    tableGate?.release();
    await manager.quiesce();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    closeStoreAndRemove(store, repoRoot);
  });

  const waitFor = async (pred: () => boolean, what: string, ms = 20_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const activeMap = (): Map<string, { session?: { open: boolean } }> =>
    (manager as unknown as { active: Map<string, { session?: { open: boolean } }> }).active;
  const sessionOpen = (id: string): boolean => Boolean(activeMap().get(id)?.session?.open);
  const triggerMemoryPause = (id: string): Promise<void> =>
    (manager as unknown as { enforceMemoryLimit(snapshot: Record<string, { rssBytes: number }>): Promise<void> })
      .enforceMemoryLimit({ [id]: { rssBytes: 999_999_999_999 } });
  const events = (id: string) => store.readEvents(id) as Array<{ type: string; message?: string; text?: string }>;
  const isReport = (e: { type: string; message?: string }): boolean => e.type === 'note' && /^(Stopped|Could not stop) /.test(e.message ?? '');
  const reportNotes = (id: string) => events(id).filter(isReport);
  const spawns = (): number => (existsSync(argsFile) ? readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean).length : 0);
  const status = (id: string) => store.getRun(id)?.status;

  /** A background server of this run, and a process of another run, on the fake machine. */
  function leaveBackgroundServer(runId: string): void {
    machine.add(
      { pid: SERVER_PID, ppid: 1, startedAt: 1_000, environ: [`${RUN_MARKER_ENV}=${runId}`], cmdline: 'node server.js --port 3000' },
      { pid: OTHER_RUN_PID, ppid: 1, startedAt: 1_000, environ: [`${RUN_MARKER_ENV}=another-run`], cmdline: 'node other.js' },
    );
  }

  it('a cancel stops what the run left running and names it in one note, after "run cancelled"', async () => {
    const run = manager.startRun(ONE_STEP, { task: 'start a dev server', worktree: false });
    await waitFor(() => sessionOpen(run.id), 'the session to open');
    leaveBackgroundServer(run.id);
    expect(manager.cancel(run.id)).toBe(true);
    await waitFor(() => reportNotes(run.id).length === 1, 'the report note');
    expect(status(run.id)).toBe('cancelled');
    expect(machine.isAlive(SERVER_PID)).toBe(false);
    expect(machine.isAlive(OTHER_RUN_PID)).toBe(true);
    const all = events(run.id);
    const note = all.find(isReport)!;
    expect(note.message).toBe(`Stopped 1 program this task started: ${SERVER_PID} node server.js --port 3000.`);
    expect(all.findIndex((e) => e.message === 'run cancelled')).toBeLessThan(all.indexOf(note));
  }, 60_000);

  /** The run has left the active set and its sweep, if any, has finished. */
  const settled = async (id: string): Promise<void> => {
    await waitFor(() => !manager.isActive(id), 'the run to end', 40_000);
    await sweeper.pending(id);
  };
  const stoppedServerNote = `Stopped 1 program this task started: ${SERVER_PID} node server.js --port 3000.`;

  it('an idle close stops what the run left running (owner 2026-10-19)', async () => {
    await manager.dispose();
    build({ idleTimeoutMinutes: IDLE_MINUTES });
    const run = manager.startRun(ONE_STEP, { task: 'start a dev server', worktree: false });
    leaveBackgroundServer(run.id);
    await settled(run.id);
    expect(events(run.id).some((e) => e.type === 'lifecycle' && (e.message ?? '').includes('of inactivity'))).toBe(true);
    expect(machine.isAlive(SERVER_PID)).toBe(false);
    expect(machine.isAlive(OTHER_RUN_PID)).toBe(true);
    expect(reportNotes(run.id).map((e) => e.message)).toEqual([stoppedServerNote]);
  }, 60_000);

  it('a Finish on a waiting session stops what the run left running (owner 2026-10-19)', async () => {
    const run = manager.startRun(ONE_STEP, { task: 'start a dev server', worktree: false });
    await waitFor(() => status(run.id) === 'waiting', 'the session to park');
    leaveBackgroundServer(run.id);
    expect(manager.finish(run.id)).toBe(true);
    await settled(run.id);
    expect(status(run.id)).toBe('done');
    expect(machine.isAlive(SERVER_PID)).toBe(false);
    expect(machine.isAlive(OTHER_RUN_PID)).toBe(true);
    expect(reportNotes(run.id).map((e) => e.message)).toEqual([stoppedServerNote]);
  }, 60_000);

  it('a CLI the EOF watchdog stops after XEZ:DONE has what the run left running stopped too (owner 2026-10-19)', async () => {
    process.env.XEZ_CLAUDE_BIN = DONE_THEN_HANGS;
    const run = manager.startRun(ONE_STEP, { task: 'start a dev server', worktree: false });
    leaveBackgroundServer(run.id);
    await settled(run.id);
    // The agent finished: the run is done, and only the watchdog's stop of its CLI asks for the sweep.
    expect(status(run.id)).toBe('done');
    expect(events(run.id).some((e) => e.type === 'lifecycle' && e.message === 'goal achieved — session closed')).toBe(true);
    expect(machine.isAlive(SERVER_PID)).toBe(false);
    expect(machine.isAlive(OTHER_RUN_PID)).toBe(true);
    expect(reportNotes(run.id).map((e) => e.message)).toEqual([stoppedServerNote]);
  }, 60_000);

  it('an agent error stops what the run left running (owner 2026-10-19)', async () => {
    const run = manager.startRun(ONE_STEP, { task: 'mock:auth-error', worktree: false });
    leaveBackgroundServer(run.id);
    await settled(run.id);
    expect(status(run.id)).toBe('failed');
    expect(machine.isAlive(SERVER_PID)).toBe(false);
    expect(machine.isAlive(OTHER_RUN_PID)).toBe(true);
    expect(reportNotes(run.id).map((e) => e.message)).toEqual([stoppedServerNote]);
  }, 60_000);

  it('a backend that fails the session is an agent error too (owner 2026-10-19)', async () => {
    const failing = join(repoRoot, 'claude-exits-one.mjs');
    writeFileSync(failing, "#!/usr/bin/env node\nprocess.stdin.once('data', () => process.exit(1));\n", { mode: 0o755 });
    process.env.XEZ_CLAUDE_BIN = failing;
    const run = manager.startRun(ONE_STEP, { task: 'start a dev server', worktree: false });
    leaveBackgroundServer(run.id);
    await settled(run.id);
    expect(status(run.id)).toBe('failed');
    expect(machine.isAlive(SERVER_PID)).toBe(false);
    expect(reportNotes(run.id).map((e) => e.message)).toEqual([stoppedServerNote]);
  }, 60_000);

  it('an agent error in a Continue stops what the run left running (owner 2026-10-19)', async () => {
    const run = manager.startRun(ONE_STEP, { task: 'mock:done', worktree: false });
    await settled(run.id);
    leaveBackgroundServer(run.id);
    expect(manager.continueRun(run.id, { text: 'mock:auth-error' }).ok).toBe(true);
    await waitFor(() => manager.isActive(run.id), 'the continuation to start');
    await settled(run.id);
    expect(status(run.id)).toBe('failed');
    expect(machine.isAlive(SERVER_PID)).toBe(false);
    expect(reportNotes(run.id).map((e) => e.message)).toEqual([stoppedServerNote]);
  }, 60_000);

  it('an autonomous read-only step that finishes at its nudge bound stops what the run left running (owner 2026-10-19)', async () => {
    const run = manager.startRun(READ_ONLY, { task: 'review the change', worktree: false, autonomous: true });
    leaveBackgroundServer(run.id);
    await settled(run.id);
    expect(status(run.id)).toBe('done');
    expect(events(run.id).some((e) => e.type === 'note' && (e.message ?? '').startsWith('autonomous read-only step finished'))).toBe(true);
    expect(machine.isAlive(SERVER_PID)).toBe(false);
    expect(reportNotes(run.id).map((e) => e.message)).toEqual([stoppedServerNote]);
  }, 60_000);

  it('a run that ends on its own sweeps nothing', async () => {
    const run = manager.startRun(ONE_STEP, { task: 'mock:done', worktree: false });
    leaveBackgroundServer(run.id);
    await waitFor(() => !manager.isActive(run.id), 'the run to end');
    expect(machine.signals).toEqual([]);
    expect(reportNotes(run.id)).toEqual([]);
  }, 60_000);

  it('a paused run can Continue; the new session waits for the pause sweep, and the note follows the pause (AC-12c, R9)', async () => {
    const run = manager.startRun(ONE_STEP, { task: 'start a dev server', worktree: false });
    await waitFor(() => sessionOpen(run.id), 'the session to open');
    leaveBackgroundServer(run.id);
    tableGate = new Gate();
    await triggerMemoryPause(run.id);
    await waitFor(() => status(run.id) === 'failed', 'the pause to settle the run');
    await waitFor(() => tableGate!.entered, 'the pause sweep to start');
    const spawnsBefore = spawns();

    expect(manager.continueRun(run.id, { text: 'carry on' }).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(spawns()).toBe(spawnsBefore); // nothing started beside the sweep
    expect(sessionOpen(run.id)).toBe(false);

    tableGate.release();
    await waitFor(() => spawns() === spawnsBefore + 1, 'the continuation session to start');
    await waitFor(() => sessionOpen(run.id), 'the continuation session to open');
    expect(machine.isAlive(SERVER_PID)).toBe(false);

    const all = events(run.id);
    const paused = all.findIndex((e) => e.type === 'lifecycle' && (e.message ?? '').startsWith('paused — memory limit exceeded'));
    const note = all.findIndex(isReport);
    const resumed = all.findIndex((e) => e.type === 'user-message' && e.text === 'carry on');
    expect(paused).toBeGreaterThanOrEqual(0);
    // R9, accepted: the note follows the pause, and here – the sweep held open – the Continue too.
    expect(paused).toBeLessThan(resumed);
    expect(resumed).toBeLessThan(note);
    // #603 unchanged: the paused step is a failed, Continue-able step naming the limit.
    const record = store.getRun(run.id)!;
    expect(record.steps.find((s) => s.id === 'task')?.status).toBe('failed');
    expect(record.steps.find((s) => s.id === 'task')?.error).toContain('memory limit exceeded');
  }, 60_000);

  it('a fresh body waits for a pending sweep and ends cancelled if cancelled meanwhile (R2)', async () => {
    const gate = new Gate();
    sweeper.hold = gate.opened;
    // With a worktree: the cancelled exit must come before anything is prepared, not at the step loop.
    const run = manager.startRun(ONE_STEP, { task: 'never starts' });
    await waitFor(() => manager.isActive(run.id), 'the run to be active');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spawns()).toBe(0);
    expect(manager.cancel(run.id)).toBe(true);
    gate.release();
    await waitFor(() => status(run.id) === 'cancelled', 'the run to end cancelled');
    expect(spawns()).toBe(0);
    expect(events(run.id).some((e) => e.type === 'step-start')).toBe(false);
    expect(store.getRun(run.id)?.worktreePath).toBeUndefined();
  }, 60_000);

  it('a cancel during a timeout sweep ends the run cancelled, with no further spawn (R6)', async () => {
    tableGate = new Gate();
    const run = manager.startRun(TIMED, { task: 'mock:slow', worktree: false });
    await waitFor(() => sessionOpen(run.id), 'the session to open');
    leaveBackgroundServer(run.id);
    await waitFor(() => tableGate!.entered, 'the timeout sweep to start', 30_000);
    expect(manager.cancel(run.id)).toBe(true);
    tableGate.release();
    await waitFor(() => !manager.isActive(run.id), 'the run to end');
    expect(status(run.id)).toBe('cancelled');
    expect(spawns()).toBe(1); // "wrap" never started
    await waitFor(() => sweeper.pending(run.id) === undefined, 'the sweeps to finish');
    expect(machine.isAlive(SERVER_PID)).toBe(false);
    expect(reportNotes(run.id)).toHaveLength(1); // the cancel's chained sweep found nothing more
  }, 60_000);

  it('quiesce() waits for a pending sweep, and its note lands before teardown (R3)', async () => {
    const run = manager.startRun(ONE_STEP, { task: 'start a dev server', worktree: false });
    await waitFor(() => sessionOpen(run.id), 'the session to open');
    leaveBackgroundServer(run.id);
    tableGate = new Gate();
    manager.cancel(run.id);
    await waitFor(() => tableGate!.entered, 'the cancel sweep to start');
    let quiesced = false;
    const quiescing = manager.quiesce().then(() => {
      quiesced = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(quiesced).toBe(false);
    tableGate.release();
    await quiescing;
    expect(reportNotes(run.id)).toHaveLength(1);
    build(); // afterEach quiesces a fresh manager
  }, 60_000);

  it('dispose() does not wait for a sweep, and a sweep that outlives it appends nothing (R3)', async () => {
    const run = manager.startRun(ONE_STEP, { task: 'start a dev server', worktree: false });
    await waitFor(() => sessionOpen(run.id), 'the session to open');
    leaveBackgroundServer(run.id);
    tableGate = new Gate();
    manager.cancel(run.id);
    await waitFor(() => tableGate!.entered, 'the cancel sweep to start');
    const pending = sweeper.pending(run.id)!;
    await manager.dispose();
    tableGate.release();
    await pending;
    expect(machine.isAlive(SERVER_PID)).toBe(false);
    expect(reportNotes(run.id)).toEqual([]);
    build();
  }, 60_000);

  it('after a crash, start-up sweeps what the interrupted turn left before the run resumes (#982)', async () => {
    // A finished first turn gives the run a session to resume; then the engine "dies" mid-turn:
    // the record still says running, and a server that turn started is still alive.
    const run = manager.startRun(ONE_STEP, { task: 'mock:done', worktree: false });
    await waitFor(() => !manager.isActive(run.id), 'the first turn to end');
    await manager.quiesce();
    store.updateStep(run.id, 'task', { status: 'running' });
    store.updateRun(run.id, { status: 'running', currentStepId: 'task', finishedAt: undefined });
    leaveBackgroundServer(run.id);
    const spawnsBefore = spawns();

    tableGate = new Gate();
    build();
    await manager.recover();
    await waitFor(() => tableGate!.entered, 'the restart sweep to start');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(spawns()).toBe(spawnsBefore); // the resumed turn waits for the sweep

    tableGate.release();
    await waitFor(() => reportNotes(run.id).length === 1, 'the report note');
    await waitFor(() => spawns() === spawnsBefore + 1, 'the resumed turn to start');
    expect(machine.isAlive(SERVER_PID)).toBe(false);
    expect(machine.isAlive(OTHER_RUN_PID)).toBe(true);
    expect(reportNotes(run.id)[0]!.message).toBe(`Stopped 1 program this task started: ${SERVER_PID} node server.js --port 3000.`);
  }, 60_000);
});
