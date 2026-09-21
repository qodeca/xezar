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
    // The warning latches for the process, so re-arm it between cases; a later
    // warn-asserting case would otherwise pass vacuously.
    machineState.resetProjectMachineStateWriteWarning();
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

  it('per-field salvage: one invalid stamp drops only itself, never its good siblings', async () => {
    const good = '2026-01-01T00:00:00.000Z';
    // `addedAt` is a number, so it fails the schema on its own. Whole-object rejection
    // would drop the good stamp, the good address and the key a newer xezar wrote —
    // the data loss this file exists to prevent.
    writeRaw({
      addedAt: 12345,
      lastOpenedAt: good,
      lastListen: { port: 1111, host: '127.0.0.1', observedAt: good },
      unknownFromNewerXezar: { keep: 'this' },
    });

    await recordLastListen({ port: 4321, host: '127.0.0.1', observedAt: good });

    const raw = readRaw();
    expect(raw.addedAt).toBeUndefined();
    expect(raw.lastOpenedAt).toBe(good);
    expect(raw.lastListen).toEqual({ port: 4321, host: '127.0.0.1', observedAt: good });
    expect(raw.unknownFromNewerXezar).toEqual({ keep: 'this' });
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
    mkdirSync(dirname(statePath), { recursive: true });
    // Raw bodies, not `writeRaw`: stringifying them would land a JSON string every
    // time and never exercise the parse failure or the real-array branch.
    for (const body of ['', 'not json', '{oops', '[]', '[1,2]', 'null', '"a string"', '42', 'true']) {
      writeFileSync(statePath, body, 'utf8');
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

  /**
   * #819 item 1d — what this machine did about the one-time global import.
   *
   * `unknown` is the case with teeth: a state file written before this field existed says nothing
   * about consent, and reading it as `not-asked` would claim this machine asked nobody. That is
   * the "fail-open helper needs a populated-input guarantee" rule — against an absent input,
   * "never recorded" and "nobody was asked" must not read the same.
   */
  describe('the global-import record (#819 item 1d)', () => {
    it('named break `absent-reads-as-not-asked`: an absent field reads as unknown (T1.6)', () => {
      writeRaw({ addedAt: '2026-01-01T00:00:00.000Z' });
      expect(readProjectMachineState().globalImport).toBeUndefined();
      expect(machineState.readGlobalImportState()).toBe('unknown');
      // And a file that does not exist at all answers the same way, without creating one.
      rmSync(statePath);
      expect(machineState.readGlobalImportState()).toBe('unknown');
      expect(existsSync(statePath)).toBe(false);
    });

    it('records each answer, keeping the facts already in the file', async () => {
      await recordLastListen({ port: 4321, host: '127.0.0.1', observedAt: '2026-01-01T00:00:00.000Z' });
      for (const state of ['imported', 'declined', 'not-asked'] as const) {
        await machineState.recordGlobalImportState(state);
        expect(machineState.readGlobalImportState()).toBe(state);
      }
      expect(readRaw().lastListen).toEqual({ port: 4321, host: '127.0.0.1', observedAt: '2026-01-01T00:00:00.000Z' });
    });

    it('a value this xezar does not know degrades to unknown, and never evicts the rest', () => {
      writeRaw({ addedAt: '2026-01-01T00:00:00.000Z', globalImport: 'half-imported' });
      expect(machineState.readGlobalImportState()).toBe('unknown');
      expect(readProjectMachineState().addedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('guard: the GLOBAL layout records nothing and reads unknown', async () => {
      setActiveStateLayout(null);
      process.env.XEZ_HOME = join(root, 'global-home');
      await machineState.recordGlobalImportState('imported');
      expect(machineState.readGlobalImportState()).toBe('unknown');
      expect(existsSync(join(root, 'global-home'))).toBe(false);
    });
  });
});
