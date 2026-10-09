/**
 * Stop what a run started when xezar stops the run (#943): a memory-limit pause, a cancel, a
 * step's time limit. The agent's own process tree is stopped by its runner; this sweep finds
 * what outlived it or left it – a dev server started in the background, a watcher – and stops
 * those too, then leaves one note naming them.
 *
 * Attribution, never by name, working folder, command line or port:
 *  - Linux: a process whose environment holds exactly `XEZ_TASK_ID=<runId>`, the marker every
 *    agent of the run carries and its children inherit (`envHasEntry`, bracketed by two reads
 *    of the start time so the answer belongs to one process).
 *  - Windows and macOS: the run's ledger (`run-process-ledger.ts`), fed by the sampler's reads.
 *    macOS is best effort: a process that detached and lost its parent between two reads is
 *    never recorded.
 * xezar itself, its ancestors and the system's own pids are never targets.
 *
 * This is best-effort cleanup, not a containment boundary, and the marker is never used to
 * authorise anything. A pid is signalled only while its start time still matches (POSIX: read
 * again right before each signal; Windows: checked and killed through one handle).
 *
 * One sweep per run at a time: a second trigger chains after the first. Each sweep is capped
 * at `SWEEP_CAP_MS`: `pending()` answers until then, and the cap timer is ref'd, so a headless
 * `xezar run` cannot exit mid-sweep (#793), and cleared when the sweep ends. A pass still running
 * at the cap finishes on its own bounded timeouts (best effort) and signals only targets it chose
 * before, each by identity; nothing waits for it.
 */
import { onProcessTable } from '../core/process-usage.ts';
import { collectSecretValues } from '../core/secret-redaction.ts';
import {
  RUN_MARKER_ENV,
  envHasEntry,
  nameAndKillIdentified,
  pidExists,
  readCommandLines,
  type NamedKill,
} from '../platform/process-proof.ts';
import {
  killIdentified,
  readProcessTable,
  signalPid,
  startTimeOf,
  systemPidFloor,
  type IdentifiedPid,
  type KillOutcome,
  type ProcRow,
  type ProcessTable,
  type ReadTableOptions,
  type SignalOutcome,
} from '../platform/process-table.ts';
import { RunProcessLedger } from './run-process-ledger.ts';
import { SweepRecord } from './run-process-sweep-record.ts';
import { buildSweepReport, rootNotConfirmedNote } from './run-process-report.ts';

/** Why xezar stopped the run. A `timeout` keeps the ledger (the run goes on); the others end
 *  the run's current life, so its ledger is handed to the sweep and a Continue starts afresh. */
/** The environment entry every agent of a run carries; it lives with the rest of the proof. */
export { RUN_MARKER_ENV };

export type SweepReason = 'memory-limit' | 'cancel' | 'timeout';

export const SWEEP_CAP_MS = 10_000;
const MAX_PASSES = 3;
const TERM_GRACE_MS = 2_000;
const POLL_MS = 100;
const KILL_SETTLE_MS = 500;
const WINDOWS_VERIFY_MS = 1_000;
const TABLE_TIMEOUT_MS = 5_000;
/** `/proc` reads in flight at once while looking for the marker. */
const ENV_READ_BATCH = 32;

/** One process the sweep may stop: its pid and the start time it had when attributed. */
interface Target {
  pid: number;
  /** Linux: `/proc` start ticks; Windows and macOS: `startedAt` in ms. */
  identity: number;
}

export interface RunProcessSweeperOptions {
  /** Append the note. Never called after `dispose()`. */
  report: (runId: string, text: string) => void;
  /** Enrol each sweep so teardown can wait for it (`RunManager.trackRun`). */
  track?: (sweep: Promise<void>) => void;
}

/** Test seams. Production passes none. */
export interface RunProcessSweeperDeps {
  platform?: NodeJS.Platform;
  subscribe?: (listener: (table: ProcessTable) => void) => () => void;
  readTable?: (opts: ReadTableOptions) => Promise<ProcessTable | null>;
  envHasEntry?: (pid: number, entry: string) => Promise<boolean>;
  startTimeOf?: (pid: number) => Promise<number | null>;
  pidExists?: (pid: number) => boolean;
  signalPid?: (pid: number, signal: NodeJS.Signals) => SignalOutcome;
  killIdentified?: (targets: readonly IdentifiedPid[]) => Promise<Map<number, KillOutcome> | null>;
  readCommandLines?: (pids: readonly number[]) => Promise<Map<number, string>>;
  secretValues?: () => readonly string[];
  selfPid?: number;
  capMs?: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** xezar itself and every ancestor it can see in `rows`. */
function selfAndAncestors(rows: readonly ProcRow[], selfPid: number): Set<number> {
  const parentOf = new Map<number, number>();
  for (const row of rows) parentOf.set(row.pid, row.ppid);
  const out = new Set<number>();
  for (let pid: number | undefined = selfPid; pid !== undefined && !out.has(pid); pid = parentOf.get(pid)) out.add(pid);
  return out;
}

export class RunProcessSweeper {
  private readonly platform: NodeJS.Platform;
  private readonly ledgers = new Map<string, RunProcessLedger>();
  private readonly sweeps = new Map<string, Promise<void>>();
  private readonly unsubscribe: () => void;
  private secrets: readonly string[] | undefined;
  private disposed = false;

  constructor(
    private readonly options: RunProcessSweeperOptions,
    private readonly deps: RunProcessSweeperDeps = {},
  ) {
    this.platform = deps.platform ?? process.platform;
    // Linux proves attribution from `/proc`; only the other systems need the sampler's reads.
    this.unsubscribe = this.usesLedger() ? (deps.subscribe ?? onProcessTable)((table) => this.record(table)) : () => undefined;
  }

  /** The run's agent process, beside `registerRunProcess`. `spawnedAt`: ms since the epoch,
   *  as close to the spawn as the caller knows it. Linux: nothing to record. */
  pinRoot(runId: string, pid: number, spawnedAt: number): void {
    if (!this.usesLedger() || this.disposed) return;
    let ledger = this.ledgers.get(runId);
    if (ledger === undefined) {
      ledger = new RunProcessLedger();
      this.ledgers.set(runId, ledger);
    }
    ledger.pin(pid, spawnedAt);
  }

  /** Test seam: has the run's ledger recorded this pid? Always false on Linux. */
  ledgerHas(runId: string, pid: number): boolean {
    return this.ledgers.get(runId)?.has(pid) ?? false;
  }

  /** Sweep in the background (the run left the active set); enrolled through `track`. */
  start(runId: string, reason: SweepReason): void {
    void this.schedule(runId, reason);
  }

  /** Sweep and wait for it (a step's time limit). Never rejects. */
  now(runId: string, reason: SweepReason): Promise<void> {
    return this.schedule(runId, reason);
  }

  /** The sweep still running or queued for this run, if any. */
  pending(runId: string): Promise<void> | undefined {
    return this.sweeps.get(runId);
  }

  /** Forget the run's ledger (it ended without a stop). A pending sweep carries on. */
  drop(runId: string): void {
    this.ledgers.delete(runId);
  }

  /** Stop recording and reporting. A pending sweep still stops its targets but appends nothing. */
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.ledgers.clear();
  }

  private usesLedger(): boolean {
    return this.platform !== 'linux';
  }

  /** One sampler read into every ledger. A root a read rejects is said once, in the run's notes. */
  private record(table: ProcessTable): void {
    for (const [runId, ledger] of this.ledgers) {
      const rejected = ledger.record(table);
      if (rejected !== undefined && !this.disposed) this.options.report(runId, rootNotConfirmedNote(rejected));
    }
  }

  private schedule(runId: string, reason: SweepReason): Promise<void> {
    const ledger = this.ledgers.get(runId);
    if (reason !== 'timeout') this.ledgers.delete(runId);
    const previous = this.sweeps.get(runId) ?? Promise.resolve();
    const sweep = previous.then(() => this.sweep(runId, ledger)).catch(() => undefined);
    this.sweeps.set(runId, sweep);
    void sweep.finally(() => {
      if (this.sweeps.get(runId) === sweep) this.sweeps.delete(runId);
    });
    this.options.track?.(sweep);
    return sweep;
  }

  private async sweep(runId: string, ledger: RunProcessLedger | undefined): Promise<void> {
    const record = new SweepRecord();
    let cap: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.passes(runId, ledger, record).catch(() => undefined),
        new Promise<void>((resolve) => {
          cap = setTimeout(resolve, this.deps.capMs ?? SWEEP_CAP_MS);
        }),
      ]);
    } finally {
      clearTimeout(cap);
      record.close();
    }
    if (this.disposed) return;
    const text = buildSweepReport(record.outcome());
    if (text !== null) this.options.report(runId, text);
  }

  /** Scan, stop, and scan again – a supervisor may have restarted what was stopped. */
  private async passes(runId: string, ledger: RunProcessLedger | undefined, record: SweepRecord): Promise<void> {
    // Windows and macOS prove nothing without a recorded ledger: skip the table read (PowerShell).
    if (this.usesLedger() && (ledger === undefined || ledger.isEmpty)) return;
    const deadline = Date.now() + (this.deps.capMs ?? SWEEP_CAP_MS);
    for (let pass = 0; pass < MAX_PASSES && !record.closed && Date.now() < deadline; pass += 1) {
      const readTable = this.deps.readTable ?? readProcessTable;
      const table = await readTable({ timeoutMs: Math.max(1, Math.min(TABLE_TIMEOUT_MS, deadline - Date.now())) });
      if (table === null || record.closed) return;
      const targets = (await this.attribute(runId, table, ledger)).filter((target) => record.claim(target.pid));
      if (targets.length === 0) return;
      if (this.platform === 'win32') await this.stopWindows(targets, record);
      else {
        await this.name(targets, record);
        await this.stopPosix(targets, record);
      }
    }
  }

  private async attribute(runId: string, table: ProcessTable, ledger: RunProcessLedger | undefined): Promise<Target[]> {
    const own = selfAndAncestors(table.rows, this.deps.selfPid ?? process.pid);
    const floor = systemPidFloor({ platform: this.platform });
    const excluded = (pid: number): boolean => pid <= floor || own.has(pid);
    if (!this.usesLedger()) return this.markedTargets(runId, table.rows.filter((row) => !excluded(row.pid)));
    if (ledger === undefined) return [];
    return ledger.targets(table.rows, excluded).map(({ pid, startedAt }) => ({ pid, identity: startedAt }));
  }

  /** Linux: the rows whose environment carries the run's marker. */
  private async markedTargets(runId: string, rows: readonly ProcRow[]): Promise<Target[]> {
    const entry = `${RUN_MARKER_ENV}=${runId}`;
    const out: Target[] = [];
    for (let from = 0; from < rows.length; from += ENV_READ_BATCH) {
      const batch = rows.slice(from, from + ENV_READ_BATCH);
      const proven = await Promise.all(batch.map((row) => this.provenMarked(row.pid, entry)));
      for (const target of proven) if (target !== null) out.push(target);
    }
    return out;
  }

  /** Marked, and the same process before and after the second read of its environment. */
  private async provenMarked(pid: number, entry: string): Promise<Target | null> {
    const read = this.deps.envHasEntry ?? ((p: number, e: string) => envHasEntry(p, e));
    const hasEntry = (): Promise<boolean> => read(pid, entry).catch(() => false);
    if (!(await hasEntry())) return null;
    const before = await this.identityOf(pid);
    if (before === null || !(await hasEntry())) return null;
    return (await this.identityOf(pid)) === before ? { pid, identity: before } : null;
  }

  private identityOf(pid: number): Promise<number | null> {
    return (this.deps.startTimeOf ?? ((p: number) => startTimeOf(p)))(pid).catch(() => null);
  }

  /** Read and redact the targets' command lines before they are stopped – after, they are gone. */
  private async name(targets: readonly Target[], record: SweepRecord): Promise<void> {
    const unnamed = this.unnamed(targets, record);
    if (unnamed.length === 0) return;
    const read = this.deps.readCommandLines ?? ((pids: readonly number[]) => readCommandLines(pids));
    this.recordNames(await read(unnamed).catch(() => new Map<number, string>()), record);
  }

  private unnamed(targets: readonly Target[], record: SweepRecord): number[] {
    return targets.map(({ pid }) => pid).filter((pid) => record.wantsName(pid));
  }

  private recordNames(commands: ReadonlyMap<number, string>, record: SweepRecord): void {
    this.secrets ??= this.deps.secretValues?.() ?? collectSecretValues();
    for (const [pid, command] of commands) record.name(pid, command, this.secrets);
  }

  /**
   * Windows: name, then kill by identity. Production does both in ONE PowerShell
   * (`nameAndKillIdentified`): two in a row took longer than the sweep's cap on a busy machine
   * (#963). A test that passes its own seams gets them called in the same order.
   */
  private async nameAndKill(targets: readonly Target[], record: SweepRecord): Promise<NamedKill['outcomes']> {
    const list = targets.map(({ pid, identity }) => ({ pid, startedAt: identity }));
    const unnamed = this.unnamed(targets, record);
    if (this.deps.killIdentified === undefined && this.deps.readCommandLines === undefined) {
      const { commands, outcomes } = await nameAndKillIdentified(list, unnamed).catch(
        (): NamedKill => ({ commands: new Map(), outcomes: null }),
      );
      this.recordNames(commands, record);
      return outcomes;
    }
    await this.name(targets, record);
    const kill = this.deps.killIdentified ?? ((pids: readonly IdentifiedPid[]) => killIdentified(pids));
    return kill(list).catch(() => null);
  }

  /** POSIX: SIGTERM, up to 2 s to leave, SIGKILL for who stayed, 500 ms to settle. */
  private async stopPosix(targets: readonly Target[], record: SweepRecord): Promise<void> {
    const signal = this.deps.signalPid ?? signalPid;
    const exists = this.deps.pidExists ?? pidExists;
    const termed: Target[] = [];
    for (const target of targets) {
      if (record.closed) return;
      if ((await this.identityOf(target.pid)) !== target.identity) continue; // gone, or someone else's now
      if (record.signalled(target.pid, signal(target.pid, 'SIGTERM'))) termed.push(target);
    }
    let alive = termed;
    for (const until = Date.now() + TERM_GRACE_MS; alive.length > 0 && !record.closed && Date.now() < until; ) {
      await delay(POLL_MS);
      alive = alive.filter((target) => {
        if (exists(target.pid)) return true;
        record.stopped(target.pid);
        return false;
      });
    }
    const killed: Target[] = [];
    for (const target of alive) {
      if (record.closed) return;
      if ((await this.identityOf(target.pid)) !== target.identity) record.stopped(target.pid);
      else if (record.signalled(target.pid, signal(target.pid, 'SIGKILL'))) killed.push(target);
    }
    if (killed.length === 0) return;
    await delay(KILL_SETTLE_MS);
    for (const target of killed) {
      const still = exists(target.pid) && (await this.identityOf(target.pid)) === target.identity;
      if (still) record.unstoppable(target.pid, 'still-running');
      else record.stopped(target.pid);
    }
  }

  /** Windows: name and kill by identity through one handle, then a fresh table 1 s later confirms. */
  private async stopWindows(targets: readonly Target[], record: SweepRecord): Promise<void> {
    const outcomes = await this.nameAndKill(targets, record);
    const toVerify: Target[] = [];
    for (const target of targets) {
      const outcome = outcomes?.get(target.pid);
      if (outcome === 'mismatch') continue; // the pid is someone else's now
      if (outcome === 'gone') record.stopped(target.pid);
      else if (outcome === 'denied') record.unstoppable(target.pid, 'access-denied');
      else {
        record.pendingStop(target.pid);
        toVerify.push(target);
      }
    }
    if (toVerify.length === 0 || record.closed) return;
    // A pid that no longer exists is stopped: no table needed. Only a pid that still exists (the
    // same process, or by now a stranger's) costs a table read (#963: each PowerShell run takes
    // seconds on a busy machine, and the whole sweep has 10).
    const exists = this.deps.pidExists ?? pidExists;
    let present = toVerify;
    for (const until = Date.now() + WINDOWS_VERIFY_MS; present.length > 0 && !record.closed && Date.now() < until; ) {
      await delay(POLL_MS);
      present = present.filter((target) => {
        if (exists(target.pid)) return true;
        record.stopped(target.pid);
        return false;
      });
    }
    if (present.length === 0 || record.closed) return;
    const table = await (this.deps.readTable ?? readProcessTable)({ timeoutMs: TABLE_TIMEOUT_MS });
    const live = new Set((table?.rows ?? []).map((row) => `${row.pid}:${row.startedAt}`));
    for (const target of present) {
      const unconfirmed = table === null ? outcomes?.get(target.pid) !== 'killed' : live.has(`${target.pid}:${target.identity}`);
      if (unconfirmed) record.unstoppable(target.pid, 'still-running');
      else record.stopped(target.pid);
    }
  }
}
