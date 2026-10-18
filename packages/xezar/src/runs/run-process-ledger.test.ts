import { describe, expect, it } from 'vitest';
import type { ProcRow, ProcessTable } from '../platform/process-table.ts';
import { LEDGER_MAX_ENTRIES, LEDGER_STALE_MS, ROOT_PIN_WINDOW_MS, RunProcessLedger } from './run-process-ledger.ts';

const T0 = 1_800_000_000_000;
const ROOT = 100;
const XEZAR = 50;

function row(pid: number, ppid: number, startedAt?: number): ProcRow {
  return { pid, ppid, rssKb: 1, cpuPct: 0, ...(startedAt !== undefined ? { startedAt } : {}) };
}

function table(queriedAt: number, ...rows: ProcRow[]): ProcessTable {
  return { rows, queriedAt };
}

const none = (): boolean => false;

/** A ledger pinned to ROOT, spawned at T0, that has seen one read. */
function pinnedLedger(...rows: ProcRow[]): RunProcessLedger {
  const ledger = new RunProcessLedger();
  ledger.pin(ROOT, T0);
  ledger.record(table(T0 + 2_000, row(ROOT, XEZAR, T0 - 5), ...rows));
  return ledger;
}

describe('RunProcessLedger – the root pin (SEC-2)', () => {
  it('records the root and its descendants when the root started near its spawn', () => {
    const ledger = pinnedLedger(row(101, ROOT, T0 + 100), row(102, 101, T0 + 200));
    for (const pid of [ROOT, 101, 102]) expect(ledger.has(pid)).toBe(true);
  });

  it(`records nothing for a root whose start is more than ${ROOT_PIN_WINDOW_MS} ms from its spawn: the pid is someone else's`, () => {
    for (const offset of [-(ROOT_PIN_WINDOW_MS + 1_000), ROOT_PIN_WINDOW_MS + 1_000]) {
      const ledger = new RunProcessLedger();
      ledger.pin(ROOT, T0);
      // the read that rejects the root answers its pid – once, so the caller can say so (T-02)
      expect(ledger.record(table(T0 + 5_000, row(ROOT, XEZAR, T0 + offset), row(101, ROOT, T0 + offset + 10)))).toBe(ROOT);
      // and stays that way, even if a later read shows a start inside the window
      expect(ledger.record(table(T0 + 7_000, row(ROOT, XEZAR, T0), row(101, ROOT, T0 + 10)))).toBeUndefined();
      expect(ledger.has(ROOT)).toBe(false);
      expect(ledger.has(101)).toBe(false);
    }
  });

  it('answers nothing from a read that accepts the root, misses it, or has no pin', () => {
    const ledger = new RunProcessLedger();
    expect(ledger.record(table(T0, row(ROOT, XEZAR, T0)))).toBeUndefined();
    ledger.pin(ROOT, T0);
    expect(ledger.record(table(T0 + 1_000, row(101, 1, T0)))).toBeUndefined(); // the root not in it
    expect(ledger.record(table(T0 + 2_000, row(ROOT, XEZAR, T0 + ROOT_PIN_WINDOW_MS)))).toBeUndefined();
    expect(ledger.has(ROOT)).toBe(true);
  });

  it('stops recording once the pinned pid shows another start time (reused)', () => {
    const ledger = pinnedLedger();
    ledger.record(table(T0 + 60_000, row(ROOT, 1, T0 + 50_000), row(103, ROOT, T0 + 55_000)));
    expect(ledger.has(103)).toBe(false);
  });

  it('never records a row without a start time, nor a "child" older than the root', () => {
    const ledger = pinnedLedger(row(104, ROOT), row(105, ROOT, T0 - 10));
    expect(ledger.has(104)).toBe(false);
    expect(ledger.has(105)).toBe(false);
  });

  it('records nothing before a pin', () => {
    const ledger = new RunProcessLedger();
    ledger.record(table(T0, row(ROOT, XEZAR, T0), row(101, ROOT, T0 + 1)));
    expect(ledger.has(ROOT)).toBe(false);
  });

  it('keeps what an earlier root recorded when the next step pins a new one', () => {
    const ledger = pinnedLedger(row(101, ROOT, T0 + 100));
    ledger.pin(200, T0 + 30_000);
    ledger.record(table(T0 + 31_000, row(200, XEZAR, T0 + 30_000), row(201, 200, T0 + 30_500), row(101, 1, T0 + 100)));
    for (const pid of [ROOT, 101, 200, 201]) expect(ledger.has(pid)).toBe(true);
  });

  it(`records at most ${LEDGER_MAX_ENTRIES} processes`, () => {
    const children = Array.from({ length: LEDGER_MAX_ENTRIES + 10 }, (_, index) => row(1_000 + index, ROOT, T0 + 1));
    const ledger = pinnedLedger(...children);
    const recorded = children.filter((child) => ledger.has(child.pid)).length;
    expect(recorded).toBe(LEDGER_MAX_ENTRIES - 1); // the root is one of them
  });
});

/**
 * A full ledger used to refuse every new process for the rest of the run, though most of what it
 * held had long exited. It now forgets processes no read has shown alive for LEDGER_STALE_MS.
 */
describe('RunProcessLedger – a full ledger forgets exited processes', () => {
  const READ_1 = T0 + 2_000;
  /** Full: the root and LEDGER_MAX_ENTRIES − 1 short-lived children, all seen by READ_1. */
  function fullLedger(...extra: ProcRow[]): RunProcessLedger {
    const children = Array.from({ length: LEDGER_MAX_ENTRIES - 1 }, (_, index) => row(1_000 + index, ROOT, T0 + 1));
    const ledger = pinnedLedger(...children, ...extra);
    expect(ledger.has(1_000 + LEDGER_MAX_ENTRIES - 2)).toBe(true);
    return ledger;
  }

  it('records a new process once the exited ones have not been seen for the stale window', () => {
    const ledger = fullLedger();
    const later = READ_1 + LEDGER_STALE_MS + 1;
    ledger.record(table(later, row(ROOT, XEZAR, T0 - 5), row(9_000, ROOT, later - 500)));
    expect(ledger.has(9_000)).toBe(true);
    expect(ledger.has(1_000)).toBe(false);
    expect(ledger.has(ROOT)).toBe(true);
  });

  it('keeps refusing while what it holds was seen within the window (GUARD)', () => {
    const ledger = fullLedger();
    const later = READ_1 + LEDGER_STALE_MS - 1;
    ledger.record(table(later, row(ROOT, XEZAR, T0 - 5), row(9_000, ROOT, later - 500)));
    expect(ledger.has(9_000)).toBe(false);
    expect(ledger.has(1_000)).toBe(true);
  });

  it('never forgets the root pin, even when no read has shown it for the window', () => {
    const ledger = fullLedger();
    ledger.record(table(READ_1 + LEDGER_STALE_MS + 1));
    expect(ledger.has(ROOT)).toBe(true);
    expect(ledger.has(1_000)).toBe(false);
  });

  it('records a live program that started under a forgotten process, so a stop still proves it', () => {
    const ledger = fullLedger();
    // 1 000 exited after READ_1; its child 300 started while 1 000 held the pid and no read recorded it.
    const orphan = row(300, 1_000, T0 + 1_500);
    expect(ledger.targets([orphan], none)).toEqual([{ pid: 300, startedAt: T0 + 1_500 }]);
    ledger.record(table(READ_1 + LEDGER_STALE_MS + 1, row(ROOT, XEZAR, T0 - 5), orphan));
    expect(ledger.has(1_000)).toBe(false);
    expect(ledger.has(300)).toBe(true);
    expect(ledger.targets([orphan], none)).toEqual([{ pid: 300, startedAt: T0 + 1_500 }]);
  });
});

describe('RunProcessLedger – targets', () => {
  it('admits a live row with the recorded (pid, start), and rejects the same pid with another start', () => {
    const ledger = pinnedLedger(row(101, ROOT, T0 + 100), row(102, ROOT, T0 + 150));
    const now = [row(101, 1, T0 + 100), row(102, 1, T0 + 90_000)];
    expect(ledger.targets(now, none)).toEqual([{ pid: 101, startedAt: T0 + 100 }]);
  });

  it('admits a detached child of a recorded process when it started while that process held the pid', () => {
    const ledger = pinnedLedger(row(101, ROOT, T0 + 100)); // last seen at T0 + 2 000
    // 101 has exited; its child 300 was reparented but still names 101 as its parent
    const orphan = row(300, 101, T0 + 1_500);
    expect(ledger.targets([orphan], none)).toEqual([{ pid: 300, startedAt: T0 + 1_500 }]);
  });

  it("rejects a row that started after the recorded parent was last seen: the pid's new holder started it", () => {
    const ledger = pinnedLedger(row(101, ROOT, T0 + 100));
    expect(ledger.targets([row(301, 101, T0 + 2_000)], none)).toEqual([]);
    expect(ledger.targets([row(302, 101, T0 + 9_000), row(101, 1, T0 + 8_000)], none)).toEqual([]);
  });

  it('rejects a row whose parent the ledger never saw, and one older than its recorded parent', () => {
    const ledger = pinnedLedger(row(101, ROOT, T0 + 100));
    expect(ledger.targets([row(303, 999, T0 + 500), row(304, 101, T0 + 50)], none)).toEqual([]);
  });

  it('follows children of targets to a fixpoint, and each only if no older than its parent', () => {
    const ledger = pinnedLedger(row(101, ROOT, T0 + 100));
    const now = [row(101, ROOT, T0 + 100), row(400, 101, T0 + 30_000), row(401, 400, T0 + 30_001), row(402, 400, T0 + 29_000)];
    expect(ledger.targets(now, none).map(({ pid }) => pid).sort()).toEqual([101, 400, 401]);
  });

  it("never admits another run's process or a stranger, whatever its command line says (SEC-4, SEC-10)", () => {
    const ours = pinnedLedger(row(101, ROOT, T0 + 100));
    const theirs = new RunProcessLedger();
    theirs.pin(700, T0);
    theirs.record(table(T0 + 2_000, row(700, XEZAR, T0), row(701, 700, T0 + 100)));
    // 800 carries the literal marker in its argv – the ledger never looks at argv, so nothing links it
    const now = [row(101, 1, T0 + 100), row(701, 1, T0 + 100), row(800, XEZAR, T0 + 500)];
    expect(ours.targets(now, none)).toEqual([{ pid: 101, startedAt: T0 + 100 }]);
    expect(theirs.targets(now, none)).toEqual([{ pid: 701, startedAt: T0 + 100 }]);
  });

  it('never admits an excluded pid, nor walks through one', () => {
    const ledger = pinnedLedger(row(101, ROOT, T0 + 100));
    // 500 started while 101 was alive, so it would join through 101 were 101 not excluded
    const now = [row(101, ROOT, T0 + 100), row(500, 101, T0 + 1_500)];
    expect(ledger.targets(now, (pid) => pid === 101)).toEqual([]);
    expect(ledger.targets(now, none).map(({ pid }) => pid).sort()).toEqual([101, 500]);
  });
});
