import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_RUN_TIMEOUT_MS } from '../core/claude-cli-runner.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * #460 § 2 — the engine records the wall clock a step ACTUALLY spawned with.
 *
 * The stall monitor's arithmetic is `../mcp/stall-monitor.test.ts`; what this file proves is the
 * WIRING, which no unit test can: that the resolution happens at the one place that knows both the
 * step's own `timeout` and the backend about to run it, and that it is the runner's own default —
 * not an assumed thirty minutes — that fills an absent one. Driven through the real engine under
 * `XEZ_DRY_RUN=1`.
 *
 * Named break: guess a fixed default instead of asking the runner, or give an interactive step a
 * deadline — `timeout: 0` is "no wall clock", and rendering it as a finite one would make every
 * long interactive step report itself near its limit.
 */
describe('a step records the timeout it spawned with (#460)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-460-progress-'));
    savedEnv.XEZ_DRY_RUN = process.env.XEZ_DRY_RUN;
    savedEnv.XEZ_FOLLOWUPS = process.env.XEZ_FOLLOWUPS;
    process.env.XEZ_DRY_RUN = '1';
    delete process.env.XEZ_FOLLOWUPS;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    writeFileSync(join(repoRoot, '.gitignore'), '.local/\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    dataDir = join(repoRoot, '.local/xezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir);
    manager = new RunManager(store, repoRoot);
  });

  afterAll(async () => {
    await manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  async function settle(runId: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!['done', 'review', 'failed', 'cancelled'].includes(store.getRun(runId)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('the run did not settle in time');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function runToEnd(workflow: WorkflowDef): Promise<RunRecord> {
    const record = manager.startRun(workflow, { task: 'mock:done', worktree: false });
    await settle(record.id);
    const settled = store.getRun(record.id);
    if (!settled) throw new Error('the run is gone');
    return settled;
  }

  function stepOf(record: RunRecord, id: string): RunRecord['steps'][number] {
    const step = record.steps.find((candidate) => candidate.id === id);
    if (!step) throw new Error(`no step ${id}`);
    return step;
  }

  it('fills an absent step timeout from the runner’s own default, with a matching deadline', async () => {
    const record = await runToEnd({
      name: 'progress-default',
      source: 'built-in',
      // A CHECK last, so the agent step above it is an ordinary non-final one and the run settles.
      steps: [
        { id: 'work', prompt: '{{task}}' },
        { id: 'gates', command: 'node -e "0"' },
      ],
    });

    const step = stepOf(record, 'work');
    expect(step.progress?.effectiveTimeoutMs).toBe(DEFAULT_RUN_TIMEOUT_MS);
    // The deadline is that timeout from the step's own start — the pair is written together, and
    // the monitor reads both rather than re-deriving either.
    const startedMs = Date.parse(step.startedAt ?? '');
    expect(Date.parse(step.progress?.deadlineAt ?? '')).toBe(startedMs + DEFAULT_RUN_TIMEOUT_MS);
    // Nothing has been observed yet, and unknown is null — never the step's own start stamped in.
    expect(step.progress?.lastActivityAt).toBeNull();
    expect(step.progress?.stall).toBeUndefined();
  });

  it('honours the step’s own timeout when it names one', async () => {
    const record = await runToEnd({
      name: 'progress-explicit',
      source: 'built-in',
      steps: [
        { id: 'work', prompt: '{{task}}', timeout: '45s' },
        { id: 'gates', command: 'node -e "0"' },
      ],
    });

    expect(stepOf(record, 'work').progress?.effectiveTimeoutMs).toBe(45_000);
  });

  it('gives an interactive last step no deadline at all', async () => {
    // Its `timeoutMs` is 0 — the idle timer rules, and there is no wall clock to be near.
    const record = manager.startRun(
      { name: 'progress-interactive', source: 'built-in', steps: [{ id: 'work', prompt: '{{task}}' }] },
      { task: 'mock:done', worktree: false },
    );
    await settle(record.id);

    const step = stepOf(store.getRun(record.id)!, 'work');
    expect(step.progress?.effectiveTimeoutMs).toBeNull();
    expect(step.progress?.deadlineAt).toBeNull();
  });

  it('leaves a check step’s timeout unknown rather than inventing one', async () => {
    const record = await runToEnd({
      name: 'progress-check',
      source: 'built-in',
      steps: [
        { id: 'work', prompt: '{{task}}' },
        { id: 'gates', command: 'node -e "0"' },
      ],
    });

    // A check step is a shell command with no agent wall clock: absent progress is honest, and an
    // invented deadline would warn about a limit nothing enforces.
    expect(stepOf(record, 'gates').progress).toBeUndefined();
  });
});
