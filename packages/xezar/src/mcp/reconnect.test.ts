import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MCP_JOURNAL_RETAINED_ROWS,
  type McpJournalAppendInput,
  type McpJournalOrigin,
  type McpJournalRow,
} from '@qodeca/xezar-contract';

import { RunStore, type RunRecord } from '../runs/store.ts';
import { EventJournal, McpJournalCursorError } from './event-journal.ts';
import { OperationReceiptStore } from './operation-receipts.ts';
import {
  LEADER_CURSORS_FILE,
  LeaderCursors,
  LeaderFeed,
  LeaderInbox,
  RECONNECT_STATE_MAX_TASKS,
  reactionOperationId,
  reconnect,
  runStateReader,
  type LeaderDelivery,
} from './reconnect.ts';
import { guardedRunMutation, runVersion } from './stale-write.ts';

/**
 * #105 — reconnect delivers outstanding significant events plus the current authoritative state,
 * with no repeated effect, explicit gaps and no polling. The five acceptance tests of the issue come
 * first, in its order; the degradation and cursor rules follow.
 *
 * Everything runs on the real `RunStore`, the real #103 journal and the real #101 receipt store.
 * The one stand-in is the EMITTER: deriving E-01 from a status transition is #104's job, so
 * `attachTerminalEmitter` below plays that part — attached when the PROJECT opens, never by a
 * leader connection, which is exactly the property N-05 needs.
 */

const PROJECT = 'alpha';
const DAY = 24 * 60 * 60 * 1_000;

let dataDir: string;
const journals: EventJournal[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'xez-reconnect-'));
});

afterEach(() => {
  vi.useRealTimers();
  for (const journal of journals.splice(0)) journal.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function openJournal(now?: () => number): EventJournal {
  const journal = EventJournal.open({ dataDir, projectId: PROJECT, secretValues: [], warn: () => {}, ...(now ? { now } : {}) });
  journals.push(journal);
  return journal;
}

function reopenJournal(journal: EventJournal, now?: () => number): EventJournal {
  journal.close();
  return openJournal(now);
}

function openCursors(journal: EventJournal, warn: (m: string) => void = () => {}): LeaderCursors {
  return LeaderCursors.open({ dataDir, projectId: PROJECT, journal, warn });
}

function createTask(store: RunStore, title = 'fix the login bug'): RunRecord {
  return store.createRun({ title, workflow: 'quick-task', task: title, steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }] });
}

function terminalRow(runId: string, version: string | null, origin: McpJournalOrigin = 'system', over: Partial<McpJournalAppendInput> = {}): McpJournalAppendInput {
  return {
    category: 'E-01',
    kind: 'task.terminal',
    subject: { type: 'run', id: runId, version },
    origin,
    causedBy: null,
    summary: `task ${runId.slice(0, 8)} reached a terminal status`,
    ...over,
  };
}

/**
 * #104's stand-in: one E-01 row per transition into a terminal status, with the version the run has
 * once the transition's writes settle (a microtask later, so the lifecycle line the engine appends
 * right after its status write is included). `origin` says who caused the transition.
 */
function attachTerminalEmitter(store: RunStore, journal: () => EventJournal) {
  const last = new Map<string, string>();
  let origin: McpJournalOrigin = 'system';
  store.on('run', (run: RunRecord) => {
    const previous = last.get(run.id);
    last.set(run.id, run.status);
    if (previous === run.status || !['done', 'failed', 'cancelled'].includes(run.status)) return;
    const by = origin;
    queueMicrotask(() => journal().append(terminalRow(run.id, runVersion(store, run.id) ?? null, by, {
      summary: `task finished: ${run.status}`,
    })));
  });
  return { as(who: McpJournalOrigin) { origin = who; } };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function ok<T extends { status: string }>(answer: T): Extract<T, { status: 'ok' }> {
  if (answer.status !== 'ok') throw new Error(`expected an ok answer, got ${answer.status}`);
  return answer as Extract<T, { status: 'ok' }>;
}

// ---- acceptance 1 ------------------------------------------------------------------------------

describe('acceptance 1 — a task completes while the leader is disconnected (A-15, F-21, N-05)', () => {
  it('the task survives, and the reconnect delivers the outstanding event and the current state', async () => {
    const store = RunStore.open(dataDir);
    let journal = openJournal();
    attachTerminalEmitter(store, () => journal);
    const statuses: string[] = [];
    store.on('run', (run: RunRecord) => statuses.push(run.status));

    // The leader connects and starts a task.
    let cursors = openCursors(journal);
    const wake = vi.fn();
    const feed = new LeaderFeed({ journal, cursors, readState: runStateReader(store, journal), wake });
    const first = ok(feed.connect());
    expect(first.events).toEqual([]);
    expect(first.fresh).toBe(true);
    const task = createTask(store);
    store.updateRun(task.id, { status: 'running', startedAt: new Date().toISOString() });

    // The client goes away. Nothing but the subscription is dropped.
    feed.disconnect();
    expect(feed.connected).toBe(false);

    // The executor finishes the task with no client connected.
    store.updateStep(task.id, 'task', { status: 'done' });
    store.updateRun(task.id, { status: 'done', finishedAt: new Date().toISOString() });
    store.appendEvent(task.id, { type: 'lifecycle', message: 'run complete' });
    await settle();

    // N-05: never cancelled, never lost; its result is where the cockpit reads it.
    expect(statuses).not.toContain('cancelled');
    expect(store.getRun(task.id)?.status).toBe('done');
    expect(store.readEvents(task.id).some((e) => e.type === 'lifecycle')).toBe(true);
    expect(wake).not.toHaveBeenCalled(); // nobody is connected to wake

    // Reconnect — a brand-new connection, as a returning client is.
    const again = ok(new LeaderFeed({ journal, cursors, readState: runStateReader(store, journal), wake }).connect());
    expect(again.fresh).toBe(true); // the SAME cursors object; its start was the head at first connect
    expect(again.events.map((d) => [d.row.category, d.row.subject.id, d.standing])).toEqual([['E-01', task.id, 'current']]);
    expect(again.state.tasks).toEqual([{ id: task.id, status: 'done', version: runVersion(store, task.id) }]);
    expect(again.state.latestSeq).toBe(journal.latestSeq);
    expect(again.hasMore).toBe(false);
    expect(again.position).toEqual({ deliveredSeq: 1, ackedSeq: 0, reactedSeq: 0 });

    // A restart of xezar in between changes nothing: the acknowledgement is persistent.
    journal = reopenJournal(journal);
    cursors = openCursors(journal);
    expect(cursors.fresh).toBe(false);
    const afterRestart = ok(reconnect({ journal, cursors, readState: runStateReader(store, journal) }));
    expect(afterRestart.events.map((d) => d.row.eventId)).toEqual(again.events.map((d) => d.row.eventId));

    // Once acknowledged, it is no longer outstanding — and the state is still delivered.
    expect(cursors.ack(afterRestart.nextCursor)).toEqual({ status: 'acked', ackedSeq: 1 });
    const settled = ok(reconnect({ journal, cursors, readState: runStateReader(store, journal) }));
    expect(settled.events).toEqual([]);
    expect(settled.state.tasks).toEqual([]); // nothing named, nothing in flight
    expect(openCursors(journal).position()).toEqual({ deliveredSeq: 1, ackedSeq: 1, reactedSeq: 0 });
  });
});

// ---- acceptance 2 ------------------------------------------------------------------------------

describe('acceptance 2 — duplicates and out-of-order delivery (A-15, A-21, N-10)', () => {
  it('releases each event once, in journal order, as one decision point with one effect', async () => {
    const journal = openJournal();
    const cursors = openCursors(journal);
    for (const n of [1, 2, 3]) journal.append(terminalRow(`run-${n}`, `rev1:run:run-${n}:1:0123456789ab`));
    const rows = ok(reconnect({ journal, cursors, readState: () => ({ latestSeq: 3, tasks: [], complete: true }) })).events.map((d) => d.row);
    const [r1, r2, r3] = rows as [McpJournalRow, McpJournalRow, McpJournalRow];

    // The leader's reaction to a finished task: one follow-up per event, through the #101 receipts.
    const receipts = OperationReceiptStore.open(dataDir);
    const effects: string[] = [];
    const decisions: McpJournalRow[][] = [];
    const react = async (batch: McpJournalRow[]) => {
      decisions.push(batch);
      return Promise.all(batch.map((row) => receipts.execute({
        projectId: PROJECT,
        operationId: reactionOperationId(journal.epoch, row, 'follow-up'),
        action: 'runs.create',
        payload: { task: `assess ${row.subject.id}` },
        reconcile: { kind: 'none' },
        effect: () => {
          effects.push(row.subject.id);
          return { outcome: 'ok', resultRef: { kind: 'run', id: `follow-${row.subject.id}` } };
        },
      })));
    };

    const inbox = new LeaderInbox({ projectId: PROJECT, afterSeq: 0 });
    const offer = async (batch: McpJournalRow[]) => {
      const accepted = inbox.accept(batch);
      if (accepted.deliver.length > 0) await react(accepted.deliver);
      return accepted;
    };

    // Out of order: row 3 arrives alone and is HELD, with the gap named.
    expect(await offer([r3])).toEqual({ deliver: [], duplicates: 0, missing: { fromSeq: 1, toSeq: 2 } });
    // Then everything twice, shuffled: released once, in order.
    const second = await offer([r2, r1, r3, r1, r2]);
    expect(second.deliver.map((row) => row.journalSeq)).toEqual([1, 2, 3]);
    expect(second.duplicates).toBe(3);
    expect(second.missing).toBeNull();
    // And again, all of it: a duplicate is no decision point at all.
    expect(await offer([r3, r2, r1])).toEqual({ deliver: [], duplicates: 3, missing: null });

    expect(decisions).toHaveLength(1);
    expect(effects).toEqual(['run-1', 'run-2', 'run-3']);

    // At-least-once: the consumer restarts before acknowledging, so the server delivers again. The
    // leader gets a second look — and the receipts make it a replay, not a second effect.
    const redelivered = ok(reconnect({ journal, cursors, readState: () => ({ latestSeq: 3, tasks: [], complete: true }) }));
    const restarted = new LeaderInbox({ projectId: PROJECT, afterSeq: cursors.position().ackedSeq });
    const answers = await react(restarted.accept(redelivered.events.map((d) => d.row)).deliver);
    expect(effects).toEqual(['run-1', 'run-2', 'run-3']);
    expect(answers.map((a) => ('replayed' in a ? a.replayed : undefined))).toEqual([true, true, true]);
  });

  it('drops another project’s row without counting it as anything', () => {
    const inbox = new LeaderInbox({ projectId: PROJECT, afterSeq: 0 });
    const foreign = { eventId: 'beta:1', journalSeq: 1, ts: new Date().toISOString(), projectId: 'beta', ...terminalRow('x', null) } as McpJournalRow;
    expect(inbox.accept([foreign])).toEqual({ deliver: [], duplicates: 0, missing: null });
  });

  it('keys a reaction on the journal epoch, so a recreated journal’s seq 1 is a new operation', () => {
    const a = reactionOperationId('11111111-1111-4111-8111-111111111111', { journalSeq: 1 }, 'follow-up');
    const b = reactionOperationId('22222222-2222-4222-8222-222222222222', { journalSeq: 1 }, 'follow-up');
    expect(a).not.toBe(b);
    expect(reactionOperationId('11111111-1111-4111-8111-111111111111', { journalSeq: 1 }, 'follow-up')).toBe(a);
    expect(reactionOperationId('11111111-1111-4111-8111-111111111111', { journalSeq: 1 }, 'cancel')).not.toBe(a);
    expect(() => reactionOperationId('e', { journalSeq: 1 }, 'Not A Label')).toThrow();
  });
});

// ---- acceptance 3 ------------------------------------------------------------------------------

/** A journal on disk as a previous process left it (the #103 file format): `count` rows at `ts`. */
function writeJournalFixture(count: number, ts: number): void {
  mkdirSync(join(dataDir, 'mcp'), { recursive: true });
  writeFileSync(join(dataDir, 'mcp', 'event-journal.json'), JSON.stringify({ v: 1, projectId: PROJECT, epoch: 'fixture-epoch', createdAt: new Date(ts).toISOString() }));
  const lines: string[] = [];
  for (let seq = 1; seq <= count; seq++) {
    lines.push(JSON.stringify({ eventId: `${PROJECT}:${seq}`, journalSeq: seq, ts: new Date(ts).toISOString(), projectId: PROJECT, ...terminalRow(`run-${seq}`, null) }));
  }
  writeFileSync(join(dataDir, 'mcp', 'event-journal.ndjson'), `${lines.join('\n')}\n`);
}

describe('acceptance 3 — a cursor older than retention (A-21, D-09 B-19)', () => {
  it('answers an explicit, recoverable gap with the current state, and recovers from it', () => {
    const T0 = Date.parse('2026-08-01T00:00:00.000Z');
    const extra = 50;
    // The leader connected when the journal held ten rows, then went away.
    writeJournalFixture(10, T0);
    let clock = T0;
    let journal = openJournal(() => clock);
    let cursors = openCursors(journal);
    expect(cursors.position().ackedSeq).toBe(10);
    journal.close();

    // Meanwhile the project kept working, and 15 days later retention (10 000 rows, 14 days) has
    // evicted rows the leader's cursor still needed.
    writeJournalFixture(MCP_JOURNAL_RETAINED_ROWS + extra, T0);
    clock = T0 + 15 * DAY;
    journal = reopenJournal(journal, () => clock);
    cursors = openCursors(journal);
    const readState = () => ({ latestSeq: journal.latestSeq, tasks: [], complete: true });
    const gap = reconnect({ journal, cursors, readState });
    if (gap.status !== 'cursor_too_old') throw new Error(`expected the gap, got ${gap.status}`);
    expect(gap.gap).toMatchObject({
      status: 'cursor_too_old',
      oldestSeq: extra + 1,
      latestSeq: MCP_JOURNAL_RETAINED_ROWS + extra,
      recovery: { required: 'current-state' },
    });
    expect(gap.state).toEqual({ latestSeq: MCP_JOURNAL_RETAINED_ROWS + extra, tasks: [], complete: true });

    // Stated again on every reconnect until the leader acknowledges it — a lost answer loses nothing.
    expect(reconnect({ journal, cursors, readState }).status).toBe('cursor_too_old');

    // Recoverable: continue from the resume cursor, from the oldest row still retained.
    const resumed = ok(reconnect({ journal, cursors, readState, cursor: gap.gap.resumeCursor }));
    expect(resumed.events[0]?.row.journalSeq).toBe(extra + 1);
    expect(resumed.hasMore).toBe(true);
    expect(cursors.ack(gap.gap.resumeCursor)).toEqual({ status: 'acked', ackedSeq: extra });
    expect(ok(reconnect({ journal, cursors, readState })).events[0]?.row.journalSeq).toBe(extra + 1);
  });

  it('answers the same gap when the journal was recreated, and counts from the new journal', () => {
    let journal = openJournal();
    const cursors0 = openCursors(journal);
    journal.append(terminalRow('run-1', null));
    const read = journal.read({});
    if (read.status !== 'ok') throw new Error('page');
    cursors0.ack(read.nextCursor);
    cursors0.markDelivered(1);

    // Deleting the journal is deleting history: a new epoch, and the old cursor cannot resolve.
    rmSync(join(dataDir, 'mcp', 'event-journal.ndjson'));
    journal = reopenJournal(journal);
    journal.append(terminalRow('run-2', null));
    const cursors = openCursors(journal);
    expect(cursors.position()).toEqual({ deliveredSeq: 0, ackedSeq: 0, reactedSeq: 0 });
    const gap = reconnect({ journal, cursors, readState: () => ({ latestSeq: 1, tasks: [], complete: true }) });
    if (gap.status !== 'cursor_too_old') throw new Error(`expected the gap, got ${gap.status}`);
    expect(gap.gap.oldestSeq).toBe(1);
    expect(cursors.ack(gap.gap.resumeCursor)).toEqual({ status: 'acked', ackedSeq: 0 });
    expect(ok(reconnect({ journal, cursors, readState: () => ({ latestSeq: 1, tasks: [], complete: true }) })).events.map((d) => d.row.subject.id)).toEqual(['run-2']);
  });

  it('refuses a malformed cursor instead of replaying from zero', () => {
    const journal = openJournal();
    const cursors = openCursors(journal);
    journal.append(terminalRow('run-1', null));
    expect(() => reconnect({ journal, cursors, readState: () => ({ latestSeq: 1, tasks: [], complete: true }), cursor: 'not-a-cursor' })).toThrow(McpJournalCursorError);
    expect(() => cursors.ack('not-a-cursor')).toThrow(McpJournalCursorError);
  });
});

// ---- acceptance 4 ------------------------------------------------------------------------------

describe('acceptance 4 — a completion arrives after a human cancellation', () => {
  it('orders by journal, lets the current state decide, and refuses a mutation built on the late completion', async () => {
    const store = RunStore.open(dataDir);
    const journal = openJournal();
    const emitter = attachTerminalEmitter(store, () => journal);
    const cursors = openCursors(journal);
    const task = createTask(store);
    store.updateRun(task.id, { status: 'running' });
    // What the executor saw when its work finished: the running task.
    const executorView = runVersion(store, task.id)!;

    // A human cancels in the cockpit (the store calls `POST …/cancel` ends in).
    emitter.as('human');
    store.updateRun(task.id, { status: 'cancelled', finishedAt: new Date().toISOString() });
    store.appendEvent(task.id, { type: 'lifecycle', message: 'run cancelled' });
    await settle();
    // …and the executor's completion lands afterwards, carrying the version it last saw.
    journal.append(terminalRow(task.id, executorView, 'system', { kind: 'task.completed', summary: 'task finished: done' }));

    const answer = ok(reconnect({ journal, cursors, readState: runStateReader(store, journal) }));
    expect(answer.events.map((d) => [d.row.journalSeq, d.row.origin, d.standing])).toEqual([
      [1, 'human', 'current'],
      [2, 'system', 'superseded'],
    ]);
    expect(answer.state.tasks).toEqual([{ id: task.id, status: 'cancelled', version: runVersion(store, task.id) }]);

    // The human's action stands: acting on the late completion is refused, with nothing applied.
    const late = answer.events[1]!.row;
    const apply = vi.fn(() => store.setPinned(task.id, true));
    expect(guardedRunMutation(store, task.id, late.subject.version ?? undefined, apply)).toMatchObject({ status: 'conflict', applied: false });
    expect(apply).not.toHaveBeenCalled();
    expect(store.getRun(task.id)?.status).toBe('cancelled');

    // Arrival order does not matter: the late row offered first is held until its place comes.
    const inbox = new LeaderInbox({ projectId: PROJECT, afterSeq: 0 });
    const rows = answer.events.map((d) => d.row);
    expect(inbox.accept([rows[1]!]).deliver).toEqual([]);
    expect(inbox.accept([rows[0]!]).deliver.map((row) => row.journalSeq)).toEqual([1, 2]);
  });
});

// ---- acceptance 5 ------------------------------------------------------------------------------

describe('acceptance 5 — no polling loop and no heartbeat (F-20, N-06)', () => {
  it('never wakes the leader without an event, and starts no timer', () => {
    vi.useFakeTimers();
    const journal = openJournal();
    const cursors = openCursors(journal);
    const wake = vi.fn<(delivery: LeaderDelivery) => void>();
    const own = new Set(['op-leader-0001']);
    const feed = new LeaderFeed({
      journal,
      cursors,
      readState: () => ({ latestSeq: journal.latestSeq, tasks: [], complete: true }),
      wake,
      isOwnOperation: (id) => own.has(id),
    });
    feed.connect();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(7 * DAY);
    expect(wake).not.toHaveBeenCalled();

    // The leader's own echo moves the cursor but is no reason to wake it (D-05 § 6.3).
    journal.append(terminalRow('run-1', null, 'leader', { causedBy: 'op-leader-0001' }));
    expect(wake).not.toHaveBeenCalled();
    expect(cursors.position().deliveredSeq).toBe(1);

    // A significant event is the one thing that wakes it — once.
    journal.append(terminalRow('run-2', null, 'human'));
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]![0].events.map((d) => d.row.subject.id)).toEqual(['run-2']);

    // Disconnected, events still land in the journal — and wake nobody.
    feed.disconnect();
    journal.append(terminalRow('run-3', null, 'human'));
    vi.advanceTimersByTime(7 * DAY);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('has no timer primitive in its source at all', () => {
    const source = readFileSync(fileURLToPath(new URL('./reconnect.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/\bset(?:Interval|Timeout|Immediate)\s*\(/);
  });
});

// ---- the cursors -------------------------------------------------------------------------------

describe('persistent acknowledgement (D-05 § 6.6)', () => {
  it('is monotonic and idempotent — an older cursor is a no-op, never a rewind', () => {
    const journal = openJournal();
    const cursors = openCursors(journal);
    const start = journal.headCursor();
    journal.append(terminalRow('run-1', null));
    journal.append(terminalRow('run-2', null));
    expect(cursors.ack(journal.headCursor())).toEqual({ status: 'acked', ackedSeq: 2 });
    expect(cursors.ack(journal.headCursor())).toEqual({ status: 'no-op', ackedSeq: 2 });
    expect(cursors.ack(start)).toEqual({ status: 'no-op', ackedSeq: 2 });
    // A replay from an earlier cursor is its own request and leaves the ack where it was.
    expect(ok(reconnect({ journal, cursors, readState: () => ({ latestSeq: 2, tasks: [], complete: true }), cursor: start })).events).toHaveLength(2);
    expect(cursors.position().ackedSeq).toBe(2);
  });

  it('keeps delivered, acknowledged and reacted apart', () => {
    const journal = openJournal();
    const cursors = openCursors(journal);
    journal.append(terminalRow('run-1', null));
    cursors.markDelivered(1);
    expect(cursors.position()).toEqual({ deliveredSeq: 1, ackedSeq: 0, reactedSeq: 0 });
    cursors.markReacted(1);
    cursors.markReacted(0);
    expect(openCursors(journal).position()).toEqual({ deliveredSeq: 1, ackedSeq: 0, reactedSeq: 1 });
  });

  it('restarts a leader with unreadable cursors at the head, says so, and warns once', () => {
    const journal = openJournal();
    journal.append(terminalRow('run-1', null));
    mkdirSync(join(dataDir, 'mcp'), { recursive: true });
    writeFileSync(join(dataDir, 'mcp', LEADER_CURSORS_FILE), '{ torn');
    const warn = vi.fn();
    const cursors = openCursors(journal, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dataDir, 'mcp', `${LEADER_CURSORS_FILE}.corrupt`))).toBe(true);
    const answer = ok(reconnect({ journal, cursors, readState: () => ({ latestSeq: 1, tasks: [], complete: true }) }));
    expect(answer.fresh).toBe(true);
    expect(answer.events).toEqual([]);
  });

  it('keeps working in memory when the cursor file cannot be written', () => {
    const journal = openJournal();
    rmSync(join(dataDir, 'mcp', LEADER_CURSORS_FILE), { force: true });
    mkdirSync(join(dataDir, 'mcp', LEADER_CURSORS_FILE), { recursive: true }); // a directory where the file goes
    const warn = vi.fn();
    const cursors = openCursors(journal, warn);
    journal.append(terminalRow('run-1', null));
    expect(cursors.ack(journal.headCursor())).toEqual({ status: 'acked', ackedSeq: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses a journal of another project', () => {
    const journal = openJournal();
    expect(() => LeaderCursors.open({ dataDir, projectId: 'beta', journal })).toThrow();
  });
});

describe('the current-state snapshot', () => {
  it('names the rows’ tasks first, then every task in flight, bounded by B-02', () => {
    const store = RunStore.open(dataDir);
    const journal = openJournal();
    const finished = createTask(store, 'finished');
    store.updateRun(finished.id, { status: 'done' });
    const running = Array.from({ length: RECONNECT_STATE_MAX_TASKS + 5 }, (_, i) => createTask(store, `task ${i}`));
    const state = runStateReader(store, journal)([{ type: 'run', id: finished.id, version: null }, { type: 'run', id: 'gone', version: null }]);
    expect(state.tasks).toHaveLength(RECONNECT_STATE_MAX_TASKS);
    expect(state.tasks[0]).toMatchObject({ id: finished.id, status: 'done' });
    expect(state.tasks[1]).toEqual({ id: 'gone', status: null, version: null });
    expect(state.complete).toBe(false);
    expect(running.length).toBeGreaterThan(RECONNECT_STATE_MAX_TASKS);
    // A projection only: no title, no prompt.
    expect(Object.keys(state.tasks[0]!).sort()).toEqual(['id', 'status', 'version']);
  });
});
