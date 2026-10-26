import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection, createServer as createSocketServer } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { WorkspaceEventBus } from '../server/server.ts';
import { ProjectOwnership } from '../workspace/project-owner.ts';
import { EventCatalog } from './event-catalog.ts';
import { EventJournal } from './event-journal.ts';
import { EchoGuard } from './echo-guard.ts';
import { LeaderDelivery } from './leader-delivery.ts';
import { listenMcpSocket } from './service.ts';
import { runBridge } from './bridge.ts';
import { LineFramer, encodeFrame } from './ipc.ts';
import { tools } from './tools/index.ts';
import { onWindows, shortTmpRoot } from '../../test/helpers/platform.ts';
import { listenCodexControl } from '../../test/helpers/codex-control.ts';
import { targetFor } from '../../test/helpers/mcp-raw.ts';

export const DELIVERY_CLIENTS = ['claude-code', 'codex', 'qwen'] as const;
export type DeliveryClient = typeof DELIVERY_CLIENTS[number];
/** True where this client's peer cannot be built: the Qwen Code peer listens on a Unix socket path, which
 *  Node cannot do on Windows, and Qwen Code opens no inbox there (#1086). The Codex peer runs on every OS
 *  (`listenCodexControl`, #977); Claude Code crosses the real service, a named pipe on Windows. Always
 *  false on POSIX. */
export const deliveryPeerUnavailable = (client: DeliveryClient): boolean => onWindows && client === 'qwen';

// Real catalog/journal/controller/adapters; only the external client is a protocol peer.
// Claude additionally crosses the real IPC service and stdio bridge, recording channel stdout.
export async function deliveryHarness(client: DeliveryClient) {
  // Short socket home is essential on macOS; never use a real agent's config/home.
  const root = realpathSync(mkdtempSync(join(shortTmpRoot(), 'xz-matrix-')));
  const closers: Array<() => unknown> = [];
  const store = RunStore.open(join(root, 'data'));
  const journal = EventJournal.open({ dataDir: store.dataDir, projectId: 'matrix', secretValues: [] });
  const bus = new WorkspaceEventBus();
  const catalog = EventCatalog.attach({ store, journal, workspaceEvents: bus,
    providerBaseline: [{ provider: 'claude', status: 'connected', enabled: true }, { provider: 'codex', status: 'disconnected', enabled: true }] });
  const guard = new EchoGuard({ projectId: 'matrix' });
  const received: string[] = [];
  const requests: string[] = [];
  const ownership = new ProjectOwnership({ projectId: 'matrix', dataDir: store.dataDir });
  const codexHome = join(root, 'codex');
  const delivery = new LeaderDelivery({ projectId: 'matrix', projectRoot: root, journal, guard, ownership,
    warn: () => {}, heartbeatMs: 60_000,
    codexLeader: { home: () => codexHome },
  });
  const close = async () => {
    delivery.close();
    for (const closer of closers.reverse()) await closer();
    for (const run of store.listRuns()) store.deleteRun(run.id);
    ownership.dispose();
    catalog.detach(); journal.close(); store.flush();
    rmSync(root, TEST_DIR_RM_OPTIONS);
  };
  try {
    if (client === 'codex') await fakeCodexAppServer({ project: root, home: codexHome, received, requests, closers, control: { react: true, hangLoaded: false } });
    if (client === 'claude-code' || client === 'qwen') {
      // Qwen Code (#1045) crosses the same service and bridge; its pushes land in the session inbox the
      // bridge finds in its environment, not on stdout.
      const inboxEnv = client === 'qwen' ? await fakeQwenInbox(root, received, closers) : {};
      const socket = await listenMcpSocket({ project: { id: 'matrix', name: 'Matrix', root }, version: '0.0.0-test', tools,
        env: { ...process.env, XEZ_HOME: root }, dataDir: store.dataDir, ownership,
        context: { leaderControl: delivery },
        sessions: { opened: (key, transport) => delivery.sessionOpened(key, transport), closed: key => delivery.sessionClosed(key),
          pushCapability: (key, transport) => delivery.pushCapability(key, transport) },
      });
      closers.push(() => socket.close());
      const input = new PassThrough(); const output = new PassThrough();
      const pending = new Map<number, (answer: unknown) => void>();
      const framer = new LineFramer(line => {
        const msg = JSON.parse(line) as { id?: number; method?: string; params?: unknown; result?: unknown };
        if (msg.method === 'notifications/claude/channel') received.push(JSON.stringify(msg.params));
        if (msg.id !== undefined) { pending.get(msg.id)?.(msg.result); pending.delete(msg.id); }
      }, () => {});
      output.on('data', (chunk: Buffer) => framer.push(chunk));
      const done = runBridge({ input, output, version: '0.0.0-test', tools, env: inboxEnv,
        resolveTarget: async () => targetFor(socket, { id: 'matrix', name: 'Matrix' }, { ...process.env, XEZ_HOME: root }) });
      closers.push(async () => { input.end(); await done; });
      let next = 1;
      const rpc = (method: string, params: Record<string, unknown>) => new Promise(resolve => {
        const id = next++; pending.set(id, resolve); input.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
      });
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: client === 'qwen' ? 'qwen-cli-mcp-client-xezar' : 'claude-code', version: '1' } });
      await rpc('tools/call', { name: 'leader_events', arguments: { action: 'status' } });
    } else {
      await ownership.acquire('matrix-owner');
      delivery.sessionOpened('matrix-owner');
      if (client === 'codex') delivery.codexAnnounced('matrix-owner', { threadId: 'matrix-thread' });
    }
    expect(await delivery.act({ action: 'attach', client })).toMatchObject({ ok: true });
    return { root, store, journal, catalog, bus, guard, delivery, close,
      texts: () => received,
      requests,
      async settle() {
        await vi.waitFor(() => {
          const status = delivery.status();
          expect(status.available && status.delivery?.deliveredSeq).toBe(journal.latestSeq);
        }, { timeout: 3000, interval: 5 });
      },
    };
  } catch (error) { await close(); throw error; }
}

/**
 * A Qwen Code session's inbox (#1045): the `auth` line, then `user` frames, each answered with a
 * `delivered` receipt on the frame's `from` socket, as Qwen Code 0.25.2 does. Returns the environment
 * the session gives its MCP servers.
 */
async function fakeQwenInbox(root: string, received: string[], closers: Array<() => unknown>): Promise<NodeJS.ProcessEnv> {
  const path = join(root, 'qwen-inbox.sock');
  const token = 'matrix-child-token';
  const server = createSocketServer((socket) => {
    let buffer = '';
    let authed = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, at)) as { type?: string; token?: string; msgId?: string; from?: string; message?: { content?: string } };
        buffer = buffer.slice(at + 1);
        if (!authed) { authed = frame.type === 'auth' && frame.token === token; if (!authed) socket.destroy(); continue; }
        if (frame.type !== 'user') continue;
        received.push(frame.message?.content ?? '');
        if (frame.from) {
          const back = createConnection({ path: frame.from });
          back.on('error', () => undefined);
          back.end(`${JSON.stringify({ msgV: 1, type: 'control', status: 'delivered', origMsgId: frame.msgId })}\n`);
        }
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { QWEN_CODE_MESSAGING_SOCKET: path, QWEN_CODE_MESSAGING_TOKEN: token };
}

/**
 * A Codex shared app-server, as far as the production link classes talk to it: one loaded thread in
 * `project`, listening on Codex's control socket in `home`. Records every `turn/start` in `received`
 * and every request method in `requests`. `control.react`: answer each started turn with its
 * `item/started`, the turn the adapter counts as a reaction. `control.hangLoaded`: take a
 * `thread/loaded/list` and never answer it — a leader that stops answering its liveness check.
 */
export interface FakeCodexAppServer {
  project: string;
  home: string;
  received: string[];
  requests: string[];
  closers: Array<() => unknown>;
  control: { react: boolean; hangLoaded: boolean };
  threadId?: string;
}

export async function fakeCodexAppServer(opts: FakeCodexAppServer): Promise<void> {
  const { project, home, received, requests, closers, control } = opts;
  const threadId = opts.threadId ?? 'matrix-thread';
  mkdirSync(join(home, 'app-server-control'), { recursive: true, mode: 0o700 });
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, client => {
      clients.add(client);
      client.on('message', raw => {
        const frame = JSON.parse(raw.toString()) as { id?: number; method: string; params: Record<string, unknown> };
        if (frame.id === undefined) return;
        requests.push(frame.method);
        if (frame.method === 'thread/loaded/list' && control.hangLoaded) return;
        let result: unknown = {};
        switch (frame.method) {
          case 'initialize': result = { codexHome: home, platformFamily: 'unix' }; break;
          case 'thread/list': result = { data: [{ id: threadId, cwd: project }], nextCursor: null }; break;
          case 'thread/loaded/list': result = { data: [threadId] }; break;
          case 'thread/resume': result = { thread: { id: threadId, status: { type: 'idle' }, turns: [] } }; break;
          case 'thread/turns/list': result = { data: [] }; break;
          case 'thread/unsubscribe': result = { status: 'unsubscribed' }; break;
          case 'turn/start':
            received.push(JSON.stringify(frame.params));
            result = { turn: { id: `turn-${received.length}`, status: 'inProgress' } };
            break;
        }
        client.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }));
        if (frame.method === 'turn/start' && control.react) client.send(JSON.stringify({ method: 'item/started', params: { threadId, item: { type: 'userMessage', clientId: frame.params.clientUserMessageId } } }));
      });
    });
  });
  const unpin = await listenCodexControl(server, home);
  closers.push(async () => {
    for (const client of clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    unpin();
  });
}
