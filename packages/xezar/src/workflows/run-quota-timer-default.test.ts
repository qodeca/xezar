import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { AUTO_RESUME_GRACE_MS, RunManager } from './run.ts';

it.each(['cancel', 'dispose'] as const)('uninjected quota timer preserves Node delay, unref and %s', async action => {
  const root = mkdtempSync(join(tmpdir(), 'xez-quota-default-'));
  const store = RunStore.open(join(root, 'data'));
  const now = Date.now();
  const reset = Math.floor(now / 1000) + 3600;
  const run = store.createRun({ title: 'quota', workflow: 'one', task: 'finish',
    steps: [{ id: 'author', name: 'Author', kind: 'agent' }] });
  store.updateStep(run.id, 'author', { status: 'failed', sessionId: 'session' });
  store.updateRun(run.id, { status: 'failed', runner: 'claude', autoResumeAt: new Date(reset * 1000 + AUTO_RESUME_GRACE_MS).toISOString(), error: `Claude AI usage limit reached|${reset}` });
  // Real Node handles, no timer dependency injection and no advancing other lifecycle clocks.
  const schedule = vi.spyOn(globalThis, 'setTimeout');
  const cancel = vi.spyOn(globalThis, 'clearTimeout');
  const date = vi.spyOn(Date, 'now').mockReturnValue(now);
  const manager = new RunManager(store, root);
  let quota: NodeJS.Timeout | undefined;
  try {
    await manager.recover();
    const delay = reset * 1000 + AUTO_RESUME_GRACE_MS - now;
    expect(store.getRun(run.id)?.autoResumeAt).toBe(new Date(now + delay).toISOString());
    const index = schedule.mock.calls.findIndex(call => call[1] === delay);
    expect(index, 'quota uses the unchanged deadline minus now').toBeGreaterThanOrEqual(0);
    quota = schedule.mock.results[index]?.value as NodeJS.Timeout | undefined;
    expect(quota?.hasRef(), 'quota appointment must not keep Node alive').toBe(false);
    if (action === 'cancel') expect(manager.cancelAutoResume(run.id)).toBe(true);
    else await manager.dispose();
    expect(cancel).toHaveBeenCalledWith(quota);
  } finally {
    await manager.quiesce();
    // Cleanup also works when a named-break probe deliberately drops production cancellation.
    for (const result of schedule.mock.results) if (result.type === 'return') clearTimeout(result.value);
    date.mockRestore();
    vi.restoreAllMocks();
    store.flush();
    rmSync(root, { recursive: true, force: true });
  }
});
