import { vi } from 'vitest';
import { FILE_LOCK_POLL_MS } from './file-lock.ts';

/**
 * Counts how often `acquireFileLock` waited one poll interval, so a "taken at once" claim is
 * checked as "never waited" rather than as a wall-clock bound a busy machine can break or hide.
 * Only `file-lock.ts`'s own poll sleeps are counted; every timer still runs as normal. Call
 * `restore()` before asserting.
 */
export function countFileLockPolls(): { count: () => number; restore: () => void } {
  let polls = 0;
  const real = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number, ...args: unknown[]) => {
    if (ms === FILE_LOCK_POLL_MS && /file-lock\.[cm]?[jt]s/.test(new Error().stack ?? '')) polls += 1;
    return Reflect.apply(real, globalThis, [handler, ms, ...args]) as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  return { count: () => polls, restore: () => spy.mockRestore() };
}
