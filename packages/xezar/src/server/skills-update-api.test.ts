import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { ensureBareClone } from '../skills-remote.ts';
import { SkillsUpdateConflictError, SkillsUpdateService } from '../skills-update.ts';
import { projectStateLayout, setActiveStateLayout } from '../state-layout.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

describe('workspace skills update API', () => {
  const savedHome = process.env.XEZ_HOME;
  const savedAutoUpdate = process.env.XEZ_SKILLS_AUTO_UPDATE;
  let home: string;
  let repoRoot: string;
  let missingRoot: string;
  let store: RunStore;
  let service: SkillsUpdateService;
  let app: Hono;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'xez-skills-update-api-'));
    process.env.XEZ_HOME = home;
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-skills-update-repo-'));
    missingRoot = join(home, 'gone');
    mkdirSync(join(repoRoot, '.local/xezar'), { recursive: true });
    // No team-skills source: the catalog block (#744) is empty here, and no case in this block
    // reads the machine's shared skills cache.
    mkdirSync(join(repoRoot, '.xezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.xezar', 'config.json'), JSON.stringify({ skillsRepos: [] }), 'utf8');
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    await mergeWriteWorkspaceConfig((config) => {
      config.projects = [
        { id: 'repo', name: 'Repo', root: repoRoot, addedAt: '', lastOpenedAt: '', source: 'local' },
        { id: 'gone', name: 'Gone', root: missingRoot, addedAt: '', lastOpenedAt: '', source: 'local' },
      ];
    });
    service = new SkillsUpdateService({ homeDir: home, resolveNpx: async () => null });
    app = createApp({ repoRoot, bootProjectId: 'repo', store, manager: {} as RunManager,
      version: 'test', skillsUpdate: service });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.flush();
    if (savedHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = savedHome;
    if (savedAutoUpdate === undefined) delete process.env.XEZ_SKILLS_AUTO_UPDATE;
    else process.env.XEZ_SKILLS_AUTO_UPDATE = savedAutoUpdate;
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns the cached snapshot immediately and schedules a detection-only check', async () => {
    const snapshot = vi.spyOn(service, 'snapshot');
    const check = vi.spyOn(service, 'check');
    const response = await apiRequest(app, '/api/v1/workspace/skills-update?projectId=repo');
    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string }).toMatchObject({ status: 'idle' });
    expect(snapshot).toHaveBeenCalledWith(repoRoot);
    expect(check).toHaveBeenCalledWith(repoRoot);
  });

  it('forces a check using only the registered project root', async () => {
    const check = vi.spyOn(service, 'check');
    const response = await apiRequest(app, '/api/v1/workspace/skills-update/check', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'repo' }),
    });
    expect(response.status).toBe(200);
    expect(check).toHaveBeenCalledWith(repoRoot, true);
  });

  it('rejects executable input and invalid bodies without checking', async () => {
    const check = vi.spyOn(service, 'check');
    for (const body of [{}, { projectId: 'repo', command: 'rm' }, { projectId: 'repo', skills: ['x'] }]) {
      const response = await apiRequest(app, '/api/v1/workspace/skills-update/check', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(check).not.toHaveBeenCalled();
  });

  it('uses the existing unknown and gone project contract', async () => {
    expect((await apiRequest(app, '/api/v1/workspace/skills-update?projectId=unknown')).status).toBe(404);
    expect((await apiRequest(app, '/api/v1/workspace/skills-update?projectId=gone')).status).toBe(409);
    expect((await apiRequest(app, '/api/v1/workspace/skills-update')).status).toBe(400);
  });

  it('applies using only the registered project identity and returns final safe state', async () => {
    const final = { ...service.snapshot(repoRoot), status: 'current' as const, updatedAt: '2026-07-22T00:00:00.000Z' };
    const update = vi.spyOn(service, 'update').mockResolvedValue(final);
    const response = await apiRequest(app, '/api/v1/workspace/skills-update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'repo' }) });
    expect(response.status).toBe(200); expect(update).toHaveBeenCalledWith(repoRoot, true);
    expect(await response.json()).toMatchObject({ status: 'current', autoUpdateEnabled: true, inherited: true });
  });

  it('rejects executable apply input and preserves unknown/gone behavior', async () => {
    const update = vi.spyOn(service, 'update');
    for (const body of [null, {}, { projectId: 'repo', path: '/tmp' }, { projectId: 'repo', names: ['x'] }, { projectId: 'repo', scope: 'global' }, { projectId: 'repo', source: 'evil/repo' }]) {
      expect((await apiRequest(app, '/api/v1/workspace/skills-update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(400);
    }
    for (const [projectId, status] of [['unknown', 404], ['gone', 409]] as const) {
      expect((await apiRequest(app, '/api/v1/workspace/skills-update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId }) })).status).toBe(status);
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('returns 409 and latest safe state when another operation owns mutation', async () => {
    vi.spyOn(service, 'update').mockRejectedValue(new SkillsUpdateConflictError());
    const response = await apiRequest(app, '/api/v1/workspace/skills-update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'repo' }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'another skills update operation is running', state: { status: 'idle', autoUpdateEnabled: true, inherited: true } });
  });

  it('reports inherited and explicit off without disabling manual apply', async () => {
    process.env.XEZ_SKILLS_AUTO_UPDATE = '0';
    let response = await apiRequest(app, '/api/v1/workspace/skills-update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'repo' }) });
    expect(await response.json()).toMatchObject({ autoUpdateEnabled: false, inherited: true, status: 'unavailable' });
    process.env.XEZ_SKILLS_AUTO_UPDATE = '1';
    await mergeWriteWorkspaceConfig((config) => { config.skillsAutoUpdate = false; });
    response = await apiRequest(app, '/api/v1/workspace/skills-update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'repo' }) });
    expect(await response.json()).toMatchObject({ autoUpdateEnabled: false, inherited: false });
  });

  it('carries an empty catalog when the project configures no team skills source', async () => {
    const response = await apiRequest(app, '/api/v1/workspace/skills-update?projectId=repo');
    expect(await response.json()).toMatchObject({ status: 'idle', catalog: [] });
  });

  it('keeps apply behind the origin/CSRF guard', async () => {
    const update = vi.spyOn(service, 'update');
    const response = await app.request('/api/v1/workspace/skills-update/apply', { method: 'POST', headers: { host: '127.0.0.1:4321', origin: 'https://evil.test', 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'repo' }) });
    expect(response.status).toBe(403); expect(update).not.toHaveBeenCalled();
  });
});

/**
 * The skill-catalog version on the wire (#744). Its own block because it pins the SINGLE-PROJECT
 * state layout: that is what puts the bare clone inside a temp folder instead of the machine's
 * shared `~/.cache/xez`, and it is also AC-13 — the mode reads the project-local cache.
 */
describe('workspace skills update API — skill catalog version', () => {
  const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
    GIT_AUTHOR_DATE: '2026-01-02T10:00:00+01:00',
    GIT_COMMITTER_DATE: '2026-01-02T10:00:00+01:00',
  };
  let project: string;
  let origin: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'xez-catalog-route-project-'));
    origin = mkdtempSync(join(tmpdir(), 'xez-catalog-route-origin-'));
    setActiveStateLayout(projectStateLayout(project));
    mkdirSync(join(project, '.local/xezar'), { recursive: true });
    mkdirSync(join(project, '.xezar'), { recursive: true });
    writeFileSync(
      join(project, '.xezar', 'config.json'),
      JSON.stringify({ skillsRepos: [{ repo: origin, ref: 'main' }] }),
      'utf8',
    );
    mkdirSync(join(origin, 'demo'), { recursive: true });
    writeFileSync(join(origin, 'demo', 'SKILL.md'), '# demo\n', 'utf8');
    for (const args of [['init', '-b', 'main'], ['add', '-A'], ['commit', '-m', 'fixture'], ['tag', 'v1.2.3']]) {
      execFileSync(REAL_GIT, args, { cwd: origin, stdio: 'ignore', env: GIT_ENV });
    }
    store = RunStore.open(join(project, '.local/xezar'));
    app = createApp({ repoRoot: project, bootProjectId: 'repo', store, manager: {} as RunManager,
      version: 'test', skillsUpdate: new SkillsUpdateService({ homeDir: project, resolveNpx: async () => null }) });
  });

  afterEach(() => {
    setActiveStateLayout(null);
    store.flush();
    rmSync(project, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  it('answers 200 with an unknown catalog on a cold cache, and the rest of the payload intact (AC-05)', async () => {
    const response = await apiRequest(app, '/api/v1/workspace/skills-update?projectId=default');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.catalog).toEqual([{ repo: origin, ref: 'main', state: 'unknown', fetchedAt: null }]);
    // Not a replacement for the existing payload — the `npx skills` half is untouched.
    expect(body).toMatchObject({ status: 'idle', autoUpdateEnabled: true, inherited: true });
    expect(Array.isArray(body.scopes)).toBe(true);
  });

  it('serves the installed and available version of the project-local clone (AC-01, AC-13)', async () => {
    await ensureBareClone(origin);
    const response = await apiRequest(app, '/api/v1/workspace/skills-update?projectId=default');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { catalog: Array<Record<string, { tag?: string; date?: string }>> };
    expect(body.catalog[0]).toMatchObject({
      state: 'up-to-date',
      installed: { tag: 'v1.2.3', date: '2026-01-02' },
      available: { tag: 'v1.2.3', date: '2026-01-02' },
    });
  });
});
