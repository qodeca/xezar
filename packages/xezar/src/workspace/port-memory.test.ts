import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './config.ts';
import {
  firstUnreservedPort,
  portsReservedByOtherProjects,
  readStoredCliSettings,
  rememberLastListen,
} from './port-memory.ts';

/**
 * Per-project port memory (#467, AC-03/AC-04).
 *
 * `named break:` cases each describe a deliberate defect. They were proven red against that
 * defect before the module was written; the PR body records the failures.
 */
describe('port memory', () => {
  const originalHome = process.env.XEZ_HOME;
  let home: string;

  const writeConfig = (value: unknown): void => {
    writeFileSync(join(home, 'config.json'), JSON.stringify(value, null, 2), 'utf8');
  };
  const readConfig = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Record<string, unknown>;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'xez-port-memory-'));
    process.env.XEZ_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = originalHome;
    // Restore write permission first: a read-only case leaves a home rm cannot clear.
    try {
      chmodSync(home, 0o700);
    } catch {
      // already writable
    }
    rmSync(home, { recursive: true, force: true });
  });

  describe('remembering', () => {
    it('writes the port that was bound, next to the host and a timestamp', async () => {
      writeConfig({ projects: [{ id: 'alpha', root: '/tmp/alpha' }] });
      const now = () => new Date('2026-09-16T08:06:12.104Z');

      const entry = await rememberLastListen('alpha', 4323, '127.0.0.1', now);

      expect(entry).toEqual({ port: 4323, host: '127.0.0.1', observedAt: '2026-09-16T08:06:12.104Z' });
      const projects = readConfig().projects as Array<Record<string, unknown>>;
      expect(projects[0]?.lastListen).toEqual(entry);
    });

    it('named break `remember-before-listen`: it stores no pid, lease or socket path', async () => {
      // The whole reason `lastListen` is a hint: it is stale the moment the process ends, so
      // anything that looked like authority would be read as a liveness claim by the next
      // reader. The keys are pinned here because adding one is a one-line temptation.
      writeConfig({ projects: [{ id: 'alpha', root: '/tmp/alpha' }] });
      await rememberLastListen('alpha', 4321, '127.0.0.1');
      const projects = readConfig().projects as Array<Record<string, unknown>>;
      expect(Object.keys(projects[0]?.lastListen as object).sort()).toEqual([
        'host',
        'observedAt',
        'port',
      ]);
    });

    it('preserves unrelated projects and every unknown key on its own row', async () => {
      writeConfig({
        schemaVersion: 3,
        somethingNewerWrote: { keep: true },
        projects: [
          { id: 'alpha', root: '/tmp/alpha', unknownKey: 'kept' },
          { id: 'beta', root: '/tmp/beta', lastListen: { port: 4999, host: '127.0.0.1' } },
        ],
      });

      await rememberLastListen('alpha', 4321, '127.0.0.1');

      const config = readConfig();
      expect(config.somethingNewerWrote).toEqual({ keep: true });
      const projects = config.projects as Array<Record<string, unknown>>;
      expect(projects).toHaveLength(2);
      expect(projects[0]?.unknownKey).toBe('kept');
      expect(projects[1]?.lastListen).toEqual({ port: 4999, host: '127.0.0.1' });
    });

    it('answers null for a project the registry does not hold, and writes nothing', async () => {
      writeConfig({ projects: [{ id: 'alpha', root: '/tmp/alpha' }] });
      expect(await rememberLastListen('ghost', 4321, '127.0.0.1')).toBeNull();
      const projects = readConfig().projects as Array<Record<string, unknown>>;
      expect(projects[0]?.lastListen).toBeUndefined();
    });

    it('named break `memory-required`: a home that cannot be written answers null, never throws', async () => {
      writeConfig({ projects: [{ id: 'alpha', root: '/tmp/alpha' }] });
      chmodSync(home, 0o500);
      // Not reachable as root, which can write a read-only directory anyway.
      if (process.getuid?.() === 0) return;

      await expect(rememberLastListen('alpha', 4321, '127.0.0.1')).resolves.toBeNull();
    });
  });

  describe('skipping ports other projects hold', () => {
    const config = {
      projects: [
        { id: 'alpha', root: '/tmp/alpha', lastListen: { port: 4321 } },
        { id: 'beta', root: '/tmp/beta', cli: { port: 4400 }, lastListen: { port: 4401 } },
        { id: 'gamma', root: '/tmp/gamma', lastListen: { port: 0 } },
        { id: 'delta', root: '/tmp/delta', cli: { port: 'nonsense' } },
      ],
    } as unknown as Parameters<typeof portsReservedByOtherProjects>[0];

    it('collects both the chosen and the remembered port of every OTHER project', () => {
      expect([...portsReservedByOtherProjects(config, 'alpha')].sort((a, b) => a - b)).toEqual([
        4400, 4401,
      ]);
    });

    it('never reserves a project against its own memory', () => {
      expect(portsReservedByOtherProjects(config, 'beta').has(4400)).toBe(false);
      expect(portsReservedByOtherProjects(config, 'beta').has(4321)).toBe(true);
    });

    it('ignores 0 and unparseable values rather than reserving nonsense', () => {
      const reserved = portsReservedByOtherProjects(config, 'alpha');
      expect(reserved.has(0)).toBe(false);
      expect(reserved.size).toBe(2);
    });

    it('with no self id every project counts', () => {
      expect(portsReservedByOtherProjects(config, undefined).size).toBe(3);
    });

    it('firstUnreservedPort walks forward and stops at the top of the range', () => {
      expect(firstUnreservedPort(4321, new Set())).toBe(4321);
      expect(firstUnreservedPort(4321, new Set([4321, 4322]))).toBe(4323);
      // Off the top: the caller reports "no free port" rather than wrapping round.
      expect(firstUnreservedPort(65535, new Set([65535]))).toBe(65536);
    });
  });

  describe('reading what is stored', () => {
    it('hands back the raw values, unvalidated, for the resolver to judge', async () => {
      writeConfig({
        cli: { output: 'lines', color: 'nonsense' },
        projects: [
          { id: 'alpha', root: '/tmp/alpha', cli: { port: 4400 }, lastListen: { port: 4401 } },
        ],
      });

      const stored = await readStoredCliSettings('alpha');

      expect(stored.workspace).toMatchObject({ output: 'lines', color: 'nonsense' });
      expect(stored.projectPort).toBe(4400);
      expect(stored.rememberedPort).toBe(4401);
    });

    it('named break `memory-required`: an absent home reads as nothing stored', async () => {
      const stored = await readStoredCliSettings('alpha');
      expect(stored.projectPort).toBeUndefined();
      expect(stored.rememberedPort).toBeUndefined();
      expect(stored.workspace).toBeUndefined();
    });

    it('named break `memory-required`: a corrupt config reads as nothing stored and does not throw', async () => {
      writeFileSync(join(home, 'config.json'), '{ this is not json', 'utf8');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const stored = await readStoredCliSettings('alpha');
        expect(stored.projectPort).toBeUndefined();
      } finally {
        warn.mockRestore();
      }
    });

    it('a project with no row reads as nothing stored, workspace defaults intact', async () => {
      writeConfig({ cli: { output: 'rich' }, projects: [] });
      const stored = await readStoredCliSettings('ghost');
      expect(stored.workspace).toMatchObject({ output: 'rich' });
      expect(stored.projectPort).toBeUndefined();
    });
  });

  it('a merge-write by another writer keeps a remembered port', async () => {
    // The two writers of the same file, in the order a start uses them: remember, then a
    // `projects` edit. The second must not drop the first — this is the single-process half
    // of the lock guarantee, and `config-lock.test.ts` proves the cross-process half.
    writeConfig({ projects: [{ id: 'alpha', root: '/tmp/alpha' }] });
    await rememberLastListen('alpha', 4323, '127.0.0.1');
    await mergeWriteWorkspaceConfig((cfg) => {
      const entry = cfg.projects.find((p) => p.id === 'alpha');
      if (entry) entry.tags = ['infra'];
    });

    const loaded = await loadWorkspaceConfig();
    expect(loaded.projects[0]?.lastListen).toMatchObject({ port: 4323 });
    expect(loaded.projects[0]?.tags).toEqual(['infra']);
  });
});
