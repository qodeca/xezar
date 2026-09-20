import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HealthResponse, RunsIndexResponse } from '@qodeca/xezar-contract';
import { projectDataDir } from '../project-data-paths.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import {
  ProjectContextError,
  ProjectContexts,
  refusedByInstanceMode,
  type ProjectContextSource,
} from './project-context.ts';
import { createApp, type ServerDeps } from './server.ts';

/**
 * `--instance project` in the server (#467, PR 2, spec § 5).
 *
 * The mode is a THIRD state, not a spelling of the two shipped narrowings: it changes whose DATA
 * one process serves and changes nothing about what is visible or manageable. Every case below
 * exists to keep those two halves apart — a change that starts hiding projects or refusing
 * project management has turned this into `XEZ_SINGLE_PROJECT`, which already exists.
 *
 * Proven red against the four named breaks of the spec: `context-built-in-project-mode`,
 * `capability-sent-in-workspace-mode`, `runs-index-still-cross-project` and
 * `guard-passes-on-empty-registry`.
 */
describe('instance mode: the server serves one project (#467, PR 2)', () => {
  const savedHome = process.env.XEZ_HOME;
  const savedDryRun = process.env.XEZ_DRY_RUN;
  let home: string;
  let bootRoot: string;
  let otherRoot: string;
  let store: RunStore;
  let bootId: string;
  let otherId: string;
  const builtContexts: ProjectContexts[] = [];

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'xez-instance-home-'));
    bootRoot = mkdtempSync(join(realpathSync(tmpdir()), 'xez-instance-boot-'));
    otherRoot = mkdtempSync(join(realpathSync(tmpdir()), 'xez-instance-other-'));
    process.env.XEZ_HOME = home;
    process.env.XEZ_DRY_RUN = '1';
    clearProjectProbeCache();
    store = RunStore.open(join(bootRoot, '.local/xezar'));
    bootId = (await registerProject(bootRoot)).id;
    otherId = (await registerProject(otherRoot)).id;
  });

  afterEach(async () => {
    for (const contexts of builtContexts.splice(0)) await contexts.disposeAll();
    store.flush();
    for (const dir of [home, bootRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = savedHome;
    if (savedDryRun === undefined) delete process.env.XEZ_DRY_RUN;
    else process.env.XEZ_DRY_RUN = savedDryRun;
  });

  /** An app wired the way boot wires it — its OWN context map, so the guard under test is the
   *  one `createApp` installs rather than one the test built. */
  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({
      repoRoot: bootRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      bootProjectId: bootId,
      onContexts: (contexts) => builtContexts.push(contexts),
      ...over,
    });

  describe('AC-2.2 a non-boot project answers 409, and no claim is taken', () => {
    it('names the other project, its folder and the project this cockpit does serve', async () => {
      const res = await apiRequest(makeApp({ instanceMode: 'project' }), `/api/v1/p/${otherId}/runs`);

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain(otherId);
      expect(body.error).toContain(otherRoot);
      expect(body.error).toContain(bootId);
      // The refusal a person must NOT meet: a writer-claim error describes a lock on a data
      // directory, which says nothing about which cockpit owns the project.
      expect(body.error).not.toContain('already in use');
    });

    it('named break `context-built-in-project-mode`: the writer claim is never taken', async () => {
      const res = await apiRequest(makeApp({ instanceMode: 'project' }), `/api/v1/p/${otherId}/runs`);

      expect(res.status).toBe(409);
      // Refused BEFORE `ownProjectData`, so the other cockpit's data directory is untouched —
      // the whole point of refusing in the map rather than letting the claim fail.
      expect(existsSync(join(projectDataDir(otherRoot), 'writer-claims'))).toBe(false);
    });

    it('the same request in the default workspace mode is not refused by this guard', async () => {
      const res = await apiRequest(makeApp(), `/api/v1/p/${otherId}/runs`);

      expect(res.status).toBe(200);
    });

    it('the boot project itself is served in project mode, under all three spellings', async () => {
      const app = makeApp({ instanceMode: 'project' });

      for (const path of ['/api/v1/runs', '/api/v1/p/default/runs', `/api/v1/p/${bootId}/runs`]) {
        expect((await apiRequest(app, path)).status).toBe(200);
      }
    });

    it('an unknown project is still a 404 — the mode does not turn one refusal into the other', async () => {
      const res = await apiRequest(makeApp({ instanceMode: 'project' }), '/api/v1/p/nope/runs');

      expect(res.status).toBe(404);
    });
  });

  describe('AC-2.3 project management stays allowed — this is not XEZ_SINGLE_PROJECT', () => {
    it('POST /projects still registers a project', async () => {
      const added = mkdtempSync(join(realpathSync(tmpdir()), 'xez-instance-added-'));
      try {
        const res = await apiRequest(makeApp({ instanceMode: 'project' }), '/api/v1/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ root: added }),
        });

        expect(res.status).toBe(200);
      } finally {
        rmSync(added, { recursive: true, force: true });
      }
    });

    it('GET /projects still lists every registered project', async () => {
      const res = await apiRequest(makeApp({ instanceMode: 'project' }), '/api/v1/projects');

      expect(res.status).toBe(200);
      const body = (await res.json()) as { projects: Array<{ id: string }> };
      expect(body.projects.map((p) => p.id).sort()).toEqual([bootId, otherId].sort());
    });
  });

  describe('AC-2.1 the health payload', () => {
    const capabilities = async (over: Partial<ServerDeps> = {}) => {
      const res = await apiRequest(makeApp(over), '/api/v1/health');
      expect(res.status).toBe(200);
      return ((await res.json()) as HealthResponse).capabilities;
    };

    it('named break `capability-sent-in-workspace-mode`: the default carries no instanceMode', async () => {
      expect('instanceMode' in (await capabilities())).toBe(false);
      expect('instanceMode' in (await capabilities({ instanceMode: 'workspace' }))).toBe(false);
    });

    it('project mode carries it, and carries nothing else new', async () => {
      const caps = await capabilities({ instanceMode: 'project' });

      expect(caps.instanceMode).toBe('project');
      expect(caps.singleProject).toBe(false);
      expect(caps.singleProjectRoot).toBeUndefined();
    });
  });

  describe('Q-7 the cross-project runs index narrows to this project', () => {
    const runsIndex = async (over: Partial<ServerDeps> = {}): Promise<RunsIndexResponse> => {
      const res = await apiRequest(makeApp(over), '/api/v1/workspace/runs-index');
      expect(res.status).toBe(200);
      return (await res.json()) as RunsIndexResponse;
    };

    const seedColdRun = (root: string, id: string) => {
      const dataDir = projectDataDir(root);
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        join(dataDir, 'runs.json'),
        JSON.stringify([
          {
            id,
            title: id,
            workflow: 'build',
            task: 't',
            status: 'done',
            createdAt: '2026-07-14T10:00:00Z',
            tokensUsed: 0,
            archived: false,
            steps: [],
          },
        ]),
        'utf8',
      );
    };

    beforeEach(() => {
      store.createRun({ title: 'Boot task', workflow: 'build', task: 't', steps: [] });
      seedColdRun(otherRoot, 'aaaaaaaa-0000-4000-8000-000000000001');
    });

    it('named break `runs-index-still-cross-project`: project mode answers for this project only', async () => {
      const body = await runsIndex({ instanceMode: 'project' });

      expect(body.runs.map((r) => r.projectId)).toEqual([bootId]);
    });

    it('the default workspace mode still answers across projects', async () => {
      const body = await runsIndex();

      expect(new Set(body.runs.map((r) => r.projectId))).toEqual(new Set([bootId, otherId]));
    });
  });

  describe('AC-2.5 the guard fails OPEN when the registry cannot be read', () => {
    it('named break `guard-passes-on-empty-registry`: an absent boot id refuses nothing', () => {
      // "We never learned which project this process boots" and "this is not the boot project"
      // are different facts and must not be the same branch (AGENTS.md § A fail-open helper
      // needs a populated-input guarantee, or it lies).
      expect(refusedByInstanceMode('project', undefined, 'anything')).toBeNull();
      expect(refusedByInstanceMode('project', '', 'anything')).toBeNull();
      // And with a boot id we actually have, it still refuses — the guard is not simply off.
      expect(refusedByInstanceMode('project', 'boot', 'other')).toBe('boot');
      expect(refusedByInstanceMode('project', 'boot', 'boot')).toBeNull();
      // Neither other mode refuses anything, whatever the ids say.
      expect(refusedByInstanceMode('workspace', 'boot', 'other')).toBeNull();
      expect(refusedByInstanceMode('narrowed', 'boot', 'other')).toBeNull();
      expect(refusedByInstanceMode(undefined, 'boot', 'other')).toBeNull();
    });

    it('an unreadable ~/.xezar/config.json still serves the boot project', async () => {
      writeFileSync(join(home, 'config.json'), '{ this is not json', 'utf8');
      clearProjectProbeCache();
      const app = makeApp({ instanceMode: 'project', bootProjectId: undefined });

      // No registry, so no boot id to compare against — and a cockpit that refused its own
      // project because a written-never-required file was broken would serve nothing at all.
      expect((await apiRequest(app, '/api/v1/runs')).status).toBe(200);
      expect((await apiRequest(app, '/api/v1/p/default/runs')).status).toBe(200);
    });

    it('a map whose boot-id source throws serves rather than refuses', async () => {
      const sources: ProjectContextSource[] = [{ id: 'other', root: otherRoot, status: 'not-git' }];
      const contexts = new ProjectContexts({
        listProjects: async () => sources,
        instanceMode: () => 'project',
        bootProjectId: () => Promise.reject(new Error('registry on fire')),
      });
      builtContexts.push(contexts);

      await expect(contexts.context('other')).resolves.toMatchObject({ id: 'other' });
    });
  });

  describe('the map refuses before it claims, independently of any route', () => {
    it('throws ProjectContextError with reason other-instance', async () => {
      const sources: ProjectContextSource[] = [{ id: 'other', root: otherRoot, status: 'not-git' }];
      const contexts = new ProjectContexts({
        listProjects: async () => sources,
        instanceMode: () => 'project',
        bootProjectId: () => 'boot',
      });
      builtContexts.push(contexts);

      await expect(contexts.context('other')).rejects.toMatchObject({
        name: 'ProjectContextError',
        reason: 'other-instance',
      });
      await expect(contexts.context('other')).rejects.toBeInstanceOf(ProjectContextError);
      expect(existsSync(join(projectDataDir(otherRoot), 'writer-claims'))).toBe(false);
    });
  });
});
