/**
 * Which signals mean "shut down", and leaving after the started programs are stopped (#963).
 *
 * POSIX: SIGINT and SIGTERM, in that order – exactly the two listeners `serve` and the gate lease
 * always installed – and exit at once. Windows adds SIGBREAK (Ctrl+Break) and SIGHUP (the console
 * window closing, which leaves about 5 seconds), and on the way out stops the programs xezar
 * started, for at most a few seconds. xezar's direct children would end with it anyway – libuv
 * starts them in a job object that is closed when xezar exits – but what THEY started outside that
 * job (a detached server, the children of a shell or a native CLI) would not: the descendant stop
 * is the load-bearing part. Because the stop kills the direct children early, while xezar still
 * runs, the run managers are held first (`beforeStop`), so those exits are not recorded.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { stopTrackedProcessTrees } from './process-tree.ts';

export type ShutdownSignal = 'SIGINT' | 'SIGTERM' | 'SIGBREAK' | 'SIGHUP';

const POSIX_SHUTDOWN: readonly ShutdownSignal[] = ['SIGINT', 'SIGTERM'];
const WINDOWS_SHUTDOWN: readonly ShutdownSignal[] = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];

/**
 * How long a Windows shutdown waits for the started programs to stop. The stop is one PowerShell
 * (table read and identified kill): measured 1.6-2 s on an idle machine and 4-6.7 s with 16 busy
 * programs on 16 cores (C-02; 3 s missed every loaded run). Closing the console window (SIGHUP)
 * leaves only about 5 seconds (5000 ms by default) before Windows ends xezar, which is less than
 * this bound, so on a busy machine a closed window can end xezar before every started program is
 * stopped; Ctrl+C or Ctrl+Break waits for the full cleanup. The exit comes as soon as the stop is
 * done; a second Ctrl+C exits at once.
 */
export const SHUTDOWN_TREE_STOP_BOUND_MS = 8_000;

/** Where the listeners go; `process` in production. */
export interface SignalTarget {
  on(event: ShutdownSignal, listener: () => void): unknown;
  off(event: ShutdownSignal, listener: () => void): unknown;
}

export interface ShutdownSignalDeps {
  platform?: NodeJS.Platform;
  target?: SignalTarget;
}

/** The shutdown signals of `platform`, in the order their listeners are installed. */
export function shutdownSignals(deps: { platform?: NodeJS.Platform } = {}): readonly ShutdownSignal[] {
  return (deps.platform ?? process.platform) === 'win32' ? WINDOWS_SHUTDOWN : POSIX_SHUTDOWN;
}

/**
 * Call `handler(signal)` on each shutdown signal: one listener per signal, installed in
 * `shutdownSignals` order. Returns the detach, which removes exactly those listeners.
 */
export function onShutdownSignals(
  handler: (signal: ShutdownSignal) => void,
  deps: ShutdownSignalDeps = {},
): () => void {
  const target = deps.target ?? process;
  const installed = shutdownSignals(deps).map((signal) => {
    const listener = (): void => handler(signal);
    target.on(signal, listener);
    return { signal, listener };
  });
  return () => {
    for (const { signal, listener } of installed) target.off(signal, listener);
  };
}

export interface ExitAfterStopDeps {
  exit?: (code: number) => void;
  platform?: NodeJS.Platform;
  /** win32 only, synchronously before the stop: whatever must not react to the stopped programs'
   *  exits is told so here (the run managers, #963). Never called where the exit is at once. */
  beforeStop?: () => void;
  /** The rest of the shutdown (closing listeners, saving). POSIX: before the exit, as it always
   *  ran. win32: right after the stop has started, so the stop is not queued behind it. */
  meanwhile?: () => void;
  /** Null when there is nothing to wait for. */
  stop?: () => Promise<unknown> | null;
  boundMs?: number;
}

/**
 * Exit 0. POSIX: `meanwhile`, then the exit, at once and synchronously. win32: `beforeStop`, the
 * stop starts, `meanwhile`, then the exit once the tracked programs are stopped, or after
 * `boundMs`, whichever is first – at once when nothing is running. The bound runs from before the
 * stop starts. The promise settles after `exit` was called (tests pass their own `exit`).
 */
export function exitAfterStoppingTrees(deps: ExitAfterStopDeps = {}): Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') {
    deps.meanwhile?.();
    exit(0);
    return Promise.resolve();
  }
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deps.boundMs ?? SHUTDOWN_TREE_STOP_BOUND_MS);
  });
  try {
    deps.beforeStop?.();
  } catch {
    // the exit and the stop go ahead regardless
  }
  const stopping = (deps.stop ?? (() => stopTrackedProcessTrees({ platform })))();
  try {
    deps.meanwhile?.();
  } catch {
    // the stop is under way; the exit still waits for it
  }
  if (stopping === null) {
    clearTimeout(timer);
    exit(0);
    return Promise.resolve();
  }
  const stopped = stopping.then(
    () => undefined,
    () => undefined,
  );
  return Promise.race([stopped, bound]).finally(() => {
    clearTimeout(timer);
    exit(0);
  });
}
