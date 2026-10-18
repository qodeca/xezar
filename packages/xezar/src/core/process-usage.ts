/**
 * Live process telemetry for the Runs table (#348): while any run has a
 * registered backend process, ONE `ps` snapshot every ~2 s is aggregated per
 * run over the process's full descendant tree (the CLI plus every Bash child
 * an agent spawned) into `{ cpuPct, rssBytes, procCount }`.
 *
 * Design constraints, in order:
 *  - never affect a run — a missing/failing `ps` (Windows, exotic containers)
 *    degrades silently to "no data";
 *  - one shared sampler, not one per run — N parallel runs still cost a
 *    single `ps` every tick, and the timer is unref()ed and stopped the
 *    moment the registry empties, so an idle cockpit spawns nothing;
 *  - parsing + tree aggregation are pure functions, testable against canned
 *    `ps` output (scripts/test-process-usage.mjs).
 */

import {
  SPAWN_CLOCK_SLACK_MS,
  descendantPids,
  readProcessTable,
  type ProcRow,
  type ProcessTable,
  type TreeRoot,
} from '../platform/process-table.ts';

/** One aggregated sample for a run's process tree. */
export interface ProcessUsage {
  /** Sum of `%cpu` across the tree — can exceed 100 on multi-core work. */
  cpuPct: number;
  /** Sum of resident set sizes, in bytes. */
  rssBytes: number;
  /** Number of live processes in the tree, the root included. */
  procCount: number;
}

/** One parsed `ps` row (`pid ppid rss %cpu`; rss is in KB, ps's unit). */
export interface ProcStat {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuPct: number;
}

/**
 * Parse `ps -axo pid=,ppid=,rss=,%cpu=` output (the `=` suffixes suppress
 * headers on darwin and linux alike). Malformed lines are skipped — `ps`
 * racing process exits can truncate rows.
 */
export function parsePsOutput(text: string): ProcStat[] {
  const out: ProcStat[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rssKb = Number(parts[2]);
    const cpuPct = Number(parts[3]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    out.push({
      pid,
      ppid,
      rssKb: Number.isFinite(rssKb) && rssKb > 0 ? rssKb : 0,
      cpuPct: Number.isFinite(cpuPct) && cpuPct > 0 ? cpuPct : 0,
    });
  }
  return out;
}

/**
 * Aggregate the full descendant tree rooted at `rootPid` from one `ps`
 * snapshot. Null when the root is gone (process exited between register and
 * sample) — callers treat that as "no data", not zero usage.
 *
 * Windows, given the moment the root was spawned: the creation-filtered walk. Windows keeps a
 * process's parent pid after the parent exits, so a long-lived program whose parent died before
 * the agent got that pid would otherwise count as the agent's child – and toward its memory
 * limit. A child counts only when it started no earlier than the root (or than `spawnedAt`, when
 * the root's own start time is unknown). Linux and macOS keep the plain walk by parent pid.
 */
export function aggregateTreeUsage(
  procs: readonly ProcRow[],
  rootPid: number,
  spawnedAt?: number,
  platform: NodeJS.Platform = process.platform,
): ProcessUsage | null {
  const byPid = new Map<number, ProcRow>();
  for (const p of procs) byPid.set(p.pid, p);
  const root = byPid.get(rootPid);
  if (!root) return null;
  const walkRoot: TreeRoot =
    platform === 'win32' && spawnedAt !== undefined
      ? {
          pid: rootPid,
          // The walk allows a direct child `SPAWN_CLOCK_SLACK_MS` before `spawnedAt`; with the
          // root's own start time known, a child must have started no earlier than the root.
          spawnedAt: root.startedAt !== undefined ? root.startedAt + SPAWN_CLOCK_SLACK_MS : spawnedAt,
          stoppedAt: Number.MAX_SAFE_INTEGER,
        }
      : { pid: rootPid };

  let cpuPct = root.cpuPct;
  let rssKb = root.rssKb;
  let procCount = 1;
  // The walk by parent pid, in the order it always visited (#963 moved it to `platform/`).
  for (const pid of descendantPids(procs, walkRoot)) {
    const p = byPid.get(pid);
    if (!p) continue;
    cpuPct += p.cpuPct;
    rssKb += p.rssKb;
    procCount += 1;
  }
  return { cpuPct: Math.round(cpuPct * 10) / 10, rssBytes: rssKb * 1024, procCount };
}

// ---- registry + sampler -----------------------------------------------------

export const SAMPLE_INTERVAL_MS = 2_000;
/**
 * One table read may take this long; the reader stops its `ps` or PowerShell then. Unbounded, a
 * read that never returned left `sampling` set for good: no usage, no memory limit and no
 * process ledger for the rest of the server's life.
 */
export const SAMPLE_READ_TIMEOUT_MS = 10_000;
/** Past the reader's own bound, the sampler stops waiting on a read that still has not settled. */
export const SAMPLE_READ_GRACE_MS = 5_000;

interface Entry {
  pid: number;
  /** When the agent process was spawned, ms since the epoch: the Windows walk's filter. */
  spawnedAt: number;
  last?: ProcessUsage;
  peakRssBytes: number;
  peakProcCount: number;
}

type UsageListener = (usage: Record<string, ProcessUsage>) => void;
type TableListener = (table: ProcessTable) => void;

const entries = new Map<string, Entry>();
const listeners = new Set<UsageListener>();
const tableListeners = new Set<TableListener>();
let timer: NodeJS.Timeout | null = null;
let sampling = false;

/** Start tracking a run's process tree. A re-register (a run's next agent
 *  step) replaces the pid but keeps nothing else — peaks are per session and
 *  the engine maxes them into the run record on unregister. `spawnedAt`: when
 *  the process was spawned, as close as the caller knows it (default: now). */
export function registerRunProcess(runId: string, pid: number, spawnedAt: number = Date.now()): void {
  entries.set(runId, { pid, spawnedAt, peakRssBytes: 0, peakProcCount: 0 });
  if (!timer) {
    timer = setInterval(() => void sample(), SAMPLE_INTERVAL_MS);
    timer.unref?.();
    void sample(); // first data point right away, not 2 s late
  }
}

/** Stop tracking; returns the session's peaks (undefined when no sample ever
 *  landed — `ps` unavailable, or the process died before the first tick). */
export function unregisterRunProcess(
  runId: string,
): { peakRssBytes: number; peakProcCount: number } | undefined {
  const entry = entries.get(runId);
  entries.delete(runId);
  if (entries.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!entry || entry.peakProcCount === 0) return undefined;
  return { peakRssBytes: entry.peakRssBytes, peakProcCount: entry.peakProcCount };
}

/** Latest sample for one run, if any. */
export function currentUsage(runId: string): ProcessUsage | undefined {
  return entries.get(runId)?.last;
}

/** Latest samples for every registered run that has data. */
export function allUsage(): Record<string, ProcessUsage> {
  const out: Record<string, ProcessUsage> = {};
  for (const [runId, entry] of entries) {
    if (entry.last) out[runId] = entry.last;
  }
  return out;
}

/** Subscribe to fresh samples (fires ~every 2 s while runs are registered);
 *  returns the unsubscribe. The SSE endpoint relays these to the GUI. */
export function onUsage(listener: UsageListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Subscribe to each tick's whole process table (#943): the rows and the moment the query
 * started. It fires only while runs are registered, and only with a table that was read – the
 * same ticks `onUsage` gets, before them. Returns the unsubscribe. A run's process sweeper
 * keeps its ledger from these; nothing here changes what a sample measures.
 */
export function onProcessTable(listener: TableListener): () => void {
  tableListeners.add(listener);
  return () => {
    tableListeners.delete(listener);
  };
}

/** Test hook: fan one snapshot out to every subscriber without shelling `ps` —
 *  lets unit tests prove a dispose()d subscriber stops receiving ticks. */
export function emitUsageForTest(snapshot: Record<string, ProcessUsage>): void {
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // mirror sample(): one broken listener never kills the fan-out
    }
  }
}

async function sample(): Promise<void> {
  if (sampling || entries.size === 0) return;
  sampling = true;
  try {
    const table = await readWithin(SAMPLE_READ_TIMEOUT_MS + SAMPLE_READ_GRACE_MS);
    if (table === null) return; // ps unavailable or too slow — degrade to no data
    for (const listener of tableListeners) {
      try {
        listener(table);
      } catch {
        // a broken ledger must not kill the sampler
      }
    }
    const procs = table.rows;
    for (const entry of entries.values()) {
      const usage = aggregateTreeUsage(procs, entry.pid, entry.spawnedAt);
      entry.last = usage ?? undefined;
      if (usage) {
        entry.peakRssBytes = Math.max(entry.peakRssBytes, usage.rssBytes);
        entry.peakProcCount = Math.max(entry.peakProcCount, usage.procCount);
      }
    }
    if (listeners.size > 0) {
      const snapshot = allUsage();
      for (const listener of listeners) {
        try {
          listener(snapshot);
        } catch {
          // a broken SSE stream must not kill the sampler
        }
      }
    }
  } finally {
    sampling = false;
  }
}

/** One bounded read; null when it fails or has not settled by `deadlineMs`. A read that settles
 *  later is dropped – the reader's own timeout has stopped its program by then. */
async function readWithin(deadlineMs: number): Promise<ProcessTable | null> {
  let deadline: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    deadline = setTimeout(() => resolve(null), deadlineMs);
    deadline.unref?.();
  });
  try {
    return await Promise.race([readProcessTable({ timeoutMs: SAMPLE_READ_TIMEOUT_MS }), late]);
  } finally {
    clearTimeout(deadline);
  }
}
