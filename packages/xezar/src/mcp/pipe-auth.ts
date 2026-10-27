/**
 * The pre-authentication stage of a Windows MCP pipe (#963, #980).
 *
 * A Windows named pipe lets any local account open it, and a name an exited engine left can be
 * created again by anyone — so neither side may trust the other until it proves it holds the 32-byte
 * key from the private endpoint file (`pipe-endpoint.ts`). The handshake is MUTUAL (#980): each side
 * both proves itself and makes the other prove itself, over a fresh random from each side, so neither
 * a foreign SERVER squatting on a stale name nor a foreign CLIENT that merely opened the pipe is let
 * through.
 *
 *   1. bridge → `hello  { v, nonce }`     — the client's random
 *   2. engine → `challenge { v, challenge }` — the engine's random; it reveals NOTHING derived from
 *        the key yet, so a foreign client cannot use the engine as a signing oracle.
 *   3. bridge → `auth  { v, mac }`         — `clientMac(nonce, challenge)`; proves the client holds the key.
 *   4. engine → `hello { v, mac }`         — `serverMac(nonce, challenge)`, sent ONLY after the
 *        client's `mac` verified; proves the engine holds the key.
 *
 * Both MACs are domain-separated (`'c'` / `'s'` prefix) and bind the client nonce, the engine
 * challenge and the pipe name, so one side's MAC can never answer the other's step and a capture on
 * one pipe is useless on another. Every check is constant time; anything else is not xezar.
 *
 * The engine writes nothing to a connection before a valid `hello`, and closes a connection that
 * sends anything else, or nothing within `helloTimeoutMs`. A `hello` of another version gets one
 * refusal line. At most `maxPending` connections may wait unauthenticated; the next one evicts the
 * oldest, so idle connections cannot fill the slots and lock the bridge out.
 *
 * Only the pipe branch uses this: the POSIX socket is owner-only by its own mode, unchanged. Node
 * exposes no way to set a named pipe's own DACL, so the key handshake — not the pipe ACL — is what
 * keeps a foreign local process out; see `pipe-endpoint.ts` for why that is sufficient (#980).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';

/** Bumped when the handshake shape changes incompatibly. 2 (#980): the mutual client→engine proof. */
export const PIPE_AUTH_VERSION = 2;
/** How long an unauthenticated connection may wait for its `hello` and its `auth`. */
export const PIPE_HELLO_TIMEOUT_MS = 1_000;
/** Unauthenticated connections at once; the next evicts the oldest. */
export const PIPE_MAX_PENDING = 16;
/** A handshake line is far shorter than this; a longer first line is not one. */
const HELLO_MAX_BYTES = 1_024;
const RANDOM_PATTERN = /^[0-9a-f]{64}$/;

/** The client's proof it holds the key: `HMAC(key, 'c' ‖ nonce ‖ challenge ‖ pipeName)`. */
export function clientMac(key: Buffer, nonce: string, challenge: string, pipeName: string): string {
  return createHmac('sha256', key).update('c', 'utf8').update(nonce, 'utf8').update(challenge, 'utf8').update(pipeName, 'utf8').digest('hex');
}

/** The engine's proof it holds the key: `HMAC(key, 's' ‖ nonce ‖ challenge ‖ pipeName)`. */
export function serverMac(key: Buffer, nonce: string, challenge: string, pipeName: string): string {
  return createHmac('sha256', key).update('s', 'utf8').update(nonce, 'utf8').update(challenge, 'utf8').update(pipeName, 'utf8').digest('hex');
}

/** True only when `got` is the hex of a value equal to `expected`, in constant time. */
function sameHex(got: unknown, expected: string): boolean {
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Test seams. Production passes none. */
export interface PipeAuthTimers {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

const realTimers: PipeAuthTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

export interface PipeAuthGateOptions {
  readonly key: Buffer;
  readonly pipeName: string;
  readonly helloTimeoutMs?: number;
  readonly maxPending?: number;
  readonly timers?: PipeAuthTimers;
  /** Told each eviction, with the running count. */
  readonly onEvict?: (count: number) => void;
}

interface Pending {
  readonly socket: Duplex;
  readonly timer: unknown;
  readonly onData: (chunk: Buffer) => void;
  /** The engine's challenge for this connection, set once its `hello` arrives. */
  challenge?: string;
  /** The client nonce from its `hello`, bound into the engine's own proof. */
  nonce?: string;
  /** Bytes already read on this connection but not yet consumed as a handshake line. */
  buffered: Buffer;
}

/** The engine side: admits each new connection, and hands it on only after a MUTUAL `hello`/`auth`. */
export class PipeAuthGate {
  private readonly pending = new Map<Duplex, Pending>();
  private evicted = 0;

  constructor(private readonly opts: PipeAuthGateOptions) {}

  /** How many unauthenticated connections were evicted to make room. */
  get evictions(): number {
    return this.evicted;
  }

  /** Unauthenticated connections now. */
  get waiting(): number {
    return this.pending.size;
  }

  admit(socket: Duplex, onReady: (socket: Duplex, rest: Buffer) => void): void {
    const max = this.opts.maxPending ?? PIPE_MAX_PENDING;
    while (this.pending.size >= max) {
      const oldest = this.pending.keys().next().value as Duplex;
      this.drop(oldest);
      this.evicted += 1;
      this.opts.onEvict?.(this.evicted);
    }
    const timers = this.opts.timers ?? realTimers;
    const onData = (chunk: Buffer): void => {
      const entry = this.pending.get(socket);
      if (entry === undefined) return;
      entry.buffered = Buffer.concat([entry.buffered, chunk]);
      const newline = entry.buffered.indexOf(0x0a);
      if (newline < 0) {
        if (entry.buffered.length > HELLO_MAX_BYTES) this.drop(socket);
        return;
      }
      if (newline > HELLO_MAX_BYTES) return this.drop(socket);
      const line = entry.buffered.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      const rest = entry.buffered.subarray(newline + 1);
      entry.buffered = Buffer.alloc(0);
      if (entry.challenge === undefined) this.onHello(socket, entry, line, rest);
      else this.onAuth(socket, entry, line, rest, onReady);
    };
    const timer = timers.setTimer(() => this.drop(socket), this.opts.helloTimeoutMs ?? PIPE_HELLO_TIMEOUT_MS);
    this.pending.set(socket, { socket, timer, onData, buffered: Buffer.alloc(0) });
    socket.on('data', onData);
    socket.once('close', () => this.forget(socket));
    socket.on('error', () => this.forget(socket));
  }

  /** Step 1→2: the client's `hello`; answer a fresh challenge, or refuse a version, or drop. */
  private onHello(socket: Duplex, entry: Pending, line: string, rest: Buffer): void {
    const hello = parseLine(line, 'hello');
    if (hello === null || typeof hello.nonce !== 'string' || !RANDOM_PATTERN.test(hello.nonce)) return this.drop(socket);
    if (hello.v !== PIPE_AUTH_VERSION) {
      this.forget(socket);
      socket.end(`${JSON.stringify({ type: 'hello-refused', v: PIPE_AUTH_VERSION, reason: 'version' })}\n`);
      return;
    }
    entry.nonce = hello.nonce;
    entry.challenge = randomBytes(32).toString('hex');
    socket.write(`${JSON.stringify({ type: 'challenge', v: PIPE_AUTH_VERSION, challenge: entry.challenge })}\n`);
    // A client that pipelined its `auth` behind the `hello` is handled at once.
    entry.buffered = rest;
    if (rest.indexOf(0x0a) >= 0) entry.onData(Buffer.alloc(0));
  }

  /** Step 3→4: the client's `auth`; prove the engine back only after the client's MAC verifies. */
  private onAuth(socket: Duplex, entry: Pending, line: string, rest: Buffer, onReady: (socket: Duplex, rest: Buffer) => void): void {
    const auth = parseLine(line, 'auth');
    const expected = clientMac(this.opts.key, entry.nonce!, entry.challenge!, this.opts.pipeName);
    if (auth === null || auth.v !== PIPE_AUTH_VERSION || !sameHex(auth.mac, expected)) return this.drop(socket);
    this.forget(socket);
    socket.write(`${JSON.stringify({ type: 'hello', v: PIPE_AUTH_VERSION, mac: serverMac(this.opts.key, entry.nonce!, entry.challenge!, this.opts.pipeName) })}\n`);
    onReady(socket, rest);
  }

  /** Close every unauthenticated connection (the service is closing). */
  closeAll(): void {
    for (const socket of [...this.pending.keys()]) this.drop(socket);
  }

  private forget(socket: Duplex): void {
    const entry = this.pending.get(socket);
    if (!entry) return;
    this.pending.delete(socket);
    (this.opts.timers ?? realTimers).clearTimer(entry.timer);
    socket.off('data', entry.onData);
  }

  /** Silently: nothing is written to a connection that never completed the handshake. */
  private drop(socket: Duplex): void {
    this.forget(socket);
    socket.destroy();
  }
}

function parseLine(line: string, type: 'hello' | 'auth'): Record<string, unknown> | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const record = json as Record<string, unknown>;
  if (record.type !== type || typeof record.v !== 'number' || !Number.isInteger(record.v)) return null;
  return record;
}

/** Why the bridge's handshake did not prove the engine. */
export type PipeHelloFailure = 'foreign' | 'version' | 'timeout' | 'closed';

/**
 * The bridge side: run the mutual handshake (send `hello`, answer the engine's `challenge` with the
 * client MAC, then check the engine's own MAC in constant time). Answers the bytes after the engine's
 * final line, which belong to the IPC framing, or why the pipe is not xezar's.
 */
export function pipeHello(
  socket: Duplex,
  auth: { readonly key: Buffer; readonly pipeName: string },
  timeoutMs: number,
): Promise<{ ok: true; rest: Buffer } | { ok: false; failure: PipeHelloFailure }> {
  return new Promise((resolve) => {
    const nonce = randomBytes(32).toString('hex');
    let buffered = Buffer.alloc(0);
    let challenge: string | undefined;
    let done = false;
    const finish = (outcome: { ok: true; rest: Buffer } | { ok: false; failure: PipeHelloFailure }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      resolve(outcome);
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) {
          if (buffered.length > HELLO_MAX_BYTES) finish({ ok: false, failure: 'foreign' });
          return;
        }
        const rawLine = buffered.subarray(0, newline).toString('utf8');
        const after = buffered.subarray(newline + 1);
        buffered = after;
        let answer: unknown;
        try {
          answer = JSON.parse(rawLine);
        } catch {
          return finish({ ok: false, failure: 'foreign' });
        }
        const record = (answer ?? {}) as Record<string, unknown>;
        if (record.type === 'hello-refused') return finish({ ok: false, failure: 'version' });
        if (challenge === undefined) {
          // Step 2: the engine's challenge. Answer with the client MAC, then await the engine's proof.
          if (record.type !== 'challenge' || typeof record.challenge !== 'string' || !RANDOM_PATTERN.test(record.challenge)) {
            return finish({ ok: false, failure: 'foreign' });
          }
          challenge = record.challenge;
          socket.write(`${JSON.stringify({ type: 'auth', v: PIPE_AUTH_VERSION, mac: clientMac(auth.key, nonce, challenge, auth.pipeName) })}\n`);
          continue;
        }
        // Step 4: the engine's own proof.
        if (record.type !== 'hello') return finish({ ok: false, failure: 'foreign' });
        const expected = serverMac(auth.key, nonce, challenge, auth.pipeName);
        return finish(sameHex(record.mac, expected) ? { ok: true, rest: after } : { ok: false, failure: 'foreign' });
      }
    };
    const onClose = (): void => finish({ ok: false, failure: 'closed' });
    const timer = setTimeout(() => finish({ ok: false, failure: 'timeout' }), Math.max(1, timeoutMs));
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.write(`${JSON.stringify({ type: 'hello', v: PIPE_AUTH_VERSION, nonce })}\n`);
  });
}
