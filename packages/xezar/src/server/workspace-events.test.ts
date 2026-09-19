import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAuthService } from '../core/provider-auth.ts';
import { emitUsageForTest, type ProcessUsage } from '../core/process-usage.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject, removeProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { WorkspaceEventBus, createApp } from './server.ts';

/**
 * Workspace SSE stream (spec 2026-07-20-multi-project-workspace, step 2.8):
 * `GET /api/v1/workspace/events` carries EVERY instantiated project's events,
 * each payload stamped with its `project` id; `usage` is split per project
 * (one stamped event per project with live rows); workspace-level bus events
 * (`project-added`, `project-removed`, `checkout-progress`) and the host-wide
 * unstamped `provider-status` event ride the same stream. Subscribing never
 * force-instantiates a project — late-built contexts join dynamically. The
 * legacy `/api/v1/events` alias stays boot-filtered with its UN-stamped,
 * byte-identical shape (protected).
 */
describe('GET /api/v1/workspace/events', () => {
  const savedHome = process.env.XEZ_HOME;
  const savedRemote = process.env.XEZ_REMOTE;
  const savedDryRun = process.env.XEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  let otherRoot: string;
  let store: RunStore;
  let contexts: ProjectContexts;
  let bus: WorkspaceEventBus;
  let app: Hono;
  let bootId: string;
  const closers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'xez-wsev-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-wsev-boot-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'xez-wsev-other-'));
    process.env.XEZ_HOME = home;
    delete process.env.XEZ_REMOTE;
    process.env.XEZ_DRY_RUN = '1';
    for (const root of [repoRoot, otherRoot]) {
      mkdirSync(join(root, '.local/xezar'), { recursive: true });
      mkdirSync(join(root, '.xezar'), { recursive: true });
      writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    }
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.local/xezar'), { keepLive: true });
    contexts = new ProjectContexts({ listProjects });
    bus = new WorkspaceEventBus();
    bootId = (await registerProject(repoRoot)).id;
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
      workspaceEvents: bus,
      providerAuth: new ProviderAuthService({
        createAuthFailureId: () => 'auth-incident-1',
      }),
    });
  });

  afterEach(async () => {
    for (const close of closers.splice(0)) await close().catch(() => undefined);
    await contexts.disposeAll();
    store.flush();
    for (const dir of [home, repoRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = savedHome;
    if (savedRemote === undefined) delete process.env.XEZ_REMOTE;
    else process.env.XEZ_REMOTE = savedRemote;
    if (savedDryRun === undefined) delete process.env.XEZ_DRY_RUN;
    else process.env.XEZ_DRY_RUN = savedDryRun;
  });

  /** Register the other project and build its context via a first API touch. */
  const buildOtherContext = async (): Promise<{
    id: string;
    store: RunStore;
  }> => {
    const other = await registerProject(otherRoot);
    expect((await apiRequest(app, `/api/v1/p/${other.id}/runs`)).status).toBe(200);
    const otherStore = contexts.peek(other.id)?.store;
    expect(otherStore).toBeDefined();
    return { id: other.id, store: otherStore as RunStore };
  };

  /** Open one SSE stream and return an incremental until-reader. */
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

  /** All payloads of one SSE event name delivered so far, in arrival order. */
  const payloadsOf = <T>(body: string, event: string): T[] =>
    [...body.matchAll(new RegExp(`event: ${event}\\ndata: (.*)\\n`, 'g'))].map((m) => JSON.parse(m[1] as string) as T);

  it("carries BOTH projects' store events, each stamped with its project id", async () => {
    const other = await buildOtherContext();

    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');

    const bootRun = store.createRun({
      title: 'boot-run',
      workflow: 'quick-task',
      task: 'b',
      steps: [],
    });
    const otherRun = other.store.createRun({
      title: 'other-run',
      workflow: 'quick-task',
      task: 'o',
      steps: [],
    });

    const body = await ws.readUntil(`"id":"${otherRun.id}"`);
    const runs = payloadsOf<{ id: string; project: string }>(body, 'run');
    expect(runs).toEqual([
      { ...JSON.parse(JSON.stringify(bootRun)), project: bootId },
      { ...JSON.parse(JSON.stringify(otherRun)), project: other.id },
    ]);

    // Deletions are stamped too.
    other.store.deleteRun(otherRun.id);
    const withDeleted = await ws.readUntil('event: run-deleted');
    expect(payloadsOf(withDeleted, 'run-deleted')).toEqual([{ id: otherRun.id, project: other.id }]);
  });

  it('legacy /api/v1/events stays boot-filtered with the byte-identical, UN-stamped shape', async () => {
    const other = await buildOtherContext();

    const legacy = await openStream('/api/v1/events');
    await legacy.readUntil('event: ping');

    // Other project first: were it going to leak, it would arrive BEFORE the
    // boot event we wait for below.
    other.store.createRun({
      title: 'other-run',
      workflow: 'quick-task',
      task: 'o',
      steps: [],
    });
    const bootRun = store.createRun({
      title: 'boot-run',
      workflow: 'quick-task',
      task: 'b',
      steps: [],
    });

    const body = await legacy.readUntil(`"id":"${bootRun.id}"`);
    // Byte-identical regression (BACKWARD_COMPATIBILITY §2): the data line is
    // EXACTLY the run record — no `project` stamp, nothing reordered.
    expect(body).toContain(`event: run\ndata: ${JSON.stringify(bootRun)}\n`);
    expect(body).not.toContain('"project"');
    // …and only the boot project's events are on this stream.
    expect(body).not.toContain('other-run');
  });

  it('splits usage per project: one stamped event per project with live rows, none for row-less projects', async () => {
    const other = await buildOtherContext();
    const bootRunId = store.createRun({
      title: 'boot',
      workflow: 'quick-task',
      task: 'b',
      steps: [],
    }).id;
    const otherRunId = other.store.createRun({
      title: 'other',
      workflow: 'quick-task',
      task: 'o',
      steps: [],
    }).id;

    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');

    const bootSample: ProcessUsage = {
      cpuPct: 12.5,
      rssBytes: 111 * 1024,
      procCount: 2,
    };
    const otherSample: ProcessUsage = {
      cpuPct: 99.9,
      rssBytes: 222 * 1024,
      procCount: 5,
    };
    emitUsageForTest({ [bootRunId]: bootSample, [otherRunId]: otherSample });

    const body = await ws.readUntil(`"project":"${other.id}","usage"`);
    await ws.readUntil(`"project":"${bootId}","usage"`);
    const events = payloadsOf<{
      project: string;
      usage: Record<string, ProcessUsage>;
    }>(body, 'usage');
    expect(events).toHaveLength(2);
    expect(events).toContainEqual({
      project: bootId,
      usage: { [bootRunId]: bootSample },
    });
    expect(events).toContainEqual({
      project: other.id,
      usage: { [otherRunId]: otherSample },
    });

    // A snapshot owned entirely by one project → exactly ONE more event; the
    // row-less project emits nothing (no empty-record clears on this stream).
    // Distinct cpuPct so the readUntil marker can't match the first event.
    emitUsageForTest({ [bootRunId]: { ...bootSample, cpuPct: 50 } });
    const after = await ws.readUntil('"cpuPct":50');
    const all = payloadsOf<{ project: string }>(after, 'usage');
    expect(all).toHaveLength(3);
    expect(all.filter((e) => e.project === other.id)).toHaveLength(1);
  });

  it("a late-built context's events appear after its first touch — and subscribing never force-instantiates", async () => {
    const other = await registerProject(otherRoot);

    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');
    // Opening the stream did NOT build the registered-but-untouched project.
    expect(contexts.peek(other.id)).toBeUndefined();

    // First API touch builds the context; the stream picks it up dynamically
    // via onContextBuilt.
    expect((await apiRequest(app, `/api/v1/p/${other.id}/runs`)).status).toBe(200);
    const otherStore = contexts.peek(other.id)?.store;
    expect(otherStore).toBeDefined();
    const run = (otherStore as RunStore).createRun({
      title: 'late',
      workflow: 'quick-task',
      task: 'late',
      steps: [],
    });

    const body = await ws.readUntil(`"id":"${run.id}"`);
    expect(payloadsOf<{ id: string; project: string }>(body, 'run')).toEqual([
      { ...JSON.parse(JSON.stringify(run)), project: other.id },
    ]);
  });

  it("broadcasts a late-built context's runtime provider invalidation without a project stamp", async () => {
    const other = await buildOtherContext();
    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');

    try {
      delete process.env.XEZ_DRY_RUN;
      const run = other.store.createRun({
        title: 'auth',
        workflow: 'quick-task',
        task: 'work',
        runner: 'opencode',
        steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
      });
      other.store.updateStep(run.id, 'work', { backend: 'opencode' });
      other.store.appendEvent(run.id, {
        type: 'session.error',
        stepId: 'work',
        message: 'OAuth access token is invalid',
      });

      const body = await ws.readUntil('event: provider-status');
      expect(body).toContain(
        'event: provider-status\n'
        + 'data: {"provider":"opencode","status":"disconnected",'
        + '"hint":"Authentication was rejected during a run. Reconnect, then try again.",'
        + '"authFailureId":"auth-incident-1"}\n',
      );
      expect(payloadsOf<Record<string, unknown>>(body, 'provider-status')).toEqual([{
        provider: 'opencode',
        status: 'disconnected',
        hint: 'Authentication was rejected during a run. Reconnect, then try again.',
        authFailureId: 'auth-incident-1',
      }]);
    } finally {
      process.env.XEZ_DRY_RUN = '1';
    }
  });

  it('broadcasts a global provider preference change with its enablement state', async () => {
    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');

    const response = await apiRequest(app, '/api/v1/providers/codex/enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(200);
    const body = await ws.readUntil('event: provider-status');
    expect(payloadsOf<Record<string, unknown>>(body, 'provider-status')).toEqual([{
      provider: 'codex',
      status: 'connected',
      enabled: false,
    }]);
  });

  it('broadcasts an enabled provider row after an incident-safe retry', async () => {
    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');
    const run = store.createRun({
      title: 'auth retry',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    try {
      delete process.env.XEZ_DRY_RUN;
      store.appendEvent(run.id, {
        type: 'error',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });
      await ws.readUntil('event: provider-status');
      process.env.XEZ_DRY_RUN = '1';

      const response = await apiRequest(app, '/api/v1/providers/claude/retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authFailureId: 'auth-incident-1' }),
      });

      expect(response.status).toBe(200);
      const body = await ws.readUntil('"enabled":true');
      expect(payloadsOf<Record<string, unknown>>(body, 'provider-status')).toContainEqual({
        provider: 'claude',
        status: 'connected',
        enabled: true,
      });
    } finally {
      process.env.XEZ_DRY_RUN = '1';
    }
  });

  it('a removed project re-added on the same slug resumes flowing on an already-open stream', async () => {
    const other = await buildOtherContext();

    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');

    // Remove the project through the API — the stream must drop its attach
    // entry with the disposed context…
    const del = await apiRequest(app, `/api/v1/projects/${other.id}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    await ws.readUntil('event: project-removed');

    // …so that the SAME slug, re-registered and rebuilt, attaches its NEW
    // store (regression: the attach guard kept the stale entry, and the
    // rebuilt context's events were silently lost until reconnect).
    const readded = await registerProject(otherRoot);
    expect(readded.id).toBe(other.id);
    expect((await apiRequest(app, `/api/v1/p/${readded.id}/runs`)).status).toBe(200);
    const rebuilt = contexts.peek(readded.id)?.store;
    expect(rebuilt).toBeDefined();
    expect(rebuilt).not.toBe(other.store);
    const run = (rebuilt as RunStore).createRun({
      title: 're-added',
      workflow: 'quick-task',
      task: 'r',
      steps: [],
    });

    const body = await ws.readUntil(`"id":"${run.id}"`);
    expect(payloadsOf<{ id: string; project: string }>(body, 'run')).toEqual([
      { ...JSON.parse(JSON.stringify(run)), project: readded.id },
    ]);
  });

  /**
   * #592 review round 1, Major 1: the sibling of the test above, but for the OUT-OF-BAND drift the
   * removal route never sees (#591) — a second process, a hand-edited `~/.xezar/config.json`, or a
   * test seeding the registry directly re-points the same slug to a different root, so
   * `ProjectContexts.context()` disposes and rebuilds on its own, with no `project-removed` event
   * ever firing. Before the fix, the attach guard in `attach()` kept pinning the DISPOSED store, so
   * an already-open workspace stream never saw the re-pointed project's events again.
   */
  it('an out-of-band drift rebuild (no removal route involved) resumes flowing on an already-open stream', async () => {
    const base = mkdtempSync(join(tmpdir(), 'xez-wsev-drift-'));
    const rootOld = join(base, 'run-1', 'shared');
    const rootNew = join(base, 'run-2', 'shared');
    for (const root of [rootOld, rootNew]) {
      mkdirSync(join(root, '.xezar'), { recursive: true });
      writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    }

    const first = await registerProject(rootOld);
    expect((await apiRequest(app, `/api/v1/p/${first.id}/runs`)).status).toBe(200);
    const oldStore = contexts.peek(first.id)?.store;
    expect(oldStore).toBeDefined();

    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');

    // Out-of-band: remove and re-register directly, never through `DELETE /projects/:id` — so no
    // `project-removed` event is ever emitted on `bus`.
    await removeProject(first.id);
    const second = await registerProject(rootNew);
    expect(second.id).toBe(first.id); // same basename → same slug, the scenario #591 names

    expect((await apiRequest(app, `/api/v1/p/${second.id}/runs`)).status).toBe(200);
    const rebuilt = contexts.peek(second.id)?.store;
    expect(rebuilt).toBeDefined();
    expect(rebuilt).not.toBe(oldStore);

    const run = (rebuilt as RunStore).createRun({
      title: 'drift',
      workflow: 'quick-task',
      task: 'd',
      steps: [],
    });
    const body = await ws.readUntil(`"id":"${run.id}"`);
    expect(payloadsOf<{ id: string; project: string }>(body, 'run')).toEqual([
      { ...JSON.parse(JSON.stringify(run)), project: second.id },
    ]);

    rmSync(base, { recursive: true, force: true });
  });

  /**
   * RP-3 (#647): the sibling of the two tests above, for the window they both step around.
   *
   * Each of them lets the dispose FINISH before the project comes back — the first waits for
   * `project-removed`, the second re-registers between two awaited route calls — so the attach
   * entry is already gone by the time the rebuilt context is published. The window this covers is
   * the one where it is not: `dispose()` drops the context and bumps the registration
   * synchronously but notifies only after `teardown` has finished, and that teardown can outlive
   * a re-add and a rebuild of the same slug (which is exactly why `DELETE /projects/:id` bounds
   * its own wait on that teardown and answers anyway rather than hanging on it).
   *
   * Keyed on the id alone, the stream then did BOTH halves wrong: the attach guard dropped the
   * rebuilt context's store on the floor, and the late dispose deleted the entry for a
   * registration that had already been replaced — so the project's events were silently lost
   * until the browser reconnected.
   *
   * The teardown is parked at `RunManager.dispose()`, the one await inside `teardown`, rather
   * than driven through the route, so the test never waits on that real bound.
   */
  it('a project rebuilt inside the previous context\'s teardown window keeps flowing on an already-open stream', async () => {
    const other = await buildOtherContext();
    expect(contexts.peek(other.id)?.generation).toBe(0);

    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');

    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realDispose = RunManager.prototype.dispose;
    const parkedDispose = vi
      .spyOn(RunManager.prototype, 'dispose')
      .mockImplementation(async function (this: RunManager) {
        await parked;
        await realDispose.call(this);
      });

    try {
      // Not awaited: this is the teardown window, and the whole point is that it is still open.
      const disposing = contexts.dispose(other.id);
      await vi.waitFor(() => expect(parkedDispose).toHaveBeenCalled());
      expect(contexts.peek(other.id)).toBeUndefined();

      // The same slug, still registered, touched again: a fresh build publishes generation 1
      // while generation 0's teardown is parked.
      expect((await apiRequest(app, `/api/v1/p/${other.id}/runs`)).status).toBe(200);
      const rebuilt = contexts.peek(other.id);
      expect(rebuilt?.generation).toBe(1);
      expect(rebuilt?.store).not.toBe(other.store);

      // Now let generation 0's dispose land — after the rebuild, naming a registration this
      // stream no longer holds.
      release();
      await disposing;

      const run = (rebuilt as { store: RunStore }).store.createRun({
        title: 'rebuilt-inside-the-window',
        workflow: 'quick-task',
        task: 'w',
        steps: [],
      });
      const body = await ws.readUntil(`"id":"${run.id}"`);
      expect(payloadsOf<{ id: string; project: string }>(body, 'run')).toEqual([
        { ...JSON.parse(JSON.stringify(run)), project: other.id },
      ]);
    } finally {
      release();
      parkedDispose.mockRestore();
    }
  });

  it('relays workspace-level bus events under their own names (projects, checkout, provider status)', async () => {
    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');

    bus.emit('project-added', { project: { id: 'newbie', name: 'newbie' } });
    bus.emit('checkout-progress', { url: 'octo/repo', phase: 'cloning' });
    bus.emit('project-removed', { id: 'newbie' });
    bus.emit('automation-change', { project: 'newbie', automationId: 'review-prs', revision: 2 });

    const body = await ws.readUntil('event: automation-change');
    expect(payloadsOf(body, 'project-added')).toEqual([{ project: { id: 'newbie', name: 'newbie' } }]);
    expect(payloadsOf(body, 'checkout-progress')).toEqual([{ url: 'octo/repo', phase: 'cloning' }]);
    expect(payloadsOf(body, 'project-removed')).toEqual([{ id: 'newbie' }]);
    expect(payloadsOf(body, 'automation-change')).toEqual([{ project: 'newbie', automationId: 'review-prs', revision: 2 }]);
  });
});
