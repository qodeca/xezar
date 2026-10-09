import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onWindows, TEST_DIR_RM_OPTIONS } from '../../../test/helpers/platform.ts';
import { cmdShimText } from '../../platform/cmd-shim.testkit.ts';
import { __clearRepoHandleCacheForTests, resolveRepoHandle } from './github.ts';

/**
 * #963: a cancelled repo-handle lookup stops `gh` AND what it started, and settles only once they
 * are gone. The fake `gh` starts a child (as the real one starts git) and both hang, with their
 * working folder in the project – the shape that made Windows refuse to remove the folder.
 */
const FAKE_GH = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.env.XEZ_FAKE_GH_PIDS, JSON.stringify([process.pid, child.pid]));
setInterval(() => {}, 1000);
`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('resolveRepoHandle cancel (#963)', () => {
  const saved = { path: process.env.PATH, pathext: process.env.PATHEXT, pids: process.env.XEZ_FAKE_GH_PIDS };
  let bin = '';
  let project = '';
  let pidsFile = '';

  beforeEach(() => {
    __clearRepoHandleCacheForTests();
    bin = realpathSync.native(mkdtempSync(join(tmpdir(), 'xez-gh-cancel-bin-')));
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'xez-gh-cancel-project-')));
    pidsFile = join(bin, 'pids.json');
    writeFileSync(join(bin, 'gh.cjs'), FAKE_GH, 'utf8');
    if (onWindows) {
      writeFileSync(join(bin, 'gh.cmd'), cmdShimText({ target: 'gh.cjs', prog: 'node' }), 'utf8');
      // `vitest.setup.ts` limits the search to `.COM;.EXE`; this case looks up a shim.
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    } else {
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(bin, 'gh.cjs'))} "$@"\n`, 'utf8');
      chmodSync(join(bin, 'gh'), 0o755);
    }
    process.env.PATH = `${bin}${delimiter}${saved.path ?? ''}`;
    process.env.XEZ_FAKE_GH_PIDS = pidsFile;
  });

  afterEach(() => {
    for (const [key, value] of [['PATH', saved.path], ['PATHEXT', saved.pathext], ['XEZ_FAKE_GH_PIDS', saved.pids]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __clearRepoHandleCacheForTests();
    rmSync(bin, TEST_DIR_RM_OPTIONS);
    if (existsSync(project)) rmSync(project, TEST_DIR_RM_OPTIONS);
  });

  it('stops gh and its child, answers null, and leaves the project folder removable', async () => {
    const controller = new AbortController();
    const lookup = resolveRepoHandle(project, { signal: controller.signal });
    await expect.poll(() => existsSync(pidsFile), { timeout: 10_000 }).toBe(true);
    const pids = JSON.parse(readFileSync(pidsFile, 'utf8')) as number[];
    expect(pids.every(alive)).toBe(true);

    const abortedAt = Date.now();
    controller.abort();
    expect(await lookup).toBeNull();
    // Well before gh's own 15 s limit (a Windows stop reads the process table, which takes seconds).
    expect(Date.now() - abortedAt).toBeLessThan(10_000);

    // Settled only after both are gone: no poll needed.
    expect(pids.map(alive)).toEqual([false, false]);
    // Plain removal, no retry: nothing holds the folder any more.
    rmSync(project, { recursive: true });
    expect(existsSync(project)).toBe(false);
  }, 30_000);

  it('never starts gh for a lookup cancelled before it began', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await resolveRepoHandle(project, { signal: controller.signal })).toBeNull();
    expect(existsSync(pidsFile)).toBe(false);
  });
});
