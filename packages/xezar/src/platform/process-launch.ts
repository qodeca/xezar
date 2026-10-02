/**
 * Starting a process (#963). Every program xezar starts goes through here.
 *
 * POSIX: each wrapper calls the matching `node:child_process` function with the very `file`,
 * `args` and `options` it was given – the same references, nothing added – after reading the
 * options for the two refusals below. Linux and macOS behave exactly as before.
 *
 * Windows: the command is first turned into one Windows can start without a shell
 * (`command-resolve.ts`: PATH search that never uses the working folder, `.mjs` through node,
 * npm shims unwrapped, other batch files only under the strict cmd.exe rule), background work
 * gets a hidden console window, and the child is tracked so a stop can reach what it starts.
 *
 * Refused on every OS, synchronously and before anything starts, with `CommandRefusedError`: a
 * truthy `shell` and a caller's `windowsVerbatimArguments` – both hand the arguments to a command
 * processor to re-read. cmd.exe itself starts only through `launchCmd`, which checks every token.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
// A bare name must never resolve in the working folder, even where src/index.ts never ran.
import './exe-search.ts';
import { Buffer } from 'node:buffer';
import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
  type ExecFileSyncOptionsWithStringEncoding,
  type SpawnOptions,
  type SpawnOptionsWithStdioTuple,
  type SpawnOptionsWithoutStdio,
  type StdioNull,
  type StdioPipe,
} from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CMD_LINE_MAX,
  cmdPayloadSafe,
  cmdQuotedPathSafe,
  cmdTokenSafe,
  cmdUrlSafe,
  verbatimLineLength,
} from './batch-line.ts';
import { trackChild } from './child-registry.ts';
import { CommandRefusedError, resolveCommand, type ResolveContext, type ResolveFs } from './command-resolve.ts';
import { withoutRunMarker } from './process-proof.ts';
import { system32Program } from './system-programs.ts';

/** How a launch may be shaped beyond its options. */
export interface LaunchPolicy {
  /** win32: hide the console window unless the options say otherwise. Background work only –
   *  never an agent session, a check step or anything the user watches. */
  hide?: boolean;
}

/** Test seams. Production passes none. `resolve` overrides the context built from the options,
 *  so the Windows shaping runs on every OS against a fake file system. */
export interface LaunchDeps {
  platform?: NodeJS.Platform;
  resolve?: Partial<ResolveContext>;
}

export type LaunchFileCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;

/** How long a detached start may fail before it counts as started. */
export const DETACHED_SETTLE_MS = 250;

const CMD_EXE_NAME = 'cmd.exe';

type StdioEnd = StdioNull | StdioPipe;
type PipeOf<T, Stream> = T extends StdioNull ? null : Stream;

/** The options every wrapper reads before it starts anything. */
interface CheckedOptions {
  shell?: boolean | string | undefined;
  windowsVerbatimArguments?: boolean | undefined;
}

function refuseCommandProcessorOptions(file: string, options: CheckedOptions | undefined): void {
  if (options?.shell || options?.windowsVerbatimArguments) throw new CommandRefusedError('XEZ_SHELL_REFUSED', file);
}

function isWindows(deps: LaunchDeps): boolean {
  return (deps.platform ?? process.platform) === 'win32';
}

/** The real file system, for the resolver. */
const NODE_FS: ResolveFs = {
  isFile(path) {
    try {
      return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
    } catch {
      return false;
    }
  },
  readText(path, maxBytes) {
    try {
      const fd = openSync(path, 'r');
      try {
        const size = fstatSync(fd).size;
        if (size > maxBytes) return null;
        const buffer = Buffer.alloc(size);
        readSync(fd, buffer, 0, size, 0);
        return buffer.toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  },
};

interface ShapeableOptions extends CheckedOptions {
  env?: NodeJS.ProcessEnv | undefined;
  cwd?: string | URL | undefined;
  windowsHide?: boolean | undefined;
}

function resolveContext(options: ShapeableOptions | undefined, deps: LaunchDeps): ResolveContext {
  const cwd = typeof options?.cwd === 'string' ? options.cwd : options?.cwd ? fileURLToPath(options.cwd) : undefined;
  return {
    env: options?.env ?? process.env,
    ...(cwd !== undefined ? { cwd } : {}),
    execPath: process.execPath,
    fs: NODE_FS,
    ...deps.resolve,
  };
}

/** win32: the program, arguments and options Node should get for `file args options`. */
function shapeForWindows<O extends ShapeableOptions>(
  file: string,
  args: readonly string[],
  options: O | undefined,
  hide: boolean,
  deps: LaunchDeps,
): { file: string; args: readonly string[]; options: O | undefined } {
  const context = resolveContext(options, deps);
  const resolved = resolveCommand(file, args, context, { platform: 'win32' });
  let shaped = options;
  if (hide && options?.windowsHide === undefined) shaped = { ...options, windowsHide: true } as O;
  // Set here only, for a batch file the strict rule accepted: its line is already cmd.exe's.
  if (resolved.verbatim) shaped = { ...shaped, windowsVerbatimArguments: true } as O;
  // A missing program: Node may search only the fully-qualified PATH entries (SEC-9). The child
  // then does not start – except an App Execution Alias, which only libuv's search finds (C-04),
  // and which runs with this PATH: fully-qualified entries only.
  if (resolved.searchPath !== undefined) shaped = { ...shaped, env: withSearchPath(context.env, resolved.searchPath) } as O;
  return { file: resolved.file, args: resolved.args, options: shaped };
}

/** `env` with `path` as its one PATH, whatever spellings it had (Windows names ignore case). */
function withSearchPath(env: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  const rest = Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== 'PATH'));
  return { ...rest, PATH: path };
}

/** `spawn`. Default stdio: every stream a pipe. */
export function launch(
  file: string,
  args: readonly string[],
  options?: SpawnOptionsWithoutStdio,
  policy?: LaunchPolicy,
  deps?: LaunchDeps,
): ChildProcessWithoutNullStreams;
/** `spawn` with a stdio tuple: a stream per `'pipe'`, null per `'ignore'`/`'inherit'`. */
export function launch<Stdin extends StdioEnd, Stdout extends StdioEnd, Stderr extends StdioEnd>(
  file: string,
  args: readonly string[],
  options: SpawnOptionsWithStdioTuple<Stdin, Stdout, Stderr>,
  policy?: LaunchPolicy,
  deps?: LaunchDeps,
): ChildProcessByStdio<PipeOf<Stdin, Writable>, PipeOf<Stdout, Readable>, PipeOf<Stderr, Readable>>;
export function launch(
  file: string,
  args: readonly string[],
  options: SpawnOptions,
  policy?: LaunchPolicy,
  deps?: LaunchDeps,
): ChildProcess;
export function launch(
  file: string,
  args: readonly string[],
  options?: SpawnOptions,
  policy: LaunchPolicy = {},
  deps: LaunchDeps = {},
): ChildProcess {
  refuseCommandProcessorOptions(file, options);
  if (!isWindows(deps)) return options === undefined ? spawn(file, args) : spawn(file, args, options);
  const shaped = shapeForWindows(file, args, options, policy.hide === true, deps);
  const child = shaped.options === undefined ? spawn(shaped.file, shaped.args) : spawn(shaped.file, shaped.args, shaped.options);
  trackChild(child, { platform: 'win32' });
  return child;
}

/**
 * `execFile` in its one 4-argument form (background work: hidden on Windows). A missing program
 * reaches `callback` as ENOENT, as before.
 */
export function launchFile(
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: LaunchFileCallback,
  deps: LaunchDeps = {},
): ChildProcess {
  refuseCommandProcessorOptions(file, options);
  if (!isWindows(deps)) return execFile(file, args, options, callback);
  const shaped = shapeForWindows(file, args, options, true, deps);
  const child = execFile(shaped.file, shaped.args, shaped.options ?? options, callback);
  trackChild(child, { platform: 'win32' });
  return child;
}

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }> & { child?: ChildProcess };

/**
 * `promisify(execFile)`, bound at each call (so a test's mock is the one used). Resolves with
 * `{ stdout, stderr }`; rejects with execFile's error. A refusal rejects too, as Node's own
 * EINVAL does through promisify.
 */
export function launchFileAsync(
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  deps: LaunchDeps = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    refuseCommandProcessorOptions(file, options);
    const run = promisify(execFile) as unknown as ExecFileAsync;
    if (!isWindows(deps)) return run(file, args, options);
    const shaped = shapeForWindows(file, args, options, true, deps);
    const pending = run(shaped.file, shaped.args, shaped.options ?? options);
    if (pending.child) trackChild(pending.child, { platform: 'win32' });
    return pending;
  } catch (error) {
    return Promise.reject(error);
  }
}

/** `execFileSync` with a string encoding (background work: hidden on Windows). */
export function launchFileSync(
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
  deps: LaunchDeps = {},
): string {
  refuseCommandProcessorOptions(file, options);
  if (!isWindows(deps)) return execFileSync(file, args, options);
  const shaped = shapeForWindows(file, args, options, true, deps);
  return execFileSync(shaped.file, shaped.args, shaped.options ?? options);
}

/** Start, then true once `settleMs` passed without an `error`; false on a throw or an error. */
function settleDetached(start: () => ChildProcess, settleMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = start();
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.once('error', () => settle(false));
    setTimeout(() => {
      child.unref();
      settle(true);
    }, settleMs);
  });
}

/**
 * Start a program the user sees (an editor, a terminal, a file manager) and let it go: no stdio,
 * its own process group, never hidden, never tracked – a shutdown must not close the user's
 * editor – and without the run marker, so no run's process sweep counts it as its own (#943).
 * Resolves true once `settleMs` passed without an error, false on any failure, including a
 * refused start. `deps.resolve.env` stands in for the inherited environment in tests.
 */
export function launchDetached(
  file: string,
  args: readonly string[],
  settleMs: number = DETACHED_SETTLE_MS,
  deps: LaunchDeps = {},
): Promise<boolean> {
  return settleDetached(() => {
    const env = withoutRunMarker(deps.resolve?.env ?? process.env, deps);
    const options: SpawnOptions = { stdio: 'ignore', detached: true, ...(env ? { env } : {}) };
    if (!isWindows(deps)) return spawn(file, args, options);
    const shaped = shapeForWindows(file, args, options, false, deps);
    return spawn(shaped.file, shaped.args, shaped.options ?? options);
  }, settleMs);
}

/** Windows Terminal, by the names `start` finds it under. */
const WINDOWS_TERMINAL = /^wt(?:\.exe)?$/i;
/** The program a `/K` payload is for. */
const CMD_PROGRAM = /^cmd(?:\.exe)?$/i;

/** The last part of a Windows path, by either separator. */
function windowsBasename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);
}

/** Where `start ""` names Windows Terminal – by name or by a full path – as the program to start, or -1. */
function windowsTerminalIndex(args: readonly string[]): number {
  return args.findIndex(
    (arg, index) =>
      WINDOWS_TERMINAL.test(windowsBasename(arg)) && args[index - 1] === '' && args[index - 2]?.toLowerCase() === 'start',
  );
}

/**
 * The line elements for `launchCmd`, or a refusal: each a `cmdTokenSafe` token, except the empty
 * title right after `start` (`""`), a `cmdUrlSafe` address, a path the caller quoted itself
 * (`cmdQuotedPathSafe`), and one `cmdPayloadSafe` command as the last element after `cmd /K`,
 * which is quoted whole so the window's cmd.exe strips exactly those quotes. Nothing else is
 * quoted, so what was checked is what cmd.exe reads.
 *
 * When the line starts Windows Terminal (`start "" wt …`, by name or full path), no later element may hold a `;`:
 * Windows Terminal splits its own command line into separate commands at every `;`, quoted or
 * not, so one in a folder or an environment value would start whatever follows it (SEC-963-01).
 * Nor may its `/K` payload hold a `"`: Windows Terminal splits its line into arguments by the
 * CommandLineToArgvW rules and builds the tab's command again from them, so the quotes inside the
 * payload are gone by the time the tab's cmd.exe reads it – `set "NAME=C:\a b"` arrives as
 * `set NAME=C:\a b` cut at the space, or with a trailing space (SEC-11A-01). Such a line belongs
 * in the classic console window, where `start` hands the payload on verbatim.
 */
export function cmdLine(args: readonly string[]): string[] {
  const terminalAt = windowsTerminalIndex(args);
  return args.map((arg, index) => {
    const previous = args[index - 1];
    if (terminalAt !== -1 && index > terminalAt && arg.includes(';')) {
      throw new CommandRefusedError('XEZ_CMD_UNSAFE_ARG', CMD_EXE_NAME, index + 1);
    }
    // A `/K` payload only for cmd.exe itself, the one program whose parsing it is checked against.
    const payload = previous?.toUpperCase() === '/K' && index === args.length - 1 && CMD_PROGRAM.test(windowsBasename(args[index - 2] ?? ''));
    if (terminalAt !== -1 && payload && arg.includes('"')) {
      throw new CommandRefusedError('XEZ_CMD_UNSAFE_ARG', CMD_EXE_NAME, index + 1);
    }
    if (arg === '' && previous?.toLowerCase() === 'start') return '""';
    if (payload && cmdPayloadSafe(arg)) return `"${arg}"`;
    if (cmdTokenSafe(arg) || cmdUrlSafe(arg) || cmdQuotedPathSafe(arg)) return arg;
    throw new CommandRefusedError('XEZ_CMD_UNSAFE_ARG', CMD_EXE_NAME, index + 1);
  });
}

/**
 * The only way to start cmd.exe (%SystemRoot%\System32, never COMSPEC): `cmd.exe /d /v:off
 * <args>`, detached and without the run marker, as `launchDetached`. Every element is checked by
 * `cmdLine` and the line is passed verbatim; a refusal throws `CommandRefusedError` before
 * anything starts.
 */
export function launchCmd(
  args: readonly string[],
  deps: { env?: NodeJS.ProcessEnv; settleMs?: number } = {},
): Promise<boolean> {
  const cmdExe = system32Program(CMD_EXE_NAME, deps.env ?? process.env);
  if (cmdExe === null) throw new CommandRefusedError('XEZ_CMD_NO_SYSTEM_ROOT', CMD_EXE_NAME);
  const line = ['/d', '/v:off', ...cmdLine(args)];
  if (verbatimLineLength(cmdExe, line) > CMD_LINE_MAX) throw new CommandRefusedError('XEZ_CMD_TOO_LONG', CMD_EXE_NAME);
  const env = withoutRunMarker(deps.env ?? process.env, { platform: 'win32' });
  return settleDetached(
    () => spawn(cmdExe, line, { stdio: 'ignore', detached: true, windowsVerbatimArguments: true, ...(env ? { env } : {}) }),
    deps.settleMs ?? DETACHED_SETTLE_MS,
  );
}
