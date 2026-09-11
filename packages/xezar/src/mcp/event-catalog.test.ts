import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MCP_EVENT_CATALOG,
  MCP_EVENT_KIND_CATEGORY,
  mcpCatalogEventSchema,
  type McpEventKind,
  type McpJournalCategory,
  type McpJournalRow,
  type ProviderStatus,
} from '@qodeca/xezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunStore, type RunRecord } from '../runs/store.ts';
import type { WorkspaceEventBus } from '../server/server.ts';
import { EventCatalog, withEventOrigin, type WorkspaceEventSource } from './event-catalog.ts';
import { EventJournal } from './event-journal.ts';
import { runVersion } from './stale-write.ts';

/**
 * #104 — the E-01–E-06 catalog reaches the journal, and nothing else does.
 *
 * Every case drives the REAL `RunStore` and the real `EventJournal`, and makes the same store call
 * the engine or the cockpit's route makes (`updateRun` for a status transition, `updateStep` for a
 * gate, `appendEvent` for a transcript line) — N-02 is the point: one derivation, whoever caused it.
 */

// The catalog's source must stay assignable from the real workspace bus (compile-time only).
const busIsASource = (bus: WorkspaceEventBus): WorkspaceEventSource => bus;
void busIsASource;

const LEADER_OP = 'op-leader-0001';

/** The workspace bus, reduced to what the catalog subscribes through. */
class FakeWorkspaceBus implements WorkspaceEventSource {
  readonly listeners = new Set<(event: string, data: unknown) => void>();
  on(listener: (event: string, data: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: string, data: unknown): void {
    for (const listener of [...this.listeners]) listener(event, data);
  }
}

const CONNECTED: ProviderStatus[] = [
  { provider: 'claude', status: 'connected', enabled: true },
  { provider: 'codex', status: 'disconnected', enabled: true },
];

let dataDir: string;
let store: RunStore;
let journal: EventJournal;
let bus: FakeWorkspaceBus;
let catalog: EventCatalog;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'xez-event-catalog-'));
  store = RunStore.open(dataDir);
  journal = EventJournal.open({ dataDir, projectId: 'xezar', secretValues: [] });
  bus = new FakeWorkspaceBus();
  catalog = EventCatalog.attach({ journal, store, workspaceEvents: bus, providerBaseline: CONNECTED });
});

afterEach(() => {
  catalog.detach();
  journal.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function rows(): McpJournalRow[] {
  const page = journal.read();
  if (page.status !== 'ok') throw new Error('unexpected cursor_too_old');
  return page.events;
}

function createRun(steps: RunRecord['steps'][number]['kind'][] = ['agent']): RunRecord {
  return store.createRun({
    title: 'fix the login bug',
    workflow: 'quick-task',
    task: 'fix the login bug',
    steps: steps.map((kind, i) => ({ id: kind === 'check' ? `gates-${i}` : `step-${i}`, name: `Step ${i}`, kind })),
  });
}

/** A run that has started: queued → running with its first step running. Writes no row. */
function startedRun(steps?: RunRecord['steps'][number]['kind'][]): RunRecord {
  const run = createRun(steps);
  store.updateRun(run.id, { status: 'running', startedAt: new Date().toISOString() });
  store.updateStep(run.id, run.steps[0]!.id, { status: 'running', iterations: 1 });
  return run;
}

function waitingRun(): RunRecord {
  const run = startedRun();
  store.updateRun(run.id, { status: 'waiting' });
  return run;
}

/** Rows without the parts that differ between two otherwise identical changes. */
function shape(row: McpJournalRow) {
  const { eventId: _e, journalSeq: _s, ts: _t, origin: _o, causedBy: _c, subject, ...rest } = row;
  return { ...rest, subject: { type: subject.type } };
}

interface Scenario {
  category: McpJournalCategory;
  what: string;
  /** Builds whatever the change needs; must write no row itself. Returns the act and the subject. */
  arrange: () => { act: () => void; subject: { type: string; id: string; version: () => string | null } };
  kind: McpEventKind;
  origin: 'human' | 'system';
}

const runSubject = (runId: string) => ({ type: 'run', id: runId, version: () => runVersion(store, runId) ?? null });

/** ONE scenario per catalog entry (the acceptance criterion of #104). */
const CATALOG_SCENARIOS: Scenario[] = [
  {
    category: 'E-01',
    what: 'the engine finishes a task',
    kind: 'task.done',
    origin: 'system',
    arrange: () => {
      const run = startedRun();
      return { act: () => store.updateRun(run.id, { status: 'done', finishedAt: new Date().toISOString() }), subject: runSubject(run.id) };
    },
  },
  {
    category: 'E-02',
    what: 'the agent raises a structured question and parks',
    kind: 'question.asked',
    origin: 'system',
    arrange: () => {
      const run = startedRun();
      return {
        act: () => {
          // The engine's order: the `ask.requested` line first, then the `waiting` status.
          store.appendEvent(run.id, { type: 'ask.requested', requestId: 'r1', questions: [{ question: 'Which scope?' }] });
          store.updateRun(run.id, { status: 'waiting' });
        },
        subject: runSubject(run.id),
      };
    },
  },
  {
    category: 'E-03',
    what: 'a quality gate passes',
    kind: 'gate.passed',
    origin: 'system',
    arrange: () => {
      const run = startedRun(['check']);
      return { act: () => store.updateStep(run.id, run.steps[0]!.id, { status: 'done' }), subject: runSubject(run.id) };
    },
  },
  {
    category: 'E-04',
    what: 'a human edits the queued prompt',
    kind: 'goal.changed',
    origin: 'human',
    arrange: () => {
      const run = createRun();
      return { act: () => store.updateRun(run.id, { task: 'fix the login bug, and the logout one' }), subject: runSubject(run.id) };
    },
  },
  {
    category: 'E-05',
    what: 'the project configuration changes what runs',
    kind: 'config.changed',
    origin: 'human',
    arrange: () => ({
      act: () => void catalog.configChanged({ keys: ['defaultRunner', 'baseBranch'] }),
      subject: { type: 'config', id: 'project', version: () => null },
    }),
  },
  {
    category: 'E-06',
    what: 'an executor stops being available',
    kind: 'executor.unavailable',
    origin: 'system',
    arrange: () => ({
      act: () => bus.emit('provider-status', { provider: 'claude', status: 'disconnected', enabled: true }),
      subject: { type: 'executor', id: 'claude', version: () => null },
    }),
  },
];

describe('the catalog: one scenario per entry, exactly one row each', () => {
  it('covers every catalog entry exactly once', () => {
    expect(CATALOG_SCENARIOS.map((s) => s.category)).toEqual(Object.keys(MCP_EVENT_CATALOG));
  });

  it.each(CATALOG_SCENARIOS)('$category — $what', ({ arrange, category, kind, origin }) => {
    const { act, subject } = arrange();
    expect(rows()).toEqual([]);

    act();

    const written = rows();
    expect(written).toHaveLength(1);
    const row = written[0]!;
    expect(row.category).toBe(category);
    expect(row.kind).toBe(kind);
    expect(row.subject).toEqual({ type: subject.type, id: subject.id, version: subject.version() });
    expect(row.origin).toBe(origin);
    expect(row.causedBy).toBeNull();
    expect(mcpCatalogEventSchema.safeParse(row).success).toBe(true);
  });

  it('writes a run row with the version of the run AFTER the change (D-06)', () => {
    const run = startedRun();
    const before = runVersion(store, run.id);
    store.updateRun(run.id, { status: 'failed', finishedAt: new Date().toISOString() });
    const [row] = rows();
    expect(row?.subject.version).toBe(runVersion(store, run.id));
    expect(row?.subject.version).not.toBe(before);
  });
});

describe('every other kind the catalog emits', () => {
  const cases: Array<{ kind: McpEventKind; origin: 'human' | 'system'; act: () => void }> = [
    {
      kind: 'task.failed',
      origin: 'system',
      act: () => {
        const run = startedRun();
        store.updateStep(run.id, run.steps[0]!.id, { status: 'failed', error: 'boom' });
        store.updateRun(run.id, { status: 'failed', error: 'boom' });
      },
    },
    {
      kind: 'task.cancelled',
      origin: 'human',
      act: () => {
        const run = createRun();
        store.updateRun(run.id, { status: 'cancelled' });
      },
    },
    {
      kind: 'task.blocked',
      origin: 'system',
      act: () => {
        const run = startedRun();
        store.updateRun(run.id, { status: 'waiting' });
      },
    },
    {
      kind: 'question.answered',
      origin: 'human',
      act: () => {
        const run = waitingRun();
        store.appendEvent(run.id, { type: 'user-message', text: 'the narrow scope', imageCount: 0, images: [] });
        store.updateRun(run.id, { status: 'running' });
      },
    },
    {
      kind: 'gate.failed',
      origin: 'system',
      act: () => {
        const run = startedRun(['check']);
        store.updateStep(run.id, run.steps[0]!.id, { status: 'failed', error: 'npm test failed' });
      },
    },
    {
      kind: 'result.ready',
      origin: 'system',
      act: () => {
        const run = startedRun();
        store.updateRun(run.id, { status: 'review' });
      },
    },
    {
      kind: 'instruction.added',
      origin: 'human',
      act: () => {
        const run = startedRun();
        store.appendEvent(run.id, { type: 'user-message', text: 'also cover logout', imageCount: 0, images: [] });
      },
    },
    {
      kind: 'instruction.queued',
      origin: 'human',
      act: () => {
        const run = createRun();
        store.updateRun(run.id, { queuedMessages: [{ id: 'm1', text: 'and logout', createdAt: new Date().toISOString() }] });
      },
    },
    {
      kind: 'instruction.edited',
      origin: 'human',
      act: () => {
        const run = createRun();
        const createdAt = new Date().toISOString();
        store.updateRun(run.id, { queuedMessages: [{ id: 'm1', text: 'and logout', createdAt }] });
        store.updateRun(run.id, { queuedMessages: [{ id: 'm1', text: 'and signup', createdAt }] });
      },
    },
    {
      kind: 'instruction.removed',
      origin: 'human',
      act: () => {
        const run = createRun();
        store.updateRun(run.id, { queuedMessages: [{ id: 'm1', text: 'and logout', createdAt: new Date().toISOString() }] });
        store.updateRun(run.id, { queuedMessages: [] });
      },
    },
    { kind: 'workflow.saved', origin: 'human', act: () => void catalog.workflowChanged({ name: 'Release train', change: 'saved' }) },
    { kind: 'workflow.deleted', origin: 'human', act: () => void catalog.workflowChanged({ name: 'Release train', change: 'deleted' }) },
    { kind: 'agent-config.changed', origin: 'human', act: () => void catalog.agentConfigChanged({ id: 'claude-settings-project' }) },
    {
      kind: 'executor.available',
      origin: 'system',
      act: () => bus.emit('provider-status', { provider: 'codex', status: 'connected', enabled: true }),
    },
  ];

  it('lists every kind of the contract once, between the two tables', () => {
    const covered = [...CATALOG_SCENARIOS.map((s) => s.kind), ...cases.map((c) => c.kind)].sort();
    expect(covered).toEqual(Object.keys(MCP_EVENT_KIND_CATEGORY).sort());
  });

  it.each(cases)('$kind', ({ kind, origin, act }) => {
    act();
    const matching = rows().filter((row) => row.kind === kind);
    expect(matching).toHaveLength(1);
    expect(matching[0]!.category).toBe(MCP_EVENT_KIND_CATEGORY[kind]);
    expect(matching[0]!.origin).toBe(origin);
    expect(mcpCatalogEventSchema.safeParse(matching[0]).success).toBe(true);
  });

  it('writes the result and the gate as different kinds — review is not a quality gate (F-11)', () => {
    const run = startedRun(['check', 'agent']);
    store.updateStep(run.id, run.steps[0]!.id, { status: 'done' });
    store.updateRun(run.id, { status: 'review' });
    expect(rows().map((row) => [row.category, row.kind])).toEqual([
      ['E-03', 'gate.passed'],
      ['E-03', 'result.ready'],
    ]);
  });
});

describe('the exclusion: a whole task produces nothing but its outcome', () => {
  it('writes zero rows for token counters, log lines, ping, usage and presentation — then one for the completion', () => {
    const run = createRun(['agent', 'agent']);
    const [first, second] = run.steps;
    store.updateRun(run.id, { status: 'running', startedAt: new Date().toISOString(), currentStepId: first!.id });
    store.appendEvent(run.id, { type: 'lifecycle', message: 'run started — workflow "quick-task" (runner: claude)' });
    store.appendEvent(run.id, { type: 'note', message: 'worktree ready — branch xez/abc (base main)' });

    for (const step of [first!, second!]) {
      store.updateStep(run.id, step.id, { status: 'running', iterations: 1, startedAt: new Date().toISOString() });
      store.appendEvent(run.id, { type: 'step-start', stepId: step.id });
      store.appendEvent(run.id, { type: 'session.started', stepId: step.id, sessionId: 's1' });
      store.appendEvent(run.id, { type: 'turn.started', stepId: step.id });
      for (let i = 0; i < 5; i++) {
        // Tool traffic and the transcript itself.
        store.appendEvent(run.id, { type: 'item.started', stepId: step.id, item: { id: `i${i}`, kind: 'tool' } });
        store.emitEphemeral(run.id, { type: 'item.delta', stepId: step.id, itemId: `i${i}`, field: 'output', delta: 'x' });
        store.appendEvent(run.id, { type: 'tool-call', stepId: step.id, name: 'Bash', input: { command: 'ls' } });
        store.appendEvent(run.id, { type: 'tool-result', stepId: step.id, output: 'README.md' });
        store.appendEvent(run.id, { type: 'item.completed', stepId: step.id, item: { id: `i${i}`, kind: 'tool' } });
        store.appendEvent(run.id, { type: 'text', stepId: step.id, text: 'working on it' });
        // Token counters and cost — on the transcript AND on the record.
        store.appendEvent(run.id, { type: 'token-usage', stepId: step.id, tokensUsed: 100 * (i + 1) });
        store.appendEvent(run.id, { type: 'usage.updated', stepId: step.id, usage: { total: 100 * (i + 1) } });
        store.appendEvent(run.id, { type: 'cost', stepId: step.id, usd: 0.01 });
        store.updateStep(run.id, step.id, { tokensUsed: 100 * (i + 1), costUsd: 0.01 * (i + 1), inputTokens: 50 * i, outputTokens: 50 * i });
        // Log lines.
        store.appendEvent(run.id, { type: 'note', stepId: step.id, message: `claude: skipped unparseable stream line ${i}` });
        store.appendEvent(run.id, { type: 'check-output', stepId: step.id, command: 'ls', text: 'ok', exitCode: 0 });
        // A keepalive frame, were one ever put on the bus — it never reaches disk.
        store.emitEphemeral(run.id, { type: 'ping' });
      }
      // Presentation.
      store.updateRun(run.id, { titleSummary: `summary ${step.id}`, diffStat: { adds: 8, dels: 1, files: 2 }, peakRssBytes: 1e8, peakProcCount: 4 });
      store.updateRun(run.id, { status: 'running', activity: 'monitoring' });
      store.updateRun(run.id, { activity: undefined });
      store.appendEvent(run.id, { type: 'turn.completed', stepId: step.id });
      store.appendEvent(run.id, { type: 'turn-end', stepId: step.id });
      store.updateStep(run.id, step.id, { status: 'done', finishedAt: new Date().toISOString() });
      store.appendEvent(run.id, { type: 'step-end', stepId: step.id, status: 'done' });
    }
    store.updateRun(run.id, { title: 'Fix login', titleSummary: 'Fix login', titleOrigin: 'user' });
    store.setRead(run.id);
    store.setUnread(run.id);
    store.setPinned(run.id, true);
    store.setPinned(run.id, false);
    // Workspace noise, and an executor that did not actually change.
    bus.emit('checkout-progress', { phase: 'receiving', percent: 40 });
    bus.emit('project-added', { id: 'other' });
    bus.emit('automation-change', { project: 'xezar', automationId: 'a1', revision: 2 });
    bus.emit('provider-status', { provider: 'claude', status: 'connected', enabled: true, hint: 'signed in' });
    // A configuration write that only changes how tasks are named.
    expect(catalog.configChanged({ keys: ['liveTitleUpdates', 'namerModel'] })).toBeUndefined();

    expect(rows()).toEqual([]);

    store.updateRun(run.id, { status: 'done', finishedAt: new Date().toISOString(), currentStepId: undefined });
    store.appendEvent(run.id, { type: 'lifecycle', message: 'goal achieved — session closed' });
    store.appendEvent(run.id, { type: 'session.ended', reason: 'completed' });
    store.setArchived(run.id, true);

    expect(rows().map((row) => [row.category, row.kind])).toEqual([['E-01', 'task.done']]);
  });

  it('does not repeat a row for a status that did not move', () => {
    const run = startedRun();
    store.updateRun(run.id, { status: 'waiting' });
    store.updateRun(run.id, { status: 'waiting' });
    store.updateStep(run.id, run.steps[0]!.id, { status: 'waiting' });
    expect(rows()).toHaveLength(1);
  });

  it('writes one row, not two, for a question — whichever order the backend parks in', () => {
    const engineOrder = startedRun();
    store.appendEvent(engineOrder.id, { type: 'ask.requested', requestId: 'r1', questions: [{}, {}] });
    store.updateRun(engineOrder.id, { status: 'waiting' });

    const parkedFirst = startedRun();
    store.updateRun(parkedFirst.id, { status: 'waiting' });
    store.appendEvent(parkedFirst.id, { type: 'ask.requested', requestId: 'r2', questions: [{}] });

    expect(rows().map((row) => [row.subject.id, row.kind])).toEqual([
      [engineOrder.id, 'question.asked'],
      [parkedFirst.id, 'task.blocked'],
      [parkedFirst.id, 'question.asked'],
    ]);
    expect(rows()[0]!.summary).toBe('the agent asked 2 questions and is waiting for an answer');
  });

  it('forgets an unanswered question once the run moves on', () => {
    const run = startedRun();
    store.appendEvent(run.id, { type: 'ask.requested', requestId: 'r1', questions: [{}] });
    store.updateRun(run.id, { status: 'failed' });
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { status: 'waiting' });
    expect(rows().map((row) => row.kind)).toEqual(['task.failed', 'task.blocked']);
  });

  it('keeps message text, questions and errors out of the row (F-15: a summary, never a payload)', () => {
    const run = waitingRun();
    store.appendEvent(run.id, { type: 'user-message', text: 'token sk-live-verysecret', imageCount: 0, images: [] });
    store.appendEvent(run.id, { type: 'ask.requested', requestId: 'r1', questions: [{ question: 'paste the sk-live key?' }] });
    store.updateRun(run.id, { status: 'failed', error: 'auth failed for sk-live-verysecret' });
    for (const row of rows()) expect(JSON.stringify(row)).not.toContain('sk-live');
  });
});

describe('origin: a human cancel and an MCP cancel differ only by who issued them', () => {
  it('cancelling a queued task — the effect lands inside the call', () => {
    const human = createRun();
    const leader = createRun();
    store.updateRun(human.id, { status: 'cancelled', finishedAt: new Date().toISOString() });
    withEventOrigin({ origin: 'leader', causedBy: LEADER_OP, runId: leader.id }, () => {
      store.updateRun(leader.id, { status: 'cancelled', finishedAt: new Date().toISOString() });
    });

    const [humanRow, leaderRow] = rows();
    expect(humanRow).toMatchObject({ category: 'E-01', kind: 'task.cancelled', origin: 'human', causedBy: null });
    expect(leaderRow).toMatchObject({ category: 'E-01', kind: 'task.cancelled', origin: 'leader', causedBy: LEADER_OP });
    expect(shape(leaderRow!)).toEqual(shape(humanRow!));
  });

  it('cancelling a running task — the effect lands when the agent process exits, after the call', async () => {
    const human = startedRun();
    const leader = startedRun();
    // The route only asks the manager to interrupt; the status is written later, outside the call.
    withEventOrigin({ origin: 'leader', causedBy: LEADER_OP, runId: leader.id }, () => ({ cancelled: true }));
    await new Promise((resolve) => setImmediate(resolve));
    for (const run of [human, leader]) {
      store.updateStep(run.id, run.steps[0]!.id, { status: 'cancelled' });
      store.updateRun(run.id, { status: 'cancelled', finishedAt: new Date().toISOString(), currentStepId: undefined });
    }

    const [humanRow, leaderRow] = rows();
    expect(humanRow).toMatchObject({ origin: 'human', causedBy: null });
    expect(leaderRow).toMatchObject({ origin: 'leader', causedBy: LEADER_OP });
    expect(shape(leaderRow!)).toEqual(shape(humanRow!));
  });

  it('spends an intent on one transition only', () => {
    const run = startedRun();
    withEventOrigin({ origin: 'leader', causedBy: LEADER_OP, runId: run.id }, () => undefined);
    store.updateRun(run.id, { status: 'waiting' });
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { status: 'done' });
    expect(rows().map((row) => [row.kind, row.origin])).toEqual([
      ['task.blocked', 'leader'],
      ['task.done', 'system'],
    ]);
  });

  it('writes no E-04 or answer row for the leader’s own change — those entries are HUMAN changes', () => {
    const queued = createRun();
    const waiting = waitingRun();
    const setup = rows();
    expect(setup.map((row) => row.kind)).toEqual(['task.blocked']);
    withEventOrigin({ origin: 'leader', causedBy: LEADER_OP }, () => {
      store.updateRun(queued.id, { task: 'a narrower goal' });
      store.updateRun(queued.id, { queuedMessages: [{ id: 'm1', text: 'and logout', createdAt: new Date().toISOString() }] });
      store.appendEvent(waiting.id, { type: 'user-message', text: 'go ahead', imageCount: 0, images: [] });
    });
    expect(rows()).toEqual(setup);
  });

  it('keeps a leader configuration change, marked as the leader’s', () => {
    withEventOrigin({ origin: 'leader', causedBy: LEADER_OP }, () => catalog.configChanged({ keys: ['maxParallel'] }));
    expect(rows()).toMatchObject([{ category: 'E-05', origin: 'leader', causedBy: LEADER_OP }]);
  });

  it('refuses a leader context without an operation id, and an operation id without a leader', () => {
    expect(() => withEventOrigin({ origin: 'leader', causedBy: null }, () => undefined)).toThrow(/operation/);
    expect(() => withEventOrigin({ origin: 'human', causedBy: LEADER_OP }, () => undefined)).toThrow(/operation id/);
  });
});

describe('lifecycle of the catalog itself', () => {
  it('treats the runs already in the store as the baseline — attaching writes nothing', () => {
    catalog.detach();
    const done = startedRun();
    store.updateRun(done.id, { status: 'done' });
    const waiting = waitingRun();
    catalog = EventCatalog.attach({ journal, store });
    expect(rows()).toEqual([]);
    // …and a Continue of a finished run is a new instruction, then an ordinary transition.
    store.appendEvent(done.id, { type: 'user-message', text: 'one more thing', imageCount: 0, images: [] });
    store.updateRun(done.id, { status: 'running' });
    store.updateRun(done.id, { status: 'waiting' });
    store.appendEvent(waiting.id, { type: 'user-message', text: 'yes', imageCount: 0, images: [] });
    expect(rows().map((row) => [row.subject.id, row.kind])).toEqual([
      [done.id, 'instruction.added'],
      [done.id, 'task.blocked'],
      [waiting.id, 'question.answered'],
    ]);
  });

  it('releases every subscription on detach', () => {
    const baseline = { run: store.listenerCount('run'), event: store.listenerCount('event'), deleted: store.listenerCount('deleted') };
    expect(bus.listeners.size).toBe(1);
    catalog.detach();
    expect(bus.listeners.size).toBe(0);
    expect(store.listenerCount('run')).toBe(baseline.run - 1);
    expect(store.listenerCount('event')).toBe(baseline.event - 1);
    expect(store.listenerCount('deleted')).toBe(baseline.deleted - 1);
    const run = startedRun();
    store.updateRun(run.id, { status: 'done' });
    expect(rows()).toEqual([]);
  });

  it('counts an executor seen for the first time without a baseline as a change', () => {
    catalog.detach();
    catalog = EventCatalog.attach({ journal, store, workspaceEvents: bus });
    bus.emit('provider-status', { provider: 'pi', status: 'connected', enabled: true });
    bus.emit('provider-status', { provider: 'pi', status: 'connected', enabled: true });
    bus.emit('provider-status', { provider: 'pi', status: 'connected', enabled: false });
    bus.emit('provider-status', { provider: 'pi', status: 'not-installed', enabled: false });
    bus.emit('provider-status', { not: 'a provider row' });
    expect(rows().map((row) => [row.kind, row.subject.id, row.summary])).toEqual([
      ['executor.available', 'pi', 'executor pi is available'],
      ['executor.unavailable', 'pi', 'executor pi is unavailable (disabled)'],
    ]);
  });

  it('never throws into the store when the journal refuses a row — one warning, and the task goes on', () => {
    catalog.detach();
    const warn = vi.fn();
    const broken = { append: () => { throw new Error('disk on fire'); } };
    catalog = EventCatalog.attach({ journal: broken, store, warn });
    const run = startedRun();
    expect(() => store.updateRun(run.id, { status: 'failed' })).not.toThrow();
    expect(() => store.updateRun(run.id, { status: 'done' })).not.toThrow();
    expect(store.getRun(run.id)?.status).toBe('done');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
