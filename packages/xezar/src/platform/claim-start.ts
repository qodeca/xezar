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
import { defaultTableRunner, fileTimeToMs, powershellArgs, type TableRunner } from './process-table.ts';
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
  /** When `pid`'s current process was created, in ms since the epoch; `gone` when no process has
   *  that pid any more; null when unreadable. */
  createdAt?: (pid: number) => CreatedAt;
  /**
   * `look` (the default) reads the creation time with one synchronous PowerShell: for the boot
   * step, before anything is served. `remembered` never blocks: it answers from what an earlier
   * look or `primeClaimProcess` found, and on a miss answers `unknown` – the pid answer, so a live
   * pid still counts as the writer – and starts that look in the background for the next call.
   */
  mode?: 'look' | 'remembered';
  /** The background look a `remembered` miss starts (`primeClaimProcess`). */
  run?: TableRunner;
  powershell?: string | null;
}

/**
 * Is the live `pid` still the process that wrote a claim recording `started`? `other` only on
 * Windows, only for a recorded number, and only when the creation time was read and is later:
 * every other answer is `unknown`, and the caller keeps treating the live pid as the writer.
 */
export function claimProcess(pid: number, started: unknown, deps: ClaimProcessDeps = {}): 'same' | 'other' | 'unknown' {
  if ((deps.platform ?? process.platform) !== 'win32') return 'unknown';
  if (typeof started !== 'number' || !Number.isSafeInteger(started) || !Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  if (deps.createdAt) return verdict(deps.createdAt(pid), started);
  const known = remembered(pid, started);
  if (known !== undefined) return known;
  if (deps.mode === 'remembered') {
    void primeClaimProcess(pid, started, { platform: deps.platform, run: deps.run, powershell: deps.powershell });
    return 'unknown';
  }
  return remember(pid, started, verdict(windowsCreatedAtSync(pid), started));
}

/**
 * Windows: read `pid`'s creation time off the main thread and remember the answer, so a later
 * `claimProcess` in either mode answers without starting PowerShell. Never rejects.
 */
export async function primeClaimProcess(
  pid: number,
  started: unknown,
  deps: { platform?: NodeJS.Platform; run?: TableRunner; powershell?: string | null } = {},
): Promise<void> {
  if ((deps.platform ?? process.platform) !== 'win32') return;
  if (typeof started !== 'number' || !Number.isSafeInteger(started) || !Number.isSafeInteger(pid) || pid <= 0) return;
  if (remembered(pid, started) !== undefined) return;
  const key = `${pid}:${started}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const look = (async () => {
    const powershell = deps.powershell === undefined ? powershellPath(process.env) : deps.powershell;
    if (powershell === null) return;
    const text = await (deps.run ?? defaultTableRunner)(powershell, powershellArgs(CREATED_AT_SCRIPT), {
      maxBuffer: 64 * 1024,
      timeoutMs: CREATED_AT_TIMEOUT_MS,
      hide: true,
      env: { ...process.env, [CLAIM_PID_ENV]: String(pid) },
    }).catch(() => null);
    remember(pid, started, verdict(text === null ? null : createdAtFrom(text), started));
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, look);
  return look;
}

/**
 * When the live pid's process was created: a time, `gone`, or null for "could not tell".
 *
 * `gone` is evidence, not a missing answer. The caller found the pid alive a moment earlier, but
 * on a busy Windows host that pid can belong to a short-lived process that reused it and then
 * exited before the look ran; the look then finds no process at all. The claim's writer, were it
 * still running, would still be there to find – so nobody holds that pid now, and the claimer is
 * gone. Read as `unknown`, this kept a dead writer's claim live and refused the next start
 * ("live writer PID …", CI run 39216917631).
 */
export type CreatedAt = number | 'gone' | null;

/** The look's printed answer: a FILETIME, `gone`, or anything else (unreadable). */
export function createdAtFrom(text: string): CreatedAt {
  const trimmed = text.trim();
  if (trimmed === 'gone') return 'gone';
  return fileTimeToMs(trimmed) ?? null;
}

function verdict(created: CreatedAt, started: number): 'same' | 'other' | 'unknown' {
  if (created === null) return 'unknown';
  if (created === 'gone') return 'other';
  return created <= started + CLAIM_START_SLACK_MS ? 'same' : 'other';
}

/**
 * What earlier looks found, per (pid, recorded start). `other` never goes stale: a process created
 * after the claim can never be its writer. `same` is kept briefly, because that writer can die and
 * Windows give its pid to another process; past that, the next call looks again. `unknown` is
 * not remembered.
 */
const verdicts = new Map<string, { answer: 'same' | 'other'; at: number }>();
const inFlight = new Map<string, Promise<void>>();
/** How long a `same` answer is trusted before it is looked up again. */
export const SAME_PROCESS_REMEMBERED_MS = 30_000;
const VERDICTS_MAX = 256;

function remembered(pid: number, started: number): 'same' | 'other' | undefined {
  const entry = verdicts.get(`${pid}:${started}`);
  if (!entry) return undefined;
  if (entry.answer === 'same' && Date.now() - entry.at > SAME_PROCESS_REMEMBERED_MS) return undefined;
  return entry.answer;
}

function remember(pid: number, started: number, answer: 'same' | 'other' | 'unknown'): 'same' | 'other' | 'unknown' {
  if (answer === 'unknown') return answer;
  if (verdicts.size >= VERDICTS_MAX) verdicts.clear();
  verdicts.set(`${pid}:${started}`, { answer, at: Date.now() });
  return answer;
}

/** Tests only: forget every remembered answer. */
export function __forgetClaimProcessesForTests(): void {
  verdicts.clear();
  inFlight.clear();
}

/** The pid reaches the script through this variable, so the script text never changes. */
const CLAIM_PID_ENV = 'CLAIM_START_PID';
const CREATED_AT_TIMEOUT_MS = 10_000;
// `GetProcessById` throws only when no process has the pid; a process that exists but whose start
// time cannot be read (access denied) answers `-`, which stays "could not tell".
export const CREATED_AT_SCRIPT = `try { $p = [Diagnostics.Process]::GetProcessById([int]$env:${CLAIM_PID_ENV}) } catch { 'gone'; return }; try { $p.StartTime.ToFileTimeUtc() } catch { '-' }`;

/** One synchronous PowerShell, for the boot step only (`mode: 'look'`). */
function windowsCreatedAtSync(pid: number): CreatedAt {
  const powershell = powershellPath(process.env);
  if (powershell === null) return null;
  try {
    const text = launchFileSync(powershell, powershellArgs(CREATED_AT_SCRIPT), {
      encoding: 'utf8',
      timeout: CREATED_AT_TIMEOUT_MS,
      env: { ...process.env, [CLAIM_PID_ENV]: String(pid) },
    });
    return createdAtFrom(text);
  } catch {
    return null;
  }
}
