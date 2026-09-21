import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_LOCK_TAKEOVER_GUARD_SUFFIX } from '../core/file-lock.ts';
import { RunStore } from '../runs/store.ts';
import { startServer } from '../server/server.ts';
import { activeStateLayout } from '../state-layout.ts';
import type { RunManager } from '../workflows/run.ts';
import { atomicTmpPath, workspaceConfigBackupPath } from './config.ts';
import { workspaceConfigLockPath } from './config-lock.ts';
import {
  CONFIG_WATCH_DEBOUNCE_MS,
  setConfigWatchFactory,
  startWorkspaceConfigWatcher,
  type ConfigDirWatcher,
} from './config-watcher.ts';
import { WorkspaceSemaphore } from './semaphore.ts';

/**
 * The workspace config watcher (#677 slice D1). Every case but one delivers the raw fs event
 * itself through `setConfigWatchFactory` and drives the product's own debounce, so neither the
 * OS's event delivery nor a wall-clock deadline is in the loop (#671, the #786 pattern): macOS
 * reports nothing when a watch is armed and drops a write landing during registration (#204).
 */

interface FakeWatch {
  dir: string;
  emit: (filename: string | null) => void;
  fail: (err: unknown) => void;
  closed: boolean;
  unrefd: boolean;
}

function installFakeWatch(): FakeWatch[] {
  const made: FakeWatch[] = [];
  setConfigWatchFactory((dir, onEvent) => {
    const errorListeners: Array<(err: unknown) => void> = [];
    const fake: FakeWatch = {
      dir,
      emit: (filename) => onEvent(filename),
      fail: (err) => errorListeners.forEach((listener) => listener(err)),
      closed: false,
      unrefd: false,
    };
    made.push(fake);
    const watcher: ConfigDirWatcher = {
      on: (_event, listener) => errorListeners.push(listener),
      close: () => {
        fake.closed = true;
      },
      unref: () => {
        fake.unrefd = true;
      },
    };
    return watcher;
  });
  return made;
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

const WARNING = 'workspace config watch unavailable';

describe('workspace config watcher', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xez-config-watch-'));
    path = join(dir, 'config.json');
  });

  afterEach(() => {
    setConfigWatchFactory(undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('debounce (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('refreshes once, one debounce window after the last event — not before', () => {
      const made = installFakeWatch();
      const refresh = vi.fn(async () => undefined);
      const handle = startWorkspaceConfigWatcher({ target: { refresh }, path });

      made[0]!.emit('config.json');
      vi.advanceTimersByTime(CONFIG_WATCH_DEBOUNCE_MS - 1);
      expect(refresh).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(refresh).toHaveBeenCalledTimes(1);
      handle.close();
    });

    /**
     * AC-c. The burst below is the sequence one `mergeWriteWorkspaceConfig` performs, named with
     * the product's own path helpers: take the lock (and its takeover guard), stage a per-writer
     * tmp file, rename it over the config, `chmod` the config, then the same for the `.bak`
     * snapshot, then release the lock. The config's OWN name appears twice (the rename and the
     * `chmod`), so without the debounce this observes two refreshes — the spec's named break.
     */
    it('AC-c: one merge-write burst produces exactly one refresh', () => {
      const made = installFakeWatch();
      const refresh = vi.fn(async () => undefined);
      const handle = startWorkspaceConfigWatcher({ target: { refresh }, path });
      const lock = workspaceConfigLockPath(path);
      const tmp = atomicTmpPath(path);
      const bak = workspaceConfigBackupPath(path);
      const bakTmp = atomicTmpPath(bak);
      const burst = [
        lock,
        `${lock}${FILE_LOCK_TAKEOVER_GUARD_SUFFIX}`,
        tmp,
        tmp,
        path, // rename tmp → config.json
        path, // chmod 0600
        bakTmp,
        bak,
        bak,
        lock,
      ].map((file) => basename(file));
      expect(burst.filter((name) => name === 'config.json')).toHaveLength(2);

      for (const name of burst) {
        made[0]!.emit(name);
        vi.advanceTimersByTime(3); // a merge-write's syscalls land milliseconds apart
      }
      vi.advanceTimersByTime(CONFIG_WATCH_DEBOUNCE_MS * 4);

      expect(refresh).toHaveBeenCalledTimes(1);
      handle.close();
    });

    it('AC-d: the lock file, its takeover guard, tmp files and the .bak snapshot never fire it', () => {
      const made = installFakeWatch();
      const refresh = vi.fn(async () => undefined);
      const handle = startWorkspaceConfigWatcher({ target: { refresh }, path });
      const lock = workspaceConfigLockPath(path);

      for (const file of [
        lock,
        `${lock}${FILE_LOCK_TAKEOVER_GUARD_SUFFIX}`,
        atomicTmpPath(path),
        workspaceConfigBackupPath(path),
        join(dir, 'agent-accounts.json'),
        join(dir, 'ui-state.json'),
      ]) {
        made[0]!.emit(basename(file));
      }
      vi.advanceTimersByTime(CONFIG_WATCH_DEBOUNCE_MS * 4);

      expect(refresh).not.toHaveBeenCalled();
      handle.close();
    });

    it('treats an event without a filename as a possible change', () => {
      const made = installFakeWatch();
      const refresh = vi.fn(async () => undefined);
      const handle = startWorkspaceConfigWatcher({ target: { refresh }, path });

      made[0]!.emit(null);
      vi.advanceTimersByTime(CONFIG_WATCH_DEBOUNCE_MS);

      expect(refresh).toHaveBeenCalledTimes(1);
      handle.close();
    });

    it('close() drops a pending refresh and ignores later events', () => {
      const made = installFakeWatch();
      const refresh = vi.fn(async () => undefined);
      const handle = startWorkspaceConfigWatcher({ target: { refresh }, path });

      made[0]!.emit('config.json');
      handle.close();
      made[0]!.emit('config.json');
      vi.advanceTimersByTime(CONFIG_WATCH_DEBOUNCE_MS * 4);

      expect(refresh).not.toHaveBeenCalled();
      expect(made[0]!.closed).toBe(true);
      expect(handle.active).toBe(false);
    });

    it('a refresh that rejects is swallowed and the watch keeps working', async () => {
      const made = installFakeWatch();
      const refresh = vi.fn(async () => {
        throw new Error('boom');
      });
      const handle = startWorkspaceConfigWatcher({ target: { refresh }, path });

      made[0]!.emit('config.json');
      await vi.advanceTimersByTimeAsync(CONFIG_WATCH_DEBOUNCE_MS);
      made[0]!.emit('config.json');
      await vi.advanceTimersByTimeAsync(CONFIG_WATCH_DEBOUNCE_MS);

      expect(refresh).toHaveBeenCalledTimes(2);
      expect(handle.active).toBe(true);
      handle.close();
    });
  });

  it('R2: the debounce timer and the watcher are both unref\'d, so neither holds a process open', async () => {
    const made = installFakeWatch();
    const realSetTimeout = globalThis.setTimeout;
    const timers: NodeJS.Timeout[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const timer = realSetTimeout(fn, ms);
      timers.push(timer);
      return timer;
    }) as typeof setTimeout);
    let refreshed!: () => void;
    const done = new Promise<void>((resolve) => {
      refreshed = resolve;
    });
    const handle = startWorkspaceConfigWatcher({
      target: { refresh: async () => refreshed() },
      path,
      debounceMs: 1,
    });

    made[0]!.emit('config.json');
    expect(timers).toHaveLength(1);
    expect(timers[0]!.hasRef()).toBe(false);
    await done; // the watcher's own signal: the refresh it made
    expect(made[0]!.unrefd).toBe(true);
    handle.close();
  });

  it('R1: the default path is the active layout\'s workspace file, watched through its directory', () => {
    const made = installFakeWatch();
    const handle = startWorkspaceConfigWatcher({ target: { refresh: async () => undefined } });

    expect(made).toHaveLength(1);
    expect(made[0]!.dir).toBe(dirname(activeStateLayout().workspacePath));
    handle.close();
  });

  describe('R3: never fails, one warning', () => {
    it.each(['ENOSPC', 'EMFILE', 'EACCES', 'ENOENT'])('fs.watch throwing %s degrades to one warning', (code) => {
      setConfigWatchFactory(() => {
        throw errno(code);
      });
      const warn = vi.fn();

      const handle = startWorkspaceConfigWatcher({ target: { refresh: async () => undefined }, path, warn });

      expect(handle.active).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain(WARNING);
      expect(String(warn.mock.calls[0]![0])).toContain(code);
      handle.close();
    });

    it('a watcher that errors later closes itself with one warning, however often it errors', () => {
      vi.useFakeTimers();
      const made = installFakeWatch();
      const refresh = vi.fn(async () => undefined);
      const warn = vi.fn();
      const handle = startWorkspaceConfigWatcher({ target: { refresh }, path, warn });

      made[0]!.emit('config.json');
      made[0]!.fail(errno('EPERM'));
      made[0]!.fail(errno('EPERM'));
      made[0]!.emit('config.json');
      vi.advanceTimersByTime(CONFIG_WATCH_DEBOUNCE_MS * 4);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(made[0]!.closed).toBe(true);
      expect(handle.active).toBe(false);
      expect(refresh).not.toHaveBeenCalled();
    });

    it('the shipped default builds a real fs.watch on an existing directory, silently', () => {
      setConfigWatchFactory(undefined);
      const warn = vi.fn();

      const handle = startWorkspaceConfigWatcher({ target: { refresh: async () => undefined }, path, warn });

      // The degraded branch logs exactly this warning, so a silent, active watch is proof the real
      // one was constructed.
      expect(handle.active).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      handle.close();
    });

    it('the shipped default on a missing directory degrades with one warning instead of throwing', () => {
      setConfigWatchFactory(undefined);
      const warn = vi.fn();

      const handle = startWorkspaceConfigWatcher({
        target: { refresh: async () => undefined },
        path: join(dir, 'missing', 'config.json'),
        warn,
      });

      expect(handle.active).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain(WARNING);
    });
  });

  /**
   * The two acceptance criteria that need a running server. `startServer` binds an ephemeral
   * loopback port; nothing here reaches the network or an agent CLI.
   */
  describe('wired into startServer', () => {
    const savedHome = process.env.XEZ_HOME;
    let repoRoot: string;
    let store: RunStore;

    beforeEach(() => {
      repoRoot = join(dir, 'repo');
      mkdirSync(join(repoRoot, '.local/xezar'), { recursive: true });
      store = RunStore.open(join(repoRoot, '.local/xezar'));
    });

    afterEach(() => {
      store.flush();
      if (savedHome === undefined) delete process.env.XEZ_HOME;
      else process.env.XEZ_HOME = savedHome;
    });

    const boot = async (semaphore: WorkspaceSemaphore) => {
      const server = startServer(
        { repoRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test', semaphore },
        0,
      );
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      return server;
    };

    it('AC-a: a hand edit of maxParallel changes the effective cap with no request and no restart', async () => {
      const home = join(dir, 'home');
      mkdirSync(home);
      process.env.XEZ_HOME = home;
      const configPath = activeStateLayout().workspacePath;
      writeFileSync(configPath, JSON.stringify({ resources: { maxParallel: 2 } }));
      const made = installFakeWatch();
      const semaphore = new WorkspaceSemaphore();
      await semaphore.refresh();
      expect(semaphore.maxParallel()).toBe(2);

      const server = await boot(semaphore);
      try {
        expect(made).toHaveLength(1);
        expect(made[0]!.dir).toBe(home);
        const realRefresh = semaphore.refresh.bind(semaphore);
        let refreshed!: () => void;
        const done = new Promise<void>((resolve) => {
          refreshed = resolve;
        });
        const refresh = vi.spyOn(semaphore, 'refresh').mockImplementation(async () => {
          await realRefresh();
          refreshed();
        });

        // The hand edit: the file rewritten in place, as an editor does, then the event the OS
        // would report for it.
        writeFileSync(configPath, JSON.stringify({ resources: { maxParallel: 5 } }));
        made[0]!.emit(basename(configPath));
        expect(refresh).not.toHaveBeenCalled(); // debounced, not synchronous

        await done; // the watcher's own signal: the refresh it made
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(semaphore.maxParallel()).toBe(5);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      expect(made[0]!.closed).toBe(true); // closing the server closes the watch
    });

    it('AC-b: an unwatchable state directory still boots, serves /api/v1/health, and warns once', async () => {
      // A home that can never exist: its parent is a regular file.
      const blocker = join(dir, 'not-a-dir');
      writeFileSync(blocker, '');
      process.env.XEZ_HOME = join(blocker, 'home');
      setConfigWatchFactory(undefined); // the real fs.watch
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const semaphore = new WorkspaceSemaphore();

      const server = await boot(semaphore);
      try {
        const { port } = server.address() as AddressInfo;
        const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
        expect(response.status).toBe(200);
        const watchWarnings = warn.mock.calls.filter((call) => String(call[0]).includes(WARNING));
        expect(watchWarnings).toHaveLength(1);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
