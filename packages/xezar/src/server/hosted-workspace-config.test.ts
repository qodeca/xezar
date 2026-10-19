import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workspaceConfigPath } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * `PUT /api/v1/workspace/config` in hosted mode: the keys that decide what this machine
 * exposes (the browsable root, the checkout folder, the host variables passed to agents and
 * which registered projects one process serves) stay a local-machine choice, like agent
 * config. Display and resource settings stay writable. A refused body changes nothing.
 */
describe('PUT /api/v1/workspace/config — machine-level keys in hosted mode', () => {
  const savedXezHome = process.env.XEZ_HOME;
  const savedRemote = process.env.XEZ_REMOTE;
  let home: string;
  let target: string;
  let app: Hono;
  let store: RunStore;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'xez-hosted-config-home-')));
    target = realpathSync(mkdtempSync(join(tmpdir(), 'xez-hosted-config-target-')));
    process.env.XEZ_HOME = join(home, '.xezar');
    delete process.env.XEZ_REMOTE;
    const repoRoot = join(home, 'boot');
    mkdirSync(join(repoRoot, '.local/xezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    for (const [key, value] of [
      ['XEZ_HOME', savedXezHome],
      ['XEZ_REMOTE', savedRemote],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [home, target]) rmSync(dir, TEST_DIR_RM_OPTIONS);
  });

  const put = (json: unknown) =>
    apiRequest(app, '/api/v1/workspace/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(json),
    });
  const stored = (): string => {
    try {
      return readFileSync(workspaceConfigPath(), 'utf8');
    } catch {
      return '';
    }
  };

  const machineBodies: Array<[string, () => unknown]> = [
    ['browseRoot', () => ({ browseRoot: target })],
    ['projectsDir', () => ({ projectsDir: join(target, 'checkouts') })],
    ['agentEnvPassthrough', () => ({ agentEnvPassthrough: ['SOME_HOST_VARIABLE'] })],
    ['agentEnvPassthrough', () => ({ agentEnvPassthrough: null })],
    ['cli.instance', () => ({ cli: { instance: 'workspace' } })],
  ];

  it.each(machineBodies)('refuses %s with 409 and stores nothing', async (key, body) => {
    process.env.XEZ_REMOTE = '1';
    const before = stored();
    const res = await put(body());
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(key);
    expect(error).toContain('hosted mode');
    expect(stored()).toBe(before);
  });

  it('refuses a mixed body whole, so the display key in it is not saved either', async () => {
    process.env.XEZ_REMOTE = '1';
    const before = stored();
    const res = await put({ followups: true, browseRoot: target });
    expect(res.status).toBe(409);
    expect(stored()).toBe(before);
  });

  it('keeps display and resource settings writable in hosted mode', async () => {
    process.env.XEZ_REMOTE = '1';
    const res = await put({ followups: true, resources: { maxParallel: 3 }, cli: { logLevel: 'warn' } });
    expect(res.status).toBe(200);
    const config = JSON.parse(stored()) as { followups?: boolean; resources?: { maxParallel?: number } };
    expect(config.followups).toBe(true);
    expect(config.resources?.maxParallel).toBe(3);
  });

  it.each(machineBodies)('still accepts %s in local mode', async (_key, body) => {
    const res = await put(body());
    expect(res.status).toBe(200);
  });
});
