import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { acquireFileLock, queueByLockPath } from '../core/file-lock.ts';
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
 * - **Bounded.** `FILE_LOCK_WAIT_MS` and then the write proceeds unlocked with one warning — the
 *   0.15 behaviour exactly.
 * - **Stale-tolerant.** A lock file whose owning pid is gone, or that is older than
 *   `FILE_LOCK_STALE_MS`, is taken over. A crash never leaves a home that cannot be written to.
 * - **Shared by every writer.** It lives inside `mergeWriteWorkspaceConfig`, so `serve`, the
 *   `projects` CLI, the settings routes, migrations and the MCP all hold it without knowing
 *   it exists. An instance-only lock would not protect against an unlocked `xez projects`,
 *   which is the contention the analysis names.
 *
 * The mechanism is the one `skills-update.ts` already proved in this repo, now shared with the
 * audit trail as `core/file-lock.ts` (#306 part 3): `open(path, 'wx')` is atomic on every
 * filesystem xezar supports, and the pid inside lets a survivor tell a live holder from a dead
 * one. The wait, polling and stale rules live there; the unlocked-after-the-bound policy is
 * this module's own.
 */

/** The lock beside the file it guards, so `XEZ_HOME` moves both together. */
export function workspaceConfigLockPath(configPath: string): string {
  return `${configPath}.lock`;
}

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
  // The in-process queue (`core/file-lock.ts`) first, so the file lock only arbitrates between processes.
  return queueByLockPath(lockPath, () => locked(lockPath, body, options));
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
  const warn = options.warn ?? ((line: string) => console.warn(line));

  try {
    assertXezarHomeWriteIsSandboxed(lockPath);
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch {
    // A home that cannot even be created is a home this write will fail on anyway — let the
    // caller's own error policy handle it rather than turning it into a lock problem here.
    return async () => {};
  }

  const lock = await acquireFileLock(lockPath, {
    ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  if (lock.acquired) return lock.release;
  // The lock file itself cannot be written (read-only home): run unlocked and silently — the
  // write that follows will report the real problem in its own words.
  if (lock.reason === 'error') return async () => {};
  if (!warnedUnlocked) {
    warnedUnlocked = true;
    warn(
      `[xez] workspace config lock ${lockPath} is held by another xezar — writing without it; ` +
        'a simultaneous change may be overwritten',
    );
  }
  return async () => {};
}
