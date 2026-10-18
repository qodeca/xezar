import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import * as factory from '../core/runner-factory.ts';
import { createWorktree, removeWorktree } from '../git-worktree.ts';
import { reclaimWorktrees } from '../runs/retention.ts';
import { RunStore } from '../runs/store.ts';
import { closeStoreAndRemove } from '../runs/store.testkit.ts';
import { RunManager } from './run.ts';

/**
 * A retention removal and a Continue of the same run are mutually exclusive. The sweep reserves the
 * run (`RunManager.reserveForReclaim`) in the same tick as its last check, so either the Continue
 * came first and the sweep skips the run, or the sweep came first and the Continue waits until the
 * removal and its stamp are done, then re-materializes the worktree before its session starts.
 *
 * The injected `remove` is the hook between the check and `git worktree remove`.
 *
 * RED WITHOUT THE FIX: "the sweep first" — the Continue's session started in the worktree the
 * sweep then removed.
 */
const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** One session that answers DONE at once; records the folder each session started in. */
function doneRunner() {
  const cwds: string[] = [];
  const mock = vi.spyOn(factory, 'createRunner').mockImplementation(() => ({
    backend: 'claude',
    run: async () => { throw new Error('unexpected one-shot runner'); },
    interrupt: async () => {},
    startSession(spec: AgentRunSpec, emit: (event: AgentEvent) => void) {
      cwds.push(spec.cwd);
      let open = true;
      let finish!: (result: AgentRunResult) => void;
      const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
      const end = () => {
        if (!open) return;
        open = false;
        finish({ text: '', tokensUsed: 0, toolCalls: [] });
      };
      queueMicrotask(() => {
        emit({ type: 'session', sessionId: spec.sessionId ?? 'continued' });
        emit({ type: 'text', text: 'Done.\nXEZ:DONE' });
        emit({ type: 'turn-end' });
      });
      return { result, get open() { return open; }, end, interrupt: end, sendMessage: () => false };
    },
  }));
  return { cwds, restore: () => mock.mockRestore() };
}

describe('a worktree removal and a Continue of the same run never overlap', { timeout: 30_000 }, () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let runner: ReturnType<typeof doneRunner>;
  let oldId: string;
  let oldPath: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'xez-reclaim-continue-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
    store = RunStore.open(join(root, '.local/xezar'));
    runner = doneRunner();
    // Two finished tasks with worktrees; keep=1 makes the older one the removal candidate.
    const finished = async (finishedAt: string) => {
      const record = store.createRun({
        title: 't', workflow: 'quick-task', task: 'x', steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
      });
      const wt = await createWorktree(root, record.id, 'main');
      store.updateStep(record.id, 'task', { status: 'done', sessionId: `s-${record.id}`, backend: 'claude' });
      store.updateRun(record.id, {
        status: 'done', finishedAt, worktreePath: wt.path, branch: wt.branch, baseBranch: 'main',
        workflowDef: { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', prompt: '{{task}}' }] },
      });
      return { id: record.id, path: wt.path };
    };
    ({ id: oldId, path: oldPath } = await finished('2026-07-01T00:00:00.000Z'));
    await finished('2026-07-09T00:00:00.000Z');
    manager = new RunManager(store, root);
  });

  afterEach(async () => {
    await manager.quiesce();
    await manager.dispose();
    runner.restore();
    closeStoreAndRemove(store, root);
  });

  const reserve = () => {
    const fn = (manager as unknown as { reserveForReclaim?: (id: string) => (() => void) | undefined }).reserveForReclaim;
    return fn ? { reserve: (id: string) => fn.call(manager, id) } : {};
  };
  /** The Continue's own step finished (the run was already `done` before it). */
  const settled = () => expect
    .poll(() => store.getRun(oldId)?.steps.find((s) => s.id === 'continue-1')?.status, { timeout: 15_000, interval: 20 })
    .toBe('done');

  it('the sweep first: the Continue waits, then runs in a re-materialized worktree', async () => {
    let continued = false;
    const reclaimed = await reclaimWorktrees(root, store, 1, {
      ...reserve(),
      remove: async (repo, path) => {
        // The hook between the check and the removal: a Continue lands now.
        expect(manager.continueRun(oldId, { text: 'one more thing' })).toEqual({ ok: true });
        continued = true;
        // Give the Continue every chance to reach its session before the directory goes.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await removeWorktree(repo, path);
      },
    });
    expect(continued).toBe(true);
    expect(reclaimed).toEqual([oldId]);
    await settled();
    // The session started only after the removal, in a worktree that exists again.
    expect(runner.cwds).toEqual([oldPath]);
    expect(existsSync(oldPath)).toBe(true);
    expect(store.getRun(oldId)?.worktreeReclaimedAt).toBeUndefined();
  });

  it('the Continue first: the sweep skips the run', async () => {
    expect(manager.continueRun(oldId, { text: 'one more thing' })).toEqual({ ok: true });
    const removed: string[] = [];
    const reclaimed = await reclaimWorktrees(root, store, 1, {
      ...reserve(),
      remove: async (repo, path) => { removed.push(path); await removeWorktree(repo, path); },
    });
    expect(reclaimed).toEqual([]);
    expect(removed).toEqual([]);
    await settled();
    expect(existsSync(oldPath)).toBe(true);
  });
});
