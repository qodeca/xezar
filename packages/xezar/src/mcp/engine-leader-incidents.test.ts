// FIRST import on purpose: the home pin is a module-load side effect and must run before anything
// that reaches `skills.ts` (#671).
import './tools/mcp-test-home.testkit.ts';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunManager, AUTO_RESUME_GRACE_MS } from '../workflows/run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { COMPLETION_VARIANTS, checkFailureWorkflow, order, providerClock, repair, scriptedRunner, SINGLE_STEP } from '../workflows/engine-incidents.testkit.ts';
import type { RunStore } from '../runs/store.ts';
import { createApp } from '../server/server.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { DELIVERY_CLIENTS, deliveryHarness } from './leader-delivery.testkit.ts';
import { withEventOrigin } from './event-catalog.ts';
import { executionControlTool } from './tools/execution-control.ts';
import { taskReadsTool } from './tools/task-reads.ts';
import type { McpTool, McpToolContext } from './tool.ts';
import type { McpJournalRow } from '@qodeca/xezar-contract';
import { StallMonitor } from './stall-monitor.ts';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
type Harness = Awaited<ReturnType<typeof deliveryHarness>>;
function rows(h: Harness): McpJournalRow[] {
  const page = h.journal.read();
  if (page.status !== 'ok') throw new Error('unexpected journal gap');
  return page.events;
}
function calls(h: Harness, manager: RunManager) {
  const service = createApp({ repoRoot: h.root, store: h.store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  const ctx = { project: { id: 'default', name: 'fixture', root: h.root }, xezarVersion: '0.0.0-test', service } as McpToolContext;
  const call = async (tool: McpTool, args: Record<string, unknown>) => {
    const result = await tool.call(tool.inputSchema.parse(args), ctx);
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  return {
    version: async (id: string) => (await call(taskReadsTool, { view: 'task', taskId: id })).version as string,
    continue: (id: string, expectedVersion: string, operationId: string) => h.guard.issue(operationId,
      () => withEventOrigin({ origin: 'leader', causedBy: operationId, runId: id }, () => call(executionControlTool, {
        action: 'continue', runId: id, expectedVersion, operationId, text: 'Repair readiness and finish the workflow.',
      }))),
  };
}
function receiptsFor(texts: string[], eventId: string) {
  // Match the rendered event line, never a transport correlation ID or a longer row ID.
  return texts.filter(text => text.includes(`- ${eventId} `));
}
it('receipt matching excludes Codex correlation IDs and longer event IDs but retains duplicates', () => {
  const correlation = 'xezar-event:matrix:3c85f1c7:1';
  const row = '- matrix:3 E-01 task.done';
  const texts = [correlation, `${correlation} - matrix:2 E-04 instruction.added`, '- matrix:30 E-01 task.done', row];
  expect(receiptsFor(texts, 'matrix:3')).toEqual([row]);
  expect(receiptsFor([...texts, row], 'matrix:3')).toEqual([row, row]);
});

async function receipt(h: Harness, row: McpJournalRow) {
  await h.settle();
  expect(receiptsFor(h.texts(), row.eventId), `peer received ${row.kind} ${row.eventId}`).toHaveLength(1);
  // Transport receipt is not leader acknowledgement.
  const status = h.delivery.status();
  expect(status.available && status.delivery?.ackedSeq).toBe(0);
}

const TERMINAL_STATUSES = new Set(['done', 'failed', 'review', 'cancelled']);

function runSettled(store: RunStore, id: string): boolean {
  return TERMINAL_STATUSES.has(String(store.getRun(id)?.status));
}

/**
 * Await the run store's OWN change signal rather than a poll budget. `RunStore` emits `run` on
 * every record mutation and `event` on every appended event, and that is where the completion
 * chain ends (`agent turn -> events -> journal -> store`) — so the chain IS awaitable, and an
 * `expect.poll` budget was only ever a guess at when it had finished. Under v8 coverage and gate
 * load that guess was the flake (#603, #630, #658): the wait is now a fact about the store, not a
 * clock. `predicate` is re-read on every signal, and a false one keeps the subscription alive.
 */
async function untilStoreChanges(store: RunStore, predicate: () => boolean): Promise<void> {
  if (predicate()) return;
  await new Promise<void>((resolve) => {
    const check = (): void => {
      if (!predicate()) return;
      store.off('run', check);
      store.off('event', check);
      resolve();
    };
    store.on('run', check);
    store.on('event', check);
  });
}

/** Wait for the run's terminal status through the store's change signal. */
async function settle(store: RunStore, id: string): Promise<void> {
  await untilStoreChanges(store, () => runSettled(store, id));
}

for (const client of DELIVERY_CLIENTS) describe(`engine incidents → ${client}`, () => {
  it.each([false, true])('G7 last-line control streamed=%s delivers one completion without a second turn', async streamed => {
    const h = await deliveryHarness(client); cleanup.push(h.close);
    const runner = scriptedRunner([streamed ? { streamed: true, chunks: ['XEZ:', 'DO', 'NE'] } : {}]); cleanup.push(runner.restore);
    const manager = new RunManager(h.store, h.root); cleanup.push(() => manager.quiesce());
    const run = manager.startRun(SINGLE_STEP, { task: 'review', worktree: false, autonomous: true });
    // The completion chain ends on the run store's own change signal; await it instead of a poll
    // budget (#603, #630, #658). A nudge, if one is sent, is recorded before the store settles
    // (#524), so waiting on the store cannot miss it.
    await settle(h.store, run.id);
    expect(runner.messages).toEqual([]);
    expect(runner.specs).toHaveLength(1);
    expect(rows(h).map(row => row.kind)).toEqual(['task.done']);
    await receipt(h, rows(h)[0]!);
  });

  // #524 regression: completion must precede the autonomous nudge at both entry points.
  it.each(COMPLETION_VARIANTS.flatMap(variant => [false, true].map(continued => ({ ...variant, continued }))))('G7 $name continued=$continued reaches leader once without nudge/block storm', async variant => {
    const h = await deliveryHarness(client); cleanup.push(h.close);
    const runner = scriptedRunner(variant.continued ? [{}, variant] : [variant]); cleanup.push(runner.restore);
    const manager = new RunManager(h.store, h.root); cleanup.push(() => manager.quiesce());
    const run = manager.startRun(SINGLE_STEP, { task: 'review', worktree: false, autonomous: true });
    if (variant.continued) {
      await settle(h.store, run.id); await h.settle();
      const tool = calls(h, manager);
      expect(await tool.continue(run.id, await tool.version(run.id), 'complete-review')).not.toHaveProperty('error');
    }
    // The completion chain (agent turn -> events -> journal -> run store) IS awaitable: it ends
    // on the run store's own change signal. Await that instead of a poll budget (#603, #630,
    // #658). The expected session count is part of the condition, so the FIRST completion of a
    // continued run (one session, already `done`) cannot satisfy it — a nudge is recorded before
    // the store settles (#524), so the assertion below cannot miss it.
    await untilStoreChanges(h.store, () => runner.specs.length === (variant.continued ? 2 : 1)
      && runSettled(h.store, run.id));
    expect(runner.messages, '#524: completion must precede nudge').toHaveLength(0);
    expect(rows(h).map(row => row.kind)).toEqual(variant.continued ? ['task.done', 'task.done'] : ['task.done']);
    expect(runner.specs).toHaveLength(variant.continued ? 2 : 1);
    await receipt(h, rows(h).at(-1)!);
  });

  it.each(['repair succeeds', 'repair fails'])('G8 %s: remaining checks settle before leader completion', async mode => {
    const h = await deliveryHarness(client); cleanup.push(h.close);
    const runner = scriptedRunner([{}, { before: mode === 'repair succeeds' ? repair
      : spec => appendFileSync(join(spec.cwd, 'order.txt'), 'repair\n') }]); cleanup.push(runner.restore);
    const manager = new RunManager(h.store, h.root); cleanup.push(() => manager.quiesce());
    const run = manager.startRun(checkFailureWorkflow(h.root), { task: 'repair', worktree: false });
    await settle(h.store, run.id);
    const failure = rows(h).find(row => row.kind === 'task.failed')!;
    expect(failure).toMatchObject({ origin: 'system', causedBy: null, category: 'E-01' });
    await receipt(h, failure);
    const tool = calls(h, manager);
    expect(await tool.continue(run.id, await tool.version(run.id), 'repair-check')).not.toHaveProperty('error');
    // The repair session is a fact the store reports: await its change signal until the second
    // agent session is up. No poll budget (#603, #630, #658).
    await untilStoreChanges(h.store, () => runner.specs.length === 2);
    expect(runner.specs).toHaveLength(2);
    await settle(h.store, run.id);
    await h.settle();
    expect(order(h.root), '#520: required check must rerun after repair').toEqual(mode === 'repair succeeds'
      ? ['readiness', 'repair', 'readiness', 'gates', 'evidence', 'handoff'] : ['readiness', 'repair', 'readiness']);
    const outcomes = rows(h).filter(row => row.kind === (mode === 'repair succeeds' ? 'task.done' : 'task.failed'));
    expect(outcomes).toHaveLength(mode === 'repair succeeds' ? 1 : 2);
    await receipt(h, outcomes.at(-1)!);
  });

  it.each(['recovery', 'repeat limit', 'cancelled schedule', 'disabled'])('G9 quota %s reaches leader without rejected-operation poisoning', async mode => {
    const h = await deliveryHarness(client); cleanup.push(h.close);
    const clock = providerClock(); cleanup.push(clock.restore);
    const reset = clock.reset();
    const runner = scriptedRunner([{ error: `Claude AI usage limit reached|${reset}` },
      mode === 'repeat limit' ? { error: `Claude AI usage limit reached|${clock.reset(180)}` } : {}]); cleanup.push(runner.restore);
    const manager = new RunManager(h.store, h.root, { autoResumeTimer: clock.timer, semaphore: new WorkspaceSemaphore({ initial: { autoResumeOnUsageLimit: mode !== 'disabled' } }) }); cleanup.push(() => manager.quiesce());
    const run = manager.startRun(SINGLE_STEP, { task: 'quota', worktree: false });
    await settle(h.store, run.id);
    expect(h.store.getRun(run.id)?.status).toBe('failed');
    expect(h.store.getRun(run.id)?.autoResumeAt).toBe(mode === 'disabled' ? undefined : new Date(reset * 1000 + AUTO_RESUME_GRACE_MS).toISOString());
    const failed = rows(h).find(row => row.kind === 'task.failed')!;
    expect(failed).toMatchObject({ origin: 'system', causedBy: null });
    await receipt(h, failed);
    const tool = calls(h, manager);
    const stale = await tool.version(run.id);
    h.store.setPinned(run.id, true);
    expect(await tool.continue(run.id, stale, 'rejected-quota-op')).toMatchObject({ error: 'stale_version', applied: false });
    if (mode === 'cancelled schedule') expect(manager.cancelAutoResume(run.id)).toBe(true);
    clock.advanceTo(reset * 1000 + AUTO_RESUME_GRACE_MS);
    if (mode === 'cancelled schedule' || mode === 'disabled') {
      expect(runner.specs).toHaveLength(1);
      expect(h.store.getRun(run.id)?.autoResumeAt).toBeUndefined();
      expect(rows(h).map(row => row.kind)).toEqual(['task.failed']);
      await receipt(h, failed);
      return;
    }
    // The auto-resume session is a fact the store reports: await its change signal until the
    // second agent session is up. No poll budget (#603, #630, #658).
    await untilStoreChanges(h.store, () => runner.specs.length === 2);
    expect(runner.specs).toHaveLength(2);
    await settle(h.store, run.id);
    expect(h.store.getRun(run.id)?.status).toBe(mode === 'repeat limit' ? 'failed' : 'done');
    if (mode === 'repeat limit') expect(h.store.getRun(run.id)?.autoResumeAt).toBe(new Date((reset + 120) * 1000 + AUTO_RESUME_GRACE_MS).toISOString());
    const events = rows(h);
    expect(events.map(row => row.kind)).toEqual(['task.failed', 'instruction.added', mode === 'repeat limit' ? 'task.failed' : 'task.done']);
    // E-04 currently derives from the user-message door (D-05), not the provider reset clock.
    expect(events[1]).toMatchObject({ origin: 'human', causedBy: null });
    expect(events[2]).toMatchObject({ origin: 'system', causedBy: null });
    for (const row of events.slice(1)) await receipt(h, row);
    expect(runner.specs).toHaveLength(2);
  });

  it('G9 advisory resume requires an observed silence episode, independent of quota', async () => {
    const h = await deliveryHarness(client); cleanup.push(h.close);
    let now = Date.now(); let tick = () => {};
    const monitor = StallMonitor.attach({ store: h.store, report: h.catalog, now: () => now,
      schedule: fn => { tick = fn; return { cancel() {} }; } }); cleanup.push(() => monitor.detach());
    const run = h.store.createRun({ title: 'quiet', task: 'quiet', workflow: 'fixture', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    h.store.updateRun(run.id, { status: 'running' });
    h.store.updateStep(run.id, 'work', { status: 'running', startedAt: new Date(now).toISOString() });
    tick(); now += 1000;
    h.store.appendEvent(run.id, { type: 'text', stepId: 'work', text: 'working' }); tick();
    expect(rows(h)).toEqual([]);
    now += 300_001; tick(); tick();
    expect(rows(h).map(row => row.kind)).toEqual(['task.stalled']);
    await receipt(h, rows(h)[0]!);
    h.store.appendEvent(run.id, { type: 'text', stepId: 'work', text: 'activity returned' }); tick(); tick();
    expect(rows(h).map(row => row.kind)).toEqual(['task.stalled', 'task.resumed']);
    expect(rows(h).map(row => [row.origin, row.causedBy])).toEqual([['system', null], ['system', null]]);
    expect(h.store.getRun(run.id)?.status).toBe('running');
    await receipt(h, rows(h)[1]!);
  });
});
