import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpJournalRow } from '@qodeca/xezar-contract';
import { RunStore } from '../runs/store.ts';
import { createApp } from '../server/server.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import type { RunManager } from '../workflows/run.ts';
import { EventCatalog, withEventOrigin, expectEventTransition } from './event-catalog.ts';
import { EventJournal } from './event-journal.ts';
import { EchoGuard, attachLeaderFeed } from './echo-guard.ts';
import { LeaderDelivery } from './leader-delivery.ts';
import { runDecisionProjection, runVersion, guardedRunMutation } from './stale-write.ts';
import { executionControlTool } from './tools/execution-control.ts';
import { taskReadsTool } from './tools/task-reads.ts';
import { DELIVERY_CLIENTS, deliveryHarness } from './leader-delivery.testkit.ts';
import { organiseWorkTool } from './tools/work-organisation.ts';
import type { McpTool, McpToolContext } from './tool.ts';

// Regressions reproduced on 248ea8a; agent processes and transport are recording seams.
// Real tool -> real HTTP routes -> real RunStore; only agent delivery is a recording seam.
let root: string;
let store: RunStore;
let journal: EventJournal;
let catalog: EventCatalog;
let guard: EchoGuard;
let ctx: McpToolContext;
let sent: ReturnType<typeof vi.fn>;
let cancelled: ReturnType<typeof vi.fn>;
let delivered: McpJournalRow[];
let unsubscribe: () => void;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'leader-investigation-'));
  store = RunStore.open(join(root, '.local/xezar'));
  journal = EventJournal.open({ dataDir: store.dataDir, projectId: 'xezar', secretValues: [] });
  catalog = EventCatalog.attach({ journal, store, workspaceEvents: { on: () => () => {} } });
  guard = new EchoGuard({ projectId: 'xezar' });
  delivered = [];
  unsubscribe = attachLeaderFeed({ journal, guard, deliver: row => delivered.push(row) });
  sent = vi.fn(() => true);
  cancelled = vi.fn(() => true);
  const manager = { isActive: () => true, sendMessage: sent, cancel: cancelled } as unknown as RunManager;
  const app = createApp({ repoRoot: root, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  ctx = { project: { id: 'default', name: 'default', root }, xezarVersion: '0.0.0-test', service: app } as McpToolContext;
});

afterEach(() => {
  unsubscribe();
  // Delete fixtures while attached, clearing any unconsumed run intent as production deletion does.
  for (const run of store.listRuns()) store.deleteRun(run.id);
  catalog.detach();
  journal.close();
  store.flush();
  rmSync(root, { recursive: true, force: true });
});

function running() {
  const run = store.createRun({ title: 'investigate', task: 'investigate', workflow: 'quick-task', steps: [
    { id: 'agent', name: 'Agent', kind: 'agent' }, { id: 'check', name: 'Check', kind: 'check' },
  ] });
  store.updateRun(run.id, { status: 'running' });
  store.updateStep(run.id, 'agent', { status: 'running', sessionId: 'fixture-session' });
  return run;
}

async function call(tool: McpTool, args: Record<string, unknown>) {
  const result = await tool.call(tool.inputSchema.parse(args), ctx);
  return JSON.parse((result.content[0] as { text: string }).text);
}

async function version(runId: string): Promise<string> {
  return (await call(taskReadsTool, { view: 'task', taskId: runId })).version;
}

// The composition in mcp/index.ts: ownership is recorded and origin entered BEFORE dispatch.
function message(runId: string, expectedVersion: string, operationId: string) {
  return guard.issue(operationId, () => withEventOrigin({ origin: 'leader', causedBy: operationId, runId },
    () => call(executionControlTool, { action: 'send_message', runId, expectedVersion, operationId, text: 'Please check the evidence.' })));
}

describe('leader delivery incidents (#449, #530)', () => {
  it('A: delivers steering after transcript-only progress between task_read and send_message', async () => {
    // Named break: highestEventSeq is part of the CAS token even when the decision projection is unchanged.
    const run = running();
    const expectedVersion = await version(run.id);
    const projection = runDecisionProjection(run);
    store.appendEvent(run.id, { type: 'tool-result', text: 'read complete' });
    expect(runDecisionProjection(run)).toEqual(projection);
    const result = await message(run.id, expectedVersion, 'investigation-race');
    expect(result).toMatchObject({ accepted: true, delivery: 'live' });
    expect(sent).toHaveBeenCalledOnce();
  });

  it.each(['done', 'failed', 'review', 'waiting'] as const)(
    'B: rejected send_message cannot own or suppress the later %s outcome', async status => {
      // Named break: pendingIntents survives a refused operation until the next status transition.
      const run = running();
      // Use a real decision change so this rejection remains valid after defect A is fixed.
      const expectedVersion = await version(run.id);
      store.setPinned(run.id, true);
      expect(await message(run.id, expectedVersion, `investigation-rejected-${status}`)).toMatchObject({ error: 'stale_version', applied: false });
      expect(sent).not.toHaveBeenCalled();
      store.updateStep(run.id, 'check', { status: 'done' });
      expect(delivered.at(-1)).toMatchObject({ kind: 'gate.passed', origin: 'system', causedBy: null });
      if (status === 'waiting') store.appendEvent(run.id, { type: 'ask.requested', questions: [{ header: 'Choice', question: 'Proceed?' }] });
      store.updateRun(run.id, { status });
      const page = journal.read();
      if (page.status !== 'ok') throw new Error('unexpected journal gap');
      const outcome = page.events.at(-1)!;
      expect.soft(outcome).toMatchObject({ origin: 'system', causedBy: null });
      expect.soft(delivered.map(row => row.eventId)).toContain(outcome.eventId);
      await expectPush(outcome, page.nextCursor);
    },
  );
});

async function expectPush(outcome: McpJournalRow, nextCursor: string) {
  // Exercise the actual attached-Claude push filter as well as EchoGuard's admission rule.
  // Attach after the rows exist, so the controller's initial floor is at the journal head.
  const push = vi.fn(async () => {});
  const delivery = new LeaderDelivery({ projectId: 'xezar', projectRoot: root, journal, guard,
    ownership: { projectId: 'xezar', sessionToken: () => 'fixture-token', state: () => 'owned' },
    warn: () => {}, heartbeatMs: 60_000 });
  try {
    delivery.sessionOpened('owner', { push, clientName: 'claude-code', leaderPush: true, channelAdvertised: true });
    expect(await delivery.act({ action: 'attach', client: 'claude-code' })).toMatchObject({ ok: true });
    const receipt = await delivery.deliver({ projectId: 'xezar', events: [outcome], nextCursor }, new AbortController().signal);
    expect.soft(receipt).toMatchObject({ handedThrough: outcome.journalSeq });
    expect(push).toHaveBeenCalledOnce();
  } finally {
    delivery.close();
  }
}

function lastOutcome() {
  const page = journal.read();
  if (page.status !== 'ok') throw new Error('unexpected journal gap');
  return { outcome: page.events.at(-1)!, cursor: page.nextCursor };
}

it('A→B→A still conflicts and survives reopening without a flush', () => {
  // Named break: omit the revision increment/persistence in RunStore.trackDecision/touch.
  const run = running();
  const token = runVersion(store, run.id);
  const title = run.title;
  store.updateRun(run.id, { title: 'temporary' });
  store.updateRun(run.id, { title });
  const recovered = RunStore.open(store.dataDir, { keepLive: true });
  expect(runVersion(recovered, run.id)).toBe(runVersion(store, run.id));
  expect(runVersion(recovered, run.id)).not.toBe(token);
  expect(guardedRunMutation(recovered, run.id, token, () => undefined).status).toBe('conflict');
  recovered.flush();
});

it('initializes legacy records and persists subsequent decisions automatically', () => {
  // Named break: discard the persisted decisionRevision when reopening the upgraded legacy record.
  const run = running();
  store.flush();
  const path = join(store.dataDir, 'runs.json');
  const records = JSON.parse(readFileSync(path, 'utf8'));
  for (const record of records) delete record.decisionRevision;
  writeFileSync(path, JSON.stringify(records));
  const recovered = RunStore.open(store.dataDir, { keepLive: true });
  const token = runVersion(recovered, run.id);
  const title = recovered.getRun(run.id)!.title;
  const revision = recovered.getRun(run.id)!.decisionRevision!;
  recovered.updateRun(run.id, { title: 'B' });
  expect(recovered.getRun(run.id)!.decisionRevision).toBe(revision + 1);
  recovered.updateRun(run.id, { title });
  expect(runVersion(recovered, run.id)).not.toBe(token);
  const reopened = RunStore.open(store.dataDir, { keepLive: true });
  expect(runVersion(reopened, run.id)).toBe(runVersion(recovered, run.id));
  recovered.flush();
  reopened.flush();
});

it('rejected cancel loses ownership and cannot hide a subsequent done', async () => {
  // Named break: pre-dispatch pending intent survives rejection / EchoGuard never forgets the id.
  const run = running();
  const expectedVersion = await version(run.id);
  store.setPinned(run.id, true);
  const operationId = 'rejected-cancel';
  const result = await guard.issue(operationId, () => withEventOrigin({ origin: 'leader', causedBy: operationId, runId: run.id },
    () => call(executionControlTool, { action: 'cancel', runId: run.id, expectedVersion, operationId })));
  expect(result).toMatchObject({ applied: false });
  expect(cancelled).not.toHaveBeenCalled();
  expect(guard.isOwn(operationId)).toBe(false);
  store.updateRun(run.id, { status: 'done' });
  const { outcome, cursor } = lastOutcome();
  expect(outcome).toMatchObject({ origin: 'system', causedBy: null });
  await expectPush(outcome, cursor);
});

it('successful running steering leaves the later completion actionable', async () => {
  // Named break: restore unconditional pendingIntents registration in withEventOrigin.
  const run = running();
  expect(await message(run.id, await version(run.id), 'accepted-steering')).toMatchObject({ accepted: true });
  store.updateRun(run.id, { status: 'done' });
  const { outcome, cursor } = lastOutcome();
  expect(outcome).toMatchObject({ origin: 'system', causedBy: null });
  await expectPush(outcome, cursor);
});

it('waiting→running answer_question leaves the later done system-originated', async () => {
  // Named break: allow AsyncLocalStorage origin to remain live after settlement.
  const run = running();
  store.appendEvent(run.id, { type: 'ask.requested', requestId: 'question-1', questions: [{ header: 'Choice', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }] });
  store.updateRun(run.id, { status: 'waiting' });
  let finish!: () => void;
  sent.mockImplementation(() => {
    store.updateRun(run.id, { status: 'running' });
    void new Promise<void>(resolve => { finish = resolve; }).then(() => store.updateRun(run.id, { status: 'done' }));
    return true;
  });
  const operationId = 'answer-waiting';
  const expectedVersion = await version(run.id);
  const result = await guard.issue(operationId, () => withEventOrigin({ origin: 'leader', causedBy: operationId, runId: run.id },
    () => call(executionControlTool, { action: 'answer_question', runId: run.id, expectedVersion, operationId, questionId: 'question-1', text: 'Proceed' })));
  expect(result).toMatchObject({ accepted: true });
  finish();
  await Promise.resolve();
  const { outcome, cursor } = lastOutcome();
  expect(outcome).toMatchObject({ kind: 'task.done', origin: 'system', causedBy: null });
  await expectPush(outcome, cursor);
});

it('accepted delayed cancellation attributes only its cancelled transition', async () => {
  // Named break: remove expectEventTransition from the accepted cancel route.
  const run = running();
  const operationId = 'accepted-cancel';
  const expectedVersion = await version(run.id);
  expect(await guard.issue(operationId, () => withEventOrigin({ origin: 'leader', causedBy: operationId, runId: run.id },
    () => call(executionControlTool, { action: 'cancel', runId: run.id, expectedVersion, operationId })))).toMatchObject({ accepted: true });
  store.updateRun(run.id, { status: 'cancelled' });
  expect(lastOutcome().outcome).toMatchObject({ origin: 'leader', causedBy: operationId });
  expect(delivered.map(row => row.eventId)).not.toContain(lastOutcome().outcome.eventId);
});

it('an accepted cancellation never claims an unrelated transition', () => {
  // Named break: ignore the expected status when consuming a pending intent.
  const run = running();
  withEventOrigin({ origin: 'leader', causedBy: 'cancel-specific', runId: run.id }, () => expectEventTransition(run.id, 'cancelled'));
  store.updateRun(run.id, { status: 'done' });
  expect(lastOutcome().outcome).toMatchObject({ origin: 'system', causedBy: null });
});

it('rejection clears its own pending effect but preserves a newer operation', async () => {
  // Named breaks: remove rejection cleanup, or delete without checking the owning context.
  const run = running();
  let reject!: (value: { applied: false }) => void;
  const first = withEventOrigin({ origin: 'leader', causedBy: 'first-operation', runId: run.id }, () => {
    expectEventTransition(run.id, 'cancelled');
    return new Promise<{ applied: false }>(resolve => { reject = resolve; });
  });
  withEventOrigin({ origin: 'leader', causedBy: 'newer-operation', runId: run.id }, () => expectEventTransition(run.id, 'cancelled'));
  reject({ applied: false });
  await first;
  store.updateRun(run.id, { status: 'cancelled' });
  expect(lastOutcome().outcome).toMatchObject({ causedBy: 'newer-operation' });
  const another = running();
  withEventOrigin({ origin: 'leader', causedBy: 'rejected', runId: another.id }, () => {
    expectEventTransition(another.id, 'cancelled');
    return { applied: false };
  });
  store.updateRun(another.id, { status: 'cancelled' });
  expect(lastOutcome().outcome).toMatchObject({ origin: 'human', causedBy: null });
});

it('pre-dispatch ownership suppresses a synchronous acknowledgement, then forgets a known rejection', async () => {
  // Named break: register EchoGuard ownership only after dispatch / omit result unwrapping.
  const run = running();
  await guard.issue('sync-ack', () => withEventOrigin({ origin: 'leader', causedBy: 'sync-ack', runId: run.id }, () => {
    store.updateRun(run.id, { status: 'cancelled' });
    expect(delivered.map(row => row.eventId)).not.toContain(lastOutcome().outcome.eventId);
    return { content: [{ type: 'text', text: JSON.stringify({ applied: false }) }] };
  }));
  expect(guard.isOwn('sync-ack')).toBe(false);
});

const outcomes = ['done', 'failed', 'cancelled', 'review', 'blocked', 'ask-before-wait', 'ask-after-wait'] as const;
type MatrixHarness = Awaited<ReturnType<typeof deliveryHarness>>;
function outcomeAfter(h: MatrixHarness, runId: string, outcome: typeof outcomes[number]) {
  h.store.updateRun(runId, { status: 'running' });
  const ask = () => h.store.appendEvent(runId, { type: 'ask.requested', requestId: 'later-question', questions: [{ question: 'Next decision?' }] });
  if (outcome === 'ask-before-wait') ask();
  h.store.updateRun(runId, { status: ['blocked', 'ask-before-wait', 'ask-after-wait'].includes(outcome) ? 'waiting' : outcome as 'done' | 'failed' | 'cancelled' | 'review' });
  if (outcome === 'ask-after-wait') ask();
  const page = h.journal.read();
  if (page.status !== 'ok') throw new Error('unexpected gap');
  const row = page.events.at(-1);
  if (!row) throw new Error('missing outcome');
  return row;
}

// #532 G2 extends #531 through the real controller and all four receiving peers.
// Named breaks: unconditional pendingIntents.set; retained explicit-refusal ownership;
// consume without expected status; leaked settled async origin; erase newer intent on old refusal.
for (const client of DELIVERY_CLIENTS) describe(`#532 causal matrix / ${client}`, () => {
  const rejected = ['send_message', 'cancel', 'continue', 'answer_question', 'pin', 'set_title', 'edit_brief'] as const;
  for (const action of rejected) {
    it.each(outcomes)(`rejected ${action} then %s remains actionable`, async outcome => {
      const h = await deliveryHarness(client);
      try {
        const run = h.store.createRun({ title: 'before', task: 'before', workflow: 'fixture', steps: [{ id: 'agent', name: 'Agent', kind: 'agent' }] });
        h.store.updateStep(run.id, 'agent', { status: 'running', sessionId: 'session' });
        h.store.updateRun(run.id, { status: action === 'continue' ? 'done' : action === 'edit_brief' ? 'queued' : action === 'answer_question' ? 'waiting' : 'running' });
        if (action === 'answer_question') h.store.appendEvent(run.id, { type: 'ask.requested', requestId: 'original', questions: [{ header: 'Choice', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }] });
        const effects = vi.fn(() => true);
        const manager = { isActive: () => true, sendMessage: effects, cancel: effects, continueRun: effects, editTask: effects } as unknown as RunManager;
        const app = createApp({ repoRoot: h.root, store: h.store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
        const context = { project: { id: 'default', name: 'fixture', root: h.root }, xezarVersion: '0.0.0-test', service: app } as McpToolContext;
        const read = await taskReadsTool.call(taskReadsTool.inputSchema.parse({ view: 'task', taskId: run.id }), context);
        const token = JSON.parse((read.content[0] as { text: string }).text).version;
        h.store.setPinned(run.id, true);
        const tool = ['pin', 'set_title', 'edit_brief'].includes(action) ? organiseWorkTool : executionControlTool;
        const args = { action, runId: run.id, expectedVersion: token, operationId: `rejected-${action}`, ...(['send_message', 'continue', 'answer_question'].includes(action) ? { text: 'Yes' } : {}), ...(action === 'answer_question' ? { questionId: 'original' } : {}), ...(action === 'set_title' ? { title: 'new' } : {}), ...(action === 'edit_brief' ? { task: 'new' } : {}) };
        const result = await h.guard.issue(args.operationId, () => withEventOrigin({ origin: 'leader', causedBy: args.operationId, runId: run.id }, () => tool.call(tool.inputSchema.parse(args), context)));
        expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ applied: false, error: 'stale_version' });
        expect(effects).not.toHaveBeenCalled();
        expect(h.guard.isOwn(args.operationId)).toBe(false);
        const row = outcomeAfter(h, run.id, outcome);
        expect(row).toMatchObject({ origin: outcome === 'cancelled' ? 'human' : 'system', causedBy: null });
        await h.settle();
        expect(h.texts().join('\n')).toContain(row.eventId);
      } finally { await h.close(); }
    });
  }

  for (const action of ['send_message', 'answer_question'] as const) {
    it.each(outcomes)(`accepted ${action} then unrelated %s remains actionable after async settlement`, async outcome => {
      const h = await deliveryHarness(client);
      try {
        const run = h.store.createRun({ title: 'accepted', task: 'accepted', workflow: 'fixture', steps: [{ id: 'agent', name: 'Agent', kind: 'agent' }] });
        h.store.updateStep(run.id, 'agent', { status: 'running', sessionId: 'session' });
        h.store.updateRun(run.id, { status: action === 'answer_question' ? 'waiting' : 'running' });
        if (action === 'answer_question') h.store.appendEvent(run.id, { type: 'ask.requested', requestId: 'original', questions: [{ header: 'Choice', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }] });
        let finish: () => void = () => { throw new Error('effect never ran'); };
        let row: McpJournalRow | undefined;
        const effect = vi.fn(() => {
          h.store.updateRun(run.id, { status: 'running' });
          void new Promise<void>(resolve => { finish = resolve; }).then(() => { row = outcomeAfter(h, run.id, outcome); });
          return true;
        });
        const manager = { isActive: () => true, sendMessage: effect } as unknown as RunManager;
        const app = createApp({ repoRoot: h.root, store: h.store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
        const context = { project: { id: 'default', name: 'fixture', root: h.root }, xezarVersion: '0.0.0-test', service: app } as McpToolContext;
        const args = { action, runId: run.id, expectedVersion: runVersion(h.store, run.id), operationId: `accepted-${action}`, text: 'Yes', ...(action === 'answer_question' ? { questionId: 'original' } : {}) };
        const result = await h.guard.issue(args.operationId, () => withEventOrigin({ origin: 'leader', causedBy: args.operationId, runId: run.id }, () => executionControlTool.call(executionControlTool.inputSchema.parse(args), context)));
        expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ accepted: true });
        expect(effect).toHaveBeenCalledOnce();
        finish(); await Promise.resolve();
        expect(row).toMatchObject({ origin: outcome === 'cancelled' ? 'human' : 'system', causedBy: null });
        await h.settle();
        expect(h.texts().join('\n')).toContain(row?.eventId);
      } finally { await h.close(); }
    });
  }
});

// #532 G3: question identity/content is decision input even when status remains waiting.
// Existing implementation increments only for user-message and the record projection, so a
// replacement ask currently leaves the old token valid. Keep the engine unchanged in this slice.
it.fails.each(['new-id', 'same-id-new-content'] as const)('question replacement %s must invalidate an already-waiting decision', replacement => {
  const run = running();
  store.appendEvent(run.id, { type: 'ask.requested', requestId: 'original', questions: [{ question: 'First?' }] });
  store.updateRun(run.id, { status: 'waiting' });
  const token = runVersion(store, run.id);
  store.appendEvent(run.id, { type: 'ask.requested', requestId: replacement === 'new-id' ? 'replacement' : 'original', questions: [{ question: 'Different decision?' }] });
  expect(runVersion(store, run.id)).not.toBe(token);
});

for (const client of DELIVERY_CLIENTS) describe(`#532 delayed intent arbitration / ${client}`, () => {
  it('own accepted cancelled acknowledgement stays suppressed but an unrelated failed outcome is delivered', async () => {
    const h = await deliveryHarness(client);
    try {
      const run = h.store.createRun({ title: 'cancel', task: 'cancel', workflow: 'fixture', steps: [] });
      h.store.updateRun(run.id, { status: 'running' });
      await h.guard.issue('accepted-cancel-matrix', () => withEventOrigin({ origin: 'leader', causedBy: 'accepted-cancel-matrix', runId: run.id }, () => expectEventTransition(run.id, 'cancelled')));
      const dispatch = vi.spyOn(h.delivery, 'deliver');
      h.store.updateRun(run.id, { status: 'cancelled' });
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce()); await dispatch.mock.results[0]?.value;
      expect(h.texts()).toEqual([]);
      const page = h.journal.read();
      if (page.status !== 'ok') throw new Error('gap');
      expect(page.events.at(-1)).toMatchObject({ kind: 'task.cancelled', origin: 'leader', causedBy: 'accepted-cancel-matrix' });
      const next = h.store.createRun({ title: 'not cancelled', task: 'outcome', workflow: 'fixture', steps: [] });
      h.store.updateRun(next.id, { status: 'running' });
      await h.guard.issue('unrelated-cancel-matrix', () => withEventOrigin({ origin: 'leader', causedBy: 'unrelated-cancel-matrix', runId: next.id }, () => expectEventTransition(next.id, 'cancelled')));
      h.store.updateRun(next.id, { status: 'failed' });
      await h.settle();
      expect(h.texts()).toHaveLength(1);
      expect(h.texts()[0]).toContain('task.failed');
      expect(h.texts()[0]).toContain('system');
    } finally { await h.close(); }
  });

  it('an older explicit rejection cannot erase a newer foreign leader intent', async () => {
    const h = await deliveryHarness(client);
    try {
      const run = h.store.createRun({ title: 'race', task: 'race', workflow: 'fixture', steps: [] });
      h.store.updateRun(run.id, { status: 'running' });
      let settle: (result: { applied: false }) => void = () => { throw new Error('not started'); };
      const old = h.guard.issue('older-operation', () => withEventOrigin({ origin: 'leader', causedBy: 'older-operation', runId: run.id }, () => {
        expectEventTransition(run.id, 'cancelled'); return new Promise<{ applied: false }>(resolve => { settle = resolve; });
      }));
      withEventOrigin({ origin: 'leader', causedBy: 'foreign-operation', runId: run.id }, () => expectEventTransition(run.id, 'cancelled'));
      settle({ applied: false }); await old;
      h.store.updateRun(run.id, { status: 'cancelled' });
      const page = h.journal.read();
      if (page.status !== 'ok') throw new Error('gap');
      expect(page.events.at(-1)).toMatchObject({ causedBy: 'foreign-operation', origin: 'leader' });
      await h.settle();
      expect(h.texts()).toHaveLength(1);
      expect(h.texts()[0]).toContain('task.cancelled');
    } finally { await h.close(); }
  });
});
