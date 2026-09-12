import { createConnection, type Socket } from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type { PiRpcLink, PiRpcMessage, PiRpcResponse } from './pi.ts';

/**
 * The thing that was missing (#330 WP2, QA round two): something that PRODUCES a `PiRpcLink`.
 *
 * `adapters/pi.ts` was complete, tested and evidenced, and never constructed in production, because
 * `piReactionTarget` builds an adapter only from a live link and nothing in the repository made one.
 * This module is that producer, and `leader-delivery.ts` is its caller.
 *
 * ## Why a socket the EXTENSION opens, rather than one xezar opens
 *
 * pi's RPC is stdio-only and spawn-only — no port, no socket, no attach (`pi --help` and
 * `docs/rpc.md` on 0.85.1, re-confirmed twice) — and xezar starts no agent process for a leader
 * (owner decision on #311). So the only way into a pi the PERSON runs is from inside it: a pi
 * extension, which may call `pi.sendUserMessage(…)` — documented "Always triggers a turn" — and
 * which runs unsandboxed and may therefore open a socket (`docs/security.md` § No Built-in Sandbox;
 * the already-required `pi-mcp-adapter` opens one today).
 *
 * Given that, the extension is the side that has an address to offer, so IT listens and xezar dials.
 * Three things follow, all of them deliberate:
 *
 *  - **xezar opens no new listener.** § Zero config asks that a feature widening exposure be opt-in;
 *    dialling a socket that only exists because the person installed and ran the extension is
 *    demand-driven by construction. Nothing listens on xezar's side, so there is nothing to secure.
 *  - **It is the same shape as OpenCode.** `attach` names a session the person runs. For OpenCode
 *    that address is a URL they paste; for pi it is a descriptor the extension writes into the
 *    project's own data directory, so the person pastes nothing (§ Zero config: discover it).
 *  - **Absent means exactly today's behaviour.** No extension, no descriptor, no link — and
 *    `piReactionTarget` answers with the recoverable `pi-not-addressable` blocker, unchanged. This
 *    module can only ever ADD a working path; it can never take the old one away.
 *
 * ## Trust
 *
 * The descriptor is read ONLY from the project's own `dataDir`, which is xezar's own state directory
 * (`<repo>/.local/xezar`, gitignored, written by this service). A socket path is taken from it and
 * dialled; nothing else in the file reaches a decision. That is the same trust the MCP connection
 * file already has, in the same directory, and it is why the path is never accepted from a request.
 *
 * Keeping other local accounts OFF that socket is the extension's job, not this file's, and an
 * earlier version of this comment claimed it wrongly: it said the socket "lives in a directory only
 * this user can enter", which on Linux with no `TMPDIR` was `/tmp` at mode `1777` and was false (QA
 * on #358). The extension now creates its own `0700` directory and puts the socket inside — the
 * DIRECTORY is the portable guard, because Linux enforces permissions on a Unix socket and macOS and
 * the BSDs do not. See `scripts/pi-leader-extension.ts` § `makePrivateSocketDir`.
 */

/** Additive changes keep version 1 (N-08); an incompatible one bumps it. */
export const PI_LEADER_SCHEMA_VERSION = 1;

export const PI_LEADER_FILE = 'pi-leader.json';

/**
 * What the extension writes once its socket really listens, so the file never names nothing — the
 * same ordering rule D-04 gives the MCP connection file. No secret: which socket the peer reached is
 * the binding (D-01 § 6), and the socket lives in a directory only this user can enter.
 */
export const piLeaderDescriptorSchema = z.object({
  schemaVersion: z.literal(PI_LEADER_SCHEMA_VERSION),
  session: z.object({
    pid: z.number().int().positive(),
    startedAt: z.string(),
    /** pi's own session id, for the cockpit to show. Never the identity anything trusts. */
    sessionId: z.string().max(200).optional(),
  }),
  endpoint: z.object({ socket: z.string().min(1).max(1024) }),
});
export type PiLeaderDescriptor = z.infer<typeof piLeaderDescriptorSchema>;

export function piLeaderPath(dataDir: string): string {
  return join(dataDir, PI_LEADER_FILE);
}

/**
 * Read the descriptor, or say why there is none. Never throws: every failure is a reason a person
 * can act on, because this runs on the `attach` path and the answer is shown to them.
 */
export function readPiLeaderDescriptor(dataDir: string): { ok: true; descriptor: PiLeaderDescriptor } | { ok: false; reason: string } {
  let raw: string;
  try {
    raw = readFileSync(piLeaderPath(dataDir), 'utf8');
  } catch {
    return { ok: false, reason: 'no pi leader has announced itself to this project' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${PI_LEADER_FILE} is not valid JSON` };
  }
  const result = piLeaderDescriptorSchema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: `${PI_LEADER_FILE} is not a descriptor this xezar understands` };
  // A descriptor whose socket is gone is a pi that exited without cleaning up. Say that, rather than
  // letting the dial fail with an errno the person cannot read.
  try {
    if (!statSync(result.data.endpoint.socket).isSocket()) {
      return { ok: false, reason: 'the pi leader socket named in ' + PI_LEADER_FILE + ' is not a socket' };
    }
  } catch {
    return { ok: false, reason: 'the pi leader that wrote ' + PI_LEADER_FILE + ' is gone (its socket no longer exists)' };
  }
  return { ok: true, descriptor: result.data };
}

/** One line is one JSON value, LF-delimited — pi's own RPC framing (`docs/rpc.md` § Framing). */
const MAX_LINE_BYTES = 1_000_000;

export interface PiLeaderLink extends PiRpcLink {
  /** Hang up. The pi process and its session belong to the person; only this socket is dropped. */
  close(): void;
}

export interface ConnectPiLeaderOptions {
  /** How long one command may wait for its `response` before it is treated as lost. */
  readonly requestTimeoutMs?: number;
  readonly warn?: (message: string) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Dial the extension's socket and present it as a `PiRpcLink`.
 *
 * The wire is pi's OWN RPC vocabulary — `{id, type:'prompt'|'steer'|'get_state'|'get_messages'}` out,
 * `{type:'response', id, success, data}` and pi's event frames back — so the adapter above is
 * unchanged by this file existing, and a future transport can replace it without touching either.
 * Framing follows `docs/rpc.md`: split on `\n` only, tolerate a trailing `\r`, and never a generic
 * line reader (Node's `readline` also splits on U+2028/U+2029, which are legal inside JSON strings).
 */
export function connectPiLeaderLink(descriptor: PiLeaderDescriptor, opts: ConnectPiLeaderOptions = {}): PiLeaderLink {
  const socket: Socket = createConnection({ path: descriptor.endpoint.socket });
  socket.setNoDelay(true);
  socket.setEncoding('utf8');
  return wrapPiLeaderSocket(socket, opts);
}

/**
 * The half that has nothing to do with `node:net`, so a test can drive it with a pair of pipes and
 * still exercise the real framing, the real correlation and the real close semantics.
 */
export function wrapPiLeaderSocket(socket: Socket, opts: ConnectPiLeaderOptions = {}): PiLeaderLink {
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const listeners = new Set<(message: PiRpcMessage) => void>();
  const pending = new Map<string, { resolve: (value: PiRpcResponse) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  let closed = false;
  let nextId = 0;
  let buffer = '';

  const failAll = (err: Error): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  };

  const shutdown = (err: Error): void => {
    if (closed) return;
    closed = true;
    failAll(err);
    listeners.clear();
    socket.destroy();
  };

  socket.on('data', (chunk: string) => {
    buffer += chunk;
    // A peer that never sends a newline must not grow this without bound.
    if (buffer.length > MAX_LINE_BYTES) {
      shutdown(new Error('the pi leader sent a line longer than the protocol allows'));
      return;
    }
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // One unreadable line is not a reason to drop a working leader; pi's own clients skip it.
        opts.warn?.('[xez] a line from the pi leader was not JSON and was ignored');
        continue;
      }
      if (typeof value !== 'object' || value === null) continue;
      const message = value as PiRpcMessage;
      const id = typeof message.id === 'string' ? message.id : undefined;
      if (message.type === 'response' && id !== undefined) {
        const entry = pending.get(id);
        if (entry) {
          pending.delete(id);
          clearTimeout(entry.timer);
          entry.resolve({
            success: message.success === true,
            ...(isRecord(message.data) ? { data: message.data } : {}),
            ...(message.error === undefined ? {} : { error: message.error }),
          });
        }
        continue;
      }
      // Everything else is one of pi's events, passed through untouched: this file knows the
      // framing, and `adapters/pi.ts` alone knows what the events MEAN.
      for (const listener of [...listeners]) listener(message);
    }
  });

  socket.on('error', (err: Error) => shutdown(err));
  socket.on('close', () => shutdown(new Error('the pi leader closed its connection to xezar')));

  return {
    get closed() {
      return closed || socket.destroyed;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(command) {
      if (closed || socket.destroyed) throw new Error('the pi leader link is closed');
      const id = `xez-${++nextId}`;
      return await new Promise<PiRpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          // Deliberately a REJECT, not a failed response: "we do not know whether pi saw it" and
          // "pi refused it" are different answers, and the adapter treats only the first as
          // uncertain and re-reads the conversation before it decides (`#uncertain`).
          reject(new Error('the pi leader did not answer in time'));
        }, timeoutMs);
        // `unref` so a hung leader can never hold the process open at shutdown.
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        try {
          socket.write(`${JSON.stringify({ ...command, id })}\n`);
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    close() {
      shutdown(new Error('xezar closed the pi leader link'));
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
