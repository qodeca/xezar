// Programs on native Windows (Git Bash) (#122): finding one the way Windows names it, and starting
// a .cmd or .bat one without letting cmd.exe read anything a repository wrote.
//
// Loaded with a dynamic import, and only on Windows, by `route.mjs`, `lib/deps.mjs`,
// `documented-output.mjs` and the upgrade tool's `upgrade/tools/verify.mjs`: Linux and macOS never
// read it. Every function is pure apart from its injected `exists`, so the Windows rules are proven
// on every OS.
//
// Why. On Windows a program is `claude.exe`, `codex.cmd`, `npm.cmd`: a search for the bare name
// finds nothing, and Node (since 20.12, CVE-2024-27980) refuses to start a .cmd or .bat without a
// shell. That shell is cmd.exe, which reads `"` `%` `!` `&` `|` `<` `>` `^` in its command line and
// searches the working folder first for any program a script names. So a .cmd starts through
// cmd.exe only with text checked here: a shim path and arguments that hold none of those
// characters, the working folder passed as cwd and never on the command line, and
// NoDefaultCurrentDirectoryInExePath=1, so a `node.cmd` committed to the working folder never runs
// in place of the real one. The finder itself never searches the working folder either.
//
// node:* and ./windows-process.mjs imports only: this file installs and runs standalone in an
// onboarded project.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { envGet, gitRoot, pathEntries } from './windows-process.mjs';

export { GIT_BASH_MISSING } from './windows-process.mjs';

const win = path.win32;

/** The extensions Windows starts a program by. Any other PATHEXT entry (.JS, .VBS, …) is never taken. */
const PROGRAM_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];
const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ABSOLUTE_DIR = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;
const DRIVE_PATH = /^[A-Za-z]:\\/;
const UNC_PATH = /^[\\/]{2}/;
/** What cmd.exe reads in a command line: quotes, variables, delayed expansion, operators, its escape, control characters. */
const CMD_UNSAFE_PATH = /["%!&|<>^\x00-\x1f\x7f]/;
/** An argument cmd.exe passes on exactly as it is. */
const CMD_SAFE_ARG = /^[A-Za-z0-9@._/:=+,-]+$/;

const refusal = (message, code = 'CMD_UNSAFE') => Object.assign(new Error(message), { code });
const unsafeForCmd = (file, args) => CMD_UNSAFE_PATH.test(file) || args.some((arg) => !CMD_SAFE_ARG.test(String(arg)));

/**
 * The program extensions to try, in PATHEXT's order, lowercase: PATHEXT ∩ {.com, .exe, .bat, .cmd}.
 * PATHEXT unset or empty: .com .exe .bat .cmd, Windows' own default order.
 */
export function programExtensions(env = process.env) {
  const raw = envGet(env, 'PATHEXT');
  if (typeof raw !== 'string' || raw.trim() === '') return [...PROGRAM_EXTENSIONS];
  const listed = raw.split(';').map((ext) => ext.trim().toLowerCase());
  return [...new Set(listed.filter((ext) => PROGRAM_EXTENSIONS.includes(ext)))];
}

/**
 * The full path of program `name` (given without its extension), or null. Searched, folder by
 * folder: each absolute PATH entry, then each absolute folder in `extraDirs`; in each folder every
 * programExtensions() entry in turn. A relative PATH entry and the working folder are never
 * searched, and a name that is not a plain program name is never looked up.
 */
export function findProgram(name, { env = process.env, extraDirs = [], exists = existsSync } = {}) {
  if (typeof name !== 'string' || !PROGRAM_NAME.test(name)) return null;
  const extra = extraDirs.filter((dir) => typeof dir === 'string' && ABSOLUTE_DIR.test(dir)).map((dir) => win.normalize(dir));
  const extensions = programExtensions(env);
  for (const dir of [...pathEntries(env), ...extra]) {
    for (const ext of extensions) {
      const file = win.join(dir, `${name}${ext}`);
      if (exists(file)) return file;
    }
  }
  return null;
}

/**
 * Git Bash for a check script: `<Git root>\bin\bash.exe`, or null when Git for Windows is not
 * found. That is Git's wrapper, which puts Git's own tools first on PATH, as a check script needs.
 * Never a bash.exe from PATH: on a stock Windows the first one is WSL's. (The gate scheduler's
 * `prepare()` in windows-process.mjs starts `usr\bin\bash.exe` instead: it needs bash's own pid.)
 */
export function gitBash({ env = process.env, exists = existsSync } = {}) {
  const root = gitRoot({ env, exists });
  return root === null ? null : win.join(root, 'bin', 'bash.exe');
}

/**
 * How to start `file` – a full path, as findProgram() returns it – with `args`, as
 * { file, args, options } for spawn. A .exe or .com starts directly (options {}: the caller's env
 * and cwd apply). A .cmd or .bat starts as `<SystemRoot>\System32\cmd.exe /d /v:off /s /c
 * ""<file>" <args>"` with windowsVerbatimArguments, and options.env is `env` with exactly one
 * NoDefaultCurrentDirectoryInExePath=1, every other key kept. Throws (code NOT_A_PROGRAM) when
 * `file` is not a .exe, .com, .cmd or .bat. Throws (code CMD_UNSAFE) rather than let cmd.exe
 * interpret text: a shim path holding " % ! & | < > ^ or a control character, an argument outside
 * [A-Za-z0-9@._/:=+,-], a UNC working folder (cmd.exe cannot start in one), or a SystemRoot that
 * is not a drive path or holds whitespace, a forward slash or one of the shim path's refused
 * characters (with windowsVerbatimArguments, cmd.exe's own path reaches its command line
 * unquoted). `cwd` is checked, never placed on the command line.
 */
export function launchPlan(file, args, { env = process.env, cwd } = {}) {
  const ext = win.extname(String(file)).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { file, args: [...args], options: {} };
  if (ext !== '.cmd' && ext !== '.bat') throw refusal(`${file} is not a program Windows starts (.exe, .com, .cmd or .bat)`, 'NOT_A_PROGRAM');
  if (unsafeForCmd(file, args)) throw refusal(`cmd.exe would read a character in ${JSON.stringify([file, ...args])} as syntax, so it is not started`);
  if (typeof cwd === 'string' && UNC_PATH.test(cwd)) throw refusal(`cmd.exe cannot start in the network folder ${cwd}`);
  const systemRoot = envGet(env, 'SystemRoot');
  if (typeof systemRoot !== 'string' || !DRIVE_PATH.test(systemRoot) || /\s/.test(systemRoot) || CMD_UNSAFE_PATH.test(systemRoot) || systemRoot.includes('/')) {
    throw refusal('cmd.exe is not started: SystemRoot is not a drive path free of spaces, forward slashes and cmd.exe metacharacters');
  }
  const next = { ...env };
  for (const key of Object.keys(next)) if (key.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH') delete next[key];
  next.NoDefaultCurrentDirectoryInExePath = '1';
  return {
    file: win.join(systemRoot, 'System32', 'cmd.exe'),
    args: ['/d', '/v:off', '/s', '/c', `""${file}"${args.length ? ` ${args.join(' ')}` : ''}"`],
    options: { windowsVerbatimArguments: true, env: next },
  };
}

/**
 * How to start `tool` – a program name, or a full path that is kept as it is – with `args`: the
 * launchPlan() of the program findProgram() finds, or { error }. A tool that is not found is an
 * ENOENT error, as spawnSync gives, and is never started by its bare name: Windows would look for
 * it in the working folder first. A refusal is returned as { error }, never thrown, so a caller
 * answers it the way it answers a failed spawn.
 */
export function launchFor(tool, args, { env = process.env, cwd, exists = existsSync } = {}) {
  const found = win.isAbsolute(String(tool)) ? tool : findProgram(tool, { env, exists });
  if (!found) return { error: Object.assign(new Error(`spawnSync ${tool} ENOENT`), { code: 'ENOENT' }) };
  try { return launchPlan(found, args, { env, cwd }); } catch (error) { return { error }; }
}
