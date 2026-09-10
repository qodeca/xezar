import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { planResponseSchema, workflowStepDefSchema } from '@qodeca/xezar-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * `POST /api/v1/plan` (spec 008), gap R13 of the coverage audit (#52).
 *
 * Only the route's REJECTIONS were covered before this file: a disabled default runner
 * (`provider-action-gating.test.ts`) and an over-cap task (`request-validation.test.ts`). The
 * success body was asserted only by `contract-parity.workflows.test.ts`, which is a COMPILE-TIME
 * check — it never calls the handler, so a handler that stops sending a field still typechecks
 * and the cockpit silently renders an empty plan.
 *
 * So the assertion here is deliberately a RUNTIME one: take the bytes the route actually answered
 * and feed them to `planResponseSchema` from `@qodeca/xezar-contract`. Proven red by deleting
 * `fallback` from `planChain`'s success return — the parse then fails on the real response while
 * the type-level parity check stays green.
 *
 * `XEZ_DRY_RUN=1` swaps in the bundled mock `claude`, whose `[xez-planner]` branch answers a
 * canned three-step chain, so no CLI, login or network is involved.
 */
describe('POST /plan success body (#52)', () => {
  const savedDryRun = process.env.XEZ_DRY_RUN;
  const savedClaudeBin = process.env.XEZ_CLAUDE_BIN;
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    process.env.XEZ_DRY_RUN = '1';
    delete process.env.XEZ_CLAUDE_BIN;
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-plan-api-'));
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    app = createApp({
      repoRoot,
      store,
      // `POST /plan` never starts a run — the planner spawns its own one-shot session — so the
      // manager is a required dep this route must not reach for. Left unimplemented on purpose:
      // any call would throw and name itself in the failure.
      manager: {} as unknown as RunManager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.XEZ_DRY_RUN;
    else process.env.XEZ_DRY_RUN = savedDryRun;
    if (savedClaudeBin === undefined) delete process.env.XEZ_CLAUDE_BIN;
    else process.env.XEZ_CLAUDE_BIN = savedClaudeBin;
  });

  const postPlan = (task: string): Promise<Response> =>
    apiRequest(app, '/api/v1/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task }),
    });

  /** Parse the answered bytes with the contract schema, reporting the zod issues on failure. */
  const parsePlanBody = (body: unknown) => {
    const parsed = planResponseSchema.safeParse(body);
    // Surfaced first so a drifted field names itself in the failure output.
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable — asserted above');
    return parsed.data;
  };

  it('answers 200 with a body the contract schema parses AT RUNTIME', async () => {
    const res = await postPlan('Add a retry to the uploader');
    expect(res.status).toBe(200);

    const plan = parsePlanBody(await res.json());

    // The three always-present keys, checked as values rather than as types: a handler that
    // dropped any one of them fails `parsePlanBody` above, which is the point of this file.
    expect(plan.fallback).toBe(false);
    expect(typeof plan.rationale).toBe('string');
    expect(plan.rationale.length).toBeGreaterThan(0);
  }, 30_000);

  it('proposes at least one step, each carrying the fields the cockpit renders', async () => {
    const res = await postPlan('Add a retry to the uploader');
    const plan = parsePlanBody(await res.json());

    expect(plan.steps.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const step of plan.steps) {
      // `workflowStepDefSchema` carries the agent-XOR-check refinement, so parsing each step
      // individually pins the one rule `z.array(...)` inside the plan schema already applied —
      // kept explicit because it is what `draftFromPlan` in the cockpit relies on.
      expect(workflowStepDefSchema.safeParse(step).success).toBe(true);
      // `id` is what the builder canvas de-dupes on; `name` is optional in the schema but is
      // the visible label, so an unnamed step would render as a blank row.
      expect(step.id.length).toBeGreaterThan(0);
      expect(step.name?.trim()).toBeTruthy();
      expect(Boolean(step.command)).not.toBe(Boolean(step.prompt ?? step.skill));
      expect(ids.has(step.id)).toBe(false);
      ids.add(step.id);
    }
  }, 30_000);

  it('derives a non-empty kebab-case workflow name rather than answering an empty one', async () => {
    const res = await postPlan('Add a retry to the uploader');
    const plan = parsePlanBody(await res.json());

    expect(plan.name).toBeTruthy();
    // The builder saves this straight into a file name, so it must already be a valid slug.
    expect(plan.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }, 30_000);

  it('degrades a malformed planner answer to the fallback plan, never a 500', async () => {
    // A fake `claude` that speaks the stream-json protocol correctly but answers prose where
    // the planner expects JSON — the "model returned nonsense" path, not a crashed CLI.
    const bin = join(repoRoot, 'babbling-claude.mjs');
    writeFileSync(
      bin,
      [
        `#!${process.execPath}`,
        "import { createInterface } from 'node:readline';",
        'const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\\n`);',
        "emit({ type: 'system', subtype: 'init' });",
        "const text = 'Sure, I can help you plan that! What repository is this?';",
        'createInterface({ input: process.stdin }).on(\'line\', () => {',
        "  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });",
        "  emit({ type: 'result', subtype: 'success', result: text });",
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(bin, 0o755);
    process.env.XEZ_CLAUDE_BIN = bin;

    const res = await postPlan('Add a retry to the uploader');
    expect(res.status).toBe(200);

    const plan = parsePlanBody(await res.json());
    expect(plan.fallback).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.prompt).toBe('{{task}}');
    // No name on the degraded plan — the cockpit keeps whatever the user already typed.
    expect(plan.name).toBeUndefined();
  }, 30_000);
});
