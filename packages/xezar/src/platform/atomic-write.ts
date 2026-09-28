/**
 * Write a file so a reader only ever sees the whole old or the whole new content (#963).
 *
 * The one write-then-rename for the engine: write a temporary file next to the target, then rename
 * it over the target. On Linux and macOS the rename is made exactly ONCE and its error is rethrown
 * untouched – the behavior every call site had before this module. On Windows another program
 * (antivirus, search indexing, a backup tool) often holds a just-written file for a few
 * milliseconds, and a file marked read-only refuses to be replaced, so there – and only there – a
 * refused rename is retried for about a second and a read-only target is made writable first.
 *
 * No `mkdir`, no `fsync`, no sandbox assertion: those stay each caller's own decision.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** The rename errors Windows returns while another program holds the file. */
export const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Waits between attempts on Windows: at most 8 attempts and 810 ms of sleeping. */
export const RENAME_RETRY_WAITS_MS: readonly number[] = [10, 20, 40, 80, 160, 250, 250];
/** No wait may take the whole retry past this, measured from the first attempt. */
export const RENAME_RETRY_BUDGET_MS = 1_000;
export const RENAME_HELD_HINT = 'another program such as antivirus or search indexing may be holding it';

type SyncFs = Pick<typeof fs, 'renameSync' | 'lstatSync' | 'chmodSync' | 'unlinkSync' | 'writeFileSync'>;
type AsyncFs = Pick<typeof fsp, 'rename' | 'lstat' | 'chmod' | 'unlink' | 'writeFile'>;

/** Test seams. Production passes none. */
export interface RenameSeams {
  platform?: NodeJS.Platform;
  now?: () => number;
  sleepSync?: (ms: number) => void;
  sleep?: (ms: number) => Promise<void>;
  fs?: Partial<SyncFs>;
  fsp?: Partial<AsyncFs>;
}

export interface AtomicWriteOptions {
  /** The temporary file. Default: `uniqueTmpPath(path)`. */
  tmpPath?: string;
  encoding?: BufferEncoding;
  /** Mode the temporary file is created with. */
  mode?: number;
  flag?: 'w' | 'wx';
  /** STRICT chmod of the temporary file before the rename: a failure fails the write. */
  tempMode?: number;
  /** BEST-EFFORT chmod of the target after the rename: a failure is ignored. */
  finalMode?: number;
}

/**
 * A staging name unique to this write: `<path>.<pid>.<8 hex>.tmp`. Two writers sharing one fixed
 * temporary name interleave (one truncates what the other is about to rename into place).
 */
export function uniqueTmpPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function sleepSyncDefault(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function syncFs(seams: RenameSeams): SyncFs {
  return {
    renameSync: seams.fs?.renameSync ?? fs.renameSync,
    lstatSync: seams.fs?.lstatSync ?? fs.lstatSync,
    chmodSync: seams.fs?.chmodSync ?? fs.chmodSync,
    unlinkSync: seams.fs?.unlinkSync ?? fs.unlinkSync,
    writeFileSync: seams.fs?.writeFileSync ?? fs.writeFileSync,
  };
}

function asyncFs(seams: RenameSeams): AsyncFs {
  return {
    rename: seams.fsp?.rename ?? fsp.rename,
    lstat: seams.fsp?.lstat ?? fsp.lstat,
    chmod: seams.fsp?.chmod ?? fsp.chmod,
    unlink: seams.fsp?.unlink ?? fsp.unlink,
    writeFile: seams.fsp?.writeFile ?? fsp.writeFile,
  };
}

/** What the retry loop knows between attempts. */
interface RetryState {
  readonly start: number;
  attempts: number;
  waitIndex: number;
  inspected: boolean;
  /** The target's permission bits before this loop made it writable, to put back on failure. */
  cleared?: number;
}

type RenameDecision = { kind: 'throw'; error: unknown } | { kind: 'wait'; ms: number };
type RenameStep = RenameDecision | { kind: 'inspect' };

/** The decision after a refused rename, shared by the sync and async loops. Pure: the loop that
 *  acts on a `wait` advances `waitIndex`. */
function nextRenameStep(state: Readonly<RetryState>, error: unknown, elapsedMs: number, to: string): RenameStep {
  const code = errorCode(error);
  if (code === undefined || !RENAME_RETRY_CODES.has(code)) return { kind: 'throw', error };
  if (!state.inspected && (code === 'EPERM' || code === 'EACCES')) return { kind: 'inspect' };
  return waitOrGiveUp(state, error, elapsedMs, to);
}

/** The next wait, or the wrapped error once the waits or the time budget run out. Pure. */
function waitOrGiveUp(state: Readonly<RetryState>, error: unknown, elapsedMs: number, to: string): RenameDecision {
  const ms = RENAME_RETRY_WAITS_MS[state.waitIndex];
  if (ms === undefined || elapsedMs + ms > RENAME_RETRY_BUDGET_MS) {
    return { kind: 'throw', error: exhaustedError(error, to, state.attempts) };
  }
  return { kind: 'wait', ms };
}

/** What an `lstat` of the target means for the retry: a folder is never "held", a read-only file
 *  can be made writable, anything else is waited on. */
function inspectTarget(stats: fs.Stats | undefined): 'folder' | 'read-only' | 'other' {
  if (stats?.isDirectory()) return 'folder';
  if (stats?.isFile() && (stats.mode & 0o200) === 0) return 'read-only';
  return 'other';
}

function exhaustedError(error: unknown, to: string, attempts: number): Error {
  const original = error as NodeJS.ErrnoException & { dest?: string };
  const wrapped = new Error(
    `could not replace ${to} after ${attempts} attempts (${original.code}): ${RENAME_HELD_HINT}. Try again in a moment.`,
    { cause: error },
  );
  // Callers branch on `code`; keep every field Node puts on a rename error.
  for (const key of ['code', 'errno', 'syscall', 'path', 'dest'] as const) {
    if (original[key] !== undefined) Object.assign(wrapped, { [key]: original[key] });
  }
  return wrapped;
}

/** A refused EPERM/EACCES: look at the target once. A folder is never "held by another program";
 *  a read-only file is made writable (its old bits kept in `state.cleared` for the failure path). */
type Inspection = 'folder' | 'cleared' | 'wait';

function inspectSync(f: SyncFs, to: string, state: RetryState): Inspection {
  state.inspected = true;
  let stats: fs.Stats | undefined;
  try { stats = f.lstatSync(to); } catch { stats = undefined; }
  const target = inspectTarget(stats);
  if (target === 'folder') return 'folder';
  if (target !== 'read-only' || !stats) return 'wait';
  try {
    f.chmodSync(to, (stats.mode & 0o777) | 0o222);
    state.cleared = stats.mode & 0o777;
    return 'cleared';
  } catch {
    return 'wait';
  }
}

async function inspectAsync(f: AsyncFs, to: string, state: RetryState): Promise<Inspection> {
  state.inspected = true;
  let stats: fs.Stats | undefined;
  try { stats = await f.lstat(to); } catch { stats = undefined; }
  const target = inspectTarget(stats);
  if (target === 'folder') return 'folder';
  if (target !== 'read-only' || !stats) return 'wait';
  try {
    await f.chmod(to, (stats.mode & 0o777) | 0o222);
    state.cleared = stats.mode & 0o777;
    return 'cleared';
  } catch {
    return 'wait';
  }
}

/** POSIX: ONE rename, the original error rethrown untouched. win32: bounded retry (see module). */
export function renameReplacingSync(from: string, to: string, seams: RenameSeams = {}): void {
  const f = syncFs(seams);
  if ((seams.platform ?? process.platform) !== 'win32') {
    f.renameSync(from, to);
    return;
  }
  const now = seams.now ?? Date.now;
  const sleep = seams.sleepSync ?? sleepSyncDefault;
  const state: RetryState = { start: now(), attempts: 0, waitIndex: 0, inspected: false };
  for (;;) {
    state.attempts += 1;
    try {
      f.renameSync(from, to);
      return;
    } catch (error) {
      const next = nextRenameStep(state, error, now() - state.start, to);
      let step: RenameDecision;
      if (next.kind === 'inspect') {
        const inspection = inspectSync(f, to, state);
        if (inspection === 'cleared') continue; // made writable: retry at once
        step = inspection === 'folder' ? { kind: 'throw', error } : waitOrGiveUp(state, error, now() - state.start, to);
      } else {
        step = next;
      }
      if (step.kind === 'wait') {
        state.waitIndex += 1;
        sleep(step.ms);
        continue;
      }
      if (state.cleared !== undefined) {
        try { f.chmodSync(to, state.cleared); } catch { /* best-effort */ }
      }
      throw step.error;
    }
  }
}

/** The async twin of `renameReplacingSync`. */
export async function renameReplacing(from: string, to: string, seams: RenameSeams = {}): Promise<void> {
  const f = asyncFs(seams);
  if ((seams.platform ?? process.platform) !== 'win32') {
    await f.rename(from, to);
    return;
  }
  const now = seams.now ?? Date.now;
  const sleep = seams.sleep ?? ((ms: number) => delay(ms));
  const state: RetryState = { start: now(), attempts: 0, waitIndex: 0, inspected: false };
  for (;;) {
    state.attempts += 1;
    try {
      await f.rename(from, to);
      return;
    } catch (error) {
      const next = nextRenameStep(state, error, now() - state.start, to);
      let step: RenameDecision;
      if (next.kind === 'inspect') {
        const inspection = await inspectAsync(f, to, state);
        if (inspection === 'cleared') continue;
        step = inspection === 'folder' ? { kind: 'throw', error } : waitOrGiveUp(state, error, now() - state.start, to);
      } else {
        step = next;
      }
      if (step.kind === 'wait') {
        state.waitIndex += 1;
        await sleep(step.ms);
        continue;
      }
      if (state.cleared !== undefined) {
        try { await f.chmod(to, state.cleared); } catch { /* best-effort */ }
      }
      throw step.error;
    }
  }
}

/** The writeFile options, carrying only the keys the caller passed. */
function writeOptions(options: AtomicWriteOptions): { encoding?: BufferEncoding; mode?: number; flag?: string } {
  return {
    ...(options.encoding !== undefined ? { encoding: options.encoding } : {}),
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    ...(options.flag !== undefined ? { flag: options.flag } : {}),
  };
}

/** A `wx` create that found the name taken: the file is someone else's and must not be removed. */
function isForeignTemp(options: AtomicWriteOptions, error: unknown): boolean {
  return options.flag === 'wx' && errorCode(error) === 'EEXIST';
}

function removeTempSync(tmp: string, f: SyncFs, platform: NodeJS.Platform): void {
  try {
    f.unlinkSync(tmp);
  } catch (error) {
    // A read-only temporary (the 0o444 hook cache) refuses deletion on Windows until it is writable.
    if (platform !== 'win32' || errorCode(error) !== 'EPERM') return;
    try { f.chmodSync(tmp, 0o666); f.unlinkSync(tmp); } catch { /* best-effort */ }
  }
}

async function removeTemp(tmp: string, f: AsyncFs, platform: NodeJS.Platform): Promise<void> {
  try {
    await f.unlink(tmp);
  } catch (error) {
    if (platform !== 'win32' || errorCode(error) !== 'EPERM') return;
    try { await f.chmod(tmp, 0o666); await f.unlink(tmp); } catch { /* best-effort */ }
  }
}

/**
 * Write temp → [chmod temp] → rename over `path` → [chmod target]. On any failure the temporary
 * file is removed best-effort (not after a `wx` create that found the name taken), and the
 * ORIGINAL error object is rethrown.
 */
export function writeFileAtomicSync(
  path: string,
  data: string | NodeJS.ArrayBufferView,
  options: AtomicWriteOptions = {},
  seams: RenameSeams = {},
): void {
  const f = syncFs(seams);
  const tmp = options.tmpPath ?? uniqueTmpPath(path);
  try {
    f.writeFileSync(tmp, data, writeOptions(options));
  } catch (error) {
    if (!isForeignTemp(options, error)) removeTempSync(tmp, f, seams.platform ?? process.platform);
    throw error;
  }
  try {
    if (options.tempMode !== undefined) f.chmodSync(tmp, options.tempMode);
    renameReplacingSync(tmp, path, seams);
  } catch (error) {
    removeTempSync(tmp, f, seams.platform ?? process.platform);
    throw error;
  }
  if (options.finalMode === undefined) return;
  try { f.chmodSync(path, options.finalMode); } catch { /* best-effort: some filesystems refuse */ }
}

/** The async twin of `writeFileAtomicSync`. */
export async function writeFileAtomic(
  path: string,
  data: string | NodeJS.ArrayBufferView,
  options: AtomicWriteOptions = {},
  seams: RenameSeams = {},
): Promise<void> {
  const f = asyncFs(seams);
  const tmp = options.tmpPath ?? uniqueTmpPath(path);
  try {
    await f.writeFile(tmp, data, writeOptions(options));
  } catch (error) {
    if (!isForeignTemp(options, error)) await removeTemp(tmp, f, seams.platform ?? process.platform);
    throw error;
  }
  try {
    if (options.tempMode !== undefined) await f.chmod(tmp, options.tempMode);
    await renameReplacing(tmp, path, seams);
  } catch (error) {
    await removeTemp(tmp, f, seams.platform ?? process.platform);
    throw error;
  }
  if (options.finalMode === undefined) return;
  try { await f.chmod(path, options.finalMode); } catch { /* best-effort */ }
}
