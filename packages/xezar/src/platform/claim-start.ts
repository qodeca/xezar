/**
 * Telling a writer claim's process from a later one that reuses its pid (#963).
 *
 * A project's writer claim names its owner by pid. Windows reuses pids within seconds on a busy
 * machine, and a Windows kill gives xezar no chance to remove its claim, so "is this pid alive?"
 * alone can refuse every later start on the strength of an unrelated process. On Windows a claim
 * therefore also records when its process started (`performance.timeOrigin`, which follows the
 * process's creation), and a live pid whose process was created AFTER that moment is another
 * process. Linux and macOS record nothing new and keep the pid-only answer exactly.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { performance } from 'node:perf_hooks';
import { launchFileSync } from './process-launch.ts';
import { fileTimeToMs, powershellArgs } from './process-table.ts';
import { powershellPath } from './system-programs.ts';

/**
 * How far a process's creation may follow the start time its claim recorded and still be the same
 * process. The creation always comes first; this absorbs clock rounding only. A process that
 * reuses the pid was created after the claimer died, which is after it wrote its claim.
 */
export const CLAIM_START_SLACK_MS = 500;

/** The start time this process records in its claim: Windows only, else undefined. */
export function claimStartedAt(platform: NodeJS.Platform = process.platform): number | undefined {
  return platform === 'win32' ? Math.floor(performance.timeOrigin) : undefined;
}

export interface ClaimProcessDeps {
  platform?: NodeJS.Platform;
  /** When `pid`'s current process was created, in ms since the epoch, or null when unreadable. */
  createdAt?: (pid: number) => number | null;
}

/**
 * Is the live `pid` still the process that wrote a claim recording `started`? `other` only on
 * Windows, only for a recorded number, and only when the creation time was read and is later:
 * every other answer is `unknown`, and the caller keeps treating the live pid as the writer.
 */
export function claimProcess(pid: number, started: unknown, deps: ClaimProcessDeps = {}): 'same' | 'other' | 'unknown' {
  if ((deps.platform ?? process.platform) !== 'win32') return 'unknown';
  if (typeof started !== 'number' || !Number.isSafeInteger(started) || !Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  const created = (deps.createdAt ?? windowsCreatedAt)(pid);
  if (created === null) return 'unknown';
  return created <= started + CLAIM_START_SLACK_MS ? 'same' : 'other';
}

/**
 * One synchronous PowerShell: the claim check runs inside a synchronous boot step, and only when
 * a claim's pid is alive, so the usual start pays nothing.
 */
function windowsCreatedAt(pid: number): number | null {
  const powershell = powershellPath(process.env);
  if (powershell === null) return null;
  try {
    const text = launchFileSync(
      powershell,
      powershellArgs(`try { [Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToFileTimeUtc() } catch { '-' }`),
      { encoding: 'utf8', timeout: 10_000 },
    );
    return fileTimeToMs(text.trim()) ?? null;
  } catch {
    return null;
  }
}
