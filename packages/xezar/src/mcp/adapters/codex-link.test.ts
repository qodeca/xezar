import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexRequestRefused } from './codex.ts';
import { CODEX_CONTROL_SOCKET, codexControlHome, connectCodexLeader, validateControlSocket } from './codex-link.ts';

/**
 * The link to a person's shared Codex app-server (#374), against a stand-in on a real Unix socket.
 * The stand-in answers what codex-cli 0.154.0 answered in the live probes on PR 403 and nothing more:
 * `initialize` names its `codexHome`, `thread/loaded/list` is `string[]`, `thread/resume` carries
 * `thread.status`. And, like the real server, it HANGS UP on an Upgrade that offers
 * `permessage-deflate` — measured: a default `ws` client got "socket hang up", `perMessageDeflate:
 * false` opened — so every case in this file fails if the client offers the extension again.
 */

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A short, private Codex home under /tmp (a Unix socket path must stay under SUN_LEN). */
function codexHome(prefix: string): string {
  const home = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  dirs.push(home);
  const control = join(home, 'app-server-control');
  mkdirSync(control, { mode: 0o700 });
  chmodSync(control, 0o700);
  return home;
}

interface Request {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

const SILENT = Symbol('no answer');
type Answer = unknown | Error | typeof SILENT;
type Handler = (request: Request, client: WebSocket) => Answer;

/** The real server's answers for one idle, loaded thread whose project is `project`. */
function answers(home: string, project: string, over: Record<string, Answer | ((request: Request, client: WebSocket) => Answer)> = {}): Handler {
  return (request, client) => {
    const own = over[request.method];
    if (own !== undefined) return typeof own === 'function' ? (own as (request: Request, client: WebSocket) => Answer)(request, client) : own;
    switch (request.method) {
      case 'initialize':
        return { codexHome: home, platformFamily: 'unix' };
      case 'thread/list':
        return { data: [{ id: 'thread-1', cwd: project }], nextCursor: null };
      case 'thread/loaded/list':
        return { data: ['thread-1'], nextCursor: null };
      case 'thread/resume':
        return { thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] } };
      case 'thread/unsubscribe':
        return { status: 'unsubscribed' };
      default:
        return {};
    }
  };
}

async function appServer(home: string, handler: Handler = answers(home, home), opts: { refuseEveryUpgrade?: boolean } = {}) {
  const upgrades: IncomingHttpHeaders[] = [];
  const requests: Request[] = [];
  const clients = new Set<WebSocket>();
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket: Duplex, head) => {
    upgrades.push(req.headers);
    // codex-cli 0.154.0 hangs up here rather than answering 400.
    if (opts.refuseEveryUpgrade || req.headers['sec-websocket-extensions'] !== undefined) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      clients.add(client);
      client.on('message', (raw) => {
        const request = JSON.parse(raw.toString()) as Request;
        requests.push(request);
        const result = handler(request, client);
        if (result === SILENT) return;
        client.send(JSON.stringify(result instanceof Error ? { jsonrpc: '2.0', id: request.id, error: { code: -32600, message: result.message } } : { jsonrpc: '2.0', id: request.id, result }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(join(home, CODEX_CONTROL_SOCKET), resolve));
  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      for (const client of clients) client.terminate();
      server.close(() => resolve());
    });
  closers.push(close);
  return { upgrades, requests, clients, close, methods: () => requests.map((request) => request.method) };
}

describe('the shared Codex app-server link (#374)', () => {
  it('attaches to the one loaded, cwd-bound thread over the private socket, resumes it without turns, and lets go of it', async () => {
    const home = codexHome('xzcl-');
    const server = await appServer(
      home,
      answers(home, home, {
        'thread/read': (_request: Request, client: WebSocket) => {
          client.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-1' } }));
          return {};
        },
        'thread/refused': new Error('request refused'),
        'thread/empty': null,
      }),
    );
    const connected = await connectCodexLeader({ threadId: 'thread-1' }, home, home);
    expect(connected).toMatchObject({ threadId: 'thread-1', state: { waiting: false } });
    expect(server.methods()).toEqual(['initialize', 'thread/list', 'thread/loaded/list', 'thread/resume', 'thread/unsubscribe']);
    expect(server.requests[1]?.params).toEqual({ cwd: home, modelProviders: [] });
    expect(server.requests[3]?.params).toEqual({ threadId: 'thread-1', excludeTurns: true });

    const notices: unknown[] = [];
    connected.link.subscribe((notice) => notices.push(notice));
    await connected.link.request('thread/read', { threadId: 'thread-1' });
    expect(notices).toHaveLength(1);
    const refusal = connected.link.request('thread/refused', {});
    await expect(refusal).rejects.toBeInstanceOf(CodexRequestRefused);
    await expect(refusal).rejects.toThrow('request refused');
    await expect(connected.link.request('thread/empty', {})).resolves.toEqual({});
    connected.link.close();
    expect(connected.link.closed).toBe(true);
    await expect(connected.link.request('thread/read', { threadId: 'thread-1' })).rejects.toThrow('connection is closed');
  });

  it('never offers permessage-deflate — the stand-in hangs up on it exactly as codex-cli 0.154.0 does', async () => {
    const home = codexHome('xzcl-deflate-');
    const server = await appServer(home);
    const connected = await connectCodexLeader({ threadId: 'thread-1' }, home, home);
    connected.link.close();
    expect(server.upgrades[0]?.['sec-websocket-extensions']).toBeUndefined();
    // The control: a client that DOES offer it (ws's default) is hung up on by this same stand-in.
    const offered = new WebSocket(`ws+unix://${join(home, CODEX_CONTROL_SOCKET)}:/`);
    await expect(new Promise((resolve, reject) => { offered.once('open', resolve); offered.once('error', reject); })).rejects.toThrow('socket hang up');
    expect(server.upgrades[1]?.['sec-websocket-extensions']).toContain('permessage-deflate');
  });

  it('binds the ANNOUNCED thread when two sessions share the project, and refuses one it cannot find', async () => {
    const home = codexHome('xzcl-two-');
    const server = await appServer(
      home,
      answers(home, home, {
        'thread/list': { data: [{ id: 'thread-1', cwd: home }, { id: 'thread-2', cwd: home }], nextCursor: null },
        'thread/loaded/list': { data: ['thread-1', 'thread-2'] },
        'thread/resume': (request: Request) => ({ thread: { id: request.params.threadId, status: { type: 'idle' } } }),
      }),
    );
    const second = await connectCodexLeader({ threadId: 'thread-2' }, home, home);
    second.link.close();
    expect(second.threadId).toBe('thread-2');
    expect(server.requests.find((request) => request.method === 'thread/resume')?.params).toEqual({ threadId: 'thread-2', excludeTurns: true });
    await expect(connectCodexLeader({ threadId: 'thread-3' }, home, home)).rejects.toThrow('absent, stale, ambiguous, or not loaded');
    expect(server.methods().filter((method) => method === 'thread/resume')).toHaveLength(1);
  });

  it('pages through thread/list for the announced thread, and a listing that never ends reads as not found', async () => {
    const home = codexHome('xzcl-pages-');
    let endless = false;
    const server = await appServer(
      home,
      answers(home, home, {
        'thread/list': (request: Request) =>
          endless || request.params.cursor === undefined ? { data: [{ id: 'older', cwd: home }], nextCursor: 'page-2' } : { data: [{ id: 'thread-1', cwd: home }], nextCursor: null },
      }),
    );
    const found = await connectCodexLeader({ threadId: 'thread-1' }, home, home);
    found.link.close();
    expect(server.requests.filter((request) => request.method === 'thread/list').map((request) => request.params.cursor)).toEqual([undefined, 'page-2']);
    endless = true;
    const before = server.methods().length;
    await expect(connectCodexLeader({ threadId: 'thread-1' }, home, home)).rejects.toThrow('not loaded');
    expect(server.methods().slice(before).filter((method) => method === 'thread/list')).toHaveLength(20);
  });

  it('refuses a saved but unloaded thread — never resuming it into the server — and closes its own link', async () => {
    const home = codexHome('xzcl-stale-');
    const server = await appServer(home, answers(home, home, { 'thread/list': { threads: [{ id: 'thread-1', cwd: home }] }, 'thread/loaded/list': { data: [] } }));
    await expect(connectCodexLeader({ threadId: 'thread-1' }, home, home)).rejects.toThrow('not loaded');
    expect(server.methods()).not.toContain('thread/resume');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([...server.clients].every((client) => client.readyState !== WebSocket.OPEN)).toBe(true);
  });

  it('rejects the obsolete object-shaped loaded-thread response instead of accepting a false positive', async () => {
    const home = codexHome('xzcl-old-shape-');
    await appServer(home, answers(home, home, { 'thread/loaded/list': { data: [{ id: 'thread-1' }] } }));
    await expect(connectCodexLeader({ threadId: 'thread-1' }, home, home)).rejects.toThrow('not loaded');
  });

  it('a wrong home fails closed: another home, no home, or a symlinked candidate the server does not name', async () => {
    const home = codexHome('xzcl-home-');
    let named: unknown = join(home, '..');
    await appServer(home, answers(home, home, { initialize: () => (named === undefined ? {} : { codexHome: named }) }));
    await expect(connectCodexLeader({ threadId: 'thread-1' }, home, home)).rejects.toThrow('did not confirm the Codex home');
    named = undefined;
    await expect(connectCodexLeader({ threadId: 'thread-1' }, home, home)).rejects.toThrow('did not confirm the Codex home');
    named = join(home, 'nowhere');
    await expect(connectCodexLeader({ threadId: 'thread-1' }, home, home)).rejects.toThrow('named a home that cannot be read (ENOENT)');
    // A candidate home whose control folder is a symlink to a real server's: the socket checks pass,
    // but the server names ITS home, not the candidate, so nothing is trusted.
    named = home;
    const alias = realpathSync(mkdtempSync('/tmp/xzcl-alias-'));
    dirs.push(alias);
    symlinkSync(join(home, 'app-server-control'), join(alias, 'app-server-control'));
    await expect(connectCodexLeader({ threadId: 'thread-1' }, home, alias)).rejects.toThrow('did not confirm the Codex home');
  });

  it('rejects a server that resumes a different thread than the one announced', async () => {
    const home = codexHome('xzcl-mismatch-');
    await appServer(home, answers(home, home, { 'thread/list': { data: [{ thread: { id: 'thread-1', cwd: home } }] }, 'thread/resume': { threadId: 'wrong-thread' } }));
    await expect(connectCodexLeader({ threadId: 'thread-1' }, home, home)).rejects.toThrow('different thread');
  });

  it('seeds a prompt already open at attach and the turn running then, and refuses a resume that reports no state', async () => {
    const home = codexHome('xzcl-busy-');
    let status: unknown = { type: 'active', activeFlags: ['waitingOnApproval'] };
    await appServer(
      home,
      answers(home, home, {
        'thread/resume': () => ({ thread: { id: 'thread-1', ...(status === undefined ? {} : { status }) } }),
        'thread/turns/list': { data: [{ id: 'turn-9', status: 'inProgress', items: [] }] },
      }),
    );
    const busy = await connectCodexLeader({ threadId: 'thread-1' }, home, home);
    busy.link.close();
    expect(busy.state).toEqual({ waiting: true, activeTurnId: 'turn-9' });
    status = undefined;
    await expect(connectCodexLeader({ threadId: 'thread-1' }, home, home)).rejects.toThrow('did not report the thread’s state');
    // Round-5 review, major 1: a flag entry xezar cannot read refuses at attach like a missing state.
    status = { type: 'active', activeFlags: [{ type: 'waitingOnApproval' }] };
    await expect(connectCodexLeader({ threadId: 'thread-1' }, home, home)).rejects.toThrow('did not report the thread’s state');
  });

  it('a missing daemon, a missing home and a hang-up are refused with reasons that name no path', async () => {
    const home = codexHome('xzcl-missing-');
    const noSocket = await connectCodexLeader({ threadId: 'thread-1' }, home, home).catch((err: Error) => err);
    expect(noSocket).toBeInstanceOf(Error);
    expect((noSocket as Error).message).toBe('no shared Codex app-server control socket was found in the Codex home (ENOENT)');
    const noHome = await connectCodexLeader({ threadId: 'thread-1' }, home, join(home, 'absent')).catch((err: Error) => err);
    expect((noHome as Error).message).toBe('the Codex home cannot be read (ENOENT)');
    const noProject = await connectCodexLeader({ threadId: 'thread-1' }, join(home, 'absent'), home).catch((err: Error) => err);
    expect((noProject as Error).message).toBe('the project folder cannot be read (ENOENT)');
    await appServer(home, answers(home, home), { refuseEveryUpgrade: true });
    const hungUp = await connectCodexLeader({ threadId: 'thread-1' }, home, home).catch((err: Error) => err);
    expect((hungUp as Error).message).toMatch(/^the Codex app-server did not accept xezar’s connection \(/);
    for (const err of [noSocket, noHome, noProject, hungUp]) expect((err as Error).message).not.toContain(home);
  });

  it('a readonly Codex home still attaches: xezar reads it and writes nothing there', async () => {
    const home = codexHome('xzcl-readonly-');
    await appServer(home);
    chmodSync(home, 0o500);
    const connected = await connectCodexLeader({ threadId: 'thread-1' }, home, home);
    connected.link.close();
    expect(connected.threadId).toBe('thread-1');
  });

  it('the daemon exiting mid-session fails what is pending and marks the link closed; bad frames close it too', async () => {
    const home = codexHome('xzcl-exit-');
    const server = await appServer(home, answers(home, home, { 'thread/read': SILENT, 'thread/garbage': (_request: Request, client: WebSocket) => (client.send('not json'), SILENT) }));
    const first = await connectCodexLeader({ threadId: 'thread-1' }, home, home);
    const pending = first.link.request('thread/read', { threadId: 'thread-1' });
    await server.close();
    await expect(pending).rejects.toThrow('closed xezar’s link');
    expect(first.link.closed).toBe(true);

    const again = await appServer(home, answers(home, home, { 'thread/garbage': (_request: Request, client: WebSocket) => (client.send('not json'), SILENT) }));
    const second = await connectCodexLeader({ threadId: 'thread-1' }, home, home);
    await expect(second.link.request('thread/garbage', {})).rejects.toThrow('invalid JSON');
    expect(second.link.closed).toBe(true);
    expect(again.upgrades).toHaveLength(1);
  });

  it('answers the server’s ping, so an idle link is not reaped', async () => {
    const home = codexHome('xzcl-ping-');
    const server = await appServer(home);
    const connected = await connectCodexLeader({ threadId: 'thread-1' }, home, home);
    const [client] = [...server.clients].slice(-1);
    const pong = new Promise<string>((resolve) => client!.once('pong', (data) => resolve(data.toString())));
    client!.ping('alive');
    await expect(pong).resolves.toBe('alive');
    connected.link.close();
  });

  it('refuses a non-socket endpoint', () => {
    const path = realpathSync(mkdtempSync('/tmp/xzcl-file-'));
    dirs.push(path);
    expect(() => validateControlSocket(path)).toThrow('not a Unix socket');
  });

  it('refuses a socket beneath a non-private directory before it dials', async () => {
    const home = codexHome('xzcl-private-');
    const server = await appServer(home);
    chmodSync(join(home, 'app-server-control'), 0o755);
    await expect(connectCodexLeader({ threadId: 'thread-1' }, home, home)).rejects.toThrow('not private');
    expect(server.upgrades).toHaveLength(0);
  });

  it('looks in the serving process’s own Codex home: CODEX_HOME when set, otherwise ~/.codex', () => {
    expect(codexControlHome({ CODEX_HOME: '/srv/codex', HOME: '/home/someone' })).toBe('/srv/codex');
    expect(codexControlHome({ HOME: '/home/someone' })).toBe(join('/home/someone', '.codex'));
  });
});
