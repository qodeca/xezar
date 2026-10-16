import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { InferRequestType } from 'hono/client';
import { hc } from 'hono/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { createRunInputSchema } from '@qodeca/xezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import type { AppType } from './app-type.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { closeStoreAndRemove } from '../runs/store.testkit.ts';

/**
 * `POST /api/v1/runs` `evidenceFromRunId` (#933) — the leader names the task whose evidence this
 * task checks. The route accepts only a task of THIS project and hands the id to the manager;
 * absent stays absent, so every existing body behaves exactly as before.
 */
describe('POST /api/v1/runs evidenceFromRunId (#933)', () => {
  // The route validates with the contract's own field: the key exists on the route type and has
  // the contract's type (`createRunInputSchema`). The rest of `POST /runs` has not moved to the
  // contract yet (docs/STATUS.md), so this pins the new key, not the whole body.
  const client = hc<AppType>('http://127.0.0.1');
  type RouteKey = InferRequestType<typeof client.api.v1.runs.$post>['json']['evidenceFromRunId'];
  type ContractKey = z.input<typeof createRunInputSchema>['evidenceFromRunId'];
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  const _sameKey: Mutual<RouteKey, ContractKey> = true;
  void _sameKey;

  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let captured: StartRunInput | undefined;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-933-route-'));
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    captured = undefined;
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        captured = input;
        return store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(() => {
    store.flush();
    closeStoreAndRemove(store, repoRoot);
  });

  const post = (body: unknown) =>
    apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const base = { task: 'review PR 42', steps: [{ id: 'review', prompt: '{{task}}' }] };

  it('forwards the id of a task in this project', async () => {
    const author = store.createRun({ title: 'author', workflow: 'w', task: 'fix', steps: [] });
    const res = await post({ ...base, evidenceFromRunId: author.id });
    expect(res.status).toBe(201);
    expect(captured?.evidenceFromRunId).toBe(author.id);
  });

  it('refuses a well-formed id that names no task here, before starting anything', async () => {
    const res = await post({ ...base, evidenceFromRunId: '0f1e2d3c-4b5a-4968-8776-655443322110' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('no task 0f1e2d3c-4b5a-4968-8776-655443322110 in this project');
    expect(captured).toBeUndefined();
  });

  it('refuses a value that is not a task id', async () => {
    const res = await post({ ...base, evidenceFromRunId: '../other' });
    expect(res.status).toBe(400);
    expect(captured).toBeUndefined();
  });

  it('an absent field stays absent', async () => {
    const res = await post(base);
    expect(res.status).toBe(201);
    expect(captured?.evidenceFromRunId).toBeUndefined();
  });
});
