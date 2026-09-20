import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  projectInstanceSchema,
  projectListEntrySchema,
  projectsResponseSchema,
} from '@qodeca/xezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import type { AppType } from './app-type.ts';
import { InstanceLiveness } from './instance-liveness.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * `packages/contract/src/projects.ts` describes EXACTLY what `GET /api/v1/projects` sends, for
 * the derived `instance?` field of #467 PR 3 as much as for the rest of the row.
 *
 * Two halves, because neither is enough on its own:
 *
 * - **Compile time**, both directions, the way every `contract-parity*.test.ts` does it. A
 *   one-way assignability check is green on real drift, and the whole family's assertion already
 *   lives in `contract-parity.workspace.test.ts`; what is added here is the new field's own
 *   shape, asserted against the type the ROUTE infers rather than against the schema it was
 *   written from.
 * - **Run time**, against a real response. A type says nothing about the two properties this
 *   field's contract turns on: that the key is OMITTED rather than sent as `null` when it is
 *   unknown, and that no key the schema does not name reaches the wire.
 */
describe('the projects contract matches the route exactly (#467, PR 3)', () => {
  const client = hc<AppType>('http://127.0.0.1');

  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  type Projects200 = InferResponseType<typeof client.api.v1.projects.$get, 200>;
  type RouteInstance = NonNullable<Projects200['projects'][number]['instance']>;

  type _Checks = [
    Assert<Exact<z.infer<typeof projectsResponseSchema>, Projects200>>,
    Assert<Exact<z.infer<typeof projectInstanceSchema>, RouteInstance>>,
    // Optional on the route as well as in the schema — a required field here would be a promise
    // hosted mode cannot keep.
    Assert<Exact<undefined extends Projects200['projects'][number]['instance'] ? true : false, true>>,
  ];

  const savedHome = process.env.XEZ_HOME;
  const savedRemote = process.env.XEZ_REMOTE;
  let home: string;
  let bootRoot: string;
  let otherRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'xez-parity-projects-home-'));
    bootRoot = mkdtempSync(join(realpathSync(tmpdir()), 'xez-parity-projects-boot-'));
    otherRoot = mkdtempSync(join(realpathSync(tmpdir()), 'xez-parity-projects-other-'));
    process.env.XEZ_HOME = home;
    delete process.env.XEZ_REMOTE;
    clearProjectProbeCache();
    store = RunStore.open(join(bootRoot, '.local/xezar'));
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, bootRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = savedHome;
    if (savedRemote === undefined) delete process.env.XEZ_REMOTE;
    else process.env.XEZ_REMOTE = savedRemote;
  });

  const fetchProjects = async (liveness: InstanceLiveness): Promise<unknown> => {
    const bootId = (await registerProject(bootRoot)).id;
    const otherId = (await registerProject(otherRoot)).id;
    await mergeWriteWorkspaceConfig((config) => {
      const project = config.projects.find((p) => p.id === otherId);
      if (project) {
        project.lastListen = { port: 4322, host: '127.0.0.1', observedAt: new Date().toISOString() };
      }
    });
    const app = createApp({
      repoRoot: bootRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      bootProjectId: bootId,
      instanceLiveness: liveness,
    });
    await apiRequest(app, '/api/v1/projects');
    await liveness.settled();
    return (await (await apiRequest(app, '/api/v1/projects')).json()) as unknown;
  };

  it('a real response parses, and carries no key the schema does not name', async () => {
    const body = await fetchProjects(
      new InstanceLiveness({ probe: async () => ({ kind: 'named', bootProject: 'nobody' }) }),
    );

    const parsed = projectsResponseSchema.parse(body);
    const known = new Set(Object.keys(projectListEntrySchema.shape));
    for (const project of (body as { projects: Record<string, unknown>[] }).projects) {
      // `.parse` STRIPS unknown keys, so it cannot answer "no wider" by itself.
      expect(Object.keys(project).filter((key) => !known.has(key))).toEqual([]);
    }
    expect(parsed.projects.every((project) => project.instance !== undefined)).toBe(true);
  });

  it('unknown is an ABSENT key, never a null — hosted mode is the case that produces it', async () => {
    process.env.XEZ_REMOTE = '1';
    const body = await fetchProjects(new InstanceLiveness({ probe: async () => ({ kind: 'no-answer' }) }));

    const parsed = projectsResponseSchema.parse(body);
    expect(parsed.projects.length).toBeGreaterThan(0);
    for (const project of (body as { projects: Record<string, unknown>[] }).projects) {
      expect('instance' in project).toBe(false);
    }
    // And the schema would REFUSE the null the route must never send.
    expect(projectInstanceSchema.safeParse(null).success).toBe(false);
  });
});
