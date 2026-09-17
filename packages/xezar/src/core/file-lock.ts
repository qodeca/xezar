import { open, readFile, rm, stat } from 'node:fs/promises';

/**
 * A bounded cross-process file lock: `open(path, 'wx', 0o600)`, the mechanism `skills-update.ts`
 * proved and `workspace/config-lock.ts` generalised (#467). Factored out for the audit trail
 * (#306 part 3, spec `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 7.2), which
 * needs the same wait, polling, stale rules and in-process queue but a DIFFERENT answer when the
 * lock cannot be taken.
 *
 * This module decides nothing about that answer. It reports what happened — acquired, timed out,
 * or failed with an error — and each caller keeps its own policy:
 *   - the workspace config writes UNLOCKED after the bound (a registry write a lock could cancel
 *     would be a worse bug than the lost update the lock prevents);
 *   - the audit trail SKIPS its record after the bound (an unlocked append could duplicate a
 *     sequence or race a rotation, and the action itself never waits on its record).
 *
 * The rules, shared by both:
 * - **Atomic create.** `open(path, 'wx')` succeeds for exactly one process; the file holds
 *   `<pid>\n<ms>\n` so a survivor can tell a live holder from a dead one.
 * - **Bounded.** `FILE_LOCK_WAIT_MS`, polling every `FILE_LOCK_POLL_MS`.
 * - **Stale-tolerant.** A lock whose pid is gone or unreadable, or whose stamp is older than
 *   `FILE_LOCK_STALE_MS`, is removed and the create retried. A crash never leaves a lock nobody
 *   can take.
 * - **Released in `finally`** by the caller, through the returned `release`.
 */

/** How long a waiter tries before it reports `timeout`. */
export const FILE_LOCK_WAIT_MS = 2_000;
/** How often the waiter re-tries. Short: both users hold the lock for a few ms. */
export const FILE_LOCK_POLL_MS = 20;
/** A lock older than this is assumed abandoned even if some process still owns the pid. */
export const FILE_LOCK_STALE_MS = 30_000;

export interface FileLockOptions {
  /** Overridable so a contention test does not have to wait two real seconds. */
  waitMs?: number;
  now?: () => number;
}

export type FileLockAcquisition =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false; reason: 'timeout' }
  | { acquired: false; reason: 'error'; error: unknown };

/**
 * One in-process queue per lock path.
 *
 * Without it, two writers in ONE process would contend for a file lock they both already own:
 * the second would find a lock file whose pid is alive — its own — and wait out the whole bound.
 * Serializing in memory first means the file lock only ever arbitrates between DIFFERENT
 * processes, which is all it is for.
 */
const queues = new Map<string, Promise<unknown>>();

/** Run `body` after every earlier `body` queued on the same lock path in this process has settled. */
export async function queueByLockPath<T>(lockPath: string, body: () => Promise<T>): Promise<T> {
  const previous = queues.get(lockPath) ?? Promise.resolve();
  // The queue holds the TAIL, not the result: a rejected body must not poison the next writer.
  const run = previous.then(body, body);
  const tail = run.catch(() => undefined);
  queues.set(lockPath, tail);
  try {
    return await run;
  } finally {
    // Drop the entry once this writer is the last one, so the map cannot grow per path across a
    // long-lived server's lifetime.
    if (queues.get(lockPath) === tail) queues.delete(lockPath);
  }
}

/**
 * Try to take the lock at `lockPath` within the bound. NEVER rejects: an error creating the lock
 * file (a read-only or missing folder) is reported as `{ acquired: false, reason: 'error' }`.
 */
export async function acquireFileLock(lockPath: string, options: FileLockOptions = {}): Promise<FileLockAcquisition> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.waitMs ?? FILE_LOCK_WAIT_MS);
  for (;;) {
    let created: boolean;
    try {
      created = await tryCreate(lockPath, now);
    } catch (error) {
      return { acquired: false, reason: 'error', error };
    }
    if (created) {
      return {
        acquired: true,
        release: async () => {
          await rm(lockPath, { force: true }).catch(() => undefined);
        },
      };
    }
    if (await takeOverIfStale(lockPath, now)) continue;
    if (now() >= deadline) return { acquired: false, reason: 'timeout' };
    await sleep(FILE_LOCK_POLL_MS);
  }
}

async function tryCreate(lockPath: string, now: () => number): Promise<boolean> {
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${process.pid}\n${now()}\n`);
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    // EROFS, EACCES, EPERM, ENOENT — a folder this process cannot write. The caller's policy.
    throw error;
  }
}

/** Remove a lock whose owner is gone or whose stamp is older than `FILE_LOCK_STALE_MS`. */
async function takeOverIfStale(lockPath: string, now: () => number): Promise<boolean> {
  const metadata = await readLockMetadata(lockPath, now);
  if (!metadata) return false;
  const fresh = now() - metadata.timestamp <= FILE_LOCK_STALE_MS;
  if (fresh && metadata.alive) return false;
  await rm(lockPath, { force: true }).catch(() => undefined);
  return true;
}

async function readLockMetadata(
  lockPath: string,
  now: () => number,
): Promise<{ timestamp: number; alive: boolean } | null> {
  let fallback: number;
  try {
    fallback = (await stat(lockPath)).mtimeMs;
  } catch {
    // It went away between the failed create and this read — the next create wins.
    return null;
  }
  let pid = NaN;
  let timestamp = fallback;
  try {
    const [pidText, stampText] = (await readFile(lockPath, 'utf8')).trim().split(/\s+/);
    pid = Number(pidText);
    const stamp = Number(stampText);
    if (Number.isFinite(stamp)) timestamp = stamp;
  } catch {
    // An unreadable or half-written lock is treated as dead — `fallback` still bounds it.
  }
  // A stamp from the future (a clock that moved backwards) must not make a lock immortal.
  if (timestamp > now()) timestamp = now();
  if (!Number.isSafeInteger(pid) || pid <= 0) return { timestamp, alive: false };
  try {
    process.kill(pid, 0);
    return { timestamp, alive: true };
  } catch (error) {
    // EPERM = the process exists and belongs to someone else. Still alive.
    return { timestamp, alive: (error as NodeJS.ErrnoException).code === 'EPERM' };
  }
}

/**
 * The poll timer is deliberately NOT `unref`'d. A writer waiting here is mid-work, so letting the
 * event loop drain would let a short CLI command exit with its write undone. The wait is bounded
 * by the caller's `waitMs`, so this holds a process open for at most that long.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
