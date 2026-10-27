import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onWindows, shortTmpRoot, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { clientMac, PIPE_AUTH_VERSION, PipeAuthGate, pipeHello, serverMac, type PipeAuthTimers } from './pipe-auth.ts';

/**
 * #963/#980: the pipe's mutual pre-authentication stage, over a real local endpoint (a Unix socket
 * on Linux and macOS, a named pipe on Windows – the gate takes any duplex). The engine proves itself
 * AND makes the client prove itself (#980), so neither a foreign server on a stale name nor a
 * foreign client that merely opened the pipe is let through.
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

/** Read exactly one newline-terminated JSON line from a socket. */
function oneLine(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const nl = buffered.indexOf(0x0a);
      if (nl < 0) return;
      socket.off('data', onData);
      try {
        resolve(JSON.parse(buffered.subarray(0, nl).toString('utf8')));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    socket.on('data', onData);
    socket.once('close', () => reject(new Error('closed before a line arrived')));
  });
}

describe('the mutual pipe handshake (#963, #980)', () => {
  it('both sides prove the key, then the engine hands the connection on with its next bytes', async () => {
    const s = await serve();
    const socket = await dial(s.path);
    const hello = await pipeHello(socket, { key: KEY, pipeName: NAME }, 5_000);
    expect(hello).toEqual({ ok: true, rest: Buffer.alloc(0) });
    await vi.waitFor(() => expect(s.ready).toHaveLength(1));
    // The engine wrote a challenge, then its own proof — and only after the client proved itself.
    expect(s.writes[0]!.map((w) => JSON.parse(w).type)).toEqual(['challenge', 'hello']);
  });

  it('carries the IPC bytes a client pipelines behind its auth through to the handoff', async () => {
    const s = await serve();
    const raw = await dial(s.path);
    const nonce = randomBytes(32).toString('hex');
    raw.write(`${JSON.stringify({ type: 'hello', v: PIPE_AUTH_VERSION, nonce })}\n`);
    const challenge = await oneLine(raw);
    expect(challenge).toMatchObject({ type: 'challenge', v: PIPE_AUTH_VERSION });
    const mac = clientMac(KEY, nonce, String(challenge.challenge), NAME);
    raw.write(`${JSON.stringify({ type: 'auth', v: PIPE_AUTH_VERSION, mac })}\n{"frame":1}\n`);
    await vi.waitFor(() => expect(s.ready).toHaveLength(1));
    expect(s.ready[0]!.rest.toString()).toBe('{"frame":1}\n');
    expect(JSON.parse(s.writes[0]![1]!)).toEqual({ type: 'hello', v: PIPE_AUTH_VERSION, mac: serverMac(KEY, nonce, String(challenge.challenge), NAME) });
  });

  // #980 finding 4: the engine admits only a client that proves the key. A client that answers the
  // challenge with the wrong key (or for another pipe name) is dropped, and the engine NEVER reveals
  // its own proof to it — so a foreign client cannot use the engine as a signing oracle.
  it('refuses a client whose challenge response does not prove the key, revealing no server proof', async () => {
    for (const forgery of [{ key: randomBytes(32), pipeName: NAME }, { key: KEY, pipeName: `${NAME.slice(0, -1)}0` }]) {
      const s = await serve();
      const raw = await dial(s.path);
      const nonce = randomBytes(32).toString('hex');
      raw.write(`${JSON.stringify({ type: 'hello', v: PIPE_AUTH_VERSION, nonce })}\n`);
      const challenge = await oneLine(raw);
      const mac = clientMac(forgery.key, nonce, String(challenge.challenge), forgery.pipeName);
      raw.write(`${JSON.stringify({ type: 'auth', v: PIPE_AUTH_VERSION, mac })}\n`);
      await closed(raw);
      expect(s.ready).toEqual([]);
      // The only thing the engine ever wrote was the challenge: no `{type:'hello',mac}`.
      expect(s.writes[0]!.map((w) => JSON.parse(w).type)).toEqual(['challenge']);
    }
  });

  it('refuses a client that sends no auth after the challenge (dropping it without its own proof)', async () => {
    let fire: (() => void) | undefined;
    const timers: PipeAuthTimers = { setTimer: (fn) => ((fire = fn), 1), clearTimer: () => undefined };
    const s = await serve({ timers });
    const raw = await dial(s.path);
    const nonce = randomBytes(32).toString('hex');
    raw.write(`${JSON.stringify({ type: 'hello', v: PIPE_AUTH_VERSION, nonce })}\n`);
    await oneLine(raw);
    fire!();
    await closed(raw);
    expect(s.ready).toEqual([]);
    expect(s.writes[0]!.map((w) => JSON.parse(w).type)).toEqual(['challenge']);
    expect(s.gate.waiting).toBe(0);
  });

  it('a foreign engine that completes the handshake with the wrong key is foreign to the bridge', async () => {
    // A server that follows the protocol shape but signs with another key does not prove itself.
    const other = randomBytes(32);
    const path = endpointPath();
    const rogue = createServer((socket) => {
      void oneLine(socket).then((hello) => {
        const challenge = randomBytes(32).toString('hex');
        socket.write(`${JSON.stringify({ type: 'challenge', v: PIPE_AUTH_VERSION, challenge })}\n`);
        void oneLine(socket).then(() => socket.write(`${JSON.stringify({ type: 'hello', v: PIPE_AUTH_VERSION, mac: serverMac(other, String(hello.nonce), challenge, NAME) })}\n`));
      });
    });
    await new Promise<void>((resolve) => rogue.listen(path, resolve));
    cleanups.push(() => rogue.close());
    expect(await pipeHello(await dial(path), { key: KEY, pipeName: NAME }, 5_000)).toEqual({ ok: false, failure: 'foreign' });
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
      `${JSON.stringify({ type: 'hi', v: PIPE_AUTH_VERSION, nonce: 'a'.repeat(64) })}\n`,
      `${JSON.stringify({ type: 'hello', v: PIPE_AUTH_VERSION, nonce: 'xyz' })}\n`,
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
