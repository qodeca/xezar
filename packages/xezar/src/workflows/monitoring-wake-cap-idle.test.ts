import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import * as factory from '../core/runner-factory.ts';
import { RunStore } from '../runs/store.ts';
import { closeStoreAndRemove } from '../runs/store.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { MAX_AUTO_CONTINUES, RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * A session parked in `monitoring` has no idle timer (#661): its exit is the wake timer, which
 * re-prompts it (#810). After `MAX_AUTO_CONTINUES` wake-ups the wake timer stops too, and the
 * session used to stay open with no automatic exit at all — only a human typing could end it.
 * Reaching the cap now arms the ordinary idle timer, so the session closes on its own.
 *
 * RED WITHOUT THE FIX: the cap case (the run never leaves `monitoring`). GUARD (passes both ways):
 * before the cap a monitoring session still has no idle timer.
 */
function alwaysMonitoringRunner() {
  const mock = vi.spyOn(factory, 'createRunner').mockImplementation(() => ({
    backend: 'claude',
    run: async () => { throw new Error('unexpected one-shot runner'); },
    interrupt: async () => {},
    startSession(spec: AgentRunSpec, emit: (event: AgentEvent) => void) {
      let open = true;
      let finish!: (result: AgentRunResult) => void;
      const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
      const end = () => {
        if (!open) return;
        open = false;
        finish({ text: '', tokensUsed: 0, toolCalls: [] });
      };
      const turn = () => {
        if (!open) return;
        emit({ type: 'text', text: 'Still waiting for the build.\n\nXEZ:MONITORING' });
        emit({ type: 'turn-end' });
      };
      queueMicrotask(() => {
        emit({ type: 'session', sessionId: spec.sessionId ?? 'monitor-session' });
        turn();
      });
      return {
        result,
        get open() { return open; },
        end,
        interrupt: end,
        sendMessage: () => {
          if (!open) return false;
          setTimeout(turn, 0);
          return true;
        },
      };
    },
  }));
  return { restore: () => mock.mockRestore() };
}

const SINGLE: WorkflowDef = { name: 'single', source: 'built-in', steps: [{ id: 'task', prompt: '{{task}}' }] };

describe('a monitoring session gets an automatic exit once its wake-ups run out', { timeout: 30_000 }, () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  let runner: ReturnType<typeof alwaysMonitoringRunner>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-monitor-cap-'));
    store = RunStore.open(join(root, 'data'));
    runner = alwaysMonitoringRunner();
  });

  afterEach(async () => {
    await manager?.quiesce();
    await manager?.dispose();
    manager = undefined;
    runner.restore();
    closeStoreAndRemove(store, root);
  });

  const idleTimerOf = (id: string) =>
    (manager as unknown as { active: Map<string, { idleTimer?: unknown }> }).active.get(id)?.idleTimer;

  it('closes the session after the idle timeout once the wake cap is reached', async () => {
    // 0.001 minutes = 60 ms for both clocks, the trick `run.test.ts` uses.
    manager = new RunManager(store, root, {
      semaphore: new WorkspaceSemaphore({ initial: { monitoringWakeIntervalMinutes: 0.001, idleTimeoutMinutes: 0.001 } }),
    });
    const record = manager.startRun(SINGLE, { task: 'watch the build', worktree: false });
    await expect.poll(() => store.getRun(record.id)?.monitoringWakeCapReached, { timeout: 20_000, interval: 20 }).toBe(true);
    await expect.poll(() => store.getRun(record.id)?.status, { timeout: 5_000, interval: 20 }).toBe('done');
    const ndjson = store.readEvents(record.id).map((event) => JSON.stringify(event)).join('\n');
    expect(ndjson).toContain(`automatic monitoring wake-up (${MAX_AUTO_CONTINUES}/${MAX_AUTO_CONTINUES})`);
    expect(ndjson).toContain('of inactivity');
  });

  it('GUARD: before the cap a monitoring session has no idle timer', async () => {
    manager = new RunManager(store, root, {
      semaphore: new WorkspaceSemaphore({ initial: { idleTimeoutMinutes: 0.001 } }),
    });
    const record = manager.startRun(SINGLE, { task: 'watch the build', worktree: false });
    await expect.poll(() => store.getRun(record.id)?.activity, { timeout: 10_000, interval: 20 }).toBe('monitoring');
    expect(idleTimerOf(record.id)).toBeUndefined();
  });
});
