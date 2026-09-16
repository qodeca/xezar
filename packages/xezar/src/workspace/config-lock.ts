import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertXezarHomeWriteIsSandboxed } from '../paths.ts';

/**
 * The bounded cross-process merge lock every `~/.xezar/config.json` writer holds (#467, AC-04;
 * `designs/cli-terminal/multi-instance.md` § 4, "Writes need a lock").
 *
 * The atomic tmp+rename in `config.ts` prevents a TORN file. It does not prevent a LOST
 * UPDATE: two processes may both read the registry, both apply their own change to the copy
 * they read, and the second rename then replaces the first one's row. That was survivable
 * while a merge-write happened once at boot; one cockpit per project makes several instances
 * start at the same moment and each remember its own port, so the window is now hit on
 * purpose rather than by accident.
 *
 * The lock is held around read→mutate→write, so a second writer re-reads a file that already
 * holds the first writer's change. It is deliberately NOT a correctness barrier: the registry
 * has always self-healed, so a lock that could BLOCK a start would trade a working default for
 * a new failure mode. Hence:
 *
 * - **Bounded.** `LOCK_WAIT_MS` and then the write proceeds unlocked with one warning — the
 *   0.15 behaviour exactly.
 * - **Stale-tolerant.** A lock file whose owning pid is gone, or that is older than
 *   `LOCK_STALE_MS`, is taken over. A crash never leaves a home that cannot be written to.
 * - **Shared by every writer.** It lives inside `mergeWriteWorkspaceConfig`, so `serve`, the
 *   `projects` CLI, the settings routes, migrations and the MCP all hold it without knowing
 *   it exists. An instance-only lock would not protect against an unlocked `xez projects`,
 *   which is the contention the analysis names.
 *
 * The mechanism is the one `skills-update.ts` already proved in this repo: `open(path, 'wx')`
 * is atomic on every filesystem xezar supports, and the pid inside lets a survivor tell a
 * live holder from a dead one.
 */

/** How long a writer waits for the lock before going ahead without it. */
const LOCK_WAIT_MS = 2_000;
/** How often the waiter re-tries. Short: a merge-write holds the lock for a few ms. */
const LOCK_POLL_MS = 20;
/** A lock older than this is assumed abandoned even if some process still owns the pid. */
const LOCK_STALE_MS = 30_000;

/** The lock beside the file it guards, so `XEZ_HOME` moves both together. */
export function workspaceConfigLockPath(configPath: string): string {
  return `${configPath}.lock`;
}

/**
 * One in-process queue per lock path.
 *
 * Without it, two `await mergeWriteWorkspaceConfig(…)` calls in ONE process would contend for
 * a file lock they both already own: the second would find a lock file whose pid is alive —
 * its own — wait the full bound, and then degrade. Serializing in memory first means the file
 * lock only ever arbitrates between DIFFERENT processes, which is all it is for.
 */
const queues = new Map<string, Promise<unknown>>();

/** Test hook: the warning is once per process, so a suite must be able to re-arm it. */
let warnedUnlocked = false;
export function resetWorkspaceLockWarning(): void {
  warnedUnlocked = false;
}

export interface WorkspaceLockOptions {
  /** Overridable so a contention test does not have to wait two real seconds. */
  waitMs?: number;
  now?: () => number;
  /** Where the degradation warning goes. Defaults to `console.warn`. */
  warn?: (line: string) => void;
}

/**
 * Run `body` while holding the cross-process lock for `configPath`, then release it.
 *
 * `body` runs EXACTLY ONCE whatever happens to the lock — acquired, timed out, or refused by
 * a read-only home. A registry write that a missing lock could cancel would be a worse bug
 * than the lost update the lock prevents (AC-04: "missing/corrupt/read-only config still
 * boots"). Release is in a `finally`, so a throwing `body` never strands the lock.
 */
export async function withWorkspaceConfigLock<T>(
  configPath: string,
  body: () => Promise<T>,
  options: WorkspaceLockOptions = {},
): Promise<T> {
  const lockPath = workspaceConfigLockPath(configPath);
  const previous = queues.get(lockPath) ?? Promise.resolve();
  // The queue holds the TAIL, not the result: a rejected body must not poison the next writer.
  const run = previous.then(
    () => locked(lockPath, body, options),
    () => locked(lockPath, body, options),
  );
  queues.set(lockPath, run.catch(() => undefined));
  try {
    return await run;
  } finally {
    // Drop the entry once this writer is the last one, so the map cannot grow per XEZ_HOME
    // across a long-lived server's lifetime.
    if (queues.get(lockPath) === undefined) queues.delete(lockPath);
  }
}

async function locked<T>(
  lockPath: string,
  body: () => Promise<T>,
  options: WorkspaceLockOptions,
): Promise<T> {
  const release = await acquireWorkspaceConfigLock(lockPath, options);
  try {
    return await body();
  } finally {
    await release();
  }
}

/**
 * Resolves to a release function — a no-op when the lock could not be taken. It NEVER
 * rejects: an unwritable home is the write's problem to report, not the lock's, and a lock
 * that could fail a start would be exactly the new failure mode this module must not add.
 */
export async function acquireWorkspaceConfigLock(
  lockPath: string,
  options: WorkspaceLockOptions = {},
): Promise<() => Promise<void>> {
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const deadline = now() + waitMs;

  try {
    assertXezarHomeWriteIsSandboxed(lockPath);
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch {
    // A home that cannot even be created is a home this write will fail on anyway — let the
    // caller's own error policy handle it rather than turning it into a lock problem here.
    return async () => {};
  }

  for (;;) {
    let created: boolean;
    try {
      created = await tryCreate(lockPath, now);
    } catch {
      // The lock file itself cannot be written (read-only home). Run unlocked and silently:
      // the write that follows will report the real problem in its own words.
      return async () => {};
    }
    if (created) {
      return async () => {
        await rm(lockPath, { force: true }).catch(() => undefined);
      };
    }
    if (await takeOverIfStale(lockPath, now)) continue;
    if (now() >= deadline) {
      if (!warnedUnlocked) {
        warnedUnlocked = true;
        warn(
          `[xez] workspace config lock ${lockPath} is held by another xezar — writing without it; ` +
            'a simultaneous change may be overwritten',
        );
      }
      return async () => {};
    }
    await sleep(LOCK_POLL_MS);
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
    // EROFS, EACCES, EPERM — a home xezar cannot write. Surfaced to the caller above, which
    // runs unlocked rather than letting this module invent a second error for it.
    throw error;
  }
}

/** Remove a lock whose owner is gone or whose stamp is older than `LOCK_STALE_MS`. */
async function takeOverIfStale(lockPath: string, now: () => number): Promise<boolean> {
  const metadata = await readLockMetadata(lockPath, now);
  if (!metadata) return false;
  const fresh = now() - metadata.timestamp <= LOCK_STALE_MS;
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
 * The poll timer is deliberately NOT `unref`'d. A writer waiting here is mid-work — its
 * merge-write has not happened yet — so letting the event loop drain would let a short CLI
 * command exit with its registry change unwritten. (Node reports that as exit code 13, an
 * unsettled top-level await, which is how the contention test caught it.) The wait is bounded
 * by `LOCK_WAIT_MS`, so this can hold a process open for at most that long.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
