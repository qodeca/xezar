import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mcpProjectOccupiedErrorSchema, mcpSessionExpiredErrorSchema } from '@qodeca/xezar-contract';
import { z } from 'zod';
import { xezarHomeDir } from '../paths.ts';

/**
 * The IPC leg between `xez mcp` (the bridge) and the running xezar service — D-01
 * (docs/features/mcp-server/mcp-d01-transport-decision.md) § 1.2–1.5.
 *
 * One Unix domain socket per registered project, owned by the service, at
 * `<xezarHomeDir()>/ipc/<projectId>.sock` (dir 0700, socket 0600). Frames are
 * newline-delimited JSON, the same framing as the stdio leg. The socket IS the
 * project binding (§ 1.5): no frame carries a project field, and the service answers
 * only for the project it opened the socket for.
 *
 * Both sides import this file, so the path rule and the frame shapes cannot drift.
 * They may still come from different installed versions (`npx` vs a global
 * install), which is what `IPC_PROTOCOL_VERSION` is for.
 */

/**
 * Bumped only when a frame shape changes incompatibly. Carried on every request.
 *
 * 2 (#302): a connection is a SESSION. The bridge keeps one connection for its whole life, opens
 * the session on it with `session/open` (which acquires the project's owner slot, D-02), and every
 * `health` / `tools/call` needs that live session. A version-1 bridge — one connection per call,
 * no session — would be refused on every call anyway; the version check refuses it legibly first.
 */
export const IPC_PROTOCOL_VERSION = 2;

/**
 * Largest frame either leg accepts, in bytes: 32 MiB + 64 KiB. Taken from D-09 B-08
 * (qodeca/xezar#206, not yet merged at the time of writing) so the bridge does not
 * invent a second number. A larger frame is refused with an explicit error and
 * closes nothing else.
 */
export const MAX_FRAME_BYTES = 33_619_968;

/**
 * How long the bridge waits for the service to answer one request — D-09 B-09
 * (qodeca/xezar#206): 55 s. On expiry the bridge answers with a readable result;
 * the service operation is not cancelled. There is no retry (D-01 § 5, D-09 B-16).
 */
export const IPC_REQUEST_TIMEOUT_MS = 55_000;

/**
 * How long the bridge waits to connect and open its session. Acquisition itself is bounded far
 * below this (D-02.2: 5 attempts, at most 375 ms of backoff), so only a hung service reaches it.
 * It is short because `initialize` waits on it, and a client gives up on a server whose handshake
 * is slow — Codex's documented default startup timeout is 10 s (not re-measured here). On expiry
 * the handshake still succeeds with no session (N-07) and the next call tries again.
 */
export const IPC_SESSION_OPEN_TIMEOUT_MS = 5_000;

// ---- socket path ---------------------------------------------------------------

/**
 * The longest socket path the OS accepts, in bytes. An operating-system constant
 * (`sun_path`), not a xezar choice: macOS/BSD measured 104 OK and 105 EINVAL
 * (D-01 E5); Linux reserves 108 bytes including the terminating NUL.
 */
function maxSocketPathBytes(platform: NodeJS.Platform): number {
  return platform === 'linux' ? 107 : 104;
}

export type McpSocketLocation =
  | { readonly kind: 'socket'; readonly path: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Where the service listens for `projectId`, and where the bridge connects. Pure:
 * both sides compute it from the same registry entry, so they always agree.
 *
 * D-01 § 1.4: when `<home>/ipc/<projectId>.sock` is longer than the OS allows, the
 * first 12 hex characters of SHA-256(project root) replace the id. When even that
 * is too long (a very long `XEZ_HOME`), there is no socket — the caller degrades.
 * Windows named pipes are untested and their naming is undecided (D-01 § 10.2), so
 * Windows is reported as unavailable rather than guessed.
 */
export function mcpSocketLocation(
  project: { readonly id: string; readonly root: string },
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): McpSocketLocation {
  if (platform === 'win32') {
    return { kind: 'unavailable', reason: 'the xezar MCP bridge is not supported on Windows yet' };
  }
  const dir = mcpSocketDir(env);
  const limit = maxSocketPathBytes(platform);
  const primary = join(dir, `${project.id}.sock`);
  if (Buffer.byteLength(primary) <= limit) return { kind: 'socket', path: primary };
  const hashed = join(dir, `${createHash('sha256').update(project.root).digest('hex').slice(0, 12)}.sock`);
  if (Buffer.byteLength(hashed) <= limit) return { kind: 'socket', path: hashed };
  return {
    kind: 'unavailable',
    reason: `the xezar home path is too long for a local socket on this system (limit ${limit} bytes) — point XEZ_HOME at a shorter directory`,
  };
}

/** `<xezarHomeDir()>/ipc` — the only directory the service creates for MCP. */
export function mcpSocketDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(xezarHomeDir(env), 'ipc');
}

// ---- frames --------------------------------------------------------------------

/** A tool result exactly as MCP carries it: the text block is authoritative. */
export const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});
export type McpToolResult = z.infer<typeof toolResultSchema>;

/** What `health` answers. No account identity and no path — F-12, N-01, F-15. */
export const healthResultSchema = z.object({
  ipcVersion: z.number().int(),
  xezarVersion: z.string().max(64),
  project: z.object({ id: z.string().max(64), name: z.string().max(200) }),
});
export type HealthResult = z.infer<typeof healthResultSchema>;

export const toolCallParamsSchema = z.object({
  name: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Bridge → service. `v` is checked BEFORE the method is looked at, so a service
 * can refuse a bridge from another protocol version legibly. `bridgeVersion` is the
 * bridge's xezar version, for diagnostics only.
 */
export const ipcRequestSchema = z.object({
  v: z.number().int(),
  id: z.number().int().nonnegative(),
  bridgeVersion: z.string().max(64).optional(),
  method: z.string().min(1).max(64),
  params: z.unknown().optional(),
});
export type IpcRequest = z.infer<typeof ipcRequestSchema>;

export const ipcErrorCodeSchema = z.enum([
  'bad-frame',
  'version-mismatch',
  'unknown-method',
  'invalid-params',
  'unknown-tool',
  'internal',
  /** `session/open` while another session owns the project (D-02 § 4, `-32080`). */
  'project-occupied',
  /** A call on a connection whose session does not own the project (D-02 § 4, `-32081`). */
  'session-expired',
]);

/**
 * The JSON-RPC error the bridge hands the client verbatim for the two ownership refusals. The
 * contract's schemas are `.strict()`, so nothing about the competing owner can ride along (N-01).
 */
export const ownershipRpcErrorSchema = z.union([mcpProjectOccupiedErrorSchema, mcpSessionExpiredErrorSchema]);

/** What `session/open` answers: this connection's session now owns the project. */
export const sessionOpenResultSchema = z.object({ owner: z.literal(true) });

/** Service → bridge. */
export const ipcResponseSchema = z.discriminatedUnion('ok', [
  z.object({ v: z.number().int(), id: z.number().int().nullable(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    v: z.number().int(),
    id: z.number().int().nullable(),
    ok: z.literal(false),
    error: z.object({ code: ipcErrorCodeSchema, message: z.string().max(2000) }),
    /** The service's xezar version, so a mismatch message can name both sides. */
    serviceVersion: z.string().max(64).optional(),
    /** Only on `project-occupied` / `session-expired`: the D-02 § 4 error the client receives. */
    rpcError: ownershipRpcErrorSchema.optional(),
  }),
]);
export type IpcResponse = z.infer<typeof ipcResponseSchema>;

// ---- framing -------------------------------------------------------------------

/**
 * Split a byte stream into newline-delimited frames. A frame over `maxBytes` is
 * reported once through `onOversize` and skipped up to its newline; the stream
 * keeps working (D-09 B-08: "closes nothing else").
 */
export class LineFramer {
  private chunks: Buffer[] = [];
  private size = 0;
  private discarding = false;

  constructor(
    private readonly onFrame: (line: string) => void,
    private readonly onOversize: () => void,
    private readonly maxBytes: number = MAX_FRAME_BYTES,
  ) {}

  push(chunk: Buffer): void {
    let start = 0;
    for (let nl = chunk.indexOf(0x0a, start); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
      this.append(chunk.subarray(start, nl));
      this.flushFrame();
      start = nl + 1;
    }
    this.append(chunk.subarray(start));
  }

  private append(part: Buffer): void {
    if (this.discarding || part.length === 0) return;
    if (this.size + part.length > this.maxBytes) {
      this.chunks = [];
      this.size = 0;
      this.discarding = true;
      this.onOversize();
      return;
    }
    this.chunks.push(part);
    this.size += part.length;
  }

  private flushFrame(): void {
    const wasDiscarding = this.discarding;
    const line = Buffer.concat(this.chunks, this.size).toString('utf8').replace(/\r$/, '');
    this.chunks = [];
    this.size = 0;
    this.discarding = false;
    if (!wasDiscarding && line.trim() !== '') this.onFrame(line);
  }
}

/** One frame on the wire. `JSON.stringify` never emits a raw newline. */
export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
