/**
 * Windows command shims for tests (#963): real ones byte for byte, and a builder that writes new
 * ones the way npm's cmd-shim 8.0.0 does (`lib/index.js`, `writeShim_`).
 *
 * Kept as string literals, not files: the repository stores every text file with LF
 * (`.gitattributes`), and these are CRLF. The literals were copied from files npm wrote on a
 * Windows machine (Node 24.21.0, npm 11): `node_modules/.bin/vitest.cmd` and `esbuild.cmd`, and
 * the global `codex.cmd`, `opencode.cmd`, `npm.cmd`, `npx.cmd` and `corepack.cmd`.
 */

export const VITEST_CMD =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\vitest\\vitest.mjs" %*\r\n';

export const ESBUILD_CMD =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\esbuild\\bin\\esbuild" %*\r\n';

export const CODEX_CMD =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';

export const OPENCODE_CMD =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n';

export const NPM_CMD =
  ':: Created by npm, please don\'t edit manually.\r\n@ECHO OFF\r\n\r\nSETLOCAL\r\n\r\nSET "NODE_EXE=%~dp0\\node.exe"\r\nIF NOT EXIST "%NODE_EXE%" (\r\n  SET "NODE_EXE=node"\r\n)\r\n\r\nSET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"\r\nSET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"\r\nFOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (\r\n  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"\r\n)\r\nIF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (\r\n  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"\r\n)\r\n\r\n"%NODE_EXE%" "%NPM_CLI_JS%" %*\r\n';

export const NPX_CMD =
  ':: Created by npm, please don\'t edit manually.\r\n@ECHO OFF\r\n\r\nSETLOCAL\r\n\r\nSET "NODE_EXE=%~dp0\\node.exe"\r\nIF NOT EXIST "%NODE_EXE%" (\r\n  SET "NODE_EXE=node"\r\n)\r\n\r\nSET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"\r\nSET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"\r\nFOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (\r\n  SET "NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js"\r\n)\r\nIF EXIST "%NPM_PREFIX_NPX_CLI_JS%" (\r\n  SET "NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%"\r\n)\r\n\r\n"%NODE_EXE%" "%NPX_CLI_JS%" %*\r\n';

/** The npm ≤ 6 form; corepack still ships it. */
export const COREPACK_CMD =
  '@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\corepack\\dist\\corepack.js" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\node_modules\\corepack\\dist\\corepack.js" %*\r\n)\r\n';

const HEAD =
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n';

export interface ShimSpec {
  /** The target, relative to the shim's folder, with `\` separators. */
  target: string;
  /** The shebang's program (`node`, `sh`); absent for a target without a shebang. */
  prog?: string;
  /** The shebang's arguments after the program. */
  args?: string;
  /** The shebang's `env K=V` assignments. */
  variables?: string[];
}

/** A shim exactly as cmd-shim writes it for `spec`. */
export function cmdShimText(spec: ShimSpec): string {
  if (spec.prog === undefined) return `${HEAD}"%dp0%\\${spec.target}"   %*\r\n`;
  const longProg = `%dp0%\\${spec.prog}.exe`;
  return (
    HEAD +
    (spec.variables ?? []).map((assignment) => `@SET ${assignment}\r\n`).join('') +
    '\r\n' +
    `IF EXIST "${longProg}" (\r\n` +
    `  SET "_prog=${longProg}"\r\n` +
    ') ELSE (\r\n' +
    `  SET "_prog=${spec.prog}"\r\n` +
    '  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n' +
    ')\r\n' +
    '\r\n' +
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ' +
    `"%_prog%" ${(spec.args ?? '').trim()} "%dp0%\\${spec.target}" %*\r\n`
  );
}
