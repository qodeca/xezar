/**
 * What one sweep did to each process it claimed (#943), in the order it claimed them, and the
 * redacted command line it will name each by. Only redacted text is kept: a raw command line is
 * handed to `name()` and never stored.
 */
import type { SignalOutcome } from '../platform/process-table.ts';
import {
  REPORT_LIST_MAX,
  redactCommandLine,
  type ReportedProcess,
  type SweepOutcome,
  type UnstoppableReason,
} from './run-process-report.ts';

type ProcessState = 'claimed' | 'pending' | 'stopped' | UnstoppableReason;

/** Two lists of `REPORT_LIST_MAX`: no more command lines are worth reading. */
const NAMES_MAX = 2 * REPORT_LIST_MAX;

export class SweepRecord {
  private readonly states = new Map<number, ProcessState>();
  private readonly names = new Map<number, string>();
  private isClosed = false;

  get closed(): boolean {
    return this.isClosed;
  }

  /** The sweep has ended (done, or at its cap): nothing changes any more. */
  close(): void {
    this.isClosed = true;
  }

  /** Take `pid` for this sweep; false when an earlier pass already did – each pid is handled once. */
  claim(pid: number): boolean {
    if (this.isClosed || this.states.has(pid)) return false;
    this.states.set(pid, 'claimed');
    return true;
  }

  wantsName(pid: number): boolean {
    return !this.names.has(pid) && this.names.size < NAMES_MAX;
  }

  /** Keep the redacted form of `command` only. */
  name(pid: number, command: string, secretValues: readonly string[]): void {
    if (this.isClosed || !this.states.has(pid) || !this.wantsName(pid)) return;
    this.names.set(pid, redactCommandLine(command, secretValues));
  }

  /** A signal was sent (awaiting the exit), or it found the process gone or out of reach.
   *  True when the process may still be alive and should be watched. */
  signalled(pid: number, outcome: SignalOutcome): boolean {
    if (outcome === 'sent') this.pendingStop(pid);
    else if (outcome === 'gone') this.stopped(pid);
    else this.unstoppable(pid, 'access-denied');
    return outcome === 'sent';
  }

  /** Asked to stop; until confirmed, the report calls it still running. */
  pendingStop(pid: number): void {
    this.set(pid, 'pending');
  }

  stopped(pid: number): void {
    this.set(pid, 'stopped');
  }

  unstoppable(pid: number, reason: UnstoppableReason): void {
    this.set(pid, reason);
  }

  /** Stopped and unstoppable processes, named; a process never asked to stop is left out. */
  outcome(): SweepOutcome {
    const stopped: ReportedProcess[] = [];
    const unstoppable: Array<ReportedProcess & { reason: UnstoppableReason }> = [];
    for (const [pid, state] of this.states) {
      const command = this.names.get(pid);
      const reported: ReportedProcess = command === undefined ? { pid } : { pid, command };
      if (state === 'stopped') stopped.push(reported);
      else if (state === 'pending') unstoppable.push({ ...reported, reason: 'still-running' });
      else if (state !== 'claimed') unstoppable.push({ ...reported, reason: state });
    }
    return { stopped, unstoppable };
  }

  private set(pid: number, state: ProcessState): void {
    if (!this.isClosed && this.states.has(pid)) this.states.set(pid, state);
  }
}
