/**
 * The machine's process table, and stopping a process by its identity (#963).
 *
 * One snapshot answers "which processes descend from this child?" for the telemetry sampler and
 * for a Windows tree stop. A pid alone is not an identity – Windows and Linux both reuse them – so
 * Windows rows also carry the process start time, and `killIdentified` kills a pid only while its
 * start time still matches, checked and killed through one handle.
 *
 * Every reader never rejects and drops the error object, which carries the program's output.
 * Linux runs exactly the `ps` command the sampler ran before this module existed; macOS adds
 * the start-time column (`lstart`, under `LC_ALL=C`) that #943's ledger needs.
 *
 * #943 adds `startTimeOf` on macOS; what else a run's process sweep reads is in
 * `process-proof.ts`.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { MsysRow } from './msys-process-tree.ts';
import { powershellPath } from './system-programs.ts';

/** One process. `rssKb` in KiB; `cpuPct` is 0 on Windows; `startedAt` in ms since the epoch
 *  (Windows; macOS to the second), absent when unknown. */
export interface ProcRow {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuPct: number;
  startedAt?: number;
}

export interface ProcessTable {
  rows: ProcRow[];
  /** When the query STARTED, in ms since the epoch: every row describes a process that was
   *  alive at some moment after this. */
  queriedAt: number;
  /** Windows, when the reader also read Git's `ps` (the run sweep, #963): the MSYS processes,
   *  each with its Windows pid. Absent: not read – never "no MSYS process". */
  msys?: readonly MsysRow[];
}

export interface TableRunOptions {
  maxBuffer: number;
  timeoutMs?: number;
  /** Hide the console window (Windows). */
  hide?: boolean;
  /** The child's whole environment; absent: inherited. */
  env?: NodeJS.ProcessEnv;
}

/** Runs one program without a shell; its stdout, or null on any failure. Never rejects. */
export type TableRunner = (file: string, args: readonly string[], options: TableRunOptions) => Promise<string | null>;

/** Test seams. Production passes none. */
export interface ProcessTableDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: TableRunner;
  /** win32 without a drive SystemRoot: does this PATH candidate exist (`powershellPath`)? */
  exists?: (path: string) => boolean;
}

export interface ReadTableOptions {
  /** Give up after this long. Default: no bound, as the sampler always ran. */
  timeoutMs?: number;
}

const TABLE_MAX_BUFFER = 16 * 1024 * 1024;
const PS_ARGS: readonly string[] = ['-axo', 'pid=,ppid=,rss=,%cpu='];
/** macOS: the same columns plus the start time, `Mon Sep 29 20:31:05 2026` in the C locale. */
const PS_ARGS_DARWIN: readonly string[] = ['-axo', 'pid=,ppid=,rss=,%cpu=,lstart='];
const LSTART_MONTHS: readonly string[] = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MS_PER_SECOND = 1_000;
/** 100 ns ticks between 1601-01-01 (FILETIME) and 1970-01-01. */
const FILETIME_UNIX_EPOCH = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
/** A direct child may be dated slightly before `spawnedAt`, which is read after `spawn` returns. */
export const SPAWN_CLOCK_SLACK_MS = 1_000;
/**
 * A direct child may also be dated slightly AFTER `stoppedAt`. Start times come from the kernel's
 * clock and `stoppedAt` from `Date.now()`, and Windows can place the two up to one clock tick
 * apart – 15.6 ms at the default timer resolution. A grandchild started about 10 ms before a stop
 * was measured dated after it, so the stop missed the only descendant it had (#963 Q-03).
 */
export const STOP_CLOCK_SLACK_MS = 100;
export const KILL_IDENTIFIED_TIMEOUT_MS = 5_000;
const KILL_MAX_BUFFER = 1024 * 1024;
/** Targets per PowerShell run, so the encoded command stays far below Windows' 32 767 limit. */
export const KILL_BATCH = 200;
/** Windows' System Idle (0) and System (4) processes. */
const WINDOWS_SYSTEM_PID_MAX = 4;
/** POSIX init. */
const POSIX_SYSTEM_PID_MAX = 1;

/** The start line first, so `queriedAt` is taken before the query, then one row per process.
 *  Shared with the one-PowerShell tree stop (`table-then-kill.ts`). */
export const WINDOWS_TABLE_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  '"queried $([DateTime]::UtcNow.ToFileTimeUtc())"',
  'Get-CimInstance Win32_Process | ForEach-Object {',
  "  $start = '-'",
  '  if ($_.CreationDate) { $start = $_.CreationDate.ToFileTimeUtc() }',
  '  "$($_.ProcessId) $($_.ParentProcessId) $([math]::Round($_.WorkingSetSize/1024)) 0 $start"',
  '}',
].join('\n');

/** The one runner the readers use unless a test passes its own: execFile without a shell, the
 *  options given and nothing else, stdout on success, null otherwise. */
export const defaultTableRunner: TableRunner = (file, args, options) =>
  process.platform === 'win32' ? runOffThread(file, args, options) : runOnThread(file, args, options);

const runOnThread: TableRunner = (file, args, options) =>
  new Promise((resolve) => {
    try {
      execFile(
        file,
        [...args],
        {
          maxBuffer: options.maxBuffer,
          ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
          ...(options.hide ? { windowsHide: true } : {}),
          ...(options.env !== undefined ? { env: options.env } : {}),
        },
        (error, stdout) => resolve(error ? null : stdout),
      );
    } catch {
      resolve(null);
    }
  });

/**
 * Windows (#963): the first PowerShell a process starts holds the CALLING thread inside process
 * creation for one to two seconds (measured on Windows 11, any window option, Windows PowerShell
 * and PowerShell 7 alike). On the main thread that froze the whole server – every request, the MCP
 * pipe and the cockpit – right after boot, when the MCP folder check runs. So on Windows the same
 * `execFile` runs on a short-lived worker thread, and only that thread waits.
 */
const OFF_THREAD_RUNNER = `
const { parentPort, workerData } = require('node:worker_threads');
const { execFile } = require('node:child_process');
const { file, args, options } = workerData;
try {
  execFile(file, args, options, (error, stdout) => parentPort.postMessage(error ? null : stdout));
} catch {
  parentPort.postMessage(null);
}
`;

function runOffThread(file: string, args: readonly string[], options: TableRunOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (text: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(text);
    };
    try {
      const worker = new Worker(OFF_THREAD_RUNNER, {
        eval: true,
        // Plain CommonJS: a loader the parent was started with (tsx, a test runner) must not
        // reinterpret these few lines.
        execArgv: [],
        workerData: {
          file,
          args: [...args],
          options: {
            maxBuffer: options.maxBuffer,
            ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
            ...(options.hide ? { windowsHide: true } : {}),
            ...(options.env !== undefined ? { env: options.env } : {}),
          },
        },
      });
      worker.once('message', (text: unknown) => {
        settle(typeof text === 'string' ? text : null);
        void worker.terminate();
      });
      worker.once('error', () => settle(null));
      worker.once('exit', () => settle(null));
    } catch {
      settle(null);
    }
  });
}

/** `powershell.exe -NoProfile -NonInteractive -EncodedCommand <script>`: no quoting to get wrong. */
export function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/** A Windows FILETIME (decimal string) as ms since the epoch, or undefined. */
export function fileTimeToMs(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d{1,20}$/.test(text)) return undefined;
  const ticks = BigInt(text);
  if (ticks <= FILETIME_UNIX_EPOCH) return undefined;
  return Number((ticks - FILETIME_UNIX_EPOCH) / FILETIME_TICKS_PER_MS);
}

/**
 * Rows of `pid ppid rssKb cpu [start]`. Malformed lines are skipped – a table read while
 * processes exit can hold torn rows. The first four columns parse exactly as the sampler's `ps`
 * parser always did; a fifth, a Windows FILETIME, becomes `startedAt`.
 */
export function parseProcessRows(text: string): ProcRow[] {
  const out: ProcRow[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rssKb = Number(parts[2]);
    const cpuPct = Number(parts[3]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const startedAt = fileTimeToMs(parts[4]);
    out.push({
      pid,
      ppid,
      rssKb: Number.isFinite(rssKb) && rssKb > 0 ? rssKb : 0,
      cpuPct: Number.isFinite(cpuPct) && cpuPct > 0 ? cpuPct : 0,
      ...(startedAt !== undefined ? { startedAt } : {}),
    });
  }
  return out;
}

/**
 * macOS `lstart` in the C locale – `Mon Sep 29 20:31:05 2026`, local time – as ms since the
 * epoch, or undefined. Whole seconds: that is all `ps` prints.
 */
export function lstartToMs(tokens: readonly string[]): number | undefined {
  if (tokens.length !== 5) return undefined;
  const [, monthName, day, time, year] = tokens as [string, string, string, string, string];
  const month = LSTART_MONTHS.indexOf(monthName);
  const hms = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(time);
  if (month === -1 || hms === null || !/^\d{1,2}$/.test(day) || !/^\d{4}$/.test(year)) return undefined;
  const ms = new Date(Number(year), month, Number(day), Number(hms[1]), Number(hms[2]), Number(hms[3])).getTime();
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}

/** macOS rows: the four sampler columns, parsed exactly as `parseProcessRows` does, then `lstart`. */
export function parseDarwinRows(text: string): ProcRow[] {
  const out: ProcRow[] = [];
  for (const line of text.split('\n')) {
    const [row] = parseProcessRows(line);
    if (row === undefined) continue;
    const startedAt = lstartToMs(line.trim().split(/\s+/).slice(4));
    out.push(startedAt === undefined ? row : { ...row, startedAt });
  }
  return out;
}

/** `ps` in the C locale, so `lstart` has one spelling whatever the user's language. */
function cLocaleEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, LC_ALL: 'C' };
}

/** The Windows script's output: its `queried <FILETIME>` line, then rows. */
export function parseWindowsTable(text: string, fallbackQueriedAt: number): ProcessTable {
  const queried = /^\s*queried (\d+)\s*$/m.exec(text);
  const queriedAt = fileTimeToMs(queried?.[1]) ?? fallbackQueriedAt;
  return { rows: parseProcessRows(text), queriedAt };
}

/**
 * One snapshot of every process, or null when it cannot be read. Never rejects. POSIX: `ps -axo
 * pid=,ppid=,rss=,%cpu=`, 16 MiB of output; macOS adds `lstart=` under `LC_ALL=C` and floors
 * `queriedAt` to the second, the resolution of its start times. Windows: PowerShell's
 * Win32_Process with each process's creation time, and the query's own start time.
 */
export async function readProcessTable(
  opts: ReadTableOptions = {},
  deps: ProcessTableDeps = {},
): Promise<ProcessTable | null> {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? defaultTableRunner;
  const startedAt = Date.now();
  try {
    if (platform === 'win32') {
      // The sampler ran a bare `powershell` before #963: it may still search PATH, safely.
      const powershell = powershellPath(deps.env ?? process.env, { searchPath: true }, { exists: deps.exists });
      if (powershell === null) return null;
      const text = await run(powershell, powershellArgs(WINDOWS_TABLE_SCRIPT), {
        maxBuffer: TABLE_MAX_BUFFER,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        hide: true,
      });
      return text === null ? null : parseWindowsTable(text, startedAt);
    }
    if (platform === 'darwin') {
      const text = await run('ps', PS_ARGS_DARWIN, {
        maxBuffer: TABLE_MAX_BUFFER,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        env: cLocaleEnv(deps.env ?? process.env),
      });
      const queriedAt = Math.floor(startedAt / MS_PER_SECOND) * MS_PER_SECOND;
      return text === null ? null : { rows: parseDarwinRows(text), queriedAt };
    }
    const text = await run('ps', PS_ARGS, {
      maxBuffer: TABLE_MAX_BUFFER,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return text === null ? null : { rows: parseProcessRows(text), queriedAt: startedAt };
  } catch {
    return null;
  }
}

/**
 * The highest pid that belongs to the system itself and is never a stop target: POSIX init (1);
 * Windows' System Idle (0) and System (4) processes. The one rule every stop and sweep uses.
 */
export function systemPidFloor(deps: { platform?: NodeJS.Platform } = {}): number {
  return (deps.platform ?? process.platform) === 'win32' ? WINDOWS_SYSTEM_PID_MAX : POSIX_SYSTEM_PID_MAX;
}

/** The root of a walk. With `spawnedAt` and `stoppedAt` the walk is creation-filtered. */
export type TreeRoot = { pid: number } | { pid: number; spawnedAt: number; stoppedAt: number };

function childrenByParent(rows: readonly ProcRow[]): Map<number, ProcRow[]> {
  const children = new Map<number, ProcRow[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }
  return children;
}

/** The sampler's walk, in its visiting order: every row reached through parent pids. */
function walkAll(rows: readonly ProcRow[], rootPid: number): number[] {
  const children = childrenByParent(rows);
  const out: number[] = [];
  const seen = new Set<number>(); // pid reuse in a torn snapshot cannot loop the walk
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (pid !== rootPid) out.push(pid);
    for (const child of children.get(pid) ?? []) stack.push(child.pid);
  }
  return out;
}

/** A direct child created between `spawnedAt − slack` and `stoppedAt + slack`; below it, a row
 *  created no earlier than its parent. A row without a start time never counts. */
function walkCreatedWithin(rows: readonly ProcRow[], root: { pid: number; spawnedAt: number; stoppedAt: number }): number[] {
  const children = childrenByParent(rows);
  const out: number[] = [];
  const seen = new Set<number>([root.pid]);
  const stack = (children.get(root.pid) ?? []).filter(
    (row) =>
      row.startedAt !== undefined &&
      row.startedAt >= root.spawnedAt - SPAWN_CLOCK_SLACK_MS &&
      row.startedAt <= root.stoppedAt + STOP_CLOCK_SLACK_MS,
  );
  while (stack.length > 0) {
    const row = stack.pop()!;
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    out.push(row.pid);
    for (const child of children.get(row.pid) ?? []) {
      if (child.startedAt !== undefined && child.startedAt >= row.startedAt!) stack.push(child);
    }
  }
  return out;
}

/**
 * The descendants of `root` in `rows`, the root excluded. Without start times in the root it is
 * the sampler's plain walk by parent pid (unchanged results on POSIX). With them it is the
 * creation-filtered walk: a parent pid that outlived its process may now name an unrelated,
 * newer process, and only the start times tell them apart.
 */
export function descendantPids(rows: readonly ProcRow[], root: TreeRoot): number[] {
  return 'spawnedAt' in root ? walkCreatedWithin(rows, root) : walkAll(rows, root.pid);
}

export interface IdentifiedPid {
  pid: number;
  startedAt: number;
}

/** `descendantPids` of a creation-filtered root, each with the start time that identifies it. */
export function descendantTargets(
  rows: readonly ProcRow[],
  root: { pid: number; spawnedAt: number; stoppedAt: number },
): IdentifiedPid[] {
  const started = new Map<number, number>();
  for (const row of rows) if (row.startedAt !== undefined) started.set(row.pid, row.startedAt);
  return descendantPids(rows, root).flatMap((pid) => {
    const startedAt = started.get(pid);
    return startedAt === undefined ? [] : [{ pid, startedAt }];
  });
}

export type KillOutcome = 'killed' | 'gone' | 'mismatch' | 'denied';

/** The targets a kill may be asked for: integers only, never a system pid or xezar itself, each
 *  pid once. Only these are ever written into a kill script or a kill helper's input. */
export function validTargets(targets: readonly IdentifiedPid[]): IdentifiedPid[] {
  const seen = new Set<number>();
  return targets.filter(({ pid, startedAt }) => {
    const valid =
      Number.isSafeInteger(pid) &&
      pid > systemPidFloor({ platform: 'win32' }) &&
      pid !== process.pid &&
      Number.isSafeInteger(startedAt) &&
      startedAt > 0 &&
      !seen.has(pid);
    if (valid) seen.add(pid);
    return valid;
  });
}

/**
 * The kill loop over `$t`, a flat array of `pid, startedAt` pairs. Per pid it opens the process,
 * keeps that one handle (`.Handle`), compares the start time with `startedAt` at 1 ms (±1 ms for
 * CIM's rounding) and kills through the same handle, so a reused pid is never killed. One line
 * per pid: `<pid> killed|gone|mismatch|denied`.
 */
export const KILL_LOOP_SCRIPT = [
  'for ($i = 0; $i -lt $t.Count; $i += 2) {',
  '  $id = [int]$t[$i]; $want = [long]$t[$i + 1]',
  '  try { $p = [Diagnostics.Process]::GetProcessById($id) } catch { "$id gone"; continue }',
  '  try {',
  '    $null = $p.Handle',
  '    $ms = [Math]::Floor(($p.StartTime.ToFileTimeUtc() - 116444736000000000) / 10000)',
  '    if ($p.HasExited) { "$id gone" } elseif ([Math]::Abs($ms - $want) -gt 1) { "$id mismatch" } else { $p.Kill(); "$id killed" }',
  '  } catch {',
  '    $state = "denied"; try { if ($p.HasExited) { $state = "gone" } } catch {}',
  '    "$id $state"',
  '  } finally { $p.Dispose() }',
  '}',
].join('\n');

/** The fixed kill script: the loop over `targets`. Only validated integers are embedded. */
export function killScript(targets: readonly IdentifiedPid[]): string {
  const pairs = validTargets(targets)
    .map(({ pid, startedAt }) => `${pid},${startedAt}`)
    .join(',');
  return ["$ErrorActionPreference = 'Stop'", `$t = @(${pairs})`, KILL_LOOP_SCRIPT].join('\n');
}

/** Reads `<pid> <outcome>` lines into `into`, for the asked pids only. */
export function parseKillOutcomes(text: string, asked: ReadonlySet<number>, into: Map<number, KillOutcome>): void {
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+) (killed|gone|mismatch|denied)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (asked.has(pid)) into.set(pid, match[2] as KillOutcome);
  }
}

/**
 * win32: kill each target whose start time still matches, through PowerShell from System32
 * (5 s bound, hidden window). The outcome per pid, or null when nothing could run. Off Windows:
 * null. Nothing to kill: an empty map, without starting anything. Never rejects.
 */
export async function killIdentified(
  targets: readonly IdentifiedPid[],
  deps: ProcessTableDeps = {},
): Promise<Map<number, KillOutcome> | null> {
  if ((deps.platform ?? process.platform) !== 'win32') return null;
  const valid = validTargets(targets);
  const outcomes = new Map<number, KillOutcome>();
  if (valid.length === 0) return outcomes;
  const powershell = powershellPath(deps.env ?? process.env);
  if (powershell === null) return null;
  const run = deps.run ?? defaultTableRunner;
  let ran = false;
  try {
    for (let from = 0; from < valid.length; from += KILL_BATCH) {
      const batch = valid.slice(from, from + KILL_BATCH);
      const text = await run(powershell, powershellArgs(killScript(batch)), {
        maxBuffer: KILL_MAX_BUFFER,
        timeoutMs: KILL_IDENTIFIED_TIMEOUT_MS,
        hide: true,
      });
      if (text === null) continue;
      ran = true;
      parseKillOutcomes(text, new Set(batch.map(({ pid }) => pid)), outcomes);
    }
  } catch {
    // a throwing runner: report what ran
  }
  return ran ? outcomes : null;
}

export type SignalOutcome = 'sent' | 'gone' | 'denied';

/**
 * POSIX: `process.kill(pid, signal)` for one process. `gone` when it no longer exists, `denied`
 * when it may not be signalled. Never 0, 1, a negative pid (a whole group or every process) or
 * this process: those are `denied` without sending anything.
 */
export function signalPid(pid: number, signal: NodeJS.Signals): SignalOutcome {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return 'denied';
  try {
    process.kill(pid, signal);
    return 'sent';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'denied';
  }
}

/** Test seams for `startTimeOf`. */
export interface StartTimeDeps {
  platform?: NodeJS.Platform;
  readText?: (path: string) => Promise<string>;
  /** macOS: runs `ps`. */
  run?: TableRunner;
  env?: NodeJS.ProcessEnv;
}

/** How long a macOS `ps -p` for one start time may take. */
const START_TIME_TIMEOUT_MS = 2_000;
const START_TIME_MAX_BUFFER = 64 * 1024;

/** macOS: `ps -o lstart= -p <pid>` in the C locale, as `readProcessTable`'s rows carry it. */
async function darwinStartTimeOf(pid: number, deps: StartTimeDeps): Promise<number | null> {
  const text = await (deps.run ?? defaultTableRunner)('ps', ['-o', 'lstart=', '-p', String(pid)], {
    maxBuffer: START_TIME_MAX_BUFFER,
    timeoutMs: START_TIME_TIMEOUT_MS,
    env: cLocaleEnv(deps.env ?? process.env),
  });
  return text === null ? null : (lstartToMs(text.trim().split(/\s+/)) ?? null);
}

/**
 * A process's start time, the identity a pid alone cannot give. Linux: field 22 of
 * `/proc/<pid>/stat` (clock ticks since boot), read after the LAST `)` because the command name
 * may itself hold one. macOS: `lstart` in ms, equal to the `startedAt` of the same process's
 * `readProcessTable` row. Comparable only with another `startTimeOf` (or, on macOS, a row) of the
 * same machine. Null when unreadable, and on every other platform. Never rejects.
 */
export async function startTimeOf(pid: number, deps: StartTimeDeps = {}): Promise<number | null> {
  const platform = deps.platform ?? process.platform;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (platform === 'darwin') {
    try {
      return await darwinStartTimeOf(pid, deps);
    } catch {
      return null;
    }
  }
  if (platform !== 'linux') return null;
  try {
    const text = await (deps.readText ?? ((path: string) => readFile(path, 'utf8')))(`/proc/${pid}/stat`);
    const close = text.lastIndexOf(')');
    if (close === -1) return null;
    // Fields 3… follow ") "; field 22 is the 20th of them.
    const field = text.slice(close + 2).split(' ')[19];
    const ticks = Number(field);
    return field !== undefined && Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null;
  } catch {
    return null;
  }
}
