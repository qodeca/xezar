/**
 * The Windows MCP rendezvous (#963): a named pipe whose name changes every start, found through
 * two files in the private IPC folder.
 *
 * - `<id>.key` – the endpoint: `{ v, pipeName, key, pid, processStartTime }`, written first and
 *   atomically, owner-only. The 32-byte `key` lets the bridge check that the pipe it reached is
 *   served by the engine that wrote the file (`pipe-auth.ts`); `pid` and `processStartTime` let it
 *   refuse a stale name before it connects, so a name an exited engine left is never dialled.
 * - `<id>.pipe` – the marker: the pipe name alone on one line, written after the endpoint. It is
 *   the external leader launcher's contract (a regular file of at most 256 bytes, one name
 *   matching `PIPE_NAME_PATTERN`); this module never trusts it without the endpoint.
 *
 * Both are read strictly: a regular file, never a link, size-capped, parsed exactly. Start and
 * close hold `<id>.lock` (`core/file-lock.ts`), and close removes a file only while it still names
 * this engine's pipe.
 */
import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomicSync } from '../platform/atomic-write.ts';
import { checkPrivateDir, type PrivateDirDeps } from '../platform/private-dir.ts';
import { pidExists } from '../platform/process-proof.ts';

/** `\\.\pipe\xezar-mcp-` and 32 lower-case hex characters: the launcher's draft contract. */
export const PIPE_NAME_PATTERN = /^\\\\\.\\pipe\\xezar-mcp-[0-9a-f]{32}$/;
export const PIPE_ENDPOINT_VERSION = 1;
const MARKER_MAX_BYTES = 256;
const ENDPOINT_MAX_BYTES = 4_096;

export interface PipeFiles {
  readonly dir: string;
  /** `<id>.pipe` */
  readonly marker: string;
  /** `<id>.key` */
  readonly endpoint: string;
  /** `<id>.lock` */
  readonly lock: string;
}

export function pipeFiles(dir: string, projectId: string): PipeFiles {
  return {
    dir,
    marker: join(dir, `${projectId}.pipe`),
    endpoint: join(dir, `${projectId}.key`),
    lock: join(dir, `${projectId}.lock`),
  };
}

export const pipeEndpointSchema = z
  .object({
    v: z.literal(PIPE_ENDPOINT_VERSION),
    pipeName: z.string().regex(PIPE_NAME_PATTERN),
    key: z.string().regex(/^[0-9a-f]{64}$/),
    pid: z.number().int().positive(),
    processStartTime: z.number().int().positive(),
  })
  .strict();

export type PipeEndpoint = z.infer<typeof pipeEndpointSchema>;

/** A fresh, unguessable pipe name. */
export function newPipeName(): string {
  return `\\\\.\\pipe\\xezar-mcp-${randomBytes(16).toString('hex')}`;
}

/** A fresh 32-byte key, as hex. */
export function newPipeKey(): string {
  return randomBytes(32).toString('hex');
}

export type ReadFailure = 'missing' | 'invalid';

/** The bytes of a regular file of at most `max` bytes – never a link, a folder or a device. */
function readSmallRegularFile(path: string, max: number): Buffer | ReadFailure {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
  }
  if (!stat.isFile() || stat.size > max) return 'invalid';
  try {
    const bytes = readFileSync(path);
    return bytes.length > max ? 'invalid' : bytes;
  } catch {
    return 'invalid';
  }
}

export function readPipeEndpoint(path: string): PipeEndpoint | ReadFailure {
  const bytes = readSmallRegularFile(path, ENDPOINT_MAX_BYTES);
  if (typeof bytes === 'string') return bytes;
  try {
    const parsed = pipeEndpointSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    return parsed.success ? parsed.data : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** The marker's pipe name: the whole file, one trailing line break allowed. */
export function readPipeMarker(path: string): string | ReadFailure {
  const bytes = readSmallRegularFile(path, MARKER_MAX_BYTES);
  if (typeof bytes === 'string') return bytes;
  const name = bytes.toString('utf8').replace(/\r?\n$/, '');
  return PIPE_NAME_PATTERN.test(name) ? name : 'invalid';
}

/** The endpoint, then the marker – both atomic, owner-only. */
export function writePipeFiles(files: PipeFiles, endpoint: PipeEndpoint): void {
  writeFileAtomicSync(files.endpoint, `${JSON.stringify(endpoint)}\n`, { mode: 0o600, tempMode: 0o600 });
  writeFileAtomicSync(files.marker, `${endpoint.pipeName}\n`, { mode: 0o600, tempMode: 0o600 });
}

/** Remove each file only while it still names `pipeName`. Never throws. */
export function removePipeFilesIfOurs(files: PipeFiles, pipeName: string): void {
  const endpoint = readPipeEndpoint(files.endpoint);
  if (typeof endpoint !== 'string' && endpoint.pipeName === pipeName) unlinkQuietly(files.endpoint);
  if (readPipeMarker(files.marker) === pipeName) unlinkQuietly(files.marker);
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone, or not ours to remove
  }
}

/**
 * Does the endpoint name a running engine? Its `pid` must be alive with exactly the start time it
 * wrote (`startedAt` is that pid's start time now, read by the caller; null when not running).
 */
export function endpointIsLive(endpoint: PipeEndpoint, startedAt: number | null | undefined): boolean {
  return typeof startedAt === 'number' && startedAt === endpoint.processStartTime;
}

/** Why the bridge will not dial the pipe. */
export type PipeOpenFailure =
  /** No endpoint, or one an exited engine left: the engine is not running. */
  | { readonly kind: 'not-running' }
  /** The endpoint or marker is unreadable, or they disagree. */
  | { readonly kind: 'invalid' }
  /** The folder or a file in it is not private to this user (or this process is elevated). */
  | { readonly kind: 'not-private'; readonly message: string };

export type PipeOpen = { readonly ok: true; readonly pipeName: string; readonly key: Buffer } | ({ readonly ok: false } & PipeOpenFailure);

/**
 * The bridge's check before it dials (#963), on every session open: the endpoint and marker are
 * read strictly and must name the same pipe; the folder and both files must be owned by this user
 * and private (`checkPrivateDir`), and the endpoint's engine must be running with the start time
 * it wrote – all in one PowerShell run. A stale name is never dialled.
 */
export async function openPipeEndpoint(
  files: PipeFiles,
  deps: PrivateDirDeps & { pidExists?: (pid: number) => boolean } = {},
): Promise<PipeOpen> {
  const endpoint = readPipeEndpoint(files.endpoint);
  if (endpoint === 'missing') return { ok: false, kind: 'not-running' };
  if (endpoint === 'invalid') return { ok: false, kind: 'invalid' };
  const marker = readPipeMarker(files.marker);
  if (marker === 'missing') return { ok: false, kind: 'not-running' };
  if (marker !== endpoint.pipeName) return { ok: false, kind: 'invalid' };
  // A gone engine is answered without the PowerShell check: nothing is dialled either way, and a
  // cold check costs seconds a client's startup budget does not have.
  if (!(deps.pidExists ?? pidExists)(endpoint.pid)) return { ok: false, kind: 'not-running' };
  const check = await checkPrivateDir(files.dir, [files.endpoint, files.marker], deps, { startTimeOf: endpoint.pid });
  if (!check.ok) return { ok: false, kind: 'not-private', message: check.message };
  if (!endpointIsLive(endpoint, check.startedAt)) return { ok: false, kind: 'not-running' };
  return { ok: true, pipeName: endpoint.pipeName, key: Buffer.from(endpoint.key, 'hex') };
}
