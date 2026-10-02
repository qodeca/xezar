/**
 * Stopping a child and what it started (#963).
 *
 * POSIX: every helper sends exactly the signal its call site sent before – `child.kill(signal)`,
 * or `kill(-pid)` for the bounded probes that run in their own process group – byte for byte.
 *
 * Windows has no signals and no groups a signal can reach: `child.kill()` is TerminateProcess on
 * the handle Node holds, whatever the signal, and the child's own children live on. So a stop
 * kills the child at once, exactly as before, and then – only for a child `launch` started and
 * has not seen exit – one PowerShell (`readTableThenKill`) reads the process table and kills the
 * child's creation-filtered descendants by identity. `taskkill /T` is never used: it follows
 * parent pids that may by now name unrelated processes. A table that cannot be read leaves only
 * the child stopped, which is what every stop did before.
 *
 * Starting PowerShell blocks the event loop (about a second when cold, more under load), so a
 * descendant stop first lets the loop turn – the caller's own reply or exit handling never waits
 * behind it – starts PowerShell once, not once to read and again to kill, and runs once per
 * child: the TERM and the KILL of one stop share one helper.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { isOwnChild, trackedChildren, trackedEntry, type RegisteredChild } from './child-registry.ts';
import { descendantTargets, type IdentifiedPid, type ProcessTable } from './process-table.ts';
import { readTableThenKill } from './table-then-kill.ts';

/** The signals xezar sends to stop a child. */
export type StopSignal = 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP' | 'SIGBREAK';

/** The slice of `ChildProcess` a stop needs. */
export type StoppableChild = RegisteredChild;

/** Test seams. Production passes none. */
export interface TreeStopDeps {
  platform: NodeJS.Platform;
  isOwnChild: (child: unknown) => boolean;
  /** One table read, then an identified kill of what `choose` picks from it (`readTableThenKill`). */
  readThenKill: (
    choose: (table: ProcessTable) => readonly IdentifiedPid[],
    opts: { timeoutMs: number },
  ) => Promise<unknown>;
  now: () => number;
}

/** How long a descendant stop's one PowerShell may take for the table and the kill together –
 *  what the separate read (5 s) and kill (5 s) were allowed before. */
export const TREE_STOP_TIMEOUT_MS = 10_000;

/** The grace between each step of a process-group stop (#888, #892). */
export const PROCESS_GROUP_GRACE_MS = 1_000;

/** Windows reports exit code 1 for a process stopped with TerminateProcess – every `kill()`. */
export const TREE_STOP_EXIT_CODE = 1;

/** The signals Node can deliver on Windows (each one terminates); any other stops as SIGTERM. */
const WINDOWS_DELIVERABLE: ReadonlySet<StopSignal> = new Set<StopSignal>(['SIGTERM', 'SIGKILL', 'SIGINT']);

const DONE: Promise<void> = Promise.resolve();

/** The one descendant stop each child gets, however many times it is stopped. */
const descendantStops = new WeakMap<RegisteredChild, Promise<void>>();

/** A stopped root: its pid and the window its direct children were created in. */
interface StoppedRoot {
  pid: number;
  spawnedAt: number;
  stoppedAt: number;
}

function hasExited(child: RegisteredChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolves after the event loop has turned once. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The descendants of every root in `roots`, from ONE table read, killed by identity – both in one
 * PowerShell. Never rejects: a missing table or a throw leaves only the roots stopped.
 */
async function stopDescendantsOf(roots: readonly StoppedRoot[], deps: Partial<TreeStopDeps>): Promise<void> {
  try {
    await nextTurn();
    // An overlap between two trees is harmless: the kill takes each pid once.
    const choose = (table: ProcessTable): IdentifiedPid[] => roots.flatMap((root) => descendantTargets(table.rows, root));
    await (deps.readThenKill ?? readTableThenKill)(choose, { timeoutMs: TREE_STOP_TIMEOUT_MS });
  } catch {
    // only the roots are stopped – what every stop did before
  }
}

/**
 * Stop `child` with `signal`. POSIX: `child.kill(signal)`, nothing else. win32: nothing once the
 * exit was seen (the pid may already be someone else's); otherwise `child.kill` at once, then its
 * descendants as described above – once per child: a later stop of the same child kills it again
 * and shares the first one's descendant stop. The promise resolves when that is done and never
 * rejects; a call site may ignore it.
 */
export function stopChildTree(
  child: StoppableChild,
  signal: StopSignal,
  deps: Partial<TreeStopDeps> = {},
): Promise<void> {
  if ((deps.platform ?? process.platform) !== 'win32') {
    child.kill(signal);
    return DONE;
  }
  if (hasExited(child)) return DONE;
  const stoppedAt = (deps.now ?? Date.now)();
  child.kill(WINDOWS_DELIVERABLE.has(signal) ? signal : 'SIGTERM');
  if (child.pid === undefined || !(deps.isOwnChild ?? isOwnChild)(child)) return DONE;
  const entry = trackedEntry(child);
  if (!entry) return DONE;
  const pending = descendantStops.get(child);
  if (pending) return pending;
  const stopping = stopDescendantsOf([{ pid: child.pid, spawnedAt: entry.spawnedAt, stoppedAt }], deps);
  descendantStops.set(child, stopping);
  return stopping;
}

/**
 * The Windows `serve` shutdown: `kill()` every tracked child that has not exited, then ONE
 * PowerShell reads one snapshot and kills all their creation-filtered descendants – never one per
 * root. Null – nothing to wait for – off Windows or when no tracked child is running. Resolves,
 * never rejects.
 */
export function stopTrackedProcessTrees(deps: Partial<TreeStopDeps> = {}): Promise<void> | null {
  if ((deps.platform ?? process.platform) !== 'win32') return null;
  const roots = trackedChildren().filter(({ child }) => !hasExited(child) && child.pid !== undefined);
  if (roots.length === 0) return null;
  const stoppedAt = (deps.now ?? Date.now)();
  for (const { child } of roots) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  const stopping = stopDescendantsOf(
    roots.map(({ child, spawnedAt }) => ({ pid: child.pid!, spawnedAt, stoppedAt })),
    deps,
  );
  // A runner's own stop arriving now shares this read rather than starting another.
  for (const { child } of roots) if (!descendantStops.has(child)) descendantStops.set(child, stopping);
  return stopping;
}

/**
 * Signal the process group `child` leads (it was spawned `detached: true`). POSIX: `kill(-pid)`,
 * falling back to the child itself when the group is already gone. win32: `stopChildTree`.
 * Never throws.
 */
export function signalProcessGroup(
  child: StoppableChild,
  signal: StopSignal,
  deps: Partial<TreeStopDeps> = {},
): void {
  if (child.pid === undefined) return;
  try {
    if ((deps.platform ?? process.platform) === 'win32') void stopChildTree(child, signal, deps);
    else process.kill(-child.pid, signal);
  } catch {
    // The group may already have closed between the reply and the signal. Falling back to the
    // saved child handle is safe and keeps a timer callback from becoming an uncaught exception.
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * The bounded escalation for a process group: SIGTERM now, SIGKILL after `graceMs`, `onSettle()`
 * after another `graceMs` – so the caller settles even when no exit ever arrives. Both timers are
 * unref'd. Returns the cancel, which clears whichever timers are still pending.
 */
export function stopProcessGroup(
  child: StoppableChild,
  graceMs: number,
  onSettle: () => void,
  deps: Partial<TreeStopDeps> = {},
): () => void {
  let settleTimer: NodeJS.Timeout | undefined;
  signalProcessGroup(child, 'SIGTERM', deps);
  const killTimer = setTimeout(() => {
    signalProcessGroup(child, 'SIGKILL', deps);
    settleTimer = setTimeout(() => onSettle(), graceMs);
    settleTimer.unref?.();
  }, graceMs);
  killTimer.unref?.();
  return () => {
    clearTimeout(killTimer);
    if (settleTimer) clearTimeout(settleTimer);
  };
}

/** win32: is `exitCode` what a stop through `kill()` leaves behind? Always false elsewhere. */
export function isTreeStopExit(
  exitCode: number | null,
  deps: { platform?: NodeJS.Platform } = {},
): boolean {
  return (deps.platform ?? process.platform) === 'win32' && exitCode === TREE_STOP_EXIT_CODE;
}
