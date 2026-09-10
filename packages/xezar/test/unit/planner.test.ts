import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { parseStructured, planChain, proposeWorkflowName } from '../../src/planner.js';

test('proposeWorkflowName slugs a title to the file-name form', () => {
  assert.equal(proposeWorkflowName('Fix And Review'), 'fix-and-review');
  assert.equal(proposeWorkflowName('  Ship it!  '), 'ship-it');
  assert.equal(proposeWorkflowName('already-kebab'), 'already-kebab');
});

test('proposeWorkflowName degrades a blank / slug-less title to undefined', () => {
  // The caller keeps the current name rather than blanking it when nothing survives.
  assert.equal(proposeWorkflowName(undefined), undefined);
  assert.equal(proposeWorkflowName('   '), undefined);
  assert.equal(proposeWorkflowName('!!! ???'), undefined);
});

test('parseStructured reads the optional planner title alongside the steps', () => {
  const schema = z.object({
    title: z.string().optional(),
    steps: z.array(z.object({ name: z.string() })),
  });
  const parsed = parseStructured(
    '```json\n{"title":"fix-and-review","steps":[{"name":"Implement"}]}\n```',
    schema,
  );
  assert.deepEqual(parsed, { title: 'fix-and-review', steps: [{ name: 'Implement' }] });
});

// ---- parseStructured: what a bad model answer must NOT do (#58) -------------

/** The planner's own response shape, restated here: `steps` is 1..5, so an
 *  answer with zero steps is a rejection, never an empty plan. */
const plannerShape = z.object({
  title: z.string().optional(),
  steps: z
    .array(
      z.object({
        skill: z.string().optional(),
        name: z.string().min(1),
        prompt: z.string().optional(),
        command: z.string().optional(),
      }),
    )
    .min(1)
    .max(5),
  rationale: z.string().default(''),
});

test('parseStructured answers null instead of throwing on a broken answer', () => {
  // Truncated mid-object — the commonest shape of a cut-off model reply.
  assert.equal(parseStructured('{"title":"fix","steps":[{"name":"Imp', plannerShape), null);
  // Empty and whitespace-only answers.
  assert.equal(parseStructured('', plannerShape), null);
  assert.equal(parseStructured('   \n  ', plannerShape), null);
  // Prose instead of JSON.
  assert.equal(parseStructured('I cannot plan this task.', plannerShape), null);
  // Valid JSON of the wrong structure.
  assert.equal(parseStructured('{"unexpected":true}', plannerShape), null);
  assert.equal(parseStructured('[1,2,3]', plannerShape), null);
  // A step with a blank name fails `min(1)` and takes the whole answer with it.
  assert.equal(parseStructured('{"steps":[{"name":""}]}', plannerShape), null);
});

test('parseStructured rejects a zero-step answer rather than yielding an empty plan', () => {
  assert.equal(parseStructured('{"title":"x","steps":[],"rationale":"nothing"}', plannerShape), null);
  // Also when the empty answer is wrapped in a fence or in prose.
  assert.equal(parseStructured('```json\n{"steps":[]}\n```', plannerShape), null);
  assert.equal(parseStructured('Here is the plan: {"steps":[]} — done', plannerShape), null);
});

test('parseStructured digs the object out of surrounding prose and fences', () => {
  const answer =
    'Sure! Here is the plan:\n\n```json\n' +
    '{"title":"Fix And Review","steps":[{"name":"Implement","prompt":"{{task}}"}],"rationale":"one pass"}' +
    '\n```\nHope that helps.';
  const parsed = parseStructured(answer, plannerShape);
  assert.equal(parsed?.title, 'Fix And Review');
  assert.equal(parsed?.steps.length, 1);
  // A string containing braces must not confuse the scanner.
  const withBraces = 'noise {not json} {"steps":[{"name":"a {b} c","prompt":"{{task}}"}],"rationale":""}';
  assert.equal(parseStructured(withBraces, plannerShape)?.steps[0]?.name, 'a {b} c');
});

// ---- planChain: every failure degrades to the one-step fallback (#58) -------

/** The exact fallback the module documents: never blocks the user. */
const FALLBACK_RATIONALE = 'planner unavailable — single-step plan';

/**
 * Run `planChain` against a fake `claude` binary that answers with `reply`
 * verbatim. `XEZ_CLAUDE_BIN` is the runner's own executable seam, so no real
 * agent CLI, no login and no network are involved. `bin: null` points the seam
 * at a path that does not exist, which is what a missing CLI looks like.
 */
async function planWithFakeAgent(
  task: string,
  reply: string | null,
): Promise<Awaited<ReturnType<typeof planChain>>> {
  const scratch = mkdtempSync(join(tmpdir(), 'xez-planner-'));
  const repoRoot = join(scratch, 'repo');
  const home = join(scratch, 'home');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  // A package.json gives `detectVerifyCommands` something real to find.
  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'vitest run', build: 'tsc' } }),
  );

  let bin = join(scratch, 'missing-claude');
  if (reply !== null) {
    bin = join(scratch, 'fake-claude.mjs');
    // Minimal stream-json CLI: answer each stdin turn with one `result`
    // frame, exit 0 when stdin closes. The shebang uses this very node.
    writeFileSync(
      bin,
      `#!${process.execPath}\n` +
        "import { createInterface } from 'node:readline';\n" +
        `const REPLY = ${JSON.stringify(reply)};\n` +
        "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');\n" +
        "const rl = createInterface({ input: process.stdin });\n" +
        "rl.on('line', () => {\n" +
        "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: REPLY }) + '\\n');\n" +
        '});\n' +
        "rl.on('close', () => process.exit(0));\n",
    );
    chmodSync(bin, 0o755);
  }

  const saved = {
    bin: process.env.XEZ_CLAUDE_BIN,
    home: process.env.XEZ_HOME,
    dry: process.env.XEZ_DRY_RUN,
  };
  process.env.XEZ_CLAUDE_BIN = bin;
  process.env.XEZ_HOME = home; // never the developer's real ~/.xezar
  delete process.env.XEZ_DRY_RUN;
  try {
    return await planChain(repoRoot, task);
  } finally {
    if (saved.bin === undefined) delete process.env.XEZ_CLAUDE_BIN;
    else process.env.XEZ_CLAUDE_BIN = saved.bin;
    if (saved.home === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = saved.home;
    if (saved.dry === undefined) delete process.env.XEZ_DRY_RUN;
    else process.env.XEZ_DRY_RUN = saved.dry;
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The degraded plan is always usable: one runnable step and a message saying why. */
function assertFallback(plan: Awaited<ReturnType<typeof planChain>>): void {
  assert.equal(plan.fallback, true);
  assert.equal(plan.rationale, FALLBACK_RATIONALE);
  assert.ok(plan.rationale.length > 0, 'the degraded plan must carry a message');
  assert.deepEqual(plan.steps, [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }]);
  assert.equal(plan.name, undefined);
}

test('planChain degrades to the one-step plan when the agent CLI is missing', async () => {
  // A spawn error is the "no dependency present" case AGENTS.md requires to
  // degrade rather than fail.
  assertFallback(await planWithFakeAgent('fix the login bug', null));
});

test('planChain degrades on a truncated answer', async () => {
  assertFallback(await planWithFakeAgent('fix the login bug', '{"title":"fix","steps":[{"name":"Imp'));
});

test('planChain degrades on an empty answer', async () => {
  assertFallback(await planWithFakeAgent('fix the login bug', ''));
});

test('planChain degrades on an answer that is not the expected structure', async () => {
  assertFallback(await planWithFakeAgent('fix the login bug', 'I am unable to plan this.'));
  assertFallback(await planWithFakeAgent('fix the login bug', '{"plan":"do it"}'));
});

test('planChain reports a zero-step answer as degraded, never as an empty plan', async () => {
  const plan = await planWithFakeAgent(
    'fix the login bug',
    '{"title":"empty","steps":[],"rationale":"nothing to do"}',
  );
  assertFallback(plan);
  assert.notEqual(plan.steps.length, 0);
});

test('planChain degrades when every proposed step is unusable', async () => {
  // Both a prompt and a command (ambiguous), and neither (empty) — the
  // sanitizer drops both, so nothing survives and the caller falls back.
  const plan = await planWithFakeAgent(
    'fix the login bug',
    JSON.stringify({
      title: 'bad-steps',
      steps: [
        { name: 'Both', prompt: '{{task}}', command: 'npm test' },
        { name: 'Neither' },
      ],
      rationale: 'nonsense',
    }),
  );
  assertFallback(plan);
});

test('planChain returns a real plan when the answer is usable', async () => {
  // Positive control: without it, every assertion above would also pass on a
  // planner that had stopped working entirely.
  const plan = await planWithFakeAgent(
    'fix the login bug',
    '```json\n' +
      JSON.stringify({
        title: 'Fix And Review',
        steps: [
          { name: 'Implement', skill: 'no-such-skill', prompt: 'Do {{task}}' },
          { name: 'Implement', prompt: 'Again {{task}}' },
          { name: 'Verify', skill: 'no-such-skill', command: 'npm test' },
        ],
        rationale: 'implement then verify',
      }) +
      '\n```',
  );
  assert.equal(plan.fallback, false);
  assert.equal(plan.name, 'fix-and-review');
  assert.equal(plan.rationale, 'implement then verify');
  assert.deepEqual(
    plan.steps.map((s) => s.id),
    ['implement', 'implement-2', 'verify'],
  );
  // An unknown skill is stripped; the prompt still carries the step.
  assert.equal(plan.steps[0]?.skill, undefined);
  assert.equal(plan.steps[0]?.prompt, 'Do {{task}}');
  // A shell check carries no skill and no prompt.
  assert.equal(plan.steps[2]?.command, 'npm test');
  assert.equal(plan.steps[2]?.skill, undefined);
  assert.equal(plan.steps[2]?.prompt, undefined);
});
