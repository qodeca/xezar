import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './config.ts';
import {
  acquireWorkspaceConfigLock,
  resetWorkspaceLockWarning,
  withWorkspaceConfigLock,
  workspaceConfigLockPath,
} from './config-lock.ts';

/**
 * The bounded cross-process merge lock (#467, AC-04).
 *
 * The contention cases run REAL child processes. Two `await`s inside one vitest worker are
 * serialized by the in-process queue and would prove nothing about two `xez` commands started
 * at the same moment, which is the failure the lock exists for.
 *
 * `named break:` cases each describe a deliberate defect this file must detect; the PR body
 * records the red run against each.
 */

const worker = fileURLToPath(new URL('./config-lock.worker.testkit.ts', import.meta.url));
const tsxLoader = import.meta.resolve('tsx');

/** Start one writer process. `hold` is spent between its read and its write. */
function startWriter(home: string, id: string, hold: number, kind = 'add') {
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, worker, id, String(hold), kind],
    { env: { ...process.env, XEZ_HOME: home, VITEST: '' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = once(child, 'exit').then(([code]) => ({ code: code as number, stderr }));
  return { child, done };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('workspace config lock', () => {
  const originalHome = process.env.XEZ_HOME;
  let home: string;

  const readProjectIds = (): string[] => {
    const raw = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      projects?: Array<{ id?: string }>;
    };
    return (raw.projects ?? []).map((p) => p.id ?? '');
  };

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'xez-config-lock-'));
    process.env.XEZ_HOME = home;
    resetWorkspaceLockWarning();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('named break `lost-registry-row`: two processes registering at once keep both rows', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ projects: [] }), 'utf8');

    // A reads, holds the file open for 400 ms, then writes. B starts inside that window.
    // Without the lock both read the empty registry and the later rename wins, so exactly
    // one project survives — the lost update this lock exists to stop.
    const first = startWriter(home, 'alpha', 400);
    await sleep(120);
    const second = startWriter(home, 'beta', 0);

    const [a, b] = await Promise.all([first.done, second.done]);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    expect(readProjectIds().sort()).toEqual(['alpha', 'beta']);
  }, 20_000);

  it('named break `double-writer`: a port-memory write and a projects edit both survive', async () => {
    // The two writers the analysis names: a starting instance remembering its port, and the
    // `projects` CLI editing the registry at the same moment. A lock only one of them holds
    // would not protect this pair, which is why the lock lives inside the merge-write.
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ projects: [{ id: 'alpha', root: '/tmp/alpha' }] }),
      'utf8',
    );

    const remembering = startWriter(home, 'alpha', 400, 'remember');
    await sleep(120);
    const registering = startWriter(home, 'beta', 0);

    const [a, b] = await Promise.all([remembering.done, registering.done]);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);

    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      projects: Array<{ id: string; lastListen?: { port?: number } }>;
    };
    expect(config.projects.map((p) => p.id).sort()).toEqual(['alpha', 'beta']);
    expect(config.projects.find((p) => p.id === 'alpha')?.lastListen?.port).toBe(4321);
  }, 20_000);

  it('named break `lost-registry-row`: unknown keys and unrelated projects survive contention', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        schemaVersion: 4,
        writtenByANewerXezar: { keep: 'this' },
        projects: [{ id: 'gamma', root: '/tmp/gamma', unknownKey: 'kept' }],
      }),
      'utf8',
    );

    const first = startWriter(home, 'alpha', 400);
    await sleep(120);
    const second = startWriter(home, 'beta', 0);
    await Promise.all([first.done, second.done]);

    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(config.writtenByANewerXezar).toEqual({ keep: 'this' });
    const projects = config.projects as Array<Record<string, unknown>>;
    expect(projects.map((p) => p.id).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(projects.find((p) => p.id === 'gamma')?.unknownKey).toBe('kept');
  }, 20_000);

  it('the lock file is released when the writer finishes', async () => {
    await mergeWriteWorkspaceConfig(() => {});
    expect(() => readFileSync(workspaceConfigLockPath(join(home, 'config.json')))).toThrow();
  });

  it('a throwing body still releases the lock', async () => {
    const path = join(home, 'config.json');
    await expect(
      withWorkspaceConfigLock(path, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // The next writer must not have to wait out the whole bound.
    await expect(withWorkspaceConfigLock(path, async () => 'ok')).resolves.toBe('ok');
  });

  it('named break `memory-required`: a lock held by a live process degrades after the bound', async () => {
    const path = join(home, 'config.json');
    const lock = workspaceConfigLockPath(path);
    // A lock this very process owns, so the liveness check says "alive" and the stale
    // take-over does not fire. The writer must go ahead anyway rather than fail the start.
    writeFileSync(lock, `${process.pid}\n${Date.now()}\n`, 'utf8');
    const warn = vi.fn();

    const result = await withWorkspaceConfigLock(path, async () => 'wrote anyway', {
      waitMs: 60,
      warn,
    });

    expect(result).toBe('wrote anyway');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('writing without it');
    // The lock it did not take is left exactly where it was.
    expect(readFileSync(lock, 'utf8')).toContain(String(process.pid));
  });

  it('a lock whose owner is gone is taken over at once', async () => {
    const path = join(home, 'config.json');
    const lock = workspaceConfigLockPath(path);
    // pid 1 is alive but is not ours; a pid that cannot exist is the honest fixture. Node
    // rejects 0, so use a very high one that no process can hold.
    writeFileSync(lock, `4294967294\n${Date.now()}\n`, 'utf8');
    const warn = vi.fn();

    const release = await acquireWorkspaceConfigLock(lock, { waitMs: 60, warn });

    expect(warn).not.toHaveBeenCalled();
    expect(readFileSync(lock, 'utf8')).toContain(String(process.pid));
    await release();
  });

  it('a lock older than the stale bound is taken over even if some process owns the pid', async () => {
    const path = join(home, 'config.json');
    const lock = workspaceConfigLockPath(path);
    writeFileSync(lock, `${process.pid}\n${Date.now() - 60_000}\n`, 'utf8');
    const warn = vi.fn();

    const release = await acquireWorkspaceConfigLock(lock, { waitMs: 60, warn });

    expect(warn).not.toHaveBeenCalled();
    await release();
  });

  it('two writers inside ONE process are serialized without touching the file lock', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ projects: [] }), 'utf8');
    // Both would find a lock file owned by a live pid — their own — and wait out the bound.
    // The in-process queue is what keeps that from happening.
    const started = Date.now();
    await Promise.all([
      mergeWriteWorkspaceConfig((config) => {
        config.projects.push({
          id: 'alpha', root: '/tmp/alpha', name: 'alpha', addedAt: '', lastOpenedAt: '', source: 'local',
        });
      }),
      mergeWriteWorkspaceConfig((config) => {
        config.projects.push({
          id: 'beta', root: '/tmp/beta', name: 'beta', addedAt: '', lastOpenedAt: '', source: 'local',
        });
      }),
    ]);

    expect(readProjectIds().sort()).toEqual(['alpha', 'beta']);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('every registry writer inherits the lock through mergeWriteWorkspaceConfig', async () => {
    // The guarantee is structural, not per-call-site: `serve`, `xez projects`, the settings
    // routes, migrations and the MCP all write through this one function, so none of them can
    // forget it. Pinned because "add a second writer that does its own atomic write" is the
    // shape of the regression.
    const source = readFileSync(fileURLToPath(new URL('./config.ts', import.meta.url)), 'utf8');
    // The exact arguments are not pinned (the project layout adds one — #650); what is pinned is
    // that the lock still wraps `mergeWriteLocked`, so a writer that bypasses it fails here. The
    // trailing `[),]` accepts both shapes, so this guard passes with and without #650.
    expect(source).toMatch(/withWorkspaceConfigLock\(\s*path,\s*\(\)\s*=>\s*mergeWriteLocked\(path, mutator[),]/);
    expect(await loadWorkspaceConfig()).toBeTruthy();
  });
});
