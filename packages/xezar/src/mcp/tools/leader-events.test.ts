import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import {
  MCP_JOURNAL_MIN_RETENTION_DAYS,
  MCP_JOURNAL_PAGE_ROWS,
  MCP_JOURNAL_RETAINED_ROWS,
  type McpJournalAppendInput,
  type McpLeaderDoorResult,
  type McpLeaderSelfStatus,
} from '@qodeca/xezar-contract';
import { afterEach, describe, expect, it } from 'vitest';

import { EventJournal } from '../event-journal.ts';
import { LeaderCursors, type StateReader } from '../reconnect.ts';
import type { McpToolContext, McpToolResult } from '../tool.ts';
import { type LeaderControlPort, leaderEventsInputSchema, leaderEventsTool } from './leader-events.ts';

/**
 * #450 — `leader_events` `attach`, `stop` and `status`: the arguments the schema refuses, the answer
 * with no delivery path to reach, and the authoritative first line of each outcome. The rules behind
 * each outcome are `LeaderDelivery`'s (`leader-delivery.test.ts`); this file covers the door's shape.
 */

const base = { project: { id: 'alpha', name: 'Alpha', root: '/nonexistent' }, xezarVersion: '0.0.0-test' };
const issues = (args: Record<string, unknown>): string[] => {
  const parsed = leaderEventsInputSchema.safeParse(args);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`);
};
const text = (result: McpToolResult): string => result.content.map((part) => part.text).join('\n');
const firstLine = (result: McpToolResult): string => text(result).split('\n')[0]!;

const attached: McpLeaderSelfStatus = {
  available: true,
  owner: { client: 'claude-code' },
  leader: { client: 'claude-code', state: 'attached' },
  delivery: { state: 'idle', deliveredSeq: 0, ackedSeq: 0, reactedSeq: 0, latestSeq: 0 },
  blocker: null,
  canPush: true,
  pushUnavailable: null,
  self: { client: 'claude-code', isOwner: true, attached: true },
};
const detached: McpLeaderSelfStatus = { ...attached, leader: null, blocker: { code: 'no-leader-session', message: 'm', fix: 'f' }, self: { client: 'claude-code', isOwner: true, attached: false } };

function port(answers: { status?: McpLeaderSelfStatus; attach?: McpLeaderDoorResult; stop?: McpLeaderDoorResult }) {
  const keys: string[] = [];
  const control: LeaderControlPort = {
    sessionStatus: (key) => (keys.push(key), answers.status ?? attached),
    attachSession: async (key) => (keys.push(key), answers.attach!),
    stopSession: async (key) => (keys.push(key), answers.stop!),
  };
  return { control, keys };
}
const call = (args: Record<string, unknown>, ctx: Record<string, unknown>) =>
  leaderEventsTool.call(args as never, { ...base, ...ctx } as McpToolContext);

describe('leader_events arguments for attach, stop and status (#450, T-1)', () => {
  it('attach and stop need an operationId; status refuses one', () => {
    // RED against: deleting the `door && operationId === undefined` or the status branch.
    expect(issues({ action: 'attach' })).toEqual(['operationId: attach needs operationId']);
    expect(issues({ action: 'stop' })).toEqual(['operationId: stop needs operationId']);
    expect(issues({ action: 'status', operationId: 'op-status-0001' })).toEqual(['operationId: operationId does not apply to status']);
    expect(issues({ action: 'attach', operationId: 'op-attach-0001' })).toEqual([]);
    expect(issues({ action: 'status' })).toEqual([]);
  });

  it('attach, stop and status take no cursor and no page size', () => {
    // RED against: deleting the cursor or the limit branch.
    for (const action of ['attach', 'stop', 'status']) {
      const op = action === 'status' ? {} : { operationId: 'op-door-00001' };
      expect(issues({ action, ...op, cursor: 'c' })).toContain(`cursor: cursor does not apply to ${action}`);
      expect(issues({ action, ...op, limit: 5 })).toEqual([`limit: limit does not apply to ${action}`]);
    }
  });

  it('never takes a client: the client is the session’s own', () => {
    // RED against: dropping `.strict()`, which would let a model name a client.
    expect(issues({ action: 'attach', operationId: 'op-attach-0002', client: 'pi' })).toEqual([expect.stringMatching(/Unrecognized key.*client/)]);
  });

  it('keeps read and ack exactly as they were', () => {
    expect(issues({ action: 'ack', operationId: 'op-ack-000001' })).toEqual(['cursor: ack needs cursor']);
    expect(issues({ action: 'read', operationId: 'op-read-00001' })).toEqual(['operationId: operationId does not apply to read']);
  });
});

describe('leader_events with no delivery path to reach (#450, T-2)', () => {
  it.each(['attach', 'stop', 'status'])('%s answers not connected, and says where to look', async (action) => {
    // RED against: inverting `if (!leaderControl || sessionKey === undefined)`.
    const { control, keys } = port({});
    for (const ctx of [{}, { leaderControl: control }, { sessionKey: 'session-a' }]) {
      const result = await call({ action }, ctx);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('leader_events is not connected');
      expect(text(result)).toContain('nothing was read, acknowledged, attached or detached');
      expect(text(result)).toContain('Call `health`');
    }
    expect(keys).toEqual([]);
  });

  it('acts for the calling session and never writes its key into the answer', async () => {
    const { control, keys } = port({ attach: { ok: true, action: 'attach', outcome: 'attached', status: attached } });
    const result = await call({ action: 'attach', operationId: 'op-attach-0003' }, { leaderControl: control, sessionKey: 'session-key-secret' });
    expect(keys).toEqual(['session-key-secret']);
    expect(JSON.stringify(result)).not.toContain('session-key-secret');
  });
});

describe('leader_events door headlines (#450, T-3)', () => {
  const withPort = (answers: Parameters<typeof port>[0], args: Record<string, unknown>) =>
    call(args, { leaderControl: port(answers).control, sessionKey: 'k' });

  it('status: attached, attached with a blocker, another client attached, not attached, cannot push, unavailable', async () => {
    // RED against: swapping any two headline strings.
    expect(firstLine(await withPort({ status: attached }, { action: 'status' }))).toBe('This session is attached as the project leader (Claude Code); events are pushed to it.');
    expect(firstLine(await withPort({ status: { ...attached, blocker: { code: 'x', message: 'Waiting.', fix: 'Wait.' } } }, { action: 'status' }))).toBe(
      'This session is attached as the project leader (Claude Code); events are pushed to it. Blocked: Waiting. Fix: Wait.',
    );
    expect(firstLine(await withPort({ status: { ...attached, leader: { client: 'opencode', state: 'attached' }, self: { client: 'claude-code', isOwner: true, attached: false } } }, { action: 'status' }))).toBe(
      'An OpenCode leader is attached to this project, not this session; events are pushed to it, not to you.',
    );
    expect(firstLine(await withPort({ status: { ...attached, leader: { client: 'pi', state: 'attached' }, self: { client: 'claude-code', isOwner: true, attached: false } } }, { action: 'status' }))).toBe(
      'A pi leader is attached to this project, not this session; events are pushed to it, not to you.',
    );
    expect(firstLine(await withPort({ status: detached }, { action: 'status' }))).toBe(
      'This session is not attached, so events are not pushed to it. Call leader_events with action attach; until then, read events with leader_events.',
    );
    const cannot = { ...detached, canPush: false, pushUnavailable: { code: 'hosted-mode' as const, message: 'Hosted.' } };
    expect(firstLine(await withPort({ status: cannot }, { action: 'status' }))).toBe('xezar cannot push events to this session: Hosted. Read events with leader_events.');
    const stopping = await withPort({ status: { available: false, reason: 'the MCP service for this project is stopping' } }, { action: 'status' });
    expect(firstLine(stopping)).toBe("xezar cannot answer for this project's event delivery: the MCP service for this project is stopping.");
    expect(stopping.structuredContent).toEqual({ available: false, reason: 'the MCP service for this project is stopping' });
  });

  it('attach and stop: each outcome, and a refusal as an error naming its message and fix', async () => {
    const op = { operationId: 'op-door-00002' };
    expect(firstLine(await withPort({ attach: { ok: true, action: 'attach', outcome: 'attached', status: attached } }, { action: 'attach', ...op }))).toBe(
      'Attached this session as the project leader (Claude Code). Events are pushed to it from now on; ack each pushed message with the cursor it names.',
    );
    expect(firstLine(await withPort({ attach: { ok: true, action: 'attach', outcome: 'already-attached', status: attached } }, { action: 'attach', ...op }))).toBe(
      'This session is already attached as the project leader (Claude Code); nothing changed.',
    );
    expect(firstLine(await withPort({ stop: { ok: true, action: 'stop', outcome: 'stopped', status: detached } }, { action: 'stop', ...op }))).toBe(
      'Detached this session. Events are kept in the journal and no longer pushed; read them with leader_events.',
    );
    expect(firstLine(await withPort({ stop: { ok: true, action: 'stop', outcome: 'already-stopped', status: detached } }, { action: 'stop', ...op }))).toBe('No leader is attached; nothing changed.');
    for (const action of ['attach', 'stop'] as const) {
      const refusal: McpLeaderDoorResult = { ok: false, action, code: 'hosted-mode', message: 'Hosted.', fix: 'Run locally.', blocker: null, status: detached };
      const result = await withPort({ [action]: refusal }, { action, ...op });
      expect(result.isError).toBe(true);
      expect(firstLine(result)).toBe(`Nothing was ${action === 'attach' ? 'attached' : 'detached'}: Hosted. Run locally.`);
      expect(text(result)).toContain('Leader setup: connected');
      expect(text(result)).not.toContain('Leader setup: attached');
      expect(result.structuredContent).toEqual(refusal);
    }
  });
});

describe('leader setup verification and restart recovery (#464 P3, ONB-04/13/14)', () => {
  it('advances only from a real call, to attach, to an attached-session replay check', async () => {
    // RED against: deleting `leaderSetupVerificationLine` from status/door/read, or marking status
    // alone as delivery verified.
    const detachedNow = { ...attached, leader: null, self: { client: 'claude-code' as const, isOwner: true, attached: false } };
    const statusPort = port({ status: detachedNow });
    expect(text(await call({ action: 'status' }, { leaderControl: statusPort.control, sessionKey: 's' }))).toContain(
      'Leader setup: connected',
    );

    const attachPort = port({
      status: attached,
      attach: { ok: true, action: 'attach', outcome: 'attached', status: attached },
    });
    expect(text(await call(
      { action: 'attach', operationId: 'op-onboard-attach-0001' },
      { leaderControl: attachPort.control, sessionKey: 's' },
    ))).toContain('Leader setup: attached');

    const dir = realpathSync(mkdtempSync('/tmp/xzle-onboard-'));
    const journal = EventJournal.open({ dataDir: dir, projectId: 'alpha', secretValues: [], warn: () => {} });
    const cursors = LeaderCursors.open({ dataDir: dir, projectId: 'alpha', journal, warn: () => {} });
    const leaderEvents = {
      journal,
      cursors,
      readState: (() => ({ latestSeq: journal.latestSeq, tasks: [], complete: true })) as StateReader,
      secretValues: [],
    };
    try {
      expect(text(await call(
        { action: 'read' },
        { leaderEvents, leaderControl: attachPort.control, sessionKey: 's' },
      ))).toContain('Leader setup: delivery verified');
    } finally {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns to connected after restart instead of trusting durable delivery counters', async () => {
    // RED against: promoting durable cursor counters after a restart, or saying an attachment
    // survives a process restart. The existing #450 push-delivery test holds the real lifecycle;
    // this pins the leader-facing report after it.
    const afterRestart: McpLeaderSelfStatus = {
      ...attached,
      leader: null,
      delivery: { state: 'idle', deliveredSeq: 7, ackedSeq: 7, reactedSeq: 7, latestSeq: 7 },
      self: { client: 'claude-code', isOwner: true, attached: false },
    };
    const restarted = port({ status: afterRestart });
    const result = await call({ action: 'status' }, { leaderControl: restarted.control, sessionKey: 'new-session' });
    expect(text(result)).toContain('Leader setup: connected');
    expect(text(result)).not.toContain('Leader setup: delivery verified');
    expect(firstLine(result)).toContain('not attached');
  });
});

/**
 * #460 § 4 (T-11, T-12) — the compaction recovery, over the REAL journal and the REAL cursors. A
 * compacted leader is told to call `read` with no cursor, so these cases pin what that call answers:
 * every retained row that was never acknowledged, in order, paged, with stable ids; an honest error
 * or gap for a cursor it cannot serve; and an honest empty answer when there is nothing. Delivery is
 * at-least-once WITHIN RETAINED DURABLE STATE, so "we could not find it" and "there is nothing" must
 * never read the same.
 */
describe('#460 § 4 — reading after a compaction, over a real journal', () => {
  const dirs: string[] = [];
  const journals: EventJournal[] = [];

  afterEach(() => {
    for (const journal of journals.splice(0)) journal.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** One project's journal, cursors and a stub state reader — the three parts the tool composes. */
  function wired(projectId = 'alpha', now?: () => number) {
    const dataDir = realpathSync(mkdtempSync('/tmp/xzle-'));
    dirs.push(dataDir);
    const journal = EventJournal.open({ dataDir, projectId, secretValues: [], warn: () => {}, ...(now ? { now } : {}) });
    journals.push(journal);
    const cursors = LeaderCursors.open({ dataDir, projectId, journal, warn: () => {} });
    const readState: StateReader = () => ({ latestSeq: journal.latestSeq, tasks: [], complete: true });
    return { dataDir, journal, cursors, leaderEvents: { journal, cursors, readState, secretValues: [] } };
  }

  const row = (n: number): McpJournalAppendInput => ({
    category: 'E-01',
    kind: 'task.terminal',
    subject: { type: 'run', id: `run-${n}`, version: null },
    origin: 'system',
    causedBy: null,
    summary: `task ${n} finished`,
  });

  interface ReadOut {
    status: 'ok';
    events: Array<{ eventId: string; journalSeq: number }>;
    nextCursor: string;
    hasMore: boolean;
    position: { deliveredSeq: number; ackedSeq: number };
  }
  interface GapOut {
    status: 'gap';
    gap: { oldestSeq: number | null; latestSeq: number; resumeCursor: string; recovery: { required: string } };
  }

  const read = async (leaderEvents: unknown, args: Record<string, unknown> = {}): Promise<McpToolResult> =>
    call({ action: 'read', ...args }, { leaderEvents });

  it('replays every retained unacknowledged row, paged, and only ack moves the acknowledgement', async () => {
    // RED against: advancing the ack on a read or on transport receipt (`markDelivered` → `ack`),
    // and against dropping the page bound so one answer returns every row with no `nextCursor`.
    const { journal, cursors, leaderEvents } = wired();
    for (let n = 1; n <= MCP_JOURNAL_PAGE_ROWS + 50; n++) journal.append(row(n));

    // The compaction recovery itself: no cursor, so it starts from the last explicit acknowledgement.
    const first = (await read(leaderEvents)).structuredContent as unknown as ReadOut;
    expect(first.status).toBe('ok');
    expect(first.events).toHaveLength(MCP_JOURNAL_PAGE_ROWS);
    expect(first.events[0]!.journalSeq).toBe(1);
    expect(first.hasMore).toBe(true);
    // Handing the rows over is delivery, never acknowledgement.
    expect(first.position).toMatchObject({ deliveredSeq: MCP_JOURNAL_PAGE_ROWS, ackedSeq: 0 });

    // `hasMore` is exhausted through `nextCursor`, and the page bound is what ends each page.
    const second = (await read(leaderEvents, { cursor: first.nextCursor })).structuredContent as unknown as ReadOut;
    expect(second.events).toHaveLength(50);
    expect(second.hasMore).toBe(false);
    expect(second.events[0]!.journalSeq).toBe(MCP_JOURNAL_PAGE_ROWS + 1);
    expect(second.position.ackedSeq).toBe(0);

    // Until it is acknowledged, the same read answers the same ids — that is the at-least-once the
    // leader deduplicates against, and it is why a compacted leader loses nothing.
    const again = (await read(leaderEvents)).structuredContent as unknown as ReadOut;
    expect(again.events.map((event) => event.eventId)).toEqual(first.events.map((event) => event.eventId));

    // Only `ack` moves it: cumulative, monotonic and idempotent.
    const acked = await call({ action: 'ack', cursor: second.nextCursor, operationId: 'op-ack-460-001' }, { leaderEvents });
    expect(acked.structuredContent).toMatchObject({ status: 'acked', ackedSeq: MCP_JOURNAL_PAGE_ROWS + 50 });
    expect((await call({ action: 'ack', cursor: second.nextCursor, operationId: 'op-ack-460-002' }, { leaderEvents })).structuredContent)
      .toMatchObject({ status: 'no-op', ackedSeq: MCP_JOURNAL_PAGE_ROWS + 50 });
    expect((await call({ action: 'ack', cursor: first.nextCursor, operationId: 'op-ack-460-003' }, { leaderEvents })).structuredContent)
      .toMatchObject({ status: 'no-op', ackedSeq: MCP_JOURNAL_PAGE_ROWS + 50 });
    expect(cursors.position().ackedSeq).toBe(MCP_JOURNAL_PAGE_ROWS + 50);

    // Acknowledged rows are not replayed by default…
    const done = (await read(leaderEvents)).structuredContent as unknown as ReadOut;
    expect(done.events).toEqual([]);
    // …and a retained earlier cursor rewinds the READ only, never the acknowledgement.
    const rewound = (await read(leaderEvents, { cursor: first.nextCursor })).structuredContent as unknown as ReadOut;
    expect(rewound.events[0]!.journalSeq).toBe(MCP_JOURNAL_PAGE_ROWS + 1);
    expect(rewound.position.ackedSeq).toBe(MCP_JOURNAL_PAGE_ROWS + 50);
  });

  it('answers an expired, foreign or malformed cursor honestly, and an empty journal honestly too', async () => {
    // RED against: answering a cursor it cannot serve with an empty page — "we lost your rows" and
    // "nothing happened" would then read the same, which is the one thing a gap exists to prevent.
    const empty = wired();
    const nothing = (await read(empty.leaderEvents)).structuredContent as unknown as ReadOut;
    expect(nothing).toMatchObject({ status: 'ok', events: [], hasMore: false });
    expect((await read(empty.leaderEvents)).content[0]!.text).toContain('No outstanding events.');

    // Malformed: refused outright, and the answer says nothing was read.
    for (const cursor of ['not-a-cursor', Buffer.from('{}', 'utf8').toString('base64url')]) {
      const refused = await read(empty.leaderEvents, { cursor });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toEqual({ error: 'invalid_cursor', message: expect.any(String) });
      expect(text(refused)).toContain('Nothing was read.');
    }
    // The same cursor through `ack` says nothing was acknowledged, and moves nothing.
    const badAck = await call({ action: 'ack', cursor: 'not-a-cursor', operationId: 'op-ack-460-004' }, { leaderEvents: empty.leaderEvents });
    expect(badAck.isError).toBe(true);
    expect(text(badAck)).toContain('Nothing was acknowledged.');
    expect(empty.cursors.position().ackedSeq).toBe(0);

    // Foreign: another project's cursor is refused before this journal's contents are consulted.
    const other = wired('bravo');
    other.journal.append(row(1));
    const foreign = ((await read(other.leaderEvents)).structuredContent as unknown as ReadOut).nextCursor;
    const crossed = await read(empty.leaderEvents, { cursor: foreign });
    expect(crossed.isError).toBe(true);
    expect(crossed.structuredContent).toEqual({ error: 'cursor_project_mismatch', message: expect.any(String) });
    expect(JSON.stringify(crossed)).not.toContain('bravo');

    // Expired: retention evicted the rows the cursor asked for, so it is an EXPLICIT gap with the
    // current state beside it and a `resumeCursor` to continue from — never a silent empty page.
    let now = Date.parse('2026-09-01T00:00:00.000Z');
    const aged = wired('charlie', () => now);
    for (let n = 1; n <= MCP_JOURNAL_RETAINED_ROWS; n++) aged.journal.append(row(n));
    // A cursor that points AT a row retention later evicted — rows #2 and #3 are what it still owes.
    const early = ((await read(aged.leaderEvents, { limit: 1 })).structuredContent as unknown as ReadOut).nextCursor;
    now += (MCP_JOURNAL_MIN_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1_000;
    aged.journal.append(row(MCP_JOURNAL_RETAINED_ROWS + 1));
    aged.journal.append(row(MCP_JOURNAL_RETAINED_ROWS + 2));
    expect(aged.journal.oldestSeq).toBe(3);
    const gapResult = await read(aged.leaderEvents, { cursor: early });
    expect(gapResult.isError).toBeFalsy();
    expect(text(gapResult)).toMatch(/^GAP: /);
    const gap = gapResult.structuredContent as unknown as GapOut;
    expect(gap).toMatchObject({ status: 'gap', gap: { oldestSeq: 3, recovery: { required: 'current-state' } } });
    expect(gap).not.toHaveProperty('events');
    // Recovery: the resume cursor is a real one, and acknowledging it is what continues.
    const resumed = (await read(aged.leaderEvents, { cursor: gap.gap.resumeCursor })).structuredContent as unknown as ReadOut;
    expect(resumed.events[0]!.journalSeq).toBe(3);
  });
});
