import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RunStore } from '../runs/store.ts';
import { loadWorkflows } from './load.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const repoKit = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.xezar');

/**
 * #851 kit slice — the kit's `architecture-review` workflow is what lets the engine record an
 * architecture verdict at all, because a packet is recorded only as the role its step declares.
 *
 * The workflow FILE is loaded through the engine's own loader from a scratch copy of the kit, and
 * its review step is run under `XEZ_DRY_RUN=1`, where the bundled mock drops the packet exactly as
 * the reviewing agent does. The kit's `kit`/`preflight` check steps are left out: they bootstrap
 * against a real primary checkout, and what this file proves is the review step's declaration.
 *
 * Named break: delete `verdictRole: architecture-review` from `.xezar/workflows/architecture-review.yaml`
 * — the first case is then refused with the second case's reason.
 */
describe('the kit architecture-review workflow records its verdict (#851)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager;
  let kitWorkflow: WorkflowDef;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-851-kit-'));
    savedEnv.XEZ_DRY_RUN = process.env.XEZ_DRY_RUN;
    savedEnv.XEZ_FOLLOWUPS = process.env.XEZ_FOLLOWUPS;
    process.env.XEZ_DRY_RUN = '1';
    delete process.env.XEZ_FOLLOWUPS;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.xezar/workflows'), { recursive: true });
    mkdirSync(join(repoRoot, '.xezar/skills'), { recursive: true });
    copyFileSync(join(repoKit, 'workflows/architecture-review.yaml'), join(repoRoot, '.xezar/workflows/architecture-review.yaml'));
    copyFileSync(join(repoKit, 'skills/xezar-architecture-review.md'), join(repoRoot, '.xezar/skills/xezar-architecture-review.md'));
    writeFileSync(join(repoRoot, '.gitignore'), '.local/\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    dataDir = join(repoRoot, '.local/xezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir);
    manager = new RunManager(store, repoRoot);

    const loaded = await loadWorkflows(repoRoot);
    expect(loaded.issues).toEqual([]);
    const found = loaded.workflows.find((workflow) => workflow.name === 'architecture-review');
    if (!found) throw new Error('the kit architecture-review workflow did not load');
    kitWorkflow = found;
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

  /** The kit's own review step, as loaded, ending on a check so the run settles without an
   *  interactive last turn. `strip` removes the declaration, which is the named break. */
  function reviewOnly(strip: boolean): WorkflowDef {
    const review = kitWorkflow.steps.find((step) => step.id === 'review');
    if (!review) throw new Error('the kit workflow has no review step');
    const step = { ...review };
    if (strip) delete step.verdictRole;
    return { ...kitWorkflow, steps: [step, { id: 'gates', name: 'gates', command: 'node -e "0"' }] };
  }

  async function runToEnd(workflow: WorkflowDef): Promise<string> {
    const record = manager.startRun(workflow, { task: 'mock:done mock:verdict:architecture-review:APPROVE', worktree: false });
    const deadline = Date.now() + 30_000;
    while (!['done', 'review', 'failed', 'cancelled'].includes(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('the run did not settle in time');
      await new Promise((settle) => setTimeout(settle, 100));
    }
    return record.id;
  }

  it('records the architecture-review packet its review step wrote', async () => {
    const id = await runToEnd(reviewOnly(false));

    // Issues first: under the named break this is where the engine's refusal reason is printed.
    expect(store.getRun(id)?.verdictIssues?.map((issue) => issue.reason) ?? []).toEqual([]);
    expect(store.getRun(id)?.verdicts?.map((verdict) => [verdict.role, verdict.verdict, verdict.stepId])).toEqual([
      ['architecture-review', 'APPROVE', 'review'],
    ]);
  }, 45_000);

  it('refuses the same packet once the step no longer declares the role', async () => {
    const id = await runToEnd(reviewOnly(true));

    expect(store.getRun(id)?.verdicts ?? []).toEqual([]);
    expect(store.getRun(id)?.verdictIssues?.map((issue) => issue.reason)).toEqual([
      'the step that settled declares no verdict role, so its architecture-review packet cannot be recorded',
    ]);
  }, 45_000);
});
