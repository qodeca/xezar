/**
 * Which program Windows should really start for a command (#963). Windows only; the file system
 * is reached only through `ResolveContext.fs`, so every rule runs on every OS in tests.
 *
 * libuv finds only `.exe`/`.com` on PATH and Node refuses a `.cmd`/`.bat` without a shell, so on
 * Windows an npm-installed CLI (`codex.cmd`), npm itself and a `.mjs` script all fail to start.
 * This module turns such a command into one Windows can start without a shell:
 *  - a program found on PATH (PATHEXT order, never the working folder) that is an `.exe`/`.com`
 *    is passed on by its bare name, or by its full path when the PATH has a folder that depends
 *    on the working folder;
 *  - a `.js`/`.mjs`/`.cjs` file runs as `node <script>`;
 *  - an npm command shim runs its target directly (`cmd-shim.ts`);
 *  - any other batch file runs through cmd.exe only under the strict rule of `batch-line.ts`;
 *  - cmd.exe itself is refused here: it starts only through `launchCmd`, which checks every token.
 * A program that is not there is passed on unchanged, so Node reports ENOENT exactly as before –
 * with a PATH that cannot reach an entry depending on the working folder, when the PATH has one.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { win32 } from 'node:path';
import { batchInvocation } from './batch-line.ts';
import { parseCmdShim } from './cmd-shim.ts';
import {
  envValue,
  firstOnPath,
  hasRelativeEntry,
  isRelativeEntry,
  isSearchableExtension,
  windowsSearchExtensions,
} from './path-search.ts';
import { system32Program } from './system-programs.ts';

export type CommandRefusalCode =
  | 'XEZ_CMD_UNSAFE_ARG'
  | 'XEZ_CMD_UNSAFE_PATH'
  | 'XEZ_CMD_TOO_LONG'
  | 'XEZ_CMD_NO_SYSTEM_ROOT'
  | 'XEZ_CMD_DIRECT'
  | 'XEZ_SHELL_REFUSED';

/** Each reason completes "it …" or "argument N …". */
const REFUSAL_REASONS: Readonly<Record<CommandRefusalCode, string>> = {
  XEZ_CMD_UNSAFE_ARG: 'has characters the Windows command processor would act on',
  XEZ_CMD_UNSAFE_PATH: 'is in a folder whose name the Windows command processor would act on',
  XEZ_CMD_TOO_LONG: 'would need a command line longer than the Windows command processor accepts',
  XEZ_CMD_NO_SYSTEM_ROOT: 'needs the Windows command processor, and SystemRoot does not name a drive folder',
  XEZ_CMD_DIRECT: 'would start the Windows command processor directly',
  XEZ_SHELL_REFUSED: 'was to run through a shell, which xezar never uses to start a program',
};

/**
 * A start xezar refused before any process began. Thrown synchronously, like Node's own EINVAL
 * for a `.cmd`. The message names the file and, for an argument, its position – never its value.
 */
export class CommandRefusedError extends Error {
  readonly code: CommandRefusalCode;
  readonly file: string;

  constructor(code: CommandRefusalCode, file: string, position?: number) {
    const subject = position === undefined ? 'it' : `argument ${position}`;
    super(`xezar did not start ${file}: ${subject} ${REFUSAL_REASONS[code]} (${code})`);
    this.name = 'CommandRefusedError';
    this.code = code;
    this.file = file;
  }
}

/** The largest shim read; npm's are under 1 KiB. */
export const SHIM_READ_LIMIT = 64 * 1024;

export interface ResolveFs {
  isFile(path: string): boolean;
  /** At most `maxBytes` of the file as UTF-8, or null when it is larger or unreadable. */
  readText(path: string, maxBytes: number): string | null;
}

export interface ResolveContext {
  /** The child's environment: its PATH and PATHEXT decide the search. */
  env: NodeJS.ProcessEnv;
  /** The child's working folder; relative paths resolve against it. */
  cwd?: string;
  /** The node that runs a script (`process.execPath`). */
  execPath: string;
  fs: ResolveFs;
}

export type ResolveHow =
  | 'as-given'
  | 'bare-name'
  | 'full-path'
  | 'script'
  | 'shim-node'
  | 'shim-program'
  | 'batch'
  | 'missing';

export interface ResolvedCommand {
  file: string;
  args: readonly string[];
  /** true only for a batch file through cmd.exe (`windowsVerbatimArguments`). */
  verbatim: boolean;
  how: ResolveHow;
  /**
   * Set only with `missing`: the PATH Node may search for `file` – the child's PATH without the
   * entries that depend on the working folder – so the start fails with ENOENT, as for any
   * missing program, instead of finding a copy there (SEC-9). Usually the child never runs with
   * it. One exception (C-04): an App Execution Alias (`%LOCALAPPDATA%\Microsoft\WindowsApps`)
   * cannot be stat'ed, so this search never "finds" one, while libuv's own search does – such a
   * program starts with this PATH, which holds only fully-qualified entries.
   */
  searchPath?: string;
}

const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const PROGRAM_EXTENSIONS = new Set(['.exe', '.com']);
const BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);
const CMD_EXE = /^cmd(?:\.exe)?$/i;

function asGiven(file: string, args: readonly string[], how: ResolveHow = 'as-given'): ResolvedCommand {
  return { file, args, verbatim: false, how };
}

function batchThroughCmd(path: string, args: readonly string[], ctx: ResolveContext): ResolvedCommand {
  const cmdExe = system32Program('cmd.exe', ctx.env);
  if (cmdExe === null) throw new CommandRefusedError('XEZ_CMD_NO_SYSTEM_ROOT', path);
  const invocation = batchInvocation(path, args, cmdExe);
  if ('refused' in invocation) throw new CommandRefusedError(invocation.refused, path, invocation.position);
  return { file: invocation.file, args: invocation.args, verbatim: true, how: 'batch' };
}

/** A `.cmd`/`.bat`: its shim target when it has one that exists, else the strict cmd.exe rule. */
function classifyBatch(
  original: string,
  path: string,
  args: readonly string[],
  ctx: ResolveContext,
): ResolvedCommand {
  const text = ctx.fs.readText(path, SHIM_READ_LIMIT);
  const target = text === null ? null : parseCmdShim(text, path);
  if (target === null) return batchThroughCmd(path, args, ctx);
  if (target.kind === 'program') {
    if (CMD_EXE.test(win32.basename(target.program))) throw new CommandRefusedError('XEZ_CMD_DIRECT', path);
    return ctx.fs.isFile(target.program) ? asGiven(target.program, args, 'shim-program') : asGiven(original, args);
  }
  if (!ctx.fs.isFile(target.script)) return asGiven(original, args);
  const localNode = win32.join(win32.dirname(path), 'node.exe');
  const node = ctx.fs.isFile(localNode) ? localNode : ctx.execPath;
  return { file: node, args: [...target.nodeArgs, target.script, ...args], verbatim: false, how: 'shim-node' };
}

/** What starts `path`, a file that exists; `original` is what the caller asked for. */
function classify(original: string, path: string, args: readonly string[], ctx: ResolveContext): ResolvedCommand {
  if (CMD_EXE.test(win32.basename(path))) throw new CommandRefusedError('XEZ_CMD_DIRECT', path);
  const ext = win32.extname(path).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(ext)) return { file: ctx.execPath, args: [path, ...args], verbatim: false, how: 'script' };
  if (BATCH_EXTENSIONS.has(ext)) return classifyBatch(original, path, args, ctx);
  return asGiven(original, args);
}

function isExplicitPath(file: string): boolean {
  return file.includes('\\') || file.includes('/') || /^[A-Za-z]:/.test(file);
}

function resolveExplicit(file: string, args: readonly string[], ctx: ResolveContext): ResolvedCommand {
  const full = win32.resolve(ctx.cwd ?? process.cwd(), file);
  if (win32.extname(full) !== '') return ctx.fs.isFile(full) ? classify(file, full, args, ctx) : asGiven(file, args);
  for (const ext of windowsSearchExtensions(ctx.env)) {
    if (ctx.fs.isFile(full + ext)) return classify(file, full + ext, args, ctx);
  }
  return asGiven(file, args);
}

/** A search over the fully-qualified entries of a Windows PATH only. */
function searchFullyQualified(names: readonly string[], searchPath: string, ctx: ResolveContext): string | null {
  const hit = firstOnPath(names, searchPath, {
    delimiter: ';',
    join: win32.join,
    exists: (path) => ctx.fs.isFile(path),
    skipRelative: true,
    platform: 'win32',
  });
  return hit?.path ?? null;
}

/** The names libuv tries in each PATH entry for a bare name: the name itself only when it has an
 *  extension, then `.com` and `.exe`. */
function libuvNames(file: string): string[] {
  return [...(win32.extname(file) !== '' ? [file] : []), `${file}.com`, `${file}.exe`];
}

/**
 * `file`, a bare name, handed to Node to search PATH itself (nothing xezar starts differently was
 * found, or a shim's target is missing). libuv would also search the PATH entries that depend on
 * the working folder, so when there are any, the search happens here over the fully-qualified
 * entries only (SEC-9): the program libuv would find there, by its full path; otherwise the name
 * with a PATH that cannot find it, so the start fails with ENOENT exactly as before. Without such
 * entries the name is passed on unchanged.
 */
function handToNode(file: string, args: readonly string[], searchPath: string, ctx: ResolveContext): ResolvedCommand {
  if (!hasRelativeEntry(searchPath, { delimiter: ';', platform: 'win32' })) return asGiven(file, args);
  const program = searchFullyQualified(libuvNames(file), searchPath, ctx);
  if (program !== null) return asGiven(program, args, 'full-path');
  const fullyQualified = searchPath.split(';').filter((entry) => entry !== '' && !isRelativeEntry(entry, 'win32'));
  return { ...asGiven(file, args, 'missing'), searchPath: fullyQualified.join(';') };
}

function resolveBareName(file: string, args: readonly string[], ctx: ResolveContext): ResolvedCommand {
  const searchPath = envValue(ctx.env, 'PATH', { platform: 'win32' }) ?? '';
  const names = isSearchableExtension(win32.extname(file))
    ? [file]
    : windowsSearchExtensions(ctx.env).map((ext) => file + ext);
  const hit = searchFullyQualified(names, searchPath, ctx);
  if (hit === null) return handToNode(file, args, searchPath, ctx);
  const ext = win32.extname(hit).toLowerCase();
  if (PROGRAM_EXTENSIONS.has(ext)) {
    // libuv would search this PATH again; a folder that depends on the working folder could
    // answer first there, so the found file is named in full.
    return hasRelativeEntry(searchPath, { delimiter: ';', platform: 'win32' })
      ? asGiven(hit, args, 'full-path')
      : asGiven(file, args, 'bare-name');
  }
  const resolved = classify(file, hit, args, ctx);
  // A shim whose target is missing comes back as the bare name: Node searches for it next.
  return resolved.how === 'as-given' && resolved.file === file ? handToNode(file, args, searchPath, ctx) : resolved;
}

/**
 * The program and arguments to hand to Node for `file args` on Windows. POSIX (and any platform
 * but win32): unchanged. Throws `CommandRefusedError` for a batch start the strict rule refuses
 * and for cmd.exe itself; never throws for a missing program.
 */
export function resolveCommand(
  file: string,
  args: readonly string[],
  ctx: ResolveContext,
  deps: { platform?: NodeJS.Platform } = {},
): ResolvedCommand {
  if ((deps.platform ?? process.platform) !== 'win32') return asGiven(file, args);
  if (CMD_EXE.test(win32.basename(file))) throw new CommandRefusedError('XEZ_CMD_DIRECT', file);
  return isExplicitPath(file) ? resolveExplicit(file, args, ctx) : resolveBareName(file, args, ctx);
}
