/**
 * Git Bash on Windows (#963): finding Git for Windows, and the environment and quoting an MSYS
 * `bash.exe` needs. Windows only – Linux and macOS never call it.
 *
 * The search is the kit's own (`.xezar/checks/lib/windows-process.mjs`, `gitRoot`), ported rule
 * for rule: first each PATH folder holding `git.exe` in Git's layout (`<root>\cmd`, `<root>\bin`,
 * `<root>\<toolchain>\bin`), then the usual install folders. A root counts only with both
 * `bin\bash.exe` and `usr\bin\bash.exe`. A `bash.exe` on PATH is never a candidate: on a stock
 * Windows the first one is WSL's launcher. Two rules are stricter than the kit's: the real
 * `usr\bin\bash.exe` must sit inside the real root (no junction out of it), and never under
 * `%SystemRoot%`.
 *
 * Pure apart from the injected `exists` and `realpath`, so every rule runs on every OS in tests.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { existsSync, realpathSync } from 'node:fs';
import { win32 } from 'node:path';
import { envValue } from './path-search.ts';

/** The one sentence a check step fails with when there is no Git Bash. */
export const GIT_BASH_MISSING =
  "Git Bash was not found. Install Git for Windows (it includes Git Bash) and make sure git.exe is on PATH; WSL's bash.exe is never used.";

const TOOLCHAINS = ['mingw64', 'clangarm64', 'mingw32'];
const DRIVE_PATH = /^[A-Za-z]:\\/;
const ABSOLUTE_ENTRY = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

export interface GitBashDeps {
  exists?: (path: string) => boolean;
  /** The native real path, or null when it cannot be read. */
  realpath?: (path: string) => string | null;
}

function nativeRealpath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** PATH's absolute folders (drive or UNC), in order, unquoted and normalised. */
function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return String(envValue(env, 'PATH', { platform: 'win32' }) ?? '')
    .split(';')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1').trim())
    .filter((entry) => ABSOLUTE_ENTRY.test(entry))
    .map((entry) => win32.normalize(entry));
}

/** The Git root a PATH folder holding git.exe implies, or null when the folder is not Git's layout. */
function rootFromGitDir(dir: string): string | null {
  const name = win32.basename(dir).toLowerCase();
  const parent = win32.dirname(dir);
  if (name === 'bin' && TOOLCHAINS.includes(win32.basename(parent).toLowerCase())) return win32.dirname(parent);
  if (name === 'cmd' || name === 'bin') return parent;
  return null;
}

function installRoots(env: NodeJS.ProcessEnv): Array<string | null> {
  const drive = (name: string): string | null => {
    const value = envValue(env, name, { platform: 'win32' });
    return typeof value === 'string' && DRIVE_PATH.test(value) ? value : null;
  };
  const programs = ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)'].map((name) => drive(name));
  const local = drive('LOCALAPPDATA');
  return [...programs.map((dir) => (dir ? win32.join(dir, 'Git') : null)), local ? win32.join(local, 'Programs', 'Git') : null];
}

/** Is `child` the folder `parent` or inside it? Exact spelling: both come from the native real path. */
function isInside(child: string, parent: string): boolean {
  const base = parent.endsWith('\\') ? parent : `${parent}\\`;
  return child === parent || child.startsWith(base);
}

/** The Git for Windows root, or null. */
export function gitRoot(env: NodeJS.ProcessEnv = process.env, deps: GitBashDeps = {}): string | null {
  const exists = deps.exists ?? existsSync;
  const realpath = deps.realpath ?? nativeRealpath;
  const systemRoot = envValue(env, 'SystemRoot', { platform: 'win32' });
  const realSystemRoot = typeof systemRoot === 'string' && DRIVE_PATH.test(systemRoot) ? realpath(systemRoot) : null;
  const onPath = pathEntries(env)
    .filter((dir) => exists(win32.join(dir, 'git.exe')))
    .map(rootFromGitDir);
  const candidates = [...onPath, ...installRoots(env)].filter((root): root is string => root !== null);
  return (
    candidates.find((root) => {
      if (!exists(win32.join(root, 'bin', 'bash.exe')) || !exists(win32.join(root, 'usr', 'bin', 'bash.exe'))) return false;
      const realRoot = realpath(root);
      const realBash = realpath(win32.join(root, 'usr', 'bin', 'bash.exe'));
      if (realRoot === null || realBash === null || !isInside(realBash, realRoot)) return false;
      return realSystemRoot === null || !isInside(realBash.toLowerCase(), realSystemRoot.toLowerCase());
    }) ?? null
  );
}

/** A copy of `env` with exactly one `key` set to `value`, whatever spellings it had. */
function withOne(env: NodeJS.ProcessEnv, key: string, value: string): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [name, v] of Object.entries(env)) if (name.toUpperCase() !== key.toUpperCase()) next[name] = v;
  next[key] = value;
  return next;
}

/**
 * The environment a check step's Git Bash runs with: `MSYS` gains `noglob` (otherwise the MSYS
 * runtime globs an unquoted `*` in its own command line), `NoDefaultCurrentDirectoryInExePath=1`
 * (a bare program name is never taken from the working folder), `MSYSTEM=MINGW64`, and Git's
 * `mingw64\bin` and `usr\bin` first on PATH – what Git's own `bin\bash.exe` wrapper and a login
 * shell would add, without the login profile scripts and without `TMP=/tmp`.
 */
export function gitBashEnv(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const msys = envValue(env, 'MSYS', { platform: 'win32' }) ?? '';
  const noglob = /(^|\s)noglob(\s|$)/.test(msys) ? msys : msys ? `${msys} noglob` : 'noglob';
  const path = envValue(env, 'PATH', { platform: 'win32' }) ?? '';
  const prefix = `${win32.join(root, 'mingw64', 'bin')};${win32.join(root, 'usr', 'bin')}`;
  let next = withOne(env, 'MSYS', noglob);
  next = withOne(next, 'NoDefaultCurrentDirectoryInExePath', '1');
  next = withOne(next, 'MSYSTEM', 'MINGW64');
  return withOne(next, 'PATH', path ? `${prefix};${path}` : prefix);
}

/**
 * One argument on an MSYS program's command line. The MSYS runtime does not read libuv's `\"`
 * escaping: inside "…" everything is literal except `"`, which is written closed, single-quoted
 * and reopened. With MSYS=noglob this round-trips spaces, `*`, `{a,b}`, backslashes, empty
 * strings and quotes.
 */
export function msysQuote(arg: string): string {
  return `"${arg.replaceAll('"', `"'"'"`)}"`;
}
