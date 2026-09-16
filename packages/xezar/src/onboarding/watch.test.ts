import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readOnboardingRecord } from './state.ts';
import { BUNDLED_TEMPLATES_DIGEST, ONBOARDING_WORKFLOW_ID } from './status.ts';
import { setupRunFinishedScope, watchSetupCompletion, type SetupWatch } from './watch.ts';
import { RunStore } from '../runs/store.ts';

/**
 * The transition out of `checking` (#464 P2, review round 1 finding 1).
 *
 * The first round shipped `recordChecked` with no production call site, so `set-up`, `changed`
 * and the whole post-update offer were states with no way in. Every case here drives the DEFAULT
 * path — a real `RunStore`, a real `run` event, no flag and no human input — because a helper
 * proved in isolation is exactly what passed last time.
 */
describe('stamping a finished check', () => {
  let dataDir: string;
  let store: RunStore;
  let watch: SetupWatch;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'xez-onboarding-watch-'));
    store = RunStore.open(dataDir);
  });

  afterEach(async () => {
    await watch?.idle();
    watch?.stop();
    store.flush();
    store.removeAllListeners();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const setupRun = (workflow: string = ONBOARDING_WORKFLOW_ID) =>
    store.createRun({
      title: 'Set up this project',
      workflow,
      task: 'Set this project up',
      steps: [{ id: 'setup', name: 'Set up this project', kind: 'agent' }],
    });

  const FINISHED_AT = '2026-09-16T04:00:00.000Z';

  /** The whole default path in one call: the run ends the way `workflows/run.ts` ends one. */
  const finish = (
    id: string,
    run: 'done' | 'failed' | 'cancelled' | 'review',
    step: 'done' | 'failed' | 'cancelled' | 'skipped' = 'done',
    finishedAt: string = FINISHED_AT,
  ) => {
    store.updateStep(id, 'setup', { status: step, finishedAt });
    store.updateRun(id, { status: run, finishedAt });
  };

  /** Read the record once every write this watcher started has settled — no timer, no polling. */
  const record = async () => {
    await watch.idle();
    return readOnboardingRecord(dataDir);
  };

  it('records the check when a setup run finishes its promised scope', async () => {
    watch = watchSetupCompletion(store, '0.15.0');
    const run = setupRun();
    expect((await record()).status).toBe('absent'); // starting it writes nothing
    finish(run.id, 'done');

    const read = await record();
    expect(read.status).toBe('ok');
    expect(read.record?.lastCheckedAt).toBe(FINISHED_AT);
    expect(read.record?.checked).toEqual({
      engineVersion: '0.15.0',
      kitDigest: BUNDLED_TEMPLATES_DIGEST,
      at: FINISHED_AT,
    });
  });

  it('leaves the record untouched for a cancelled, a failed and a half-done run (AC-12)', async () => {
    watch = watchSetupCompletion(store, '0.15.0');
    finish(setupRun().id, 'cancelled', 'cancelled');
    finish(setupRun().id, 'failed', 'failed');
    // Reached the end of the chain without doing the work: `done` is not the same as "finished
    // what it promised", which is the whole distinction this predicate exists to carry.
    finish(setupRun().id, 'done', 'skipped');
    // Parked for a person to accept. Accepting flips it to `done` and comes back through here.
    finish(setupRun().id, 'review');

    expect((await record()).status).toBe('absent');
  });

  it('ignores a finished run of any other workflow', async () => {
    watch = watchSetupCompletion(store, '0.15.0');
    finish(setupRun('quick-task').id, 'done');
    expect((await record()).status).toBe('absent');
  });

  it('does not stamp a run that was already finished when the store opened', async () => {
    // History, not a transition: an archive, a pin or a retention sweep touches such a record, and
    // stamping it would move "last successfully checked" to today for a check that ended long ago.
    const run = setupRun();
    store.updateStep(run.id, 'setup', { status: 'done', finishedAt: FINISHED_AT });
    store.updateRun(run.id, { status: 'done', finishedAt: FINISHED_AT });
    watch = watchSetupCompletion(store, '0.15.0');
    store.updateRun(run.id, { pinned: true });

    expect((await record()).status).toBe('absent');
  });

  it('stamps one run once, however often its record is touched again', async () => {
    watch = watchSetupCompletion(store, '0.15.0');
    const run = setupRun();
    finish(run.id, 'done');
    await record();
    store.updateRun(run.id, { finishedAt: '2026-09-16T09:00:00.000Z' });

    expect((await record()).record?.lastCheckedAt).toBe(FINISHED_AT);
  });

  it('attaches once per store', async () => {
    watch = watchSetupCompletion(store, '0.15.0');
    expect(watchSetupCompletion(store, '0.15.0')).toBe(watch);
    expect(store.listenerCount('run')).toBe(1);
  });
});

describe('what "promised scope" means', () => {
  const run = (over: Partial<Parameters<typeof setupRunFinishedScope>[0]>) =>
    setupRunFinishedScope({
      workflow: ONBOARDING_WORKFLOW_ID,
      status: 'done',
      steps: [{ status: 'done' }] as never,
      ...over,
    });

  it('is the launch definition, a done run, and every step done', () => {
    expect(run({})).toBe(true);
    expect(run({ workflow: 'quick-task' })).toBe(false);
    expect(run({ status: 'review' })).toBe(false);
    expect(run({ status: 'failed' })).toBe(false);
    expect(run({ status: 'cancelled' })).toBe(false);
    expect(run({ steps: [] as never })).toBe(false);
    expect(run({ steps: [{ status: 'done' }, { status: 'cancelled' }] as never })).toBe(false);
  });
});
