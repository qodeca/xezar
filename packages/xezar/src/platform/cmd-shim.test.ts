import { describe, expect, it } from 'vitest';
import { parseCmdShim } from './cmd-shim.ts';
import {
  CODEX_CMD,
  COREPACK_CMD,
  ESBUILD_CMD,
  NPM_CMD,
  NPX_CMD,
  OPENCODE_CMD,
  VITEST_CMD,
  cmdShimText,
} from './cmd-shim.testkit.ts';

const BIN = 'C:\\repo\\node_modules\\.bin';
const GLOBAL = 'C:\\Users\\me\\AppData\\Roaming\\npm';

describe('parseCmdShim – real shims', () => {
  it('reads the node form, resolving the target against the shim folder', () => {
    expect(parseCmdShim(VITEST_CMD, `${BIN}\\vitest.cmd`)).toEqual({
      kind: 'node-script',
      script: 'C:\\repo\\node_modules\\vitest\\vitest.mjs',
      nodeArgs: [],
    });
    expect(parseCmdShim(ESBUILD_CMD, `${BIN}\\esbuild.cmd`)).toEqual({
      kind: 'node-script',
      script: 'C:\\repo\\node_modules\\esbuild\\bin\\esbuild',
      nodeArgs: [],
    });
    expect(parseCmdShim(CODEX_CMD, `${GLOBAL}\\codex.cmd`)).toEqual({
      kind: 'node-script',
      script: `${GLOBAL}\\node_modules\\@openai\\codex\\bin\\codex.js`,
      nodeArgs: [],
    });
  });

  it('reads the program form for an .exe target', () => {
    expect(parseCmdShim(OPENCODE_CMD, `${GLOBAL}\\opencode.cmd`)).toEqual({
      kind: 'program',
      program: `${GLOBAL}\\node_modules\\opencode-ai\\bin\\opencode.exe`,
    });
  });

  it("reads npm's own npm.cmd and npx.cmd", () => {
    const dir = 'C:\\Program Files\\nodejs';
    expect(parseCmdShim(NPM_CMD, `${dir}\\npm.cmd`)).toEqual({
      kind: 'node-script',
      script: `${dir}\\node_modules\\npm\\bin\\npm-cli.js`,
      nodeArgs: [],
    });
    expect(parseCmdShim(NPX_CMD, `${dir}\\npx.cmd`)).toEqual({
      kind: 'node-script',
      script: `${dir}\\node_modules\\npm\\bin\\npx-cli.js`,
      nodeArgs: [],
    });
  });

  it('declines the npm ≤ 6 form', () => {
    expect(parseCmdShim(COREPACK_CMD, `${GLOBAL}\\corepack.cmd`)).toBeNull();
  });

  it('reads LF text the same as CRLF', () => {
    expect(parseCmdShim(VITEST_CMD.replaceAll('\r\n', '\n'), `${BIN}\\vitest.cmd`)).toEqual(
      parseCmdShim(VITEST_CMD, `${BIN}\\vitest.cmd`),
    );
  });
});

describe('the builder writes what cmd-shim writes', () => {
  it('reproduces the real shims byte for byte', () => {
    expect(cmdShimText({ prog: 'node', target: '..\\vitest\\vitest.mjs' })).toBe(VITEST_CMD);
    expect(cmdShimText({ prog: 'node', target: 'node_modules\\@openai\\codex\\bin\\codex.js' })).toBe(CODEX_CMD);
    expect(cmdShimText({ target: 'node_modules\\opencode-ai\\bin\\opencode.exe' })).toBe(OPENCODE_CMD);
  });
});

describe('parseCmdShim – what it declines', () => {
  const shim = `${BIN}\\tool.cmd`;

  it('keeps shebang node options that are plain flags', () => {
    expect(parseCmdShim(cmdShimText({ prog: 'node', args: '--no-warnings --max-old-space-size=4096', target: 'x.js' }), shim))
      .toEqual({ kind: 'node-script', script: `${BIN}\\x.js`, nodeArgs: ['--no-warnings', '--max-old-space-size=4096'] });
  });

  it.each([
    ['an env assignment', cmdShimText({ prog: 'node', variables: ['NODE_OPTIONS=--x'], target: 'x.js' })],
    ['another interpreter', cmdShimText({ prog: 'sh', target: 'x.sh' })],
    ['a non-flag node argument', cmdShimText({ prog: 'node', args: '-r ./hook.js', target: 'x.js' })],
    ['a program target that is not an .exe', cmdShimText({ target: 'x.ps1' })],
    ['a variable in the target', cmdShimText({ prog: 'node', target: '%OTHER%\\x.js' })],
    ['an extra command', VITEST_CMD.replace('SETLOCAL\r\n', 'SETLOCAL\r\ndel /q *\r\n')],
    ['a changed launch line', VITEST_CMD.replace('%*\r\n', '%* & calc\r\n')],
    ['a missing head', VITEST_CMD.replace('CALL :find_dp0\r\n', '')],
    ['npm.cmd starting another script', NPM_CMD.replace('"%NODE_EXE%" "%NPM_CLI_JS%" %*', '"%NODE_EXE%" "%NPX_CLI_JS%" %*')],
    ['an empty file', ''],
    ['an arbitrary batch file', '@echo off\r\necho hello %1\r\n'],
  ])('declines %s', (_label, text) => {
    expect(parseCmdShim(text, shim)).toBeNull();
  });
});
