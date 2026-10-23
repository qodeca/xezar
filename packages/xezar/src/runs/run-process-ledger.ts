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
import type { MsysRow } from '../platform/msys-process-tree.ts';
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
/**
 * A full ledger forgets a process no read has shown alive for this long (30 sampler reads), before
 * it refuses a new one: a long run that starts thousands of short programs would otherwise stop
 * recording for good. Never the root. The only proof a forgotten process still carried is for a
 * live program it started that no read recorded (one that left the tree with it); the ledger
 * records those, by their own identity, as it forgets their parent.
 */
export const LEDGER_STALE_MS = 60_000;
/** Recorded Git Bash process groups per run. */
export const LEDGER_MAX_GROUPS = 256;

/** A process by identity: its pid, and the start time that tells it from a later holder. */
export interface IdentifiedProcess {
  pid: number;
  startedAt: number;
}

/** The file form of a ledger (#982): `[pid, startedAt, lastSeenAt]` rows and `[pgid, leaderStartedAt]` groups. */
export interface LedgerSnapshot {
  v: 1;
  seen: Array<[number, number, number]>;
  groups: Array<[number, number]>;
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
  /** Windows: the MSYS process groups the run's own Git Bash shells lead – pgid → the leader's
   *  Windows start time (#963). */
  private readonly groups = new Map<number, number>();

  /** The run's root process from now on; what earlier roots recorded is kept. */
  pin(pid: number, spawnedAt: number): void {
    this.root = { pid, spawnedAt };
  }

  /** Has any read recorded anything? Without it no process can be proved the run's. */
  get isEmpty(): boolean {
    return this.seen.size === 0;
  }

  /** Has a read recorded a Git Bash process group? Only then is Git's `ps` worth reading at a stop. */
  get hasGroups(): boolean {
    return this.groups.size > 0;
  }

  /**
   * Windows (#963): the MSYS half of one read. A recorded process that leads its own MSYS process
   * group – a Git Bash shell the run started, as an agent's Bash tool does – records that group.
   * When an MSYS process execs, or a subshell exits, a program it started lives on under a Windows
   * parent that is already gone, and the group is what still ties it to the run.
   */
  recordMsys(table: ProcessTable): void {
    if (table.msys === undefined) return;
    const byPid = rowsByPid(table.rows);
    for (const row of table.msys) {
      if (row.pid !== row.pgid || this.groups.has(row.pgid)) continue;
      const startedAt = byPid.get(row.winpid)?.startedAt;
      if (startedAt === undefined || this.seen.get(row.winpid)?.startedAt !== startedAt) continue;
      if (this.groups.size >= LEDGER_MAX_GROUPS) return;
      this.groups.set(row.pgid, startedAt);
    }
  }

  /** Test seam: did a read record this pid? */
  has(pid: number): boolean {
    return this.seen.has(pid);
  }

  /**
   * What the ledger proves, for a file (#982): the recorded processes and Git Bash groups. The
   * root pin is left out – after a restart only what was recorded counts, never a pid to watch.
   */
  snapshot(): LedgerSnapshot {
    return {
      v: 1,
      seen: [...this.seen].map(([pid, entry]) => [pid, entry.startedAt, entry.lastSeenAt]),
      groups: [...this.groups],
    };
  }

  /**
   * A ledger from `snapshot()`'s output, or null for anything else. Read back after a crash
   * (#982); the same identity rules then decide, so a pid now held by a later process counts for
   * nothing. Bounded like a live ledger.
   */
  static restore(value: unknown): RunProcessLedger | null {
    if (typeof value !== 'object' || value === null) return null;
    const { v, seen, groups } = value as Partial<Record<keyof LedgerSnapshot, unknown>>;
    if (v !== 1 || !Array.isArray(seen) || !Array.isArray(groups)) return null;
    const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
    const ledger = new RunProcessLedger();
    for (const entry of seen.slice(0, LEDGER_MAX_ENTRIES)) {
      if (!Array.isArray(entry) || entry.length !== 3 || !entry.every(count)) return null;
      const [pid, startedAt, lastSeenAt] = entry as [number, number, number];
      ledger.seen.set(pid, { startedAt, lastSeenAt });
    }
    for (const entry of groups.slice(0, LEDGER_MAX_GROUPS)) {
      if (!Array.isArray(entry) || entry.length !== 2 || !entry.every(count)) return null;
      ledger.groups.set(entry[0] as number, entry[1] as number);
    }
    return ledger;
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
    if (this.seen.size >= LEDGER_MAX_ENTRIES) this.forgetStale(table);
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

  /**
   * Drop the processes no read has shown alive for `LEDGER_STALE_MS`; the pinned root stays. A
   * live row that started under a dropped process – the same rule `targets` applies to a recorded
   * parent – is recorded in its place, so a stop still proves it.
   */
  private forgetStale(table: ProcessTable): void {
    const root = this.root;
    const stale = new Map<number, Seen>();
    for (const [pid, entry] of this.seen) {
      if (root !== undefined && pid === root.pid && entry.startedAt === root.startedAt) continue;
      if (entry.lastSeenAt < table.queriedAt - LEDGER_STALE_MS) stale.set(pid, entry);
    }
    if (stale.size === 0) return;
    for (const pid of stale.keys()) this.seen.delete(pid);
    for (const row of table.rows) {
      const parent = stale.get(row.ppid);
      if (parent === undefined || row.startedAt === undefined || this.seen.has(row.pid)) continue;
      if (parent.startedAt <= row.startedAt && row.startedAt < parent.lastSeenAt) this.note({ pid: row.pid, startedAt: row.startedAt }, table.queriedAt);
    }
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
  targets(rows: readonly ProcRow[], excluded: (pid: number) => boolean, msys?: readonly MsysRow[]): IdentifiedProcess[] {
    const found = new Map<number, number>();
    for (const row of rows) {
      const entry = this.seen.get(row.pid);
      if (entry !== undefined && row.startedAt === entry.startedAt && !excluded(row.pid)) found.set(row.pid, row.startedAt);
    }
    for (const target of this.groupMembers(rows, excluded, msys ?? [])) found.set(target.pid, target.startedAt);
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
   * Windows (#963): the live members of the run's recorded MSYS groups, by Windows identity. A
   * member counts when its Windows process started no earlier than the group's leader did. A group
   * whose leader pid now names another live process (MSYS reused the pid) counts for nothing.
   */
  private groupMembers(rows: readonly ProcRow[], excluded: (pid: number) => boolean, msys: readonly MsysRow[]): IdentifiedProcess[] {
    if (this.groups.size === 0 || msys.length === 0) return [];
    const byPid = rowsByPid(rows);
    const reused = new Set<number>();
    for (const row of msys) {
      const leaderStart = this.groups.get(row.pid);
      if (leaderStart !== undefined && byPid.get(row.winpid)?.startedAt !== leaderStart) reused.add(row.pid);
    }
    const out: IdentifiedProcess[] = [];
    for (const row of msys) {
      const leaderStart = this.groups.get(row.pgid);
      if (leaderStart === undefined || reused.has(row.pgid) || excluded(row.winpid)) continue;
      const startedAt = byPid.get(row.winpid)?.startedAt;
      if (startedAt !== undefined && startedAt >= leaderStart) out.push({ pid: row.winpid, startedAt });
    }
    return out;
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
