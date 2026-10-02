import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { closeStoreAndRemove } from '../runs/store.testkit.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/** Every session a (mocked) runner started, with the hand that ends it. */
const sessions = vi.hoisted(() => ({
  started: [] as Array<{ spec: AgentRunSpec; fail: (message: string) => void }>,
}));

vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent: (event: AgentEvent) => void) => {
      let fail: (message: string) => void = () => undefined;
      const result = new Promise<never>((_resolve, reject) => {
        // As the real runners do: the error event first, then the rejection.
        fail = (message) => {
          onEvent({ type: 'error', message });
          reject(new Error(message));
        };
      });
      sessions.started.push({ spec, fail });
      return { result, sendMessage: () => false, end: () => {}, interrupt: () => {}, open: true };
    },
    interrupt: async () => {},
  }),
}));

/** Two agent steps, so the first is an ordinary, non-interactive step whose failure ends the run. */
const TWO_STEPS: WorkflowDef = {
  name: 'two-steps',
  source: 'built-in',
  steps: [
    { id: 'first', prompt: '{{task}}' },
    { id: 'second', prompt: 'then {{task}}' },
  ],
};

/** One agent step: what a Continue resumes. */
const ONE_STEP: WorkflowDef = { name: 'one-step', source: 'built-in', steps: [{ id: 'task', prompt: '{{task}}' }] };

/** A check that runs until it is stopped, and an agent step after it: a stopped check that were
 *  recorded would fail the run (or, with an `onFail`, retry). */
const LONG_CHECK = 'sleep 60';
const CHECK_FIRST: WorkflowDef = {
  name: 'check-first',
  source: 'built-in',
  steps: [
    { id: 'check', command: LONG_CHECK },
    { id: 'after', prompt: 'then {{task}}' },
  ],
};

/** What the Windows tree stop leaves an agent CLI with: exit code 1, as from TerminateProcess. */
const STOPPED_EXIT = 'claude CLI exited with code 1';

/**
 * The Windows `serve` shutdown stops the programs xezar started before it exits (#963 Q-01). The
 * run managers are held first, so those exits are recorded as nothing at all: the runs stay live
 * on disk, and the next start's `recover()` resumes them – the outcome an immediate POSIX exit
 * has. The shutdown calls `holdForExit()` only on Windows; the hold itself is the same on every
 * OS, so this runs everywhere.
 */
describe('RunManager.holdForExit (serve shutdown, #963)', () => {
  let dir: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    sessions.started.length = 0;
    // Not a git repository: the run works in place, with no worktree to create.
    dir = mkdtempSync(join(tmpdir(), 'xez-exit-hold-'));
    store = RunStore.open(join(dir, '.local', 'xezar'));
    manager = new RunManager(store, dir);
  });

  afterEach(async () => {
    await manager.dispose();
    closeStoreAndRemove(store, dir);
  });

  interface StoredRun {
    id: string;
    status?: string;
    steps?: Array<{ id: string; status: string }>;
  }

  function onDisk(runId: string): StoredRun | undefined {
    const runs = JSON.parse(readFileSync(join(store.dataDir, 'runs.json'), 'utf8')) as StoredRun[];
    return runs.find((run) => run.id === runId);
  }

  function eventLines(runId: string): string[] {
    const path = join(store.dataDir, 'runs', `${runId}.ndjson`);
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [];
  }

  async function runningFirstStep(): Promise<string> {
    const record = manager.startRun(TWO_STEPS, { task: 'do the thing' });
    await expect.poll(() => sessions.started.length, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => store.getRun(record.id)?.status).toBe('running');
    return record.id;
  }

  /** Long enough for a body that is NOT parked to record the failure and start the next thing. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 500));

  it('the control: without the hold, the stopped agent fails the step and the run', async () => {
    const runId = await runningFirstStep();
    sessions.started[0]!.fail(STOPPED_EXIT);
    await expect.poll(() => store.getRun(runId)?.status, { timeout: 10_000 }).toBe('failed');
  });

  it('records nothing for an agent the shutdown stops: the run stays running on disk', async () => {
    const runId = await runningFirstStep();
    const linesBefore = eventLines(runId).length;

    await manager.holdForExit();
    sessions.started[0]!.fail(STOPPED_EXIT);
    await settle();

    expect(onDisk(runId)?.status).toBe('running');
    expect(onDisk(runId)?.steps?.find((step) => step.id === 'first')?.status).toBe('running');
    expect(eventLines(runId)).toHaveLength(linesBefore);
    expect(store.getRun(runId)?.status).toBe('running');
    // No next step, no retry: nothing else was started.
    expect(sessions.started).toHaveLength(1);
  });

  // GUARD: green with or without the gates – `dispose()` alone already blocks a new start.
  it('starts nothing new once held, not even a run queued after it', async () => {
    await runningFirstStep();
    await manager.holdForExit();
    manager.startRun(TWO_STEPS, { task: 'another thing' });
    await settle();
    expect(sessions.started).toHaveLength(1);
  });

  /** A finished run whose step carries a resumable session, then a Continue: the #367 path the
   *  hold protects – a Continue in flight at shutdown must resume on the next start (C-05). */
  async function continuingRun(): Promise<string> {
    const record = store.createRun({
      title: 'first pass',
      workflow: ONE_STEP.name,
      task: 'first pass',
      worktree: false,
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
    });
    store.updateRun(record.id, { status: 'done', finishedAt: new Date().toISOString(), workflowDef: ONE_STEP });
    store.updateStep(record.id, 'task', { status: 'done', sessionId: 'sess-hold', backend: 'claude' });
    expect(manager.continueRun(record.id, { text: 'carry on' }).ok).toBe(true);
    await expect.poll(() => sessions.started.length, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => store.getRun(record.id)?.status).toBe('running');
    return record.id;
  }

  const continuation = (runId: string) => store.getRun(runId)?.steps.find((step) => step.id === 'continue-1');

  it('the control: without the hold, a stopped Continue session fails the continuation', async () => {
    const runId = await continuingRun();
    sessions.started[0]!.fail(STOPPED_EXIT);
    await expect.poll(() => continuation(runId)?.status, { timeout: 10_000 }).toBe('failed');
  });

  it('records nothing for a Continue session the shutdown stops, held in the same tick as production', async () => {
    const runId = await continuingRun();
    const linesBefore = eventLines(runId).length;

    // index.ts does not wait for the hold before it stops the programs.
    void manager.holdForExit();
    sessions.started[0]!.fail(STOPPED_EXIT);
    await settle();

    expect(store.getRun(runId)?.status).toBe('running');
    expect(continuation(runId)?.status).toBe('running');
    expect(onDisk(runId)?.status).toBe('running');
    expect(eventLines(runId)).toHaveLength(linesBefore);
    expect(sessions.started).toHaveLength(1);
  });

  /** A run whose first step is a check that runs until something stops it. */
  async function runningCheck(): Promise<{ runId: string; stopCheck: () => void }> {
    const record = manager.startRun(CHECK_FIRST, { task: 'check it' });
    await expect.poll(() => eventLines(record.id).some((line) => line.includes(`$ ${LONG_CHECK}`)), { timeout: 10_000 }).toBe(true);
    // The command starts in the same tick as its `$ …` note, so its stop is in place now; taken
    // before the hold, whose dispose() forgets the run's state.
    const state = (manager as unknown as { active: Map<string, { interrupt: () => void }> }).active.get(record.id)!;
    return { runId: record.id, stopCheck: () => state.interrupt() };
  }

  const checkStep = (runId: string) => store.getRun(runId)?.steps.find((step) => step.id === 'check');

  it('the control: without the hold, a stopped check fails its step and the run', async () => {
    const { runId, stopCheck } = await runningCheck();
    stopCheck();
    await expect.poll(() => store.getRun(runId)?.status, { timeout: 15_000 }).toBe('failed');
    expect(checkStep(runId)?.status).toBe('failed');
  }, 30_000);

  it('records nothing for a check the shutdown stops: no output, no retry, no next step (C-05)', async () => {
    const { runId, stopCheck } = await runningCheck();
    const linesBefore = eventLines(runId).length;

    void manager.holdForExit();
    stopCheck();
    await settle();
    await settle();

    expect(checkStep(runId)?.status).toBe('running');
    expect(store.getRun(runId)?.status).toBe('running');
    expect(onDisk(runId)?.status).toBe('running');
    expect(eventLines(runId)).toHaveLength(linesBefore);
    expect(sessions.started).toHaveLength(0);
  }, 30_000);
});
