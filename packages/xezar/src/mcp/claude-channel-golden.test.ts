import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
 * The production service answering `session/open` the way a canPush service does — the same answer the
 * installed 0.18.0 service gives (`{owner: true, canPush: true}`), so this also pins P4: a bridge from
 * this tree against that service registers the channel.
 */
async function world() {
  const root = join(home, 'alpha');
  mkdirSync(root);
  let transport: McpSessionTransport | undefined;
  const handle = await listenMcpSocket({
    project: { id: 'alpha', name: 'Alpha', root },
    version: '0.18.0',
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
