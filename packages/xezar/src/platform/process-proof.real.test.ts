/**
 * The #943 readers against a real child process, on the system the suite runs on: the parsers
 * and scripts the unit tests pin with fakes must also read what the OS really prints (R9).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { envHasEntry, pidExists, readCommandLines } from './process-proof.ts';
import { readProcessTable, startTimeOf } from './process-table.ts';

const RUN_ID = '3f2a9c71-5e0b-4d8a-9b16-7c4e2d1a0f53';
const SCRIPT = 'setInterval(() => {}, 1000); // xez-proof-marker';
const REAL_TIMEOUT_MS = 30_000;

let child: ChildProcess | undefined;

afterEach(async () => {
  const started = child;
  child = undefined;
  if (started === undefined || started.exitCode !== null || started.signalCode !== null) return;
  const exited = once(started, 'exit');
  started.kill('SIGKILL');
  await exited;
});

async function startMarkedChild(): Promise<number> {
  child = spawn(process.execPath, ['-e', SCRIPT], {
    env: { ...process.env, XEZ_TASK_ID: RUN_ID },
    stdio: 'ignore',
    windowsHide: true,
  });
  await once(child, 'spawn');
  return child.pid!;
}

describe('the #943 readers against a real child', () => {
  it('sees the child alive, then gone', { timeout: REAL_TIMEOUT_MS }, async () => {
    const pid = await startMarkedChild();
    expect(pidExists(pid)).toBe(true);
    const exited = once(child!, 'exit');
    child!.kill('SIGKILL');
    await exited;
    expect(pidExists(pid)).toBe(false);
  });

  // win32-skip(#976): `/proc/<pid>/environ` exists on Linux only; Windows and macOS are pinned by the next case
  it.runIf(process.platform === 'linux')('Linux: proves the marker from /proc, and only the exact one', { timeout: REAL_TIMEOUT_MS }, async () => {
    const pid = await startMarkedChild();
    expect(await envHasEntry(pid, `XEZ_TASK_ID=${RUN_ID}`)).toBe(true);
    expect(await envHasEntry(pid, `XEZ_TASK_ID=${RUN_ID}x`)).toBe(false);
    expect(await envHasEntry(pid, 'XEZ_TASK_ID=another-run')).toBe(false);
    expect(await startTimeOf(pid)).toEqual(expect.any(Number));
  });

  // win32-skip(#976): the process-table ledger is the proof on Windows and macOS only; Linux is pinned above
  it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    "macOS and Windows: the table's row carries a start time, and the command line reads back",
    { timeout: REAL_TIMEOUT_MS },
    async () => {
      const pid = await startMarkedChild();
      const table = await readProcessTable({ timeoutMs: 10_000 });
      const row = table?.rows.find((candidate) => candidate.pid === pid);
      expect(row?.startedAt).toEqual(expect.any(Number));
      expect(Math.abs(row!.startedAt! - Date.now())).toBeLessThan(60_000);
      if (process.platform === 'darwin') expect(await startTimeOf(pid)).toBe(row!.startedAt);
      const lines = await readCommandLines([pid]);
      expect(lines.get(pid)).toContain('xez-proof-marker');
    },
  );
});
