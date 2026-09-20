import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectsResponse } from '@qodeca/xezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import { InstanceLiveness, type HealthProbe } from './instance-liveness.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type ServerDeps } from './server.ts';

/**
 * The derived `instance?` field on `GET /api/v1/projects` (#467, PR 3, spec § 5).
 *
 * The route half of the checker's own suite: the field is filled through the chained projects
 * family, it is filled for every row or for none, and in hosted mode this server makes no
 * outbound request at all. The probe and the claim reader are injected, so what these cases
 * exercise is the ROUTE's decision to look or not to look — never a real socket.
 */
describe('GET /api/v1/projects carries the derived instance field (#467, PR 3)', () => {
  const savedHome = process.env.XEZ_HOME;
  const savedRemote = process.env.XEZ_REMOTE;
  const savedDryRun = process.env.XEZ_DRY_RUN;
  let home: string;
  let bootRoot: string;
  let otherRoot: string;
  let store: RunStore;
  let bootId: string;
  let otherId: string;

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'xez-instance-field-home-'));
    bootRoot = mkdtempSync(join(realpathSync(tmpdir()), 'xez-instance-field-boot-'));
    otherRoot = mkdtempSync(join(realpathSync(tmpdir()), 'xez-instance-field-other-'));
    process.env.XEZ_HOME = home;
    process.env.XEZ_DRY_RUN = '1';
    delete process.env.XEZ_REMOTE;
    clearProjectProbeCache();
    store = RunStore.open(join(bootRoot, '.local/xezar'));
    bootId = (await registerProject(bootRoot)).id;
    otherId = (await registerProject(otherRoot)).id;
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, bootRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, saved] of [
      ['XEZ_HOME', savedHome],
      ['XEZ_REMOTE', savedRemote],
      ['XEZ_DRY_RUN', savedDryRun],
    ] as const) {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  /** Remember an address for `otherId`, the way a real start does after its bind succeeds. */
  const rememberAddress = async (port: number): Promise<void> => {
    await mergeWriteWorkspaceConfig((config) => {
      const project = config.projects.find((p) => p.id === otherId);
      if (project) {
        project.lastListen = { port, host: '127.0.0.1', observedAt: new Date().toISOString() };
      }
    });
  };

  const makeApp = (liveness: InstanceLiveness, over: Partial<ServerDeps> = {}) =>
    createApp({
      repoRoot: bootRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      bootProjectId: bootId,
      instanceLiveness: liveness,
      ...over,
    });

  const list = async (liveness: InstanceLiveness, over: Partial<ServerDeps> = {}) => {
    const app = makeApp(liveness, over);
    const first = (await (await apiRequest(app, '/api/v1/projects')).json()) as ProjectsResponse;
    // One request starts the bounded probes; the second reads what they answered. That is the
    // cache window of `multi-instance.md` § 6, not a workaround: the registry render never waits
    // on a socket.
    await liveness.settled();
    const second = (await (await apiRequest(app, '/api/v1/projects')).json()) as ProjectsResponse;
    return { first, second };
  };

  const row = (body: ProjectsResponse, id: string) => body.projects.find((p) => p.id === id)!;

  it('AC-3.4 the field is present on every row, and it is omitted — never null — when unknown', async () => {
    const { second } = await list(new InstanceLiveness({ probe: async () => ({ kind: 'no-answer' }), claimLive: () => false }));

    for (const project of second.projects) {
      expect(project.instance).toBeDefined();
      expect(project.instance).not.toBeNull();
    }
  });

  it('the project this cockpit serves is `this`, and carries no url', async () => {
    const { first } = await list(new InstanceLiveness({ probe: async () => ({ kind: 'no-answer' }) }));

    expect(row(first, bootId).instance).toEqual({ state: 'this' });
  });

  it('AC-3.2 a running project answers `running` with a url to ITS cockpit, not to this one', async () => {
    await rememberAddress(4322);
    const { second } = await list(
      new InstanceLiveness({ probe: async () => ({ kind: 'named', bootProject: otherId }) }),
    );

    expect(row(second, otherId).instance).toEqual({
      state: 'running',
      url: `http://127.0.0.1:4322/p/${otherId}/`,
    });
    // This app's own address is 127.0.0.1:4321 (`apiRequest`'s Host header); the link points
    // somewhere else, which is the whole reason the row exists.
    expect(row(second, otherId).instance?.url).not.toContain(':4321');
  });

  it('AC-3.1 named break `probe-trusts-lastListen`: a stale remembered address renders stopped', async () => {
    await rememberAddress(4322);
    const { second } = await list(
      new InstanceLiveness({ probe: async () => ({ kind: 'no-answer' }), claimLive: () => false }),
    );

    expect(row(second, otherId).instance).toEqual({ state: 'stopped' });
  });

  it('named break `wrong-project-accepted`: another project answering on that port is not this one', async () => {
    await rememberAddress(4322);
    const { second } = await list(
      new InstanceLiveness({ probe: async () => ({ kind: 'named', bootProject: 'someone-else' }) }),
    );

    expect(row(second, otherId).instance).toEqual({ state: 'stopped' });
  });

  it('named break `port-zero-reads-as-stopped`: a live cockpit with no remembered address is running', async () => {
    // Nothing is remembered — a `--port 0` start writes no `lastListen` — but the claim is live.
    const probe = vi.fn<HealthProbe>(async () => ({ kind: 'no-answer' }));
    const { first } = await list(new InstanceLiveness({ probe, claimLive: (root) => root === otherRoot }));

    expect(row(first, otherId).instance).toEqual({ state: 'running-unknown-address' });
    // And it never asked: there was no address to ask.
    expect(probe).not.toHaveBeenCalled();
  });

  it('AC-3.3 hosted mode makes NO outbound probe and sends no field at all', async () => {
    await rememberAddress(4322);
    process.env.XEZ_REMOTE = '1';
    const probe = vi.fn<HealthProbe>(async () => ({ kind: 'named', bootProject: otherId }));
    const claimLive = vi.fn(() => true);
    const liveness = new InstanceLiveness({ probe, claimLive });

    const app = makeApp(liveness);
    const res = await apiRequest(app, '/api/v1/projects');
    const text = await res.text();
    await liveness.settled();

    expect(probe).not.toHaveBeenCalled();
    expect(claimLive).not.toHaveBeenCalled();
    // Absent on the wire, not `null` and not `{state:'checking'}` — a hosted server did not look.
    expect(text).not.toContain('"instance"');
    const body = JSON.parse(text) as ProjectsResponse;
    for (const project of body.projects) expect('instance' in project).toBe(false);
  });
});
