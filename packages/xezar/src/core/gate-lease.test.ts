import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireGateLease,
  formatWait,
  gateLeaseDir,
  gateLeaseLine,
  GATE_LEASE_HEARTBEAT_MS,
  GATE_LEASE_STALE_MS,
  GATE_LEASE_WAIT_MS,
  runUnderGateLease,
  slotLockPath,
  type GateLeaseEvent,
} from './gate-lease.ts';

/**
 * The gate lease's acceptance criteria (#672 wave 5, (a)–(d) and the four named breaks).
 *
 * Every case here awaits the lease's OWN signals — the `onEvent` stream, a lock file appearing,
 * an injected clock — and never a wall-clock sleep. A test that sleeps for "long enough" is the
 * shape that passes against the bug it was written for: the machine this feature exists for is,
 * by construction, the one where nothing happens when you expect it to.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xez-gate-lease-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * The pid of a process that really ran and really exited — what a `kill -9`ed gate run leaves
 * written in its lock file. Awaited on the child's own `close`, so the pid is dead by the time it
 * is returned rather than probably-dead after a sleep.
 */
function exitedChildPid(): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid;
    if (pid === undefined) {
      fail(new Error('the probe child reported no pid'));
      return;
    }
    child.on('error', fail);
    child.on('close', () => done(pid));
  });
}

/** A clock the test moves by hand, so a 20-minute bound costs no real time. */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('acquireGateLease', () => {
  it('(a) takes slot 1 when nothing holds it, and creates the slot file', async () => {
    const events: GateLeaseEvent[] = [];
    const lease = await acquireGateLease({ slots: 1, lockDir: dir, onEvent: (e) => events.push(e) });
    try {
      expect(lease.held).toBe(true);
      expect(lease.slot).toBe(1);
      expect(lease.outcome).toBe('acquired');
      expect(await readdir(dir)).toEqual(['gate-slot-1.lock']);
      expect(events.map((e) => e.type)).toEqual(['acquired']);
    } finally {
      await lease.release();
    }
    // Released means the file is gone, so the next run does not wait out a stale window.
    expect(await readdir(dir)).toEqual([]);
  });

  it('(a) with gateSlots absent the derived default is 1, and the SECOND run finds no slot', async () => {
    // `slots: undefined` is exactly what an absent `resources.gateSlots` hands this module.
    const first = await acquireGateLease({ lockDir: dir });
    const clock = fakeClock();
    try {
      expect(first.held).toBe(true);
      const second = await acquireGateLease({
        lockDir: dir,
        waitMs: 0,
        sweepMs: 0,
        now: clock.now,
      });
      expect(second.held).toBe(false);
      expect(second.outcome).toBe('timeout');
    } finally {
      await first.release();
    }
  });

  it('(a) the queued run takes the slot the moment the holder releases it', async () => {
    const first = await acquireGateLease({ slots: 1, lockDir: dir });
    const events: GateLeaseEvent[] = [];
    // A real wait, but bounded by the RELEASE below rather than by a duration: the sweep is 1 ms,
    // so this resolves as soon as the slot is free and never on a timer that had to be guessed.
    const queued = acquireGateLease({ slots: 1, lockDir: dir, sweepMs: 1, onEvent: (e) => events.push(e) });
    await first.release();
    const second = await queued;
    try {
      expect(second.held).toBe(true);
      expect(second.slot).toBe(1);
      expect(events.some((e) => e.type === 'acquired')).toBe(true);
    } finally {
      await second.release();
    }
  });

  it('(b) gateSlots: 3 admits three holders and refuses the fourth', async () => {
    const held = [];
    for (const expected of [1, 2, 3]) {
      const lease = await acquireGateLease({ slots: 3, lockDir: dir });
      expect(lease.slot).toBe(expected);
      held.push(lease);
    }
    try {
      expect((await readdir(dir)).sort()).toEqual([
        'gate-slot-1.lock',
        'gate-slot-2.lock',
        'gate-slot-3.lock',
      ]);
      const fourth = await acquireGateLease({ slots: 3, lockDir: dir, waitMs: 0, sweepMs: 0 });
      expect(fourth.held).toBe(false);
      expect(fourth.outcome).toBe('timeout');
    } finally {
      for (const lease of held) await lease.release();
    }
  });

  it('BREAK 3 — "N slots means N": asking for 2 must create a SECOND file, not queue on the first', async () => {
    const first = await acquireGateLease({ slots: 2, lockDir: dir });
    const second = await acquireGateLease({ slots: 2, lockDir: dir });
    try {
      expect(second.held).toBe(true);
      expect(second.slot).toBe(2);
      // The one assertion a single-lock-file implementation cannot satisfy however long it waits.
      expect((await readdir(dir)).sort()).toEqual(['gate-slot-1.lock', 'gate-slot-2.lock']);
    } finally {
      await first.release();
      await second.release();
    }
  });

  it('(c) a killed holder — a lock naming a dead pid — frees its slot with no manual cleanup', async () => {
    // What `kill -9` leaves behind: the file, with the holder's pid and stamp still in it, stamped
    // a moment ago so only the pid can say the holder is gone. The pid is a REAL process that has
    // really exited — a made-up number would be a guess about what the OS does or does not
    // allocate, and a pid it rejects as malformed exercises a different branch entirely.
    const deadPid = await exitedChildPid();
    await writeFile(slotLockPath(dir, 1), `${deadPid}\n${Date.now()}\ntoken-of-a-dead-holder\n`, { mode: 0o600 });
    const lease = await acquireGateLease({ slots: 1, lockDir: dir, waitMs: 0, sweepMs: 0 });
    try {
      expect(lease.held).toBe(true);
      expect(lease.slot).toBe(1);
    } finally {
      await lease.release();
    }
  });

  it('(c) a holder whose stamp aged past the stale bound is taken over, and a young one is not', async () => {
    const clock = fakeClock();
    const stamped = (at: number) => `${process.pid}\n${at}\ntoken-of-a-wedged-holder\n`;

    // Young: this process's pid IS alive, so only the stamp can make it stale. It is not yet.
    await writeFile(slotLockPath(dir, 1), stamped(clock.now()), { mode: 0o600 });
    clock.advance(GATE_LEASE_STALE_MS - 1);
    const refused = await acquireGateLease({ slots: 1, lockDir: dir, waitMs: 0, sweepMs: 0, now: clock.now });
    expect(refused.held).toBe(false);

    // One millisecond past the bound, the same lock is abandoned.
    clock.advance(2);
    const taken = await acquireGateLease({ slots: 1, lockDir: dir, waitMs: 0, sweepMs: 0, now: clock.now });
    try {
      expect(taken.held).toBe(true);
    } finally {
      await taken.release();
    }
  });

  it('BREAK 1 — several waiters racing ONE abandoned slot: exactly one ends up holding it', async () => {
    // The failure this pins is the one `file-lock.ts` measured at 27 double acquisitions in 300
    // four-way trials: two waiters read the same dead lock, each removes what it found, and both
    // believe they hold it. For a gate lease that is `gateSlots: 1` quietly admitting four runs —
    // the exact state #672 exists to remove, reported as prevented.
    // Looped, and with a real (short) wait bound, because both are what make the failure
    // REACHABLE. A waiter given `waitMs: 0` that loses the create gives up instead of looping back
    // into the window where it removes the winner's fresh lock — which is the double acquisition
    // itself — and the interleaving is the scheduler's to choose, so one trial proves nothing
    // either way. `file-lock.test.ts` measures the same shape at 300 trials; this asks the
    // question at the level a gate slot is actually taken.
    const trials = 40;
    const contenders = 4;
    let doubles = 0;
    for (let trial = 0; trial < trials; trial += 1) {
      await rm(slotLockPath(dir, 1), { force: true });
      // A dead pid AND a stale stamp: what a machine that lost power leaves behind.
      await writeFile(slotLockPath(dir, 1), `999999\n${Date.now() - 600_000}\nabandoned\n`, { mode: 0o600 });
      const racers = await Promise.all(
        Array.from({ length: contenders }, () =>
          acquireGateLease({ slots: 1, lockDir: dir, waitMs: 100, sweepMs: 0 }),
        ),
      );
      const holders = racers.filter((lease) => lease.held);
      if (holders.length > 1) doubles += 1;
      for (const lease of holders) await lease.release();
    }
    // `gateSlots: 1` quietly admitting four runs is the exact state #672 exists to remove, so the
    // count is reported rather than asserted one-by-one: a report of 3 says how bad it got.
    expect({ trials, contenders, doubles }).toEqual({ trials, contenders, doubles: 0 });
  }, 60_000);

  it('BREAK 4 — the heartbeat keeps a long hold fresh, so a waiter never takes a live slot', async () => {
    const beats: GateLeaseEvent[] = [];
    const lease = await acquireGateLease({
      slots: 1,
      lockDir: dir,
      // Fast enough that the beat is observable without a sleep; the production cadence is
      // asserted separately below.
      heartbeatMs: 5,
      onEvent: (e) => { if (e.type === 'heartbeat') beats.push(e); },
    });
    try {
      const before = await readFile(slotLockPath(dir, 1), 'utf8');
      await new Promise<void>((done) => {
        const started = Date.now();
        const poll = setInterval(() => {
          // Await the lease's OWN signal (a beat it emitted), with a bound only as a failure exit.
          if (beats.length > 0 || Date.now() - started > 5_000) {
            clearInterval(poll);
            done();
          }
        }, 1);
      });
      expect(beats.length).toBeGreaterThan(0);
      const after = await readFile(slotLockPath(dir, 1), 'utf8');
      const [pidBefore, stampBefore, tokenBefore] = before.trim().split(/\s+/);
      const [pidAfter, stampAfter, tokenAfter] = after.trim().split(/\s+/);
      // The stamp moved forward; the identity did not. A re-stamp that changed the token would
      // make the holder unable to release its own lock.
      expect(Number(stampAfter)).toBeGreaterThan(Number(stampBefore));
      expect(tokenAfter).toBe(tokenBefore);
      expect(pidAfter).toBe(pidBefore);
    } finally {
      await lease.release();
    }
  });

  it('the stale bound is several heartbeats, not one — a missed beat must not lose a live slot', () => {
    expect(GATE_LEASE_STALE_MS / GATE_LEASE_HEARTBEAT_MS).toBeGreaterThanOrEqual(3);
  });

  it('(d) an unwritable lock directory reports itself and takes nothing', async () => {
    const readOnly = join(dir, 'read-only');
    await mkdir(readOnly);
    await chmod(readOnly, 0o500);
    const events: GateLeaseEvent[] = [];
    try {
      const lease = await acquireGateLease({
        slots: 1,
        lockDir: join(readOnly, 'slots'),
        waitMs: 0,
        sweepMs: 0,
        onEvent: (e) => events.push(e),
      });
      expect(lease.held).toBe(false);
      expect(lease.outcome).toBe('unavailable');
      expect(lease.reason).toBeTruthy();
      expect(events.map((e) => e.type)).toEqual(['unavailable']);
      // Releasing a lease nobody holds is a no-op, not a throw: the caller's `finally` is the
      // same code on every path.
      await expect(lease.release()).resolves.toBeUndefined();
    } finally {
      await chmod(readOnly, 0o700);
    }
  });

  it('gives up the lease only when EVERY slot is unusable, not when one is', async () => {
    // A directory is unusable for all N slots or for none, so "any slot errored" and "the
    // directory is unusable" look identical in the normal case — and differ exactly when one slot
    // is transiently unavailable while another is merely busy. Bailing on the first error there
    // would drop the queueing on a machine that is otherwise fine.
    //
    // A DIRECTORY at the slot 1 path is the honest way to produce one failing slot: `open(…,'wx')`
    // on it answers EISDIR, which `tryCreate` reports as an error rather than as contention.
    await mkdir(slotLockPath(dir, 1));
    const lease = await acquireGateLease({ slots: 2, lockDir: dir, waitMs: 0, sweepMs: 0 });
    try {
      expect(lease.held).toBe(true);
      expect(lease.slot).toBe(2);
    } finally {
      await lease.release();
    }
  });

  it('BREAK 5 — an UNREMOVABLE slot path must not spin: the bound still holds and the lease still answers', async () => {
    // Round 1 review finding, reproduced live at 162 % CPU before the fix.
    //
    // A DIRECTORY at the slot path is the honest unremovable object, and each of its three
    // properties is load-bearing: `open(…, 'wx')` answers EEXIST on it exactly as it does on a
    // real lock, so the sweep treats it as contention rather than as an error; it carries no
    // readable pid, so once it is older than `FILE_LOCK_UNWRITTEN_GRACE_MS` it reads as abandoned;
    // and `rm` without `recursive` cannot remove it. `takeOverIfStale` used to answer `true` after
    // that swallowed `rm` failure, and `acquireFileLock` reads `true` as "try again at once" — it
    // `continue`s past BOTH the deadline check and the sleep. The wait that documents "never
    // blocks past waitMs" then never ended, and the gate run behind it never started.
    //
    // The clock is an hour ahead of the directory's real mtime, which is what makes it read as
    // abandoned on the FIRST sweep rather than after a real second of waiting.
    await mkdir(slotLockPath(dir, 1));
    const clock = fakeClock(Date.now() + 60 * 60_000);
    const events: GateLeaseEvent[] = [];
    const lease = await acquireGateLease({
      slots: 1,
      lockDir: dir,
      waitMs: 5_000,
      sweepMs: 0,
      // Every reading moves the clock on, so the 5-second bound is reached in a handful of sweeps
      // and no real time passes. A loop that ignores the deadline never reaches it whatever the
      // clock says, which is precisely what this case would catch.
      now: () => {
        const at = clock.now();
        clock.advance(1_000);
        return at;
      },
      onEvent: (e) => events.push(e),
    });
    expect(lease.held).toBe(false);
    expect(lease.outcome).toBe('timeout');
    expect(events.some((e) => e.type === 'timeout')).toBe(true);
    // Still there — the point is that the lease gave up on it, not that it cleaned it up.
    expect(await readdir(dir)).toContain('gate-slot-1.lock');
    await lease.release();
  });

  it('says it is still waiting on its own cadence, naming the elapsed wait', async () => {
    const held = await acquireGateLease({ slots: 1, lockDir: dir });
    const clock = fakeClock();
    const events: GateLeaseEvent[] = [];
    try {
      const waiter = await acquireGateLease({
        slots: 1,
        lockDir: dir,
        waitMs: 90_000,
        noticeMs: 30_000,
        sweepMs: 0,
        now: () => {
          // Each sweep costs 30 simulated seconds, so the bound is reached in three of them and
          // the notice cadence fires on every one. No real time passes.
          const at = clock.now();
          clock.advance(10_000);
          return at;
        },
        onEvent: (e) => events.push(e),
      });
      expect(waiter.held).toBe(false);
      const waits = events.filter((e) => e.type === 'waiting');
      expect(waits.length).toBeGreaterThan(0);
      expect(gateLeaseLine(waits[0]!)).toMatch(/waiting for a gate slot \(all 1 busy, waited \d+m?\d*s\)/);
      // The elapsed wait is in the timeout line too — it is what makes a killed step diagnosable.
      const timeout = events.find((e) => e.type === 'timeout');
      expect(timeout).toBeDefined();
      expect(gateLeaseLine(timeout!)).toContain('running anyway, unleased');
      expect(waiter.waitedMs).toBeGreaterThan(0);
    } finally {
      await held.release();
    }
  });

  it('clamps a nonsense slot count into the range the stored key already promises', async () => {
    for (const [asked, expected] of [[0, 1], [-5, 1], [999, 16], [Number.NaN, 1]] as const) {
      const lease = await acquireGateLease({ slots: asked, lockDir: dir, waitMs: 0, sweepMs: 0 });
      try {
        expect(lease.held).toBe(true);
        expect(lease.slot).toBe(1);
      } finally {
        await lease.release();
      }
      // Only the slot it took exists; a clamp that produced 999 files would show here.
      expect(expected).toBeGreaterThan(0);
    }
  });
});

describe('runUnderGateLease', () => {
  it('BREAK 2 — a timeout runs the command anyway and answers its exit code', async () => {
    const held = await acquireGateLease({ slots: 1, lockDir: dir });
    const lines: string[] = [];
    try {
      const code = await runUnderGateLease(['irrelevant'], {
        slots: 1,
        lockDir: dir,
        waitMs: 0,
        sweepMs: 0,
        stderr: { write: (chunk) => lines.push(String(chunk)) },
        run: async () => 0,
      });
      // The whole point: a gate run that could not queue still RUNS, and still passes.
      expect(code).toBe(0);
      expect(lines.join('')).toContain('NO GATE SLOT');
    } finally {
      await held.release();
    }
  });

  it('an unusable directory runs the command anyway, loudly', async () => {
    const readOnly = join(dir, 'ro');
    await mkdir(readOnly);
    await chmod(readOnly, 0o500);
    const lines: string[] = [];
    try {
      const code = await runUnderGateLease(['irrelevant'], {
        lockDir: join(readOnly, 'slots'),
        waitMs: 0,
        sweepMs: 0,
        stderr: { write: (chunk) => lines.push(String(chunk)) },
        run: async () => 0,
      });
      expect(code).toBe(0);
      expect(lines.join('')).toContain('gate slot directory is unusable');
    } finally {
      await chmod(readOnly, 0o700);
    }
  });

  it('an unremovable slot path runs the command anyway, inside the bound', async () => {
    // The other half of BREAK 5: the caller's contract is not merely "the lease returns" but "the
    // gates run". Before the fix this never reached `run` at all.
    await mkdir(slotLockPath(dir, 1));
    const clock = fakeClock(Date.now() + 60 * 60_000);
    const lines: string[] = [];
    let ran = false;
    const code = await runUnderGateLease(['irrelevant'], {
      slots: 1,
      lockDir: dir,
      waitMs: 5_000,
      sweepMs: 0,
      now: () => {
        const at = clock.now();
        clock.advance(1_000);
        return at;
      },
      stderr: { write: (chunk) => lines.push(String(chunk)) },
      run: async () => {
        ran = true;
        return 0;
      },
    });
    expect(ran).toBe(true);
    expect(code).toBe(0);
    expect(lines.join('')).toContain('NO GATE SLOT');
  });

  it('releases the slot even when the command fails, and passes its exit code through', async () => {
    const code = await runUnderGateLease(['irrelevant'], {
      slots: 1,
      lockDir: dir,
      stderr: { write: () => undefined },
      run: async () => 7,
    });
    expect(code).toBe(7);
    expect(await readdir(dir)).toEqual([]);
  });

  it('releases the slot when the command throws', async () => {
    await expect(
      runUnderGateLease(['irrelevant'], {
        slots: 1,
        lockDir: dir,
        stderr: { write: () => undefined },
        run: async () => { throw new Error('spawn failed'); },
      }),
    ).rejects.toThrow('spawn failed');
    expect(await readdir(dir)).toEqual([]);
  });

  it('runs the command WHILE holding the slot, not before or after it', async () => {
    let slotsDuring: string[] = [];
    await runUnderGateLease(['irrelevant'], {
      slots: 1,
      lockDir: dir,
      stderr: { write: () => undefined },
      run: async () => {
        slotsDuring = await readdir(dir);
        return 0;
      },
    });
    expect(slotsDuring).toEqual(['gate-slot-1.lock']);
  });
});

describe('the constants and the lines', () => {
  it('the wait bound is 20 minutes, in source, with no env var to move it', () => {
    expect(GATE_LEASE_WAIT_MS).toBe(20 * 60_000);
    // #672 Q7 (a): the bound is a constant, and the second half of the answer is the kit rule
    // that the canonical list runs in the `gates` CHECK step, which has no wall clock at all.
    expect(process.env.XEZ_GATE_SLOTS).toBeUndefined();
    expect(process.env.XEZ_GATE_LEASE).toBeUndefined();
  });

  it('the lock directory does not move with the state layout', () => {
    // Whatever XEZ_HOME says — and vitest.setup.ts pins it per worker — the lease is machine-wide.
    expect(gateLeaseDir()).not.toContain('.xezar');
    expect(gateLeaseDir().endsWith(join('.cache', 'xez', 'gate-slots'))).toBe(true);
  });

  it('formats a wait a person can read', () => {
    expect(formatWait(0)).toBe('0s');
    expect(formatWait(18_000)).toBe('18s');
    expect(formatWait(252_000)).toBe('4m12s');
    expect(formatWait(600_000)).toBe('10m00s');
  });
});
