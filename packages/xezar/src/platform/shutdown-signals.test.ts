import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SHUTDOWN_TREE_STOP_BOUND_MS,
  exitAfterStoppingTrees,
  onShutdownSignals,
  shutdownSignals,
  type ShutdownSignal,
} from './shutdown-signals.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('shutdownSignals', () => {
  it('is SIGINT then SIGTERM on POSIX, as serve and the gate lease always listened', () => {
    for (const platform of ['linux', 'darwin'] as const) expect(shutdownSignals({ platform })).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('adds Ctrl+Break and the console window closing on Windows', () => {
    expect(shutdownSignals({ platform: 'win32' })).toEqual(['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']);
  });
});

describe('onShutdownSignals', () => {
  it.each(['linux', 'win32'] as const)('installs one listener per signal in order on %s, and detaches exactly those', (platform) => {
    const target = new EventEmitter();
    const installed: string[] = [];
    target.on('newListener', (event: string) => installed.push(event));
    const unrelated = (): void => {};
    target.on('SIGINT', unrelated);
    installed.length = 0;

    const seen: ShutdownSignal[] = [];
    const detach = onShutdownSignals((signal) => seen.push(signal), { platform, target });
    expect(installed).toEqual([...shutdownSignals({ platform })]);
    for (const signal of shutdownSignals({ platform })) target.emit(signal);
    expect(seen).toEqual([...shutdownSignals({ platform })]);

    detach();
    for (const signal of shutdownSignals({ platform })) {
      expect(target.listenerCount(signal)).toBe(signal === 'SIGINT' ? 1 : 0);
    }
    expect(target.listeners('SIGINT')).toEqual([unrelated]);
  });
});

describe('exitAfterStoppingTrees', () => {
  it.each(['linux', 'darwin'] as const)('exits 0 at once on %s, without stopping anything', (platform) => {
    const exit = vi.fn();
    const stop = vi.fn(() => Promise.resolve());
    void exitAfterStoppingTrees({ exit, platform, stop });
    expect(exit).toHaveBeenCalledWith(0);
    expect(stop).not.toHaveBeenCalled();
  });

  it('exits at once on Windows when nothing runs', () => {
    const exit = vi.fn();
    void exitAfterStoppingTrees({ exit, platform: 'win32', stop: () => null });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits on Windows once the trees are stopped', async () => {
    const exit = vi.fn();
    let finish: () => void = () => {};
    const done = exitAfterStoppingTrees({
      exit,
      platform: 'win32',
      stop: () => new Promise<void>((resolve) => { finish = resolve; }),
    });
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    finish();
    await done;
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits on Windows after the bound when the stop hangs, and after a failed stop', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const done = exitAfterStoppingTrees({ exit, platform: 'win32', stop: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TREE_STOP_BOUND_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(exit).toHaveBeenCalledWith(0);

    const failed = vi.fn();
    await exitAfterStoppingTrees({ exit: failed, platform: 'win32', stop: () => Promise.reject(new Error('boom')) });
    expect(failed).toHaveBeenCalledWith(0);
  });

  // Q-01: the run managers must be told BEFORE the stop, or the stopped programs' exits are
  // recorded as failures and retries. POSIX exits at once and tells nobody.
  it('calls beforeStop on Windows only, before the stop', async () => {
    const order: string[] = [];
    const beforeStop = vi.fn(() => order.push('beforeStop'));
    const stop = vi.fn(() => {
      order.push('stop');
      return Promise.resolve();
    });
    await exitAfterStoppingTrees({ exit: vi.fn(), platform: 'win32', beforeStop, stop });
    expect(order).toEqual(['beforeStop', 'stop']);

    for (const platform of ['linux', 'darwin'] as const) {
      const posixBefore = vi.fn();
      void exitAfterStoppingTrees({ exit: vi.fn(), platform, beforeStop: posixBefore, stop });
      expect(posixBefore).not.toHaveBeenCalled();
    }
  });

  it('still stops and exits when beforeStop throws', async () => {
    const exit = vi.fn();
    const stop = vi.fn(() => Promise.resolve());
    await exitAfterStoppingTrees({
      exit,
      platform: 'win32',
      beforeStop: () => {
        throw new Error('boom');
      },
      stop,
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  // C-02: the rest of the shutdown must not delay the stop on Windows; POSIX keeps its order.
  it('runs `meanwhile` before the exit on POSIX, and right after the stop has started on Windows', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const order: string[] = [];
      void exitAfterStoppingTrees({
        platform,
        exit: () => order.push('exit'),
        meanwhile: () => order.push('meanwhile'),
      });
      expect(order).toEqual(['meanwhile', 'exit']);
    }

    const order: string[] = [];
    let finish: () => void = () => {};
    const done = exitAfterStoppingTrees({
      platform: 'win32',
      exit: () => order.push('exit'),
      beforeStop: () => order.push('beforeStop'),
      stop: () => {
        order.push('stop');
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      meanwhile: () => {
        order.push('meanwhile');
        throw new Error('boom'); // a failing close still waits for the stop, then exits
      },
    });
    await Promise.resolve();
    expect(order).toEqual(['beforeStop', 'stop', 'meanwhile']);
    finish();
    await done;
    expect(order).toEqual(['beforeStop', 'stop', 'meanwhile', 'exit']);
  });

  // C-02: under CPU load the stop's one PowerShell measured 4-6.7 s; the old 3 s bound exited first
  // and the descendants survived. The exit waits for a stop that takes that long.
  it('on Windows waits for a stop that takes 7.9 s, and no longer than 8 s', async () => {
    vi.useFakeTimers();
    expect(SHUTDOWN_TREE_STOP_BOUND_MS).toBe(8_000);
    const exit = vi.fn();
    let stopped = false;
    const done = exitAfterStoppingTrees({
      exit,
      platform: 'win32',
      stop: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            stopped = true;
            resolve();
          }, 7_900),
        ),
    });
    await vi.advanceTimersByTimeAsync(7_899);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(stopped).toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  // ARCH-1: on Windows starting PowerShell blocks the event loop; the bound must count that time.
  it('arms the bound before the stop starts, so time the stop blocks counts against it', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const done = exitAfterStoppingTrees({
      exit,
      platform: 'win32',
      stop: () => {
        vi.advanceTimersByTime(SHUTDOWN_TREE_STOP_BOUND_MS); // a stop that blocked for the whole bound
        return new Promise(() => {});
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(exit).toHaveBeenCalledWith(0);
  });
});
