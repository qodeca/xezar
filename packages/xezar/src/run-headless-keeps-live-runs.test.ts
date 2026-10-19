import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from './runs/store.ts';
import { RunManager } from './workflows/run.ts';
import { closeStoreAndRemove } from './runs/store.testkit.ts';
import { onWindows } from '../test/helpers/platform.ts';

/**
 * A headless `xezar run` touches only the run it creates. It used to open the run store the way
 * one-shot read paths do, which marks every `queued`, `running` and `waiting` run `failed` as
 * "interrupted"; its first save wrote that to disk, so the next `serve` had nothing to recover —
 * and, seeing no `running` run, dropped their saved process lists without stopping what they left.
 *
 * Out of process, through the real CLI entry, with a one-check workflow so no agent runs.
 *
 * RED WITHOUT THE FIX: both live runs come back `failed`.
 */
const tsxLoader = import.meta.resolve('tsx');
const cliEntry = fileURLToPath(new URL('./index.ts', import.meta.url));

describe('headless `xezar run` leaves other live runs alone', () => {
  let root: string;
  let store: RunStore | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-headless-live-'));
  });

  afterEach(() => {
    closeStoreAndRemove(store, root);
    store = undefined;
  });

  it('keeps a running and a queued run as they were', () => {
    const project = join(root, 'project');
    const home = join(root, 'home');
    mkdirSync(join(project, '.xezar', 'workflows'), { recursive: true });
    mkdirSync(home, { recursive: true });
    // One check step: the run finishes on its own, with no agent and no question to answer.
    writeFileSync(
      join(project, '.xezar', 'workflows', 'check-only.yaml'),
      'name: check-only\nsteps:\n  - id: check\n    command: node -e ""\n',
      'utf8',
    );
    writeFileSync(join(project, '.xezar', 'config.json'), JSON.stringify({ skillsRepos: [] }), 'utf8');

    const dataDir = join(project, '.local', 'xezar');
    const seed = RunStore.open(dataDir, { keepLive: true });
    const running = seed.createRun({
      title: 'running', workflow: 'quick-task', task: 'still working',
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
    });
    seed.updateStep(running.id, 'task', { status: 'running', sessionId: 's-1', backend: 'claude' });
    seed.updateRun(running.id, { status: 'running', currentStepId: 'task' });
    const queued = seed.createRun({
      title: 'queued', workflow: 'quick-task', task: 'not started',
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
    });
    seed.updateRun(queued.id, { status: 'queued' });
    seed.close();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      ...(onWindows ? { USERPROFILE: home } : {}),
      XEZ_HOME: home,
      XEZ_DRY_RUN: '1',
      XEZ_AUTONAME: '0',
    };
    delete env.VITEST;

    const result = spawnSync(
      process.execPath,
      [
        '--import', tsxLoader, cliEntry, 'run', 'say hello', '--workflow', 'check-only',
        '--repo', project, '--single-project', '--no-open', '--output', 'lines',
      ],
      { cwd: project, env, encoding: 'utf8', timeout: 90_000 },
    );
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status, out).toBe(0);

    store = RunStore.open(dataDir, { keepLive: true });
    expect(store.getRun(running.id)?.status, out).toBe('running');
    expect(store.getRun(running.id)?.steps[0]?.status).toBe('running');
    expect(store.getRun(queued.id)?.status).toBe('queued');
    // The headless run itself is there and finished.
    expect(store.listRuns().some(r => r.id !== running.id && r.id !== queued.id && r.status === 'done')).toBe(true);
  }, 120_000);
});

describe('an `ownRunsOnly` manager never adopts a stored run it did not start', () => {
  let root: string;
  let store: RunStore | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-own-runs-'));
  });

  afterEach(() => {
    closeStoreAndRemove(store, root);
    store = undefined;
  });

  const lostQueuedRun = (s: RunStore) => {
    const run = s.createRun({
      title: 'queued', workflow: 'check-only', task: 'not started',
      steps: [{ id: 'check', name: 'Check', kind: 'check' }],
    });
    // A check step, so a re-adopted run that starts runs no agent.
    s.updateRun(run.id, { status: 'queued', workflowDef: {
      name: 'check-only', source: 'built-in', steps: [{ id: 'check', command: 'node -e ""' }],
    } });
    return run.id;
  };
  const pendingJobs = (m: RunManager) => (m as unknown as { pendingJobs: Map<string, unknown> }).pendingJobs;

  it('leaves a queued record the queue watchdog would re-adopt', async () => {
    store = RunStore.open(join(root, 'data'), { keepLive: true });
    const id = lostQueuedRun(store);
    const manager = new RunManager(store, root, { ownRunsOnly: true });
    await manager.rescueStalledQueue();
    expect(pendingJobs(manager).has(id)).toBe(false);
    expect(store.getRun(id)?.status).toBe('queued');
    await manager.dispose();
  });

  it('GUARD: the serving manager still re-adopts it', async () => {
    store = RunStore.open(join(root, 'data'), { keepLive: true });
    const id = lostQueuedRun(store);
    const manager = new RunManager(store, root);
    await manager.rescueStalledQueue();
    expect(pendingJobs(manager).has(id) || store.getRun(id)?.status !== 'queued').toBe(true);
    await manager.quiesce();
    await manager.dispose();
  });
});
