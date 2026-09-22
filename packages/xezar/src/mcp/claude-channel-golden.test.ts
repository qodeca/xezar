import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { McpJournalRow } from '@qodeca/xezar-contract';

import { channelMeta, renderChannelContent } from './adapters/claude-code.ts';
import { runBridge } from './bridge.ts';
import { LineFramer, encodeFrame } from './ipc.ts';
import { CHANNEL_INCOMPATIBLE_PROTOCOL_VERSION } from './protocol.ts';
import { listenMcpSocket, type McpSessionTransport } from './service.ts';
import { tools } from './tools/index.ts';

/**
 * #886 — the channel contract with Claude Code, pinned against what a REAL Claude Code sends and
 * consumes rather than against our own reading of it. The fixture holds the `initialize` request a
 * live Claude Code 2.1.280 sent to this bridge (captured from the bridge's stdio in an isolated run)
 * and the notification schema read out of the same binary. The service, the bridge and the channel
 * rendering are the production ones; only the event controller is stood in for, by calling the
 * session transport the service hands the delivery seam, which is what `LeaderDelivery` does.
 *
 * P5: if the bridge stops advertising the channel, negotiates the revision Claude Code refuses a
 * channel over, renames the method, or writes a `params`/`meta` shape Claude Code does not parse,
 * one of these cases goes red.
 */

const FIXTURE = JSON.parse(readFileSync(new URL('./__fixtures__/claude-code-channel-2.1.280.json', import.meta.url), 'utf8')) as {
  claudeCodeVersion: string;
  initializeRequest: { method: string; params: { protocolVersion: string; clientInfo: { name: string; version: string } } };
  consumer: { method: string; metaKeyPattern: string };
};

/** Claude Code 2.1.280's own consumer schema, restated strictly: an extra key is a drift we want to see. */
const claudeChannelNotification = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.literal(FIXTURE.consumer.method),
  params: z.strictObject({
    content: z.string().min(1),
    meta: z.record(z.string().regex(new RegExp(FIXTURE.consumer.metaKeyPattern)), z.string()).optional(),
  }),
});

let home: string;
const handles: Array<{ close(): void }> = [];
beforeEach(() => {
  home = mkdtempSync('/tmp/xz886-');
});
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  rmSync(home, { recursive: true, force: true });
});

function row(journalSeq: number): McpJournalRow {
  return {
    eventId: `alpha:${journalSeq}`, journalSeq, ts: '2026-09-22T20:47:00.000Z', projectId: 'alpha', category: 'E-01', kind: 'task.done',
    subject: { type: 'run', id: 'r1', version: '3' }, origin: 'system', causedBy: null, summary: 'a task finished',
  };
}

/**
 * This tree's service answering `session/open` the way a canPush service does. It pins the bridge's
 * side of the channel contract (P5) — not the older-service pairing: that is P4, below, against what
 * the published 0.18.0 service really sent (#890 review, finding 2).
 */
async function world() {
  const root = join(home, 'alpha');
  mkdirSync(root);
  let transport: McpSessionTransport | undefined;
  const handle = await listenMcpSocket({
    project: { id: 'alpha', name: 'Alpha', root },
    version: 'this-tree',
    tools: [],
    env: { XEZ_HOME: home },
    sessions: { opened: (_key, t) => { transport = t; }, closed: () => {}, pushCapability: () => ({ canPush: true }) },
  });
  handles.push(handle);
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<Record<string, unknown>> = [];
  const framer = new LineFramer((line) => messages.push(JSON.parse(line) as Record<string, unknown>), () => {});
  output.on('data', (c: Buffer) => framer.push(c));
  const done = runBridge({
    input, output, version: '0.19.0-test', tools: [],
    resolveTarget: async () => ({ kind: 'socket', path: handle.path, project: { id: 'alpha', name: 'Alpha' } }),
  });
  const until = async <T>(what: string, fn: () => T | undefined): Promise<T> => {
    for (let i = 0; i < 200; i++) {
      const v = fn();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  return { input, messages, done, until, transport: () => transport };
}

describe(`the Claude Code channel contract, against a real Claude Code ${FIXTURE.claudeCodeVersion} (#886)`, () => {
  it('answers the captured initialize with the channel capability and a revision Claude Code delivers over', async () => {
    // RED against: dropping `experimental["claude/channel"]` (Claude Code logs "server did not declare
    // claude/channel capability"), or negotiating 2026-07-28 (no unsolicited notification path).
    const w = await world();
    w.input.write(encodeFrame(FIXTURE.initializeRequest));
    const init = await w.until('the initialize answer', () => w.messages.find((m) => m.id === 0)) as { result: { protocolVersion: string; capabilities: Record<string, unknown> } };
    expect(init.result.capabilities).toMatchObject({ experimental: { 'claude/channel': {} } });
    expect(init.result.capabilities).not.toHaveProperty(['experimental', 'claude/channel/permission']);
    expect(init.result.protocolVersion).toBe(FIXTURE.initializeRequest.params.protocolVersion);
    expect(init.result.protocolVersion).not.toBe(CHANNEL_INCOMPATIBLE_PROTOCOL_VERSION);
    w.input.end();
    await w.done;
  });

  it('writes a pushed event as exactly the notification Claude Code parses', async () => {
    // RED against: a renamed method, a non-string meta value, a meta key Claude Code drops, or any
    // extra field in params — each fails the consumer schema restated from the 2.1.280 binary.
    const w = await world();
    w.input.write(encodeFrame(FIXTURE.initializeRequest));
    await w.until('the initialize answer', () => w.messages.find((m) => m.id === 0));
    const transport = await w.until('the owner transport', () => w.transport());
    expect(transport).toMatchObject({ clientName: 'claude-code', leaderPush: true });
    const dispatch = { projectId: 'alpha', events: [row(9769), row(9770)], nextCursor: 'cursor-9770', omittedRoutineCount: 2 };
    await transport.push(renderChannelContent(dispatch, dispatch.events, 'ROLE'), channelMeta(dispatch, dispatch.events));
    const frame = await w.until('the channel frame', () => w.messages.find((m) => m.method === FIXTURE.consumer.method));
    const parsed = claudeChannelNotification.safeParse(frame);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(frame).not.toHaveProperty('id');
    expect(parsed.data?.params.meta).toMatchObject({ source_app: 'xezar', project_id: 'alpha', first_seq: '9769', last_seq: '9770', next_cursor: 'cursor-9770', omitted_routine_count: '2' });
    expect(parsed.data?.params.content).toContain('alpha:9770');
    w.input.end();
    await w.done;
  });
});

// ---- P4: this tree's bridge against the published 0.18.0 service --------------------------------

/**
 * #886 P4 (#890 review, finding 2). The wire exchange between a published @qodeca/xezar 0.18.0 service
 * and a source bridge fronting Claude Code, CAPTURED from the real service (provenance inside the
 * file), not produced by this tree's `listenMcpSocket` with an older version string. A replay server
 * answers the bridge with exactly what 0.18.0 answered, refuses a foreign protocol version and an
 * unknown method with 0.18.0's own recorded refusals, and sends 0.18.0's own `leader/push`. The file
 * is pinned by hash, so it cannot be edited to agree with a future bridge.
 *
 * RED against, among others: bumping `IPC_PROTOCOL_VERSION` (0.18.0 refuses it), the bridge requiring
 * a `session/open` field 0.18.0 never sends before it registers the channel, a `leader/push` shape the
 * bridge no longer accepts, or the bridge sending 0.18.0 anything the capture did not cover.
 */
const WIRE_FILE = new URL('./__fixtures__/xezar-service-0.18.0-wire.json', import.meta.url);
const WIRE_SHA256 = '20d9fb7ad4ae67b4f84ca17d4185fe411360dd34e9e684bcba8612d890050cb9';
type WireFrame = Record<string, unknown> & { v: number; id: number; method?: string; params?: Record<string, unknown> };
const WIRE = JSON.parse(readFileSync(WIRE_FILE, 'utf8')) as {
  ipcVersion: number;
  exchange: Array<{ request: WireFrame; response: WireFrame & { result?: unknown } }>;
  push: { request: WireFrame & { params: { content: string; meta: Record<string, string> } }; reply: WireFrame };
  refusals: { versionMismatch: { response: WireFrame }; unknownMethod: { response: WireFrame } };
};
/** The methods a 0.18.0 service serves; anything else it refuses as `unknown-method` (recorded). */
const SERVED_BY_0_18_0 = new Set(['session/open', 'health', 'tools/call']);

/** What the bridge sent, minus its own version string: what 0.18.0 actually reads. */
const sent = (f: WireFrame): unknown => ({ v: f.v, method: f.method, params: f.params });

async function replay018() {
  const path = join(home, 'svc-0.18.0.sock');
  const script = WIRE.exchange.slice();
  const unexpected: unknown[] = [];
  const replies: WireFrame[] = [];
  let conn: Socket | undefined;
  const server = createServer((socket) => {
    conn = socket;
    const answer = (to: WireFrame, frame: WireFrame): void => void socket.write(encodeFrame({ ...frame, id: to.id }));
    socket.on('data', (c: Buffer) => framer.push(c));
    const framer = new LineFramer((line) => {
      const f = JSON.parse(line) as WireFrame;
      if (f.method === undefined) { replies.push(f); return; } // the bridge answering our leader/push
      if (f.v !== WIRE.ipcVersion) { answer(f, WIRE.refusals.versionMismatch.response); return; }
      if (!SERVED_BY_0_18_0.has(f.method)) {
        const refusal = WIRE.refusals.unknownMethod.response as WireFrame & { error: { code: string } };
        answer(f, { ...refusal, error: { code: refusal.error.code, message: `unknown method: ${f.method}` } });
        return;
      }
      const next = script[0];
      if (next === undefined || JSON.stringify(sent(f)) !== JSON.stringify(sent(next.request))) {
        unexpected.push(sent(f));
        answer(f, { v: WIRE.ipcVersion, id: f.id, ok: false, error: { code: 'internal', message: 'not in the 0.18.0 capture' } } as WireFrame);
        return;
      }
      script.shift();
      answer(f, next.response);
    }, () => {});
  });
  await new Promise<void>((r) => server.listen(path, r));
  handles.push({ close: () => { conn?.destroy(); server.close(); } });
  return {
    path, unexpected, replies,
    remaining: () => script.length,
    push: () => conn?.write(encodeFrame(WIRE.push.request)),
  };
}

describe('a bridge from this tree against the published xezar 0.18.0 service (#886 P4)', () => {
  it('replays a capture nobody has edited', () => {
    // RED against: changing the captured 0.18.0 answers to agree with a newer bridge.
    expect(createHash('sha256').update(readFileSync(WIRE_FILE)).digest('hex')).toBe(WIRE_SHA256);
  });

  it('opens its session, registers the channel, relays every tool answer and delivers 0.18.0’s own push', async () => {
    const svc = await replay018();
    const input = new PassThrough();
    const output = new PassThrough();
    const messages: Array<Record<string, unknown>> = [];
    const framer = new LineFramer((line) => messages.push(JSON.parse(line) as Record<string, unknown>), () => {});
    output.on('data', (c: Buffer) => framer.push(c));
    const done = runBridge({
      input, output, version: '0.19.0-test', tools,
      resolveTarget: async () => ({ kind: 'socket', path: svc.path, project: { id: 'project', name: 'project' } }),
    });
    const until = async <T>(what: string, fn: () => T | undefined): Promise<T> => {
      for (let i = 0; i < 300; i++) {
        const v = fn();
        if (v !== undefined) return v;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for ${what}; unexpected requests: ${JSON.stringify(svc.unexpected)}`);
    };
    let next = 100;
    const call = async (args: Record<string, unknown>) => {
      const id = ++next;
      input.write(encodeFrame({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'leader_events', arguments: args } }));
      return (await until(`the ${String(args.action)} answer`, () => messages.find((m) => m.id === id))) as { result?: unknown; error?: unknown };
    };
    const recorded = (i: number) => WIRE.exchange[i]!.response.result;

    input.write(encodeFrame(FIXTURE.initializeRequest));
    const init = await until('the initialize answer', () => messages.find((m) => m.id === 0)) as { result: { capabilities: Record<string, unknown> } };
    // 0.18.0 answered `{owner: true, canPush: true}`: the bridge registers the channel on it.
    expect(init.result.capabilities).toMatchObject({ experimental: { 'claude/channel': {} } });
    input.write(encodeFrame({ jsonrpc: '2.0', method: 'notifications/initialized' }));

    expect((await call({ action: 'status' })).result).toEqual(recorded(1));
    expect((await call({ action: 'attach', operationId: 'op-886-capture-attach' })).result).toEqual(recorded(2));
    expect((await call({ action: 'status' })).result).toEqual(recorded(3));

    svc.push();
    const frame = await until('the channel frame', () => messages.find((m) => m.method === FIXTURE.consumer.method));
    const parsed = claudeChannelNotification.safeParse(frame);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.params).toEqual(WIRE.push.request.params);
    const reply = await until('the push reply', () => svc.replies[0]);
    expect(reply).toEqual(WIRE.push.reply);

    const cursor = (WIRE.exchange[5]!.request.params as { arguments: { cursor: string } }).arguments.cursor;
    expect((await call({ action: 'read' })).result).toEqual(recorded(4));
    expect((await call({ action: 'ack', cursor, operationId: 'op-886-capture-ack' })).result).toEqual(recorded(5));
    expect((await call({ action: 'status' })).result).toEqual(recorded(6));

    expect(svc.unexpected).toEqual([]);
    expect(svc.remaining()).toBe(0);
    input.end();
    await done;
  });
});
