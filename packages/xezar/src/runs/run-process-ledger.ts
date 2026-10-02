/**
 * The ledger of one run's processes, for systems where a process's environment cannot be read
 * without starting something – Windows and macOS (#943).
 *
 * The sampler reads the process table every ~2 s; each read, the ledger records the run's root
 * and the root's descendants as `pid → { startedAt, lastSeenAt }`. When the run is stopped, a
 * fresh table decides what is still the run's: a row whose `(pid, startedAt)` the ledger
 * recorded, and – to a fixpoint – a row whose parent is one of those, or whose parent the ledger
 * saw holding that pid when the row started. That catches what an agent detached, which a walk
 * from the root no longer reaches.
 *
 * Proof is only this ledger – never a name, working folder, command line, port or temp folder.
 * The root itself counts only while it is the process that was spawned (SEC-2): its start time
 * must be within `ROOT_PIN_WINDOW_MS` of the spawn when first seen, and equal to that afterwards,
 * so a reused pid records nothing. A process that left the tree before a read (it detached and
 * its parent exited within one tick) is never recorded: this is best-effort cleanup, not a
 * containment boundary.
 */
import {
  SPAWN_CLOCK_SLACK_MS,
  descendantTargets,
  type ProcRow,
  type ProcessTable,
} from '../platform/process-table.ts';

/** How far the root's start time may be from the moment it was pinned, when first seen. */
export const ROOT_PIN_WINDOW_MS = 2_000;
/** Recorded processes per run; beyond it only what is already recorded is kept up to date. */
export const LEDGER_MAX_ENTRIES = 2_048;

/** A process by identity: its pid, and the start time that tells it from a later holder. */
export interface IdentifiedProcess {
  pid: number;
  startedAt: number;
}

interface Seen {
  startedAt: number;
  /** The start of the last read that showed this process alive. */
  lastSeenAt: number;
}

interface RootPin {
  pid: number;
  spawnedAt: number;
  startedAt?: number;
  rejected?: true;
}

function rowsByPid(rows: readonly ProcRow[]): Map<number, ProcRow> {
  const byPid = new Map<number, ProcRow>();
  for (const row of rows) byPid.set(row.pid, row);
  return byPid;
}

export class RunProcessLedger {
  private root: RootPin | undefined;
  private readonly seen = new Map<number, Seen>();

  /** The run's root process from now on; what earlier roots recorded is kept. */
  pin(pid: number, spawnedAt: number): void {
    this.root = { pid, spawnedAt };
  }

  /** Has any read recorded anything? Without it no process can be proved the run's. */
  get isEmpty(): boolean {
    return this.seen.size === 0;
  }

  /** Test seam: did a read record this pid? */
  has(pid: number): boolean {
    return this.seen.has(pid);
  }

  /**
   * One read of the process table. Answers the root's pid when THIS read rejected it – its start
   * time is too far from the spawn – because from then on nothing is recorded for that root, and
   * the caller must say so rather than let a later stop find an empty ledger in silence.
   */
  record(table: ProcessTable): number | undefined {
    const byPid = rowsByPid(table.rows);
    for (const [pid, entry] of this.seen) {
      const row = byPid.get(pid);
      if (row?.startedAt === entry.startedAt) entry.lastSeenAt = Math.max(entry.lastSeenAt, table.queriedAt);
    }
    const root = this.root;
    const wasRejected = root?.rejected === true;
    const rootStart = root === undefined ? undefined : this.pinnedStart(root, byPid.get(root.pid));
    if (root?.rejected === true && !wasRejected) return root.pid;
    if (root === undefined || rootStart === undefined) return undefined;
    this.note({ pid: root.pid, startedAt: rootStart }, table.queriedAt);
    // `descendantTargets` counts a direct child from `spawnedAt − SPAWN_CLOCK_SLACK_MS`; the root's
    // own start time is known here, so a child must have started no earlier than the root did.
    const walkRoot = { pid: root.pid, spawnedAt: rootStart + SPAWN_CLOCK_SLACK_MS, stoppedAt: Number.MAX_SAFE_INTEGER };
    for (const target of descendantTargets(table.rows, walkRoot)) this.note(target, table.queriedAt);
    return undefined;
  }

  /** The root's start time when this row is still the pinned process, else undefined. */
  private pinnedStart(root: RootPin, row: ProcRow | undefined): number | undefined {
    if (root.rejected || row?.startedAt === undefined) return undefined;
    if (root.startedAt === undefined) {
      if (Math.abs(row.startedAt - root.spawnedAt) > ROOT_PIN_WINDOW_MS) {
        // The pid already names another process – or the pin was taken late: record nothing for it.
        root.rejected = true;
        return undefined;
      }
      root.startedAt = row.startedAt;
    }
    return row.startedAt === root.startedAt ? root.startedAt : undefined;
  }

  private note({ pid, startedAt }: IdentifiedProcess, queriedAt: number): void {
    const entry = this.seen.get(pid);
    if (entry?.startedAt === startedAt) {
      entry.lastSeenAt = Math.max(entry.lastSeenAt, queriedAt);
      return;
    }
    if (entry === undefined && this.seen.size >= LEDGER_MAX_ENTRIES) return;
    this.seen.set(pid, { startedAt, lastSeenAt: queriedAt });
  }

  /**
   * The live processes of `rows` that belong to the run, by identity. `excluded(pid)` rows never
   * count (xezar itself, its ancestors, the system's own pids) and are never walked through.
   */
  targets(rows: readonly ProcRow[], excluded: (pid: number) => boolean): IdentifiedProcess[] {
    const found = new Map<number, number>();
    for (const row of rows) {
      const entry = this.seen.get(row.pid);
      if (entry !== undefined && row.startedAt === entry.startedAt && !excluded(row.pid)) found.set(row.pid, row.startedAt);
    }
    for (let grew = true; grew; ) {
      grew = false;
      for (const row of rows) {
        if (row.startedAt === undefined || found.has(row.pid) || excluded(row.pid) || excluded(row.ppid)) continue;
        if (this.startedUnderRun(row.startedAt, row.ppid, found)) {
          found.set(row.pid, row.startedAt);
          grew = true;
        }
      }
    }
    return [...found].map(([pid, startedAt]) => ({ pid, startedAt }));
  }

  /**
   * Did a process started at `startedAt` with parent pid `ppid` start under the run? Yes when the
   * parent is a live target that started no later, or when the ledger saw that pid held by a run
   * process that started no later and was still alive after `startedAt` – so the parent pid
   * named the run's process, not a later holder, when the child was created.
   */
  private startedUnderRun(startedAt: number, ppid: number, found: ReadonlyMap<number, number>): boolean {
    const liveParent = found.get(ppid);
    if (liveParent !== undefined) return liveParent <= startedAt;
    const recorded = this.seen.get(ppid);
    return recorded !== undefined && recorded.startedAt <= startedAt && startedAt < recorded.lastSeenAt;
  }
}
