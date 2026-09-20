import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import * as factory from '../core/runner-factory.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { scriptedRunner, type ScriptedTurn } from './engine-incidents.testkit.ts';
import type { WorkflowDef, WorkflowStepDef } from './types.ts';

const roots: string[] = [];
const managers: RunManager[] = [];
const stores: RunStore[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.quiesce();
  for (const store of stores.splice(0)) store.flush();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(turns: Array<{ text?: string; before?: (spec: AgentRunSpec) => void }>) {
  const root = mkdtempSync(join(tmpdir(), 'xez-repair-'));
  roots.push(root);
  const store = RunStore.open(join(root, 'data'));
  stores.push(store);
  const manager = new RunManager(store, root);
  managers.push(manager);
  const nudges = vi.fn(() => false);
  let invocation = 0;
  vi.spyOn(factory, 'createRunner').mockImplementation(() => ({
    backend: 'claude', interrupt: async () => {},
    run: async () => { throw new Error('unexpected one-shot'); },
    startSession(spec, emit, options) {
      const turn = turns[invocation++];
      if (!turn) throw new Error('unexpected extra agent');
      const text = turn.text ?? 'XEZ:DONE';
      let open = true;
      let resolve!: (result: AgentRunResult) => void;
      const result = new Promise<AgentRunResult>(done => { resolve = done; });
      const end = () => { open = false; resolve({ text, tokensUsed: 0, toolCalls: [] }); };
      queueMicrotask(() => {
        turn.before?.(spec);
        emit?.({ type: 'session', sessionId: 'repair-session' });
        emit?.({ type: 'text', text });
        emit?.({ type: 'turn-end' });
        if (options?.autoEndAfterFirstTurn) end();
      });
      return { result, get open() { return open; }, end, interrupt: end, sendMessage: nudges };
    },
  }));
  return { root, store, manager, nudges };
}

async function settled(store: RunStore, id: string) {
  await expect.poll(() => store.getRun(id)?.status, { interval: 10 })
    .toSatisfy(value => ['done', 'failed'].includes(String(value)));
}

it.each(['XEZ:DONE\nCheckpoint: saved', ' \tXEZ:DONE \t\r\nCheckpoint: saved\r\n']) (
  'accepts a standalone final marker before the checkpoint: %j', async text => {
    const { store, manager, nudges } = fixture([{ text }]);
    const run = manager.startRun({ name: 'one', source: 'built-in', steps: [{ id: 'author', prompt: '{{task}}' }] },
      { task: 'finish', worktree: false, autonomous: true });
    await expect.poll(() => store.getRun(run.id)?.status).not.toBe('queued');
    await expect.poll(() => store.getRun(run.id)?.steps[0]?.sessionId).toBe('repair-session');
    expect(nudges).not.toHaveBeenCalled();
    await settled(store, run.id);
    expect(store.getRun(run.id)?.status).toBe('done');
  },
);

const fencedExamples = [
  { name: 'reviewer backtick example', text: 'Example:\n```text\nXEZ:DONE\n```\nCheckpoint: saved' },
  { name: 'tilde example with info string', text: 'Example:\n~~~text extra info\nXEZ:DONE\n~~~\nCheckpoint: saved' },
  { name: 'unclosed backtick fence at end of turn', text: 'Example:\n```text\nXEZ:DONE' },
  { name: 'unclosed tilde fence', text: 'Example:\n~~~text\nXEZ:DONE\nCheckpoint: saved' },
  { name: 'nested shorter fence', text: '````markdown\n```text\nXEZ:DONE\n```\nXEZ:DONE\n````\nCheckpoint: saved' },
  { name: 'nested opposite fence', text: '```markdown\n~~~text\nXEZ:DONE\n~~~\nXEZ:DONE\n```\nCheckpoint: saved' },
  { name: 'info string does not close fence', text: '```text\n```still inside\nXEZ:DONE' },
];

async function finalTurn(text: string) {
  const context = fixture([{ text }]);
  let previous: string | undefined;
  let completions = 0;
  // Observe completion directly; startup can outlast a poll budget during the full gate, and a
  // direct observation says which transition never came rather than only that one did not.
  // The enclosing test timeout still bounds a missing transition.
  let resolveFinalStatus!: () => void;
  const finalStatus = new Promise<void>(resolve => { resolveFinalStatus = resolve; });
  context.store.on('run', (record: RunRecord) => {
    if (['waiting', 'done', 'failed'].includes(record.status)) resolveFinalStatus();
    if (record.status === 'done' && previous !== 'done') completions++;
    previous = record.status;
  });
  const run = context.manager.startRun(
    { name: 'one', source: 'built-in', steps: [{ id: 'author', prompt: '{{task}}' }] },
    { task: 'finish', worktree: false, autonomous: true },
  );
  await finalStatus;
  expect(context.store.getRun(run.id)?.status)
    .toSatisfy(status => status === 'waiting' || status === 'done');
  return { ...context, status: context.store.getRun(run.id)?.status, completions };
}

it.each(fencedExamples)('ignores fenced DONE like a markerless final autonomous turn: $name', async ({ text }) => {
  const control = await finalTurn('Example: completion marker omitted\nCheckpoint: saved');
  expect(control.status).toBe('waiting');
  const example = await finalTurn(text);
  expect(example.status).toBe(control.status);
  expect(example.nudges).toHaveBeenCalledTimes(control.nudges.mock.calls.length);
  expect(example.completions).toBe(0);
});

it.each(fencedExamples.slice(0, 2))('completes once for a real DONE after a closed fenced example: $name', async ({ text }) => {
  const result = await finalTurn(`${text}\n \tXEZ:DONE \t\r\nCheckpoint: saved\r\n`);
  expect(result.status).toBe('done');
  expect(result.completions).toBe(1);
  expect(result.nudges).not.toHaveBeenCalled();
});

it.each([
  { repaired: true, legacyDone: false },
  { repaired: false, legacyDone: false },
  { repaired: true, legacyDone: true },
])('retries the whole tail ($repaired, legacy done=$legacyDone)', async ({ repaired, legacyDone }) => {
  const { root, store, manager } = fixture([{}, { before: spec => {
    appendFileSync(join(spec.cwd, 'order'), 'repair\n');
    if (repaired) writeFileSync(join(spec.cwd, 'ready'), 'yes');
  } }, { before: spec => appendFileSync(join(spec.cwd, 'order'), 'final-agent\n') }]);
  writeFileSync(join(root, 'check.cjs'), `const fs = require('node:fs');
const name = process.argv[2]; fs.appendFileSync('order', name + '\\n');
if (name === 'readiness' && !fs.existsSync('ready')) process.exit(1);`);
  const workflow: WorkflowDef = { name: 'repair', source: 'built-in', steps: [
    { id: 'author', prompt: '{{task}}' },
    ...['readiness', 'gates', 'evidence', 'handoff'].map(id => ({ id, command: `node check.cjs ${id}` })),
    { id: 'final-agent', prompt: '{{task}}' },
  ] };
  const run = manager.startRun(workflow, { task: 'work', worktree: false });
  await settled(store, run.id);
  expect(store.getRun(run.id)?.status).toBe('failed');
  if (legacyDone) {
    store.updateStep(run.id, 'readiness', { status: 'pending' });
    store.updateRun(run.id, { status: 'done' });
  }
  const premature: string[] = [];
  let started = false;
  store.on('run', (record: RunRecord) => {
    if (record.id === run.id && record.status === 'running') started = true;
    if (started && record.id === run.id && record.status === 'done' &&
        workflow.steps.some(step => record.steps.find(s => s.id === step.id)?.status !== 'done')) premature.push('pending');
  });
  expect(manager.continueRun(run.id, { text: 'repair' })).toEqual({ ok: true });
  await expect.poll(() => store.getRun(run.id)?.steps.find(s => s.id === 'continue-1')?.status)
    .toSatisfy(status => status === 'done' || status === 'failed');
  await expect.poll(() => manager.isActive(run.id)).toBe(false);
  await settled(store, run.id);
  expect(readFileSync(join(root, 'order'), 'utf8').trim().split('\n')).toEqual(repaired
    ? ['readiness', 'repair', 'readiness', 'gates', 'evidence', 'handoff', 'final-agent']
    : ['readiness', 'repair', 'readiness']);
  expect(premature).toEqual([]);
  expect(store.getRun(run.id)?.status).toBe(repaired ? 'done' : 'failed');
});

/**
 * #676 — the FIRST automatic return after a red check resumes the author's own session and
 * sends it only the failing output; the SECOND is byte-for-byte the fresh spawn it has always
 * been. The return is counted either way: `onFail.max` stays 2 and the terminal message is
 * unchanged. Named breaks B1–B8 in the issue's spec; B7 lives in `step-timeout-wiring.test.ts`
 * and B8 in `run-unfinished-step.test.ts`, which own those seams.
 */
describe('the cheap return after a red check (#676)', () => {
  const TASK = 'repair-the-gate-brief';

  /**
   * author agent + a `gates` check that exits non-zero its first `failures` times.
   * `script` replaces the default "every turn says XEZ:DONE" tape — one entry per spawn, so a
   * turn can be made to fail the way a real backend fails. `authorStep` merges into the author
   * step definition (a per-step `runner`, for the backends that cannot resume at all).
   */
  function cheapFixture(
    failures: number,
    turns = 3,
    script?: ScriptedTurn[],
    authorStep: Partial<WorkflowStepDef> = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), 'xez-676-'));
    roots.push(root);
    writeFileSync(join(root, 'check.cjs'), `const fs = require('node:fs');
const n = (fs.existsSync('count') ? Number(fs.readFileSync('count', 'utf8')) : 0) + 1;
fs.writeFileSync('count', String(n));
if (n <= ${failures}) { console.log('GATE-RED-' + n + ' the failing gate output'); process.exit(1); }
`);
    const store = RunStore.open(join(root, 'data'));
    stores.push(store);
    const manager = new RunManager(store, root);
    managers.push(manager);
    const runner = scriptedRunner(script ?? Array.from({ length: turns }, () => ({})));
    const workflow: WorkflowDef = {
      name: 'cheap-return', source: 'file', steps: [
        { id: 'author', prompt: '{{task}}', ...authorStep },
        { id: 'gates', command: 'node check.cjs', onFail: { retry: 'author', max: 2 } },
      ],
    };
    return { root, store, manager, runner, workflow };
  }

  // B1 (always spawn fresh), B2 (send the full prompt on the cheap turn), B4 (use the cheap
  // path on return #2 as well) — and AC1.
  it('return #1 resumes the recorded session with only the failing output; return #2 is fresh', async () => {
    const { store, manager, runner, workflow } = cheapFixture(2);
    try {
      const run = manager.startRun(workflow, { task: TASK, worktree: false });
      await settled(store, run.id);
      expect(store.getRun(run.id)?.status).toBe('done');
      expect(runner.specs).toHaveLength(3);

      const [first, cheap, fresh] = runner.specs;
      // The first execution is untouched: whole brief, no resume.
      expect(first?.resume).toBeFalsy();
      expect(first?.userPrompt).toContain(TASK);

      // B1 — return #1 reopens the SAME session the first execution recorded.
      expect(cheap?.resume).toBe(true);
      expect(cheap?.sessionId).toBe(first?.sessionId);
      // B2 — the failing output, and deliberately not the brief.
      expect(cheap?.userPrompt).toContain('GATE-RED-1 the failing gate output');
      expect(cheap?.userPrompt).not.toContain(TASK);
      expect(cheap?.userPrompt).toContain('repair turn');
      // The system prompt is composed exactly as for a fresh spawn — that is what keeps the
      // skill body (and its counter instruction) in front of the agent on a resumed turn.
      expect(cheap?.systemPrompt).toBe(first?.systemPrompt);

      // B4 — return #2 is today's spawn, byte for byte: fresh id, whole brief, failing output.
      expect(fresh?.resume).toBeFalsy();
      expect(fresh?.sessionId).not.toBe(first?.sessionId);
      expect(fresh?.userPrompt).toContain(TASK);
      expect(fresh?.userPrompt).toContain('GATE-RED-2 the failing gate output');
    } finally {
      runner.restore();
    }
  }, 30_000);

  // B3 — the cheap turn is counted, not extra. AC2.
  it('two returns are still all there are, and the terminal message is unchanged', async () => {
    const { store, manager, runner, workflow } = cheapFixture(3);
    try {
      const run = manager.startRun(workflow, { task: TASK, worktree: false });
      await settled(store, run.id);
      expect(store.getRun(run.id)?.status).toBe('failed');
      expect(store.getRun(run.id)?.error).toBe('check "gates" failed after 3 attempts');
      // One original execution plus exactly two returns — never a fourth spawn.
      expect(runner.specs).toHaveLength(3);
      expect(runner.specs.map(s => s.resume === true)).toEqual([false, true, false]);
    } finally {
      runner.restore();
    }
  }, 30_000);

  // B5 (no recorded session) and B6 (backend mismatch) — the resume is unavailable, so the
  // return falls back to today's fresh spawn INSIDE the same return: still two returns, the
  // whole brief is sent, and the fall-back is announced rather than silent. AC4.
  it.each([
    { name: 'no recorded session', patch: { sessionId: undefined }, note: 'no session was recorded' },
    { name: 'the session belongs to another backend', patch: { backend: 'pi' as const }, note: 'recorded session belongs to pi' },
    // Review round 1, Major 3: the condition the spec called "the one most likely to be skipped,
    // and the one whose failure is silent" — `sessionId` and `profileId` are a pair, and a resume
    // that reads another account's config dir finds no session and starts fresh WITHOUT saying so.
    // It is the only one of the three resolved inside `runAgentStep`, after the account is known.
    { name: 'the session belongs to another agent account', patch: { profileId: 'someone-else' }, note: 'agent account someone-else' },
  ])('falls back to a fresh spawn without consuming a return: $name', async ({ patch, note }) => {
    const { store, manager, runner, workflow } = cheapFixture(2);
    const notes: string[] = [];
    try {
      const run = manager.startRun(workflow, { task: TASK, worktree: false });
      // Break the recorded session the moment the gate step starts — before it fails, and so
      // before the engine decides how to return.
      let broken = false;
      store.on('run', (record: RunRecord) => {
        if (broken || record.id !== run.id) return;
        if (record.steps.find(s => s.id === 'gates')?.status !== 'running') return;
        broken = true;
        store.updateStep(run.id, 'author', patch);
      });
      await settled(store, run.id);
      for (const event of store.readEvents(run.id)) {
        if ((event as { type?: string }).type === 'note') notes.push(String((event as { message?: string }).message ?? ''));
      }

      expect(broken).toBe(true);
      expect(store.getRun(run.id)?.status).toBe('done');
      // Still exactly two returns — an unreachable session is an environment fact, not a round.
      expect(runner.specs).toHaveLength(3);
      expect(runner.specs.map(s => s.resume === true)).toEqual([false, false, false]);
      expect(runner.specs[1]?.userPrompt).toContain(TASK);
      expect(notes.some(message => message.includes(note))).toBe(true);
    } finally {
      runner.restore();
    }
  }, 30_000);

  /**
   * Review round 1, Major 1. A recorded session id proves nothing about a backend whose runner
   * ignores `spec.resume`: `opencode-server-runner.ts` `bootstrap()` always `POST /session`s and
   * never adopts `spec.sessionId`, so a "resumed" repair turn there would be a brand-new
   * conversation told that its brief "is earlier in this conversation". Eligibility is decided
   * from what the runner can do, so the whole brief goes out and the note names the backend.
   */
  it('a backend whose runner cannot resume takes the fresh spawn, and says which backend', async () => {
    const { store, manager, runner, workflow } = cheapFixture(2, 3, undefined, { runner: 'opencode' });
    const notes: string[] = [];
    try {
      const run = manager.startRun(workflow, { task: TASK, worktree: false });
      await settled(store, run.id);
      for (const event of store.readEvents(run.id)) {
        if ((event as { type?: string }).type === 'note') notes.push(String((event as { message?: string }).message ?? ''));
      }
      expect(store.getRun(run.id)?.status).toBe('done');
      // The step DID record a session id — that is exactly what must not be mistaken for "resumable".
      expect(store.getRun(run.id)?.steps.find(s => s.id === 'author')?.sessionId).toBeTruthy();
      expect(runner.specs).toHaveLength(3);
      expect(runner.specs.map(s => s.resume === true)).toEqual([false, false, false]);
      // Return #1 carries the whole brief, exactly as it did before #676.
      expect(runner.specs[1]?.userPrompt).toContain(TASK);
      expect(runner.specs[1]?.userPrompt).toContain('GATE-RED-1 the failing gate output');
      expect(notes.some(message => message.includes('the opencode runner cannot resume'))).toBe(true);
      // And never the sentence that tells the model its brief is already in the conversation.
      expect(notes.some(message => message.includes('repair turn — resuming'))).toBe(false);
    } finally {
      runner.restore();
    }
  }, 30_000);

  /**
   * Review round 1, Major 2. The reviewer's probe: the resumed turn comes back with the message a
   * real `claude -p --resume <forgotten id>` prints. Before the fix the run ended `failed` with 2
   * spawns; the accepted spec, the PR body, the BC entry and the changelog all promised the fresh
   * spawn instead. It happens inside the SAME return, so there are still exactly two returns.
   */
  it('a resume the backend refuses at runtime falls back to the fresh spawn in the same return', async () => {
    const { store, manager, runner, workflow } = cheapFixture(1, 3, [
      {},
      { error: 'No conversation found with session ID: gone' },
      {},
    ]);
    const notes: string[] = [];
    try {
      const run = manager.startRun(workflow, { task: TASK, worktree: false });
      await settled(store, run.id);
      for (const event of store.readEvents(run.id)) {
        if ((event as { type?: string }).type === 'note') notes.push(String((event as { message?: string }).message ?? ''));
      }
      // The run reaches its normal terminal path instead of dying on an environment fact.
      expect(store.getRun(run.id)?.status).toBe('done');
      expect(store.getRun(run.id)?.error).toBeUndefined();
      expect(runner.specs).toHaveLength(3);
      expect(runner.specs.map(s => s.resume === true)).toEqual([false, true, false]);
      // The third spawn is the fresh one this return owed: whole brief plus the failing output.
      expect(runner.specs[2]?.resume).toBeFalsy();
      expect(runner.specs[2]?.sessionId).not.toBe(runner.specs[1]?.sessionId);
      expect(runner.specs[2]?.userPrompt).toContain(TASK);
      expect(runner.specs[2]?.userPrompt).toContain('GATE-RED-1 the failing gate output');
      expect(notes.some(message =>
        message.includes('the resumed turn ended before the model produced anything')
        && message.includes('No conversation found'))).toBe(true);
      // The fall-back is a second backend SESSION, and `UiEventSink` latches `ended` — reusing one
      // sink for both would drop the fresh execution's whole v2 stream, its own close included.
      // Three closes on the author step is what proves the second sink exists: the original
      // execution, then the refused resume's error, then the fresh turn's clean end. With one
      // shared sink the last of those never reaches the NDJSON.
      const closes = store.readEvents(run.id).filter(event =>
        (event as { type?: string; stepId?: string }).type === 'session.ended'
        && (event as { stepId?: string }).stepId === 'author');
      expect(closes.map(event => (event as { reason?: string }).reason)).toEqual(['end_turn', 'error', 'end_turn']);
    } finally {
      runner.restore();
    }
  }, 30_000);

  /**
   * Review round 1, Minor 1 — VERIFIED by reading, then pinned here. Codex reports
   * `thread/tokenUsage/updated` → `tokenUsage.total.totalTokens`, the THREAD's cumulative figure
   * (`codex-app-server-runner.ts:527-531`, `tokenTotal` at `:674-678`). A `thread/resume` keeps
   * counting on the same thread, so the figure the resumed repair turn reports already contains
   * everything the first execution spent: adding the step's stored total to it, the way every
   * other runner's per-execution figure must be added, bills the first execution twice.
   */
  it('a resumed repair turn on a cumulative-reporting backend does not double count its tokens', async () => {
    const { store, manager, runner, workflow } = cheapFixture(
      1,
      2,
      // Execution 1 spends 1 000. The resumed turn spends 500 more and reports the thread total.
      [{ tokensUsed: 1_000 }, { tokensUsed: 1_500 }],
      { runner: 'codex' },
    );
    try {
      const run = manager.startRun(workflow, { task: TASK, worktree: false });
      await settled(store, run.id);
      expect(store.getRun(run.id)?.status).toBe('done');
      expect(runner.specs).toHaveLength(2);
      expect(runner.specs[1]?.resume).toBe(true);
      // 1 500, the thread's own total — never 1 000 + 1 500.
      expect(store.getRun(run.id)?.steps.find(s => s.id === 'author')?.tokensUsed).toBe(1_500);
    } finally {
      runner.restore();
    }
  }, 30_000);

  /**
   * A clock only `run.ts` reads. `Date.now()` is shifted; `new Date()` — which is what stamps a
   * step's `startedAt` — is not, so the shift IS the elapsed time of the execution under test and
   * no test ever waits for a real minute. Restored by the suite's `vi.restoreAllMocks()`.
   */
  function shiftableClock() {
    const real = Date.now;
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => real.call(Date) + offset);
    return { advance: (ms: number) => { offset += ms; } };
  }

  /**
   * BREAK-732-A-WORDING (#732 Minor A). The fall-back branch tests `outcome !== null &&
   * !sawActivity`, never the KIND of failure, so every no-activity end of the resumed turn used
   * to be announced as "the backend refused the recorded session" — including the reviewer's Q5
   * probe, a turn that ended cleanly having said nothing, and a usage limit, neither of which is
   * a refusal. The branch is deliberately unchanged (it is the recovery that makes those cases
   * end well); only the sentence is, and it now states what was observed rather than a cause it
   * cannot know.
   */
  it.each([
    {
      cause: 'a conversation the backend has forgotten',
      turn: { error: 'No conversation found with session ID: gone' } as ScriptedTurn,
      reason: 'No conversation found with session ID: gone',
    },
    {
      cause: 'a usage limit on the resumed turn',
      turn: { error: 'Claude usage limit reached; resets 11:50am' } as ScriptedTurn,
      reason: 'Claude usage limit reached; resets 11:50am',
    },
    {
      // Probe Q5 of the re-check: the resumed turn ends cleanly having produced no text at all.
      cause: 'a turn that ended cleanly having produced nothing',
      turn: { chunks: [] } as ScriptedTurn,
      reason: 'without the XEZ:DONE completion marker',
    },
  ])('names what it observed, not a refusal it cannot know: $cause', async ({ turn, reason }) => {
    const { store, manager, runner, workflow } = cheapFixture(1, 3, [{}, turn, {}]);
    const notes: string[] = [];
    try {
      const run = manager.startRun(workflow, { task: TASK, worktree: false });
      await settled(store, run.id);
      for (const event of store.readEvents(run.id)) {
        if ((event as { type?: string }).type === 'note') notes.push(String((event as { message?: string }).message ?? ''));
      }
      // Unchanged: the fall-back still happens, inside the same return, and the run ends well.
      expect(store.getRun(run.id)?.status).toBe('done');
      expect(runner.specs).toHaveLength(3);
      expect(runner.specs.map(s => s.resume === true)).toEqual([false, true, false]);
      expect(notes.some(message =>
        message.includes('the resumed turn ended before the model produced anything')
        && message.includes(reason))).toBe(true);
      // And never the claim the branch cannot support.
      expect(notes.some(message => message.includes('refused the recorded session'))).toBe(false);
    } finally {
      runner.restore();
    }
  }, 30_000);

  /**
   * BREAK-732-B-DOUBLE-CLOCK (#732 Minor B). A resumed turn that hangs and is killed by its own
   * wall clock used to fall back to a fresh execution carrying the FULL `stepTimeoutMs` again —
   * 30 minutes after 30 minutes for one return — while `progress.deadlineAt` was still computed
   * from the step's original `startedAt` and so pointed at an instant the second execution was
   * allowed to run straight past. The fall-back now gets what is LEFT of the step's clock, which
   * is also what makes the deadline true again.
   */
  it('the fall-back execution gets what is left of the step clock, not a second full one', async () => {
    const clock = shiftableClock();
    const observed: Array<{ now: number; deadlineAt: string | null | undefined }> = [];
    const context: { store?: RunStore; runId?: string } = {};
    const readProgress = () => {
      const step = context.store?.getRun(context.runId ?? '')?.steps.find(s => s.id === 'author');
      observed.push({ now: Date.now(), deadlineAt: step?.progress?.deadlineAt });
    };
    const { store, manager, runner, workflow } = cheapFixture(
      1,
      3,
      [
        {},
        // The resumed turn burns 20 of the step's 30 minutes and is killed by its own deadline.
        { error: 'claude CLI timed out after 30m and was killed', before: () => clock.advance(20 * 60_000) },
        { before: readProgress },
      ],
      { timeout: '30m' },
    );
    context.store = store;
    try {
      const run = manager.startRun(workflow, { task: TASK, worktree: false });
      context.runId = run.id;
      await settled(store, run.id);
      expect(store.getRun(run.id)?.status).toBe('done');
      expect(runner.specs).toHaveLength(3);
      // Unchanged: the step's own `timeout` still governs both the first execution and the
      // resumed repair turn, exactly as #676 shipped it.
      expect(runner.specs[0]?.timeoutMs).toBe(30 * 60_000);
      expect(runner.specs[1]?.timeoutMs).toBe(30 * 60_000);
      // The fall-back is bounded by the remainder — about ten minutes, never another thirty.
      const remaining = runner.specs[2]?.timeoutMs ?? 0;
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(10 * 60_000);
      expect(remaining).toBeGreaterThan(9 * 60_000);
      // And the advertised deadline is the instant that budget actually runs out.
      const [progress] = observed;
      expect(progress?.deadlineAt).toBeTruthy();
      expect(Date.parse(String(progress?.deadlineAt)) - (progress?.now ?? 0))
        .toBeGreaterThan(remaining - 5_000);
      expect(Date.parse(String(progress?.deadlineAt)) - (progress?.now ?? 0))
        .toBeLessThanOrEqual(remaining + 5_000);
    } finally {
      runner.restore();
    }
  }, 30_000);

  /** BREAK-732-B-DOUBLE-CLOCK, the other half: a resumed turn that spent the WHOLE step clock has
   *  nothing left to lend a fresh execution, so the return ends on the failure it has instead of
   *  starting a second execution that would be over its deadline before it spoke. */
  it('does not start a fall-back execution when the step clock is already spent', async () => {
    const clock = shiftableClock();
    const { store, manager, runner, workflow } = cheapFixture(
      1,
      3,
      [{}, { error: 'claude CLI timed out after 30m and was killed', before: () => clock.advance(31 * 60_000) }, {}],
      { timeout: '30m' },
    );
    const notes: string[] = [];
    try {
      const run = manager.startRun(workflow, { task: TASK, worktree: false });
      await settled(store, run.id);
      for (const event of store.readEvents(run.id)) {
        if ((event as { type?: string }).type === 'note') notes.push(String((event as { message?: string }).message ?? ''));
      }
      expect(runner.specs).toHaveLength(2);
      expect(store.getRun(run.id)?.status).toBe('failed');
      expect(notes.some(message =>
        message.includes('the resumed turn ended before the model produced anything')
        && message.includes('no time is left on this step\'s wall clock'))).toBe(true);
    } finally {
      runner.restore();
    }
  }, 30_000);
});
