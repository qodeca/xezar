import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { isOwnChild, trackChild, trackedChildren, trackedEntry, type ChildRegistryDeps } from './child-registry.ts';
import { launch } from './process-launch.ts';

interface FakeChild extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: Mock<(signal?: NodeJS.Signals) => boolean>;
}

const made: FakeChild[] = [];

function fakeChild(pid: number | undefined, exitCode: number | null = null): FakeChild {
  const child = Object.assign(new EventEmitter(), { pid, exitCode, signalCode: null, kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true) });
  made.push(child);
  return child;
}

afterEach(() => {
  // Tracked fakes leave the module-wide registry the way real children do: on exit.
  for (const child of made.splice(0)) child.emit('exit');
  expect(trackedChildren()).toEqual([]);
});

const own: ChildRegistryDeps = { platform: 'win32', isOwnChild: () => true };

describe('isOwnChild', () => {
  it('accepts a real child with a pid and nothing else', async () => {
    const real = spawn(process.execPath, ['-e', '']);
    try {
      expect(isOwnChild(real)).toBe(true);
    } finally {
      await once(real, 'exit');
    }
    expect(isOwnChild(new ChildProcess())).toBe(false);
    expect(isOwnChild(fakeChild(1234))).toBe(false);
    expect(isOwnChild(null)).toBe(false);
  });
});

describe('trackChild', () => {
  it.each(['linux', 'darwin'] as const)('records nothing on %s', (platform) => {
    const child = fakeChild(10);
    trackChild(child, { platform, isOwnChild: () => true });
    expect(trackedChildren()).toEqual([]);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('records an own running child with its spawn time, once, until its exit', () => {
    const child = fakeChild(10);
    trackChild(child, { ...own, now: () => 5_000 });
    trackChild(child, { ...own, now: () => 9_000 });
    expect(trackedChildren()).toEqual([{ child, spawnedAt: 5_000 }]);
    expect(trackedEntry(child)).toEqual({ child, spawnedAt: 5_000 });
    child.emit('exit');
    expect(trackedChildren()).toEqual([]);
    expect(trackedEntry(child)).toBeUndefined();
  });

  it('skips a child that is not own, and one that already exited', () => {
    trackChild(fakeChild(10), { platform: 'win32' });
    trackChild(fakeChild(11, 0), own);
    expect(trackedChildren()).toEqual([]);
  });
});

// T-06: the wiring every Windows tree stop needs – `launch` records the real child it started –
// proved on every OS, so the required Linux leg fails if it is lost. The Windows rules of `launch`
// pass Node's own executable through unchanged on any host.
describe('launch → trackChild', () => {
  it('records the real child launch() starts under the Windows rules, until its exit', async () => {
    const child = launch(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore' }, {}, { platform: 'win32' });
    expect(child).toBeInstanceOf(ChildProcess);
    expect(trackedChildren().some((tracked) => tracked.child === child)).toBe(true);
    await once(child, 'exit');
    expect(trackedChildren().some((tracked) => tracked.child === child)).toBe(false);
  });

  it('records nothing for a child launch() starts under the POSIX rules', async () => {
    const child = launch(process.execPath, ['-e', ''], { stdio: 'ignore' }, {}, { platform: 'linux' });
    expect(trackedChildren().some((tracked) => tracked.child === child)).toBe(false);
    await once(child, 'exit');
  });
});
