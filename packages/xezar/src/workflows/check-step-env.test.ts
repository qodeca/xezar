import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { closeStoreAndRemove } from '../runs/store.testkit.ts';
import type { WorkflowDef } from './types.ts';
import { RunManager } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const SEEN = 'check-env-seen.json';

/**
 * #1006 — a check step learns the task's PR number, so a workflow can check the PR out BEFORE a
 * read-only review agent starts (a Codex read-only step's sandbox cannot write git).
 *
 * `XEZ_PR_NUMBER` is the run's `prNumber` when the engine knows one, and ABSENT otherwise — also
 * when the engine's own environment carries one (a nested xezar), or a command step would check
 * out a PR that belongs to a different task. `XEZ_TASK_ID` stays out of check steps: the process
 * sweeper attributes programs to a run by that variable (src/runs/AGENTS.md § Run process sweep), and
 * the kit derives the task from the worktree directory instead.
 */
describe('check-step environment (#1006)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  const workflow: WorkflowDef = {
    name: 'check-env-test',
    source: 'built-in',
    steps: [
      {
        id: 'env',
        command: `node -e "const e=process.env; require('node:fs').writeFileSync('${SEEN}', JSON.stringify({ pr: e.XEZ_PR_NUMBER ?? null, task: e.XEZ_TASK_ID ?? null }))"`,
      },
    ],
  };

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-1006-'));
    for (const key of ['XEZ_DRY_RUN', 'XEZ_FOLLOWUPS', 'XEZ_PR_NUMBER', 'XEZ_TASK_ID']) savedEnv[key] = process.env[key];
    process.env.XEZ_DRY_RUN = '1';
    delete process.env.XEZ_FOLLOWUPS;
    delete process.env.XEZ_TASK_ID;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    writeFileSync(join(repoRoot, '.gitignore'), `.local/\n${SEEN}\n`);
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.local/xezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterAll(async () => {
    await manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    closeStoreAndRemove(store, repoRoot);
  });

  beforeEach(() => {
    if (existsSync(join(repoRoot, SEEN))) unlinkSync(join(repoRoot, SEEN));
    delete process.env.XEZ_PR_NUMBER;
  });

  async function seenBy(task: string): Promise<{ pr: string | null; task: string | null }> {
    const record = manager.startRun(workflow, { task, worktree: false });
    const deadline = Date.now() + 20_000;
    while (!['done', 'review', 'failed', 'cancelled'].includes(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(store.getRun(record.id)?.status).toBe('done');
    expect(existsSync(join(repoRoot, SEEN))).toBe(true);
    return JSON.parse(readFileSync(join(repoRoot, SEEN), 'utf8'));
  }

  it('gives a check step XEZ_PR_NUMBER when the run knows its PR', async () => {
    expect((await seenBy('Review pull request #123 against the spec')).pr).toBe('123');
  }, 30_000);

  it('omits XEZ_PR_NUMBER when the run knows no PR', async () => {
    expect((await seenBy('tidy the parser module')).pr).toBeNull();
  }, 30_000);

  it('drops an XEZ_PR_NUMBER inherited from the engine environment when the run knows no PR', async () => {
    process.env.XEZ_PR_NUMBER = '999';
    expect((await seenBy('tidy the parser module')).pr).toBeNull();
  }, 30_000);

  it("prefers the run's own PR over an inherited XEZ_PR_NUMBER", async () => {
    process.env.XEZ_PR_NUMBER = '999';
    expect((await seenBy('Review pull request #123')).pr).toBe('123');
  }, 30_000);

  // Guard (green before and after #1006): check steps stay outside the sweeper's attribution.
  it('keeps XEZ_TASK_ID out of a check step, with or without a PR', async () => {
    expect((await seenBy('Review pull request #123')).task).toBeNull();
    expect((await seenBy('tidy the parser module')).task).toBeNull();
  }, 30_000);
});
