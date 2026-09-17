import { MCP_EVENT_KIND_CATEGORY, type McpEventKind, type McpJournalRow } from '@qodeca/xezar-contract';
import { describe, expect, it, vi } from 'vitest';
import { DELIVERY_CLIENTS, deliveryHarness } from './leader-delivery.testkit.ts';
import { withEventOrigin } from './event-catalog.ts';

type Harness = Awaited<ReturnType<typeof deliveryHarness>>;
const variants = [
  ...Object.keys(MCP_EVENT_KIND_CATEGORY), 'question.after-wait', 'gate.stage', 'gate.legacy', 'gate.routine-failure',
] as const;

function produce(h: Harness, variant: string) {
  const run = h.store.createRun({ title: 'matrix task', task: 'verify delivery', workflow: 'fixture',
    steps: [{ id: 'check', name: 'Check', kind: 'check' }] });
  h.store.updateRun(run.id, { status: 'running' });
  h.store.updateStep(run.id, 'check', { status: 'running' });
  const ask = () => h.store.appendEvent(run.id, { type: 'ask.requested', requestId: 'question', questions: [{ question: 'Proceed?' }] });
  const queued = (text: string) => h.store.updateRun(run.id, { queuedMessages: [{ id: 'message', text, createdAt: '2026-09-01T00:00:00.000Z' }] });
  let kind = variant as McpEventKind;
  switch (variant) {
    case 'task.done': h.store.updateRun(run.id, { status: 'done' }); break;
    case 'task.failed': h.store.updateRun(run.id, { status: 'failed' }); break;
    case 'task.cancelled': h.store.updateRun(run.id, { status: 'cancelled' }); break;
    case 'task.blocked': h.store.updateRun(run.id, { status: 'waiting' }); break;
    case 'task.stalled': h.catalog.taskStalled({ runId: run.id, stepId: 'check', reason: 'silence', since: '2026-09-01T00:00:00.000Z' }); break;
    case 'task.resumed': h.catalog.taskStalled({ runId: run.id, stepId: 'check', reason: 'silence', since: '2026-09-01T00:00:00.000Z' }); h.catalog.taskResumed({ runId: run.id, stepId: 'check' }); break;
    case 'question.asked': ask(); h.store.updateRun(run.id, { status: 'waiting' }); break;
    case 'question.after-wait': kind = 'question.asked'; h.store.updateRun(run.id, { status: 'waiting' }); ask(); break;
    case 'question.answered': ask(); h.store.updateRun(run.id, { status: 'waiting' }); h.store.appendEvent(run.id, { type: 'user-message', text: 'Yes' }); h.store.updateRun(run.id, { status: 'running' }); break;
    case 'gate.passed': case 'gate.stage': case 'gate.legacy': case 'gate.failed': case 'gate.routine-failure': {
      const failed = variant === 'gate.failed' || variant === 'gate.routine-failure';
      kind = failed ? 'gate.failed' : 'gate.passed';
      if (variant !== 'gate.passed' && variant !== 'gate.failed') h.store.updateRun(run.id, { workflowDef: { name: 'fixture', source: 'file', steps: [{ id: 'check', command: 'true', ...(variant === 'gate.legacy' ? {} : { resultScope: variant === 'gate.routine-failure' ? 'routine' : 'stage' }) }] } });
      h.store.updateStep(run.id, 'check', { status: failed ? 'failed' : 'done' }); break;
    }
    case 'result.ready': h.store.updateRun(run.id, { status: 'review' }); break;
    case 'verdict.posted': h.store.updateRun(run.id, { verdicts: [{ id: 'report', taskId: run.id, stepId: 'check', role: 'code-review', verdict: 'REQUEST CHANGES', reviewedHeadSha: 'a'.repeat(40), summary: 'findings', recordedAt: '2026-09-01T00:00:00.000Z', ingestedAt: '2026-09-01T00:00:00.000Z', labels: { requestedAdd: ['testing'], requestedRemove: [], observed: ['testing'], state: 'verified' }, source: 'task-reported', publication: 'pending' }] }); break;
    case 'goal.changed': h.store.updateRun(run.id, { task: 'new human brief' }); break;
    case 'instruction.added': h.store.appendEvent(run.id, { type: 'user-message', text: 'human instruction' }); break;
    case 'instruction.queued': queued('first'); break;
    case 'instruction.edited': queued('first'); queued('edited'); break;
    case 'instruction.removed': queued('first'); h.store.updateRun(run.id, { queuedMessages: [] }); break;
    case 'config.changed': h.catalog.configChanged({ keys: ['baseBranch'] }); break;
    case 'workflow.saved': case 'workflow.deleted': h.catalog.workflowChanged({ name: 'fixture', change: variant === 'workflow.saved' ? 'saved' : 'deleted' }); break;
    case 'agent-config.changed': h.catalog.agentConfigChanged({ id: 'claude-settings-project' }); break;
    case 'executor.available': h.bus.emit('provider-status', { provider: 'codex', status: 'connected', enabled: true }); break;
    case 'executor.unavailable': h.bus.emit('provider-status', { provider: 'claude', status: 'disconnected', enabled: true }); break;
    default: throw new Error(`missing production fixture: ${variant}`);
  }
  const page = h.journal.read();
  if (page.status !== 'ok') throw new Error('unexpected gap');
  const row = page.events.filter(r => r.kind === kind).at(-1);
  expect(row, variant).toBeDefined();
  return row as McpJournalRow;
}

for (const client of DELIVERY_CLIENTS) describe(`#532 production event matrix / ${client}`, () => {
  // Named breaks: omit catalog subscriptions, hide task.failed, suppress all leader-origin rows.
  it.each(variants)('%s reaches the receiving peer with exact identity and cursor', async variant => {
    const h = await deliveryHarness(client);
    try {
      const row = produce(h, variant);
      await h.settle();
      const text = h.texts().join('\n');
      for (const value of [row.eventId, row.category, row.kind, row.origin, row.subject.type, row.subject.id, h.journal.headCursor()]) expect(text).toContain(value);
      if (client !== 'opencode' && row.subject.version) expect(text).toContain(row.subject.version);
      expect(row.category).toBe(MCP_EVENT_KIND_CATEGORY[row.kind as McpEventKind]);
      if (variant === 'verdict.posted') for (const value of ['REQUEST CHANGES', 'code-review', 'report', 'a'.repeat(40), 'verified']) expect(text).toContain(value);
      expect(h.journal.read()).toMatchObject({ events: expect.arrayContaining([row]) });
    } finally { await h.close(); }
  });

  it('guard-present other-leader change is news, own echo and empty dispatch make no model request', async () => {
    const h = await deliveryHarness(client);
    try {
      expect(await h.delivery.deliver({ projectId: 'matrix', events: [], nextCursor: h.journal.headCursor() }, new AbortController().signal)).toMatchObject({ handedThrough: null, dispatchDelivered: false });
      expect(h.texts()).toEqual([]);
      const dispatch = vi.spyOn(h.delivery, 'deliver');
      await h.guard.issue('own-operation', () => withEventOrigin({ origin: 'leader', causedBy: 'own-operation' }, () => h.catalog.configChanged({ keys: ['baseBranch'] })));
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      await dispatch.mock.results[0]?.value;
      expect(h.texts()).toEqual([]);
      withEventOrigin({ origin: 'leader', causedBy: 'other-operation' }, () => h.catalog.configChanged({ keys: ['defaultRunner'] }));
      await h.settle();
      expect(h.texts()).toHaveLength(1);
      expect(h.texts()[0]).toContain('leader');
      expect(h.texts()[0]).toContain('defaultRunner');
    } finally { await h.close(); }
  });
});

for (const client of DELIVERY_CLIENTS) describe(`#532 significance and ordering / ${client}`, () => {
  it('scans all-routine pages before failure, retains raw rows and never covers an unseen tail', async () => {
    // Named breaks: only Claude filters significance; task.failed is routine; cursor uses page tail.
    const h = await deliveryHarness(client);
    try {
      const steps = Array.from({ length: 104 }, (_, i) => ({ id: `check-${i}`, name: `Check ${i}`, kind: 'check' as const }));
      const run = h.store.createRun({ title: 'page boundary', task: 'check', workflow: 'fixture', steps });
      h.store.updateRun(run.id, { status: 'running', workflowDef: { name: 'fixture', source: 'file', steps: steps.map(s => ({ id: s.id, command: 'true', resultScope: 'routine' })) } });
      for (let i = 0; i < 101; i++) h.store.updateStep(run.id, `check-${i}`, { status: 'done' });
      h.store.updateRun(run.id, { status: 'failed' });
      const failureSeq = h.journal.latestSeq;
      for (let i = 101; i < 104; i++) h.store.updateStep(run.id, `check-${i}`, { status: 'done' });
      await vi.waitFor(() => expect(h.texts()).toHaveLength(1));
      const text = h.texts()[0] ?? '';
      expect(text).toContain('task.failed');
      expect(text).not.toContain('gate.passed');
      expect(text).toContain(h.journal.cursorAt(failureSeq));
      expect(text).not.toContain(h.journal.headCursor());
      expect(text).toContain('101');
      const rows: McpJournalRow[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = h.journal.read(cursor ? { cursor } : {});
        if (page.status !== 'ok') throw new Error('unexpected gap');
        rows.push(...page.events); cursor = page.nextCursor;
        if (!page.hasMore) break;
      }
      expect(rows.filter(r => r.kind === 'gate.passed')).toHaveLength(104);
      expect(rows.filter(r => r.kind === 'task.failed')).toHaveLength(1);
    } finally { await h.close(); }
  });

  it('delivers verdict before done, superseded failure and human instruction in journal order', async () => {
    const h = await deliveryHarness(client);
    try {
      const verdict = produce(h, 'verdict.posted');
      h.store.updateRun(verdict.subject.id, { status: 'done' });
      h.store.updateRun(verdict.subject.id, { status: 'running' });
      h.store.updateRun(verdict.subject.id, { status: 'failed' });
      h.store.updateRun(verdict.subject.id, { status: 'running' });
      h.store.appendEvent(verdict.subject.id, { type: 'user-message', text: 'human follow-up after failure' });
      h.store.updateRun(verdict.subject.id, { status: 'done' });
      await h.settle();
      const page = h.journal.read();
      if (page.status !== 'ok') throw new Error('unexpected gap');
      expect(page.events.map(r => r.kind)).toEqual(['verdict.posted', 'task.done', 'task.failed', 'instruction.added', 'task.done']);
      const text = h.texts().join('\n');
      let previous = -1;
      for (const row of page.events) {
        const position = text.indexOf(`${row.eventId} ${row.category}`);
        expect(position).toBeGreaterThan(previous); previous = position;
      }
    } finally { await h.close(); }
  });
});

// G1 requires exact subject versions at the receiving peer. #535 fixed OpenCode's renderer to
// include it, matching the other three adapters.
it.each(variants.filter(variant => !['config.changed', 'workflow.saved', 'workflow.deleted', 'agent-config.changed', 'executor.available', 'executor.unavailable'].includes(variant)))('#532/#535 OpenCode — %s receiving peer gets the decision version', async variant => {
  const h = await deliveryHarness('opencode');
  try {
    const row = produce(h, variant); await h.settle();
    expect(h.texts().join('\n')).toContain(row.subject.version);
  } finally { await h.close(); }
});

for (const client of DELIVERY_CLIENTS) it(`#532 legacy gate without routing metadata remains significant / ${client}`, async () => {
  const h = await deliveryHarness(client);
  try {
    // Persisted pre-metadata rows cannot be produced by today's catalog, which defaults to stage.
    // Seed that old wire shape in the real journal; everything downstream remains composed.
    const row = h.journal.append({ kind: 'gate.passed', category: 'E-03', subject: { type: 'run', id: 'legacy-run', version: 'legacy-version' }, origin: 'system', causedBy: null, summary: 'legacy check passed' });
    expect(row).toBeDefined();
    await h.settle();
    expect(h.texts()).toHaveLength(1);
    expect(h.texts()[0]).toContain('gate.passed');
    expect(h.texts()[0]).toContain(row?.eventId);
    expect(h.texts()[0]).toContain(h.journal.headCursor());
    expect(h.journal.read()).toMatchObject({ events: [row] });
  } finally { await h.close(); }
});
