import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chainStepNote,
  MAX_STEP_TIMEOUT_MS,
  normalizeWorkflowDoc,
  parseStepTimeout,
  skillStackOf,
  skillsToSteps,
  stepsIssue,
  stepTimeoutMs,
  workflowFileSchema,
  workflowStepSchema,
  type WorkflowStepDef,
} from '../../src/workflows/types.js';

test('portable skill stacks normalize into unique agent steps', () => {
  const parsed = workflowFileSchema.parse({
    name: 'review-twice',
    skills: ['code-review', 'code-review'],
  });

  assert.deepEqual(normalizeWorkflowDoc(parsed), {
    name: 'review-twice',
    steps: [
      { id: 'code-review', name: 'code-review', skill: 'code-review', prompt: '{{task}}' },
      { id: 'code-review-2', name: 'code-review', skill: 'code-review', prompt: '{{task}}' },
    ],
  });
});

test('workflow files require exactly one step representation', () => {
  assert.equal(workflowFileSchema.safeParse({ name: 'empty' }).success, false);
  assert.equal(
    workflowFileSchema.safeParse({
      name: 'ambiguous',
      skills: ['review'],
      steps: [{ id: 'review', prompt: '{{task}}' }],
    }).success,
    false,
  );
});

test('retry targets must refer to an earlier unique step', () => {
  assert.equal(
    stepsIssue([
      { id: 'implement', prompt: '{{task}}' },
      { id: 'verify', command: 'npm test', onFail: { retry: 'implement', max: 2 } },
    ]),
    null,
  );
  assert.equal(
    stepsIssue([
      { id: 'verify', command: 'npm test', onFail: { retry: 'implement', max: 2 } },
      { id: 'implement', prompt: '{{task}}' },
    ]),
    'step "verify": onFail.retry must reference an earlier step (got "implement")',
  );
  assert.equal(
    stepsIssue([
      { id: 'duplicate', prompt: '{{task}}' },
      { id: 'duplicate', command: 'npm test' },
    ]),
    'duplicate step id "duplicate"',
  );
});

test('only plain agent skill steps compact back to a portable stack', () => {
  assert.deepEqual(skillStackOf(skillsToSteps(['implement', 'review'])), ['implement', 'review']);
  assert.equal(skillStackOf([{ id: 'verify', command: 'npm test' }]), null);
  assert.equal(
    skillStackOf([{ id: 'review', name: 'Custom name', skill: 'review', prompt: '{{task}}' }]),
    null,
  );
  // #22: the compact `skills:` form has nowhere to put a per-step timeout, so a step
  // carrying one is "richer" — compacting it would silently reset it to 30 minutes.
  assert.equal(
    skillStackOf([{ id: 'review', name: 'review', skill: 'review', prompt: '{{task}}', timeout: '90m' }]),
    null,
  );
});

// ---- per-step wall-clock timeout (#22) --------------------------------------------------
// Non-final agent steps inherit the runner's 30-minute DEFAULT_RUN_TIMEOUT_MS and used to
// have no way to raise it; two real bug-fix tasks were killed mid-investigate with nothing
// committed. These pin the grammar, the two deliberate refusals, and the untouched default.

test('parseStepTimeout reads the accepted duration units', () => {
  assert.equal(parseStepTimeout('45s'), 45_000);
  assert.equal(parseStepTimeout('90m'), 5_400_000);
  assert.equal(parseStepTimeout('2h'), 7_200_000);
  assert.equal(parseStepTimeout('1s'), 1_000);
});

test('parseStepTimeout maps the literal "none" to 0 — the runners\' "arm no deadline"', () => {
  assert.equal(parseStepTimeout('none'), 0);
});

test('parseStepTimeout refuses anything outside the grammar', () => {
  for (const bad of ['', '30', 'm', '30 m', '30M', '1.5h', '-5m', '30d', '90ms', 'never', 'none ', '+2h']) {
    assert.equal(parseStepTimeout(bad), null, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test('parseStepTimeout refuses a zero duration and anything past the setTimeout ceiling', () => {
  // "0 seconds" reads as "kill it at once", which is the opposite of the 0 the runners
  // use for "no cap" — `none` is the only spelling for that.
  for (const zero of ['0s', '0m', '0h']) assert.equal(parseStepTimeout(zero), null);
  // 2^31-1 ms is Node's setTimeout ceiling; past it the timer fires almost immediately,
  // so accepting `1000h` would kill the step it was meant to protect.
  assert.equal(parseStepTimeout('596h'), 596 * 3_600_000);
  assert.ok((parseStepTimeout('596h') as number) <= MAX_STEP_TIMEOUT_MS);
  assert.equal(parseStepTimeout('597h'), null);
  assert.equal(parseStepTimeout('1000h'), null);
});

test('the step schema accepts a valid timeout and rejects an unknown format', () => {
  assert.equal(workflowStepSchema.safeParse({ id: 'a', prompt: '{{task}}', timeout: '90m' }).success, true);
  assert.equal(workflowStepSchema.safeParse({ id: 'a', prompt: '{{task}}', timeout: 'none' }).success, true);

  const bad = workflowStepSchema.safeParse({ id: 'a', prompt: '{{task}}', timeout: '90 minutes' });
  assert.equal(bad.success, false);
  assert.match(bad.error?.issues[0]?.message ?? '', /timeout must be "none" or a positive duration/);
});

test('the step schema refuses a timeout on a check step — a shell command has no wall clock', () => {
  const parsed = workflowStepSchema.safeParse({ id: 'verify', command: 'npm test', timeout: '90m' });
  assert.equal(parsed.success, false);
  assert.match(parsed.error?.issues[0]?.message ?? '', /a check step \(command\) has no wall clock/);
});

test('a workflow FILE with a per-step timeout loads', () => {
  const parsed = workflowFileSchema.safeParse({
    name: 'long-investigate',
    steps: [
      { id: 'investigate', prompt: '{{task}}', timeout: '3h' },
      { id: 'verify', command: 'npm test' },
    ],
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.steps?.[0]?.timeout, '3h');
});

test('stepTimeoutMs leaves the zero-config default EXACTLY where it was', () => {
  // No `timeout` key: a non-final agent step still gets `undefined`, which is what falls
  // through to the runner's own 30-minute DEFAULT_RUN_TIMEOUT_MS. This is the assertion
  // that says "this change moved nothing for anyone who did not ask for it".
  assert.equal(stepTimeoutMs({ id: 'work', prompt: '{{task}}' }, false), undefined);
  // …and the workflow's last (interactive) step stays uncapped, as before.
  assert.equal(stepTimeoutMs({ id: 'work', prompt: '{{task}}' }, true), 0);
});

test('stepTimeoutMs lets the step outrank both defaults', () => {
  assert.equal(stepTimeoutMs({ id: 'work', prompt: '{{task}}', timeout: '90m' }, false), 5_400_000);
  assert.equal(stepTimeoutMs({ id: 'work', prompt: '{{task}}', timeout: 'none' }, false), 0);
  // A step may also tighten the interactive step, which was previously uncappable.
  assert.equal(stepTimeoutMs({ id: 'work', prompt: '{{task}}', timeout: '45s' }, true), 45_000);
});

// #410: a chain of 2+ skills gave every step the SAME task text and shared
// one run-level handoff journal — a later step's fresh session had nothing
// telling it "an earlier step's own completion doesn't cover you", so it
// could read the earlier step's "done" signal and self-terminate (`XEZ:DONE`)
// on its first turn without doing its own step's work. `chainStepNote` is the
// prompt-level guard against that; these pin its exact contract.
test('chainStepNote is absent for a single-step run (the common case, unchanged)', () => {
  assert.equal(chainStepNote(skillsToSteps(['implement']), 0), undefined);
});

test('chainStepNote counts AGENT steps only — a lone agent step plus checks is not a chain', () => {
  // The README's canonical workflow (README.md): one agent step + one check
  // that loops back to it. `steps.length` is 2, but there is no step boundary
  // for an agent to misread, so the prompt must stay untouched.
  const readmeShape: WorkflowStepDef[] = [
    { id: 'implement', skill: 'project-conventions', prompt: '{{task}}' },
    { id: 'verify', command: 'npm test', onFail: { retry: 'implement', max: 2 } },
  ];
  assert.equal(chainStepNote(readmeShape, 0), undefined);
  // A check step never gets a note of its own — it has no prompt.
  assert.equal(chainStepNote(readmeShape, 1), undefined);
});

test('chainStepNote numbers agent steps, skipping the checks between them', () => {
  const withCheck: WorkflowStepDef[] = [
    { id: 'review', skill: 'om-auto-review-pr', prompt: '{{task}}' },
    { id: 'verify', command: 'npm test' },
    { id: 'ui', skill: 'om-auto-verify-pr-ui', prompt: '{{task}}' },
  ];
  // The second AGENT step is "step 2 of 2", not "step 3 of 3".
  assert.ok(chainStepNote(withCheck, 0)?.includes('step 1 of 2'));
  assert.equal(chainStepNote(withCheck, 1), undefined);
  assert.ok(chainStepNote(withCheck, 2)?.includes('step 2 of 2'));
});

test('chainStepNote names the step position, total, and skill for every step of a chain', () => {
  const steps = skillsToSteps(['om-auto-review-pr', 'om-auto-verify-pr-ui']);
  const first = chainStepNote(steps, 0);
  const second = chainStepNote(steps, 1);

  assert.ok(first?.includes('step 1 of 2'));
  assert.ok(first?.includes('om-auto-review-pr'));
  assert.ok(second?.includes('step 2 of 2'));
  assert.ok(second?.includes('om-auto-verify-pr-ui'));
  for (const note of [first, second]) assert.ok(note?.includes('XEZ:DONE'));
  // The whole point: tell a step that HAS a predecessor that the predecessor's
  // completion isn't its own. On step 1 that premise is false, so it is left out.
  assert.ok(second?.includes("does not mean step 2's work is done"));
  assert.ok(!first?.includes('earlier step'));
});

test('chainStepNote labels a step by its name first, then its skill, then generically', () => {
  // `name` is what the author called the step and what the GUI rail shows; a
  // skill is a support for the step's goal, not the goal itself.
  const named = chainStepNote(
    [
      { id: 'implement', name: 'Implement', skill: 'project-conventions', prompt: '{{task}}' },
      { id: 'review', skill: 'code-review', prompt: '{{task}}' },
    ],
    0,
  );
  assert.ok(named?.includes('"Implement"'));
  assert.ok(!named?.includes('project-conventions'));

  const bare = chainStepNote([{ id: 'step-1', prompt: '{{task}}' }, { id: 'step-2', prompt: '{{task}}' }], 0);
  assert.ok(bare?.includes('this step'));
});
