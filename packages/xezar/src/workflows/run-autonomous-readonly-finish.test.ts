import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { MAX_AUTO_CONTINUES, RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * #933 — an autonomous READ-ONLY run never ends in "waiting for input".
 *
 * Run `79e11f69` (a read-only review step, autonomous) posted its verdict, ended its turn without
 * `XEZ:DONE`, answered the automatic nudge with prose and no tool call, and the #613 idle bound
 * then PARKED it at `waiting` — where it sat until a person cancelled it. The fix closes the
 * session instead and leaves a note that names the gap, at BOTH turn-end handlers (`execute` and
 * `runContinuation`, the #141 pair), through one helper (`finishStoppedReadOnlyTurn`).
 *
 * The dry-run mock answers every message with prose, makes no tool call and never volunteers
 * `XEZ:DONE` unless the text carries `mock:done` — exactly the 79e11f69 shape.
 *
 * Kept out of `run-autonomous-nudge.test.ts` for the same wall-clock reason that file is out of
 * `run.test.ts` (#125). GUARD tests pass before AND after the fix: a NON-autonomous read-only
 * run still parks, and a writing autonomous run keeps its park (pinned in the nudge file).
 */
describe('autonomous read-only runs finish instead of waiting (#933)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  /** A read-only step: its tools name neither Edit nor Write (`isReadOnlyStep`). */
  const READ_ONLY_STEP: WorkflowDef = {
    name: 'review',
    source: 'built-in',
    steps: [{ id: 'review', name: 'Review', prompt: '{{task}}', allowedTools: ['Read', 'Grep', 'Glob', 'Bash'] }],
  };
  const FINISH_NOTE = 'autonomous read-only step finished instead of waiting for input';

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-933-'));
    savedEnv.XEZ_DRY_RUN = process.env.XEZ_DRY_RUN;
    savedEnv.XEZ_REVIEW_GATE = process.env.XEZ_REVIEW_GATE;
    process.env.XEZ_DRY_RUN = '1';
    delete process.env.XEZ_REVIEW_GATE;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    manager = new RunManager(store, repoRoot);
    currentId = undefined;
  });

  afterEach(async () => {
    if (currentId) manager.cancel(currentId);
    manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await store.close();
    rmSync(repoRoot, TEST_DIR_RM_OPTIONS);
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error(`condition not met in time (status=${store.getRun(id)?.status})`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const notes = (id: string, fragment: string) =>
    store.readEvents(id).filter((e) => e.type === 'note' && String((e as { message?: unknown }).message ?? '').includes(fragment));
  /** The run left `running` for a state a person or the leader would see. */
  const settled = (r: RunRecord | undefined) => ['waiting', 'done', 'failed', 'review'].includes(r?.status ?? '');

  type LiveState = { autoContinues?: number };
  const waitForActiveRun = async (id: string, ms = 10_000): Promise<LiveState> => {
    const states = (manager as unknown as { active: Map<string, LiveState> }).active;
    const deadline = Date.now() + ms;
    for (;;) {
      const state = states.get(id);
      if (state) return state;
      if (Date.now() > deadline) throw new Error('ActiveRun not built in time');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('a fresh autonomous read-only run whose nudge is idle FINISHES with a gap note — never `waiting` (execute site)', async () => {
    const record = manager.startRun(READ_ONLY_STEP, {
      task: 'review the change and post a verdict',
      worktree: false,
      autonomous: true,
    });
    currentId = record.id;
    await waitFor(record.id, settled);

    expect(store.getRun(record.id)?.status).toBe('done');
    expect(store.getRun(record.id)?.steps.find((s) => s.id === 'review')?.status).toBe('done');
    // The nudge still fired first — it is what answers a question in autonomous mode.
    expect(notes(record.id, 'autonomous — continuing without pausing')).toHaveLength(1);
    // The bound that used to park the run is named in the finish note.
    const finish = notes(record.id, FINISH_NOTE);
    expect(finish).toHaveLength(1);
    expect(String((finish[0] as { message?: unknown }).message)).toContain('made no tool call');
    expect(String((finish[0] as { message?: unknown }).message)).toContain('gap');
  }, 40_000);

  it('a Continue of an autonomous read-only run finishes the same way (runContinuation site)', async () => {
    const record = manager.startRun(READ_ONLY_STEP, {
      task: 'mock:done first pass',
      worktree: false,
      autonomous: true,
    });
    currentId = record.id;
    await waitFor(record.id, (r) => r?.status === 'done');
    expect(manager.continueRun(record.id, { text: 'now check the second half' }).ok).toBe(true);
    await waitFor(record.id, (r) => r?.status === 'running');
    await waitFor(record.id, settled);

    expect(store.getRun(record.id)?.status).toBe('done');
    expect(notes(record.id, FINISH_NOTE)).toHaveLength(1);
  }, 40_000);

  it('a spent nudge budget finishes an autonomous read-only run too, naming the cap', async () => {
    const record = manager.startRun(READ_ONLY_STEP, {
      task: 'review the change and post a verdict',
      worktree: false,
      autonomous: true,
    });
    currentId = record.id;
    const state = await waitForActiveRun(record.id);
    state.autoContinues = MAX_AUTO_CONTINUES;
    await waitFor(record.id, settled);

    expect(store.getRun(record.id)?.status).toBe('done');
    const finish = notes(record.id, FINISH_NOTE);
    expect(finish).toHaveLength(1);
    expect(String((finish[0] as { message?: unknown }).message)).toContain(`cap of ${MAX_AUTO_CONTINUES}`);
  }, 40_000);

  it('a NON-autonomous read-only run still parks at `waiting` (guard)', async () => {
    const record = manager.startRun(READ_ONLY_STEP, {
      task: 'review the change and post a verdict',
      worktree: false,
    });
    currentId = record.id;
    await waitFor(record.id, settled);
    await new Promise((r) => setTimeout(r, 500));

    expect(store.getRun(record.id)?.status).toBe('waiting');
    expect(notes(record.id, FINISH_NOTE)).toHaveLength(0);
  }, 40_000);

  it('an autonomous read-only run that emits XEZ:DONE finishes without a gap note (guard)', async () => {
    const record = manager.startRun(READ_ONLY_STEP, {
      task: 'mock:done review posted',
      worktree: false,
      autonomous: true,
    });
    currentId = record.id;
    await waitFor(record.id, settled);

    expect(store.getRun(record.id)?.status).toBe('done');
    expect(notes(record.id, FINISH_NOTE)).toHaveLength(0);
  }, 40_000);
});
