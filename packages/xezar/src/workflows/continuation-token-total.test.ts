import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, SessionOptions } from '../core/agent-runner.ts';
import type { RunnerId } from '../core/agent-runner.ts';
import * as factory from '../core/runner-factory.ts';
import { RunStore } from '../runs/store.ts';
import { closeStoreAndRemove } from '../runs/store.testkit.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * A Continue that resumes a Codex thread records only what its own turn spent. Codex reports the
 * THREAD's cumulative total (`BACKENDS_WITH_CUMULATIVE_TOKENS`), and the run total sums its steps,
 * so storing the raw figure on the `continue-N` step billed every earlier turn on that thread twice.
 * The first spawn already subtracts that baseline (`stepTokenTotal`); the continuation did not.
 *
 * RED WITHOUT THE FIX: the Codex case. GUARD (passes both ways): a per-session backend (Claude)
 * keeps recording its own figure as reported.
 */
interface Turn { text: string; tokensUsed: number }

function scriptedRunner(backend: RunnerId, turns: Turn[]) {
  let spawned = 0;
  const mock = vi.spyOn(factory, 'createRunner').mockImplementation(() => ({
    backend,
    run: async () => { throw new Error('unexpected one-shot runner'); },
    interrupt: async () => {},
    startSession(spec: AgentRunSpec, emit: (event: AgentEvent) => void, options?: SessionOptions) {
      const turn = turns[spawned++];
      if (!turn) throw new Error('unscripted agent invocation');
      let open = true;
      let finish!: (result: AgentRunResult) => void;
      const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
      const end = () => {
        if (!open) return;
        open = false;
        finish({ text: '', tokensUsed: turn.tokensUsed, toolCalls: [] });
      };
      queueMicrotask(() => {
        emit({ type: 'session', sessionId: spec.sessionId ?? 'thread-1' });
        emit({ type: 'token-usage', tokensUsed: turn.tokensUsed });
        emit({ type: 'text', text: turn.text });
        emit({ type: 'turn-end' });
        if (options?.autoEndAfterFirstTurn) end();
      });
      return { result, get open() { return open; }, end, interrupt: end, sendMessage: () => false };
    },
  }));
  return { restore: () => mock.mockRestore() };
}

const GATED: WorkflowDef = {
  name: 'gated', source: 'built-in',
  steps: [{ id: 'author', prompt: '{{task}}' }, { id: 'readiness', command: 'node -e ""' }],
};

describe('a resumed continuation records its own tokens', { timeout: 30_000 }, () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let runner: ReturnType<typeof scriptedRunner> | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-continue-tokens-'));
    store = RunStore.open(join(root, 'data'));
    manager = new RunManager(store, root);
  });

  afterEach(async () => {
    await manager.quiesce();
    await manager.dispose();
    runner?.restore();
    runner = undefined;
    closeStoreAndRemove(store, root);
  });

  const until = (pred: () => boolean) => expect.poll(pred, { timeout: 10_000, interval: 10 }).toBe(true);

  /** The author step spends `first` and fails without the marker; the Continue reports `second`. */
  const continueOnce = async (backend: RunnerId, first: number, second: number) => {
    runner = scriptedRunner(backend, [
      { text: 'Pushed; waiting for CI.', tokensUsed: first },
      { text: 'All finished.\nXEZ:DONE', tokensUsed: second },
    ]);
    const record = manager.startRun(GATED, { task: 'address the review', runner: backend, worktree: false });
    await until(() => store.getRun(record.id)?.status === 'failed');
    expect(manager.continueRun(record.id, { text: 'finish the remaining steps' })).toEqual({ ok: true });
    await until(() => store.getRun(record.id)?.status === 'done');
    const run = store.getRun(record.id);
    // The Continue resumed the author's own session, the case the baseline is for.
    expect(run?.steps.find(s => s.id === 'continue-1')?.sessionId).toBe(run?.steps.find(s => s.id === 'author')?.sessionId);
    return run;
  };

  it('subtracts what the Codex thread had already spent', async () => {
    // The thread spent 1 000 in the author step; the continued turn adds 500 and reports 1 500.
    const run = await continueOnce('codex', 1_000, 1_500);
    expect(run?.steps.find(s => s.id === 'author')?.tokensUsed).toBe(1_000);
    expect(run?.steps.find(s => s.id === 'continue-1')?.tokensUsed).toBe(500);
    expect(run?.tokensUsed).toBe(1_500);
  });

  it('keeps a per-session backend’s figure as reported', async () => {
    const run = await continueOnce('claude', 1_000, 500);
    expect(run?.steps.find(s => s.id === 'continue-1')?.tokensUsed).toBe(500);
    expect(run?.tokensUsed).toBe(1_500);
  });
});
