import { describe, expect, it } from 'vitest';

import { aggregateTreeUsage, parsePsOutput } from './process-usage.ts';

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
