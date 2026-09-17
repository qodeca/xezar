import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectDataDir } from '../project-data-paths.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject, removeProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * #591: the registry changed WITHOUT going through the project-removal route — a second process, a
 * hand-edited `~/.xezar/config.json`, or a test seeding the registry directly, all of which the
 * QA of PR #589 (case E) reproduced by reusing the same registered id across repeated local runs.
 * Before the fix, `ProjectContexts.context()` returned the cached `{store, manager, dataDir}`
 * bundle for whatever root it was first built against, forever — so a re-registered id kept
 * writing into a `dataDir` that no longer existed and crashed with ENOENT.
 *
 * Reusing the SAME id for two different roots (rather than calling `dispose()` directly, which
 * would trivially pass) is the point: it is what a registry re-read alone cannot always tell apart
 * from "still the same registration" (see the `generations` counter doc in `project-context.ts`)
 * — but a ROOT change is not that ambiguous case, which is exactly what this test pins.
 */
describe('project context resolves the CURRENT registry root (#591)', () => {
  const savedHome = process.env.XEZ_HOME;
  const savedDryRun = process.env.XEZ_DRY_RUN;
  let home: string;
  let base: string;
  let rootOld: string;
  let rootNew: string;
  let bootRoot: string;
  let bootStore: RunStore;
  let contexts: ProjectContexts;
  let app: Hono;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'xez-drift-home-'));
    base = mkdtempSync(join(tmpdir(), 'xez-drift-base-'));
    bootRoot = mkdtempSync(join(tmpdir(), 'xez-drift-boot-'));
    process.env.XEZ_HOME = home;
    process.env.XEZ_DRY_RUN = '1';
    clearProjectProbeCache();

    // Same basename both times, in different parents: after the old registration is removed, the
    // slug allocator (basename-derived) hands the SAME id back to the new root — precisely the
    // "re-registered project" the issue names.
    rootOld = join(base, 'run-1', 'shared-name');
    rootNew = join(base, 'run-2', 'shared-name');
    mkdirSync(rootOld, { recursive: true });
    mkdirSync(rootNew, { recursive: true });

    bootStore = RunStore.open(join(bootRoot, '.local/xezar'), { keepLive: true });
    contexts = new ProjectContexts({ listProjects });
    app = createApp({
      repoRoot: bootRoot,
      store: bootStore,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
    });
  });

  afterEach(async () => {
    await contexts.disposeAll();
    bootStore.flush();
    for (const dir of [home, base, bootRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = savedHome;
    if (savedDryRun === undefined) delete process.env.XEZ_DRY_RUN;
    else process.env.XEZ_DRY_RUN = savedDryRun;
  });

  it('re-registering the same id against a new root serves the new dataDir, not the deleted old one', async () => {
    const first = await registerProject(rootOld);
    const id = first.id;

    // First touch through the real route builds and caches the context for the OLD root — the
    // exact seam `resolveProjectScope` calls on every scoped request.
    expect((await apiRequest(app, `/api/v1/p/${id}/runs`)).status).toBe(200);
    expect(contexts.peek(id)?.root).toBe(rootOld);

    // Out-of-band registry change: NOT the removal route, so `contexts.dispose()` never fires.
    // The old folder (and its dataDir) is really gone, the way a deleted worktree or a moved repo
    // would be.
    await removeProject(id);
    rmSync(rootOld, { recursive: true, force: true });
    const second = await registerProject(rootNew);
    expect(second.id).toBe(id); // same slug reused — the scenario the removal route never saw

    // Same warm server, same route: must resolve to the CURRENT root, not the cached one.
    const res = await apiRequest(app, `/api/v1/p/${id}/runs`);
    expect(res.status).toBe(200);

    const after = contexts.peek(id);
    expect(after?.root).toBe(rootNew);
    expect(after?.dataDir).toBe(projectDataDir(rootNew));

    // A run against the reused id lands under the NEW folder and reaches a terminal state — never
    // the ENOENT this issue reports against the deleted old one.
    const run = after!.store.createRun({ title: 'drift', workflow: 'quick-task', task: 'x', steps: [] });
    after!.store.appendEvent(run.id, { type: 'log', text: 'drift' }); // the write the issue's ENOENT names
    after!.store.updateRun(run.id, { status: 'done' });
    after!.store.flush();
    expect(existsSync(join(projectDataDir(rootNew), 'runs.json'))).toBe(true);
    expect(existsSync(join(projectDataDir(rootNew), 'runs', `${run.id}.ndjson`))).toBe(true);
    expect(existsSync(rootOld)).toBe(false); // the old root really is gone, not just unlinked in the registry
  });
});
