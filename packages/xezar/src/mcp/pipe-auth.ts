/**
 * The pre-authentication stage of a Windows MCP pipe (#963).
 *
 * A Windows named pipe lets any local account open it for reading, and a name an exited engine
 * left can be created again by anyone. So before the first IPC frame the bridge sends
 * `hello { v, nonce }`, and the engine answers `HMAC-SHA256(key, nonce ‖ pipeName)` with the key
 * only the engine and the private endpoint file hold (`pipe-endpoint.ts`). The bridge checks the
 * answer in constant time; anything else is not xezar.
 *
 * The engine writes nothing to a connection before a valid `hello`: anything else, or nothing
 * within `helloTimeoutMs`, is closed silently. A `hello` of another version gets one refusal line.
 * At most `maxPending` connections may wait unauthenticated; the next one evicts the oldest, so
 * idle connections cannot fill the slots and lock the bridge out.
 *
 * Only the pipe branch uses this: the POSIX socket is owner-only by its own mode, unchanged.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';

export const PIPE_AUTH_VERSION = 1;
/** How long an unauthenticated connection may wait for its `hello`. */
export const PIPE_HELLO_TIMEOUT_MS = 1_000;
/** Unauthenticated connections at once; the next evicts the oldest. */
export const PIPE_MAX_PENDING = 16;
/** A `hello` line is far shorter than this; a longer first line is not one. */
const HELLO_MAX_BYTES = 1_024;
const NONCE_PATTERN = /^[0-9a-f]{64}$/;

export function pipeMac(key: Buffer, nonce: string, pipeName: string): string {
  return createHmac('sha256', key).update(nonce, 'utf8').update(pipeName, 'utf8').digest('hex');
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
}

/** The engine side: admits each new connection, and hands it on only after a valid `hello`. */
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
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        if (buffered.length > HELLO_MAX_BYTES) this.drop(socket);
        return;
      }
      if (newline > HELLO_MAX_BYTES) return this.drop(socket);
      const line = buffered.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      const rest = buffered.subarray(newline + 1);
      const hello = parseHello(line);
      if (hello === null) return this.drop(socket);
      if (hello.v !== PIPE_AUTH_VERSION) {
        this.forget(socket);
        socket.end(`${JSON.stringify({ type: 'hello-refused', v: PIPE_AUTH_VERSION, reason: 'version' })}\n`);
        return;
      }
      this.forget(socket);
      socket.write(`${JSON.stringify({ type: 'hello', v: PIPE_AUTH_VERSION, mac: pipeMac(this.opts.key, hello.nonce, this.opts.pipeName) })}\n`);
      onReady(socket, rest);
    };
    const timer = timers.setTimer(() => this.drop(socket), this.opts.helloTimeoutMs ?? PIPE_HELLO_TIMEOUT_MS);
    this.pending.set(socket, { socket, timer, onData });
    socket.on('data', onData);
    socket.once('close', () => this.forget(socket));
    socket.on('error', () => this.forget(socket));
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

  /** Silently: nothing is written to a connection that never said a valid `hello`. */
  private drop(socket: Duplex): void {
    this.forget(socket);
    socket.destroy();
  }
}

function parseHello(line: string): { v: number; nonce: string } | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const { type, v, nonce } = json as Record<string, unknown>;
  if (type !== 'hello' || typeof v !== 'number' || !Number.isInteger(v)) return null;
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return null;
  return { v, nonce };
}

/** Why the bridge's `hello` did not prove the engine. */
export type PipeHelloFailure = 'foreign' | 'version' | 'timeout' | 'closed';

/**
 * The bridge side: send `hello`, read the first line, check the MAC in constant time. Answers the
 * bytes after the answer line, which belong to the IPC framing, or why the pipe is not xezar's.
 */
export function pipeHello(
  socket: Duplex,
  auth: { readonly key: Buffer; readonly pipeName: string },
  timeoutMs: number,
): Promise<{ ok: true; rest: Buffer } | { ok: false; failure: PipeHelloFailure }> {
  return new Promise((resolve) => {
    const nonce = randomBytes(32).toString('hex');
    const expected = Buffer.from(pipeMac(auth.key, nonce, auth.pipeName), 'utf8');
    let buffered = Buffer.alloc(0);
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
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        if (buffered.length > HELLO_MAX_BYTES) finish({ ok: false, failure: 'foreign' });
        return;
      }
      let answer: unknown;
      try {
        answer = JSON.parse(buffered.subarray(0, newline).toString('utf8'));
      } catch {
        return finish({ ok: false, failure: 'foreign' });
      }
      const { type, mac } = (answer ?? {}) as Record<string, unknown>;
      if (type === 'hello-refused') return finish({ ok: false, failure: 'version' });
      if (type !== 'hello' || typeof mac !== 'string') return finish({ ok: false, failure: 'foreign' });
      const got = Buffer.from(mac, 'utf8');
      const same = got.length === expected.length && timingSafeEqual(got, expected);
      finish(same ? { ok: true, rest: buffered.subarray(newline + 1) } : { ok: false, failure: 'foreign' });
    };
    const onClose = (): void => finish({ ok: false, failure: 'closed' });
    const timer = setTimeout(() => finish({ ok: false, failure: 'timeout' }), Math.max(1, timeoutMs));
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.write(`${JSON.stringify({ type: 'hello', v: PIPE_AUTH_VERSION, nonce })}\n`);
  });
}
