import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

interface HarnessModule {
  ChildRegistry: new (stateFile: string) => {
    spawn(name: string, command: string, args: string[], options: SpawnOptions): ChildProcess;
    assertOwned(child: ChildProcess): void;
    stopAll(): Promise<Array<{ pid: number; signal: string }>>;
  };
  HarnessBlockedError: new (message: string) => Error;
}

const harness = (await import(pathToFileURL(join(import.meta.dirname, '../../scripts/multi-project-harness.mjs')).href)) as HarnessModule;
const roots: string[] = [];
const children: ChildProcess[] = [];

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const waitExit = (child: ChildProcess) => new Promise<void>((resolve) => {
  if (!alive(child)) resolve();
  else child.once('exit', () => resolve());
});

afterEach(async () => {
  for (const child of children) if (alive(child)) child.kill('SIGKILL');
  await Promise.all(children.map(waitExit));
  children.length = 0;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe('multi-project harness process ownership', () => {
  it('records every owned PID before teardown and leaves an unrelated sentinel alive', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'xez-mp-cleanup-'));
    roots.push(root);
    const registry = new harness.ChildRegistry(join(root, 'state.json'));
    const owned = registry.spawn('owned', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(owned, sentinel);

    const descriptor = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as { children: Array<{ name: string; pid: number }> };
    assert.deepEqual(descriptor.children, [{ name: 'owned', pid: owned.pid }]);

    const stopped = await registry.stopAll();
    assert.deepEqual(stopped, [{ name: 'owned', pid: owned.pid, signal: 'SIGTERM' }]);
    assert.equal(alive(sentinel), true);
  });

  it('refuses patternless cleanup when a child was not recorded', () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'xez-mp-unowned-'));
    roots.push(root);
    const registry = new harness.ChildRegistry(join(root, 'state.json'));
    const unowned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(unowned);

    assert.throws(() => registry.assertOwned(unowned), /patternless-cleanup.*not owned/);
  });
});

describe('multi-project harness result vocabulary', () => {
  it('has a distinct BLOCKED error for an unavailable built artifact', () => {
    assert.equal(new harness.HarnessBlockedError('built CLI missing').name, 'Error');
    assert.match(new harness.HarnessBlockedError('built CLI missing').message, /built CLI missing/);
  });
});
