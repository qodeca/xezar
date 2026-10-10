import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OwnedPids } from '../../test/helpers/owned-pids.ts';
import { trackedChildren } from './child-registry.ts';
import { launch } from './process-launch.ts';
import { killIdentified, readProcessTable } from './process-table.ts';
import { TREE_STOP_TIMEOUT_MS, stopChildTree } from './process-tree.ts';
import { readTableThenKill } from './table-then-kill.ts';

/**
 * The Windows tree stop against real processes (#963 AC-6): a child and the grandchild it
 * started, both deaf to stdin EOF, are gone after one `stopChildTree`, and `killIdentified` never
 * kills a pid whose start time does not match. Every OS runs the same rules against fakes in
 * process-tree.test.ts and process-table.test.ts; this file runs on Windows only.
 */

const FIXTURE = fileURLToPath(new URL('../core/__fixtures__/process/spawns-grandchild.mjs', import.meta.url));
/** The stop's own worst case: its one PowerShell (table and kill) is ended at this bound. A cold
 *  start alone takes 1-2 s on an idle machine and several under load, so a 5 s bound flaked. */
const STOP_BOUND_MS = TREE_STOP_TIMEOUT_MS;

/** Every pid a test started; what it did not see exit is stopped afterwards, identity-checked. */
const started = new OwnedPids();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

afterEach(() => started.stopAll(), 20_000);

async function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  const lines = createInterface({ input: stream });
  try {
    const [line] = (await once(lines, 'line')) as [string];
    return line;
  } finally {
    lines.close();
  }
}

// win32-skip(#976): a Windows tree stop with real processes runs on Windows only
describe.runIf(process.platform === 'win32')('Windows tree stop with real processes', () => {
  it('stops a child and its grandchild, both ignoring stdin EOF, within the bound (AC-6)', async () => {
    const child = launch(process.execPath, [FIXTURE], { stdio: ['pipe', 'pipe', 'ignore'] });
    const pids = JSON.parse(await firstLine(child.stdout)) as { child: number; grandchild: number };
    started.add([pids.child, pids.grandchild]);
    expect(pids.child).toBe(child.pid);
    expect(trackedChildren().some((tracked) => tracked.child === child)).toBe(true);
    expect(alive(pids.grandchild)).toBe(true);

    const stopping = Date.now();
    await stopChildTree(child, 'SIGTERM');
    // Named per pid, so a failure says which one survived.
    await expect
      .poll(() => ({ child: alive(pids.child), grandchild: alive(pids.grandchild) }), {
        timeout: STOP_BOUND_MS,
        interval: 100,
      })
      .toEqual({ child: false, grandchild: false });
    started.gone(pids.child, pids.grandchild);
    expect(Date.now() - stopping).toBeLessThan(STOP_BOUND_MS);
    await expect.poll(() => trackedChildren().some((tracked) => tracked.child === child)).toBe(false);
  }, 20_000);

  // The control: without the descendant stop the grandchild outlives its parent, so the test
  // above cannot pass by accident (a non-detached Node grandchild would: see the fixture).
  it('leaves the grandchild running when only the child is killed', async () => {
    const child = launch(process.execPath, [FIXTURE], { stdio: ['pipe', 'pipe', 'ignore'] });
    const pids = JSON.parse(await firstLine(child.stdout)) as { child: number; grandchild: number };
    started.add([pids.child, pids.grandchild]);
    const exited = once(child, 'exit');
    await stopChildTree(child, 'SIGTERM', { isOwnChild: () => false });
    await exited;
    started.gone(pids.child);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(alive(pids.grandchild)).toBe(true);
  }, 20_000);

  it('reads start times, and kills a pid only while its start time matches', async () => {
    const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });
    await once(victim, 'spawn');
    const pid = victim.pid!;
    started.add([pid]);

    const table = await readProcessTable();
    const row = table?.rows.find((candidate) => candidate.pid === pid);
    expect(row?.startedAt).toBeTypeOf('number');
    expect(Math.abs(row!.startedAt! - Date.now())).toBeLessThan(60_000);
    expect(table!.queriedAt).toBeGreaterThanOrEqual(row!.startedAt!);

    const mismatch = await killIdentified([{ pid, startedAt: row!.startedAt! + 5_000 }]);
    expect(mismatch?.get(pid)).toBe('mismatch');
    expect(alive(pid)).toBe(true);

    const exited = once(victim, 'exit');
    const killed = await killIdentified([{ pid, startedAt: row!.startedAt! }]);
    expect(killed?.get(pid)).toBe('killed');
    await exited;
    started.gone(pid);

    const gone = await killIdentified([{ pid, startedAt: row!.startedAt! }]);
    expect(gone?.get(pid)).toBe('gone');
  }, 20_000);

  // C-02: the descendant stop's one PowerShell – the table, then the kill of what was chosen from it.
  it('reads the table and kills the chosen pid in one helper, only while its start time matches', async () => {
    const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });
    await once(victim, 'spawn');
    const pid = victim.pid!;
    started.add([pid]);

    const shifted = await readTableThenKill((table) => {
      const row = table.rows.find((candidate) => candidate.pid === pid);
      return row?.startedAt === undefined ? [] : [{ pid, startedAt: row.startedAt + 5_000 }];
    }, { timeoutMs: STOP_BOUND_MS });
    expect(shifted?.outcomes.get(pid)).toBe('mismatch');
    expect(alive(pid)).toBe(true);

    const exited = once(victim, 'exit');
    const matched = await readTableThenKill((table) => {
      const row = table.rows.find((candidate) => candidate.pid === pid);
      return row?.startedAt === undefined ? [] : [{ pid, startedAt: row.startedAt }];
    }, { timeoutMs: STOP_BOUND_MS });
    expect(matched?.outcomes.get(pid)).toBe('killed');
    await exited;
    started.gone(pid);
  }, 30_000);
});
