import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onWindows, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { launchCheckStep } from './check-step-shell.ts';
import { gitRoot } from './git-bash.ts';
import { parseMsysTable } from './msys-process-tree.ts';
import { defaultTableRunner } from './process-table.ts';
import { stopChildTree } from './process-tree.ts';

/**
 * #963: stopping a check step stops what its Git Bash shell started, including the processes a
 * Windows parent-pid walk cannot reach – a program whose MSYS parent (`nohup`, a subshell) has
 * already exited. Real Git Bash, real processes.
 */

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const slash = (path: string): string => path.replace(/\\/g, '/');

/** A node that writes its own Windows pid to `file`, then waits forever. */
const sleeper = (file: string): string =>
  `"${slash(process.execPath)}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)" "${slash(file)}"`;

const readPid = (file: string): number | null =>
  existsSync(file) && readFileSync(file, 'utf8').length > 0 ? Number(readFileSync(file, 'utf8')) : null;

// win32-skip(#963): Git Bash process trees exist on Windows only
describe.skipIf(!onWindows)('stopping a check step stops what Git Bash started (#963)', () => {
  let dir = '';
  const started: number[] = [];
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'xez-msys-stop-')));
  });
  afterEach(() => {
    for (const pid of started.splice(0)) if (alive(pid)) process.kill(pid);
    rmSync(dir, TEST_DIR_RM_OPTIONS);
  });

  const cases: Array<[string, (a: string, b: string) => string]> = [
    ['a background child and a foreground one', (a, b) => `${sleeper(a)} & ${sleeper(b)}`],
    ['an exec in a background subshell', (a, b) => `(exec ${sleeper(a)}) & ${sleeper(b)}`],
    ['a nohup child whose MSYS parent exits, and an MSYS sleep', (a, b) => `nohup ${sleeper(a)} >/dev/null 2>&1 & ${sleeper(b)} & sleep 600`],
    ['a program the shell execs into', (a, b) => `${sleeper(b)} & exec ${sleeper(a)}`],
  ];
  for (const [name, command] of cases) {
    it(`stops ${name}, and leaves no process of the shell's group`, async () => {
      const [a, b, shell] = ['a.pid', 'b.pid', 'shell.pid'].map((file) => join(dir, file)) as [string, string, string];
      const child = launchCheckStep(`printf %s "$$" >'${slash(shell)}'; ${command(a, b)}`, { cwd: dir, env: process.env });
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await expect.poll(() => readPid(a) !== null && readPid(b) !== null && readPid(shell) !== null, { timeout: 15_000 }).toBe(true);
      const pids = [readPid(a)!, readPid(b)!];
      started.push(...pids);
      expect(pids.every(alive)).toBe(true);

      await stopChildTree(child, 'SIGTERM');
      await exited;
      await expect.poll(() => pids.filter(alive), { timeout: 5_000 }).toEqual([]);
      const ps = join(gitRoot()!, 'usr', 'bin', 'ps.exe');
      const rows = parseMsysTable((await defaultTableRunner(ps, [], { maxBuffer: 1024 * 1024, timeoutMs: 5_000, hide: true })) ?? '');
      expect(rows.filter((row) => row.pgid === readPid(shell))).toEqual([]);
    }, 40_000);
  }
});
