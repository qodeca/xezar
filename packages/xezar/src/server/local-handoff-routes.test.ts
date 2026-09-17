import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { xezarHomeDir } from '../paths.ts';
import { createApp, localHandoffRouteManifest } from './server.ts';

// Registration owns the inventory. Source parity prevents an inline local-only
// refusal from being added without the guard (or losing its marker).
function inlineLocalOnlyRoutes() {
  const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  const registrations = [...source.matchAll(/\.(get|post|put|patch|delete)\(\s*'(\/[^']+)'/g)];
  const routes: string[] = [];
  for (const [index, match] of registrations.entries()) {
    const body = source.slice(match.index, registrations[index + 1]?.index);
    const hasRefusal = /if \(!capabilities\(\)\.localHandoff\)\s*(?:\{\s*)?return c\.json/.test(body);
    if (!hasRefusal || match[2] === '/providers/connect') continue;
    expect(body.slice(0, body.indexOf('async (c)')), match[2]).toContain('localHandoffRoute');
    routes.push(`${match[1]?.toUpperCase()} ${match[2]}`);
  }
  expect(routes.length).toBeGreaterThan(0);
  return routes;
}

describe('registration-derived local-only boundary (#547)', () => {
  const roots: string[] = [];
  const stores: RunStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.flush();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it.each(['environment', 'bind-host'])('A-LOCAL-01 all registered guards refuse before local effects: %s', async (mode) => {
    vi.stubEnv('XEZ_REMOTE', mode === 'environment' ? '1' : '');
    vi.stubEnv('XEZ_DRY_RUN', '1');
    const root = mkdtempSync(join(tmpdir(), 'xez-local-routes-'));
    roots.push(root);
    const store = RunStore.open(join(root, '.local/xezar'));
    stores.push(store);
    const run = store.createRun({ title: 'fixture', task: 'fixture', workflow: 'fixture', steps: [] });
    const open = vi.fn().mockResolvedValue(true);
    const protectedPaths = [join(xezarHomeDir(), 'agent-accounts.json'), join(root, '.claude/settings.json')];
    const snapshot = () => protectedPaths.map((path) => existsSync(path) ? readFileSync(path, 'utf8') : null);
    const before = snapshot();
    const app = createApp({ repoRoot: root, store, manager: {} as RunManager,
      openTerminal: open, openFile: open, openApp: open,
      version: 'test', bindHost: mode === 'bind-host' ? '0.0.0.0' : '127.0.0.1' });
    const manifest = localHandoffRouteManifest(app);
    expect(manifest.length).toBeGreaterThan(0); // never silently pass an empty inventory
    const canonical = manifest.filter(({ path }) => !path.startsWith('/api/v1/p/'));
    expect(canonical.map(({ method, path }) => `${method} ${path.slice('/api/v1'.length)}`).sort())
      .toEqual(inlineLocalOnlyRoutes().sort());
    for (const { method, path } of manifest) {
      const url = path.replace(':projectId', 'default').replace(/:id\b/g, path.includes('/runs/') ? run.id : 'fixture');
      // Request fixtures are selected for the registered row; they never select
      // which rows run. Strict schemas intentionally reject a superset payload.
      let body: object = {};
      if (path.endsWith('/mcp/leader')) body = { action: 'attach', client: 'codex' };
      else if (path.includes('/agent-config/')) body = { content: '{}', version: null };
      else if (path.endsWith('/open-in')) body = { target: 'vscode' };
      else if (path.includes('/agent-profiles')) {
        if (path.endsWith('/selection')) body = { projectId: 'default', provider: 'claude', profileId: null };
        else if (path.endsWith('/open')) body = { file: 'folder' };
        else if (method === 'PATCH') body = { label: 'fixture' };
        else if (method === 'POST') body = { provider: 'claude', configDir: join(root, 'account') };
      }
      const response = await app.request(url, { method,
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
      expect(response.status, `${method} ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.stringContaining('hosted mode') });
      expect(store.listRuns()).toHaveLength(1);
      expect(open).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
    }
  });
});
