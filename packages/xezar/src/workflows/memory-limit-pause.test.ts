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

  /** The live `active` registry — same reach-in the #489 nudge suite uses. Resolved fresh on
   *  every call, never hoisted, because `manager` is only assigned inside `beforeEach`. */
  const activeMap = (): Map<string, { session?: { open: boolean } }> =>
    (manager as unknown as { active: Map<string, { session?: { open: boolean } }> }).active;

  /** The live `ActiveRun` the memory guard reads — same reach-in the #489 nudge suite uses. */
  const waitForOpenSession = async (id: string): Promise<void> => {
    await waitFor(() => Boolean(activeMap().get(id)?.session?.open), 'the step session to open');
  };

  /** `enforceMemoryLimit` is normally driven by the shared `ps` sampler on a ~2s tick
   *  (#memory-guard) — called directly here for a deterministic, instant breach. */
  const triggerMemoryPause = (id: string): Promise<void> =>
    (manager as unknown as {
      enforceMemoryLimit(snapshot: Record<string, { rssBytes: number }>): Promise<void>;
    }).enforceMemoryLimit({ [id]: { rssBytes: 999_999_999_999 } });

  /** Detach this manager from the real process-tree sampler (`onUsage`, the constructor's
   *  subscription `dispose()` also releases), so the direct trigger below is the ONLY thing
   *  that can pause the session. */
  const detachRealSampler = (): void => {
    (manager as unknown as { offUsage(): void }).offUsage();
  };

  it('ends failed, naming the memory limit — never done, on the fresh-run path', async () => {
    // The real sampler is detached because at the 1 MiB ceiling it races the wait below:
    // `registerRunProcess` takes a first sample the instant the session is published, and on a
    // host where the fresh child already shows more than 1 MiB RSS that sample closes the session
    // within one `ps` call. A 25 ms poll for `session.open` can then miss the whole open window,
    // the run settles `failed`, and the wait times out whatever its bound — the 15 s timeout CI
    // hit on #618 (the Linux first-sample RSS is inferred; a stub delivering that breach right
    // after `publishSession` reproduces the timeout exactly).
    // Detached, the interactive last step's session stays open until the direct trigger closes
    // it, so the wait is for a state that holds once reached and the pause has exactly one cause.
    detachRealSampler();
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
    // The post-first-turn state is BUILT, not produced by a first turn: a persisted `done` run
    // whose step carries a resumable session, exactly what a finished run looks like to Continue
    // and to restart recovery. Continue then opens a SECOND `ActiveRun` (`runContinuation`) — the
    // #811-shaped twin construction site `runAgentStep`'s fix does not cover.
    //
    // It is built rather than run because a real first turn cannot reach `done` here: the 1 MiB
    // ceiling this suite needs is also seen by the real process-tree sampler (`onUsage`, ~2 s
    // tick), which ends any live turn that outlasts one tick as a memory-limit failure. Under
    // CI load the mock's first turn did outlast it, so the run read `failed` and a wait for
    // `done` could never be met, whatever its bound.
    const record = store.createRun({
      title: 'first pass',
      workflow: AGENT.name,
      task: 'first pass',
      worktree: false,
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
    });
    store.updateRun(record.id, {
      status: 'done',
      finishedAt: new Date().toISOString(),
      workflowDef: AGENT,
    });
    store.updateStep(record.id, 'task', { status: 'done', sessionId: 'sess-603', backend: 'claude' });
    currentId = record.id;

    expect(manager.continueRun(record.id, { text: 'now do the second half' }).ok).toBe(true);
    // The real sampler may pause this session before the direct trigger below does. Both go
    // through the same `enforceMemoryLimit`, so either one is the case under test; wait for the
    // session to open or the run to settle, and the trigger is a no-op once the session closed.
    await waitFor(
      () => Boolean(activeMap().get(record.id)?.session?.open) || store.getRun(record.id)?.status === 'failed',
      'the continuation session to open',
    );

    await triggerMemoryPause(record.id);

    await waitFor(
      () => store.getRun(record.id)?.status === 'failed' || store.getRun(record.id)?.status === 'done',
      'the continuation to settle',
    );

    const run = store.getRun(record.id);
    expect(run?.status).toBe('failed');
    expect(run?.error).toContain('memory limit exceeded');
    expect(run?.steps.find((s) => s.id === 'continue-1')?.status).toBe('failed');
  }, 30_000);
});
