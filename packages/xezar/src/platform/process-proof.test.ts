import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TableRunner } from './process-table.ts';
import {
  COMMAND_LINES_MAX,
  commandLineScript,
  envHasEntry,
  nameAndKillIdentified,
  nameAndKillScript,
  RUN_MARKER_ENV,
  pidExists,
  readCommandLines,
  withoutRunMarker,
} from './process-proof.ts';

const execHook = vi.hoisted(() => ({
  reply: { error: null as Error | null, stdout: '' },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
      queueMicrotask(() => callback(execHook.reply.error, execHook.reply.stdout));
      return undefined;
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  execHook.reply = { error: null, stdout: '' };
});

const RUN_ID = '3f2c1d7e-0000-4000-8000-000000000001';
const OTHER_RUN_ID = '3f2c1d7e-0000-4000-8000-000000000002';
const MARKER = `XEZ_TASK_ID=${RUN_ID}`;
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

function environ(...entries: string[]): Buffer {
  return Buffer.from(`${entries.join('\0')}\0`, 'utf8');
}

function procFs(files: Record<string, Buffer>): (path: string) => Promise<Buffer> {
  return async (path) => {
    const bytes = files[path];
    if (bytes === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return bytes;
  };
}

function recordingRunner(reply: string | null): { run: TableRunner; calls: Array<Parameters<TableRunner>> } {
  const calls: Array<Parameters<TableRunner>> = [];
  const run: TableRunner = async (...call) => {
    calls.push(call);
    return reply;
  };
  return { run, calls };
}

describe('envHasEntry', () => {
  const linux = (files: Record<string, Buffer>) => ({ platform: 'linux' as const, readBytes: procFs(files) });

  it('answers yes only for the exact, whole entry, wherever it sits', async () => {
    for (const bytes of [environ(MARKER), environ('PATH=/usr/bin', MARKER, 'HOME=/h'), Buffer.from(`A=1\0${MARKER}`)]) {
      expect(await envHasEntry(4000, MARKER, linux({ '/proc/4000/environ': bytes }))).toBe(true);
    }
  });

  it('refuses every near miss (SEC-4, SEC-10)', async () => {
    const decoys = {
      'a longer value': environ(`${MARKER}x`),
      'a longer name': environ(`X${MARKER}`),
      "another run's id": environ(`XEZ_TASK_ID=${OTHER_RUN_ID}`),
      'the id alone': environ(`SOMETHING=${RUN_ID}`),
      'the entry inside another value': environ(`NOTE=${MARKER}`),
      'an empty environment': Buffer.alloc(0),
    };
    for (const [label, bytes] of Object.entries(decoys)) {
      expect(await envHasEntry(4000, MARKER, linux({ '/proc/4000/environ': bytes })), label).toBe(false);
    }
  });

  it('reads the environment, never the command line: the literal entry in argv is no proof', async () => {
    const readBytes = vi.fn(procFs({ '/proc/4000/cmdline': Buffer.from(`node\0-e\0${MARKER}\0`), '/proc/4000/environ': environ('PATH=/bin') }));
    expect(await envHasEntry(4000, MARKER, { platform: 'linux', readBytes })).toBe(false);
    expect(readBytes.mock.calls).toEqual([['/proc/4000/environ']]);
  });

  it('is false when unreadable, and gives nothing of the error back (SEC-5)', async () => {
    const readBytes = async (): Promise<Buffer> => {
      throw new Error(`EACCES reading GITHUB_TOKEN=${TOKEN}`);
    };
    await expect(envHasEntry(4000, MARKER, { platform: 'linux', readBytes })).resolves.toBe(false);
  });

  it('is false off Linux, for a bad pid or a malformed entry, without reading anything', async () => {
    const readBytes = vi.fn(procFs({ '/proc/4000/environ': environ(MARKER) }));
    for (const platform of ['darwin', 'win32', 'freebsd'] as const) {
      expect(await envHasEntry(4000, MARKER, { platform, readBytes })).toBe(false);
    }
    for (const pid of [0, 1, -4000, 1.5, Number.NaN]) {
      expect(await envHasEntry(pid, MARKER, { platform: 'linux', readBytes })).toBe(false);
    }
    for (const entry of ['', '=x', 'NOEQUALS', `${MARKER}\0`]) {
      expect(await envHasEntry(4000, entry, { platform: 'linux', readBytes })).toBe(false);
    }
    expect(readBytes).not.toHaveBeenCalled();
  });
});

describe('withoutRunMarker (ARCH-2, SEC-963-04)', () => {
  it('is the run marker every agent carries', () => {
    expect(RUN_MARKER_ENV).toBe('XEZ_TASK_ID');
  });

  it('answers undefined when there is no marker, so the child inherits exactly as before', () => {
    expect(withoutRunMarker({ PATH: '/usr/bin' }, { platform: 'linux' })).toBeUndefined();
    expect(withoutRunMarker({ Path: 'C:/x' }, { platform: 'win32' })).toBeUndefined();
  });

  it('drops exactly the marker on POSIX, where names are case-sensitive', () => {
    const env = { PATH: '/usr/bin', XEZ_TASK_ID: 'run-1', xez_task_id: 'a different variable' };
    expect(withoutRunMarker(env, { platform: 'linux' })).toEqual({ PATH: '/usr/bin', xez_task_id: 'a different variable' });
    expect(env).toHaveProperty('XEZ_TASK_ID', 'run-1');
  });

  it('drops every spelling on Windows, which reads names case-insensitively', () => {
    expect(withoutRunMarker({ Path: 'C:/x', Xez_Task_Id: 'run-1', XEZ_TASK_ID: 'run-1' }, { platform: 'win32' })).toEqual({ Path: 'C:/x' });
  });
});

describe('pidExists', () => {
  it('asks with signal 0 and reads EPERM as alive, ESRCH as gone', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(pidExists(4321)).toBe(true);
    expect(kill).toHaveBeenCalledWith(4321, 0);
    kill.mockImplementation(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });
    expect(pidExists(4321)).toBe(true);
    kill.mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    expect(pidExists(4321)).toBe(false);
  });

  it('never asks about 0, 1 or a group', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    for (const pid of [0, 1, -1, -4321, 1.5, Number.NaN]) expect(pidExists(pid)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('readCommandLines', () => {
  const env = { SystemRoot: 'C:\\Windows' };

  it('Linux: reads /proc/<pid>/cmdline for the asked pids only, NULs as spaces', async () => {
    const readBytes = vi.fn(
      procFs({
        '/proc/4121/cmdline': Buffer.from('node\0server.js\0--port\x003000\0'),
        '/proc/4122/cmdline': Buffer.alloc(0),
      }),
    );
    const lines = await readCommandLines([4121, 4122, 4123, 4121], { platform: 'linux', readBytes });
    expect(lines).toEqual(new Map([[4121, 'node server.js --port 3000']]));
    expect(readBytes.mock.calls.map(([path]) => path)).toEqual(['/proc/4121/cmdline', '/proc/4122/cmdline', '/proc/4123/cmdline']);
  });

  it('Windows: queries Win32_Process filtered to the asked pids, embedding only integers', () => {
    const script = commandLineScript([4121, 4, process.pid, Number.NaN, '1;calc' as unknown as number, 4133]);
    expect(script).toContain("-Filter 'ProcessId = 4121 OR ProcessId = 4133'");
    expect(script).not.toMatch(/calc|NaN|ProcessId = 4\b/);
    expect(script).toContain('ToBase64String');
  });

  it('Windows: runs System32 PowerShell, hidden and bounded, and decodes only asked rows', async () => {
    const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
    // A command line holding a newline and a fake row stays inside its own base64 row.
    const tricky = 'node server.js\n4133 forged';
    const { run, calls } = recordingRunner(
      `4121 ${b64(tricky)}\r\n4133 ${b64('esbuild --watch')}\r\n9999 ${b64('not asked')}\r\n4140 \r\n`,
    );
    const lines = await readCommandLines([4121, 4133, 4140], { platform: 'win32', env, run });
    expect(lines).toEqual(new Map([[4121, tricky], [4133, 'esbuild --watch']]));
    const [file, , options] = calls[0]!;
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(options).toEqual({ maxBuffer: 16 * 1024 * 1024, timeoutMs: 5_000, hide: true });
  });

  it('macOS and other systems: one bounded ps for the asked pids', async () => {
    const { run, calls } = recordingRunner('  4121 node server.js\n 4133 esbuild --watch\n  777 not asked\n');
    const lines = await readCommandLines([4121, 4133], { platform: 'darwin', run });
    expect(lines).toEqual(new Map([[4121, 'node server.js'], [4133, 'esbuild --watch']]));
    expect(calls).toEqual([['ps', ['-ww', '-o', 'pid=,command=', '-p', '4121,4133'], { maxBuffer: 16 * 1024 * 1024, timeoutMs: 5_000 }]]);
  });

  it(`asks about at most ${COMMAND_LINES_MAX} pids, and nothing for none`, async () => {
    const { run, calls } = recordingRunner('');
    await readCommandLines(Array.from({ length: 250 }, (_, index) => 5000 + index), { platform: 'darwin', run });
    expect(calls[0]![1][4]!.split(',')).toHaveLength(COMMAND_LINES_MAX);
    expect(await readCommandLines([], { platform: 'darwin', run })).toEqual(new Map());
    expect(await readCommandLines([1, 0, -5], { platform: 'darwin', run })).toEqual(new Map());
    expect(calls).toHaveLength(1);
  });

  it('a failing reader whose output holds a token leaves no trace (SEC-5)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    execHook.reply = {
      error: Object.assign(new Error(`Command failed: GITHUB_TOKEN=${TOKEN}`), { stdout: `4121 GITHUB_TOKEN=${TOKEN}` }),
      stdout: `4121 GITHUB_TOKEN=${TOKEN}`,
    };
    const lines = await readCommandLines([4121], { platform: 'darwin' });
    expect(lines).toEqual(new Map());
    const throwing: TableRunner = async () => {
      throw new Error(`GITHUB_TOKEN=${TOKEN}`);
    };
    await expect(readCommandLines([4121], { platform: 'win32', env, run: throwing })).resolves.toEqual(new Map());
    expect(await readCommandLines([4121], { platform: 'win32', env: {}, run: recordingRunner('4121 x').run })).toEqual(new Map());
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('nameAndKillIdentified (#963)', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

  it('builds ONE script: the name query inside a try, then the identity kill loop', () => {
    const script = nameAndKillScript([{ pid: 4121, startedAt: 1_000 }], [4121, Number.NaN, 4]);
    expect(script).toContain("-Filter 'ProcessId = 4121'");
    expect(script).toContain('"name $($_.ProcessId) ');
    expect(script.indexOf('try {')).toBeLessThan(script.indexOf('Get-CimInstance'));
    expect(script.indexOf('Get-CimInstance')).toBeLessThan(script.indexOf('$t = @(4121,1000)'));
    expect(script).not.toMatch(/NaN|ProcessId = 4\b/);
    // Nothing to name: no query at all.
    expect(nameAndKillScript([{ pid: 4121, startedAt: 1_000 }], [])).not.toContain('Get-CimInstance');
  });

  it('starts one hidden System32 PowerShell, and reads names and outcomes apart', async () => {
    // A command line that decodes to a kill outcome stays a name.
    const { run, calls } = recordingRunner(
      `name 4121 ${b64('node dev.js')}\r\nname 4133 ${b64('4121 gone')}\r\n4121 killed\r\n4133 mismatch\r\n9999 killed\r\n`,
    );
    const result = await nameAndKillIdentified(
      [{ pid: 4121, startedAt: 1 }, { pid: 4133, startedAt: 2 }],
      [4121, 4133],
      { platform: 'win32', env, run },
    );
    expect(result.commands).toEqual(new Map([[4121, 'node dev.js'], [4133, '4121 gone']]));
    expect(result.outcomes).toEqual(new Map([[4121, 'killed'], [4133, 'mismatch']]));
    expect(calls).toHaveLength(1);
    const [file, , options] = calls[0]!;
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(options).toEqual({ maxBuffer: 16 * 1024 * 1024, timeoutMs: 10_000, hide: true });
  });

  it('answers null outcomes when PowerShell fails, and starts nothing off Windows or for no target', async () => {
    const failed = recordingRunner(null);
    expect(await nameAndKillIdentified([{ pid: 4121, startedAt: 1 }], [4121], { platform: 'win32', env, run: failed.run })).toEqual({
      commands: new Map(),
      outcomes: null,
    });
    const idle = recordingRunner('');
    expect((await nameAndKillIdentified([{ pid: 4121, startedAt: 1 }], [4121], { platform: 'linux', run: idle.run })).outcomes).toBeNull();
    expect((await nameAndKillIdentified([], [4121], { platform: 'win32', env, run: idle.run })).outcomes).toEqual(new Map());
    expect(idle.calls).toHaveLength(0);
  });
});
