import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { closeStoreAndRemove } from '../runs/store.testkit.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * A task's own extra system prompt (`StartRunInput.systemPrompt`, which automations pass) used to
 * reach the record only when the run STARTED. A task still queued when xezar restarted was rebuilt
 * from the record without it, so it ran with the project default instead.
 *
 * RED WITHOUT THE FIX: both cases.
 */
const CHECK_ONLY: WorkflowDef = {
  name: 'check-only', source: 'built-in', steps: [{ id: 'check', command: 'node -e ""' }],
};

describe('a queued task keeps its own system prompt across a restart', () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-queued-prompt-'));
    store = RunStore.open(join(root, 'data'), { keepLive: true });
  });

  afterEach(() => {
    closeStoreAndRemove(store, root);
  });

  const jobsOf = (m: RunManager) =>
    (m as unknown as { pendingJobs: Map<string, { input: { systemPrompt?: string } }> }).pendingJobs;

  it('is saved on the record when the task is created', async () => {
    const manager = new RunManager(store, root);
    const run = manager.startRun(CHECK_ONLY, { task: 'x', worktree: false, systemPrompt: 'Answer in French.' });
    // Read before the run is picked up: this is the record a restart would find.
    expect(store.getRun(run.id)?.systemPrompt).toBe('Answer in French.');
    await manager.quiesce();
    await manager.dispose();
  });

  it('is handed back to the rebuilt job by recover()', async () => {
    const run = store.createRun({ title: 't', workflow: 'check-only', task: 'x', steps: [] });
    store.updateRun(run.id, { status: 'queued', workflowDef: CHECK_ONLY, worktree: false, systemPrompt: 'Answer in French.' });
    const manager = new RunManager(store, root);
    // Hold the queue so the rebuilt job can be read before it starts.
    (manager as unknown as { pump: () => Promise<void> }).pump = async () => {};
    await manager.recover();
    expect(jobsOf(manager).get(run.id)?.input.systemPrompt).toBe('Answer in French.');
    await manager.dispose();
  });
});
