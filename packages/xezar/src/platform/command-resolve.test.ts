import { describe, expect, it } from 'vitest';
import { CODEX_CMD, COREPACK_CMD, NPM_CMD, NPX_CMD, OPENCODE_CMD, VITEST_CMD } from './cmd-shim.testkit.ts';
import { CommandRefusedError, resolveCommand, type ResolveContext } from './command-resolve.ts';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const SYSTEM = { SystemRoot: 'C:\\Windows' };
const GLOBAL = 'C:\\Users\\me\\AppData\\Roaming\\npm';

/** A fake Windows disk: `files` maps a path (any case) to its text. */
function ctx(files: Record<string, string>, env: NodeJS.ProcessEnv, cwd = 'C:\\work'): ResolveContext {
  const byLower = new Map(Object.entries(files).map(([path, text]) => [path.toLowerCase(), text]));
  return {
    env: { ...SYSTEM, ...env },
    cwd,
    execPath: NODE,
    fs: {
      isFile: (path) => byLower.has(path.toLowerCase()),
      readText: (path, maxBytes) => {
        const text = byLower.get(path.toLowerCase());
        return text === undefined || text.length > maxBytes ? null : text;
      },
    },
  };
}

const resolveOn = (file: string, args: readonly string[], context: ResolveContext) =>
  resolveCommand(file, args, context, { platform: 'win32' });

function refusal(run: () => unknown): CommandRefusedError {
  try {
    run();
  } catch (error) {
    if (error instanceof CommandRefusedError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('resolveCommand off Windows', () => {
  it.each(['linux', 'darwin'] as const)('returns the command unchanged on %s', (platform) => {
    const args = ['a'];
    const resolved = resolveCommand('tool.cmd', args, ctx({}, {}), { platform });
    expect(resolved).toEqual({ file: 'tool.cmd', args, verbatim: false, how: 'as-given' });
    expect(resolved.args).toBe(args);
  });
});

describe('resolveCommand – bare names', () => {
  it('passes an .exe on PATH on by its bare name (D2)', () => {
    const args = ['status'];
    const resolved = resolveOn('git', args, ctx({ 'C:\\Git\\cmd\\git.exe': '' }, { PATH: 'C:\\Git\\cmd' }));
    expect(resolved).toEqual({ file: 'git', args, verbatim: false, how: 'bare-name' });
    expect(resolved.args).toBe(args);
  });

  it('names the .exe in full when the PATH has an entry that depends on the working folder', () => {
    for (const relative of ['', '.', 'bin', 'C:foo', '\\foo']) {
      const resolved = resolveOn('git', [], ctx({ 'C:\\Git\\cmd\\git.exe': '' }, { PATH: `${relative};C:\\Git\\cmd` }));
      // Spelled with PATHEXT's extension; Windows file names ignore case.
      expect(resolved).toMatchObject({ file: 'C:\\Git\\cmd\\git.EXE', how: 'full-path' });
    }
  });

  // SEC-963-02: a name handed to Node unchanged is searched by libuv again – relative entries
  // included – so it is handed over with a PATH that cannot reach them.
  it('never finds a copy in the working folder or a relative entry, not even through Node', () => {
    const files = { 'C:\\work\\git.exe': '', 'C:\\work\\bin\\git.exe': '' };
    expect(resolveOn('git', [], ctx(files, { PATH: '.;bin' }))).toEqual({
      file: 'git',
      args: [],
      verbatim: false,
      how: 'missing',
      searchPath: '',
    });
    expect(resolveOn('git', [], ctx(files, { PATH: '.;C:\\tools;bin;C:\\other' }))).toMatchObject({
      how: 'missing',
      searchPath: 'C:\\tools;C:\\other',
    });
  });

  it('names in full the .exe Node would find after a shim whose target is missing, past a relative entry', () => {
    const files = { [`${GLOBAL}\\codex.cmd`]: CODEX_CMD, 'C:\\later\\codex.exe': '', 'C:\\work\\bin\\codex.exe': '' };
    expect(resolveOn('codex', [], ctx(files, { PATH: `${GLOBAL};bin;C:\\later` }))).toMatchObject({
      file: 'C:\\later\\codex.exe',
      how: 'full-path',
    });
    expect(resolveOn('codex', [], ctx({ [`${GLOBAL}\\codex.cmd`]: CODEX_CMD }, { PATH: `bin;${GLOBAL}` }))).toMatchObject({
      file: 'codex',
      how: 'missing',
      searchPath: GLOBAL,
    });
  });

  it('searches PATH entry by entry in PATHEXT order', () => {
    // The shim's target, `..\vitest\vitest.mjs`, is C:\vitest\vitest.mjs from C:\a.
    const files = { 'C:\\a\\tool.cmd': VITEST_CMD, 'C:\\b\\tool.exe': '', 'C:\\vitest\\vitest.mjs': '' };
    const env = { PATH: 'C:\\a;C:\\b', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    // C:\a comes first, so its .cmd wins over C:\b's .exe – what a shell would start.
    expect(resolveOn('tool', [], ctx(files, env))).toMatchObject({ how: 'shim-node' });
    // Within one entry, PATHEXT decides.
    const both = { 'C:\\a\\tool.cmd': VITEST_CMD, 'C:\\a\\tool.exe': '', 'C:\\vitest\\vitest.mjs': '' };
    expect(resolveOn('tool', [], ctx(both, { PATH: 'C:\\a', PATHEXT: '.CMD;.EXE' }))).toMatchObject({ how: 'shim-node' });
    expect(resolveOn('tool', [], ctx(both, { PATH: 'C:\\a', PATHEXT: '.EXE;.CMD' }))).toMatchObject({ how: 'bare-name' });
  });

  it("reads the PATH spelling Node gives the child ('PATH' before 'Path')", () => {
    const files = { 'C:\\right\\tool.exe': '', 'C:\\wrong\\tool.exe': '' };
    expect(resolveOn('tool', [], ctx(files, { Path: '.;C:\\wrong', PATH: 'C:\\right' }))).toMatchObject({ how: 'bare-name' });
    expect(resolveOn('tool', [], ctx(files, { Path: 'C:\\right', PATH: '.;C:\\wrong' }))).toMatchObject({
      file: 'C:\\wrong\\tool.EXE',
    });
  });

  it('passes a missing program on unchanged, so Node reports ENOENT (AC-4)', () => {
    const args = ['--version'];
    const resolved = resolveOn('xez-no-such-program', args, ctx({}, { PATH: 'C:\\bin' }));
    expect(resolved).toEqual({ file: 'xez-no-such-program', args, verbatim: false, how: 'as-given' });
  });

  it('accepts a name that already carries a searchable extension', () => {
    const files = { [`${GLOBAL}\\npx.cmd`]: NPX_CMD, [`${GLOBAL}\\node_modules\\npm\\bin\\npx-cli.js`]: '' };
    expect(resolveOn('npx.cmd', ['-y', 'x'], ctx(files, { PATH: GLOBAL }))).toEqual({
      file: NODE,
      args: [`${GLOBAL}\\node_modules\\npm\\bin\\npx-cli.js`, '-y', 'x'],
      verbatim: false,
      how: 'shim-node',
    });
  });
});

describe('resolveCommand – shims and scripts', () => {
  const shimFiles = {
    [`${GLOBAL}\\codex.cmd`]: CODEX_CMD,
    [`${GLOBAL}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '',
  };

  it('unwraps the cmd-shim node form to node + script, arguments untouched', () => {
    const args = ['app-server', 'x" & calc & "', '%PATH%'];
    expect(resolveOn('codex', args, ctx(shimFiles, { PATH: GLOBAL }))).toEqual({
      file: NODE,
      args: [`${GLOBAL}\\node_modules\\@openai\\codex\\bin\\codex.js`, ...args],
      verbatim: false,
      how: 'shim-node',
    });
  });

  it("prefers a node.exe next to the shim, as the shim does", () => {
    const files = { ...shimFiles, [`${GLOBAL}\\node.exe`]: '' };
    expect(resolveOn('codex', [], ctx(files, { PATH: GLOBAL })).file).toBe(`${GLOBAL}\\node.exe`);
  });

  it('starts the program form directly', () => {
    const files = { [`${GLOBAL}\\opencode.cmd`]: OPENCODE_CMD, [`${GLOBAL}\\node_modules\\opencode-ai\\bin\\opencode.exe`]: '' };
    expect(resolveOn('opencode', ['serve'], ctx(files, { PATH: GLOBAL }))).toEqual({
      file: `${GLOBAL}\\node_modules\\opencode-ai\\bin\\opencode.exe`,
      args: ['serve'],
      verbatim: false,
      how: 'shim-program',
    });
  });

  it("unwraps npm's own npm.cmd", () => {
    const dir = 'C:\\Program Files\\nodejs';
    const files = { [`${dir}\\npm.cmd`]: NPM_CMD, [`${dir}\\node.exe`]: '', [`${dir}\\node_modules\\npm\\bin\\npm-cli.js`]: '' };
    expect(resolveOn('npm', ['ci'], ctx(files, { PATH: dir }))).toEqual({
      file: `${dir}\\node.exe`,
      args: [`${dir}\\node_modules\\npm\\bin\\npm-cli.js`, 'ci'],
      verbatim: false,
      how: 'shim-node',
    });
  });

  it('passes a shim whose target is missing on unchanged (AC-4)', () => {
    const files = { [`${GLOBAL}\\codex.cmd`]: CODEX_CMD };
    expect(resolveOn('codex', [], ctx(files, { PATH: GLOBAL }))).toMatchObject({ file: 'codex', how: 'as-given' });
    expect(resolveOn(`${GLOBAL}\\codex.cmd`, [], ctx(files, {}))).toMatchObject({ file: `${GLOBAL}\\codex.cmd`, how: 'as-given' });
  });

  it('runs an explicit .js/.mjs/.cjs through node (D4)', () => {
    for (const ext of ['.js', '.mjs', '.cjs']) {
      const script = `C:\\fixtures\\mock${ext}`;
      expect(resolveOn(script, ['a'], ctx({ [script]: '' }, {}))).toEqual({
        file: NODE,
        args: [script, 'a'],
        verbatim: false,
        how: 'script',
      });
    }
    expect(resolveOn('..\\fixtures\\mock.mjs', [], ctx({ 'C:\\fixtures\\mock.mjs': '' }, {}, 'C:\\work'))).toMatchObject({
      args: ['C:\\fixtures\\mock.mjs'],
    });
  });

  it('adds PATHEXT to an explicit path without an extension', () => {
    const files = { 'C:\\tools\\build.CMD': VITEST_CMD, 'C:\\vitest\\vitest.mjs': '' };
    expect(resolveOn('C:\\tools\\build', [], ctx(files, {}))).toMatchObject({ how: 'shim-node' });
    expect(resolveOn('C:\\tools\\app.exe', [], ctx({ 'C:\\tools\\app.exe': '' }, {}))).toMatchObject({
      file: 'C:\\tools\\app.exe',
      how: 'as-given',
    });
  });
});

describe('resolveCommand – other batch files (AC-3)', () => {
  const batch = 'C:\\tools\\build.bat';
  const files = { [batch]: '@echo off\r\necho %*\r\n' };

  it('runs one through cmd.exe from System32 when every argument is safe', () => {
    expect(resolveOn(batch, ['--fast', 'src/a.ts'], ctx(files, {}))).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '""C:\\tools\\build.bat" --fast src/a.ts"'],
      verbatim: true,
      how: 'batch',
    });
  });

  it.each(['x" & calc & "', '%PATH%', '!x!', 'C:\\dir\\', 'a,b', 'a=b'])('refuses %j, naming the file and position only', (arg) => {
    const error = refusal(() => resolveOn(batch, ['ok', arg], ctx(files, {})));
    expect(error.code).toBe('XEZ_CMD_UNSAFE_ARG');
    expect(error.file).toBe(batch);
    expect(error.message).toContain('argument 2');
    expect(error.message).toContain(batch);
    if (arg.length > 2) expect(error.message).not.toContain(arg);
  });

  it('treats a declined shim as an ordinary batch file', () => {
    const shim = `${GLOBAL}\\corepack.cmd`;
    expect(resolveOn(shim, ['enable'], ctx({ [shim]: COREPACK_CMD }, {}))).toMatchObject({ how: 'batch', verbatim: true });
  });

  it('refuses a batch file in an unsafe folder, a line too long, and a missing SystemRoot', () => {
    const unsafe = 'C:\\A&B\\build.bat';
    expect(refusal(() => resolveOn(unsafe, [], ctx({ [unsafe]: '' }, {}))).code).toBe('XEZ_CMD_UNSAFE_PATH');
    expect(refusal(() => resolveOn(batch, ['a'.repeat(8200)], ctx(files, {}))).code).toBe('XEZ_CMD_TOO_LONG');
    const noRoot = { ...ctx(files, {}), env: {} };
    expect(refusal(() => resolveOn(batch, [], noRoot)).code).toBe('XEZ_CMD_NO_SYSTEM_ROOT');
  });
});

describe('resolveCommand – cmd.exe itself (D22)', () => {
  it.each(['cmd', 'CMD.EXE', 'C:\\Windows\\System32\\cmd.exe', 'C:\\elsewhere\\Cmd'])('refuses %j', (file) => {
    expect(refusal(() => resolveOn(file, ['/c', 'echo'], ctx({}, { PATH: 'C:\\Windows\\System32' }))).code).toBe(
      'XEZ_CMD_DIRECT',
    );
  });

  it('refuses a program shim whose target is cmd.exe', () => {
    const shim = `${GLOBAL}\\sneaky.cmd`;
    const text = OPENCODE_CMD.replace('node_modules\\opencode-ai\\bin\\opencode.exe', 'cmd.exe');
    expect(refusal(() => resolveOn(shim, [], ctx({ [shim]: text, [`${GLOBAL}\\cmd.exe`]: '' }, {}))).code).toBe(
      'XEZ_CMD_DIRECT',
    );
  });
});
