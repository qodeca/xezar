import type { McpLeaderDoorResult, McpLeaderSelfStatus } from '@qodeca/xezar-contract';
import { describe, expect, it } from 'vitest';

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
      expect(result.structuredContent).toEqual(refusal);
    }
  });
});
