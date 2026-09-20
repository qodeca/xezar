import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, type FSWatcher, type WatchListener } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTodosWatchRegistry } from './todos.ts';

/**
 * Per-dataDir todos watch (multi-project spec, step 2.3): each project's
 * `.local/xezar` gets its own fs watcher + emitter, created on first
 * subscription and torn down when the last subscriber leaves — so with N
 * projects open, A's todos.json writes fire A's subscribers only.
 */

class ControlledWatcher extends EventEmitter {
  closed = false;
  close(): void { this.closed = true; }
  ref(): this { return this; }
  unref(): this { return this; }
}

describe('per-dataDir todos watch (step 2.3)', () => {
  let root: string;
  let dirA: string;
  let dirB: string;
  let callbacks: Map<string, WatchListener<string>>;
  let watchers: Map<string, ControlledWatcher>;
  let registry: ReturnType<typeof createTodosWatchRegistry>;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), 'xez-todos-watch-'));
    dirA = join(root, 'project-a', '.local/xezar');
    dirB = join(root, 'project-b', '.local/xezar');
    callbacks = new Map();
    watchers = new Map();
    registry = createTodosWatchRegistry((dataDir, callback) => {
      const watcher = new ControlledWatcher();
      callbacks.set(dataDir, callback);
      watchers.set(dataDir, watcher);
      return watcher as unknown as FSWatcher;
    });
  });

  afterEach(() => {
    // Unsubscribe everything first so no watcher outlives its tmp dir.
    for (const off of cleanups.splice(0)) off();
    rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const subscribe = (dataDir: string, cb: () => void) => {
    const off = registry.onChanged(dataDir, cb);
    cleanups.push(off);
    return off;
  };

  const signal = async (dataDir: string, filename = 'todos.json') => {
    callbacks.get(dataDir)?.('change', filename);
    await vi.advanceTimersByTimeAsync(300);
  };

  it('scopes events to the written dataDir — A fires, B stays silent', async () => {
    let a = 0;
    let b = 0;
    subscribe(dirA, () => a++);
    subscribe(dirB, () => b++);

    // BREAK-671-TODOS-WAIT. The old test depended on when macOS registered and drained a real
    // fs.watch. Deliver the callback itself and advance the documented debounce instead, so the
    // assertion measures registry routing rather than host scheduling.
    await signal(dirA);
    expect(a).toBe(1);
    expect(b).toBe(0);
  });

  it('unsubscribe stops delivery to that callback while others keep receiving', async () => {
    let first = 0;
    let second = 0;
    const offFirst = subscribe(dirA, () => first++);
    subscribe(dirA, () => second++);

    offFirst();
    await signal(dirA);
    expect(first).toBe(0);
    expect(second).toBe(1);
  });

  it('tears the watch down with the last subscriber; a new subscription re-creates it', () => {
    const off1 = registry.onChanged(dirA, () => undefined);
    const off2 = registry.onChanged(dirA, () => undefined);
    expect(registry.active(dirA)).toBe(true);

    off1();
    expect(registry.active(dirA)).toBe(true); // one subscriber left — watch survives

    off2();
    expect(registry.active(dirA)).toBe(false); // last one out closes the watcher
    expect(watchers.get(dirA)?.closed).toBe(true);

    const off3 = subscribe(dirA, () => undefined);
    expect(registry.active(dirA)).toBe(true); // fresh subscription re-creates it
    off3();
    expect(registry.active(dirA)).toBe(false);
  });

  it('a stale double-unsubscribe never tears down a re-created watch', () => {
    const off1 = registry.onChanged(dirA, () => undefined);
    off1();
    expect(registry.active(dirA)).toBe(false);

    subscribe(dirA, () => undefined);
    off1(); // stale second call from the dead subscription — must be a no-op
    expect(registry.active(dirA)).toBe(true);
  });
});
