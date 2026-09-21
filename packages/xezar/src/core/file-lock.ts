import { randomBytes } from 'node:crypto';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

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
 *   `<pid>\n<ms>\n<token>\n` so a survivor can tell a live holder from a dead one, and so every
 *   removal can name WHICH lock it means.
 * - **Bounded.** `FILE_LOCK_WAIT_MS`, polling every `FILE_LOCK_POLL_MS`.
 * - **Stale-tolerant.** A lock whose pid is gone, whose owner stayed unreadable for
 *   `FILE_LOCK_UNWRITTEN_GRACE_MS`, or whose stamp is older than `FILE_LOCK_STALE_MS`, is removed and
 *   the create retried. A crash never leaves a lock nobody can take, and a lock being written right
 *   now is never mistaken for an abandoned one.
 * - **Never two holders.** Both removals — a takeover and a release — happen under a second `wx`
 *   guard file and only after re-reading the token under it (#306 part 3 review, M1). Without that,
 *   two waiters that read the SAME dead lock each removed what they found: A removed the dead lock
 *   and created its own, B then removed A's and created a third, and both believed they held it (a
 *   measured 27 double acquisitions in 300 four-way trials). The same token check is what stops a
 *   holder that paused past the stale bound from deleting its successor's lock on release.
 * - **Released in `finally`** by the caller, through the returned `release`.
 */

/** How long a waiter tries before it reports `timeout`. */
export const FILE_LOCK_WAIT_MS = 2_000;
/** How often the waiter re-tries. Short: both users hold the lock for a few ms. */
export const FILE_LOCK_POLL_MS = 20;
/** A lock older than this is assumed abandoned even if some process still owns the pid. */
export const FILE_LOCK_STALE_MS = 30_000;
/**
 * How long a lock file without a readable owner still counts as held. `open(path, 'wx')` creates the
 * file empty and the owner's pid is written a moment later, so an empty lock is usually one that is
 * being taken right now — removing it would let two writers hold the lock at once. A lock that stays
 * unreadable this long was abandoned mid-write, and is taken over inside the wait bound.
 */
export const FILE_LOCK_UNWRITTEN_GRACE_MS = 1_000;
/** Appended to the lock path for the `wx` guard that serialises takeover and release. */
export const FILE_LOCK_TAKEOVER_GUARD_SUFFIX = '.takeover';
/**
 * The guard's own stale bound. It is held for two or three syscalls, so anything older than this was
 * left behind by a crash; without the bound, one crash inside the takeover would block every later
 * waiter for good.
 */
export const FILE_LOCK_TAKEOVER_GUARD_STALE_MS = 1_000;

export interface FileLockOptions {
  /** Overridable so a contention test does not have to wait two real seconds. */
  waitMs?: number;
  /**
   * How old a lock may be before a waiter treats it as abandoned. Defaults to
   * `FILE_LOCK_STALE_MS`, which is right for the two original callers: both hold the lock for a
   * few milliseconds, so thirty seconds is already three orders of magnitude of slack.
   *
   * It is an option because a caller that holds the lock for MINUTES cannot use that bound —
   * `isHeld` would call a live holder abandoned and hand its lock to a waiter, which is the one
   * thing this module promises never to do. The gate lease (#672) holds a slot for a whole gate
   * run and therefore names its own bound AND re-stamps the lock while it works; neither half is
   * sufficient alone. A caller that does not say keeps exactly the behaviour it had.
   */
  staleMs?: number;
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
  // Keyed by the ABSOLUTE path, so two spellings of one folder in one process share one queue.
  const key = resolve(lockPath);
  const previous = queues.get(key) ?? Promise.resolve();
  // The queue holds the TAIL, not the result: a rejected body must not poison the next writer.
  const run = previous.then(body, body);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  try {
    return await run;
  } finally {
    // Drop the entry once this writer is the last one, so the map cannot grow per path across a
    // long-lived server's lifetime.
    if (queues.get(key) === tail) queues.delete(key);
  }
}

/**
 * Try to take the lock at `lockPath` within the bound. NEVER rejects: an error creating the lock
 * file (a read-only or missing folder) is reported as `{ acquired: false, reason: 'error' }`.
 */
export async function acquireFileLock(lockPath: string, options: FileLockOptions = {}): Promise<FileLockAcquisition> {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? FILE_LOCK_STALE_MS;
  const deadline = now() + (options.waitMs ?? FILE_LOCK_WAIT_MS);
  for (;;) {
    let token: string | null;
    try {
      token = await tryCreate(lockPath, now);
    } catch (error) {
      return { acquired: false, reason: 'error', error };
    }
    if (token !== null) {
      const mine = token;
      return {
        acquired: true,
        release: async () => {
          await releaseIfStillMine(lockPath, mine, now);
        },
      };
    }
    if (await takeOverIfStale(lockPath, now, staleMs)) continue;
    if (now() >= deadline) return { acquired: false, reason: 'timeout' };
    await sleep(FILE_LOCK_POLL_MS);
  }
}

/** The created lock's token, or `null` when another holder already has the file. */
async function tryCreate(lockPath: string, now: () => number): Promise<string | null> {
  const token = `${process.pid}-${now()}-${randomBytes(8).toString('hex')}`;
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${process.pid}\n${now()}\n${token}\n`);
    } finally {
      await handle.close();
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    // EROFS, EACCES, EPERM, ENOENT — a folder this process cannot write. The caller's policy.
    throw error;
  }
}

/**
 * Remove a lock whose owner is gone or whose stamp is older than `FILE_LOCK_STALE_MS`.
 *
 * The judgement and the removal are two separate reads, so the removal repeats the judgement UNDER
 * the guard and only for the same token. A lock created in between carries a different token and is
 * left alone; the waiter then simply keeps waiting for it.
 */
async function takeOverIfStale(lockPath: string, now: () => number, staleMs: number): Promise<boolean> {
  const judged = await readLockMetadata(lockPath, now);
  if (!judged || isHeld(judged, now, staleMs)) return false;
  return await underTakeoverGuard(lockPath, async () => {
    const current = await readLockMetadata(lockPath, now);
    // Gone already: the next create decides who gets it.
    if (!current) return true;
    if (current.token !== judged.token) return false;
    if (isHeld(current, now, staleMs)) return false;
    await rm(lockPath, { force: true }).catch(() => undefined);
    return true;
  });
}

/** Remove the lock file only while it still holds `token` — never a successor's lock. */
async function releaseIfStillMine(lockPath: string, token: string, now: () => number): Promise<void> {
  const remove = async () => {
    const current = await readLockMetadata(lockPath, now);
    if (current && current.token !== token) return;
    await rm(lockPath, { force: true }).catch(() => undefined);
  };
  // Under the guard, so a takeover cannot slip between the read and the removal. If the guard is
  // busy for the whole (very short) attempt, remove by token anyway: leaking a lock nobody releases
  // would cost every later writer its whole wait bound.
  const guarded = await underTakeoverGuard(lockPath, async () => {
    await remove();
    return true;
  });
  if (!guarded) await remove();
}

function isHeld(metadata: { timestamp: number; alive: boolean }, now: () => number, staleMs: number): boolean {
  return now() - metadata.timestamp <= staleMs && metadata.alive;
}

/**
 * Run `body` while holding the `wx` guard beside the lock, so at most one process at a time may
 * remove the lock file. Resolves to `false` when the guard could not be taken within its own short
 * bound, and never throws.
 *
 * The guard is judged by REAL time, not by the caller's `now`. A caller's clock is injectable so a
 * test can age a LOCK without waiting; the guard is a live artifact of the few syscalls happening
 * right now, and an injected clock must neither call a live guard abandoned nor make this loop
 * unbounded.
 */
async function underTakeoverGuard(lockPath: string, body: () => Promise<boolean>): Promise<boolean> {
  const guardPath = `${lockPath}${FILE_LOCK_TAKEOVER_GUARD_SUFFIX}`;
  const deadline = Date.now() + FILE_LOCK_TAKEOVER_GUARD_STALE_MS;
  for (;;) {
    let taken = false;
    try {
      await (await open(guardPath, 'wx', 0o600)).close();
      taken = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    }
    if (taken) {
      try {
        return await body();
      } catch {
        return false;
      } finally {
        await rm(guardPath, { force: true }).catch(() => undefined);
      }
    }
    if (await removeAbandonedGuard(guardPath)) continue;
    if (Date.now() >= deadline) return false;
    await sleep(FILE_LOCK_POLL_MS);
  }
}

/** A guard older than its own bound was left behind by a crash; one crash must not block everyone. */
async function removeAbandonedGuard(guardPath: string): Promise<boolean> {
  let age: number;
  try {
    age = Date.now() - (await stat(guardPath)).mtimeMs;
  } catch {
    // Gone between the failed create and this read — retry the create.
    return true;
  }
  if (age < FILE_LOCK_TAKEOVER_GUARD_STALE_MS) return false;
  await rm(guardPath, { force: true }).catch(() => undefined);
  return true;
}

async function readLockMetadata(
  lockPath: string,
  now: () => number,
): Promise<{ timestamp: number; alive: boolean; token: string | null } | null> {
  let fallback: number;
  try {
    fallback = (await stat(lockPath)).mtimeMs;
  } catch {
    // It went away between the failed create and this read — the next create wins.
    return null;
  }
  let pid = NaN;
  let timestamp = fallback;
  // A lock written by an older xezar, or caught between `open` and its write, has no token. `null`
  // is then its identity: it compares equal only to another tokenless read of the same file, and the
  // freshness re-judgement under the guard is what keeps a young successor safe.
  let token: string | null = null;
  try {
    const [pidText, stampText, tokenText] = (await readFile(lockPath, 'utf8')).trim().split(/\s+/);
    pid = Number(pidText);
    const stamp = Number(stampText);
    if (Number.isFinite(stamp)) timestamp = stamp;
    if (tokenText) token = tokenText;
  } catch {
    // Unreadable: judged by its age below, like an empty one.
  }
  // A stamp from the future (a clock that moved backwards) must not make a lock immortal.
  if (timestamp > now()) timestamp = now();
  // No readable owner: still being written if it is young, abandoned mid-write if it is not.
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return { timestamp, token, alive: now() - Math.min(fallback, now()) < FILE_LOCK_UNWRITTEN_GRACE_MS };
  try {
    process.kill(pid, 0);
    return { timestamp, token, alive: true };
  } catch (error) {
    // EPERM = the process exists and belongs to someone else. Still alive.
    return { timestamp, token, alive: (error as NodeJS.ErrnoException).code === 'EPERM' };
  }
}

/**
 * The poll timer is deliberately NOT `unref`'d. A writer waiting here is mid-work, so letting the
 * event loop drain would let a short CLI command exit with its write undone. The wait is bounded
 * by the caller's `waitMs`, so this holds a process open for at most that long.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}
