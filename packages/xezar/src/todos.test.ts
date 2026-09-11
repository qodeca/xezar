import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onTodosChanged, todosPath, todosWatchActive } from './todos.ts';

/**
 * Per-dataDir todos watch (multi-project spec, step 2.3): each project's
 * `.local/xezar` gets its own fs watcher + emitter, created on first
 * subscription and torn down when the last subscriber leaves — so with N
 * projects open, A's todos.json writes fire A's subscribers only.
 */

/** Poll until the assertion holds (the watch debounce is 300 ms). */
async function waitFor(assertion: () => void, timeoutMs = 4000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

/**
 * Write `file` until `delivered()` holds. A write that lands while macOS is still registering a
 * fresh watch is DROPPED, not delayed — a probe for #204 lost 9 of 15 such writes outright, and a
 * rewrite always arrived about 310 ms later — and nothing reports when registration is done. A
 * delivered event is the only proof the watch is live, so rewrite once per debounce window until
 * one lands. Rewriting sooner would restart the 300 ms debounce instead of letting it fire.
 */
async function writeUntilDelivered(
  file: string,
  content: string,
  delivered: () => boolean,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await fs.writeFile(file, content);
    const rewriteAt = Date.now() + 600;
    while (Date.now() < rewriteAt) {
      if (delivered()) return;
      if (Date.now() >= deadline) throw new Error(`no change event for ${file} within ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

describe('per-dataDir todos watch (step 2.3)', () => {
  let root: string;
  let dirA: string;
  let dirB: string;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-todos-watch-'));
    dirA = join(root, 'project-a', '.local/xezar');
    dirB = join(root, 'project-b', '.local/xezar');
  });

  afterEach(() => {
    // Unsubscribe everything first so no watcher outlives its tmp dir.
    for (const off of cleanups.splice(0)) off();
    rmSync(root, { recursive: true, force: true });
  });

  const subscribe = (dataDir: string, cb: () => void) => {
    const off = onTodosChanged(dataDir, cb);
    cleanups.push(off);
    return off;
  };

  it('scopes events to the written dataDir — A fires, B stays silent', async () => {
    let a = 0;
    let b = 0;
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    await fs.writeFile(todosPath(dirA), '[]');
    await fs.writeFile(todosPath(dirB), '[]');
    subscribe(dirA, () => a++);
    subscribe(dirB, () => b++);

    // macOS FSEvents can deliver the just-created files as backlog after watch() returns. Let
    // that registration noise clear before measuring the write whose project scope matters.
    await new Promise((resolve) => setTimeout(resolve, 400));
    a = 0;
    b = 0;
    await fs.writeFile(todosPath(dirA), JSON.stringify([{ id: 't1', summary: 'from A' }]));
    await waitFor(() => expect(a).toBeGreaterThan(0));
    // A full debounce window past A's delivery — a late cross-fire would land here.
    await new Promise((r) => setTimeout(r, 400));
    expect(b).toBe(0);
  });

  it('unsubscribe stops delivery to that callback while others keep receiving', async () => {
    let first = 0;
    let second = 0;
    const offFirst = subscribe(dirA, () => first++);
    subscribe(dirA, () => second++);

    offFirst();
    // No fixed settle: a write that lands the instant watch() returns can be missed entirely
    // (#204), so keep writing until the surviving subscriber proves the watch is live. Both
    // callbacks would fire on the same emit, so `first` staying 0 is still the whole claim.
    await writeUntilDelivered(
      todosPath(dirA),
      JSON.stringify([{ id: 't2', summary: 'still watched' }]),
      () => second > 0,
    );
    expect(first).toBe(0);
  });

  it('tears the watch down with the last subscriber; a new subscription re-creates it', () => {
    const off1 = onTodosChanged(dirA, () => undefined);
    const off2 = onTodosChanged(dirA, () => undefined);
    expect(todosWatchActive(dirA)).toBe(true);

    off1();
    expect(todosWatchActive(dirA)).toBe(true); // one subscriber left — watch survives

    off2();
    expect(todosWatchActive(dirA)).toBe(false); // last one out closes the watcher

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
});
