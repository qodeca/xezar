import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { cmdPathSafe } from './batch-line.ts';
import { trackedChildren } from './child-registry.ts';
import { cmdShimText } from './cmd-shim.testkit.ts';
import { CommandRefusedError } from './command-resolve.ts';
import { envValue } from './path-search.ts';
import { launch, launchFileAsync } from './process-launch.ts';

/**
 * Starting real programs on Windows (#963 AC-2..AC-4): an npm shim runs its node target with every
 * argument intact and no cmd.exe in between, a script runs through node, a plain batch file runs
 * only with safe arguments, and a missing program still fails with ENOENT. The same rules run on
 * every OS against a fake disk in process-launch.test.ts and command-resolve.test.ts.
 */

/** Arguments cmd.exe would act on; through an unwrapped shim they must arrive byte for byte. The
 *  one that would run a command writes the marker file, so a cmd.exe in between is seen, not
 *  merely survived (T-09). */
function hostileArgs(): string[] {
  return ['plain', 'two words', `x" & echo pwned > "${marker}`, '%PATH%', '!x!', 'a|b', 'trailing\\', 'quote"inside', ''];
}

let dir = '';
let shim = '';
let script = '';
let batch = '';
let marker = '';

beforeAll(() => {
  // win32-skip(#976): the real Windows programs this suite starts exist on Windows only
  if (process.platform !== 'win32') return;
  dir = mkdtempSync(join(tmpdir(), 'xez-launch-'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'lib'));
  marker = join(dir, 'marker.txt');
  script = join(dir, 'lib', 'tool.mjs');
  writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  shim = join(dir, 'bin', 'tool.cmd');
  writeFileSync(shim, cmdShimText({ prog: 'node', target: '..\\lib\\tool.mjs' }));
  batch = join(dir, 'echo.bat');
  writeFileSync(batch, '@echo off\r\necho %*\r\n');
});

afterAll(() => {
  if (dir) rmSync(dir, TEST_DIR_RM_OPTIONS);
});

// win32-skip(#976): the real Windows programs this suite starts exist on Windows only
describe.runIf(process.platform === 'win32')('starting real programs on Windows', () => {
  it('runs an npm shim by path with every argument intact (AC-2)', async () => {
    const { stdout } = await launchFileAsync(shim, hostileArgs(), { encoding: 'utf8' });
    expect(JSON.parse(stdout)).toEqual(hostileArgs());
    expect(existsSync(marker)).toBe(false);
  });

  it('finds an npm shim by bare name on the PATH the child gets', async () => {
    // `{ ...process.env, PATH }` next to the inherited `Path`: Node keeps one spelling, and the
    // search must read that same one. PATHEXT is Windows' default here: the suite's own setup
    // leaves `.cmd` out of it so no case starts a developer's real agent CLI.
    const env = { ...process.env, PATH: join(dir, 'bin'), PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    const { stdout } = await launchFileAsync('tool', ['a b'], { encoding: 'utf8', env });
    expect(JSON.parse(stdout)).toEqual(['a b']);
  });

  it('reads the PATH spelling Node really hands the child', () => {
    for (const env of [
      { SystemRoot: process.env.SystemRoot, Path: 'C:\\from-Path', PATH: 'C:\\from-PATH' },
      { SystemRoot: process.env.SystemRoot, PATH: 'C:\\from-PATH', Path: 'C:\\from-Path' },
      { SystemRoot: process.env.SystemRoot, path: 'C:\\from-path', Path: 'C:\\from-Path' },
    ]) {
      const seen = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.PATH ?? "")'], { env, encoding: 'utf8' });
      expect(seen.stdout).toBe(envValue(env, 'PATH', { platform: 'win32' }));
    }
  });

  it('runs a .mjs through node instead of failing with EFTYPE (D4)', async () => {
    const payload = `x" & echo pwned > "${marker}`;
    const { stdout } = await launchFileAsync(script, [payload], { encoding: 'utf8' });
    expect(JSON.parse(stdout)).toEqual([payload]);
    expect(existsSync(marker)).toBe(false);
  });

  it('tracks the child it started until its exit', async () => {
    const child = launch(shim, [], { stdio: 'ignore' });
    expect(trackedChildren().some((tracked) => tracked.child === child)).toBe(true);
    await once(child, 'exit');
    expect(trackedChildren().some((tracked) => tracked.child === child)).toBe(false);
  });

  it('runs a plain batch file with safe arguments (AC-3)', async () => {
    // Fail, not skip: a temp folder cmd.exe cannot be given safely would hide both batch cases.
    expect(cmdPathSafe(batch), `temp folder not cmd-safe: ${batch}`).toBe(true);
    const { stdout } = await launchFileAsync(batch, ['--fast', 'src/a.ts', 'C:\\x\\y.txt'], { encoding: 'utf8' });
    expect(stdout.trim()).toBe('--fast src/a.ts C:\\x\\y.txt');
  });

  it('refuses a batch payload before cmd.exe ever runs (AC-3)', async () => {
    expect(cmdPathSafe(batch), `temp folder not cmd-safe: ${batch}`).toBe(true);
    for (const payload of [`x & echo pwned > ${marker}`, `x" & echo pwned > "${marker}`, '%COMSPEC%', 'x^& echo', 'C:\\dir\\']) {
      await expect(launchFileAsync(batch, [payload], { encoding: 'utf8' })).rejects.toBeInstanceOf(CommandRefusedError);
      expect(() => launch(batch, [payload], { stdio: 'ignore' })).toThrow(CommandRefusedError);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('still reports a missing program as ENOENT (AC-4)', async () => {
    await expect(launchFileAsync('xez-no-such-program-963', ['--version'], { encoding: 'utf8' })).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
