import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunsIndexResponse } from '@qodeca/xezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { WorkspaceEventBus, createApp } from './server.ts';

/**
 * One route-level A/B product-composition transition that no focused suite owns end to end: a
 * project registered after boot is lazy, its first touch builds a context whose runs join BOTH
 * the cross-project runs index (`runs-index-api.test.ts`) and the workspace SSE stream
 * (`workspace-events.test.ts`) — and when it is removed and re-added on the same slug, project A
 * must keep answering on every one of those surfaces throughout. The registry, route-parity and
 * semaphore matrices already cover their own mechanisms in isolation and are deliberately not
 * repeated here (`docs/testing/coverage-gaps.md`).
 */
describe('multi-project composition: late B build through removal and re-add, A stays valid', () => {
  const savedHome = process.env.XEZ_HOME;
  const savedDryRun = process.env.XEZ_DRY_RUN;
  let home: string;
  let rootA: string;
  let rootB: string;
  let storeA: RunStore;
  let contexts: ProjectContexts;
  let bus: WorkspaceEventBus;
  let app: Hono;
  let idA: string;
  const closers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'xez-mpc-home-'));
    rootA = mkdtempSync(join(tmpdir(), 'xez-mpc-a-'));
    rootB = mkdtempSync(join(tmpdir(), 'xez-mpc-b-'));
    process.env.XEZ_HOME = home;
    process.env.XEZ_DRY_RUN = '1';
    clearProjectProbeCache();
    storeA = RunStore.open(join(rootA, '.local/xezar'), { keepLive: true });
    contexts = new ProjectContexts({ listProjects });
    bus = new WorkspaceEventBus();
    idA = (await registerProject(rootA)).id;
    app = createApp({
      repoRoot: rootA,
      store: storeA,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
      workspaceEvents: bus,
    });
  });

  afterEach(async () => {
    for (const close of closers.splice(0)) await close().catch(() => undefined);
    await contexts.disposeAll();
    storeA.flush();
    for (const dir of [home, rootA, rootB]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = savedHome;
    if (savedDryRun === undefined) delete process.env.XEZ_DRY_RUN;
    else process.env.XEZ_DRY_RUN = savedDryRun;
  });

  const runsIndex = async (): Promise<RunsIndexResponse> => {
    const res = await apiRequest(app, '/api/v1/workspace/runs-index');
    expect(res.status).toBe(200);
    return (await res.json()) as RunsIndexResponse;
  };

  /** Open one SSE stream and return an incremental until-reader (mirrors `workspace-events.test.ts`). */
  const openStream = async (url: string): Promise<{ readUntil: (marker: string) => Promise<string> }> => {
    const res = await apiRequest(app, url);
    expect(res.status, url).toBe(200);
    expect(res.body, url).not.toBeNull();
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    closers.push(() => reader.cancel());
    const decoder = new TextDecoder();
    let body = '';
    return {
      async readUntil(marker: string): Promise<string> {
        const deadline = Date.now() + 5_000;
        while (!body.includes(marker) && Date.now() < deadline) {
          const timeout = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())),
          );
          const next = await Promise.race([reader.read(), timeout]);
          if (next === null || next.done) break;
          body += decoder.decode(next.value, { stream: true });
        }
        expect(body, `${url} never delivered ${JSON.stringify(marker)}`).toContain(marker);
        return body;
      },
    };
  };

  const payloadsOf = <T>(body: string, event: string): T[] =>
    [...body.matchAll(new RegExp(`event: ${event}\\ndata: (.*)\\n`, 'g'))].map((m) => JSON.parse(m[1] as string) as T);

  it('late B build joins the runs index and workspace stream; B removal and re-add never disturb A', async () => {
    // --- B is registered but untouched: lazy, absent from the context map. ---
    const idB = (await registerProject(rootB)).id;
    expect(contexts.peek(idB)).toBeUndefined();

    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');

    // A alone shows up on the index while B has never been touched.
    const aRun1 = storeA.createRun({ title: 'a-1', workflow: 'quick-task', task: 'a1', steps: [] });
    storeA.updateRun(aRun1.id, { status: 'done' });
    expect((await runsIndex()).runs.map((r) => r.id)).toEqual([aRun1.id]);
    expect(contexts.peek(idB)).toBeUndefined(); // reading the index never built B

    // --- First API touch builds B's context (lazy build, spec 2026-07-20 step 2.2). ---
    expect((await apiRequest(app, `/api/v1/p/${idB}/runs`)).status).toBe(200);
    const bCtx1 = contexts.peek(idB);
    expect(bCtx1).toBeDefined();

    const bRun1 = bCtx1!.store.createRun({ title: 'b-1', workflow: 'quick-task', task: 'b1', steps: [] });
    bCtx1!.store.updateRun(bRun1.id, { status: 'done' });

    // Both projects now compose on the cross-project index…
    const both = await runsIndex();
    expect(both.runs.map((r) => r.id).sort()).toEqual([aRun1.id, bRun1.id].sort());
    expect(both.runs.find((r) => r.id === aRun1.id)?.projectId).toBe(idA);
    expect(both.runs.find((r) => r.id === bRun1.id)?.projectId).toBe(idB);

    // …and on the one already-open workspace stream, each stamped with its own project.
    const withB = await ws.readUntil(`"id":"${bRun1.id}"`);
    expect(payloadsOf<{ id: string; project: string }>(withB, 'run')).toContainEqual(
      expect.objectContaining({ id: bRun1.id, project: idB }),
    );

    // --- Removing B tears its context down; A must not notice. ---
    const del = await apiRequest(app, `/api/v1/projects/${idB}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    await ws.readUntil('event: project-removed');
    expect(contexts.peek(idB)).toBeUndefined();

    // B's route is unknown again (unregistered, not merely missing) — a stable 404, not a hang.
    expect((await apiRequest(app, `/api/v1/p/${idB}/runs`)).status).toBe(404);

    // A keeps composing correctly with B gone: the index drops B's row without touching A's,
    // and a fresh A run still reaches the already-open stream.
    const onlyA = await runsIndex();
    expect(onlyA.runs.map((r) => r.id)).toEqual([aRun1.id]);

    const aRun2 = storeA.createRun({ title: 'a-2', workflow: 'quick-task', task: 'a2', steps: [] });
    const afterRemoval = await ws.readUntil(`"id":"${aRun2.id}"`);
    expect(payloadsOf<{ id: string; project: string }>(afterRemoval, 'run')).toContainEqual(
      expect.objectContaining({ id: aRun2.id, project: idA }),
    );

    // --- Re-adding B on the same root resumes composition on the SAME open stream — this is the
    // transition `disposed-b-still-attached` guards: a stale attach entry never cleared for the
    // removed project would make this rebuilt context's events vanish silently instead of arriving. ---
    const readded = await registerProject(rootB);
    expect(readded.id).toBe(idB);
    expect((await apiRequest(app, `/api/v1/p/${readded.id}/runs`)).status).toBe(200);
    const bCtx2 = contexts.peek(readded.id);
    expect(bCtx2).toBeDefined();
    expect(bCtx2!.store).not.toBe(bCtx1!.store);

    const bRun2 = bCtx2!.store.createRun({ title: 'b-2', workflow: 'quick-task', task: 'b2', steps: [] });
    const afterReadd = await ws.readUntil(`"id":"${bRun2.id}"`);
    expect(payloadsOf<{ id: string; project: string }>(afterReadd, 'run')).toContainEqual(
      expect.objectContaining({ id: bRun2.id, project: readded.id }),
    );

    // A is still exactly where it was left: unaffected by B's whole churn.
    const final = await runsIndex();
    expect(final.runs.map((r) => r.id)).toEqual(expect.arrayContaining([aRun1.id, aRun2.id]));
    expect(final.runs.filter((r) => r.projectId === idA)).toHaveLength(2);
  });
});
