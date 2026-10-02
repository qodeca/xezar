/**
 * One PowerShell for a whole Windows descendant stop (#963 C-02): it reads the process table,
 * hands it over, then kills by identity the targets it is handed back – one start instead of a
 * table read and a separate `killIdentified`.
 *
 * Starting PowerShell is most of what a stop costs: about a second on an idle machine and several
 * under CPU load, and Windows creates the process while the event loop waits. Measured with 16
 * busy programs on 16 cores, a table read took 8.5-12 s and the separate kill 3 more, so the
 * Windows shutdown ran out of time before any descendant was stopped. So the helper starts once,
 * and at above-normal priority: the builds and tests a task runs at normal priority no longer
 * starve it (4-5.5 s for the whole stop under the same load, about 1.3 s idle).
 *
 * The exchange: the table script's output, then the line `end-of-table`; the helper then reads ONE
 * line from its stdin – `pid,startedAt,pid,startedAt…`, validated integers only, or empty – and
 * answers one `<pid> <outcome>` line per pid, exactly as `killIdentified` does.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { constants, setPriority } from 'node:os';
import {
  KILL_LOOP_SCRIPT,
  WINDOWS_TABLE_SCRIPT,
  parseKillOutcomes,
  parseWindowsTable,
  powershellArgs,
  validTargets,
  type IdentifiedPid,
  type KillOutcome,
  type ProcessTable,
} from './process-table.ts';
import { powershellPath } from './system-programs.ts';

const END_OF_TABLE = 'end-of-table';
const END_OF_TABLE_LINE = /^end-of-table\r?$/m;
/** The table is at most what a table read keeps; the outcomes are one short line per pid. */
const HELPER_MAX_OUTPUT = 17 * 1024 * 1024;

const HELPER_SCRIPT = [
  WINDOWS_TABLE_SCRIPT,
  `"${END_OF_TABLE}"`,
  '$line = [Console]::In.ReadLine()',
  "$ErrorActionPreference = 'Stop'",
  "$t = @(); if ($line) { $t = @($line.Split(',') | ForEach-Object { [long]$_ }) }",
  KILL_LOOP_SCRIPT,
].join('\n');

/** The slice of a started helper this module uses; a test passes a fake. */
export interface KillHelper {
  readonly pid?: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  kill(): boolean;
  once(event: 'close', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

/** Test seams. Production passes none. */
export interface TableThenKillDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Start the helper: hidden, stdin and stdout piped. */
  start?: (file: string, args: readonly string[]) => KillHelper;
  /** Raise the helper's priority; best effort. */
  raise?: (pid: number) => void;
}

export interface TableThenKillResult {
  table: ProcessTable;
  /** Per asked pid, the outcome the helper reported (a pid it never answered for is absent). */
  outcomes: Map<number, KillOutcome>;
}

function startHelper(file: string, args: readonly string[]): KillHelper {
  return spawn(file, [...args], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
}

function raiseToAboveNormal(pid: number): void {
  setPriority(pid, constants.priority.PRIORITY_ABOVE_NORMAL);
}

/**
 * win32: read the process table and kill, by identity, the targets `choose` picks from it – in one
 * PowerShell from System32, hidden, at above-normal priority, ended after `timeoutMs` whatever it
 * is doing. The table and the outcomes, or null when no table arrived (off Windows, no usable
 * SystemRoot, a helper that failed or timed out first). `choose` answering nothing, or throwing,
 * kills nothing. Never rejects.
 */
export function readTableThenKill(
  choose: (table: ProcessTable) => readonly IdentifiedPid[],
  opts: { timeoutMs: number },
  deps: TableThenKillDeps = {},
): Promise<TableThenKillResult | null> {
  if ((deps.platform ?? process.platform) !== 'win32') return Promise.resolve(null);
  const powershell = powershellPath(deps.env ?? process.env);
  if (powershell === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let helper: KillHelper;
    try {
      helper = (deps.start ?? startHelper)(powershell, powershellArgs(HELPER_SCRIPT));
    } catch {
      resolve(null);
      return;
    }
    try {
      if (helper.pid !== undefined) (deps.raise ?? raiseToAboveNormal)(helper.pid);
    } catch {
      // normal priority, then: slower under load, never wrong
    }
    let text = '';
    let table: ProcessTable | undefined;
    let outcomesFrom = 0;
    let asked = new Set<number>();
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (table === undefined) {
        resolve(null);
        return;
      }
      const outcomes = new Map<number, KillOutcome>();
      parseKillOutcomes(text.slice(outcomesFrom), asked, outcomes);
      resolve({ table, outcomes });
    };
    const stopHelper = (): void => {
      try {
        helper.kill();
      } catch {
        // already gone
      }
      finish();
    };
    const timer = setTimeout(stopHelper, opts.timeoutMs);
    /** Once the table is complete: choose, and hand the targets over on one line. */
    const handOver = (): void => {
      const end = END_OF_TABLE_LINE.exec(text);
      if (end === null) return;
      table = parseWindowsTable(text.slice(0, end.index), startedAt);
      outcomesFrom = end.index + end[0].length;
      let targets: IdentifiedPid[] = [];
      try {
        targets = validTargets(choose(table));
      } catch {
        targets = [];
      }
      asked = new Set(targets.map(({ pid }) => pid));
      helper.stdin.end(`${targets.map(({ pid, startedAt: start }) => `${pid},${start}`).join(',')}\n`);
    };
    helper.stdin.on('error', () => undefined); // the helper ended before it read its line
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > HELPER_MAX_OUTPUT) stopHelper();
      else if (table === undefined) handOver();
    });
    helper.once('error', finish);
    helper.once('close', finish);
  });
}
