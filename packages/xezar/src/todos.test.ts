import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  onTodosChanged,
  setTodosWatchFactory,
  todosWatchActive,
  type TodosWatcher,
} from './todos.ts';

/**
 * Per-dataDir todos watch (multi-project spec, step 2.3): each project's
 * `.local/xezar` gets its own fs watcher + emitter, created on first
 * subscription and torn down when the last subscriber leaves — so with N
 * projects open, A's todos.json writes fire A's subscribers only.
 *
 * These cases drive the watcher through `setTodosWatchFactory` and advance the debounce with
 * fake timers, so the OS is not in the loop at all. They used to write a real file and wait up to
 * 4 s for macOS to report it, which is not a signal the test can rely on: `fs.watch` announces
 * nothing when it is armed, and a write that lands during registration is DROPPED rather than
 * delayed (#204) — so under a loaded machine the awaited event simply never came and the case
 * failed on its deadline (#671, three reds on 2026-09-20). Delivery here is the product's own
 * routing plus its own 300 ms timer, both driven synchronously: there is no wall clock left to
 * lose a race to.
 */

/** A stand-in for `fs.watch` whose events the test delivers itself. */
interface FakeWatcher extends TodosWatcher {
  readonly dataDir: string;
  closed: boolean;
  /** Deliver one raw fs event for this dataDir (the product still debounces it). */
  fire(filename?: string | null): void;
}

describe('per-dataDir todos watch (step 2.3)', () => {
  let root: string;
  let dirA: string;
  let dirB: string;
  let watchers: FakeWatcher[];
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-todos-watch-'));
    // Nothing here writes to the workspace home, but the pin keeps the developer's own
    // `~/.xezar` out of reach for anything this file constructs.
    process.env.XEZ_HOME = join(root, 'xez-home');
    dirA = join(root, 'project-a', '.local/xezar');
    dirB = join(root, 'project-b', '.local/xezar');
    watchers = [];
    vi.useFakeTimers();
    setTodosWatchFactory((dataDir, onChange) => {
      const watcher: FakeWatcher = {
        dataDir,
        closed: false,
        on: () => watcher,
        close: () => {
          watcher.closed = true;
        },
        fire: (filename = 'todos.json') => {
          if (watcher.closed) throw new Error(`fired a closed watcher for ${dataDir}`);
          onChange(filename);
        },
      };
      watchers.push(watcher);
      return watcher;
    });
  });

  afterEach(() => {
    // Unsubscribe everything first so no watcher outlives its tmp dir.
    for (const off of cleanups.splice(0)) off();
    setTodosWatchFactory(undefined);
    vi.useRealTimers();
    // Drop the pin rather than leave the whole worker pointed at a directory about to be
    // removed — `vitest.setup.ts` re-pins its own sandbox home in its `afterEach`.
    delete process.env.XEZ_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  const subscribe = (dataDir: string, cb: () => void) => {
    const off = onTodosChanged(dataDir, cb);
    cleanups.push(off);
    return off;
  };

  /** The live watcher the product created for `dataDir`. */
  const watcherFor = (dataDir: string): FakeWatcher => {
    const live = watchers.filter((w) => w.dataDir === dataDir && !w.closed);
    const watcher = live[live.length - 1];
    if (!watcher) throw new Error(`no live watch for ${dataDir}`);
    return watcher;
  };

  /** Run the product's 300 ms debounce, and then every timer that a mis-routed event could have
   *  left pending, so "B stays silent" is a settled state and not a snapshot mid-flight. */
  const settle = () => vi.advanceTimersByTime(10_000);

  it('scopes events to the written dataDir — A fires, B stays silent', () => {
    let a = 0;
    let b = 0;
    subscribe(dirA, () => a++);
    subscribe(dirB, () => b++);

    watcherFor(dirA).fire();
    settle();
    expect(a).toBe(1);
    expect(b).toBe(0);

    // Not a vacuous silence: B's own watcher does reach B, and still never reaches A.
    watcherFor(dirB).fire();
    settle();
    expect(b).toBe(1);
    expect(a).toBe(1);
  });

  it('unsubscribe stops delivery to that callback while others keep receiving', () => {
    let first = 0;
    let second = 0;
    const offFirst = subscribe(dirA, () => first++);
    subscribe(dirA, () => second++);

    offFirst();
    watcherFor(dirA).fire();
    settle();

    expect(second).toBe(1); // the watch is live, so `first` staying 0 means something
    expect(first).toBe(0);
  });

  it('tears the watch down with the last subscriber; a new subscription re-creates it', () => {
    const off1 = onTodosChanged(dirA, () => undefined);
    const off2 = onTodosChanged(dirA, () => undefined);
    expect(todosWatchActive(dirA)).toBe(true);

    off1();
    expect(todosWatchActive(dirA)).toBe(true); // one subscriber left — watch survives
    expect(watcherFor(dirA).closed).toBe(false);

    off2();
    expect(todosWatchActive(dirA)).toBe(false); // last one out closes the watcher
    expect(watchers.at(-1)?.closed).toBe(true);

    const off3 = subscribe(dirA, () => undefined);
    expect(todosWatchActive(dirA)).toBe(true); // fresh subscription re-creates it
    off3();
    expect(todosWatchActive(dirA)).toBe(false);
  });

  it('a stale double-unsubscribe never tears down a re-created watch', () => {
    const off1 = onTodosChanged(dirA, () => undefined);
    off1();
    expect(todosWatchActive(dirA)).toBe(false);

    subscribe(dirA, () => undefined);
    off1(); // stale second call from the dead subscription — must be a no-op
    expect(todosWatchActive(dirA)).toBe(true);
  });

  it('the shipped default still builds a real fs.watch — the factory is a test seam only', () => {
    setTodosWatchFactory(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    subscribe(dirA, () => undefined);

    // `startWatch` degrades to a watcher-less entry with exactly this warning when `watch()`
    // throws, so a silent, active watch is proof the real one was constructed.
    expect(todosWatchActive(dirA)).toBe(true);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('todos watch unavailable');
    warn.mockRestore();
  });
});
