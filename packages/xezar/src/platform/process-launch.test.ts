import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { useEmptyPath } from '../../test/helpers/empty-path.ts';
import { trackedChildren } from './child-registry.ts';
import { CODEX_CMD } from './cmd-shim.testkit.ts';
import { CommandRefusedError, type ResolveContext } from './command-resolve.ts';
import {
  cmdLine,
  launch,
  launchCmd,
  launchDetached,
  launchFile,
  launchFileAsync,
  launchFileSync,
  type LaunchFileCallback,
} from './process-launch.ts';

const fakes = vi.hoisted(() => ({
  children: [] as unknown[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter: Emitter } = await import('node:events');
  const child = (): unknown => {
    const fake = Object.assign(new Emitter(), { pid: 4242, exitCode: null, signalCode: null, unref: () => {}, kill: () => true });
    fakes.children.push(fake);
    return fake;
  };
  return {
    ...actual,
    spawn: vi.fn(() => child()),
    execFile: vi.fn((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      queueMicrotask(() => callback(null, 'out', 'err'));
      return child();
    }),
    execFileSync: vi.fn(() => 'sync-out'),
  };
});

const { execFile, execFileSync, spawn } = await import('node:child_process');
const spawnMock = vi.mocked(spawn);
const execFileMock = vi.mocked(execFile);
const execFileSyncMock = vi.mocked(execFileSync);

const pathAtLoad = process.env.PATH;
useEmptyPath();
afterAll(() => {
  expect(process.env.PATH).toBe(pathAtLoad);
});

beforeEach(() => {
  vi.clearAllMocks();
  fakes.children.length = 0;
});

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const GLOBAL = 'C:\\Users\\me\\AppData\\Roaming\\npm';
const CODEX_JS = `${GLOBAL}\\node_modules\\@openai\\codex\\bin\\codex.js`;
const SYSTEM = { SystemRoot: 'C:\\Windows' };

/** Windows shaping against a fake disk that holds an npm-installed codex and a batch file. */
function windows(files: Record<string, string> = {}): { platform: 'win32'; resolve: Partial<ResolveContext> } {
  const all: Record<string, string> = {
    [`${GLOBAL}\\codex.cmd`]: CODEX_CMD,
    [CODEX_JS]: '',
    'C:\\tools\\build.bat': '@echo off\r\n',
    ...files,
  };
  const byLower = new Map(Object.entries(all).map(([path, text]) => [path.toLowerCase(), text]));
  return {
    platform: 'win32',
    resolve: {
      env: { ...SYSTEM, PATH: GLOBAL },
      cwd: 'C:\\work',
      execPath: NODE,
      fs: {
        isFile: (path) => byLower.has(path.toLowerCase()),
        readText: (path) => byLower.get(path.toLowerCase()) ?? null,
      },
    },
  };
}

const noop: LaunchFileCallback = () => {};

function refusal(run: () => unknown): CommandRefusedError {
  try {
    run();
  } catch (error) {
    if (error instanceof CommandRefusedError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

it('runs every test of this file with an empty PATH on Windows, and leaves PATH alone elsewhere', () => {
  // Only Windows searches PATH before a start; elsewhere real stubs need PATH to find node.
  expect(process.env.PATH).toBe(process.platform === 'win32' ? '' : pathAtLoad);
});

describe.each(['linux', 'darwin'] as const)('on %s every wrapper passes its arguments through by reference (AC-1)', (platform) => {
  const deps = { platform };

  it('launch → spawn(file, args, options), and spawn(file, args) without options', () => {
    const args = ['-p', 'hi'];
    const options = { cwd: '/repo', env: { PATH: '/usr/bin' } };
    const snapshot = structuredClone(options);
    const child = launch('claude', args, options, { hide: true }, deps);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const call = spawnMock.mock.calls[0]!;
    expect(call).toHaveLength(3);
    expect(call[0]).toBe('claude');
    expect(call[1]).toBe(args);
    expect(call[2]).toBe(options);
    expect(options).toEqual(snapshot);
    expect(child).toBe(fakes.children[0]);

    launch('git', args, undefined, {}, deps);
    expect(spawnMock.mock.calls[1]).toHaveLength(2);
    expect(spawnMock.mock.calls[1]![1]).toBe(args);
  });

  it('launchFile → execFile(file, args, options, callback)', () => {
    const args = ['status'];
    const options = { cwd: '/repo', encoding: 'utf8' as const };
    const child = launchFile('git', args, options, noop, deps);
    const call = execFileMock.mock.calls[0]!;
    expect(call).toHaveLength(4);
    expect(call[0]).toBe('git');
    expect(call[1]).toBe(args);
    expect(call[2]).toBe(options);
    expect(call[3]).toBe(noop);
    expect(options).toEqual({ cwd: '/repo', encoding: 'utf8' });
    expect(child).toBe(fakes.children[0]);
  });

  it('launchFileAsync → the promisified execFile with the same file, args and options', async () => {
    const args = ['--version'];
    const options = { timeout: 5_000 };
    await launchFileAsync('gh', args, options, deps);
    const call = execFileMock.mock.calls[0]!;
    expect(call[0]).toBe('gh');
    expect(call[1]).toBe(args);
    expect(call[2]).toBe(options);
    expect(typeof call[3]).toBe('function');
    expect(options).toEqual({ timeout: 5_000 });
  });

  it('launchFileSync → execFileSync(file, args, options)', () => {
    const args = ['rev-parse'];
    const options = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
    expect(launchFileSync('git', args, options, deps)).toBe('sync-out');
    const call = execFileSyncMock.mock.calls[0]!;
    expect(call).toHaveLength(3);
    expect(call[1]).toBe(args);
    expect(call[2]).toBe(options);
  });

  it('launchDetached → spawn(file, args, { stdio: ignore, detached }) and true after the settle window', async () => {
    const args = ['/repo'];
    // The inherited environment, pinned: without the run marker nothing is passed, as before.
    expect(await launchDetached('code', args, 0, { ...deps, resolve: { env: { PATH: '/usr/bin' } } })).toBe(true);
    const call = spawnMock.mock.calls[0]!;
    expect(call[0]).toBe('code');
    expect(call[1]).toBe(args);
    expect(call[2]).toEqual({ stdio: 'ignore', detached: true });
  });

  // ARCH-2 / SEC-963-04: an editor or terminal a nested xezar opens must not carry the outer
  // run's marker, or stopping that run would sweep the user's editor on Linux.
  it('launchDetached passes the environment without the run marker when it holds one', async () => {
    const env = { PATH: '/usr/bin', XEZ_TASK_ID: 'run-1' };
    expect(await launchDetached('code', ['/repo'], 0, { ...deps, resolve: { env } })).toBe(true);
    expect(spawnMock.mock.calls[0]![2]).toEqual({ stdio: 'ignore', detached: true, env: { PATH: '/usr/bin' } });
  });

  it('launchDetached answers false when the start fails', async () => {
    spawnMock.mockImplementationOnce(() => {
      const failing = new EventEmitter();
      queueMicrotask(() => failing.emit('error', new Error('spawn xdg-open ENOENT')));
      return Object.assign(failing, { unref: () => {} }) as never;
    });
    expect(await launchDetached('xdg-open', ['x'], 20, deps)).toBe(false);
  });
});

describe('the narrow launchFile type (A5)', () => {
  it('is the 4-argument execFile form plus the test seam, with no __promisify__', () => {
    expectTypeOf<Parameters<typeof launchFile>[0]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<typeof launchFile>[1]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<Parameters<typeof launchFile>[3]>().toEqualTypeOf<LaunchFileCallback>();
    expectTypeOf(launchFile).not.toHaveProperty('__promisify__');
    expectTypeOf(launchFileAsync).returns.resolves.toEqualTypeOf<{ stdout: string; stderr: string }>();
  });
});

describe.each(['linux', 'darwin', 'win32'] as const)('on %s a shell is refused before anything starts (SEC-11)', (platform) => {
  const deps = platform === 'win32' ? windows() : { platform };

  it.each([
    ['shell: true', { shell: true }],
    ['a shell path', { shell: '/bin/sh' }],
    ['windowsVerbatimArguments', { windowsVerbatimArguments: true }],
  ])('refuses %s', async (_label, options) => {
    expect(refusal(() => launch('tool', ['x'], options, {}, deps)).code).toBe('XEZ_SHELL_REFUSED');
    expect(refusal(() => launchFile('tool', ['x'], options, noop, deps)).code).toBe('XEZ_SHELL_REFUSED');
    expect(refusal(() => launchFileSync('tool', ['x'], { ...options, encoding: 'utf8' }, deps)).code).toBe('XEZ_SHELL_REFUSED');
    await expect(launchFileAsync('tool', ['x'], options, deps)).rejects.toMatchObject({ code: 'XEZ_SHELL_REFUSED' });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('lets shell: false through', () => {
    launch('tool', [], { shell: false }, {}, deps);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('Windows shaping, on every OS (A6, AC-2)', () => {
  it('unwraps an npm shim to node + script and keeps the arguments and options', () => {
    const args = ['app-server', 'x" & calc & "'];
    const options = { cwd: 'C:\\work', env: { ...SYSTEM, PATH: GLOBAL } };
    launch('codex', args, options, {}, windows());
    const [file, passedArgs, passedOptions] = spawnMock.mock.calls[0]!;
    expect(file).toBe(NODE);
    expect(passedArgs).toEqual([CODEX_JS, ...args]);
    expect(passedOptions).toBe(options);
  });

  it('hides the window only for launchFile* and launches that opt in, never over an explicit choice (D7)', () => {
    const options = { cwd: 'C:\\work' };
    launch('codex', [], options, {}, windows());
    launch('codex', [], options, { hide: true }, windows());
    launch('codex', [], { windowsHide: false }, { hide: true }, windows());
    launchFile('codex', [], { encoding: 'utf8' }, noop, windows());
    launchFileSync('codex', [], { encoding: 'utf8' }, windows());
    void launchDetached('codex', [], 0, windows());
    expect(spawnMock.mock.calls[0]![2]).toBe(options);
    expect(spawnMock.mock.calls[1]![2]).toEqual({ cwd: 'C:\\work', windowsHide: true });
    expect(spawnMock.mock.calls[2]![2]).toEqual({ windowsHide: false });
    expect(execFileMock.mock.calls[0]![2]).toEqual({ encoding: 'utf8', windowsHide: true });
    expect(execFileSyncMock.mock.calls[0]![2]).toEqual({ encoding: 'utf8', windowsHide: true });
    expect(spawnMock.mock.calls[3]![2]).toEqual({ stdio: 'ignore', detached: true });
    expect(options).toEqual({ cwd: 'C:\\work' });
  });

  it('runs a batch file through System32 cmd.exe with the verbatim line it checked', () => {
    launchFile('C:\\tools\\build.bat', ['--fast'], { encoding: 'utf8' }, noop, windows());
    expect(execFileMock.mock.calls[0]!.slice(0, 3)).toEqual([
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/v:off', '/s', '/c', '""C:\\tools\\build.bat" --fast"'],
      { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true },
    ]);
  });

  it('refuses an unsafe batch argument and a direct cmd.exe without starting anything (AC-3, D22)', () => {
    expect(refusal(() => launch('C:\\tools\\build.bat', ['%PATH%'], {}, {}, windows())).code).toBe('XEZ_CMD_UNSAFE_ARG');
    expect(refusal(() => launchFile('cmd', ['/c', 'echo'], { encoding: 'utf8' }, noop, windows())).code).toBe('XEZ_CMD_DIRECT');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('drops the run marker in any spelling from a detached start (ARCH-2, SEC-963-04)', async () => {
    const shaped = windows();
    const env = { ...shaped.resolve.env, xez_task_id: 'run-1' };
    expect(await launchDetached('codex', [], 0, { ...shaped, resolve: { ...shaped.resolve, env } })).toBe(true);
    expect(spawnMock.mock.calls[0]![2]).toEqual({ stdio: 'ignore', detached: true, env: shaped.resolve.env });
  });

  it('answers false from launchDetached for a refused start', async () => {
    expect(await launchDetached('cmd', ['/c', 'start'], 0, windows())).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // SEC-963-02: libuv would search a relative PATH entry for the missing name in the child's
  // working folder; the start gets a PATH without such entries and fails with ENOENT instead.
  it('starts a missing program with only the fully-qualified PATH entries, when the PATH has others', () => {
    const shaped = windows();
    const env = { ...shaped.resolve.env, Path: `bin;${GLOBAL}` };
    delete (env as NodeJS.ProcessEnv).PATH;
    launch('xez-no-such-program', ['--version'], { env }, {}, { ...shaped, resolve: { ...shaped.resolve, env } });
    const [file, , options] = spawnMock.mock.calls[0]!;
    expect(file).toBe('xez-no-such-program');
    expect((options as { env: NodeJS.ProcessEnv }).env).toEqual({ ...SYSTEM, PATH: GLOBAL });
  });

  it('passes a missing program on unchanged (AC-4)', () => {
    const args = ['--version'];
    launch('xez-no-such-program', args, {}, {}, windows());
    expect(spawnMock.mock.calls[0]![0]).toBe('xez-no-such-program');
    expect(spawnMock.mock.calls[0]![1]).toBe(args);
  });

  it('tracks only real children, never a test fake', () => {
    launch('codex', [], {}, {}, windows());
    expect(trackedChildren().map(({ child }) => child)).not.toContain(fakes.children[0]);
  });
});

describe('launchCmd (D22, SEC-7)', () => {
  const CMD = 'C:\\Windows\\System32\\cmd.exe';

  it('opens a URL through System32 cmd.exe with /d /v:off, verbatim and detached', async () => {
    expect(await launchCmd(['/c', 'start', '', 'http://127.0.0.1:4777/'], { env: SYSTEM, settleMs: 0 })).toBe(true);
    expect(spawnMock.mock.calls[0]).toEqual([
      CMD,
      ['/d', '/v:off', '/c', 'start', '""', 'http://127.0.0.1:4777/'],
      { stdio: 'ignore', detached: true, windowsVerbatimArguments: true },
    ]);
  });

  it('starts the window without the run marker, in any spelling (ARCH-2, SEC-963-04)', async () => {
    const env = { ...SYSTEM, Xez_Task_Id: 'run-1', XEZ_TASK_ID: 'run-1' };
    expect(await launchCmd(['/c', 'start', '', 'http://127.0.0.1:4777/'], { env, settleMs: 0 })).toBe(true);
    expect(spawnMock.mock.calls[0]![2]).toEqual({
      stdio: 'ignore',
      detached: true,
      windowsVerbatimArguments: true,
      env: SYSTEM,
    });
  });

  // SEC-963-01: Windows Terminal reads `;` as a command separator even inside quotes.
  it('refuses a `;` anywhere after Windows Terminal, and keeps it for the classic window', () => {
    const payload = 'set "CLAUDE_CONFIG_DIR=C:\\x;powershell -NoP -e SQBFAFgA" && claude --resume 0f8c2a4e';
    for (const terminal of ['wt', 'WT.EXE']) {
      const error = refusal(() => cmdLine(['/c', 'start', '', terminal, '-d', 'C:\\work', 'cmd', '/K', payload]));
      expect(error.code).toBe('XEZ_CMD_UNSAFE_ARG');
      expect(error.message).toContain('argument 9');
    }
    expect(cmdLine(['/c', 'start', '', 'cmd', '/K', payload]).at(-1)).toBe(`"${payload}"`);
  });

  /**
   * How Windows Terminal splits the line `start ""` hands it on verbatim: the CommandLineToArgvW
   * rules (a quote toggles quoting and is dropped; 2n backslashes before a quote are n, 2n+1 are n
   * and a literal quote). Checked against a real Windows process for every line below
   * (scratch probe, fix round 2); `""` inside quotes never occurs in these lines.
   */
  function windowsArgv(line: string): string[] {
    const argv: string[] = [];
    let i = 0;
    for (;;) {
      while (line[i] === ' ' || line[i] === '\t') i += 1;
      if (i >= line.length) return argv;
      let arg = '';
      let quoted = false;
      while (i < line.length && (quoted || (line[i] !== ' ' && line[i] !== '\t'))) {
        if (line[i] === '\\') {
          let slashes = 0;
          while (line[i] === '\\') {
            slashes += 1;
            i += 1;
          }
          const beforeQuote = line[i] === '"';
          arg += '\\'.repeat(beforeQuote ? Math.floor(slashes / 2) : slashes);
          if (beforeQuote && slashes % 2 === 1) {
            arg += '"';
            i += 1;
          }
        } else if (line[i] === '"') {
          quoted = !quoted;
          i += 1;
        } else {
          arg += line[i];
          i += 1;
        }
      }
      argv.push(arg);
    }
  }

  // SEC-11A-01: Windows Terminal rebuilds its tab's command from that split, so a quote inside the
  // `/K` payload is lost – `set "CLAUDE_CONFIG_DIR=…"` reached the tab cut at a space, or with a
  // trailing one, and the shell pointed at the wrong agent account.
  it('hands Windows Terminal only a /K payload its argument split keeps whole, and a quoted one to the classic window', () => {
    for (const payload of [
      'set "CLAUDE_CONFIG_DIR=C:\\Users\\Jane Doe\\.claude" && claude --resume 0f8c2a4e',
      'set "CLAUDE_CONFIG_DIR=C:\\cfg" && claude --resume 0f8c2a4e',
    ]) {
      // why it is refused: what Windows Terminal would read is not the payload that was checked
      expect(windowsArgv(`wt -d C:\\work cmd /K "${payload}"`).slice(5)).not.toEqual([payload]);
      for (const terminal of ['wt', 'wt.exe']) {
        const error = refusal(() => cmdLine(['/c', 'start', '', terminal, '-d', 'C:\\work', 'cmd', '/K', payload]));
        expect(error.code).toBe('XEZ_CMD_UNSAFE_ARG');
        expect(error.message).toContain('argument 9');
      }
      expect(cmdLine(['/c', 'start', '', 'cmd', '/K', payload]).at(-1)).toBe(`"${payload}"`);
    }
    // What is let through reaches Windows Terminal as one argument, exactly as it was checked.
    for (const folder of ['C:\\work', '"C:\\my work\\wt"']) {
      const line = cmdLine(['/c', 'start', '', 'wt', '-d', folder, 'cmd', '/K', 'claude --resume 0f8c2a4e']);
      expect(windowsArgv(line.slice(3).join(' '))).toEqual(['wt', '-d', folder.replaceAll('"', ''), 'cmd', '/K', 'claude --resume 0f8c2a4e']);
    }
  });

  // SEC-11A-06: the Windows Terminal rules follow it to a full path, and a /K payload is checked
  // only as what cmd.exe reads.
  it('applies the Windows Terminal rules to a full path, and takes a /K payload only for cmd', () => {
    const terminal = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe';
    const payload = 'set "CLAUDE_CONFIG_DIR=C:\\x;y" && claude --resume 0f8c2a4e';
    expect(refusal(() => cmdLine(['/c', 'start', '', terminal, '-d', 'C:\\work', 'cmd', '/K', payload])).code).toBe('XEZ_CMD_UNSAFE_ARG');
    expect(refusal(() => cmdLine(['/c', 'start', '', terminal, '-d', 'C:\\work', 'cmd', '/K', 'claude "x"'])).code).toBe('XEZ_CMD_UNSAFE_ARG');
    expect(cmdLine(['/c', 'start', '', 'C:\\Windows\\System32\\cmd.exe', '/K', 'claude --resume 0f8c2a4e']).at(-1)).toBe('"claude --resume 0f8c2a4e"');
    for (const program of ['powershell', 'wsl', 'notepad.exe']) {
      const error = refusal(() => cmdLine(['/c', 'start', '', program, '/K', 'claude --resume 0f8c2a4e']));
      expect(error.code).toBe('XEZ_CMD_UNSAFE_ARG');
      expect(error.message).toContain('argument 6');
    }
  });

  it('passes a path the caller quoted, and refuses one whose last backslash would escape the quote (Q-04)', () => {
    expect(cmdLine(['/c', 'start', '', 'wt', '-d', '"C:\\my work\\wt"', 'cmd'])).toEqual([
      '/c',
      'start',
      '""',
      'wt',
      '-d',
      '"C:\\my work\\wt"',
      'cmd',
    ]);
    expect(refusal(() => cmdLine(['/c', 'start', '', 'wt', '-d', '"C:\\my work\\"'])).code).toBe('XEZ_CMD_UNSAFE_ARG');
  });

  it('quotes one checked payload after /K as a whole', () => {
    const payload = 'cd /d "C:\\Users\\Jane Doe\\repo" && set "CLAUDE_CONFIG_DIR=C:\\cfg" && claude --resume 0f8c2a4e';
    expect(cmdLine(['/c', 'start', '', 'cmd', '/K', payload])).toEqual(['/c', 'start', '""', 'cmd', '/K', `"${payload}"`]);
  });

  it.each([
    ['an address with &', ['/c', 'start', '', 'http://x/?a=1&b=2'], 4],
    ['a second command after /K', ['/c', 'start', '', 'cmd', '/K', 'claude && calc'], 6],
    ['a payload that is not last', ['/c', 'start', '', 'cmd', '/K', 'claude --x', 'more'], 6],
    ['an empty argument outside the title slot', ['/c', ''], 2],
    ['a folder with &', ['/c', 'start', '', 'wt', '-d', 'C:\\A&B'], 6],
    ['a variable', ['/c', 'start', '', '%COMSPEC%'], 4],
  ])('refuses %s, before anything starts', (_label, args, position) => {
    const error = refusal(() => launchCmd(args, { env: SYSTEM }));
    expect(error.code).toBe('XEZ_CMD_UNSAFE_ARG');
    expect(error.message).toContain(`argument ${position}`);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses without a drive SystemRoot and past 8191 characters', () => {
    expect(refusal(() => launchCmd(['/c', 'start', '', 'http://x/'], { env: {} })).code).toBe('XEZ_CMD_NO_SYSTEM_ROOT');
    expect(refusal(() => launchCmd(['/c', 'start', '', `http://x/${'a'.repeat(8200)}`], { env: SYSTEM })).code).toBe(
      'XEZ_CMD_TOO_LONG',
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
