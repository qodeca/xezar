import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FILE_LOCK_STALE_MS,
  FILE_LOCK_TAKEOVER_GUARD_STALE_MS,
  FILE_LOCK_TAKEOVER_GUARD_SUFFIX,
  FILE_LOCK_UNWRITTEN_GRACE_MS,
  acquireFileLock,
  queueByLockPath,
} from './file-lock.ts';

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

describe('a stale lock taken over by a contender', () => {
  it('named break `B-TAKEOVER-TWO-HOLDERS`: contenders racing one stale lock never both acquire it', async () => {
    // What two PROCESSES do: `acquireFileLock` called concurrently with no in-process queue between
    // them. The reviewer's probe measured 2 double acquisitions in 500 such trials against the
    // unguarded takeover (A removes the dead lock and creates L1; B, acting on the same dead
    // metadata it read earlier, then removes L1 and creates L2). Looped because the interleaving is
    // the scheduler's to choose; the guard makes the outcome the same whichever it chooses.
    const trials = 300;
    const contenders = 4;
    let doubles = 0;
    for (let trial = 0; trial < trials; trial++) {
      rmSync(lock, { force: true });
      writeFileSync(lock, `999999\n${Date.now() - 60_000}\n`); // a dead pid with a stale stamp
      const got = await Promise.all(
        Array.from({ length: contenders }, () => acquireFileLock(lock, { waitMs: 100 })),
      );
      const holders = got.filter((one) => one.acquired);
      if (holders.length > 1) doubles++;
      for (const one of holders) if (one.acquired) await one.release();
    }
    expect({ trials, contenders, doubles }).toEqual({ trials, contenders, doubles: 0 });
  }, 60_000);

  it('named break `B-RELEASE-NOT-MINE`: a paused holder whose lock was taken over does not delete the new holder`s lock', async () => {
    // A laptop that sleeps: the holder is alive but its stamp is older than `FILE_LOCK_STALE_MS`,
    // so a waiter takes the lock over. The first holder must then release NOTHING.
    const paused = await acquireFileLock(lock, { waitMs: 100 });
    expect(paused.acquired).toBe(true);
    const later = Date.now() + FILE_LOCK_STALE_MS + 10_000;
    const taker = await acquireFileLock(lock, { waitMs: 100, now: () => later });
    expect(taker.acquired).toBe(true);
    const takersLock = readFileSync(lock, 'utf8');

    if (paused.acquired) await paused.release();
    // The taker still holds its own lock file, byte for byte.
    expect(readFileSync(lock, 'utf8')).toBe(takersLock);

    if (taker.acquired) await taker.release();
    expect(() => readFileSync(lock)).toThrow();
  });

  it('abandons a takeover guard that was left behind, so one crash cannot block every later waiter', async () => {
    writeFileSync(lock, `999999\n${Date.now() - 60_000}\n`);
    const guard = `${lock}${FILE_LOCK_TAKEOVER_GUARD_SUFFIX}`;
    writeFileSync(guard, 'left behind\n');
    const past = (Date.now() - FILE_LOCK_TAKEOVER_GUARD_STALE_MS - 5_000) / 1000;
    utimesSync(guard, past, past);
    const got = await acquireFileLock(lock, { waitMs: 500 });
    expect(got.acquired).toBe(true);
    if (got.acquired) await got.release();
    expect(existsSync(guard)).toBe(false);
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
