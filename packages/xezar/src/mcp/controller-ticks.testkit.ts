import { vi } from 'vitest';

/**
 * Counts the event controller's heartbeat ticks in this process, so a "nothing happened" check
 * waits for N real ticks instead of a fixed sleep. A fixed sleep proves nothing on a busy machine:
 * when the timers run late, two seconds can hold fewer ticks than the test assumes, and a duplicate
 * push that a later tick would make is never seen. Counting the ticks makes the wait as long as the
 * claim needs, and no longer.
 *
 * It wraps `setInterval` for the intervals `EventController.start` creates (found by the caller's
 * file in the stack) and passes every other interval through untouched. Install it before the
 * controller starts; `restore()` puts the real `setInterval` back.
 */
export function countControllerTicks(): {
  count: () => number;
  /** Resolves once `n` more ticks have STARTED; the ticks before the last had a whole interval to finish. */
  waitFor: (n: number, timeoutMs?: number) => Promise<void>;
  restore: () => void;
} {
  let ticks = 0;
  const waiters: Array<{ target: number; resolve: () => void }> = [];
  const real = globalThis.setInterval;
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (!/event-controller\.[cm]?[jt]s/.test(new Error().stack ?? '')) return real(handler, ms, ...args);
    return real((...callArgs: unknown[]) => {
      ticks += 1;
      for (const waiter of waiters.splice(0)) {
        if (ticks >= waiter.target) waiter.resolve();
        else waiters.push(waiter);
      }
      handler(...callArgs);
    }, ms, ...args);
  }) as typeof setInterval);
  return {
    count: () => ticks,
    waitFor: (n, timeoutMs = 30_000) =>
      new Promise<void>((resolve, reject) => {
        const start = ticks;
        const target = start + n;
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${n} controller ticks (saw ${ticks - start})`)), timeoutMs);
        waiters.push({ target, resolve: () => { clearTimeout(timer); resolve(); } });
      }),
    restore: () => spy.mockRestore(),
  };
}
