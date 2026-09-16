import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createSocketServer, type AddressInfo, type Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { CODEX_CONTROL_SOCKET } from './adapters/codex-link.ts';
import { piLeaderPath } from './adapters/pi-link.ts';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
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

export const DELIVERY_CLIENTS = ['claude-code', 'codex', 'opencode', 'pi'] as const;
export type DeliveryClient = typeof DELIVERY_CLIENTS[number];
const SESSION = 'ses_matrix0000000000000001';
interface Submission { parts: Array<{ text: string; metadata?: { xezar?: { rows: string[] } } }> }

// Real catalog/journal/controller/adapters; only the external client is a protocol peer.
// Claude additionally crosses the real IPC service and stdio bridge, recording channel stdout.
export async function deliveryHarness(client: DeliveryClient) {
  // Short socket home is essential on macOS; never use a real agent's config/home.
  const root = realpathSync(mkdtempSync('/tmp/xz-matrix-'));
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
  const delivery = new LeaderDelivery({ projectId: 'matrix', projectRoot: root, dataDir: store.dataDir, journal, guard, ownership,
    warn: () => {}, heartbeatMs: 60_000,
    codexLeader: { home: () => codexHome },
  });
  const close = async () => {
    delivery.close();
    for (const closer of closers.reverse()) await closer();
    for (const run of store.listRuns()) store.deleteRun(run.id);
    ownership.dispose();
    catalog.detach(); journal.close(); store.flush();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    if (client === 'codex') await fakeCodex(root, codexHome, received, requests, closers);
    if (client === 'pi') await fakePi(root, store.dataDir, received, requests, closers);
    if (client === 'claude-code') {
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
      const done = runBridge({ input, output, version: '0.0.0-test', tools,
        resolveTarget: async () => ({ kind: 'socket', path: socket.path, project: { id: 'matrix', name: 'Matrix' } }) });
      closers.push(async () => { input.end(); await done; });
      let next = 1;
      const rpc = (method: string, params: Record<string, unknown>) => new Promise(resolve => {
        const id = next++; pending.set(id, resolve); input.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
      });
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } });
      await rpc('tools/call', { name: 'leader_events', arguments: { action: 'status' } });
    } else {
      await ownership.acquire('matrix-owner');
      delivery.sessionOpened('matrix-owner');
      if (client === 'codex') delivery.codexAnnounced('matrix-owner', { threadId: 'matrix-thread' });
    }
    let peer: Awaited<ReturnType<typeof fakeOpenCode>> | undefined;
    if (client === 'opencode') {
      peer = await fakeOpenCode(root, closers);
      expect(await delivery.act({ action: 'attach', client, baseUrl: peer.baseUrl, sessionId: SESSION })).toMatchObject({ ok: true });
    } else {
      expect(await delivery.act({ action: 'attach', client })).toMatchObject({ ok: true });
    }
    return { root, store, journal, catalog, bus, guard, delivery, close,
      texts: () => peer ? peer.submissions.map(s => JSON.stringify(s)) : received,
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

async function fakeOpenCode(directory: string, closers: Array<() => unknown>) {
  const submissions: Submission[] = [];
  const streams = new Set<ServerResponse>();
  const history: unknown[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route = `${req.method} ${url.pathname}`;
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      };
      if (route === 'GET /event') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
        streams.add(res);
        res.on('close', () => streams.delete(res));
        return;
      }
      if (route === `GET /session/${SESSION}`) return json(200, { id: SESSION, directory });
      if (route === 'GET /session/status') return json(200, {});
      if (route === 'GET /permission' || route === 'GET /question') return json(200, []);
      if (route === `GET /session/${SESSION}/message`) return json(200, history);
      if (route === `POST /session/${SESSION}/prompt_async`) {
        const body = JSON.parse(raw) as Submission;
        submissions.push(body);
        const messageId = 'msg_' + submissions.length;
        history.push({ info: { id: messageId, role: 'user' }, parts: body.parts });
        const emit = (type: string, properties: Record<string, unknown>): void => {
          for (const stream of streams) stream.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
        };
        // The submission's own frames, as OpenCode emits them: this is how the adapter learns which
        // message to watch for a turn.
        emit('message.updated', { sessionID: SESSION, info: { id: messageId, sessionID: SESSION, role: 'user' } });
        for (const part of body.parts) emit('message.part.updated', { sessionID: SESSION, part: { ...part, sessionID: SESSION, messageID: messageId } });
        res.writeHead(204).end();
        return;
      }
      json(404, { name: 'NotFoundError', route });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    for (const stream of streams) stream.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    submissions,
    /** The event ids each submission carried, from its own `metadata.xezar` marker. */
    delivered: (): string[] => submissions.flatMap((s) => s.parts.flatMap((p) => (p.metadata?.xezar?.rows ?? []).map((key) => key.split('@')[0]!))),
  };
}


/** The client endpoints receive actual framed requests through the production link classes. */
async function fakeCodex(project: string, home: string, received: string[], requests: string[], closers: Array<() => unknown>) {
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
        let result: unknown = {};
        switch (frame.method) {
          case 'initialize': result = { codexHome: home, platformFamily: 'unix' }; break;
          case 'thread/list': result = { data: [{ id: 'matrix-thread', cwd: project }], nextCursor: null }; break;
          case 'thread/loaded/list': result = { data: ['matrix-thread'] }; break;
          case 'thread/resume': result = { thread: { id: 'matrix-thread', status: { type: 'idle' }, turns: [] } }; break;
          case 'thread/turns/list': result = { data: [] }; break;
          case 'thread/unsubscribe': result = { status: 'unsubscribed' }; break;
          case 'turn/start':
            received.push(JSON.stringify(frame.params));
            result = { turn: { id: `turn-${received.length}`, status: 'inProgress' } };
            break;
        }
        client.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }));
        if (frame.method === 'turn/start') client.send(JSON.stringify({ method: 'item/started', params: { threadId: 'matrix-thread', item: { type: 'userMessage', clientId: frame.params.clientUserMessageId } } }));
      });
    });
  });
  await new Promise<void>(resolve => server.listen(join(home, CODEX_CONTROL_SOCKET), resolve));
  closers.push(async () => {
    for (const client of clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
}

async function fakePi(root: string, dataDir: string, received: string[], requests: string[], closers: Array<() => unknown>) {
  const path = join(root, 'pi.sock');
  const sockets = new Set<Socket>();
  const server = createSocketServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const framer = new LineFramer(line => {
      const command = JSON.parse(line) as { id: string; type: string };
      requests.push(command.type);
      let data: unknown;
      if (command.type === 'get_state') data = { isStreaming: false, pendingMessageCount: 0 };
      else if (command.type === 'get_messages') data = { messages: [] };
      else received.push(line);
      socket.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, ...(data === undefined ? {} : { data }) }) + '\n');
    }, () => {});
    socket.on('data', (chunk: Buffer) => framer.push(chunk));
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  writeFileSync(piLeaderPath(dataDir), JSON.stringify({ schemaVersion: 1, session: { pid: process.pid, startedAt: 'fixture' }, endpoint: { socket: path } }), { mode: 0o600 });
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
}
