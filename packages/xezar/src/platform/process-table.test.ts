import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withPlatform } from '../../test/helpers/platform.ts';
import { aggregateTreeUsage, parsePsOutput } from '../core/process-usage.ts';
import {
  SPAWN_CLOCK_SLACK_MS,
  STOP_CLOCK_SLACK_MS,
  defaultTableRunner,
  descendantPids,
  descendantTargets,
  fileTimeToMs,
  killIdentified,
  killScript,
  lstartToMs,
  parseDarwinRows,
  parseProcessRows,
  parseWindowsTable,
  readProcessTable,
  signalPid,
  startTimeOf,
  systemPidFloor,
  type ProcRow,
  type TableRunner,
} from './process-table.ts';

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

const { execFile } = await import('node:child_process');

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(execFile).mockClear();
  execHook.reply = { error: null, stdout: '' };
});

/** 2024-01-01T00:00:00Z as a Windows FILETIME. */
const JAN_1_2024_FILETIME = '133485408000000000';
const JAN_1_2024_MS = Date.UTC(2024, 0, 1);

function decodedScript(args: readonly string[]): string {
  expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  return Buffer.from(args[3]!, 'base64').toString('utf16le');
}

function recordingRunner(reply: string | null): { run: TableRunner; calls: Array<Parameters<TableRunner>> } {
  const calls: Array<Parameters<TableRunner>> = [];
  const run: TableRunner = async (...call) => {
    calls.push(call);
    return reply;
  };
  return { run, calls };
}

/** `Tue Sep 29 20:31:05 2026` as macOS `ps` prints it, and that moment in this machine's time zone. */
const LSTART_TOKENS = 'Tue Sep 29 20:31:05 2026';
const LSTART_MS = new Date(2026, 8, 29, 20, 31, 5).getTime();

describe('parsing', () => {
  const PS = '  101     1  2048  1.5\n  102   101  1024  0.0\nbroken\n  x   1 2 3\n  103   102   -5  nan\n';

  it("parses ps output exactly as the sampler's parser does", () => {
    expect(parseProcessRows(PS)).toEqual(parsePsOutput(PS));
  });

  it('reads a fifth FILETIME column as startedAt, and "-" as unknown', () => {
    expect(parseProcessRows(`7 4 100 0 ${JAN_1_2024_FILETIME}\r\n8 7 50 0 -\r\n`)).toEqual([
      { pid: 7, ppid: 4, rssKb: 100, cpuPct: 0, startedAt: JAN_1_2024_MS },
      { pid: 8, ppid: 7, rssKb: 50, cpuPct: 0 },
    ]);
  });

  it('converts a FILETIME to whole ms since the epoch, and refuses anything else', () => {
    expect(fileTimeToMs(JAN_1_2024_FILETIME)).toBe(JAN_1_2024_MS);
    expect(fileTimeToMs('133485408000009999')).toBe(JAN_1_2024_MS); // 0.9999 ms rounds down
    for (const bad of [undefined, '', '-', '1e17', '12.5', '116444736000000000', '1'.repeat(21)]) {
      expect(fileTimeToMs(bad)).toBeUndefined();
    }
  });

  it('reads macOS lstart as local time to the second, and refuses anything else', () => {
    expect(lstartToMs(LSTART_TOKENS.split(' '))).toBe(LSTART_MS);
    expect(lstartToMs('Mon Jan  1 00:00:00 2024'.split(/\s+/))).toBe(new Date(2024, 0, 1).getTime());
    const bad = ['', 'Tue Sep 29 20:31:05', 'Tue Foo 29 20:31:05 2026', 'Tue Sep 29 20:31 2026', 'Tue Sep x 20:31:05 2026', 'Tue Sep 29 20:31:05 26'];
    for (const text of bad) expect(lstartToMs(text.split(' ')), text).toBeUndefined();
  });

  it("parses macOS rows' first four columns exactly as the sampler's parser does", () => {
    const text = `  101     1  2048  1.5 ${LSTART_TOKENS}\n  102   101  1024  0.0\nbroken\n  x   1 2 3 ${LSTART_TOKENS}\n  103   102   -5  nan ${LSTART_TOKENS}\n`;
    const rows = parseDarwinRows(text);
    expect(rows.map(({ startedAt: _startedAt, ...row }) => row)).toEqual(parsePsOutput(text));
    expect(rows.map((row) => row.startedAt)).toEqual([LSTART_MS, undefined, LSTART_MS]);
  });

  it("takes queriedAt from the script's own first line, else the fallback", () => {
    expect(parseWindowsTable(`queried ${JAN_1_2024_FILETIME}\r\n9 4 1 0 -\r\n`, 5)).toEqual({
      rows: [{ pid: 9, ppid: 4, rssKb: 1, cpuPct: 0 }],
      queriedAt: JAN_1_2024_MS,
    });
    expect(parseWindowsTable('9 4 1 0 -\r\n', 5).queriedAt).toBe(5);
  });
});

describe('readProcessTable', () => {
  it.each(['linux', 'freebsd'] as const)('runs the unchanged ps command on %s', async (platform) => {
    const { run, calls } = recordingRunner('  1 0 10 0.5\n');
    const table = await readProcessTable({}, { platform, run });
    expect(calls).toEqual([['ps', ['-axo', 'pid=,ppid=,rss=,%cpu='], { maxBuffer: 16 * 1024 * 1024 }]]);
    expect(table?.rows).toEqual([{ pid: 1, ppid: 0, rssKb: 10, cpuPct: 0.5 }]);
    expect(typeof table?.queriedAt).toBe('number');
  });

  it('adds the start time on macOS, in the C locale, and dates the query to the second (#943)', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 29, 12, 0, 5, 750), toFake: ['Date'] });
    try {
      const { run, calls } = recordingRunner(`  7 1 10 0.5 ${LSTART_TOKENS}\n  8 7 20 0.0 garbled\n`);
      const env = { LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE' };
      const table = await readProcessTable({ timeoutMs: 5_000 }, { platform: 'darwin', env, run });
      expect(calls).toEqual([
        [
          'ps',
          ['-axo', 'pid=,ppid=,rss=,%cpu=,lstart='],
          { maxBuffer: 16 * 1024 * 1024, timeoutMs: 5_000, env: { LANG: 'de_DE.UTF-8', LC_ALL: 'C' } },
        ],
      ]);
      expect(table).toEqual({
        rows: [
          { pid: 7, ppid: 1, rssKb: 10, cpuPct: 0.5, startedAt: LSTART_MS },
          { pid: 8, ppid: 7, rssKb: 20, cpuPct: 0 },
        ],
        queriedAt: Date.UTC(2026, 8, 29, 12, 0, 5),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs System32 PowerShell on win32, hidden, with the start-time column', async () => {
    const { run, calls } = recordingRunner(`queried ${JAN_1_2024_FILETIME}\r\n12 4 300 0 ${JAN_1_2024_FILETIME}\r\n`);
    const table = await readProcessTable({ timeoutMs: 5_000 }, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run });
    const [file, args, options] = calls[0]!;
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(options).toEqual({ maxBuffer: 16 * 1024 * 1024, timeoutMs: 5_000, hide: true });
    const script = decodedScript(args);
    expect(script).toContain('Get-CimInstance Win32_Process');
    expect(script).toContain('CreationDate.ToFileTimeUtc()');
    expect(script.indexOf('queried')).toBeLessThan(script.indexOf('Get-CimInstance'));
    expect(table).toEqual({ rows: [{ pid: 12, ppid: 4, rssKb: 300, cpuPct: 0, startedAt: JAN_1_2024_MS }], queriedAt: JAN_1_2024_MS });
  });

  // ARCH-6 / SEC-963-05: before #963 the sampler ran a bare `powershell`, which Node looks up on
  // PATH – relative entries included. Without a usable SystemRoot it still searches PATH, but
  // only fully-qualified entries, and hands Node the file it found, never a name. The file system
  // is the `exists` seam and every entry a Windows spelling, so this runs the same on every OS
  // (a host temp folder is `/tmp/...` on Linux, which is no Windows path at all – T-01).
  it('without a drive SystemRoot, runs the first powershell.exe on a fully-qualified PATH entry', async () => {
    const asked: string[] = [];
    const exists = (path: string): boolean => {
      asked.push(path);
      return path === 'D:\\tools\\powershell.exe' || path === 'E:\\later\\powershell.exe';
    };
    const { run, calls } = recordingRunner('queried 0\r\n');
    await readProcessTable({}, { platform: 'win32', env: { PATH: '.;bin;D:\\tools;E:\\later' }, run, exists });
    expect(calls.map(([file]) => file)).toEqual(['D:\\tools\\powershell.exe']);
    expect(asked).toEqual(['D:\\tools\\powershell.exe']);
  });

  it('without a drive SystemRoot, never runs a PowerShell only a relative PATH entry offers', async () => {
    const { run, calls } = recordingRunner('queried 0\r\n');
    const exists = (): boolean => true;
    expect(await readProcessTable({}, { platform: 'win32', env: { PATH: '.;bin' }, run, exists })).toBeNull();
    expect(await readProcessTable({}, { platform: 'win32', env: {}, run, exists })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('answers null for a failed read and never rejects', async () => {
    expect(await readProcessTable({}, { platform: 'linux', run: recordingRunner(null).run })).toBeNull();
    const throwing: TableRunner = async () => {
      throw new Error('boom');
    };
    expect(await readProcessTable({}, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run: throwing })).toBeNull();
  });
});

describe('defaultTableRunner', () => {
  // Linux and macOS call `execFile` on this thread; Windows moves the same call to a worker thread
  // (process-table.windows.test.ts), so these pin the POSIX branch on every host.
  it('passes only the options it was given and answers stdout', () => withPlatform('linux', async () => {
    execHook.reply = { error: null, stdout: 'rows' };
    expect(await defaultTableRunner('ps', ['-a'], { maxBuffer: 10 })).toBe('rows');
    expect(vi.mocked(execFile).mock.calls[0]!.slice(0, 3)).toEqual(['ps', ['-a'], { maxBuffer: 10 }]);
    await defaultTableRunner('ps', [], { maxBuffer: 10, timeoutMs: 3, hide: true });
    expect(vi.mocked(execFile).mock.calls[1]![2]).toEqual({ maxBuffer: 10, timeout: 3, windowsHide: true });
    await defaultTableRunner('ps', [], { maxBuffer: 10, env: { LC_ALL: 'C' } });
    expect(vi.mocked(execFile).mock.calls[2]![2]).toEqual({ maxBuffer: 10, env: { LC_ALL: 'C' } });
  }));

  it('drops the error object, and the output it carries (SEC-5)', () => withPlatform('linux', async () => {
    execHook.reply = { error: Object.assign(new Error('failed'), { stdout: 'GITHUB_TOKEN=ghp_secret' }), stdout: 'GITHUB_TOKEN=ghp_secret' };
    expect(await defaultTableRunner('ps', [], { maxBuffer: 10 })).toBeNull();
  }));
});

describe('descendantPids', () => {
  const plain: ProcRow[] = [
    { pid: 10, ppid: 1, rssKb: 1, cpuPct: 0 },
    { pid: 11, ppid: 10, rssKb: 1, cpuPct: 0 },
    { pid: 12, ppid: 10, rssKb: 1, cpuPct: 0 },
    { pid: 13, ppid: 11, rssKb: 1, cpuPct: 0 },
    { pid: 14, ppid: 99, rssKb: 1, cpuPct: 0 },
    // a torn snapshot: 10's pid shows up again as its own grandchild
    { pid: 10, ppid: 13, rssKb: 1, cpuPct: 0 },
  ];

  it("walks the sampler's way without start times, in the sampler's order", () => {
    expect(descendantPids(plain, { pid: 10 })).toEqual([12, 11, 13]);
    expect(descendantPids(plain, { pid: 77 })).toEqual([]);
  });

  it('adds up to what aggregateTreeUsage counts', () => {
    const usage = aggregateTreeUsage(plain, 10);
    expect(usage?.procCount).toBe(1 + descendantPids(plain, { pid: 10 }).length);
  });

  const spawnedAt = 1_000_000;
  const stoppedAt = 2_000_000;
  const row = (pid: number, ppid: number, startedAt?: number): ProcRow => ({
    pid,
    ppid,
    rssKb: 0,
    cpuPct: 0,
    ...(startedAt !== undefined ? { startedAt } : {}),
  });

  it('counts a direct child only when it started between spawnedAt − 1 s and stoppedAt + the clock slack', () => {
    const rows = [
      row(21, 20, spawnedAt - SPAWN_CLOCK_SLACK_MS),
      row(22, 20, stoppedAt + STOP_CLOCK_SLACK_MS),
      row(23, 20, spawnedAt - SPAWN_CLOCK_SLACK_MS - 1), // older than the root: an unrelated process
      row(24, 20, stoppedAt + STOP_CLOCK_SLACK_MS + 1), // created after the stop: the pid was reused
      row(25, 20), // unknown start
    ];
    expect(descendantPids(rows, { pid: 20, spawnedAt, stoppedAt }).sort()).toEqual([21, 22]);
  });

  // Q-03: the kernel dates a process with its own clock and `stoppedAt` is Date.now(); Windows can
  // put the two one 15.6 ms clock tick apart, and a grandchild started ~10 ms before a stop was
  // measured dated after it – the stop then found no descendant and left it running.
  it('still counts a direct child dated one clock tick after the stop', () => {
    const rows = [row(41, 40, stoppedAt + 16), row(42, 41, stoppedAt + 20)];
    expect(descendantTargets(rows, { pid: 40, spawnedAt, stoppedAt })).toEqual(
      expect.arrayContaining([
        { pid: 41, startedAt: stoppedAt + 16 },
        { pid: 42, startedAt: stoppedAt + 20 },
      ]),
    );
  });

  it('counts a deeper row only when it started no earlier than its counted parent', () => {
    const rows = [
      row(31, 30, spawnedAt + 10),
      row(32, 31, spawnedAt + 10),
      row(33, 31, spawnedAt + 9), // older than its parent: a stale parent pid
      row(34, 32, stoppedAt + 50_000), // grandchildren may start after the root's stop
      row(35, 33, spawnedAt + 20), // under an excluded row
      row(36, 31), // unknown start
    ];
    expect(descendantPids(rows, { pid: 30, spawnedAt, stoppedAt }).sort()).toEqual([31, 32, 34]);
    expect(descendantTargets(rows, { pid: 30, spawnedAt, stoppedAt })).toEqual(
      expect.arrayContaining([
        { pid: 31, startedAt: spawnedAt + 10 },
        { pid: 32, startedAt: spawnedAt + 10 },
        { pid: 34, startedAt: stoppedAt + 50_000 },
      ]),
    );
  });
});

describe('systemPidFloor (ARCH-5)', () => {
  it('is init on POSIX and the System process on Windows', () => {
    for (const platform of ['linux', 'darwin'] as const) expect(systemPidFloor({ platform })).toBe(1);
    expect(systemPidFloor({ platform: 'win32' })).toBe(4);
  });
});

describe('killIdentified', () => {
  const env = { SystemRoot: 'C:\\Windows' };

  it('embeds only validated integers, each pid once', () => {
    const script = killScript([
      { pid: 1234, startedAt: 1_700_000_000_123 },
      { pid: Number.NaN, startedAt: 1 },
      { pid: 1.5, startedAt: 1 },
      { pid: -3, startedAt: 1 },
      { pid: 4, startedAt: 1 },
      { pid: process.pid, startedAt: 1 },
      { pid: 77, startedAt: Number.POSITIVE_INFINITY },
      { pid: 78, startedAt: 0 },
      { pid: 1234, startedAt: 5 },
      { pid: '1;calc' as unknown as number, startedAt: 1 },
    ]);
    expect(script).toContain('$t = @(1234,1700000000123)\n');
    expect(script).not.toMatch(/calc|NaN|Infinity/);
  });

  it('does nothing off Windows, and starts nothing for no targets', async () => {
    const { run, calls } = recordingRunner('');
    expect(await killIdentified([{ pid: 50, startedAt: 1 }], { platform: 'linux', run })).toBeNull();
    expect(await killIdentified([], { platform: 'win32', env, run })).toEqual(new Map());
    expect(await killIdentified([{ pid: 2, startedAt: 1 }], { platform: 'win32', env, run })).toEqual(new Map());
    expect(calls).toEqual([]);
  });

  it('runs System32 PowerShell, bounded and hidden, and reads one outcome per pid it asked about', async () => {
    const { run, calls } = recordingRunner('50 killed\r\n51 mismatch\r\n52 gone\r\n53 denied\r\n99 killed\r\nnoise\r\n');
    const targets = [50, 51, 52, 53].map((pid) => ({ pid, startedAt: 1_700_000_000_000 + pid }));
    const outcomes = await killIdentified(targets, { platform: 'win32', env, run });
    expect(outcomes).toEqual(new Map([[50, 'killed'], [51, 'mismatch'], [52, 'gone'], [53, 'denied']]));
    const [file, args, options] = calls[0]!;
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(options).toEqual({ maxBuffer: 1024 * 1024, timeoutMs: 5_000, hide: true });
    const script = decodedScript(args);
    expect(script).toContain('$t = @(50,1700000000050,51,1700000000051,52,1700000000052,53,1700000000053)');
    expect(script).toContain('$null = $p.Handle');
    expect(script).not.toMatch(/taskkill|Stop-Process|\/T\b/);
  });

  it('splits a long list into several runs', async () => {
    const { run, calls } = recordingRunner('');
    const targets = Array.from({ length: 450 }, (_, index) => ({ pid: 1000 + index, startedAt: 1 }));
    await killIdentified(targets, { platform: 'win32', env, run });
    expect(calls).toHaveLength(3);
  });

  it('answers null when nothing could run, and never rejects', async () => {
    const target = [{ pid: 50, startedAt: 1 }];
    expect(await killIdentified(target, { platform: 'win32', env, run: recordingRunner(null).run })).toBeNull();
    expect(await killIdentified(target, { platform: 'win32', env: {}, run: recordingRunner('50 killed').run })).toBeNull();
    const throwing: TableRunner = async () => {
      throw new Error('boom');
    };
    expect(await killIdentified(target, { platform: 'win32', env, run: throwing })).toBeNull();
  });
});

describe('signalPid', () => {
  it('sends to one process and names the outcome', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(signalPid(4321, 'SIGTERM')).toBe('sent');
    expect(kill).toHaveBeenCalledWith(4321, 'SIGTERM');
    kill.mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    expect(signalPid(4321, 'SIGKILL')).toBe('gone');
    kill.mockImplementation(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });
    expect(signalPid(4321, 'SIGKILL')).toBe('denied');
  });

  it('never signals a group, every process, init or itself', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    for (const pid of [0, 1, -1, -4321, process.pid, 1.5, Number.NaN]) expect(signalPid(pid, 'SIGKILL')).toBe('denied');
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('startTimeOf', () => {
  const STAT = '1234 (we) ird) S 1 1234 1234 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 987654 12345 67';

  it('reads field 22 after the last ")" on Linux', async () => {
    const readText = vi.fn(async () => STAT);
    expect(await startTimeOf(1234, { platform: 'linux', readText })).toBe(987654);
    expect(readText).toHaveBeenCalledWith('/proc/1234/stat');
  });

  it("macOS: one bounded ps -o lstart= in the C locale, equal to a table row's startedAt", async () => {
    const { run, calls } = recordingRunner(`${LSTART_TOKENS}\n`);
    expect(await startTimeOf(1234, { platform: 'darwin', env: { LC_ALL: 'fr_FR' }, run })).toBe(LSTART_MS);
    expect(calls).toEqual([['ps', ['-o', 'lstart=', '-p', '1234'], { maxBuffer: 64 * 1024, timeoutMs: 2_000, env: { LC_ALL: 'C' } }]]);
    expect(await startTimeOf(1234, { platform: 'darwin', run: recordingRunner(null).run })).toBeNull();
    expect(await startTimeOf(1234, { platform: 'darwin', run: recordingRunner('').run })).toBeNull();
    const throwing: TableRunner = async () => {
      throw new Error('boom');
    };
    expect(await startTimeOf(1234, { platform: 'darwin', run: throwing })).toBeNull();
    expect(await startTimeOf(0, { platform: 'darwin', run })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('answers null when unreadable, malformed, or off Linux and macOS', async () => {
    expect(await startTimeOf(1234, { platform: 'linux', readText: async () => { throw new Error('EACCES'); } })).toBeNull();
    expect(await startTimeOf(1234, { platform: 'linux', readText: async () => 'garbage' })).toBeNull();
    expect(await startTimeOf(1234, { platform: 'linux', readText: async () => '1 (x) S 1' })).toBeNull();
    expect(await startTimeOf(1234, { platform: 'freebsd', readText: async () => STAT })).toBeNull();
    expect(await startTimeOf(1234, { platform: 'win32', readText: async () => STAT })).toBeNull();
    expect(await startTimeOf(-1, { platform: 'linux', readText: async () => STAT })).toBeNull();
  });
});
