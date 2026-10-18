import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, SessionOptions } from '../core/agent-runner.ts';
import * as factory from '../core/runner-factory.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';

/**
 * A Continue after a mid-workflow failure only hands the remaining steps over once its turn ends
 * with `XEZ:DONE` (#520). A non-autonomous continued turn without the marker parks at `waiting`,
 * and closing that session fails the task with "remaining workflow requires XEZ:DONE from the
 * continued turn". Restart recovery used to settle the same parked session as a success instead,
 * so the task ended `done` and the later check never ran.
 *
 * RED WITHOUT THE FIX: the first case. GUARD (passes both ways): a parked LAST step still settles.
 */

/** One scripted turn per session; a session never ends on its own, like a parked interactive one. */
function scriptedRunner(turns: string[]) {
  let spawned = 0;
  const mock = vi.spyOn(factory, 'createRunner').mockImplementation(() => ({
    backend: 'claude',
    run: async () => { throw new Error('unexpected one-shot runner'); },
    interrupt: async () => {},
    startSession(spec: AgentRunSpec, emit: (event: AgentEvent) => void, options?: SessionOptions) {
      const text = turns[spawned++];
      if (text === undefined) throw new Error('unscripted agent invocation');
      let open = true;
      let finish!: (result: AgentRunResult) => void;
      const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
      const end = () => {
        if (!open) return;
        open = false;
        finish({ text: '', tokensUsed: 0, toolCalls: [] });
      };
      queueMicrotask(() => {
        emit({ type: 'session', sessionId: spec.sessionId ?? `session-${spawned}` });
        emit({ type: 'text', text });
        emit({ type: 'turn-end' });
        if (options?.autoEndAfterFirstTurn) end();
      });
      return { result, get open() { return open; }, end, interrupt: end, sendMessage: () => false };
    },
  }));
  return { spawned: () => spawned, restore: () => mock.mockRestore() };
}

describe('recover() keeps the remaining workflow of a parked continuation', { timeout: 30_000 }, () => {
  let root: string;
  let dataDir: string;
  let runner: ReturnType<typeof scriptedRunner> | undefined;
  const managers: RunManager[] = [];
  const stores: RunStore[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-recover-parked-'));
    dataDir = join(root, 'data');
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const store of stores.splice(0)) store.close();
    runner?.restore();
    runner = undefined;
    rmSync(root, TEST_DIR_RM_OPTIONS);
  });

  const until = (pred: () => boolean) => expect.poll(pred, { timeout: 10_000, interval: 10 }).toBe(true);

  /** Simulate the process exit: persist what the first engine knows, then boot a second one. */
  const restart = async (first: RunStore, firstManager: RunManager) => {
    await firstManager.dispose();
    first.close();
    const store = RunStore.open(dataDir, { keepLive: true });
    stores.push(store);
    const manager = new RunManager(store, root);
    managers.push(manager);
    await manager.recover();
    return store;
  };

  const boot = () => {
    const store = RunStore.open(dataDir);
    stores.push(store);
    const manager = new RunManager(store, root);
    managers.push(manager);
    return { store, manager };
  };

  it('fails a parked continuation whose remaining workflow still needs XEZ:DONE, without running the tail', async () => {
    const marker = join(root, 'check-ran');
    const workflow: WorkflowDef = {
      name: 'gated', source: 'built-in',
      steps: [
        { id: 'author', prompt: '{{task}}' },
        { id: 'readiness', command: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, '1')"` },
      ],
    };
    // The author step ends without the marker (#317) and fails; the continued turn asks instead
    // of finishing, so the non-autonomous run parks at `waiting`.
    runner = scriptedRunner(['Pushed; waiting for CI.', 'Which branch should I use?']);
    const { store, manager } = boot();
    const record = manager.startRun(workflow, { task: 'address the review', worktree: false });
    await until(() => store.getRun(record.id)?.status === 'failed');
    expect(manager.continueRun(record.id, { text: 'finish the remaining steps' })).toEqual({ ok: true });
    await until(() => store.getRun(record.id)?.status === 'waiting');

    const after = await restart(store, manager);
    const recovered = after.getRun(record.id);
    expect(recovered?.status).toBe('failed');
    expect(recovered?.error).toBe('continue failed: remaining workflow requires XEZ:DONE from the continued turn');
    expect(recovered?.steps.find(s => s.id === 'continue-1')?.status).toBe('failed');
    expect(recovered?.steps.find(s => s.id === 'readiness')?.status).not.toBe('done');
    expect(existsSync(marker)).toBe(false);
    // Recovery starts no agent: the failed run stays Continue-able, exactly as after a live close.
    expect(runner.spawned()).toBe(2);
  });

  it('still settles a parked last step as a closed session', async () => {
    const workflow: WorkflowDef = { name: 'single', source: 'built-in', steps: [{ id: 'task', prompt: '{{task}}' }] };
    runner = scriptedRunner(['Done for now — anything else?']);
    const { store, manager } = boot();
    const record = manager.startRun(workflow, { task: 'answer a question', worktree: false });
    await until(() => store.getRun(record.id)?.status === 'waiting');

    const after = await restart(store, manager);
    expect(after.getRun(record.id)?.status).toBe('done');
    expect(after.getRun(record.id)?.steps.find(s => s.id === 'task')?.status).toBe('done');
  });
});
