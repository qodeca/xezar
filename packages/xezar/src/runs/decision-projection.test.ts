import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from './store.ts';
import { runDecisionProjection } from './decision-projection.ts';
import { guardedRunMutation, runVersion } from '../mcp/stale-write.ts';

let store: RunStore;
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'decision-projection-')); store = RunStore.open(root); });
afterEach(() => { store.flush(); rmSync(root, { recursive: true, force: true }); });

// #532 G3: each independent field has its own omission mutant. A combined patch would hide omissions.
const changes: Array<[string, (run: RunRecord) => Partial<RunRecord>]> = [
  ['status', () => ({ status: 'review' })],
  ['archived', () => ({ archived: true })],
  ['pinned', () => ({ pinned: true })],
  ['title', () => ({ title: 'B' })],
  ['titleOrigin', () => ({ titleOrigin: 'user' })],
  ['autoResumeAt', () => ({ autoResumeAt: '2026-09-20T00:00:00.000Z' })],
  ['task', () => ({ task: 'B' })],
  ['queuedMessages.id', r => ({ queuedMessages: r.queuedMessages?.map(m => ({ ...m, id: 'B' })) })],
  ['queuedMessages.text', r => ({ queuedMessages: r.queuedMessages?.map(m => ({ ...m, text: 'B' })) })],
  ['steps.id', r => ({ steps: r.steps.map(s => ({ ...s, id: 'B' })) })],
  ['steps.status', r => ({ steps: r.steps.map(s => ({ ...s, status: 'done' })) })],
  ['steps.add', r => ({ steps: [...r.steps, { id: 'extra', name: 'Extra', kind: 'check', status: 'pending' }] })],
  ['steps.remove', () => ({ steps: [] })],
  ['branch', () => ({ branch: 'B' })],
  ['workflow', () => ({ workflow: 'B' })],
];

describe('#532 independent decision fields', () => {
  it.each(changes)('%s: changes once, same-value write stays stable, A→B→A persists', (_field, patch) => {
    const run = store.createRun({ title: 'A', task: 'A', workflow: 'A', steps: [{ id: 'a', name: 'A', kind: 'agent' }] });
    store.updateRun(run.id, { status: 'failed', queuedMessages: [{ id: 'a', text: 'A', createdAt: '2026-09-01T00:00:00.000Z' }] });
    const before = structuredClone(run);
    const token = runVersion(store, run.id);
    const revision = run.decisionRevision ?? 0;
    const changed = patch(run);
    store.updateRun(run.id, changed);
    expect(runDecisionProjection(run)).not.toEqual(runDecisionProjection(before));
    expect(runVersion(store, run.id)).not.toBe(token);
    expect(run.decisionRevision).toBe(revision + 1);
    const second = runVersion(store, run.id);
    store.updateRun(run.id, structuredClone(changed));
    expect(runVersion(store, run.id)).toBe(second);
    const restore = Object.fromEntries(Object.keys(changed).map(key => [key, before[key as keyof RunRecord]]));
    store.updateRun(run.id, restore);
    expect(runDecisionProjection(run)).toEqual(runDecisionProjection(before));
    expect(run.decisionRevision).toBe(revision + 2);
    expect(guardedRunMutation(store, run.id, token, () => 'must not apply').status).toBe('conflict');
    // No flush: the store, not the caller, owns durable decision revision writes.
    const reopened = RunStore.open(root, { keepLive: true });
    expect(runVersion(reopened, run.id)).toBe(runVersion(store, run.id));
    expect(reopened.getRun(run.id)?.decisionRevision).toBe(revision + 2);
    reopened.flush();
  });
});
