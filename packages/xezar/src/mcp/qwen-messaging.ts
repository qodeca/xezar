import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Push into a Qwen Code leader session (#1045). The research note
 * `docs/research/qwen-code-leader-push-2026-10-16.md` is the evidence; this is its "what this means".
 *
 * Qwen Code (0.25.2 and newer) gives every process it starts — so every MCP server, `xezar mcp`
 * included — the address of the session's own inbox (`QWEN_CODE_MESSAGING_SOCKET`) and a child
 * token (`QWEN_CODE_MESSAGING_TOKEN`). A message sent with that token is accepted without review in
 * every approval mode, and Qwen Code shows it to the model as coming from a process the session
 * started, not from the user. The bridge is that child, so the bridge sends; the service never
 * touches the socket.
 *
 * One message on the wire is two lines on one connection: an `auth` frame, then a `user` frame whose
 * `from` names a socket xezar listens on. Qwen Code answers there with a receipt per message:
 * `delivered` is a hand-over; `held` (parked for the user to review), `dropped` (rate limit,
 * duplicate, full queue) and silence are not, so the push fails and the rows stay unacknowledged for
 * the next dispatch. Qwen Code accepts a burst of 30, then one message per 2 s, per sender, so sends
 * are serialized and paced by a token bucket: `QWEN_SEND_BURST` at once, then one per
 * `QWEN_MIN_SEND_GAP_MS`. xezar already sends one message per dispatch, so the bucket is rarely
 * empty.
 *
 * The variables are read when the bridge starts, from its own environment. Absent ones are the
 * start-order race the note describes (or messaging switched off in the person's Qwen settings): the
 * bridge then reports that it cannot push, and the leader reads its events instead.
 */

/** The prefix of the MCP `clientInfo.name` Qwen Code sends: `qwen-cli-mcp-client-<server name>` (0.25.2). */
export const QWEN_MCP_CLIENT_PREFIX = 'qwen-cli-mcp-client-';
export const QWEN_MESSAGING_SOCKET_ENV = 'QWEN_CODE_MESSAGING_SOCKET';
export const QWEN_MESSAGING_TOKEN_ENV = 'QWEN_CODE_MESSAGING_TOKEN';

/** Qwen Code's own frame version for cross-session messages (0.25.2). */
const PEER_FRAME_VERSION = 1;
/** Qwen Code's per-sender refill: one message per 2 s once the burst is spent. */
export const QWEN_MIN_SEND_GAP_MS = 2_000;
/** Below Qwen Code's burst of 30, so a send is never dropped for speed. */
export const QWEN_SEND_BURST = 20;
/** How long a receipt may take. A live session answers in well under a second (the note, scenario c). */
export const QWEN_RECEIPT_TIMEOUT_MS = 10_000;

/** Is this MCP client Qwen Code? Its name carries the configured server name, so it is a prefix. */
export function isQwenClientName(name: string | undefined): boolean {
  return name !== undefined && name.startsWith(QWEN_MCP_CLIENT_PREFIX) && name.length > QWEN_MCP_CLIENT_PREFIX.length;
}

export interface QwenInbox {
  readonly socketPath: string;
  readonly token: string;
}

/** The session's inbox from an environment, or undefined when Qwen Code gave this process none. */
export function qwenInboxFrom(env: NodeJS.ProcessEnv): QwenInbox | undefined {
  const socketPath = env[QWEN_MESSAGING_SOCKET_ENV]?.trim();
  const token = env[QWEN_MESSAGING_TOKEN_ENV]?.trim();
  return socketPath && token ? { socketPath, token } : undefined;
}

/**
 * Where the receipt listener binds. A Unix socket in a private temp folder on Linux and macOS; a
 * named pipe on Windows, where Qwen Code's own inbox is one too.
 */
export function receiptAddress(dir: string, id: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `\\\\.\\pipe\\xezar-qwen-receipt-${id}` : join(dir, 'r.sock');
}

/** What one send came to, in Qwen Code's own receipt words. */
export type QwenReceipt = 'delivered' | 'held' | 'dropped' | 'refused' | 'expired' | 'misaddressed' | 'timeout';

export interface QwenMessengerOptions {
  readonly inbox: QwenInbox;
  /** Shown in the session next to each message (`name="xezar"`). */
  readonly fromName?: string;
  readonly receiptTimeoutMs?: number;
  readonly minGapMs?: number;
  readonly burst?: number;
  /** Test seams. */
  readonly now?: () => number;
}

/**
 * Sends one message at a time into a Qwen Code session's inbox and resolves on its `delivered`
 * receipt. Never throws synchronously; a failed send rejects with a sentence that names the receipt.
 */
export class QwenMessenger {
  readonly #opts: QwenMessengerOptions;
  readonly #now: () => number;
  readonly #waiting = new Map<string, (receipt: QwenReceipt, reason?: string) => void>();
  #queue: Promise<unknown> = Promise.resolve();
  /** Sends left in the bucket at `#refilledAt`. */
  #tokens: number;
  #refilledAt: number;
  #listener: { server: Server; address: string; dir: string } | undefined;
  #closed = false;

  constructor(opts: QwenMessengerOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#tokens = opts.burst ?? QWEN_SEND_BURST;
    this.#refilledAt = this.#now();
  }

  /** Queue one message. Resolves once Qwen Code says `delivered`. */
  send(content: string): Promise<void> {
    const run = this.#queue.then(() => this.#sendNow(content));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.#closed = true;
    for (const settle of this.#waiting.values()) settle('timeout', 'the bridge stopped');
    this.#waiting.clear();
    const listener = this.#listener;
    this.#listener = undefined;
    if (listener) {
      listener.server.close();
      try {
        rmSync(listener.dir, { recursive: true, force: true });
      } catch {
        // A temp folder; failing to remove it never concerns the session.
      }
    }
  }

  async #sendNow(content: string): Promise<void> {
    if (this.#closed) throw new Error('the xezar bridge is closing, so nothing was sent to Qwen Code');
    this.#takeToken();
    const from = await this.#receiptListener();
    const msgId = `xz-${randomUUID()}`;
    const receipt = new Promise<{ receipt: QwenReceipt; reason?: string }>((resolve) => {
      const timer = setTimeout(() => settle('timeout'), this.#opts.receiptTimeoutMs ?? QWEN_RECEIPT_TIMEOUT_MS);
      const settle = (value: QwenReceipt, reason?: string): void => {
        clearTimeout(timer);
        this.#waiting.delete(msgId);
        resolve(reason === undefined ? { receipt: value } : { receipt: value, reason });
      };
      this.#waiting.set(msgId, settle);
    });
    const frames =
      `${JSON.stringify({ msgV: PEER_FRAME_VERSION, type: 'auth', token: this.#opts.inbox.token })}\n` +
      `${JSON.stringify({ msgV: PEER_FRAME_VERSION, msgId, type: 'user', from, fromName: this.#opts.fromName ?? 'xezar', message: { role: 'user', content } })}\n`;
    try {
      await writeAndClose(this.#opts.inbox.socketPath, frames);
    } catch (err) {
      this.#waiting.get(msgId)?.('timeout');
      throw new Error(`could not reach the Qwen Code session's inbox (${err instanceof Error ? err.message : String(err)})`);
    }
    const answer = await receipt;
    if (answer.receipt !== 'delivered') {
      throw new Error(`Qwen Code did not take the message (${answer.receipt}${answer.reason ? `: ${answer.reason}` : ''})`);
    }
  }

  /**
   * Spend one send from the bucket, or refuse at once when it is empty. Never waits: a send that
   * waited could outlive the delivery attempt that asked for it, reach the session after the attempt
   * was counted as failed, and arrive twice. A refusal is an ordinary failed attempt, which the
   * delivery controller retries.
   */
  #takeToken(): void {
    const gapMs = this.#opts.minGapMs ?? QWEN_MIN_SEND_GAP_MS;
    const burst = this.#opts.burst ?? QWEN_SEND_BURST;
    const now = this.#now();
    const refill = Math.floor((now - this.#refilledAt) / gapMs);
    if (refill > 0) {
      this.#tokens = Math.min(burst, this.#tokens + refill);
      this.#refilledAt = this.#tokens === burst ? now : this.#refilledAt + refill * gapMs;
    }
    if (this.#tokens <= 0) {
      // The wait is the caller's to make (the adapter, inside its own attempt and abort signal):
      // a wait here, in the serialised send queue, would outlive an attempt and send late.
      const freeInMs = Math.max(0, this.#refilledAt + gapMs - now);
      throw new Error(`xezar is sending to this Qwen Code session faster than it accepts messages, so this one waits for the next attempt; the next send is free in ${freeInMs} ms`);
    }
    this.#tokens -= 1;
  }

  async #receiptListener(): Promise<string> {
    if (this.#listener) return this.#listener.address;
    const dir = mkdtempSync(join(tmpdir(), 'xez-qwen-'));
    const address = receiptAddress(dir, randomUUID());
    const server = createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let at: number;
        while ((at = buffer.indexOf('\n')) >= 0) {
          this.#receipt(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
        }
      });
      socket.on('end', () => {
        if (buffer.trim()) this.#receipt(buffer);
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.unref();
    this.#listener = { server, address, dir };
    return address;
  }

  /** One receipt line: `{"type":"control","status":…,"origMsgId":…}` (0.25.2). Anything else is ignored. */
  #receipt(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof frame !== 'object' || frame === null) return;
    const record = frame as Record<string, unknown>;
    if (record.type !== 'control' || typeof record.origMsgId !== 'string') return;
    const status = typeof record.status === 'string' ? record.status : '';
    const known: readonly QwenReceipt[] = ['delivered', 'held', 'dropped', 'refused', 'expired', 'misaddressed'];
    const receipt = (known as readonly string[]).includes(status) ? (status as QwenReceipt) : undefined;
    if (receipt === undefined) return;
    const reason = typeof record.reason === 'string' ? record.reason.slice(0, 200) : undefined;
    this.#waiting.get(record.origMsgId)?.(receipt, reason);
  }
}

/** Write the frames on one connection and close it. Resolves once the peer has the bytes. */
function writeAndClose(path: string, frames: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    let settled = false;
    const done = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(QWEN_RECEIPT_TIMEOUT_MS, () => {
      socket.destroy();
      done(new Error('the inbox did not accept the connection in time'));
    });
    socket.once('error', (err) => done(err));
    socket.once('connect', () => socket.end(frames, () => done()));
  });
}
