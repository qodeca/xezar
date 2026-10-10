/**
 * The Git Bash (MSYS) half of a Windows tree stop (#963), ported from the kit's
 * `windows-process.mjs`.
 *
 * When an MSYS process execs, or a subshell that started a program exits, the program lives on
 * in a Windows process whose parent has already exited, so a Windows parent-pid walk from the
 * shell xezar started stops short of it. Git's own `ps.exe` still lists every process of the
 * shell's MSYS process group with its Windows pid (WINPID). Those become extra starting points of
 * the Windows walk, each still identified by its Windows creation time.
 *
 * A non-interactive `bash -c` started by a Windows program leads its own process group, so its
 * MSYS pid is the group id. `launchMsys` has the shell write that pid (`$$`) to a file as its
 * first act: a shell killed before it gets that far has started nothing.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { readFileSync } from 'node:fs';
import { SPAWN_CLOCK_SLACK_MS, type IdentifiedPid, type ProcRow, type TableRunner } from './process-table.ts';

/** One row of Git's `ps`. */
export interface MsysRow {
  pid: number;
  ppid: number;
  pgid: number;
  winpid: number;
}

/** What a stop needs to find a shell's MSYS processes: Git's `ps.exe`, and the file the shell
 *  writes its own MSYS pid to. */
export interface MsysTree {
  ps: string;
  pidFile: string;
}

const MSYS_ROW = /^\s*(?:[A-Za-z]\s+)?(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s|$)/;
const PS_MAX_BUFFER = 1024 * 1024;
const PS_TIMEOUT_MS = 5_000;
const WINDOWS_SYSTEM_PID_MAX = 4;

/** Git's `ps` output: an optional one-letter status, then PID PPID PGID WINPID. The header and
 *  torn lines are skipped. */
export function parseMsysTable(text: string): MsysRow[] {
  const rows: MsysRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = MSYS_ROW.exec(line);
    if (!match) continue;
    const [pid, ppid, pgid, winpid] = match.slice(1, 5).map(Number) as [number, number, number, number];
    if ([pid, ppid, pgid, winpid].every(Number.isSafeInteger)) rows.push({ pid, ppid, pgid, winpid });
  }
  return rows;
}

/** The shell's MSYS pid from its pid file, or null when it never got that far. */
export function readMsysPid(pidFile: string, read: (path: string) => string = (path) => readFileSync(path, 'utf8')): number | null {
  try {
    const text = read(pidFile).trim();
    if (!/^\d{1,10}$/.test(text)) return null;
    const pid = Number(text);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** The Windows pids of the shell's MSYS process group, and of everything reached from its MSYS
 *  pid through PPID. None without the MSYS pid. */
export function msysMemberWinpids(rows: readonly MsysRow[], msysPid: number | null): number[] {
  if (msysPid === null) return [];
  const members = new Map<number, number>();
  for (const row of rows) if (row.pgid === msysPid) members.set(row.pid, row.winpid);
  const children = new Map<number, MsysRow[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const stack = [msysPid];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const row of children.get(pid) ?? []) {
      members.set(row.pid, row.winpid);
      stack.push(row.pid);
    }
  }
  return [...new Set(members.values())];
}

/**
 * The extra kill targets for one shell: each Windows pid in `starts` that was created within
 * [spawnedAt − 1 s, readAt], and below it every process created no earlier than its parent (the
 * kit's `treeTargets`). Never the shell itself (its own handle stops it), `selfPid`, or pids 0–4.
 */
export function msysTreeTargets(
  rows: readonly ProcRow[],
  starts: readonly number[],
  root: { pid: number; spawnedAt: number; readAt: number },
  selfPid: number = process.pid,
): IdentifiedPid[] {
  const never = (pid: number): boolean => pid === root.pid || pid === selfPid || pid <= WINDOWS_SYSTEM_PID_MAX;
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const children = new Map<number, ProcRow[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const inWindow = (row: ProcRow): boolean =>
    row.startedAt !== undefined && row.startedAt >= root.spawnedAt - SPAWN_CLOCK_SLACK_MS && row.startedAt <= root.readAt;
  const stack = starts
    .filter((pid) => !never(pid))
    .map((pid) => byPid.get(pid))
    .filter((row): row is ProcRow => row !== undefined && inWindow(row));
  const targets = new Map<number, number>();
  while (stack.length > 0) {
    const row = stack.pop()!;
    if (targets.has(row.pid) || never(row.pid)) continue;
    targets.set(row.pid, row.startedAt!);
    for (const child of children.get(row.pid) ?? []) {
      if (child.startedAt !== undefined && child.startedAt >= row.startedAt!) stack.push(child);
    }
  }
  return [...targets].map(([pid, startedAt]) => ({ pid, startedAt }));
}

/** One read of Git's `ps`, hidden and bounded: its rows, or null when it could not run. Never rejects. */
export async function readMsysTable(ps: string, run: TableRunner): Promise<MsysRow[] | null> {
  try {
    const text = await run(ps, [], { maxBuffer: PS_MAX_BUFFER, timeoutMs: PS_TIMEOUT_MS, hide: true });
    return text === null ? null : parseMsysTable(text);
  } catch {
    return null;
  }
}

/**
 * The first line of a check step's script: the shell writes its MSYS pid to `pidFile` and goes on.
 * Joined with `;` on the SAME line, so bash's "line N" in an error message is unchanged. Null when
 * the path cannot sit inside single quotes.
 */
export function msysPidPrefix(pidFile: string): string | null {
  const path = pidFile.replace(/\\/g, '/');
  if (path.includes("'")) return null;
  return `printf %s "$$" >'${path}' 2>/dev/null; `;
}
