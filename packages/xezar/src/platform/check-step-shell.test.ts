import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onWindows, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { CheckShellMissingError, launchCheckStep } from './check-step-shell.ts';
import * as processLaunch from './process-launch.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('launchCheckStep on Linux and macOS (#963)', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    it(`is exactly launch('bash', ['-lc', command], options) on ${platform}`, () => {
      const fake = {} as ReturnType<typeof processLaunch.launch>;
      const launch = vi.spyOn(processLaunch, 'launch').mockReturnValue(fake);
      const msys = vi.spyOn(processLaunch, 'launchMsys');
      const options = { cwd: '/w', env: { PATH: '/usr/bin' } };
      expect(launchCheckStep('npm test', options, { platform })).toBe(fake);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0]?.[0]).toBe('bash');
      expect(launch.mock.calls[0]?.[1]).toEqual(['-lc', 'npm test']);
      expect(launch.mock.calls[0]?.[2]).toBe(options);
      expect(msys).not.toHaveBeenCalled();
    });
  }
});

describe('launchCheckStep without Git Bash (#963)', () => {
  it('starts nothing and names Git for Windows', () => {
    const launch = vi.spyOn(processLaunch, 'launch');
    const msys = vi.spyOn(processLaunch, 'launchMsys');
    const run = () => launchCheckStep('true', { env: { PATH: 'C:\\Windows\\System32' } }, { platform: 'win32', exists: () => false });
    expect(run).toThrow(CheckShellMissingError);
    expect(run).toThrow(/Git for Windows \(it includes Git Bash\)/);
    expect(launch).not.toHaveBeenCalled();
    expect(msys).not.toHaveBeenCalled();
  });
});

/**
 * The environment of a cockpit started from PowerShell on a stock install: PATH reaches Git only
 * through `Git\cmd`, so the first `bash.exe` on it is System32's (WSL's) or none. This test
 * process runs under Git Bash, whose PATH puts Git's own bash first and would hide the difference.
 */
function stockWindowsEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = (env[key] ?? '')
    .split(';')
    .filter((dir) => dir && !existsSync(join(dir, 'bash.exe')) || /system32$/i.test(dir))
    .join(';');
  return env;
}

/** Runs `command` as a check step and answers its exit code and output. */
function runStep(command: string, cwd: string): Promise<{ code: number | null; out: string }> {
  const child = launchCheckStep(command, { cwd, env: stockWindowsEnv() });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
}

// win32-skip(#976): Git Bash exists on Windows only; Linux and macOS are pinned above
describe.skipIf(!onWindows)('launchCheckStep in Git Bash on Windows (#963)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, TEST_DIR_RM_OPTIONS);
    dir = '';
  });

  it('passes quotes, backslashes, globs, braces, an empty word and spaces through unchanged', async () => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'xez-check-shell-')));
    const command = `printf '[%s]' "a \\"b\\" c" 'x\\y' '*' '{a,b}' '' 'two  spaces'; printf '[%s]' *`;
    const { code, out } = await runStep(command, dir);
    expect(code).toBe(0);
    // The last printf proves the shell globs (an empty folder leaves `*` as it is).
    expect(out).toBe('[a "b" c][x\\y][*][{a,b}][][two  spaces][*]');
  });

  it('runs in the working folder, in MINGW64, with node, npm and gh or git found, and a Windows temp folder', async () => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'xez-check-shell-')));
    const { code, out } = await runStep('cygpath -w "$PWD"; echo "$MSYSTEM"; command -v node npm git >/dev/null && echo found; cygpath -w "$TMP"', dir);
    expect(code).toBe(0);
    const [pwd, msystem, found, temp] = out.trim().split(/\r?\n/);
    expect(pwd?.toLowerCase()).toBe(dir.toLowerCase());
    expect(msystem).toBe('MINGW64');
    expect(found).toBe('found');
    // Not a login shell: TMP is still the Windows temp folder, not Git's own `/tmp`.
    expect(temp?.toLowerCase()).toBe(realpathSync.native(process.env.TMP ?? tmpdir()).toLowerCase());
  });

  it('is Git\'s own bash, not WSL\'s', async () => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'xez-check-shell-')));
    const { out } = await runStep('uname -s', dir);
    expect(out).toMatch(/^MINGW64_NT/);
    // The test machine's PATH may also reach System32's bash.exe; it was not used.
    expect(execFileSync('where', ['git'], { encoding: 'utf8' })).toMatch(/git\.exe/i);
  });
});
