/**
 * Reading an npm command shim (#963). Windows only; pure – no file system.
 *
 * `npm install -g` puts a `<name>.cmd` next to each installed command, and Node refuses to start a
 * `.cmd` without a shell: running it through cmd.exe would re-read every argument with cmd.exe's
 * rules (BatBadBut). The shim itself is a fixed template that ends in one line starting node on a
 * script, so reading that line gives the program to start directly – no cmd.exe at all.
 *
 * Accepted, and nothing else (checked against npm's cmd-shim 8.0.0 and the shims it wrote):
 *  - the node form: cmd-shim's template for a `#!/usr/bin/env node` script, line for line;
 *  - the program form: cmd-shim's template for a target with no shebang, when it is an .exe/.com;
 *  - npm's own `npm.cmd` / `npx.cmd`, which are not cmd-shim output.
 * A shim that sets variables (`#!/usr/bin/env K=V node`), starts another interpreter (sh, pwsh),
 * the npm ≤ 6 form, or a file that differs from the template in any line is declined (null), and
 * the caller falls back to the strict cmd.exe rule. CRLF or LF, blank lines and the indentation
 * of a line do not matter; everything else does.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { win32 } from 'node:path';

export type ShimTarget =
  | { kind: 'node-script'; script: string; nodeArgs: string[] }
  | { kind: 'program'; program: string };

/** cmd-shim's head, which finds the shim's own folder (`%dp0%`). */
const HEAD: readonly string[] = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
];

/** The choice between a `node.exe` next to the shim and `node` from PATH. */
const NODE_CHOICE: readonly string[] = [
  'IF EXIST "%dp0%\\node.exe" (',
  'SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  'SET "_prog=node"',
  'SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
];

/** A target inside the quotes: never a quote, a variable, a caret or a line break. */
const NODE_LAUNCH =
  /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" (.*) "%dp0%\\([^"%!^\r\n]+)" %\*$/;
const PROGRAM_LAUNCH = /^"%dp0%\\([^"%!^\r\n]+)"\s+%\*$/;
/** A shebang's node option (`--no-warnings`, `--max-old-space-size=4096`); nothing else. */
const NODE_OPTION = /^--?[A-Za-z0-9][\w.:=-]*$/;
const PROGRAM_EXTENSION = /\.(?:exe|com)$/i;

const NPM_CLI_SET = /^SET "NP([MX])_CLI_JS=%~dp0\\node_modules\\npm\\bin\\np([mx])-cli\.js"$/;
const NPM_LAUNCH = /^"%NODE_EXE%" "%NP([MX])_CLI_JS%" %\*$/;

function sameLines(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((line, index) => line === expected[index]);
}

/** npm's own launcher: `SET "NPM_CLI_JS=…npm-cli.js"` and a last line starting node on it. */
function npmLauncher(lines: readonly string[], last: string, shimDir: string): ShimTarget | null {
  const launch = NPM_LAUNCH.exec(last);
  if (!launch) return null;
  const which = launch[1]!;
  const declared = lines.some((line) => {
    const set = NPM_CLI_SET.exec(line);
    return set !== null && set[1] === which && set[2] === which.toLowerCase();
  });
  if (!declared) return null;
  const cli = `np${which.toLowerCase()}-cli.js`;
  return { kind: 'node-script', script: win32.join(shimDir, 'node_modules', 'npm', 'bin', cli), nodeArgs: [] };
}

function nodeForm(body: readonly string[], last: string, shimDir: string): ShimTarget | null {
  if (!sameLines(body, NODE_CHOICE)) return null;
  const launch = NODE_LAUNCH.exec(last);
  if (!launch) return null;
  const options = launch[1]!.trim();
  const nodeArgs = options === '' ? [] : options.split(/\s+/);
  if (!nodeArgs.every((option) => NODE_OPTION.test(option))) return null;
  return { kind: 'node-script', script: win32.join(shimDir, launch[2]!), nodeArgs };
}

function programForm(body: readonly string[], last: string, shimDir: string): ShimTarget | null {
  if (body.length !== 0) return null;
  const launch = PROGRAM_LAUNCH.exec(last);
  if (!launch || !PROGRAM_EXTENSION.test(launch[1]!)) return null;
  return { kind: 'program', program: win32.join(shimDir, launch[1]!) };
}

/**
 * What the shim at `shimPath` (whose text is `text`) starts, or null when it is not one of the
 * accepted forms. Paths are joined with `path.win32` relative to the shim's folder. Whether the
 * target exists is the caller's question.
 */
export function parseCmdShim(text: string, shimPath: string): ShimTarget | null {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const last = lines.at(-1);
  if (last === undefined) return null;
  const shimDir = win32.dirname(shimPath);
  const npm = npmLauncher(lines, last, shimDir);
  if (npm) return npm;
  if (!sameLines(lines.slice(0, HEAD.length), HEAD)) return null;
  const body = lines.slice(HEAD.length, -1);
  return nodeForm(body, last, shimDir) ?? programForm(body, last, shimDir);
}
