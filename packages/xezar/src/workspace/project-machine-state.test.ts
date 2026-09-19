import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireFileLock } from '../core/file-lock.ts';
import { projectStateLayout, setActiveStateLayout } from '../state-layout.ts';
import { workspaceConfigLockPath } from './config-lock.ts';
import { registerProject } from './projects.ts';
import {
  projectMachineStatePath,
  readProjectMachineState,
  recordLastListen,
} from './project-machine-state.ts';
import * as machineState from './project-machine-state.ts';

/**
 * `<project>/.local/xezar/machine-state.json` — the per-machine working file of the
 * single-project layout (#600 defect A), hardened by #649.
 *
 * Three defects the fix closes, each with its own red case:
 * - the hand-rolled parse dropped every key it did not know and kept any string
 *   however long (`named break unknown-key-dropped`, `named break unbounded-stamp`);
 * - the read-modify-write held no lock, so two writers starting at once lost one
 *   fact (`named break lost-update`);
 * - a failed registration write was swallowed in an empty `catch {}`
 *   (`named break silent-failed-write`).
 *
 * The last two cases are GUARDS: they pin the fail-open read and the untouched
 * global layout, and they pass both with and without the fix by design. The
 * red proof (fix stashed, tests kept) is recorded on the pull request.
 */

const worker = fileURLToPath(new URL('./project-machine-state.worker.testkit.ts', import.meta.url));
const tsxLoader = import.meta.resolve('tsx');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error('timed out waiting for the worker process to start');
}

describe('project machine state (#649)', () => {
  const originalHome = process.env.XEZ_HOME;
  let root: string;
  let statePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'xez-machine-state-'));
    mkdirSync(join(root, '.xezar'), { recursive: true });
    setActiveStateLayout(projectStateLayout(root));
    const resolved = projectMachineStatePath();
    if (resolved === null) throw new Error('the project layout must resolve a machine-state path');
    statePath = resolved;
  });

  afterEach(() => {
    setActiveStateLayout(null);
    if (originalHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  });

  const readRaw = (): Record<string, unknown> =>
    JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;

  const writeRaw = (value: unknown): void => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  };

  it('named break `unknown-key-dropped`: an unknown key survives a rewrite', async () => {
    writeRaw({
      addedAt: '2026-01-01T00:00:00.000Z',
      writtenByANewerXezar: { keep: 'this' },
    });

    await recordLastListen({ port: 4321, host: '127.0.0.1', observedAt: '2026-01-01T00:00:00.000Z' });

    const raw = readRaw();
    // The key a newer xezar wrote is what the hand-rolled parse dropped.
    expect(raw.writtenByANewerXezar).toEqual({ keep: 'this' });
    // ...and the facts the rewrite was for are still there, unchanged.
    expect(raw.addedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(raw.lastListen).toEqual({
      port: 4321,
      host: '127.0.0.1',
      observedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('named break `unbounded-stamp`: an over-long stamp is dropped, never persisted', async () => {
    const overLong = 'x'.repeat(100);
    writeRaw({ addedAt: overLong, lastOpenedAt: overLong });

    await recordLastListen({ port: 4321, host: '127.0.0.1', observedAt: '2026-01-01T00:00:00.000Z' });

    const raw = readRaw();
    expect(raw.lastOpenedAt).toBeUndefined();
    expect(raw.addedAt).toBeUndefined();
    expect(readProjectMachineState().lastOpenedAt).toBeUndefined();
    // The bounded fact the call was for is still recorded.
    expect(raw.lastListen).toEqual({
      port: 4321,
      host: '127.0.0.1',
      observedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('named break `lost-update`: a writer gated behind the lock keeps BOTH facts', async () => {
    mkdirSync(dirname(statePath), { recursive: true });
    const marker = join(root, 'worker-ready');

    // Writer B holds the file lock the fix uses. While it holds it, it writes its own
    // fact — exactly what a concurrent read-modify-write that read the file first does.
    const lock = await acquireFileLock(workspaceConfigLockPath(statePath), { waitMs: 5_000 });
    expect(lock.acquired, JSON.stringify(lock)).toBe(true);
    if (!lock.acquired) throw new Error('could not take the machine-state lock');

    // Writer A does its read-modify-write in a real second process.
    const child = spawn(process.execPath, ['--import', tsxLoader, worker, root, marker], {
      env: { ...process.env, VITEST: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const done = once(child, 'exit').then(([code]) => ({ code: code as number, stderr }));

    try {
      await waitFor(() => existsSync(marker), 15_000);
      // Without the lock A finishes here (its read-modify-write is synchronous). With the
      // lock it is blocked, so this waits out the short bound, not the child's lifetime.
      await Promise.race([done, sleep(800)]);

      writeRaw({ lastOpenedAt: '2026-01-02T00:00:00.000Z' });
      await lock.release();

      const result = await done;
      expect(result.code, result.stderr).toBe(0);
    } finally {
      // Never strand a child when an assertion above throws. By PID, never by pattern.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await lock.release();
    }

    const raw = readRaw();
    expect(raw.lastOpenedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(raw.lastListen).toEqual({
      port: 4321,
      host: '127.0.0.1',
      observedAt: '2026-01-01T00:00:00.000Z',
    });
  }, 30_000);

  it('named break `silent-failed-write`: a failed registration write warns once and never fails the boot', async () => {
    const dataDir = join(root, '.local', 'xezar');
    mkdirSync(dataDir, { recursive: true });
    // Not reachable as root, which can write a read-only directory anyway.
    if (process.getuid?.() === 0) return;
    chmodSync(dataDir, 0o500);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const reset = (machineState as { resetProjectMachineStateWriteWarning?: () => void })
        .resetProjectMachineStateWriteWarning;
      reset?.();

      await expect(registerProject(root)).resolves.toBeTruthy();
      await expect(registerProject(root)).resolves.toBeTruthy();

      const lines = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('could not record this launch'));
      expect(lines).toHaveLength(1);
    } finally {
      warn.mockRestore();
      chmodSync(dataDir, 0o700);
    }
  });

  it('guard: a missing, corrupt or non-object file answers {} and never throws', () => {
    expect(readProjectMachineState()).toEqual({});
    for (const body of ['', 'not json', '[]', 'null', '"a string"', '42', 'true']) {
      writeRaw(body);
      expect(readProjectMachineState()).toEqual({});
    }
    rmSync(statePath);
    expect(readProjectMachineState()).toEqual({});
  });

  it('guard: the GLOBAL layout still has no file, no path and no writer', async () => {
    setActiveStateLayout(null);
    process.env.XEZ_HOME = join(root, 'global-home');

    expect(projectMachineStatePath()).toBeNull();
    expect(readProjectMachineState()).toEqual({});
    await recordLastListen({ port: 4321, host: '127.0.0.1', observedAt: '2026-01-01T00:00:00.000Z' });
    // A no-op writer creates nothing — the per-user config is the only home in the
    // global layout, which `projects.test.ts`'s byte-identical control also pins.
    expect(existsSync(join(root, 'global-home'))).toBe(false);
    expect(existsSync(statePath)).toBe(false);
  });
});
