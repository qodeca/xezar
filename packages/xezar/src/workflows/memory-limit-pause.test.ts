import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * #603: `enforceMemoryLimit` closes a breaching run's session with `state.session.end()`
 * (a graceful EOF close, or — if the CLI does not exit on its own — the forced SIGTERM/SIGKILL
 * teardown that #703 deliberately settles as "our own signal coming back", not an agent crash).
 * Either way `session.result` resolves without throwing, and before this fix the step-completion
 * handler had no way to tell that xezar itself cut the session off mid-turn — it read the clean
 * resolution exactly like a legitimate `XEZ:DONE` close and recorded the step, and the run, `done`
 * with no deliverable. `ActiveRun.memoryLimitPause` is what `enforceMemoryLimit` now sets, and
 * what `runAgentStep` (the fresh-run body) and `runContinuation` (Continue / restart recovery)
 * both check right after `session.result` settles.
 */
describe('a run xezar terminates for the memory limit (#603)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  const AGENT: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-603-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: repoRoot });
    savedEnv.XEZ_DRY_RUN = process.env.XEZ_DRY_RUN;
    process.env.XEZ_DRY_RUN = '1';
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    // A 1 MiB ceiling: any process-tree sample the test hands `enforceMemoryLimit` breaches it,
    // without needing the real `ps` sampler this method is normally piggy-backed on (#memory-guard).
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2, memoryLimitMb: 1 } }),
    });
    currentId = undefined;
  });

  afterEach(() => {
    if (currentId) manager.cancel(currentId);
    manager.dispose();
    if (savedEnv.XEZ_DRY_RUN === undefined) delete process.env.XEZ_DRY_RUN;
    else process.env.XEZ_DRY_RUN = savedEnv.XEZ_DRY_RUN;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = async (
    pred: () => boolean,
    what: string,
    ms = 15_000,
  ): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  /** The live `ActiveRun` the memory guard reads — same reach-in the #489 nudge suite uses. */
  const waitForOpenSession = async (id: string): Promise<void> => {
    const active = (manager as unknown as { active: Map<string, { session?: { open: boolean } }> }).active;
    await waitFor(() => Boolean(active.get(id)?.session?.open), 'the step session to open');
  };

  /** `enforceMemoryLimit` is normally driven by the shared `ps` sampler on a ~2s tick
   *  (#memory-guard) — called directly here for a deterministic, instant breach. */
  const triggerMemoryPause = (id: string): Promise<void> =>
    (manager as unknown as {
      enforceMemoryLimit(snapshot: Record<string, { rssBytes: number }>): Promise<void>;
    }).enforceMemoryLimit({ [id]: { rssBytes: 999_999_999_999 } });

  it('ends failed, naming the memory limit — never done, on the fresh-run path', async () => {
    const record = manager.startRun(AGENT, { task: 'do the thing', worktree: false });
    currentId = record.id;
    await waitForOpenSession(record.id);

    await triggerMemoryPause(record.id);

    await waitFor(
      () => store.getRun(record.id)?.status === 'failed' || store.getRun(record.id)?.status === 'done',
      'the run to settle',
    );

    const run = store.getRun(record.id);
    expect(run?.status).toBe('failed');
    expect(run?.error).toContain('memory limit exceeded');
    expect(run?.steps.find((s) => s.id === 'task')?.status).toBe('failed');
    // `failed` is one of the statuses `continueRun` accepts — the leader can resume it.
    expect(manager.continueRun(record.id, { text: 'resume it' }).ok).toBe(true);
  }, 30_000);

  it('ends failed, naming the memory limit — never done, on the Continue/restart-recovery path', async () => {
    // `mock:done` closes the first turn cleanly, so the run is genuinely `done` and Continue
    // opens a SECOND `ActiveRun` (`runContinuation`) — the #811-shaped twin construction site
    // `runAgentStep`'s fix does not cover.
    const record = manager.startRun(AGENT, { task: 'mock:done first pass', worktree: false });
    currentId = record.id;
    await waitFor(() => store.getRun(record.id)?.status === 'done', 'the first turn to finish');

    expect(manager.continueRun(record.id, { text: 'now do the second half' }).ok).toBe(true);
    await waitFor(() => store.getRun(record.id)?.status === 'running', 'the continuation to start');
    await waitForOpenSession(record.id);

    await triggerMemoryPause(record.id);

    await waitFor(
      () => store.getRun(record.id)?.status === 'failed' || store.getRun(record.id)?.status === 'done',
      'the continuation to settle',
    );

    const run = store.getRun(record.id);
    expect(run?.status).toBe('failed');
    expect(run?.error).toContain('memory limit exceeded');
  }, 30_000);
});
