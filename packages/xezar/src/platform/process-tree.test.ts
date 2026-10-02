import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { trackChild, trackedChildren } from './child-registry.ts';
import { STOP_CLOCK_SLACK_MS, type IdentifiedPid, type ProcRow, type ProcessTable } from './process-table.ts';
import {
  PROCESS_GROUP_GRACE_MS,
  TREE_STOP_EXIT_CODE,
  TREE_STOP_TIMEOUT_MS,
  isTreeStopExit,
  signalProcessGroup,
  stopChildTree,
  stopProcessGroup,
  stopTrackedProcessTrees,
  type TreeStopDeps,
} from './process-tree.ts';

interface FakeChild extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: Mock<(signal?: NodeJS.Signals) => boolean>;
}

const made: FakeChild[] = [];

function fakeChild(pid: number | undefined): FakeChild {
  const child = Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true) });
  made.push(child);
  return child;
}

afterEach(() => {
  for (const child of made.splice(0)) child.emit('exit');
  expect(trackedChildren()).toEqual([]);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SPAWNED_AT = 1_000_000;
const STOPPED_AT = 2_000_000;

type Choose = (table: ProcessTable) => readonly IdentifiedPid[];
type ReadThenKillMock = Mock<(choose: Choose, opts: { timeoutMs: number }) => Promise<null>>;

/** A one-PowerShell helper over a fixed table: it hands `choose` the table and records what it
 *  was asked to kill. */
function fakeHelper(rows: ProcRow[], queriedAt: number): { readThenKill: ReadThenKillMock; killed: IdentifiedPid[][] } {
  const killed: IdentifiedPid[][] = [];
  const readThenKill: ReadThenKillMock = vi.fn(async (choose: Choose) => {
    killed.push([...choose({ rows, queriedAt })]);
    return null;
  });
  return { readThenKill, killed };
}

/** A tracked fake and a table around it: 501 and its child 502 are the tree; 503 is older than
 *  the root (a stale parent pid); 504 was created after the stop (a reused root pid). */
function trackedTree(): { child: FakeChild; killed: IdentifiedPid[][]; deps: Partial<TreeStopDeps> & { readThenKill: ReadThenKillMock } } {
  const child = fakeChild(500);
  trackChild(child, { platform: 'win32', isOwnChild: () => true, now: () => SPAWNED_AT });
  const rows: ProcRow[] = [
    { pid: 501, ppid: 500, rssKb: 0, cpuPct: 0, startedAt: SPAWNED_AT + 5 },
    { pid: 502, ppid: 501, rssKb: 0, cpuPct: 0, startedAt: SPAWNED_AT + 9 },
    { pid: 503, ppid: 500, rssKb: 0, cpuPct: 0, startedAt: SPAWNED_AT - 5_000 },
    { pid: 504, ppid: 500, rssKb: 0, cpuPct: 0, startedAt: STOPPED_AT + STOP_CLOCK_SLACK_MS + 1 },
  ];
  const { readThenKill, killed } = fakeHelper(rows, STOPPED_AT);
  return {
    child,
    killed,
    deps: { platform: 'win32', isOwnChild: () => true, now: () => STOPPED_AT, readThenKill },
  };
}

describe('stopChildTree', () => {
  it.each(['linux', 'darwin'] as const)('sends exactly one child.kill(signal) on %s', async (platform) => {
    const { child, deps } = trackedTree();
    for (const signal of ['SIGTERM', 'SIGKILL', 'SIGINT'] as const) {
      child.kill.mockClear();
      await stopChildTree(child, signal, { ...deps, platform });
      expect(child.kill.mock.calls).toEqual([[signal]]);
    }
    expect(deps.readThenKill).not.toHaveBeenCalled();
  });

  it('on win32 kills the child first, then its creation-filtered descendants by identity, in one helper', async () => {
    const { child, deps, killed } = trackedTree();
    await stopChildTree(child, 'SIGTERM', deps);
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
    expect(child.kill.mock.invocationCallOrder[0]).toBeLessThan(deps.readThenKill.mock.invocationCallOrder[0]!);
    expect(deps.readThenKill).toHaveBeenCalledTimes(1);
    expect(deps.readThenKill.mock.calls[0]![1]).toEqual({ timeoutMs: TREE_STOP_TIMEOUT_MS });
    expect(killed.map((targets) => targets.map(({ pid }) => pid).sort())).toEqual([[501, 502]]);
  });

  it('on win32 stops with SIGTERM for a signal Windows cannot deliver', async () => {
    const { child, deps } = trackedTree();
    await stopChildTree(child, 'SIGBREAK', deps);
    await stopChildTree(child, 'SIGHUP', deps);
    await stopChildTree(child, 'SIGINT', deps);
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGTERM'], ['SIGINT']]);
  });

  it('does nothing once the exit was seen, since the pid may be reused (R10)', async () => {
    const { child, deps } = trackedTree();
    child.exitCode = 1;
    await stopChildTree(child, 'SIGKILL', deps);
    child.exitCode = null;
    child.signalCode = 'SIGTERM';
    await stopChildTree(child, 'SIGKILL', deps);
    expect(child.kill).not.toHaveBeenCalled();
    expect(deps.readThenKill).not.toHaveBeenCalled();
  });

  it('only kills the child when it is not an own, tracked child', async () => {
    const { child, deps } = trackedTree();
    await stopChildTree(child, 'SIGTERM', { ...deps, isOwnChild: () => false });
    const untracked = fakeChild(600);
    await stopChildTree(untracked, 'SIGTERM', deps);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(untracked.kill).toHaveBeenCalledTimes(1);
    expect(deps.readThenKill).not.toHaveBeenCalled();
  });

  it('only kills the child when the table is missing or the helper throws, and never rejects', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('boom');
    };
    // One child per case: a child's descendant stop runs once, so a second call would share it.
    for (const broken of [{ readThenKill: async () => null }, { readThenKill: boom }]) {
      const { child, deps } = trackedTree();
      await stopChildTree(child, 'SIGTERM', { ...deps, ...broken });
      expect(child.kill).toHaveBeenCalledTimes(1);
      child.emit('exit');
    }
  });

  // ARCH-1 (b): the KILL that follows a TERM must not start a second PowerShell.
  it('on win32 starts one helper per child, however often the child is stopped', async () => {
    const { child, deps } = trackedTree();
    const term = stopChildTree(child, 'SIGTERM', deps);
    const kill = stopChildTree(child, 'SIGKILL', deps);
    expect(kill).toBe(term);
    await Promise.all([term, kill]);
    await stopChildTree(child, 'SIGKILL', deps);
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], ['SIGKILL']]);
    expect(deps.readThenKill).toHaveBeenCalledTimes(1);
  });

  // ARCH-1 (a): starting PowerShell blocks the loop, so it must not start inside the caller's stack.
  it('on win32 lets the event loop turn before it starts the helper', async () => {
    const { child, deps } = trackedTree();
    let turned = false;
    setImmediate(() => {
      turned = true;
    });
    const sawTurn: boolean[] = [];
    deps.readThenKill.mockImplementation(async () => {
      sawTurn.push(turned);
      return null;
    });
    const stopping = stopChildTree(child, 'SIGTERM', deps);
    expect(deps.readThenKill).not.toHaveBeenCalled();
    await stopping;
    expect(sawTurn).toEqual([true]);
  });
});

describe('stopTrackedProcessTrees', () => {
  it('has nothing to wait for off Windows or when nothing runs', () => {
    expect(stopTrackedProcessTrees({ platform: 'linux' })).toBeNull();
    expect(stopTrackedProcessTrees({ platform: 'win32' })).toBeNull();
  });

  it('kills every running root, then their descendants from one snapshot, in one helper', async () => {
    const a = fakeChild(100);
    const b = fakeChild(200);
    trackChild(a, { platform: 'win32', isOwnChild: () => true, now: () => 1_000_000 });
    trackChild(b, { platform: 'win32', isOwnChild: () => true, now: () => 1_000_000 });
    const rows: ProcRow[] = [
      { pid: 101, ppid: 100, rssKb: 0, cpuPct: 0, startedAt: 1_000_500 },
      { pid: 201, ppid: 200, rssKb: 0, cpuPct: 0, startedAt: 1_000_600 },
      { pid: 202, ppid: 200, rssKb: 0, cpuPct: 0, startedAt: 10 }, // older than the root
    ];
    const { readThenKill, killed } = fakeHelper(rows, 1_500_000);
    await stopTrackedProcessTrees({ platform: 'win32', now: () => 2_000_000, readThenKill });
    expect(a.kill).toHaveBeenCalledWith('SIGTERM');
    expect(b.kill).toHaveBeenCalledWith('SIGTERM');
    expect(readThenKill).toHaveBeenCalledTimes(1);
    expect(readThenKill.mock.calls[0]![1]).toEqual({ timeoutMs: TREE_STOP_TIMEOUT_MS });
    expect(killed).toEqual([
      [
        { pid: 101, startedAt: 1_000_500 },
        { pid: 201, startedAt: 1_000_600 },
      ],
    ]);

    // A runner's own stop that follows shares the shutdown's helper.
    await stopChildTree(a, 'SIGKILL', { platform: 'win32', isOwnChild: () => true, readThenKill });
    expect(readThenKill).toHaveBeenCalledTimes(1);
  });

  it('leaves a root it saw exit alone', () => {
    const child = fakeChild(100);
    trackChild(child, { platform: 'win32', isOwnChild: () => true });
    child.exitCode = 1;
    expect(stopTrackedProcessTrees({ platform: 'win32' })).toBeNull();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('resolves with only the roots stopped when the table is missing or the helper throws', async () => {
    const child = fakeChild(100);
    trackChild(child, { platform: 'win32', isOwnChild: () => true });
    await expect(stopTrackedProcessTrees({ platform: 'win32', readThenKill: async () => null })).resolves.toBeUndefined();
    await expect(
      stopTrackedProcessTrees({
        platform: 'win32',
        readThenKill: async () => {
          throw new Error('boom');
        },
      }),
    ).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(2);
  });
});

describe('signalProcessGroup', () => {
  it('signals the whole group on POSIX', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const child = fakeChild(700);
    signalProcessGroup(child, 'SIGTERM', { platform: 'linux' });
    expect(kill).toHaveBeenCalledWith(-700, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('falls back to the child when the group is gone, and never throws', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const child = fakeChild(700);
    signalProcessGroup(child, 'SIGKILL', { platform: 'darwin' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.kill.mockImplementation(() => {
      throw new Error('also gone');
    });
    expect(() => signalProcessGroup(child, 'SIGKILL', { platform: 'darwin' })).not.toThrow();
  });

  it('does nothing without a pid, and stops the tree on win32', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const noPid = fakeChild(undefined);
    signalProcessGroup(noPid, 'SIGTERM', { platform: 'linux' });
    const child = fakeChild(700);
    signalProcessGroup(child, 'SIGTERM', { platform: 'win32', isOwnChild: () => false });
    expect(kill).not.toHaveBeenCalled();
    expect(noPid.kill).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('stopProcessGroup', () => {
  it('sends TERM now, KILL after the grace and settles after another grace', () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const onSettle = vi.fn();
    stopProcessGroup(fakeChild(800), PROCESS_GROUP_GRACE_MS, onSettle, { platform: 'linux' });
    expect(kill.mock.calls).toEqual([[-800, 'SIGTERM']]);
    vi.advanceTimersByTime(PROCESS_GROUP_GRACE_MS - 1);
    expect(kill).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(kill.mock.calls[1]).toEqual([-800, 'SIGKILL']);
    vi.advanceTimersByTime(PROCESS_GROUP_GRACE_MS - 1);
    expect(onSettle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it('cancels whichever step is still pending', () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const early = vi.fn();
    stopProcessGroup(fakeChild(801), 1_000, early, { platform: 'linux' })();
    const late = vi.fn();
    const cancelLate = stopProcessGroup(fakeChild(802), 1_000, late, { platform: 'linux' });
    vi.advanceTimersByTime(1_000);
    cancelLate();
    vi.advanceTimersByTime(10_000);
    expect(early).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
    expect(kill.mock.calls).toEqual([
      [-801, 'SIGTERM'],
      [-802, 'SIGTERM'],
      [-802, 'SIGKILL'],
    ]);
  });
});

describe('isTreeStopExit', () => {
  it('is exit 1 on win32 only', () => {
    expect(TREE_STOP_EXIT_CODE).toBe(1);
    expect(isTreeStopExit(1, { platform: 'win32' })).toBe(true);
    for (const code of [0, 2, 130, 143, null]) expect(isTreeStopExit(code, { platform: 'win32' })).toBe(false);
    for (const platform of ['linux', 'darwin'] as const) expect(isTreeStopExit(1, { platform })).toBe(false);
  });
});
