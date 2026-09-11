import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpDiscoverySchema, type HealthResponse, type McpDiscovery } from '@qodeca/xezar-contract';
import { mergeWriteWorkspaceConfig } from '../../workspace/config.ts';
import { toolListing } from '../tool.ts';
import { bindHostFromArgv, buildDiscovery, discoverProjectTool, type DiscoveryFacts } from './discovery.ts';

// The bound project and one OTHER registered project whose name and id must never surface (N-01).
const BOUND = { id: 'alpha-app', name: 'alpha-app', root: '/work/alpha-app' };
const OTHER = { id: 'zebra-secret-id', name: 'Zebra Secret Project' };

/** A FULL health payload — `projects` and `bootProject` included — so the filter has something to drop. */
function fullHealth(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    version: '9.9.9',
    latestVersion: '10.0.0',
    repoRoot: '/work/boot-somewhere-else',
    repo: { root: BOUND.root, branch: 'main', remote: 'https://github.com/alpha/alpha-app.git' },
    checks: [
      { name: 'claude', available: true, version: '2.1.0 (Claude Code)' },
      { name: 'codex', available: false, hint: 'optional: install the Codex CLI' },
      { name: 'opencode', available: false },
      { name: 'pi', available: false },
      { name: 'gh', available: true, version: 'authenticated' },
      { name: 'git', available: true, version: 'git version 2.50.0' },
    ],
    defaultRunner: 'claude',
    forge: { kind: 'github', available: true },
    capabilities: {
      localHandoff: true,
      followups: true,
      singleProject: false,
      automations: true,
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    },
    projects: [{ id: BOUND.id, name: BOUND.name }, OTHER],
    bootProject: OTHER.id,
    ...overrides,
  };
}

function facts(overrides: { health?: Partial<HealthResponse>; config?: Partial<DiscoveryFacts['config']>; providers?: DiscoveryFacts['providers'] } = {}): DiscoveryFacts {
  return {
    project: BOUND,
    xezarVersion: '9.9.9',
    health: fullHealth(overrides.health),
    config: { baseBranch: 'main', modelsLocked: false, ...overrides.config },
    providers: overrides.providers ?? {
      providers: [
        { provider: 'claude', status: 'connected', enabled: true },
        { provider: 'codex', status: 'not-installed', enabled: true },
        { provider: 'opencode', status: 'not-installed', enabled: true },
        { provider: 'pi', status: 'not-installed', enabled: true },
      ],
    },
    limits: {
      maxParallel: { effective: 3, project: 3, workspace: 2 },
      memoryLimitMb: { effective: 4096, project: null, workspace: 4096 },
      maxMonitoringSessions: 2,
      monitoringWakeIntervalMinutes: 5,
      autoResumeOnUsageLimit: true,
      idleTimeoutMinutes: 15,
      worktreeRetention: 10,
    },
  };
}

const actionOf = (discovery: McpDiscovery, id: McpDiscovery['actions'][number]['id']) =>
  discovery.actions.find((a) => a.id === id)!;

/** Every key at any depth. */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) allKeys(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.add(key);
      allKeys(inner, out);
    }
  }
  return out;
}

describe('discover_project — the filter', () => {
  it('names the bound project and never another one, nor projects / bootProject', () => {
    const discovery = buildDiscovery(facts());
    expect(discovery.project).toEqual({ id: BOUND.id, name: BOUND.name, root: BOUND.root });
    const keys = allKeys(discovery);
    expect(keys.has('projects')).toBe(false);
    expect(keys.has('bootProject')).toBe(false);
    const wire = JSON.stringify(discovery);
    expect(wire).not.toContain(OTHER.id);
    expect(wire).not.toContain(OTHER.name);
    expect(wire).not.toContain('boot-somewhere-else');
    // The remote URL can carry a credential; only the branch crosses.
    expect(wire).not.toContain('github.com/alpha');
    expect(discovery.repository).toEqual({ git: true, branch: 'main' });
  });

  it('the schema itself refuses projects and bootProject, at the top level and nested', () => {
    const valid = buildDiscovery(facts());
    expect(mcpDiscoverySchema.safeParse(valid).success).toBe(true);
    expect(mcpDiscoverySchema.safeParse({ ...valid, projects: [OTHER] }).success).toBe(false);
    expect(mcpDiscoverySchema.safeParse({ ...valid, bootProject: OTHER.id }).success).toBe(false);
    expect(mcpDiscoverySchema.safeParse({ ...valid, project: { ...valid.project, email: 'x@y.z' } }).success).toBe(false);
  });

  it('carries no account identity, email, organisation or plan — even when the inputs do', () => {
    const tainted = facts({
      health: {
        checks: [
          { name: 'claude', available: true, version: '2.1.0 (Claude Code)\njane.doe@example.com Acme Corp Max plan', hint: 'signed in as jane.doe@example.com' },
          { name: 'codex', available: true, version: '1.0.0', hint: 'org: Acme Corp' },
          { name: 'opencode', available: false, hint: 'jane.doe@example.com' },
          { name: 'pi', available: false },
          { name: 'gh', available: false, hint: 'Logged in to github.com account jane-doe (Acme Corp)' },
          { name: 'git', available: true },
        ],
        forge: { kind: 'github', available: false, reason: 'HTTP 403: jane-doe lacks access to acme-corp/secret (plan: enterprise)' },
      },
      providers: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: true, hint: 'jane.doe@example.com · Acme Corp · Max plan', profileId: 'jane-profile', authFailureId: 'fail-1' },
          { provider: 'codex', status: 'disconnected', enabled: true, hint: 'Pro plan for jane.doe@example.com', profileId: 'jane-2' },
          { provider: 'opencode', status: 'not-installed', enabled: false, hint: 'Acme Corp' },
          { provider: 'pi', status: 'unknown', hint: 'jane' },
        ],
      },
    });
    const discovery = buildDiscovery(tainted);
    const wire = JSON.stringify(discovery);
    expect(wire).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // an email address
    expect(wire).not.toMatch(/@/);
    expect(wire).not.toMatch(/jane/i);
    expect(wire).not.toMatch(/acme/i);
    expect(wire).not.toMatch(/\b(max|pro|enterprise)\b/i);
    expect(wire).not.toMatch(/\bplan\b/i);
    const keys = allKeys(discovery);
    for (const key of ['profileId', 'authFailureId', 'hint', 'email', 'account', 'org', 'organization', 'plan']) {
      expect(keys.has(key), key).toBe(false);
    }
    // The tool's text block carries the same result, so it must be clean too.
    expect(wire).not.toContain('Acme');
  });
});

describe('discover_project — unavailable actions carry a reason', () => {
  it('every action that is not available says why', () => {
    const cases = [
      facts(),
      facts({ health: { repo: null, forge: null } }),
      facts({ health: { capabilities: { ...fullHealth().capabilities, localHandoff: false, followups: false, automations: false } } }),
      facts({ config: { modelsLocked: true } }),
    ];
    for (const input of cases) {
      for (const a of buildDiscovery(input).actions) {
        if (a.status !== 'available') expect(a.reason.length, a.id).toBeGreaterThan(10);
      }
    }
  });

  it.each([
    ['gh is missing', { forge: { kind: 'github' as const, available: false, reason: 'gh CLI not found — install it and run `gh auth login`' } }, /not installed/],
    ['gh is not authenticated', { forge: { kind: 'github' as const, available: false, reason: 'To get started with GitHub CLI, please run:  gh auth login' } }, /not signed in/],
    ['there is no GitHub remote', { forge: null }, /no GitHub remote/],
    ['the project is not a git repository', { repo: null, forge: null }, /not a git repository/],
  ])('with forge unavailable because %s, GitHub is reported unavailable with that reason', (_why, health, reason) => {
    const discovery = buildDiscovery(facts({ health }));
    const github = actionOf(discovery, 'github');
    expect(github.status).toBe('unavailable');
    expect(github.status === 'unavailable' && github.reason).toMatch(reason);
    // Automations sit on top of GitHub, so they inherit the same reason rather than vanishing.
    const automations = actionOf(discovery, 'automations');
    expect(automations.status).toBe('unavailable');
    expect(automations.status === 'unavailable' && automations.reason).toMatch(reason);
  });

  it('never forwards gh’s own error text', () => {
    const discovery = buildDiscovery(facts({
      health: { forge: { kind: 'github', available: false, reason: 'GraphQL: Could not resolve to a Repository with the name octo-org/private-thing' } },
    }));
    const github = actionOf(discovery, 'github');
    expect(github.status).toBe('unavailable');
    expect(JSON.stringify(discovery)).not.toContain('octo-org');
  });

  // Found by the #333 mutation sample: flipping `available === true` in `toolCheck` left every test
  // green, because nothing read the `tools` list a leader checks before reaching for gh or git.
  it('reports gh and git as the health checks found them, with a remedy only for the missing one', () => {
    const check = (gh: boolean, git: boolean) =>
      buildDiscovery(
        facts({
          health: {
            checks: [
              { name: 'claude', available: true, version: '2.1.0 (Claude Code)' },
              { name: 'gh', available: gh },
              { name: 'git', available: git },
            ],
          },
        }),
      ).tools;
    expect(check(true, true)).toEqual([
      { name: 'gh', available: true },
      { name: 'git', available: true },
    ]);
    expect(check(false, true)).toEqual([
      { name: 'gh', available: false, reason: expect.stringMatching(/gh auth login/) },
      { name: 'git', available: true },
    ]);
    expect(check(true, false)).toEqual([
      { name: 'gh', available: true },
      { name: 'git', available: false, reason: 'git is not installed on this machine.' },
    ]);
    // A check the health probe never ran is not a pass.
    expect(buildDiscovery(facts({ health: { checks: [] } })).tools.map((t) => t.available)).toEqual([false, false]);
  });

  it('with GitHub reachable, the GitHub area is available', () => {
    expect(actionOf(buildDiscovery(facts()), 'github')).toEqual({ id: 'github', label: expect.any(String), status: 'available' });
  });

  it('reports model selection read-only when models are locked, and available otherwise', () => {
    const locked = buildDiscovery(facts({ config: { modelsLocked: true } }));
    expect(locked.settings.modelsLocked).toBe(true);
    const model = actionOf(locked, 'model_selection');
    expect(model.status).toBe('read-only');
    expect(model.status === 'read-only' && model.reason).toMatch(/locked/i);
    expect(actionOf(buildDiscovery(facts()), 'model_selection').status).toBe('available');
  });

  it('hosted mode closes open-in and agent-config writes, and trims the root like /health', () => {
    const discovery = buildDiscovery(facts({ health: { capabilities: { ...fullHealth().capabilities, localHandoff: false } } }));
    expect(discovery.project.root).toBe('alpha-app');
    for (const id of ['open_in_app', 'agent_config_write'] as const) {
      const a = actionOf(discovery, id);
      expect(a.status, id).toBe('unavailable');
      expect(a.status === 'unavailable' && a.reason, id).toMatch(/hosted mode/);
    }
  });

  it('opt-in features that are off say how to turn them on', () => {
    const discovery = buildDiscovery(facts({ health: { capabilities: { ...fullHealth().capabilities, followups: false, automations: false } } }));
    const inbox = actionOf(discovery, 'inbox');
    const automations = actionOf(discovery, 'automations');
    expect(inbox.status === 'unavailable' && inbox.reason).toMatch(/XEZ_FOLLOWUPS=1/);
    expect(automations.status === 'unavailable' && automations.reason).toMatch(/XEZ_AUTOMATIONS=1/);
  });

  it('without git, variants and the worktree choice are unavailable', () => {
    const discovery = buildDiscovery(facts({ health: { repo: null, forge: null } }));
    expect(discovery.repository).toEqual({ git: false });
    expect(actionOf(discovery, 'parallel_variants').status).toBe('unavailable');
    expect(actionOf(discovery, 'worktree_choice').status).toBe('unavailable');
  });

  it('task creation follows provider readiness: no usable agent means unavailable, with each agent’s reason', () => {
    const none = buildDiscovery(facts({
      providers: {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: false },
          { provider: 'opencode', status: 'not-installed', enabled: true },
          { provider: 'pi', status: 'unknown', enabled: true },
        ],
      },
    }));
    const create = actionOf(none, 'create_task');
    expect(create.status).toBe('unavailable');
    const reason = create.status === 'unavailable' ? create.reason : '';
    expect(reason).toMatch(/Claude Code is installed but not signed in/);
    expect(reason).toMatch(/Codex is disabled/);
    expect(reason).toMatch(/OpenCode is not installed/);
    expect(none.agents.every((a) => !a.usable && a.reason)).toBe(true);

    const ready = buildDiscovery(facts());
    expect(actionOf(ready, 'create_task').status).toBe('available');
    expect(ready.agents.find((a) => a.runner === 'claude')).toMatchObject({ usable: true, installed: true, version: '2.1.0 (Claude Code)' });
  });

  it('workspace limits are reported as a read-only shared constraint, with this project’s own values', () => {
    const discovery = buildDiscovery(facts());
    expect(actionOf(discovery, 'workspace_limits').status).toBe('read-only');
    expect(discovery.limits.maxParallel).toEqual({ effective: 3, project: 3, workspace: 2 });
  });
});

describe('discover_project — the tool', () => {
  const dirs: string[] = [];
  const saved = { home: process.env.XEZ_HOME, dry: process.env.XEZ_DRY_RUN, remote: process.env.XEZ_REMOTE };
  const tempDir = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };

  beforeEach(() => {
    process.env.XEZ_HOME = tempDir('xez-discovery-home-');
    process.env.XEZ_DRY_RUN = '1';
    delete process.env.XEZ_REMOTE;
  });
  afterEach(() => {
    for (const [key, value] of [['XEZ_HOME', saved.home], ['XEZ_DRY_RUN', saved.dry], ['XEZ_REMOTE', saved.remote]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('takes no arguments: a projectId parameter is refused rather than honoured', () => {
    expect(discoverProjectTool.inputSchema.safeParse({}).success).toBe(true);
    expect(discoverProjectTool.inputSchema.safeParse({ projectId: OTHER.id }).success).toBe(false);
    expect(toolListing(discoverProjectTool).inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(discoverProjectTool.annotations?.readOnlyHint).toBe(true);
  });

  it('answers for the bound project from real state, with another project registered beside it', async () => {
    const root = tempDir('xez-discovery-a-');
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    // A branch exists only once it has a commit; `getRepoInfo` reads an unborn HEAD as "no repo".
    execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const otherRoot = tempDir('xez-discovery-b-');
    await mergeWriteWorkspaceConfig((config) => {
      config.projects.push(
        { id: 'proj-a', root, name: 'Project A', addedAt: '', lastOpenedAt: '', source: 'local', maxParallel: 4 },
        { id: OTHER.id, root: otherRoot, name: OTHER.name, addedAt: '', lastOpenedAt: '', source: 'local', maxParallel: 9 },
      );
    });

    const result = await discoverProjectTool.call({}, { project: { id: 'proj-a', name: 'Project A', root }, xezarVersion: '1.2.3' });

    expect(result.isError).toBeUndefined();
    const discovery = mcpDiscoverySchema.parse(result.structuredContent);
    expect(discovery.project).toEqual({ id: 'proj-a', name: 'Project A', root });
    expect(discovery.repository).toEqual({ git: true, branch: 'main' });
    expect(discovery.limits.maxParallel).toMatchObject({ effective: 4, project: 4 });
    // No remote: GitHub is closed, with the reason.
    const github = actionOf(discovery, 'github');
    expect(github.status === 'unavailable' && github.reason).toMatch(/no GitHub remote/);
    // XEZ_DRY_RUN reports every provider connected, so a task can start.
    expect(actionOf(discovery, 'create_task').status).toBe('available');

    const text = result.content[0]!.text;
    expect(text).toContain('Bound to xezar project "Project A" (id proj-a).');
    for (const wire of [text, JSON.stringify(result.structuredContent)]) {
      expect(wire).not.toContain(OTHER.id);
      expect(wire).not.toContain(OTHER.name);
      expect(wire).not.toContain(otherRoot);
      expect(wire).not.toContain('bootProject');
      expect(wire).not.toContain('"projects"');
    }
  }, 60_000);

  it('reads --bind-host from the serving process, in both spellings', () => {
    expect(bindHostFromArgv(['node', 'xezar', 'serve'])).toBeUndefined();
    expect(bindHostFromArgv(['node', 'xezar', '--bind-host', '0.0.0.0'])).toBe('0.0.0.0');
    expect(bindHostFromArgv(['node', 'xezar', 'serve', '--bind-host=10.0.0.5'])).toBe('10.0.0.5');
  });
});
