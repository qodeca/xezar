import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unavailableAgentAccountRefusal } from '@qodeca/xezar-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planChain } from './planner.ts';
import { projectStateLayout, setActiveStateLayout } from './state-layout.ts';
import { mergeWriteAgentAccounts } from './workspace/agent-accounts.ts';

/**
 * #612 review m2: the planner spawns an agent CLI under the project's account, so in
 * single-project mode a committed account this machine lacks (#600 BR-4) must not be spawned on.
 * `XEZ_DRY_RUN=1` makes the mock `claude` answer a canned three-step chain, so a planner that
 * DID spawn would answer `fallback: false`.
 */
describe('planChain on an unavailable committed account (#612 m2)', () => {
  const savedDryRun = process.env.XEZ_DRY_RUN;
  let root: string;

  beforeEach(() => {
    process.env.XEZ_DRY_RUN = '1';
    root = realpathSync(mkdtempSync(join(tmpdir(), 'xez-planner-sp-')));
    setActiveStateLayout(projectStateLayout(root));
  });

  afterEach(() => {
    setActiveStateLayout(null);
    rmSync(root, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.XEZ_DRY_RUN;
    else process.env.XEZ_DRY_RUN = savedDryRun;
  });

  it('degrades to the one-step plan without spawning, and names the refusal', async () => {
    const missing = join(root, 'not-here');
    await mergeWriteAgentAccounts((store) => {
      store.accounts.push({ id: 'work', provider: 'claude', configDir: missing, label: 'Work account', addedAt: '' });
      store.selections[root] = { claude: 'work' };
    });

    const plan = await planChain(root, 'fix the calculation and run the tests');

    expect(plan.fallback).toBe(true);
    expect(plan.steps).toEqual([{ id: 'task', name: 'Do the task', prompt: '{{task}}' }]);
    expect(plan.rationale).toBe(unavailableAgentAccountRefusal('Work account', missing));
  }, 30_000);
});
