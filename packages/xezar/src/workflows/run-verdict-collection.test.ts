import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RunStore } from '../runs/store.ts';
import { taskVerdictPacketPath } from '../runs/task-verdicts.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * #460 — the engine collects a reviewer's packet at the step that wrote it, end to end.
 *
 * The unit-level rules live in `../runs/task-verdicts.test.ts`; what this file proves is the
 * WIRING, which no schema test can: that the collection point is reached at all, that it is the
 * settling agent step's own identity that is checked, and that the packet path the reviewer skills
 * are told to use is the path the engine reads. Driven through the real engine under
 * `XEZ_DRY_RUN=1`, where the bundled mock drops the packet exactly as a reviewing agent does
 * (`mock:verdict:<role>:<verdict>:<stepId>`).
 *
 * Named break: omit the collection call from step settlement, or let a check step collect — and,
 * for the packet the mock builds from `$XEZ_STEP_ID` alone, omit `XEZ_STEP_ID` from the step env.
 */
describe('a reviewer packet is collected at its own step (#460)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  const workflow: WorkflowDef = {
    name: 'verdict-collection-test',
    source: 'built-in',
    // The chain ends on a CHECK so the run settles without an interactive last turn: the reviewing
    // agent step is then an ordinary non-final step, which is what a reviewer workflow's is.
    steps: [
      { id: 'review', prompt: '{{task}}' },
      { id: 'gates', command: 'node -e "0"' },
    ],
  };

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-460-'));
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

  async function runToEnd(task: string): Promise<string> {
    const record = manager.startRun(workflow, { task, worktree: false });
    await settle(record.id);
    return record.id;
  }

  it('records the packet the reviewing step wrote, in that step’s own words', async () => {
    const id = await runToEnd('mock:done mock:verdict:qa:FAIL:review');

    const verdicts = store.getRun(id)?.verdicts ?? [];
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.role).toBe('qa');
    expect(verdicts[0]?.verdict).toBe('FAIL');
    expect(verdicts[0]?.stepId).toBe('review');
    expect(verdicts[0]?.source).toBe('task-reported');
    // Written before anything announced it — the recoverable half of the two-step publication.
    expect(verdicts[0]?.publication).toBe('pending');
    // And consumed, so no later step of the same chain is offered it again.
    expect(existsSync(taskVerdictPacketPath(dataDir, id))).toBe(false);
  }, 45_000);

  it('gives the agent its own step id, so a packet built from $XEZ_STEP_ID is accepted', async () => {
    // No step id in the token: the mock reads `XEZ_STEP_ID` exactly as the three reviewer skills
    // are told to. Before that variable existed a reviewer had nothing to read and the obvious
    // guesses ("code-review", the workflow name) were all refused, costing the whole verdict.
    const id = await runToEnd('mock:done mock:verdict:code-review:APPROVE');

    const verdicts = store.getRun(id)?.verdicts ?? [];
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.stepId).toBe('review');
    expect(store.getRun(id)?.verdictIssues).toBeUndefined();
  }, 45_000);

  it('refuses a packet naming a step other than the one that settled, and records why', async () => {
    const id = await runToEnd('mock:done mock:verdict:code-review:APPROVE:gates');

    expect(store.getRun(id)?.verdicts ?? []).toEqual([]);
    expect(store.getRun(id)?.verdictIssues ?? []).toHaveLength(1);
    expect(store.getRun(id)?.verdictIssues?.[0]?.stepId).toBe('review');
  }, 45_000);

  it('leaves a task that reported nothing without a verdict, however it finished', async () => {
    const id = await runToEnd('mock:done');

    expect(store.getRun(id)?.verdicts).toBeUndefined();
    expect(store.getRun(id)?.verdictIssues).toBeUndefined();
  }, 45_000);
});
