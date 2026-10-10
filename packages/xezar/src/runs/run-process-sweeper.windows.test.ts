import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onWindows, plainMsysEnv, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { gitRoot } from '../platform/git-bash.ts';
import { launch } from '../platform/process-launch.ts';
import { readProcessTable, type ProcessTable } from '../platform/process-table.ts';
import { stopChildTree } from '../platform/process-tree.ts';
import { RunProcessSweeper } from './run-process-sweeper.ts';

/**
 * #963, real processes: an agent whose Git Bash shell starts `nohup node … &` from a subshell
 * and exits between two sampler reads. The program's Windows parent (nohup.exe) and its parent
 * (the subshell) are then gone, so only the shell's MSYS process group still ties it to the run.
 */

const RUN = '11111111-2222-4333-8444-555555555555';
const slash = (path: string): string => path.replace(/\\/g, '/');

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// win32-skip(#976): Git Bash process groups exist on Windows only
describe.skipIf(!onWindows)('the run sweep and Git Bash process groups (#963)', () => {
  let dir = '';
  const started: number[] = [];
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'xez-sweep-msys-')));
  });
  afterEach(() => {
    for (const pid of started.splice(0)) if (alive(pid)) process.kill(pid);
    rmSync(dir, TEST_DIR_RM_OPTIONS);
  });

  it("stops a nohup child the agent's shell left after both its MSYS parents exited", async () => {
    const bash = join(gitRoot()!, 'usr', 'bin', 'bash.exe');
    const pidFile = join(dir, 'orphan.pid');
    const go = join(dir, 'go');
    const sleeper = `"${slash(process.execPath)}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)" "${slash(pidFile)}"`;
    // The shell waits for `go`, then leaves the orphan from a subshell and exits.
    const script = `while [ ! -e '${slash(go)}' ]; do sleep 0.1; done; (nohup ${sleeper} >/dev/null 2>&1 &); exit 0`;
    const agentCode = `const { spawn } = require('node:child_process'); spawn(process.argv[1], ['-c', process.argv[2]], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
    // plainMsysEnv: the stand-in agent starts its bash with ordinary quoting, which MSYS=noglob breaks.
    const agent = launch(process.execPath, ['-e', agentCode, bash, script], { stdio: 'ignore', env: plainMsysEnv() });
    const spawnedAt = Date.now();

    let listener: ((table: ProcessTable) => void) | undefined;
    const reports: string[] = [];
    const sweeper = new RunProcessSweeper(
      { report: (_runId, text) => reports.push(text) },
      { platform: 'win32', subscribe: (l) => ((listener = l), () => (listener = undefined)) },
    );
    sweeper.pinRoot(RUN, agent.pid!, spawnedAt);
    try {
      // One sampler read while the shell runs: it records the shell and its MSYS group.
      await expect
        .poll(
          async () => {
            const table = await readProcessTable();
            if (table) listener?.(table);
            return table?.rows.some((row) => row.ppid === agent.pid) === true;
          },
          { timeout: 20_000, interval: 500 },
        )
        .toBe(true);
      // Give the Git ps read beside that tick time to land.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await import('node:fs').then(({ writeFileSync }) => writeFileSync(go, ''));
      await expect.poll(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, { timeout: 15_000 }).toBe(true);
      const orphan = Number(readFileSync(pidFile, 'utf8'));
      started.push(orphan);
      // No read sees the shell exit: the sweep comes next, as after a cancel.
      await sweeper.now(RUN, 'cancel');
      expect(alive(orphan)).toBe(false);
      expect(reports.join('\n')).toMatch(/^Stopped /);
    } finally {
      sweeper.dispose();
      await stopChildTree(agent, 'SIGTERM');
    }
  }, 60_000);
});
