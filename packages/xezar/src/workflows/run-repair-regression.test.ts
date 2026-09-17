import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import * as factory from '../core/runner-factory.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

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
  await expect.poll(() => store.getRun(id)?.status, { timeout: 3000, interval: 10 })
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
  // Observe completion directly; startup can outlast expect.poll's one-second default
  // during the full gate. The enclosing test timeout still bounds a missing transition.
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
