/**
 * What a run's process sweep reads about one process (#943): is it alive, does its environment
 * prove the run started it, and what is its command line.
 *
 * The proof is xezar's own marker: every agent xezar starts carries `XEZ_TASK_ID=<runId>`, and a
 * process that inherited it holds the same entry in its environment. On Linux that is readable
 * without starting anything (`/proc/<pid>/environ`); elsewhere the sweep keeps its own ledger.
 * The environment holds the user's secrets, so `envHasEntry` answers yes or no and keeps
 * nothing, and `readCommandLines` is asked only about the pids a report is about to name.
 * Every reader never rejects and drops the error object, which may carry the program's output.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { powershellPath } from './system-programs.ts';
import {
  defaultTableRunner,
  KILL_BATCH,
  KILL_IDENTIFIED_TIMEOUT_MS,
  killIdentified,
  killScript,
  parseKillOutcomes,
  powershellArgs,
  systemPidFloor,
  validTargets,
  type IdentifiedPid,
  type KillOutcome,
  type ProcessTableDeps,
} from './process-table.ts';

/** The environment entry every agent of a run carries (`RunManager.agentEnv`): `XEZ_TASK_ID=<runId>`. */
export const RUN_MARKER_ENV = 'XEZ_TASK_ID';

/**
 * `env` without the run marker, or undefined when it holds none (the child then inherits, exactly
 * as before). For a program xezar opens FOR the user – an editor, a terminal, a browser – which
 * must never count as started by a run, even when xezar itself runs inside one (#943). Windows
 * reads environment names case-insensitively, so every spelling goes there.
 */
export function withoutRunMarker(
  env: NodeJS.ProcessEnv,
  deps: { platform?: NodeJS.Platform } = {},
): NodeJS.ProcessEnv | undefined {
  const anyCase = (deps.platform ?? process.platform) === 'win32';
  const isMarker = (name: string): boolean =>
    anyCase ? name.toUpperCase() === RUN_MARKER_ENV : name === RUN_MARKER_ENV;
  const names = Object.keys(env);
  if (!names.some(isMarker)) return undefined;
  return Object.fromEntries(names.filter((name) => !isMarker(name)).map((name) => [name, env[name]]));
}

const COMMAND_LINES_MAX_BUFFER = 16 * 1024 * 1024;
const COMMAND_LINES_TIMEOUT_MS = 5_000;
/** At most this many command lines per call: a report names at most 50 per list. */
export const COMMAND_LINES_MAX = 100;

/**
 * Does `pid` exist? `process.kill(pid, 0)` sends nothing: true when it succeeds or the process
 * exists but may not be signalled (EPERM), false when it is gone. Never 0, 1 or a negative pid.
 */
export function pidExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Test seams for the `/proc` readers. Production passes none. */
export interface ProcFsDeps {
  platform?: NodeJS.Platform;
  readBytes?: (path: string) => Promise<Buffer>;
}

const readProcFile = (path: string): Promise<Buffer> => readFile(path);

/** True when `needle` is one whole NUL-delimited entry of `bytes`. */
function hasWholeEntry(bytes: Buffer, needle: Buffer): boolean {
  for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    if ((at === 0 || bytes[at - 1] === 0) && (end === bytes.length || bytes[end] === 0)) return true;
  }
  return false;
}

/**
 * Linux: does `/proc/<pid>/environ` hold exactly `entry` (`NAME=value`) as one whole
 * NUL-delimited entry? Only the answer leaves this function: the bytes are neither kept nor
 * logged, and an unreadable file (another user's process, `hidepid`) is `false`, never proof.
 * `false` on every other platform. Never rejects.
 */
export async function envHasEntry(pid: number, entry: string, deps: ProcFsDeps = {}): Promise<boolean> {
  if ((deps.platform ?? process.platform) !== 'linux') return false;
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  if (entry.indexOf('=') < 1 || entry.includes('\0')) return false;
  try {
    const environ = await (deps.readBytes ?? readProcFile)(`/proc/${pid}/environ`);
    return hasWholeEntry(environ, Buffer.from(entry, 'utf8'));
  } catch {
    return false;
  }
}

/** Test seams for `readCommandLines`. */
export interface CommandLineDeps extends ProcessTableDeps, ProcFsDeps {}

/** The pids worth asking about: valid, above the system pids, not this process, each once. */
function commandLinePids(pids: readonly number[], platform: NodeJS.Platform): number[] {
  const floor = systemPidFloor({ platform });
  const valid = pids.filter((pid) => Number.isSafeInteger(pid) && pid > floor && pid !== process.pid);
  return [...new Set(valid)].slice(0, COMMAND_LINES_MAX);
}

/**
 * The fixed Windows script. Only validated integers are embedded, and only those pids are
 * queried, so no other process's command line reaches its output. Each command line is printed
 * as base64 of UTF-8, so no command line can forge another row.
 */
export function commandLineScript(pids: readonly number[]): string {
  return ["$ProgressPreference = 'SilentlyContinue'", ...commandLineQuery(pids, '')].join('\n');
}

/** The query lines of `commandLineScript`, each row starting with `prefix`. */
function commandLineQuery(pids: readonly number[], prefix: string): string[] {
  const filter = commandLinePids(pids, 'win32')
    .map((pid) => `ProcessId = ${pid}`)
    .join(' OR ');
  return [
    `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object {`,
    '  $line = [string]$_.CommandLine',
    `  "${prefix}$($_.ProcessId) $([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line)))"`,
    '}',
  ];
}

/** `<pid> <command>` lines; only pids that were asked about, the first line for each. */
function parseCommandLineRows(
  text: string,
  asked: ReadonlySet<number>,
  decode: (value: string) => string,
): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+) (.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = decode(match[2]!).trim();
    if (asked.has(pid) && !out.has(pid) && command.length > 0) out.set(pid, command);
  }
  return out;
}

async function linuxCommandLines(pids: readonly number[], deps: ProcFsDeps): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const pid of pids) {
    try {
      const bytes = await (deps.readBytes ?? readProcFile)(`/proc/${pid}/cmdline`);
      const command = bytes.toString('utf8').split('\0').join(' ').trim();
      if (command.length > 0) out.set(pid, command);
    } catch {
      // gone, or not ours to read: no command line
    }
  }
  return out;
}

async function windowsCommandLines(pids: readonly number[], deps: CommandLineDeps): Promise<Map<number, string>> {
  const powershell = powershellPath(deps.env ?? process.env);
  if (powershell === null) return new Map();
  const text = await (deps.run ?? defaultTableRunner)(powershell, powershellArgs(commandLineScript(pids)), {
    maxBuffer: COMMAND_LINES_MAX_BUFFER,
    timeoutMs: COMMAND_LINES_TIMEOUT_MS,
    hide: true,
  });
  if (text === null) return new Map();
  return parseCommandLineRows(text, new Set(pids), (value) => Buffer.from(value, 'base64').toString('utf8'));
}

async function psCommandLines(pids: readonly number[], deps: CommandLineDeps): Promise<Map<number, string>> {
  const text = await (deps.run ?? defaultTableRunner)('ps', ['-ww', '-o', 'pid=,command=', '-p', pids.join(',')], {
    maxBuffer: COMMAND_LINES_MAX_BUFFER,
    timeoutMs: COMMAND_LINES_TIMEOUT_MS,
  });
  return text === null ? new Map() : parseCommandLineRows(text, new Set(pids), (value) => value);
}

/**
 * The command lines of these pids (at most `COMMAND_LINES_MAX`), for naming processes in a
 * report. Nothing else is queried. The text is raw: the caller redacts it before anyone sees it.
 * Linux: `/proc/<pid>/cmdline`. Windows: Win32_Process filtered to these pids, hidden, 5 s.
 * Other systems: `ps -ww -o pid=,command= -p …`, 5 s. A pid it cannot read is absent. Never
 * rejects.
 */
export async function readCommandLines(pids: readonly number[], deps: CommandLineDeps = {}): Promise<Map<number, string>> {
  const platform = deps.platform ?? process.platform;
  const wanted = commandLinePids(pids, platform);
  if (wanted.length === 0) return new Map();
  try {
    if (platform === 'linux') return await linuxCommandLines(wanted, deps);
    if (platform === 'win32') return await windowsCommandLines(wanted, deps);
    return await psCommandLines(wanted, deps);
  } catch {
    return new Map();
  }
}

/** What `nameAndKillIdentified` found: the command lines it read, and the kill outcomes (null
 *  when nothing could run, as `killIdentified` answers). */
export interface NamedKill {
  commands: Map<number, string>;
  outcomes: Map<number, KillOutcome> | null;
}

const NAME_ROW = 'name ';

/** The one script: the name query (its failure never stops the kill), then the kill loop. */
export function nameAndKillScript(targets: readonly IdentifiedPid[], named: readonly number[]): string {
  const query = commandLinePids(named, 'win32').length === 0 ? [] : commandLineQuery(named, NAME_ROW);
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    ...(query.length === 0 ? [] : ['try {', ...query.map((line) => `  ${line}`), '} catch {}']),
    killScript(targets),
  ].join('\n');
}

/**
 * win32, for a run's sweep (#963): ONE PowerShell reads the command lines of `named`, then runs
 * the identity kill (`killIdentified`'s loop) over `targets`. Each PowerShell start costs seconds
 * on a busy machine, and a sweep that started two in a row went past its 10 s cap and reported a
 * stop that had worked as "still running". Names first: after the kill they are gone. Name rows
 * carry a `name ` prefix, so no command line can read as a kill outcome. Targets past the first
 * kill batch go through `killIdentified`. Off Windows: nothing runs, outcomes null. Never rejects.
 */
export async function nameAndKillIdentified(
  targets: readonly IdentifiedPid[],
  named: readonly number[],
  deps: CommandLineDeps = {},
): Promise<NamedKill> {
  const commands = new Map<number, string>();
  if ((deps.platform ?? process.platform) !== 'win32') return { commands, outcomes: null };
  const valid = validTargets(targets);
  if (valid.length === 0) return { commands, outcomes: new Map() };
  const powershell = powershellPath(deps.env ?? process.env);
  if (powershell === null) return { commands, outcomes: null };
  const first = valid.slice(0, KILL_BATCH);
  let outcomes: Map<number, KillOutcome> | null = null;
  try {
    const text = await (deps.run ?? defaultTableRunner)(powershell, powershellArgs(nameAndKillScript(first, named)), {
      maxBuffer: COMMAND_LINES_MAX_BUFFER,
      timeoutMs: KILL_IDENTIFIED_TIMEOUT_MS + COMMAND_LINES_TIMEOUT_MS,
      hide: true,
    });
    if (text !== null) {
      const lines = text.split('\n');
      const rows = lines.filter((line) => line.startsWith(NAME_ROW)).map((line) => line.slice(NAME_ROW.length));
      const asked = new Set(commandLinePids(named, 'win32'));
      const decode = (value: string): string => Buffer.from(value, 'base64').toString('utf8');
      for (const [pid, command] of parseCommandLineRows(rows.join('\n'), asked, decode)) commands.set(pid, command);
      outcomes = new Map();
      parseKillOutcomes(text, new Set(first.map(({ pid }) => pid)), outcomes);
    }
  } catch {
    // a throwing runner: the rest still gets its kill
  }
  if (valid.length > KILL_BATCH) {
    const rest = await killIdentified(valid.slice(KILL_BATCH), deps);
    if (rest !== null) outcomes = new Map([...(outcomes ?? []), ...rest]);
  }
  return { commands, outcomes };
}
