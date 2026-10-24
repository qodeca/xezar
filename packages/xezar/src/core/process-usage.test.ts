import { afterEach, describe, expect, it, vi } from 'vitest';

import { withPlatform } from '../../test/helpers/platform.ts';
import { readProcessTable, type ProcRow, type ProcessTable } from '../platform/process-table.ts';
import { ROOT_PIN_WINDOW_MS } from '../runs/run-process-ledger.ts';
import {
  SAMPLE_INTERVAL_MS,
  SAMPLE_READ_GRACE_MS,
  SAMPLE_READ_TIMEOUT_MS,
  aggregateTreeUsage,
  currentUsage,
  onProcessTable,
  onUsage,
  parsePsOutput,
  registerRunProcess,
  unregisterRunProcess,
} from './process-usage.ts';

const tableHook = vi.hoisted(() => ({ next: null as ProcessTable | null, reads: 0, hang: false }));

// Only the read is faked: every other export (the walk above all) is the real one.
vi.mock('../platform/process-table.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/process-table.ts')>();
  return {
    ...actual,
    readProcessTable: vi.fn(async () => {
      tableHook.reads += 1;
      // A read that never settles: a hung `ps` or PowerShell.
      if (tableHook.hang) return new Promise<never>(() => undefined);
      return tableHook.next;
    }),
  };
});

describe('parsePsOutput', () => {
  it('parses the unix `ps` shape (pid ppid rssKb cpu)', () => {
    const rows = parsePsOutput('  100   1  20480  3.5\n  101 100  10240  1.0\n');
    expect(rows).toEqual([
      { pid: 100, ppid: 1, rssKb: 20480, cpuPct: 3.5 },
      { pid: 101, ppid: 100, rssKb: 10240, cpuPct: 1.0 },
    ]);
  });

  it('parses the Windows PowerShell shape (pid ppid rssKb 0) — same columns, cpu 0', () => {
    // Get-CimInstance Win32_Process emits "PID PPID WorkingSetKB 0".
    const rows = parsePsOutput('4321 4000 51200 0\n4400 4321 12000 0\n');
    expect(rows.map((r) => [r.pid, r.ppid, r.rssKb])).toEqual([
      [4321, 4000, 51200],
      [4400, 4321, 12000],
    ]);
    expect(rows.every((r) => r.cpuPct === 0)).toBe(true);
  });

  it('skips malformed / truncated rows', () => {
    expect(parsePsOutput('garbage\n100 1\n200 1 4096 2.0')).toEqual([
      { pid: 200, ppid: 1, rssKb: 4096, cpuPct: 2.0 },
    ]);
  });
});

describe('aggregateTreeUsage', () => {
  const procs = parsePsOutput(
    ['500 1 100000 10', '501 500 50000 5', '502 501 25000 2', '900 1 999999 99'].join('\n'),
  );

  it('sums RSS over the whole descendant tree, in bytes', () => {
    const usage = aggregateTreeUsage(procs, 500);
    // (100000 + 50000 + 25000) KB * 1024
    expect(usage?.rssBytes).toBe(175000 * 1024);
    expect(usage?.procCount).toBe(3);
  });

  it('returns null when the root pid is gone (no data, not zero)', () => {
    expect(aggregateTreeUsage(procs, 12345)).toBeNull();
  });

  it('does not pull in unrelated trees', () => {
    // pid 900 (999999 KB) is a sibling under init, not under 500 — must not be counted.
    expect(aggregateTreeUsage(procs, 500)?.rssBytes).toBe(175000 * 1024);
  });

  it('sums CPU over the tree too, and treats a leaf as a one-process tree of its own', () => {
    // Ported from the retired scripts/test-process-usage.mjs, the cases this file did not cover.
    expect(aggregateTreeUsage(procs, 500)).toEqual({ cpuPct: 17, rssBytes: 175000 * 1024, procCount: 3 });
    expect(aggregateTreeUsage(procs, 502)).toEqual({ cpuPct: 2, rssBytes: 25000 * 1024, procCount: 1 });
    expect(aggregateTreeUsage(procs, 900)).toEqual({ cpuPct: 99, rssBytes: 999999 * 1024, procCount: 1 });
  });
});

/**
 * #963 moved the walk into `platform/process-table.ts` (`descendantPids`). On Linux and macOS
 * every sample must come out exactly as before, so the walk the sampler ran until then is kept
 * here as the reference and compared on shapes a torn `ps` snapshot can have.
 */
describe('aggregateTreeUsage walks exactly as it did before #963', () => {
  type Row = { pid: number; ppid: number; rssKb: number; cpuPct: number };

  /** The pre-#963 implementation, verbatim apart from its name. */
  function referenceAggregate(procs: Row[], rootPid: number) {
    const byPid = new Map<number, Row>();
    const children = new Map<number, number[]>();
    for (const p of procs) {
      byPid.set(p.pid, p);
      const siblings = children.get(p.ppid);
      if (siblings) siblings.push(p.pid);
      else children.set(p.ppid, [p.pid]);
    }
    if (!byPid.has(rootPid)) return null;
    let cpuPct = 0;
    let rssKb = 0;
    let procCount = 0;
    const queue = [rootPid];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const pid = queue.pop() as number;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const p = byPid.get(pid);
      if (!p) continue;
      cpuPct += p.cpuPct;
      rssKb += p.rssKb;
      procCount += 1;
      for (const child of children.get(pid) ?? []) queue.push(child);
    }
    return { cpuPct: Math.round(cpuPct * 10) / 10, rssBytes: rssKb * 1024, procCount };
  }

  const fixtures: Record<string, string[]> = {
    'a deep tree with siblings': ['500 1 100000 10.1', '501 500 50000 5.2', '502 501 25000 2.3', '503 500 7 0.35', '504 503 9 0.05', '900 1 999999 99'],
    'a torn snapshot that lists a pid twice': ['500 1 100 1.1', '501 500 200 2.2', '501 500 300 3.3', '502 501 400 4.4'],
    'a pid reused as its own ancestor (a cycle)': ['500 502 100 1', '501 500 200 2', '502 501 300 3'],
    'a root with no children': ['500 1 100 0.7', '600 1 200 0.3'],
    'float sums that depend on the visiting order': ['500 1 1 0.1', '501 500 1 0.2', '502 500 1 0.3', '503 501 1 0.4', '504 502 1 0.05'],
  };

  it.each(Object.entries(fixtures))('%s', (_label, lines) => {
    const procs = parsePsOutput(lines.join('\n'));
    for (const root of [500, 501, 502, 12345]) {
      expect(aggregateTreeUsage(procs, root)).toEqual(referenceAggregate(procs, root));
    }
  });
});

/** ps-style rows stamped with start times, so the Windows creation-filtered walk counts the child
 *  too: a sampler test runs on every CI platform, and on Windows a child counts only when its
 *  start is known and no earlier than the root's. */
const SPAWNED_AT = 1_700_000_000_000;
function stamped(lines: string[]): ProcRow[] {
  return parsePsOutput(lines.join('\n')).map((row, i) => ({ ...row, startedAt: SPAWNED_AT + i * 100 }));
}

describe('onProcessTable (#943)', () => {
  const RUN = 'run-process-table-hook';

  afterEach(() => {
    unregisterRunProcess(RUN);
    tableHook.next = null;
    tableHook.reads = 0;
  });

  it("hands each tick's whole table to its listeners, before the usage listeners, and survives a throwing one", async () => {
    const table: ProcessTable = { rows: stamped(['500 1 100 1', '501 500 50 0', '900 1 7 0']), queriedAt: 1_234 };
    tableHook.next = table;
    const order: string[] = [];
    const seen: ProcessTable[] = [];
    const offBroken = onProcessTable(() => {
      throw new Error('a broken ledger');
    });
    const offTable = onProcessTable((received) => {
      order.push('table');
      seen.push(received);
    });
    const offUsage = onUsage(() => order.push('usage'));
    try {
      registerRunProcess(RUN, 500, SPAWNED_AT);
      await vi.waitFor(() => expect(order).toEqual(['table', 'usage']));
      expect(seen).toEqual([table]);
      expect(seen[0]).toBe(table);
      expect(currentUsage(RUN)).toEqual({ cpuPct: 1, rssBytes: 150 * 1024, procCount: 2 });
    } finally {
      offBroken();
      offTable();
      offUsage();
    }
  });

  it('is not called for a table that could not be read, nor after unsubscribing', async () => {
    const calls: ProcessTable[] = [];
    const off = onProcessTable((received) => calls.push(received));
    registerRunProcess(RUN, 500, SPAWNED_AT);
    await vi.waitFor(() => expect(tableHook.reads).toBe(1));
    // Let that read settle (its deadline race takes a few microtasks), so the re-register below
    // starts a read of its own instead of finding one in flight.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
    off();
    unregisterRunProcess(RUN);
    tableHook.next = { rows: parsePsOutput('500 1 100 1'), queriedAt: 1 };
    registerRunProcess(RUN, 500, SPAWNED_AT);
    await vi.waitFor(() => expect(tableHook.reads).toBe(2));
    expect(calls).toEqual([]);
  });
});

/**
 * Windows keeps a process's parent pid after the parent exits. A long-lived program whose parent
 * died before the agent got that pid then looked like the agent's child, and its memory counted
 * toward the run's memory limit. Given the spawn time, the Windows walk counts only children that
 * started no earlier than the agent.
 */
describe('aggregateTreeUsage after pid reuse on Windows', () => {
  const T = 1_800_000_000_000;
  const rows: ProcRow[] = [
    { pid: 500, ppid: 1, rssKb: 100, cpuPct: 0, startedAt: T },
    { pid: 501, ppid: 500, rssKb: 50, cpuPct: 0, startedAt: T + 100 },
    { pid: 502, ppid: 501, rssKb: 5, cpuPct: 0, startedAt: T + 200 },
    // Started under an earlier holder of pid 500, long before the agent existed.
    { pid: 600, ppid: 500, rssKb: 999_999, cpuPct: 0, startedAt: T - 60_000 },
    { pid: 601, ppid: 600, rssKb: 7, cpuPct: 0, startedAt: T - 59_000 },
  ];

  it('counts only the processes that started under the agent', () => {
    expect(aggregateTreeUsage(rows, 500, T, 'win32')).toEqual({ cpuPct: 0, rssBytes: 155 * 1024, procCount: 3 });
  });

  it("counts nothing when the root's own pid now names a process started well after the spawn", () => {
    const reused = rows.map((r) => (r.pid === 500 ? { ...r, startedAt: T + ROOT_PIN_WINDOW_MS + 1 } : r));
    expect(aggregateTreeUsage(reused, 500, T, 'win32')).toBeNull();
    // Within the window it is still the agent (GUARD), and Linux keeps counting as before.
    const late = rows.map((r) => (r.pid === 500 ? { ...r, startedAt: T + ROOT_PIN_WINDOW_MS } : r));
    expect(aggregateTreeUsage(late, 500, T, 'win32')?.procCount).toBeGreaterThan(0);
    expect(aggregateTreeUsage(reused, 500, T, 'linux')?.procCount).toBe(5);
  });

  it('keeps the plain walk on Linux and macOS, and without a spawn time', () => {
    const plain = { cpuPct: 0, rssBytes: (155 + 999_999 + 7) * 1024, procCount: 5 };
    expect(aggregateTreeUsage(rows, 500, T, 'linux')).toEqual(plain);
    expect(aggregateTreeUsage(rows, 500, T, 'darwin')).toEqual(plain);
    expect(aggregateTreeUsage(rows, 500, undefined, 'win32')).toEqual(plain);
  });

  it('is what the sampler measures for a run registered with its spawn time', async () => {
    const RUN = 'run-process-usage-pid-reuse';
    tableHook.next = { rows, queriedAt: T + 1_000 };
    try {
      await withPlatform('win32', async () => {
        registerRunProcess(RUN, 500, T);
        await vi.waitFor(() => expect(currentUsage(RUN)?.procCount).toBe(3));
      });
      expect(currentUsage(RUN)?.rssBytes).toBe(155 * 1024);
    } finally {
      unregisterRunProcess(RUN);
      tableHook.next = null;
      tableHook.reads = 0;
    }
  });
});

/** A table read that never returned left the sampler busy for good: no usage, no memory limit. */
describe('a process-table read that never settles', () => {
  const RUN = 'run-process-usage-hung-read';

  afterEach(() => {
    unregisterRunProcess(RUN);
    vi.useRealTimers();
    tableHook.hang = false;
    tableHook.next = null;
    tableHook.reads = 0;
  });

  it('bounds the read and lets the next tick sample again', async () => {
    vi.useFakeTimers();
    tableHook.hang = true;
    registerRunProcess(RUN, 500, SPAWNED_AT);
    await vi.advanceTimersByTimeAsync(0);
    expect(tableHook.reads).toBe(1);
    expect(vi.mocked(readProcessTable)).toHaveBeenLastCalledWith({ timeoutMs: SAMPLE_READ_TIMEOUT_MS });

    // Ticks while the read hangs start no second read.
    await vi.advanceTimersByTimeAsync(SAMPLE_READ_TIMEOUT_MS);
    expect(tableHook.reads).toBe(1);

    tableHook.hang = false;
    tableHook.next = { rows: stamped(['500 1 100 1', '501 500 50 0']), queriedAt: 1 };
    await vi.advanceTimersByTimeAsync(SAMPLE_READ_GRACE_MS + SAMPLE_INTERVAL_MS);
    expect(tableHook.reads).toBe(2);
    expect(currentUsage(RUN)).toEqual({ cpuPct: 1, rssBytes: 150 * 1024, procCount: 2 });
  });
});
