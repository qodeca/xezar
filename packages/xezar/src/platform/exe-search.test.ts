import { spawnSync } from 'node:child_process';
import { copyFileSync, linkSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hardenChildExecutableSearch, hardenExecutableSearch } from './exe-search.ts';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';

const VARIABLE = 'NoDefaultCurrentDirectoryInExePath';

describe('hardenExecutableSearch', () => {
  it('changes nothing on POSIX', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const env: NodeJS.ProcessEnv = {};
      hardenExecutableSearch(env, platform);
      expect(env).toEqual({});
    }
  });

  it('turns the working-folder lookup off on win32', () => {
    const env: NodeJS.ProcessEnv = {};
    hardenExecutableSearch(env, 'win32');
    expect(env[VARIABLE]).toBe('1');
  });

  it('keeps a value that is already set', () => {
    const env: NodeJS.ProcessEnv = { [VARIABLE]: 'yes' };
    hardenExecutableSearch(env, 'win32');
    expect(env[VARIABLE]).toBe('yes');
  });

  describe('hardenChildExecutableSearch', () => {
    it('changes nothing on POSIX', () => {
      for (const platform of ['linux', 'darwin'] as const) {
        const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', NODEFAULTCURRENTDIRECTORYINEXEPATH: '0' };
        hardenChildExecutableSearch(env, platform);
        expect(env).toEqual({ PATH: '/usr/bin', NODEFAULTCURRENTDIRECTORYINEXEPATH: '0' });
      }
    });

    it('adds the variable to a child environment on win32', () => {
      const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows' };
      hardenChildExecutableSearch(env, 'win32');
      expect(env).toEqual({ Path: 'C:\\Windows', [VARIABLE]: '1' });
    });

    it('forces 1 under one spelling, whatever spelling and value were there', () => {
      const env: NodeJS.ProcessEnv = { nodefaultcurrentdirectoryinexepath: '', NODEFAULTCURRENTDIRECTORYINEXEPATH: '0' };
      hardenChildExecutableSearch(env, 'win32');
      expect(env).toEqual({ [VARIABLE]: '1' });
    });
  });

  // The whole protection depends on running before any module that can start a process.
  it("is src/index.ts's first import", () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const firstImport = source.split(/\r?\n/).find((line) => line.startsWith('import '));
    expect(firstImport).toBe("import './platform/exe-search.ts';");
  });
});

// Real Windows: a `git.exe` planted in the child's working folder. Before the fix it is the program
// that runs; after it, the real Git from PATH answers.
// win32-skip(#976): a program search through the working folder happens on Windows only
describe.runIf(process.platform === 'win32')('planted git.exe on Windows', () => {
  it('runs the PATH git, not the one in the working folder', () => {
    const folder = mkdtempSync(join(tmpdir(), 'xez-planted-git-'));
    const saved = process.env[VARIABLE];
    try {
      const planted = join(folder, 'git.exe');
      try {
        linkSync(process.execPath, planted);
      } catch {
        copyFileSync(process.execPath, planted);
      }
      delete process.env[VARIABLE];
      const exposed = spawnSync('git', ['--version'], { cwd: folder, encoding: 'utf8' });
      // The hole exists: node (planted as git.exe) printed its own version.
      expect(exposed.stdout.trim()).toBe(process.version);

      hardenExecutableSearch();
      const hardened = spawnSync('git', ['--version'], { cwd: folder, encoding: 'utf8' });
      expect(hardened.stdout.trim()).toMatch(/^git version /);
    } finally {
      if (saved === undefined) delete process.env[VARIABLE];
      else process.env[VARIABLE] = saved;
      rmSync(folder, TEST_DIR_RM_OPTIONS);
    }
  });
});
