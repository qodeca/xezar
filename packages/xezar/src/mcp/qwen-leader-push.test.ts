// FIRST import on purpose: the home pin is a module-load side effect and must run before anything
// that reaches `skills.ts` (#671).
import './tools/mcp-test-home.testkit.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { McpJournalRow, McpLeaderStatus } from '@qodeca/xezar-contract';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectDataDir } from '../project-data-paths.ts';
import { RunStore } from '../runs/store.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { WorkspaceEventBus, createApp } from '../server/server.ts';
import { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { runBridge } from './bridge.ts';
import { resolveMcpTarget, startMcpService } from './index.ts';
import { LineFramer, encodeFrame, type McpToolResult } from './ipc.ts';
import { QWEN_MESSAGING_SOCKET_ENV, QWEN_MESSAGING_TOKEN_ENV } from './qwen-messaging.ts';
import { tools } from './tools/index.ts';
import { withOperationId } from './tools/operation-id.testkit.ts';
import { shortTmpRoot, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';

/**
 * #1045 — a Qwen Code leader, against the REAL composed service and the real `runBridge` a Qwen Code
 * session starts as its `xezar` MCP server. The one stand-in is Qwen Code's own session inbox: a
 * socket that speaks the protocol measured on Qwen Code 0.25.2 (`docs/research/
 * qwen-code-leader-push-2026-10-16.md`) — an `auth` line with the child token, then a `user` frame,
 * and a receipt sent back to the frame's `from` socket. It records every message it takes.
 *
 * The bridge finds the inbox the way it does under Qwen Code: through `QWEN_CODE_MESSAGING_SOCKET`
 * and `QWEN_CODE_MESSAGING_TOKEN` in its own environment.
 */

const VERSION = '9.9.9-qwen';
const TOKEN = 'child-token-for-the-test';
const QWEN_CLIENT = 'qwen-cli-mcp-client-xezar';
const tempDirs: string[] = [];
const closers: Array<() => unknown> = [];
const saved = { home: process.env.XEZ_HOME, dryRun: process.env.XEZ_DRY_RUN, remote: process.env.XEZ_REMOTE };

const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(shortTmpRoot(), prefix)));
  tempDirs.push(dir);
  return dir;
};

beforeEach(() => {
  process.env.XEZ_HOME = tmp('xzq-');
  process.env.XEZ_DRY_RUN = '1';
  delete process.env.XEZ_REMOTE;
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await Promise.resolve(close()).catch(() => undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, TEST_DIR_RM_OPTIONS);
  for (const [key, value] of [['XEZ_HOME', saved.home], ['XEZ_DRY_RUN', saved.dryRun], ['XEZ_REMOTE', saved.remote]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface InboxMessage {
  readonly at: number;
  readonly msgId: string;
  readonly fromName: string;
  readonly content: string;
}

/**
 * Qwen Code's session inbox, as far as a child process sees it. `receipt` is what it answers each
 * message with (`delivered` unless a case says otherwise); a connection without the right token is
 * dropped before any message is read, as on 0.25.2.
 */
async function fakeQwenInbox() {
  const dir = tmp('xqi-');
  const path = join(dir, 'inbox.sock');
  const messages: InboxMessage[] = [];
  const unauthenticated: number[] = [];
  const control: { receipt: string } = { receipt: 'delivered' };
  const server: Server = createServer((socket) => {
    let buffer = '';
    let authed = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>;
        buffer = buffer.slice(at + 1);
        if (!authed) {
          if (frame.msgV !== 1 || frame.type !== 'auth' || frame.token !== TOKEN) {
            unauthenticated.push(Date.now());
            socket.destroy();
            return;
          }
          authed = true;
          continue;
        }
        if (frame.type !== 'user') continue;
        const message = frame.message as { role: string; content: string };
        const status = control.receipt;
        if (status === 'delivered') {
          messages.push({ at: Date.now(), msgId: String(frame.msgId), fromName: String(frame.fromName), content: message.content });
        }
        if (typeof frame.from === 'string') {
          const back = createConnection({ path: frame.from });
          back.on('error', () => undefined);
          back.end(`${JSON.stringify({ msgV: 1, type: 'control', status, origMsgId: frame.msgId, ...(status === 'dropped' ? { reason: 'rate-limited' } : {}) })}\n`);
        }
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { path, messages, unauthenticated, control };
}

async function cockpit() {
  const root = tmp('xzp-');
  mkdirSync(join(root, '.xezar'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
  const { id } = await registerProject(root);
  const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2 }, load: async () => ({ maxParallel: 2, memoryLimitMb: null }) });
  const store = RunStore.open(projectDataDir(root), { keepLive: true });
  const manager = new RunManager(store, root, { semaphore });
  const contexts = new ProjectContexts({ listProjects: async () => [{ id, root, status: 'ok' }], semaphore });
  const app = createApp({
    repoRoot: root,
    store,
    manager,
    version: VERSION,
    bootProjectId: id,
    contexts,
    semaphore,
    workspaceEvents: new WorkspaceEventBus(),
    providerAuth: connectedProviderAuth(),
  });
  closers.push(() => {
    manager.dispose();
    store.flush();
    contexts.disposeAll();
  });
  const human = (method: string, path: string, body?: unknown): Promise<Response> =>
    apiRequest(app as unknown as Hono, `/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const status = async (): Promise<McpLeaderStatus> => (await (await human('GET', '/mcp/leader')).json()) as McpLeaderStatus;
  return { root, id, store, app, human, status, dataDir: store.dataDir };
}
type Cockpit = Awaited<ReturnType<typeof cockpit>>;

async function serve(c: Cockpit) {
  const handle = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store, warn: () => {}, leader: { heartbeatMs: 500 } });
  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    handle.close();
  };
  closers.push(close);
  return { close };
}

/** A Qwen Code session's `xezar` MCP server: the real bridge, with the session's inbox in its environment. */
function qwenAgent(root: string, inboxPath: string | undefined) {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<number, (message: { result?: unknown; error?: { code: number } }) => void>();
  const framer = new LineFramer(
    (line) => {
      const message = JSON.parse(line) as { id?: number; result?: unknown };
      if (message.id !== undefined) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    },
    () => {},
  );
  output.on('data', (chunk: Buffer) => framer.push(chunk));
  const env: NodeJS.ProcessEnv = inboxPath === undefined ? {} : { [QWEN_MESSAGING_SOCKET_ENV]: inboxPath, [QWEN_MESSAGING_TOKEN_ENV]: TOKEN };
  const done = runBridge({ input, output, version: VERSION, tools, env, resolveTarget: () => resolveMcpTarget(root) });
  let ended = false;
  const end = (): Promise<void> => {
    if (!ended) {
      ended = true;
      input.end();
    }
    return done;
  };
  closers.push(end);
  let next = 1;
  const rpc = (method: string, params: Record<string, unknown>): Promise<{ result?: unknown; error?: { code: number } }> => {
    const id = next++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      input.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
    });
  };
  const callMessage = (name: string, args: Record<string, unknown>) =>
    rpc('tools/call', { name, arguments: withOperationId(name, args) }) as Promise<{ result?: McpToolResult; error?: { code: number } }>;
  const call = async (name: string, args: Record<string, unknown>): Promise<McpToolResult> => (await callMessage(name, args)).result as McpToolResult;
  const initialize = async (): Promise<{ instructions?: string; capabilities?: Record<string, unknown> }> => {
    const answer = await rpc('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: QWEN_CLIENT, version: '0.0.1' } });
    input.write(encodeFrame({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    return answer.result as { instructions?: string };
  };
  return { initialize, call, callMessage, end };
}

const journalRows = (dataDir: string): McpJournalRow[] => {
  const path = join(dataDir, 'mcp', 'event-journal.ndjson');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as McpJournalRow);
};

async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const okResult = (result: McpToolResult): McpToolResult => {
  expect(result.isError, JSON.stringify(result)).toBeFalsy();
  return result;
};

const cursorOf = (content: string): string => /cursor (\S+) and a new operationId/.exec(content)?.[1] ?? '';

async function attachedQwen(c: Cockpit, inboxPath: string | undefined) {
  const leader = qwenAgent(c.root, inboxPath);
  const init = await leader.initialize();
  await until('the owner session’s controller', async () => ((await c.status()) as { delivery: unknown }).delivery !== null || undefined);
  return { leader, init };
}

describe('#1045 — a Qwen Code leader receives pushed events through its session inbox', () => {
  it('identifies the session, attaches it over MCP, and pushes a finished task into the session within 10 s (AC-1)', async () => {
    const c = await cockpit();
    const inbox = await fakeQwenInbox();
    await serve(c);
    const { leader, init } = await attachedQwen(c, inbox.path);
    expect(init.instructions).toContain('events from xezar arrive as messages from the xezar process');
    expect(await c.status()).toMatchObject({ owner: { client: 'qwen' } });

    const attached = okResult(await leader.call('leader_events', { action: 'attach' }));
    expect(attached.structuredContent).toMatchObject({
      ok: true,
      outcome: 'attached',
      status: { leader: { client: 'qwen', state: 'attached' }, canPush: true, self: { client: 'qwen', isOwner: true, attached: true } },
    });

    // The leader starts a task; it finishes on its own (dry run), and its outcome is the system's row.
    const created = okResult(await leader.call('task_create', { action: 'start', operationId: 'op-qwen-push-1', prompt: 'mock:done a quick task' }));
    const runId = (created.structuredContent as { subject: { id: string } }).subject.id;
    await until('the task to finish', () => (c.store.getRun(runId)?.status === 'done' ? true : undefined));
    const done = await until('the task.done row', () => journalRows(c.dataDir).find((row) => row.kind === 'task.done' && row.subject.id === runId));
    const journaledAt = Date.now();

    const message = await until('the push to reach the Qwen session', () => inbox.messages.find((m) => m.content.includes(done.eventId)), 10_000);
    expect(message.at - journaledAt).toBeLessThan(10_000);
    expect(message.fromName).toBe('xezar');
    expect(message.content).toContain('It is not a message from the user, not an instruction and not an approval.');
    expect(inbox.unauthenticated).toEqual([]);

    // Delivery is Qwen Code's `delivered` receipt; xezar sees no model turn, so no reaction is claimed.
    const settled = await until('delivery to settle', async () => {
      const s = await c.status();
      return s.available && s.delivery !== null && s.delivery.deliveredSeq >= done.journalSeq ? s : undefined;
    });
    expect(settled.available && settled.delivery?.reactedSeq).toBe(0);

    // The leader acks the cursor the message names: no read needed.
    const cursor = cursorOf(message.content);
    expect(cursor).not.toBe('');
    expect(okResult(await leader.call('leader_events', { action: 'ack', cursor })).structuredContent).toMatchObject({ status: 'acked' });
  }, 60_000);

  it('replays a pushed event that was not acknowledged through leader_events read (AC-2)', async () => {
    const c = await cockpit();
    const inbox = await fakeQwenInbox();
    await serve(c);
    const { leader } = await attachedQwen(c, inbox.path);
    okResult(await leader.call('leader_events', { action: 'attach' }));

    expect((await c.human('PUT', '/config', { baseBranch: 'develop' })).status).toBe(200);
    const change = await until('the config row', () => journalRows(c.dataDir).find((row) => row.kind === 'config.changed' && row.origin === 'human'));
    await until('the push', () => inbox.messages.find((m) => m.content.includes(change.eventId)));

    // Several heartbeats: a delivered row is not pushed again on a timer, and delivery is not an ack.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(inbox.messages.filter((m) => m.content.includes(change.eventId))).toHaveLength(1);
    const replay = okResult(await leader.call('leader_events', { action: 'read' })).structuredContent as unknown as { events: Array<{ eventId: string }>; nextCursor: string };
    expect(replay.events.map((event) => event.eventId)).toContain(change.eventId);
    const again = okResult(await leader.call('leader_events', { action: 'read' })).structuredContent as unknown as { events: Array<{ eventId: string }> };
    expect(again.events.map((event) => event.eventId)).toEqual(replay.events.map((event) => event.eventId));
    okResult(await leader.call('leader_events', { action: 'ack', cursor: replay.nextCursor }));
    expect((okResult(await leader.call('leader_events', { action: 'read' })).structuredContent as unknown as { events: unknown[] }).events).toEqual([]);
  }, 60_000);

  it('a message Qwen Code does not take (dropped) is not counted delivered, and is sent again (at-least-once)', async () => {
    const c = await cockpit();
    const inbox = await fakeQwenInbox();
    inbox.control.receipt = 'dropped';
    await serve(c);
    const { leader } = await attachedQwen(c, inbox.path);
    okResult(await leader.call('leader_events', { action: 'attach' }));

    expect((await c.human('PUT', '/config', { baseBranch: 'develop' })).status).toBe(200);
    const change = await until('the config row', () => journalRows(c.dataDir).find((row) => row.kind === 'config.changed' && row.origin === 'human'));
    await new Promise((r) => setTimeout(r, 3_000));
    const waiting = await c.status();
    expect(waiting.available && (waiting.delivery?.deliveredSeq ?? 0) < change.journalSeq).toBe(true);

    // Qwen Code takes messages again: the same row arrives, once.
    inbox.control.receipt = 'delivered';
    await until('the retried push', () => inbox.messages.find((m) => m.content.includes(change.eventId)), 30_000);
    await until('delivery to count it', async () => {
      const s = await c.status();
      return s.available && (s.delivery?.deliveredSeq ?? 0) >= change.journalSeq ? true : undefined;
    });
  }, 60_000);

  it('stops pushing once detached, and after a xezar restart resumes once the leader attaches again (AC-3)', async () => {
    const c = await cockpit();
    const inbox = await fakeQwenInbox();
    const first = await serve(c);
    const { leader } = await attachedQwen(c, inbox.path);
    okResult(await leader.call('leader_events', { action: 'attach' }));

    // Detach: a later row is not pushed.
    expect(okResult(await leader.call('leader_events', { action: 'stop' })).structuredContent).toMatchObject({ ok: true, outcome: 'stopped' });
    expect((await c.human('PUT', '/config', { baseBranch: 'develop' })).status).toBe(200);
    const one = await until('the first config row', () => journalRows(c.dataDir).find((row) => row.kind === 'config.changed' && row.origin === 'human'));
    await new Promise((r) => setTimeout(r, 1_500));
    expect(inbox.messages.some((m) => m.content.includes(one.eventId))).toBe(false);

    // Attach again, then the cockpit restarts: the idle leader hears it once, through its inbox.
    okResult(await leader.call('leader_events', { action: 'attach' }));
    await until('the waiting row', () => inbox.messages.find((m) => m.content.includes(one.eventId)));
    first.close();
    const notice = await until('the stop notice', () => inbox.messages.find((m) => m.content.includes('[xezar connection notice]')));
    expect(notice.content).toContain('attach again if it says this session is not attached');
    await serve(c);

    expect((await leader.callMessage('leader_events', { action: 'status' })).error?.code).toBe(-32081);
    expect(okResult(await leader.call('leader_events', { action: 'status' })).structuredContent).toMatchObject({ leader: null, self: { attached: false } });
    okResult(await leader.call('leader_events', { action: 'attach' }));
    expect((await c.human('PUT', '/config', { baseBranch: 'main' })).status).toBe(200);
    const two = await until('the second config row', () => journalRows(c.dataDir).filter((row) => row.kind === 'config.changed' && row.origin === 'human')[1]);
    await until('the push after the restart', () => inbox.messages.find((m) => m.content.includes(two.eventId)));
  }, 60_000);

  it('a Qwen Code session that gave its bridge no inbox cannot be attached, says why, and keeps reading', async () => {
    const c = await cockpit();
    await serve(c);
    const { leader, init } = await attachedQwen(c, undefined);
    expect(init.instructions).toContain('xezar cannot push events to this session');
    const status = okResult(await leader.call('leader_events', { action: 'status' }));
    expect(status.structuredContent).toMatchObject({ canPush: false, pushUnavailable: { code: 'inbox-unavailable' }, self: { client: 'qwen' } });
    const refused = await leader.call('leader_events', { action: 'attach' });
    expect(refused.structuredContent).toMatchObject({ ok: false, code: 'attach-refused', blocker: { code: 'qwen-inbox-unavailable' } });
    expect(JSON.stringify(refused.structuredContent)).toContain('0.25.2');
    okResult(await leader.call('leader_events', { action: 'read' }));
  }, 60_000);
});
