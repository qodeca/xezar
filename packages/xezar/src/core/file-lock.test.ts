import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FILE_LOCK_UNWRITTEN_GRACE_MS, acquireFileLock, queueByLockPath } from './file-lock.ts';

/**
 * The shared bounded lock (#306 part 3). Its contention behaviour across real processes is proved by
 * its two users — `workspace/config-lock.test.ts` and `mcp/audit-rotation.test.ts`; this file pins
 * the rules only this module owns.
 */

let dir: string;
let lock: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xez-file-lock-'));
  lock = join(dir, 'thing.lock');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a lock file with no readable owner', () => {
  it('named break `B-EMPTY-LOCK-TAKEOVER`: a young empty lock is one being taken right now, and is not removed', async () => {
    // What `open(path, 'wx')` leaves for the instant before the owner writes its pid.
    writeFileSync(lock, '');
    const got = await acquireFileLock(lock, { waitMs: 100 });
    expect(got).toEqual({ acquired: false, reason: 'timeout' });
    expect(readFileSync(lock, 'utf8')).toBe('');
  });

  it('an empty lock older than the grace was abandoned mid-write, and is taken over at once', async () => {
    writeFileSync(lock, 'not a pid\n');
    const past = (Date.now() - FILE_LOCK_UNWRITTEN_GRACE_MS - 5_000) / 1000;
    utimesSync(lock, past, past);
    const got = await acquireFileLock(lock, { waitMs: 100 });
    expect(got.acquired).toBe(true);
    expect(readFileSync(lock, 'utf8')).toContain(String(process.pid));
    if (got.acquired) await got.release();
    expect(() => readFileSync(lock)).toThrow();
  });

  it('reports an unwritable folder as an error, never a throw', async () => {
    const got = await acquireFileLock(join(dir, 'missing', 'thing.lock'), { waitMs: 100 });
    expect(got).toMatchObject({ acquired: false, reason: 'error', error: { code: 'ENOENT' } });
  });
});

describe('the in-process queue', () => {
  it('runs bodies on one path in order, survives a rejected body, and keys the absolute path', async () => {
    const order: string[] = [];
    const slow = (label: string, ms: number) => async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(label);
      return label;
    };
    // Enqueued in this order; the first is the slowest, so only the queue can keep the order.
    const first = queueByLockPath(lock, slow('first', 30));
    const failing = queueByLockPath(lock, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('failed');
      throw new Error('boom');
    });
    const third = queueByLockPath(join(dir, '.', 'thing.lock'), slow('same-path-other-spelling', 1));
    const results = await Promise.allSettled([first, failing, third]);
    expect(order).toEqual(['first', 'failed', 'same-path-other-spelling']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});
