import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LONG_PATH_PROBE_TIMEOUT_MS,
  LONG_PATHS_FIX,
  defaultProbeRunner,
  isPathTooLong,
  longPathNoticeText,
  parseGitLongPaths,
  parseLongPathsRegistry,
  probeLongPathNotice,
  regExePath,
  startLongPathNotice,
  withLongPathHint,
  type LongPathNoticeLine,
  type LongPathState,
  type ProbeOutcome,
  type ProbeRunner,
} from './long-paths.ts';

// reg.exe prints the hive's long name, whatever spelling the query used.
const KEY = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\FileSystem';
const regOutput = (lines: string[], eol = '\n'): string => ['', KEY, ...lines, ''].join(eol);

function recordingRunner(answers: Record<string, ProbeOutcome>): { run: ProbeRunner; calls: Array<[string, readonly string[], number]> } {
  const calls: Array<[string, readonly string[], number]> = [];
  const run: ProbeRunner = async (file, args, timeoutMs) => {
    calls.push([file, args, timeoutMs]);
    return answers[file.endsWith('reg.exe') ? 'reg' : file] ?? { exitCode: null, stdout: '' };
  };
  return { run, calls };
}

describe('probeLongPathNotice', () => {
  it.each(['linux', 'darwin'] as const)('answers null on %s without starting anything', async (platform) => {
    const { run, calls } = recordingRunner({});
    expect(await probeLongPathNotice('/repo', { platform, run })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('runs reg.exe and git with the exact arguments and timeout', async () => {
    const { run, calls } = recordingRunner({
      reg: { exitCode: 0, stdout: regOutput(['    LongPathsEnabled    REG_DWORD    0x0']) },
      git: { exitCode: 1, stdout: '' },
    });
    const notice = await probeLongPathNotice('C:\\repo', { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run });
    expect(calls).toEqual([
      ['C:\\Windows\\System32\\reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem'], LONG_PATH_PROBE_TIMEOUT_MS],
      ['git', ['-C', 'C:\\repo', 'config', '--type=bool', '--get', 'core.longpaths'], LONG_PATH_PROBE_TIMEOUT_MS],
    ]);
    expect(notice).toEqual({ message: longPathNoticeText('off', 'off'), windows: 'off', git: 'off' });
  });

  it('skips reg.exe when SystemRoot is not a drive path, and is silent when nothing is known to be off', async () => {
    const { run, calls } = recordingRunner({ git: { exitCode: 0, stdout: 'true\n' } });
    expect(await probeLongPathNotice('C:\\repo', { platform: 'win32', env: {}, run })).toBeNull();
    expect(calls.map(([file]) => file)).toEqual(['git']);
  });

  // The real reg.exe and git on a Windows machine, through the production runner: whatever the
  // settings are, both must be READ (never "unknown"), which pins the runner and the header and
  // value parsing against the real output shape.
  // win32-skip(#976): the long-path settings are read from the Windows registry and Git, on Windows only
  it.runIf(process.platform === 'win32')('reads both real settings on Windows', async () => {
    const outcomes: Record<string, ProbeOutcome> = {};
    const run: ProbeRunner = async (file, args, timeoutMs) => {
      const outcome = await defaultProbeRunner(file, args, timeoutMs);
      outcomes[file.endsWith('reg.exe') ? 'reg' : 'git'] = outcome;
      return outcome;
    };
    await probeLongPathNotice(process.cwd(), { run });
    expect(parseLongPathsRegistry(outcomes.reg!)).not.toBe('unknown');
    expect(parseGitLongPaths(outcomes.git!)).not.toBe('unknown');
  });

  it('never rejects, even when the runner does', async () => {
    const run: ProbeRunner = async () => { throw new Error('boom'); };
    expect(await probeLongPathNotice('C:\\repo', { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run })).toBeNull();
  });
});

describe('parseLongPathsRegistry', () => {
  it('reads on, off and absent', () => {
    expect(parseLongPathsRegistry({ exitCode: 0, stdout: regOutput(['    LongPathsEnabled    REG_DWORD    0x1']) })).toBe('on');
    expect(parseLongPathsRegistry({ exitCode: 0, stdout: regOutput(['    LongPathsEnabled    REG_DWORD    0x0']) })).toBe('off');
    expect(parseLongPathsRegistry({ exitCode: 0, stdout: regOutput(['    NtfsDisable8dot3NameCreation    REG_DWORD    0x2']) })).toBe('off');
    expect(parseLongPathsRegistry({ exitCode: 0, stdout: regOutput([]) })).toBe('off');
  });
  it('accepts CRLF output', () => {
    expect(parseLongPathsRegistry({ exitCode: 0, stdout: regOutput(['    LongPathsEnabled    REG_DWORD    0x1'], '\r\n') })).toBe('on');
  });
  it('answers unknown for a failed, unfinished or unexpected run', () => {
    expect(parseLongPathsRegistry({ exitCode: 1, stdout: '' })).toBe('unknown');
    expect(parseLongPathsRegistry({ exitCode: null, stdout: '' })).toBe('unknown');
    expect(parseLongPathsRegistry({ exitCode: 0, stdout: 'garbage' })).toBe('unknown');
  });
});

describe('regExePath', () => {
  it('builds the System32 path from a drive-rooted SystemRoot', () => {
    expect(regExePath({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\reg.exe');
    expect(regExePath({ SYSTEMROOT: 'D:/Win' })).toBe('D:\\Win\\System32\\reg.exe');
  });
  it.each([undefined, '', 'Windows', '\\\\srv\\s', '\\\\?\\C:\\Windows', '\\Windows'])('refuses %j', (root) => {
    expect(regExePath(root === undefined ? {} : { SystemRoot: root })).toBeNull();
  });
});

describe('parseGitLongPaths', () => {
  it.each<[ProbeOutcome, LongPathState]>([
    [{ exitCode: 0, stdout: 'true\n' }, 'on'],
    [{ exitCode: 0, stdout: 'false\n' }, 'off'],
    [{ exitCode: 1, stdout: '' }, 'off'],
    [{ exitCode: 128, stdout: '' }, 'unknown'],
    [{ exitCode: null, stdout: '' }, 'unknown'],
    [{ exitCode: 0, stdout: 'maybe' }, 'unknown'],
  ])('%j → %s', (outcome, state) => {
    expect(parseGitLongPaths(outcome)).toBe(state);
  });
});

describe('longPathNoticeText', () => {
  const states: LongPathState[] = ['on', 'off', 'unknown'];
  it('speaks only when a setting is known to be off', () => {
    for (const windows of states) {
      for (const git of states) {
        const text = longPathNoticeText(windows, git);
        if (windows !== 'off' && git !== 'off') expect(text, `${windows}/${git}`).toBeNull();
        else expect(text, `${windows}/${git}`).toMatch(/^Long file paths are off /);
      }
    }
  });
  it('names the fix for whichever setting is off', () => {
    expect(longPathNoticeText('off', 'off')).toContain(LONG_PATHS_FIX);
    expect(longPathNoticeText('off', 'off')).toContain('on this computer');
    expect(longPathNoticeText('off', 'on')).toContain('off in Windows');
    expect(longPathNoticeText('off', 'on')).toContain('LongPathsEnabled');
    expect(longPathNoticeText('off', 'on')).not.toContain('core.longpaths');
    expect(longPathNoticeText('on', 'off')).toContain('off in Git');
    expect(longPathNoticeText('unknown', 'off')).toContain('Run "git config --global core.longpaths true".');
    expect(longPathNoticeText('on', 'off')).not.toContain('LongPathsEnabled');
  });
});

describe('withLongPathHint', () => {
  const GIT_DETAIL = "fatal: cannot create 'x': Filename too long";
  const NODE_DETAIL = 'ENAMETOOLONG: name too long, open x';

  it('recognises both spellings of "too long"', () => {
    expect(isPathTooLong(GIT_DETAIL)).toBe(true);
    expect(isPathTooLong(NODE_DETAIL)).toBe(true);
    expect(isPathTooLong('fatal: invalid reference: main')).toBe(false);
  });
  it("appends the long-path fix to Git's \"Filename too long\" on win32, saying the setting MAY be off", () => {
    expect(withLongPathHint(GIT_DETAIL, 'win32')).toBe(
      `${GIT_DETAIL}. This path is too long for Windows; long file paths may be off. ${LONG_PATHS_FIX}`,
    );
    // Both names in one detail: Git's failure decides.
    expect(withLongPathHint(`${GIT_DETAIL} (ENAMETOOLONG)`, 'win32')).toContain(LONG_PATHS_FIX);
  });
  it('never claims the long-path settings fix a bare ENAMETOOLONG', () => {
    const hinted = withLongPathHint(NODE_DETAIL, 'win32');
    expect(hinted).toBe(`${NODE_DETAIL}. This path, or a name in it, is too long for Windows; a shorter folder or file name avoids it.`);
    expect(hinted).not.toContain('LongPathsEnabled');
    expect(hinted).not.toContain('core.longpaths');
  });
  it('leaves every other detail, and every POSIX detail, unchanged', () => {
    expect(withLongPathHint('fatal: invalid reference: main', 'win32')).toBe('fatal: invalid reference: main');
    expect(withLongPathHint('fatal: Filename too long', 'linux')).toBe('fatal: Filename too long');
    expect(withLongPathHint('ENAMETOOLONG', 'darwin')).toBe('ENAMETOOLONG');
  });
});

// Every OS: the production runner against a real child process (node itself), so its exit-code,
// output and "did not finish" mapping is pinned where CI runs, not only on Windows.
describe('defaultProbeRunner', () => {
  it('answers the exit code and the output of a program that ran', async () => {
    expect(await defaultProbeRunner(process.execPath, ['-e', "process.stdout.write('ok')"], 10_000)).toEqual({ exitCode: 0, stdout: 'ok' });
    expect(await defaultProbeRunner(process.execPath, ['-e', "process.stdout.write('no'); process.exit(3)"], 10_000)).toEqual({
      exitCode: 3,
      stdout: 'no',
    });
  });
  it('answers null for a program that is not there or does not finish in time', async () => {
    expect((await defaultProbeRunner('xez-no-such-program-963', [], 10_000)).exitCode).toBeNull();
    expect((await defaultProbeRunner(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], 200)).exitCode).toBeNull();
  });
});

describe('startLongPathNotice – the `xezar serve` start-up line', () => {
  const offRunner = (): ReturnType<typeof recordingRunner> =>
    recordingRunner({
      reg: { exitCode: 0, stdout: regOutput(['    LongPathsEnabled    REG_DWORD    0x0']) },
      git: { exitCode: 1, stdout: '' },
    });
  const onWindows = (run: ProbeRunner) => ({ platform: 'win32' as const, env: { SystemRoot: 'C:\\Windows' }, run });
  /** A few turns of the event loop: long enough for a started probe to finish and report. */
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolvePromise) => setImmediate(resolvePromise));
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports one windows.longpaths line on win32 when a setting is off – after it has returned', async () => {
    const { run, calls } = offRunner();
    const lines: LongPathNoticeLine[] = [];
    startLongPathNotice('C:\\repo', (line) => lines.push(line), onWindows(run));
    expect(calls).toEqual([]); // nothing has started yet: the probe waits for the next event-loop turn
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    expect(lines).toEqual([
      {
        level: 'warn',
        subject: 'windows',
        message: longPathNoticeText('off', 'off'),
        event: 'windows.longpaths',
        fields: [['windows', 'off'], ['git', 'off']],
      },
    ]);
  });

  it('reports nothing on win32 when nothing is known to be off', async () => {
    const { run, calls } = recordingRunner({
      reg: { exitCode: 0, stdout: regOutput(['    LongPathsEnabled    REG_DWORD    0x1']) },
      git: { exitCode: 0, stdout: 'true\n' },
    });
    const report = vi.fn();
    startLongPathNotice('C:\\repo', report, onWindows(run));
    await settle();
    expect(calls).toHaveLength(2);
    expect(report).not.toHaveBeenCalled();
  });

  it.each(['linux', 'darwin'] as const)('schedules nothing and starts nothing on %s', async (platform) => {
    const immediate = vi.spyOn(globalThis, 'setImmediate');
    const { run, calls } = offRunner();
    const report = vi.fn();
    startLongPathNotice('/repo', report, { platform, run });
    expect(immediate).not.toHaveBeenCalled();
    immediate.mockRestore();
    await settle();
    expect(calls).toEqual([]);
    expect(report).not.toHaveBeenCalled();
  });

  it('swallows a report that throws, so no unhandled rejection escapes', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { run } = offRunner();
      const report = vi.fn(() => {
        throw new Error('the terminal is gone');
      });
      startLongPathNotice('C:\\repo', report, onWindows(run));
      await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // The wiring the tests above cannot reach: `serveCommand` in src/index.ts (importing it runs the CLI).
  it('is started once by xezar serve, which logs the line unless it is stopping', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source.match(/\bstartLongPathNotice\(/g)).toHaveLength(1);
    expect(source).toMatch(
      /startLongPathNotice\(repoRoot, \(line\) => \{\s*if \(!stopping\) terminal\.log\(activityEntry\(line\)\);\s*\}\);/,
    );
  });
});
