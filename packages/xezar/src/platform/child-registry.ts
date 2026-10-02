/**
 * The children xezar started and has not seen exit (#963). Windows only.
 *
 * Windows has no process groups a signal can reach, so stopping a child's whole tree means
 * finding its descendants in the process table – and that is safe only for a process xezar knows
 * it started, and only while its pid is still its own. So `launch` records each real child here
 * with the moment it was spawned, and the record goes the moment Node reports the exit. The tree
 * stops in `process-tree.ts` read this list; nothing else does. POSIX records nothing.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { ChildProcess } from 'node:child_process';

/** The slice of `ChildProcess` a stop needs – keeps the helpers usable with test fakes. */
export interface RegisteredChild {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface TrackableChild extends RegisteredChild {
  once(event: 'exit', listener: () => void): unknown;
}

export interface TrackedChild {
  readonly child: RegisteredChild;
  /** ms since the epoch, read right after `spawn` returned. */
  readonly spawnedAt: number;
}

/** Test seams. Production passes none. */
export interface ChildRegistryDeps {
  platform?: NodeJS.Platform;
  isOwnChild?: (child: unknown) => boolean;
  now?: () => number;
}

const tracked = new Map<RegisteredChild, TrackedChild>();

/** A real `ChildProcess` that got a pid – never a test fake, whose pid may be a stranger's. */
export function isOwnChild(child: unknown): boolean {
  try {
    return child instanceof ChildProcess && Number.isSafeInteger(child.pid);
  } catch {
    // a mocked module without the class
    return false;
  }
}

/** win32: remember `child` until its exit, if it is an own child that is still running. */
export function trackChild(child: TrackableChild, deps: ChildRegistryDeps = {}): void {
  if ((deps.platform ?? process.platform) !== 'win32') return;
  const exited = child.exitCode !== null || child.signalCode !== null;
  if (!(deps.isOwnChild ?? isOwnChild)(child) || exited || tracked.has(child)) return;
  tracked.set(child, { child, spawnedAt: (deps.now ?? Date.now)() });
  child.once('exit', () => tracked.delete(child));
}

/** Every child tracked now, oldest first. */
export function trackedChildren(): TrackedChild[] {
  return [...tracked.values()];
}

/** The record of `child`, while it is tracked. */
export function trackedEntry(child: RegisteredChild): TrackedChild | undefined {
  return tracked.get(child);
}
