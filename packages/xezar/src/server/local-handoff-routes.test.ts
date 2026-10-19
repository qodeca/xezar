import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { xezarHomeDir } from '../paths.ts';
import { createApp, localHandoffRouteManifest } from './server.ts';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';

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

/**
 * Every route the app registers, classified for hosted mode (`capabilities.localHandoff: false`).
 * A route marked `localHandoffRoute` needs no entry: the manifest finds it and the case below sends
 * it a request in hosted mode. Every OTHER registration must be named here, so a new route fails
 * the classification case until its author decides which of these it is. Fail closed: no default.
 *
 * This is a baseline of the routes as they were registered on 2026-10-18, not a per-route security
 * audit; a route that turns out to need the local-only refusal moves out of HOSTED_SAFE and gains
 * the marker in `server.ts`. Project-scoped copies (`/api/v1/p/:projectId/…`) share the entry of
 * their `/api/v1/…` spelling.
 */
/** Served in hosted mode. Any hosted-mode trimming of what they return is the handler's own and
 *  pinned by that route's own tests. */
const HOSTED_SAFE: readonly string[] = [
  'GET /*', 'GET /api/v1/agent-config',
  'GET /api/v1/agent-config/:id', 'GET /api/v1/automation-checks/:checkId',
  'GET /api/v1/automation-log', 'POST /api/v1/automation-log/:receiptId/retry',
  'GET /api/v1/automations', 'POST /api/v1/automations',
  'DELETE /api/v1/automations/:id', 'GET /api/v1/automations/:id',
  'PUT /api/v1/automations/:id', 'POST /api/v1/automations/:id/check',
  'POST /api/v1/automations/:id/enable', 'POST /api/v1/automations/:id/pause',
  'GET /api/v1/config', 'PUT /api/v1/config',
  'GET /api/v1/events', 'GET /api/v1/fs/browse',
  'GET /api/v1/github', 'GET /api/v1/github/checks',
  'GET /api/v1/github/comments/:kind/:number', 'GET /api/v1/github/prs/:number/changes',
  'POST /api/v1/github/prs/:number/merge', 'GET /api/v1/github/prs/:number/merge-state',
  'POST /api/v1/github/prs/:number/ready', 'GET /api/v1/github/ref-status',
  'GET /api/v1/github/search', 'GET /api/v1/groups/:groupId',
  'POST /api/v1/groups/:groupId/pick', 'GET /api/v1/health',
  'GET /api/v1/launch-key', 'GET /api/v1/mcp/leader',
  'GET /api/v1/mcp/reference', 'GET /api/v1/models',
  'GET /api/v1/onboarding', 'POST /api/v1/onboarding/offered',
  'GET /api/v1/open-targets', 'POST /api/v1/plan',
  'GET /api/v1/projects', 'POST /api/v1/projects',
  'DELETE /api/v1/projects/:projectId', 'PATCH /api/v1/projects/:projectId',
  'POST /api/v1/projects/checkout', 'PUT /api/v1/providers/:provider/enabled',
  'POST /api/v1/providers/:provider/retry', 'GET /api/v1/providers/status',
  'GET /api/v1/repo', 'POST /api/v1/repo/branch',
  'GET /api/v1/repo/changes', 'GET /api/v1/repo/commit/:sha',
  'GET /api/v1/repo/diff', 'GET /api/v1/runs',
  'POST /api/v1/runs', 'DELETE /api/v1/runs/:id',
  'GET /api/v1/runs/:id', 'PATCH /api/v1/runs/:id',
  'POST /api/v1/runs/:id/archive', 'DELETE /api/v1/runs/:id/auto-resume',
  'POST /api/v1/runs/:id/cancel', 'GET /api/v1/runs/:id/changes',
  'GET /api/v1/runs/:id/commit/:sha', 'GET /api/v1/runs/:id/commits',
  'POST /api/v1/runs/:id/continue', 'GET /api/v1/runs/:id/diff',
  'GET /api/v1/runs/:id/events', 'GET /api/v1/runs/:id/files',
  'POST /api/v1/runs/:id/finish', 'POST /api/v1/runs/:id/git/commit',
  'POST /api/v1/runs/:id/git/push', 'GET /api/v1/runs/:id/handoff',
  'GET /api/v1/runs/:id/history', 'GET /api/v1/runs/:id/history-context',
  'GET /api/v1/runs/:id/images/:file', 'POST /api/v1/runs/:id/messages',
  'POST /api/v1/runs/:id/pin', 'POST /api/v1/runs/:id/pr',
  'DELETE /api/v1/runs/:id/queued-messages/:msgId', 'PATCH /api/v1/runs/:id/queued-messages/:msgId',
  'POST /api/v1/runs/:id/read', 'POST /api/v1/runs/:id/remove-worktree',
  'POST /api/v1/runs/:id/unread', 'GET /api/v1/runs/:id/version',
  'POST /api/v1/runs/archive-finished', 'POST /api/v1/runs/read-all',
  'GET /api/v1/skills', 'GET /api/v1/skills/importable',
  'POST /api/v1/skills/refresh', 'GET /api/v1/todos',
  'DELETE /api/v1/todos/:id', 'POST /api/v1/todos/:id/start',
  'GET /api/v1/ui-state', 'PUT /api/v1/ui-state',
  'GET /api/v1/workflows', 'POST /api/v1/workflows',
  'DELETE /api/v1/workflows/:name', 'POST /api/v1/workflows/parse',
  'GET /api/v1/workspace/agent-profiles', 'GET /api/v1/workspace/agent-quota',
  'POST /api/v1/workspace/agent-quota/refresh', 'GET /api/v1/workspace/config',
  'PUT /api/v1/workspace/config', 'GET /api/v1/workspace/events',
  'GET /api/v1/workspace/runs-index', 'GET /api/v1/workspace/skills-update',
  'POST /api/v1/workspace/skills-update/apply', 'POST /api/v1/workspace/skills-update/check',
  'GET /api/v1/workspace/ui-state', 'PUT /api/v1/workspace/ui-state',
  'GET /api/v1/worktrees', 'POST /api/v1/worktrees/reclaim',
  'GET /assets/:file', 'GET /xezar.svg',
];
/** Served in hosted mode, but the handler refuses the local effect itself: it refuses a named
 *  account and the terminal hand-off with a 409, and still answers the bare status the cockpit
 *  needs. Kept out of the marker because the refusal is conditional on the request. */
const REFUSED_IN_HANDLER: readonly string[] = ['POST /api/v1/providers/connect'];
/** `app.use` middleware (hono records it as method ALL). An `.all()` route would land here too,
 *  which is why these are listed rather than skipped. */
const MIDDLEWARE: readonly string[] = [
  'ALL /*', 'ALL /api/*',
  'ALL /api/v1/*', 'ALL /api/v1/automation-checks/*',
  'ALL /api/v1/automation-log', 'ALL /api/v1/automation-log/*',
  'ALL /api/v1/automations', 'ALL /api/v1/automations/*',
  'ALL /api/v1/health', 'ALL /api/v1/ui-state',
  'ALL /api/v1/workspace/ui-state',
];

const routeKey = (method: string, path: string): string =>
  `${method} ${path.startsWith('/api/v1/p/:projectId') ? `/api/v1${path.slice('/api/v1/p/:projectId'.length)}` : path}`;

describe('registration-derived local-only boundary (#547)', () => {
  const roots: string[] = [];
  const stores: RunStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.flush();
    for (const root of roots.splice(0)) rmSync(root, TEST_DIR_RM_OPTIONS);
    vi.unstubAllEnvs();
  });
  it.each(['environment', 'bind-host', 'local'])('A-LOCAL-02 every registered route is marked local-only or explicitly classified for hosted mode: %s', (mode) => {
    vi.stubEnv('XEZ_REMOTE', mode === 'environment' ? '1' : '');
    vi.stubEnv('XEZ_DRY_RUN', '1');
    const root = mkdtempSync(join(tmpdir(), 'xez-local-routes-'));
    roots.push(root);
    const store = RunStore.open(join(root, '.local/xezar'));
    stores.push(store);
    const open = vi.fn().mockResolvedValue(true);
    const app = createApp({ repoRoot: root, store, manager: {} as RunManager,
      openTerminal: open, openFile: open, openApp: open,
      version: 'test', bindHost: mode === 'bind-host' ? '0.0.0.0' : '127.0.0.1' });
    const marked = new Set(localHandoffRouteManifest(app).map(({ method, path }) => routeKey(method, path)));
    const classified = new Map<string, string>();
    for (const [kind, keys] of [['hosted-safe', HOSTED_SAFE], ['refused-in-handler', REFUSED_IN_HANDLER], ['middleware', MIDDLEWARE]] as const) {
      for (const key of keys) {
        expect(classified.has(key), `${key} is classified twice`).toBe(false);
        classified.set(key, kind);
      }
    }
    // Never pass on an empty inventory: no routes, or no marker found, would make every check below vacuous.
    expect(app.routes.length).toBeGreaterThan(classified.size);
    expect(marked.size).toBeGreaterThan(0);
    const registered = new Set(app.routes.map(({ method, path }) => routeKey(method, path)));
    const unclassified = [...registered].filter((key) => !marked.has(key) && !classified.has(key)).sort();
    expect(unclassified, 'a new route must carry localHandoffRoute in server.ts, or be added to HOSTED_SAFE / REFUSED_IN_HANDLER / MIDDLEWARE here').toEqual([]);
    // A marked route listed as hosted-safe is a contradiction, and a stale entry hides a removed route.
    expect([...marked].filter((key) => classified.has(key)).sort(), 'marked local-only AND classified').toEqual([]);
    expect([...classified.keys()].filter((key) => !registered.has(key)).sort(), 'classified but not registered').toEqual([]);
    // A route is marked as a whole: its project-scoped copy is marked exactly when its canonical spelling is.
    for (const { method, path } of app.routes) {
      if (!path.startsWith('/api/v1/p/:projectId/')) continue;
      const canonical = `/api/v1${path.slice('/api/v1/p/:projectId'.length)}`;
      if (!app.routes.some((route) => route.method === method && route.path === canonical)) continue;
      const scopedMarked = localHandoffRouteManifest(app).some((route) => route.method === method && route.path === path);
      const canonicalMarked = localHandoffRouteManifest(app).some((route) => route.method === method && route.path === canonical);
      expect(scopedMarked, `${method} ${path}`).toBe(canonicalMarked);
    }
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
