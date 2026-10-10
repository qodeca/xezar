/**
 * A fake machine for `RunProcessSweeper` tests (#943): processes with parents, start times, an
 * environment and a command line, which answer the sweeper's seams the way the OS would. The
 * Linux marker is proved by the REAL `envHasEntry` over the fake environment bytes, so decoys
 * exercise the exact-entry rule itself.
 */
import { Buffer } from 'node:buffer';
import { envHasEntry } from '../platform/process-proof.ts';
import type { KillOutcome, ProcessTable, SignalOutcome } from '../platform/process-table.ts';
import type { RunProcessSweeperDeps } from './run-process-sweeper.ts';

export interface FakeProcess {
  pid: number;
  ppid: number;
  /** ms since the epoch: the table's `startedAt`, and the identity on Windows and macOS. */
  startedAt: number;
  environ?: string[];
  cmdline?: string;
  alive?: boolean;
  /** Survives this signal (a process that traps SIGTERM, or a stuck one that survives SIGKILL). */
  survives?: ReadonlyArray<'SIGTERM' | 'SIGKILL'>;
  /** Signalling or killing it is not permitted (another user's process). */
  denied?: boolean;
  /** Linux: after this many start-time reads the pid names a newer process (pid reuse). */
  reusedAfterReads?: number;
  /** Windows: its row in Git's `ps` – MSYS pid, parent and process group (#963). */
  msys?: { pid: number; ppid: number; pgid: number };
  /** Called when it dies – a supervisor restarting it, say. */
  onDeath?: (machine: FakeMachine) => void;
}

export class FakeMachine {
  readonly processes = new Map<number, FakeProcess>();
  readonly signals: Array<[number, string]> = [];
  readonly killRequests: Array<Array<{ pid: number; startedAt: number }>> = [];
  readonly identityReads = new Map<number, number>();
  /** Reads of Git's `ps`; `hasGit: false` answers each with null (no Git for Windows). */
  msysReads = 0;
  hasGit = true;
  private listener: ((table: ProcessTable) => void) | undefined;

  constructor(
    readonly platform: NodeJS.Platform,
    readonly selfPid: number,
  ) {}

  add(...processes: FakeProcess[]): this {
    for (const proc of processes) this.processes.set(proc.pid, { alive: true, ...proc });
    return this;
  }

  isAlive(pid: number): boolean {
    return this.processes.get(pid)?.alive === true;
  }

  table(): ProcessTable {
    const rows = [...this.processes.values()]
      .filter((proc) => proc.alive)
      .map(({ pid, ppid, startedAt }) => ({ pid, ppid, rssKb: 1, cpuPct: 0, startedAt }));
    return { rows, queriedAt: Date.now() };
  }

  /** One sampler tick, as `onProcessTable` delivers it. */
  tick(): void {
    this.listener?.(this.table());
  }

  get subscribed(): boolean {
    return this.listener !== undefined;
  }

  private die(proc: FakeProcess): void {
    proc.alive = false;
    proc.onDeath?.(this);
  }

  private identityOf(pid: number): number | null {
    const proc = this.processes.get(pid);
    if (!proc?.alive) return null;
    const reads = (this.identityReads.get(pid) ?? 0) + 1;
    this.identityReads.set(pid, reads);
    const reused = proc.reusedAfterReads !== undefined && reads > proc.reusedAfterReads;
    return proc.startedAt + (reused ? 60_000 : 0);
  }

  private signal(pid: number, signal: NodeJS.Signals): SignalOutcome {
    this.signals.push([pid, signal]);
    const proc = this.processes.get(pid);
    if (!proc?.alive) return 'gone';
    if (proc.denied) return 'denied';
    if (!(proc.survives ?? []).includes(signal as 'SIGTERM' | 'SIGKILL')) this.die(proc);
    return 'sent';
  }

  private kill(targets: ReadonlyArray<{ pid: number; startedAt: number }>): Map<number, KillOutcome> {
    this.killRequests.push([...targets]);
    const out = new Map<number, KillOutcome>();
    for (const { pid, startedAt } of targets) {
      const proc = this.processes.get(pid);
      if (!proc?.alive) out.set(pid, 'gone');
      else if (proc.startedAt !== startedAt) out.set(pid, 'mismatch');
      else if (proc.denied) out.set(pid, 'denied');
      else {
        if (!(proc.survives ?? []).includes('SIGKILL')) this.die(proc);
        out.set(pid, 'killed');
      }
    }
    return out;
  }

  private environBytes(path: string): Buffer {
    const pid = Number(/^\/proc\/(\d+)\/environ$/.exec(path)?.[1]);
    const proc = this.processes.get(pid);
    if (!proc?.alive) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return Buffer.from((proc.environ ?? []).map((entry) => `${entry}\0`).join(''), 'utf8');
  }

  deps(overrides: Partial<RunProcessSweeperDeps> = {}): RunProcessSweeperDeps {
    return {
      platform: this.platform,
      selfPid: this.selfPid,
      subscribe: (listener) => {
        this.listener = listener;
        return () => {
          this.listener = undefined;
        };
      },
      readTable: async () => this.table(),
      readMsys: async () => {
        this.msysReads += 1;
        if (!this.hasGit) return null;
        return [...this.processes.values()]
          .filter((proc) => proc.alive && proc.msys !== undefined)
          .map((proc) => ({ ...proc.msys!, winpid: proc.pid }));
      },
      envHasEntry: (pid, entry) => envHasEntry(pid, entry, { platform: 'linux', readBytes: async (path) => this.environBytes(path) }),
      startTimeOf: async (pid) => this.identityOf(pid),
      pidExists: (pid) => this.isAlive(pid),
      signalPid: (pid, signal) => this.signal(pid, signal),
      killIdentified: async (targets) => this.kill(targets),
      readCommandLines: async (pids) => {
        const out = new Map<number, string>();
        for (const pid of pids) {
          const command = this.processes.get(pid)?.cmdline;
          if (this.isAlive(pid) && command !== undefined) out.set(pid, command);
        }
        return out;
      },
      secretValues: () => [],
      ...overrides,
    };
  }
}
