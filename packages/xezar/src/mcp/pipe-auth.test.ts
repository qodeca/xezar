import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onWindows, shortTmpRoot, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { PIPE_AUTH_VERSION, PipeAuthGate, pipeHello, pipeMac, type PipeAuthTimers } from './pipe-auth.ts';

/**
 * #963: the pipe's pre-authentication stage, over a real local endpoint (a Unix socket on Linux and
 * macOS, a named pipe on Windows – the gate takes any duplex).
 */

const KEY = randomBytes(32);
const NAME = '\\\\.\\pipe\\xezar-mcp-0123456789abcdef0123456789abcdef';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
});

function endpointPath(): string {
  if (onWindows) return `\\\\.\\pipe\\xezar-test-${randomBytes(16).toString('hex')}`;
  const dir = mkdtempSync(join(shortTmpRoot(), 'xzpa-'));
  cleanups.push(() => rmSync(dir, TEST_DIR_RM_OPTIONS));
  return join(dir, 's.sock');
}

interface Served {
  path: string;
  gate: PipeAuthGate;
  ready: Array<{ socket: Socket; rest: Buffer }>;
  /** Every write the server made to a connection, by connection order. */
  writes: string[][];
}

async function serve(opts: { maxPending?: number; timers?: PipeAuthTimers; helloTimeoutMs?: number } = {}): Promise<Served> {
  const path = endpointPath();
  const gate = new PipeAuthGate({ key: KEY, pipeName: NAME, ...opts });
  const ready: Served['ready'] = [];
  const writes: string[][] = [];
  const server: Server = createServer((socket) => {
    const log: string[] = [];
    writes.push(log);
    const write = socket.write.bind(socket);
    socket.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      log.push(String(chunk));
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof socket.write;
    const end = socket.end.bind(socket);
    socket.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (chunk !== undefined && typeof chunk !== 'function') log.push(String(chunk));
      return (end as (...args: unknown[]) => Socket)(chunk, ...rest);
    }) as typeof socket.end;
    gate.admit(socket, (s, rest) => ready.push({ socket: s as Socket, rest }));
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => server.close());
  return { path, gate, ready, writes };
}

async function dial(path: string): Promise<Socket> {
  const socket = createConnection(path);
  cleanups.push(() => socket.destroy());
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  return socket;
}

const closed = (socket: Socket): Promise<void> =>
  new Promise((resolve) => {
    if (socket.destroyed) return resolve();
    socket.once('close', () => resolve());
    socket.resume(); // read what is left, so the end arrives
  });

describe('the pipe handshake (#963)', () => {
  it('proves the engine with HMAC(key, nonce ‖ pipeName), then hands the connection on with its next bytes', async () => {
    const s = await serve();
    const socket = await dial(s.path);
    const hello = await pipeHello(socket, { key: KEY, pipeName: NAME }, 5_000);
    expect(hello).toEqual({ ok: true, rest: Buffer.alloc(0) });
    await vi.waitFor(() => expect(s.ready).toHaveLength(1));
    // A frame sent right behind the hello reaches the IPC side.
    const raw = await dial(s.path);
    const nonce = randomBytes(32).toString('hex');
    raw.write(`${JSON.stringify({ type: 'hello', v: PIPE_AUTH_VERSION, nonce })}\n{"frame":1}\n`);
    await vi.waitFor(() => expect(s.ready).toHaveLength(2));
    expect(s.ready[1]!.rest.toString()).toBe('{"frame":1}\n');
    expect(JSON.parse(s.writes[1]![0]!)).toEqual({ type: 'hello', v: PIPE_AUTH_VERSION, mac: pipeMac(KEY, nonce, NAME) });
  });

  it('a bridge with another key, or for another pipe name, calls the answer foreign', async () => {
    const s = await serve();
    expect(await pipeHello(await dial(s.path), { key: randomBytes(32), pipeName: NAME }, 5_000)).toEqual({ ok: false, failure: 'foreign' });
    expect(await pipeHello(await dial(s.path), { key: KEY, pipeName: `${NAME.slice(0, -1)}0` }, 5_000)).toEqual({ ok: false, failure: 'foreign' });
  });

  it('a server that is not xezar (it echoes, or says nothing) is foreign, or a timeout', async () => {
    const path = endpointPath();
    const echo = createServer((socket) => socket.on('data', (d) => socket.write(d)));
    await new Promise<void>((resolve) => echo.listen(path, resolve));
    cleanups.push(() => echo.close());
    expect(await pipeHello(await dial(path), { key: KEY, pipeName: NAME }, 5_000)).toEqual({ ok: false, failure: 'foreign' });

    const silent = endpointPath();
    const quiet = createServer(() => undefined);
    await new Promise<void>((resolve) => quiet.listen(silent, resolve));
    cleanups.push(() => quiet.close());
    expect(await pipeHello(await dial(silent), { key: KEY, pipeName: NAME }, 200)).toEqual({ ok: false, failure: 'timeout' });
  });

  it('writes nothing before a valid hello: garbage, a wrong type, a bad nonce and an oversized line are closed silently', async () => {
    const s = await serve();
    const lines = [
      'not json\n',
      `${JSON.stringify({ type: 'hi', v: 1, nonce: 'a'.repeat(64) })}\n`,
      `${JSON.stringify({ type: 'hello', v: 1, nonce: 'xyz' })}\n`,
      `${'x'.repeat(2_000)}`,
      `{"v":${PIPE_AUTH_VERSION},"id":1,"method":"session/open"}\n`, // an IPC frame before the hello
    ];
    for (const line of lines) {
      const socket = await dial(s.path);
      socket.write(line);
      await closed(socket);
    }
    expect(s.writes).toHaveLength(lines.length);
    expect(s.writes.flat()).toEqual([]);
    expect(s.ready).toEqual([]);
  });

  it('closes a connection that says nothing within the hello timeout, writing nothing', async () => {
    let fire: (() => void) | undefined;
    const timers: PipeAuthTimers = { setTimer: (fn) => ((fire = fn), 1), clearTimer: () => undefined };
    const s = await serve({ timers });
    const socket = await dial(s.path);
    await vi.waitFor(() => expect(s.gate.waiting).toBe(1));
    fire!();
    await closed(socket);
    expect(s.writes.flat()).toEqual([]);
    expect(s.gate.waiting).toBe(0);
  });

  it('refuses another handshake version with one line', async () => {
    const s = await serve();
    const socket = await dial(s.path);
    socket.write(`${JSON.stringify({ type: 'hello', v: PIPE_AUTH_VERSION + 1, nonce: 'a'.repeat(64) })}\n`);
    await closed(socket);
    expect(s.writes.flat().map((w) => JSON.parse(w))).toEqual([{ type: 'hello-refused', v: PIPE_AUTH_VERSION, reason: 'version' }]);
    // And the bridge reads that as a version refusal.
    const bridgeSide = createServer((sock) => sock.end(`${JSON.stringify({ type: 'hello-refused', v: 9, reason: 'version' })}\n`));
    const path = endpointPath();
    await new Promise<void>((resolve) => bridgeSide.listen(path, resolve));
    cleanups.push(() => bridgeSide.close());
    expect(await pipeHello(await dial(path), { key: KEY, pipeName: NAME }, 5_000)).toEqual({ ok: false, failure: 'version' });
  });

  it('evicts the oldest idle connection at the cap, so idle clients cannot lock the bridge out', async () => {
    const evicted: number[] = [];
    const s = await serve({ maxPending: 16, helloTimeoutMs: 60_000 });
    (s.gate as unknown as { opts: { onEvict: (n: number) => void } }).opts.onEvict = (n) => evicted.push(n);
    const idle: Socket[] = [];
    for (let i = 0; i < 16; i++) idle.push(await dial(s.path));
    await vi.waitFor(() => expect(s.gate.waiting).toBe(16));
    const hello = await pipeHello(await dial(s.path), { key: KEY, pipeName: NAME }, 5_000);
    expect(hello.ok).toBe(true);
    await closed(idle[0]!);
    expect(s.gate.evictions).toBe(1);
    expect(evicted).toEqual([1]);
    expect(idle.slice(1).every((socket) => !socket.destroyed)).toBe(true);
  });
});
