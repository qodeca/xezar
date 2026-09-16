import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  const listeners = new Set<(message: Record<string, unknown>) => void>();
  let closed = false;
  const emit = (message: Record<string, unknown>) => { for (const listener of listeners) listener(message); };
  const subscription = (listener: (message: Record<string, unknown>) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const codexLink = {
    get closed() { return closed; }, subscribe: subscription, close() { closed = true; },
    async request(method: string, params: Record<string, unknown>) {
      requests.push(method);
      if (method === 'thread/loaded/list') return { data: ['matrix-thread'] };
      if (method === 'thread/resume') return { thread: { id: 'matrix-thread', status: { type: 'idle' } } };
      if (method === 'thread/turns/list') return { data: [] };
      if (method === 'turn/start') {
        received.push(JSON.stringify(params));
        queueMicrotask(() => emit({ method: 'item/started', params: { threadId: 'matrix-thread', item: { type: 'userMessage', clientId: params.clientUserMessageId } } }));
        return { turn: { id: `turn-${received.length}`, status: 'inProgress' } };
      }
      return {};
    },
  };
  const piLink = {
    get closed() { return closed; }, subscribe: subscription, close() { closed = true; },
    async request(command: Record<string, unknown>) {
      requests.push(String(command.type));
      if (command.type === 'get_state') return { success: true, data: { isStreaming: false, pendingMessageCount: 0 } };
      if (command.type === 'get_messages') return { success: true, data: { messages: [] } };
      received.push(JSON.stringify(command));
      return { success: true };
    },
  };
  const delivery = new LeaderDelivery({ projectId: 'matrix', projectRoot: root, journal, guard, ownership,
    warn: () => {}, heartbeatMs: 60_000,
    codexLeader: { home: () => join(root, 'codex'), connect: async () => ({ threadId: 'matrix-thread', link: codexLink, state: { waiting: false } }) },
    piLeader: { read: () => ({ ok: true, descriptor: { schemaVersion: 1, session: { pid: 1, startedAt: 'fixture' }, endpoint: { socket: join(root, 'pi.sock') } } }), connect: () => piLink as never },
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
        const msg = JSON.parse(line);
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
    const peer = client === 'opencode' ? await fakeOpenCode(root, closers) : undefined;
    expect(await delivery.act({ action: 'attach', client, ...(peer ? { baseUrl: peer.baseUrl, sessionId: SESSION } : {}) })).toMatchObject({ ok: true });
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
