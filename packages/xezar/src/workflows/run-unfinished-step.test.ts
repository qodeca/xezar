import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';
import { RunManager } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * #317 — a non-final agent step that ends its turn without `XEZ:DONE` is not done.
 *
 * Run b86c6066's implement step ended on a design question (`XEZ:ASK`), the engine marked it
 * `done` because its session closed without an error, and readiness, the gates and the seal all
 * ran on a branch holding none of the task's work. The kit's BLOCKED file only helps when the
 * agent writes one; this is the stop that does not depend on it.
 *
 * Shape: the README's `implement` + `verify` workflow, with the check standing in for the kit's
 * `readiness` step — it leaves a file behind, so "did the workflow proceed" is observable. Driven
 * through the real engine under `XEZ_DRY_RUN=1`; the mock's reply ends with whatever marker the
 * task text names (`mock:done`, `mock:ask`, `mock:monitoring`) and with none otherwise.
 */
describe('a non-final agent step that did not finish stops the workflow (#317)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};
  const readinessRan = () => existsSync(join(repoRoot, 'readiness-ran'));

  const workflow: WorkflowDef = {
    name: 'unfinished-step-test',
    source: 'built-in',
    steps: [
      { id: 'implement', prompt: '{{task}}' },
      { id: 'readiness', command: 'node -e "require(\'node:fs\').writeFileSync(\'readiness-ran\', \'\')"' },
    ],
  };

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-317-'));
    savedEnv.XEZ_DRY_RUN = process.env.XEZ_DRY_RUN;
    savedEnv.XEZ_FOLLOWUPS = process.env.XEZ_FOLLOWUPS;
    process.env.XEZ_DRY_RUN = '1';
    delete process.env.XEZ_FOLLOWUPS;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    writeFileSync(join(repoRoot, '.gitignore'), '.local/\nreadiness-ran\nnotes.md\n');
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
    rmSync(repoRoot, { recursive: true, force: true });
  });

  beforeEach(() => rmSync(join(repoRoot, 'readiness-ran'), { force: true }));

  async function settle(runId: string, statuses = ['done', 'review', 'failed', 'cancelled']): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!statuses.includes(store.getRun(runId)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error(`run did not reach ${statuses.join('/')} in time`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function runToEnd(task: string, wf = workflow) {
    const record = manager.startRun(wf, { task, worktree: false });
    await settle(record.id);
    return store.getRun(record.id);
  }

  it('a step that ends on an XEZ:ASK question fails, and readiness never runs', async () => {
    const finished = await runToEnd('mock:ask which library should the parser use');
    expect(finished?.status).toBe('failed');
    expect(finished?.steps.map((s) => ({ id: s.id, status: s.status }))).toEqual([
      { id: 'implement', status: 'failed' },
      { id: 'readiness', status: 'pending' },
    ]);
    expect(finished?.error).toContain('step "implement" failed');
    expect(finished?.error).toContain('XEZ:ASK');
    expect(finished?.error).toContain('Continue this task to answer it');
    expect(readinessRan()).toBe(false);
  }, 30_000);

  it('a step that ends on a plain-prose question, with no marker at all, fails the same way', async () => {
    const finished = await runToEnd('should the parser keep the old envelope or the new one?');
    expect(finished?.status).toBe('failed');
    expect(finished?.steps.find((s) => s.id === 'implement')?.status).toBe('failed');
    expect(finished?.error).toContain('without the XEZ:DONE completion marker');
    expect(readinessRan()).toBe(false);
  }, 30_000);

  it('a step that ends still monitoring its own work is not done either', async () => {
    const finished = await runToEnd('mock:monitoring wait for the review agent');
    expect(finished?.status).toBe('failed');
    expect(finished?.error).toContain('XEZ:MONITORING');
    expect(readinessRan()).toBe(false);
  }, 30_000);

  // The control: an ordinary completion must still proceed, or the guard is worse than none.
  it('a step that ends with XEZ:DONE is done, and the workflow proceeds to readiness', async () => {
    const finished = await runToEnd('mock:done fix the parser');
    expect(finished?.status).toBe('done');
    expect(finished?.steps.map((s) => ({ id: s.id, status: s.status }))).toEqual([
      { id: 'implement', status: 'done' },
      { id: 'readiness', status: 'done' },
    ]);
    expect(readinessRan()).toBe(true);
  }, 30_000);

  /**
   * #676 B8 — the cheap repair turn is still a non-final agent step, so #317 judges it exactly
   * as it judges a fresh one: a clean session close is not a finished step.
   *
   * Also AC5 and the headless proof: this drives the REAL `--resume` through the bundled mock
   * CLI under `XEZ_DRY_RUN=1`, the same `RunManager` path `xezar run` uses, and reads the argv
   * the mock recorded. The gate's own stdout becomes the repair turn's whole prompt, so what
   * the check prints is what decides whether the repair turn ends with a marker.
   */
  it.each([
    { name: 'a repair turn without XEZ:DONE fails the step', gateSays: 'the gate is red', status: 'failed' },
    { name: 'a repair turn that finishes proceeds', gateSays: 'the gate is red — mock:done', status: 'done' },
  ])('#676: $name', async ({ gateSays, status }) => {
    const argsFile = join(repoRoot, `mock-args-${status}.ndjson`);
    const gate = join(repoRoot, `gate-${status}.cjs`);
    const flag = join(repoRoot, `gate-ran-${status}`);
    writeFileSync(gate, `const fs = require('node:fs');
if (fs.existsSync(${JSON.stringify(flag)})) process.exit(0);
fs.writeFileSync(${JSON.stringify(flag)}, 'yes');
console.log(${JSON.stringify(gateSays)});
process.exit(1);
`);
    const saved = process.env.XEZ_MOCK_ARGS_FILE;
    process.env.XEZ_MOCK_ARGS_FILE = argsFile;
    try {
      const record = manager.startRun(
        {
          name: 'cheap-return-dry-run',
          source: 'built-in',
          steps: [
            { id: 'implement', prompt: '{{task}}' },
            { id: 'gates', command: `node ${JSON.stringify(gate)}`, onFail: { retry: 'implement', max: 2 } },
          ],
        },
        { task: 'mock:done fix the parser', worktree: false },
      );
      await settle(record.id);
      expect(store.getRun(record.id)?.status).toBe(status);
      // The second CLI invocation really carried `--resume <the first session id>`.
      const invocations = readFileSync(argsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
      expect(invocations.length).toBeGreaterThanOrEqual(2);
      expect(invocations[0]).not.toContain('--resume');
      expect(invocations[1]).toContain('--resume');
    } finally {
      if (saved === undefined) delete process.env.XEZ_MOCK_ARGS_FILE;
      else process.env.XEZ_MOCK_ARGS_FILE = saved;
    }
  }, 40_000);

  // Passes with or without the fix: the LAST step is interactive and keeps its own rules — a
  // markerless turn parks it at `waiting` for the user's reply, it is never failed.
  it('the last agent step still parks at waiting on a markerless turn', async () => {
    const lastIsAgent: WorkflowDef = {
      name: 'unfinished-step-last',
      source: 'built-in',
      steps: [{ id: 'task', prompt: '{{task}}' }],
    };
    const record = manager.startRun(lastIsAgent, { task: 'which envelope should I use?', worktree: false });
    await settle(record.id, ['waiting', 'failed', 'done']);
    expect(store.getRun(record.id)?.status).toBe('waiting');
    expect(store.getRun(record.id)?.steps[0]?.status).toBe('waiting');
    manager.cancel(record.id);
    await settle(record.id, ['cancelled', 'done', 'failed']);
  }, 30_000);
});
