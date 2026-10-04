// The gate scheduler's process layer on native Windows (Git Bash) (#122).
//
// Two files load it, both only on Windows: `gate-parallel.mjs` for the process layer, and
// `windows-programs.mjs` for `gitRoot`, `envGet` and `pathEntries`. Linux and macOS never read it.
// Off Windows the scheduler stops a gate by signalling the gate's process group;
// Windows has no signal a console program can catch from outside and no group a signal reaches,
// so this file does it the way the engine's own Windows layer does (`stopChildTree`,
// `readProcessTable`, `killIdentified`):
//   - the worker itself is stopped through Node's own handle (TerminateProcess), never by a pid;
//   - ONE process table is read (PowerShell, Win32_Process, each row with its creation time);
//   - descendants are chosen by creation time: a starting process created within
//     [spawnedAt - 1 s, stoppedAt], and below it a process created no earlier than its parent.
//     Windows reuses a pid, and a parent pid alone may by now name a stranger;
//   - each is killed by identity: one handle, the start time compared within 1 ms, Kill() through
//     that same handle. `taskkill /T` is never used: it follows parent pids that may by now name
//     unrelated processes.
//
// The MSYS layer is this file's own. A worker is a bash tree, and when an MSYS process execs, the
// program runs in a new Windows process whose parent has already exited, so a Windows parent-pid
// walk from the worker stops at its first `bash -c`, before the gate's own command. Git's ps.exe
// still lists every process of the worker's MSYS process group with its Windows pid (WINPID);
// those become extra starting points of the Windows walk.
//
// node:* imports only: this file installs and runs standalone in an onboarded project.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const win = path.win32;

export const GIT_BASH_MISSING =
  "Git Bash was not found. Install Git for Windows (it includes Git Bash) and make sure git.exe is on PATH; WSL's bash.exe is never used.";

/** A starting process may be dated slightly before `spawnedAt`, which is read after spawn returns. */
export const SPAWN_CLOCK_SLACK_MS = 1000;
const TOOL_TIMEOUT_MS = 5000;
const PS_MAX_BUFFER = 1024 * 1024;
const TABLE_MAX_BUFFER = 16 * 1024 * 1024;
const KILL_MAX_BUFFER = 1024 * 1024;
/** Targets per PowerShell run, so the encoded command stays far below Windows' 32 767 limit. */
const KILL_BATCH = 200;
/** Windows' System Idle (0) and System (4) processes. */
const SYSTEM_PID_MAX = 4;
/** 100 ns ticks between 1601-01-01 (FILETIME) and 1970-01-01. */
const FILETIME_UNIX_EPOCH = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;

// --- Git Bash, found the way this repository's scripts find it (a parity test holds them equal) --

const TOOLCHAINS = ['mingw64', 'clangarm64', 'mingw32'];
const DRIVE_PATH = /^[A-Za-z]:\\/;
const ABSOLUTE_ENTRY = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

/** A variable read the way Windows does: any case; with several spellings the lexicographically first key wins. */
export function envGet(env, name) {
  const upper = name.toUpperCase();
  const key = Object.keys(env).sort().find((k) => k.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
}

/** PATH's absolute folders (drive or UNC), in order, unquoted and normalised; a relative entry is never one. */
export function pathEntries(env) {
  return String(envGet(env, 'PATH') ?? '')
    .split(';')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1').trim())
    .filter((entry) => ABSOLUTE_ENTRY.test(entry))
    .map((entry) => win.normalize(entry));
}

/** The Git root a PATH folder holding git.exe implies, or null when the folder is not Git's layout. */
function rootFromGitDir(dir) {
  const name = win.basename(dir).toLowerCase();
  const parent = win.dirname(dir);
  if (name === 'bin' && TOOLCHAINS.includes(win.basename(parent).toLowerCase())) return win.dirname(parent);
  if (name === 'cmd' || name === 'bin') return parent;
  return null;
}

function installRoots(env) {
  const drive = (name) => {
    const value = envGet(env, name);
    return typeof value === 'string' && DRIVE_PATH.test(value) ? value : null;
  };
  return [
    ...['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)'].map((name) => drive(name) && win.join(drive(name), 'Git')),
    drive('LOCALAPPDATA') && win.join(drive('LOCALAPPDATA'), 'Programs', 'Git'),
  ];
}

/**
 * The Git for Windows root, or null. First each PATH folder holding git.exe that has Git's layout
 * (<root>\cmd, <root>\bin, <root>\<toolchain>\bin), then the usual install folders. A root counts
 * only with both bin\bash.exe and usr\bin\bash.exe. A bash.exe on PATH is never a candidate: on a
 * stock Windows the first one is WSL's launcher. Pure; `exists` is injectable for tests.
 */
export function gitRoot({ env = process.env, exists = existsSync } = {}) {
  const onPath = pathEntries(env)
    .filter((dir) => exists(win.join(dir, 'git.exe')))
    .map(rootFromGitDir);
  const candidates = [...onPath, ...installRoots(env)].filter(Boolean);
  const isGitBashRoot = (root) => exists(win.join(root, 'bin', 'bash.exe')) && exists(win.join(root, 'usr', 'bin', 'bash.exe'));
  return candidates.find(isGitBashRoot) ?? null;
}

/** A copy of env with "noglob" in MSYS (value kept, one key): otherwise the MSYS runtime globs an unquoted `*`. */
export function withNoglob(env) {
  const msys = envGet(env, 'MSYS') ?? '';
  const next = { ...env };
  for (const key of Object.keys(next)) if (key.toUpperCase() === 'MSYS') delete next[key];
  next.MSYS = /(^|\s)noglob(\s|$)/.test(msys) ? msys : msys ? `${msys} noglob` : 'noglob';
  return next;
}

/**
 * What the scheduler needs on Windows: { ok: true, bash, ps, powershell, env }, or
 * { ok: false, reason } with one plain sentence. bash is Git's usr\bin\bash.exe (no wrapper, so
 * the worker's pid is bash's own, which the scheduler stops by identity); a check script started
 * outside the scheduler takes the wrapper `gitBash()` (windows-programs.mjs) returns instead, which
 * puts Git's tools first on PATH. env carries MSYS=noglob, and NoDefaultCurrentDirectoryInExePath=1
 * so a bare program name in a gate is never taken from the working folder.
 */
export function prepare(env = process.env, { exists = existsSync } = {}) {
  const root = gitRoot({ env, exists });
  if (root === null) return { ok: false, reason: GIT_BASH_MISSING };
  const usrBin = win.join(root, 'usr', 'bin');
  const ps = win.join(usrBin, 'ps.exe');
  if (!exists(ps)) return { ok: false, reason: `Git's ps.exe was not found in ${usrBin}; install the full Git for Windows, not MinGit` };
  const systemRoot = envGet(env, 'SystemRoot');
  if (typeof systemRoot !== 'string' || !DRIVE_PATH.test(systemRoot)) {
    return { ok: false, reason: 'PowerShell was not found: SystemRoot is not a drive path, so System32 cannot be located' };
  }
  const powershell = win.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!exists(powershell)) return { ok: false, reason: `PowerShell was not found at ${powershell}` };
  const next = withNoglob(env);
  for (const key of Object.keys(next)) if (key.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH') delete next[key];
  next.NoDefaultCurrentDirectoryInExePath = '1';
  return { ok: true, bash: win.join(usrBin, 'bash.exe'), ps, powershell, env: next };
}

/**
 * One argument on an MSYS program's command line. The MSYS runtime does not read libuv's \"
 * escaping: inside "…" everything is literal except `"`, which is written closed, single-quoted
 * and reopened. With MSYS=noglob this round-trips spaces, `*`, `{a,b}`, backslashes, empty
 * strings and quotes.
 */
export function msysQuote(arg) {
  return `"${String(arg).replaceAll('"', `"'"'"`)}"`;
}

// --- the two tables ------------------------------------------------------------------------------

const MSYS_ROW = /^\s*(?:[A-Za-z]\s+)?(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s|$)/;

/** Git's ps output: an optional one-letter status, then PID PPID PGID WINPID; the header and torn lines are skipped. */
export function parseMsysTable(text) {
  const rows = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = MSYS_ROW.exec(line);
    if (!match) continue;
    const [pid, ppid, pgid, winpid] = match.slice(1, 5).map(Number);
    if ([pid, ppid, pgid, winpid].every(Number.isSafeInteger)) rows.push({ pid, ppid, pgid, winpid });
  }
  return rows;
}

/** A Windows FILETIME (decimal string) as ms since the epoch, or undefined. */
function fileTimeToMs(text) {
  if (text === undefined || !/^\d{1,20}$/.test(text)) return undefined;
  const ticks = BigInt(text);
  if (ticks <= FILETIME_UNIX_EPOCH) return undefined;
  return Number((ticks - FILETIME_UNIX_EPOCH) / FILETIME_TICKS_PER_MS);
}

/** The table script's output: one `pid ppid <FILETIME|->` row per process; torn rows are skipped. */
export function parseWindowsTable(text) {
  const rows = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    const startedAt = fileTimeToMs(parts[2]);
    rows.push({ pid, ppid, ...(startedAt !== undefined ? { startedAt } : {}) });
  }
  return rows;
}

const byKey = (rows, key) => {
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row[key]);
    if (list) list.push(row);
    else map.set(row[key], [row]);
  }
  return map;
};

/** The worker's MSYS processes: its process group, and everything reached from it through PPID. None without its MSYS pid. */
function msysMembers(msysRows, msysPid) {
  if (!Number.isSafeInteger(msysPid) || msysPid <= 0) return [];
  const members = new Map();
  for (const row of msysRows) if (row.pgid === msysPid) members.set(row.pid, row);
  const children = byKey(msysRows, 'ppid');
  const stack = [msysPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const row of children.get(pid) ?? []) {
      members.set(row.pid, row);
      stack.push(row.pid);
    }
  }
  return [...members.values()];
}

/**
 * The processes to kill for one worker, each with the start time that identifies it.
 * root = { winpid, msysPid, spawnedAt, stoppedAt }. Starting points: the Windows pids of the
 * worker's MSYS members, and the Windows processes whose parent pid is the worker's. A starting
 * point counts only when it was created within [spawnedAt - 1 s, stoppedAt]; below a counted
 * process, a child counts when it was created no earlier than its parent. Never the worker itself
 * (the caller stops it through its own handle), `selfPid`, or pids 0-4. Each pid once.
 */
export function treeTargets({ msysRows = [], winRows = [], root, selfPid = process.pid }) {
  const never = (pid) => pid === root.winpid || pid === selfPid || pid <= SYSTEM_PID_MAX;
  const winByPid = new Map(winRows.map((row) => [row.pid, row]));
  const starts = new Set(msysMembers(msysRows, root.msysPid).map((row) => row.winpid));
  for (const row of winRows) if (row.ppid === root.winpid) starts.add(row.pid);
  const inWindow = (row) => row.startedAt !== undefined && row.startedAt >= root.spawnedAt - SPAWN_CLOCK_SLACK_MS && row.startedAt <= root.stoppedAt;
  const children = byKey(winRows, 'ppid');
  const stack = [...starts].filter((pid) => !never(pid)).map((pid) => winByPid.get(pid)).filter((row) => row && inWindow(row));
  const targets = new Map();
  while (stack.length) {
    const row = stack.pop();
    if (targets.has(row.pid) || never(row.pid)) continue;
    targets.set(row.pid, row.startedAt);
    for (const child of children.get(row.pid) ?? []) {
      if (child.startedAt !== undefined && child.startedAt >= row.startedAt) stack.push(child);
    }
  }
  return [...targets].map(([pid, startedAt]) => ({ pid, startedAt }));
}

// --- PowerShell ------------------------------------------------------------------------------------

/** One row per process: pid ppid creation-FILETIME (`-` when Windows gives none). */
const TABLE_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  'Get-CimInstance Win32_Process | ForEach-Object {',
  "  $start = '-'",
  '  if ($_.CreationDate) { $start = $_.CreationDate.ToFileTimeUtc() }',
  '  "$($_.ProcessId) $($_.ParentProcessId) $start"',
  '}',
].join('\n');

/** `-EncodedCommand`: no quoting to get wrong. */
function powershellArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function validTargets(targets, selfPid = process.pid) {
  const seen = new Set();
  return targets.filter(({ pid, startedAt }) => {
    const valid = Number.isSafeInteger(pid) && pid > SYSTEM_PID_MAX && pid !== selfPid &&
      Number.isSafeInteger(startedAt) && startedAt > 0 && !seen.has(pid);
    if (valid) seen.add(pid);
    return valid;
  });
}

/**
 * The kill script; only validated integers are embedded. Per pid it opens the process, keeps that
 * one handle, compares its start time with `startedAt` at 1 ms, and kills through the same
 * handle, so a reused pid is never killed. One line per pid: `<pid> killed|gone|mismatch|denied`.
 */
export function killScript(targets) {
  const pairs = validTargets(targets).map(({ pid, startedAt }) => `${pid},${startedAt}`).join(',');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$t = @(${pairs})`,
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
}

/** The outcome of each pid that was asked for, from the kill script's output. */
export function parseKillOutcomes(text, asked) {
  const outcomes = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(\d+) (killed|gone|mismatch|denied)\s*$/.exec(line);
    if (match && asked.has(Number(match[1]))) outcomes.set(Number(match[1]), match[2]);
  }
  return outcomes;
}

/** Runs one program without a shell: its stdout, or null on any failure (stderr dropped). Never rejects. */
function defaultRun(file, args, { maxBuffer, timeoutMs }) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { encoding: 'utf8', maxBuffer, timeout: timeoutMs, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout));
    } catch {
      resolve(null);
    }
  });
}

/**
 * One stop round for a worker: read Git's ps, then (unless nothing of the worker is left and the
 * worker was not just killed) the Windows table, and kill the chosen processes by identity.
 * tools = prepare()'s { ps, powershell }. Resolves { ok, killed, reason? }: ok is false when a
 * table could not be read, PowerShell did not run, or a process could not be killed (denied);
 * a process already gone, or a pid now naming another process, is fine. Never rejects.
 */
export async function stopTree(root, tools, { killRoot = false, run = defaultRun } = {}) {
  try {
    const psText = await run(tools.ps, [], { maxBuffer: PS_MAX_BUFFER, timeoutMs: TOOL_TIMEOUT_MS });
    const msysRows = psText === null ? [] : parseMsysTable(psText);
    // After the worker exited by itself, a readable ps with no member left is the whole answer: a
    // process whose every ancestor exited and that left the group is out of reach on both layers.
    // Only when the worker's MSYS pid is known: without it no member can be found, and the
    // Windows table is the one place the worker's processes still show.
    const knowsGroup = Number.isSafeInteger(root.msysPid) && root.msysPid > 0;
    if (!killRoot && knowsGroup && psText !== null && msysMembers(msysRows, root.msysPid).length === 0) return { ok: true, killed: 0 };
    const tableText = await run(tools.powershell, powershellArgs(TABLE_SCRIPT), { maxBuffer: TABLE_MAX_BUFFER, timeoutMs: TOOL_TIMEOUT_MS });
    if (tableText === null) return { ok: false, killed: 0, reason: 'the Windows process table could not be read' };
    const targets = validTargets(treeTargets({ msysRows, winRows: parseWindowsTable(tableText), root }));
    let killed = 0;
    const denied = [];
    let unran = false;
    for (let from = 0; from < targets.length; from += KILL_BATCH) {
      const batch = targets.slice(from, from + KILL_BATCH);
      const text = await run(tools.powershell, powershellArgs(killScript(batch)), { maxBuffer: KILL_MAX_BUFFER, timeoutMs: TOOL_TIMEOUT_MS });
      if (text === null) { unran = true; continue; }
      for (const [pid, outcome] of parseKillOutcomes(text, new Set(batch.map((t) => t.pid)))) {
        if (outcome === 'killed') killed += 1;
        if (outcome === 'denied') denied.push(pid);
      }
    }
    if (psText === null) return { ok: false, killed, reason: "Git's ps.exe could not be read" };
    if (unran) return { ok: false, killed, reason: 'PowerShell did not run the kill' };
    if (denied.length) return { ok: false, killed, reason: `access denied to process ${denied.join(', ')}` };
    return { ok: true, killed };
  } catch (error) {
    return { ok: false, killed: 0, reason: String(error?.message ?? error) };
  }
}
