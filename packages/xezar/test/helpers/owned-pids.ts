/**
 * The pids a real-process test started but holds no handle for – a grandchild, a detached server
 * (#963 T-04). Cleanup stops each one only while its number still names the process the test saw:
 * once a process is gone, Windows and POSIX hand its pid to the next process that asks, which may
 * be anyone's. So a pid the test saw exit is forgotten at once, and the rest are identity-checked.
 *
 * Identity: on Linux and macOS the start time `startTimeOf` reads when the test first sees the
 * pid, compared again right before the signal. On Windows one process table at cleanup (only when
 * something is left): a later holder of the number was created after the seen process exited, so
 * after the test saw it alive; a row that started no later than that is the same process, and it
 * is stopped through `killIdentified`, which checks the start time once more on the handle it kills.
 */
import { STOP_CLOCK_SLACK_MS, killIdentified, readProcessTable, startTimeOf } from '../../src/platform/process-table.ts';

/** One PowerShell table read (cold, under load) and one identified kill. */
const WINDOWS_CLEANUP_TIMEOUT_MS = 10_000;

interface Seen {
  /** ms since the epoch at which the process was known to be alive. */
  seenAt: number;
  /** POSIX: its start time then (null: not readable – it is never signalled). */
  identity: Promise<number | null>;
}

export class OwnedPids {
  private readonly owned = new Map<number, Seen>();

  /** The test knows these pids were alive at `seenAt` (default: now). */
  add(pids: readonly number[], seenAt = Date.now()): void {
    for (const pid of pids) {
      const identity = process.platform === 'win32' ? Promise.resolve(null) : startTimeOf(pid).catch(() => null);
      this.owned.set(pid, { seenAt, identity });
    }
  }

  /** The test saw these exit: their numbers are never signalled again. */
  gone(...pids: number[]): void {
    for (const pid of pids) this.owned.delete(pid);
  }

  /** Stop every pid still owned, each only while it is the process that was seen. Never throws. */
  async stopAll(): Promise<void> {
    const owned = [...this.owned];
    this.owned.clear();
    if (owned.length === 0) return;
    try {
      if (process.platform === 'win32') await stopOnWindows(owned);
      else await stopOnPosix(owned);
    } catch {
      // best effort: a cleanup never fails the test it follows
    }
  }
}

async function stopOnWindows(owned: ReadonlyArray<[number, Seen]>): Promise<void> {
  const table = await readProcessTable({ timeoutMs: WINDOWS_CLEANUP_TIMEOUT_MS });
  if (table === null) return;
  const targets: Array<{ pid: number; startedAt: number }> = [];
  for (const [pid, { seenAt }] of owned) {
    const row = table.rows.find((candidate) => candidate.pid === pid);
    if (row?.startedAt !== undefined && row.startedAt <= seenAt + STOP_CLOCK_SLACK_MS) targets.push({ pid, startedAt: row.startedAt });
  }
  if (targets.length > 0) await killIdentified(targets);
}

async function stopOnPosix(owned: ReadonlyArray<[number, Seen]>): Promise<void> {
  for (const [pid, { identity }] of owned) {
    const seen = await identity;
    if (seen === null || (await startTimeOf(pid)) !== seen) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone between the check and the signal
    }
  }
}
