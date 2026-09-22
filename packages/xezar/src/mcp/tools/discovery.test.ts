// FIRST import on purpose: the home pin is a module-load side effect and must run before anything
// that reaches `skills.ts` (#671) — this file reads the catalog through the issue-filing check.
import './mcp-test-home.testkit.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpDiscoverySchema, type HealthResponse, type McpDiscovery } from '@qodeca/xezar-contract';
import { BUNDLED_TEMPLATES_DIGEST } from '../../onboarding/status.ts';
import { mergeWriteWorkspaceConfig } from '../../workspace/config.ts';
import { globalImportSummary } from '../../workspace/import-global.ts';
import { recordGlobalImportState } from '../../workspace/project-machine-state.ts';
import { projectStateLayout, setActiveStateLayout } from '../../state-layout.ts';
import { recordOwnListen } from '../../server/instance-liveness.ts';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { toolListing } from '../tool.ts';
import { detectEnvironment } from '../../core/backend-detect.ts';
import { providerInstallHint } from '../../core/provider-auth.ts';
import { PROVIDER_INSTALL } from '../../core/provider-install.ts';
import { bindHostFromArgv, buildDiscovery, cockpitLinks, discoverProjectTool, discoveryText, type DiscoveryFacts } from './discovery.ts';

// The bound project and one OTHER registered project whose name and id must never surface (N-01).
const BOUND = { id: 'alpha-app', name: 'alpha-app', root: '/work/alpha-app' };
const OTHER = { id: 'zebra-secret-id', name: 'Zebra Secret Project' };

/** A FULL health payload — `projects` and `bootProject` included — so the filter has something to drop. */
function fullHealth(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    version: '9.9.9',
    latestVersion: '10.0.0',
    channel: 'release',
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

/** The onboarding block of a project nothing has checked yet — the state a fresh fixture is in. */
function neverSetUp(
  overrides: Partial<DiscoveryFacts['onboarding']> = {},
): DiscoveryFacts['onboarding'] {
  return {
    state: 'never',
    provenance: 'unknown',
    available: true,
    unavailableReason: null,
    localHandoff: true,
    offerPending: false,
    dismissed: false,
    observed: { engineVersion: '9.9.9', kitDigest: '2c20c60' },
    lastOffered: null,
    lastChecked: null,
    checkingRunId: null,
    launch: { workflowId: 'project-setup', modes: ['setup', 'preview', 'recheck'] },
    issueFiling: { status: 'available', reason: null, skill: 'xez-issue-create' },
    ...overrides,
  };
}

function facts(
  overrides: {
    health?: Partial<HealthResponse>;
    config?: Partial<DiscoveryFacts['config']>;
    providers?: DiscoveryFacts['providers'];
    onboarding?: Partial<DiscoveryFacts['onboarding']>;
  } = {},
): DiscoveryFacts {
  return {
    project: BOUND,
    xezarVersion: '9.9.9',
    onboarding: neverSetUp(overrides.onboarding),
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

describe('discover_project — the global-import state (#819 PR 5)', () => {
  // Break: the onboarding block rebuilt from a wider object — a list of names beside the count
  // would ride along to the model.
  it('carries the state and the count and drops anything else put beside them', () => {
    const discovery = buildDiscovery(
      facts({ onboarding: { globalImport: { state: 'declined', importable: 1, ids: ['secret-id'] } as never } }),
    );
    expect(discovery.onboarding.globalImport).toEqual({ state: 'declined', importable: 1 });
    expect(JSON.stringify(discovery)).not.toContain('secret-id');
    expect(discoveryText(discovery)).toContain(
      'Agent accounts: a person declined to copy the machine-wide accounts into this project; 1 account of the machine-wide setup is not in this project.',
    );
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
    // Review round 1 (F3). Break: a not-installed reason that names no way to install the agent.
    expect(reason).toContain('OpenCode is not installed on this machine. Install OpenCode (from https://opencode.ai), then run `opencode auth login`.');
    // Review round 1 (F4). Break: with no address, telling the person to start a cockpit — this
    // fallback is reached only in hosted mode, where one is already running.
    expect(reason).toContain('Settings → Agents → Providers in the running cockpit (no address is recorded here)');
    expect(none.agents.every((a) => !a.usable && a.reason)).toBe(true);

    const ready = buildDiscovery(facts());
    expect(actionOf(ready, 'create_task').status).toBe('available');
    expect(ready.agents.find((a) => a.runner === 'claude')).toMatchObject({ usable: true, installed: true, version: '2.1.0 (Claude Code)' });
  });

  // #677 wave 2 slice B1: the row was `read-only` until the owner's 2026-09-20 rule made the
  // workspace settings writable through `project_config set_workspace_config`. A leader reads
  // this answer first, so a stale `read-only` here is a false "you cannot".
  it('workspace limits are reported as an available action, with this project’s own values', () => {
    const discovery = buildDiscovery(facts());
    expect(actionOf(discovery, 'workspace_limits')).toEqual({
      id: 'workspace_limits',
      label: 'Change workspace-wide limits',
      status: 'available',
    });
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

  /** A project root whose config switches team skills off: the issue-filing check (#468) reads the
   *  skill catalog, and no background clone may reach the network from a unit test. */
  const projectDir = (prefix: string) => {
    const dir = tempDir(prefix);
    mkdirSync(join(dir, '.xezar'), { recursive: true });
    writeFileSync(join(dir, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
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
    const root = projectDir('xez-discovery-a-');
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

  it('carries the project setup block, and reads it off the real record', async () => {
    // UI ↔ MCP parity (owner rule, 2026-09-16) and `AC-17`: a leader and a person looking at the
    // same project must not be told different things about whether a check happened.
    const root = projectDir('xez-discovery-onboarding-');
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
    mkdirSync(join(root, '.local/xezar'), { recursive: true });
    writeFileSync(
      join(root, '.local/xezar/onboarding-state.json'),
      JSON.stringify({
        engineVersion: '1.2.3',
        kitDigest: BUNDLED_TEMPLATES_DIGEST,
        lastOfferedAt: null,
        lastCheckedAt: null,
        checked: { engineVersion: '1.0.0', kitDigest: BUNDLED_TEMPLATES_DIGEST, at: '2026-09-02T16:40:00.000Z' },
      }),
      'utf8',
    );

    const result = await discoverProjectTool.call({}, { project: { id: 'proj-a', name: 'Project A', root }, xezarVersion: '1.2.3' });
    const discovery = mcpDiscoverySchema.parse(result.structuredContent);

    expect(discovery.onboarding).toMatchObject({
      state: 'changed',
      provenance: 'recorded',
      offerPending: true,
      observed: { engineVersion: '1.2.3', kitDigest: BUNDLED_TEMPLATES_DIGEST },
      lastChecked: { engineVersion: '1.0.0', at: '2026-09-02T16:40:00.000Z' },
      launch: { workflowId: 'project-setup', modes: ['setup', 'preview', 'recheck'] },
    });
    // The text block is what a model actually reads (D-05), and it must state the fact without
    // turning it into an instruction to spend a task.
    const text = result.content[0]!.text;
    expect(text).toContain('Setup: the last finished check covered xezar 1.0.0');
    expect(text).not.toMatch(/you should re-check/i);
    // Issue filing (#468) rides in the same block the cockpit reads: a repository with no remote
    // is closed — with the reason, never an error.
    expect(discovery.onboarding.issueFiling).toMatchObject({ status: 'unavailable', skill: 'xez-issue-create' });
    expect(discovery.onboarding.issueFiling.reason).toMatch(/has no remote/);
    expect(text).toContain('Issue filing: not available: ');
  }, 60_000);

  /**
   * #819 PR 5, P5-AC4 — `onboarding.globalImport` is the persisted outcome and the count, read by
   * the listing's own reader. Break: the key missing from discovery (the 0.17.0 answer), or a
   * second reader that folds `not-asked` into `declined` or lists the machine-wide accounts.
   */
  describe('the global-import state (#819 PR 5)', () => {
    afterEach(() => setActiveStateLayout(null));
    const MACHINE_ACCOUNTS = {
      accounts: [
        { id: 'pr5-work', provider: 'claude', configDir: '~/.claude-pr5-work', label: 'someone@example.com' },
        { id: 'pr5-team', provider: 'codex', configDir: '~/.codex-pr5-team', label: 'Team' },
      ],
    };
    const call = async (root: string) => {
      const result = await discoverProjectTool.call({}, { project: { id: 'proj-a', name: 'Project A', root }, xezarVersion: '1.2.3' });
      return { discovery: mcpDiscoverySchema.parse(result.structuredContent), text: result.content[0]!.text, wire: JSON.stringify(result) };
    };

    it('P5-AC4: equals the persisted outcome and the count, and names no account', async () => {
      const root = projectDir('xez-discovery-import-');
      writeFileSync(join(process.env.XEZ_HOME!, 'agent-accounts.json'), JSON.stringify(MACHINE_ACCOUNTS), 'utf8');
      const layout = projectStateLayout(root);
      setActiveStateLayout(layout);

      // Nothing recorded: `unknown`, never a "no".
      let answer = await call(root);
      expect(answer.discovery.onboarding.globalImport).toEqual({ state: 'unknown', importable: 2 });
      expect(answer.text).toContain('Agent accounts: nothing records whether the machine-wide accounts were copied into this project; 2 accounts');

      await recordGlobalImportState('declined', layout);
      answer = await call(root);
      expect(answer.discovery.onboarding.globalImport).toEqual({ state: 'declined', importable: 2 });
      expect(answer.discovery.onboarding.globalImport).toEqual(globalImportSummary(layout));

      await recordGlobalImportState('imported', layout);
      answer = await call(root);
      expect(answer.discovery.onboarding.globalImport).toEqual({ state: 'done', importable: 2 });
      expect(answer.text).toContain('Agent accounts: the machine-wide accounts were copied into this project; 2 accounts');
      for (const secret of ['pr5-work', 'pr5-team', 'someone@example.com', 'claude-pr5', 'codex-pr5', 'Team']) {
        expect(answer.wire, secret).not.toContain(secret);
      }
    }, 60_000);

    it('reads an unreadable machine-wide file as 0, never an error', async () => {
      const root = projectDir('xez-discovery-import-bad-');
      writeFileSync(join(process.env.XEZ_HOME!, 'agent-accounts.json'), '{ not json', 'utf8');
      setActiveStateLayout(projectStateLayout(root));
      const answer = await call(root);
      expect(answer.discovery.onboarding.globalImport).toEqual({ state: 'unknown', importable: 0 });
      expect(answer.text).toContain('0 accounts of the machine-wide setup are not in this project');
    }, 60_000);

    // P5-AC5 and the global layout. Break: the count served where the global home must not be
    // read (hosted) or where there is nothing to import into (the global layout).
    it('is absent in the global layout and in hosted mode', async () => {
      const root = projectDir('xez-discovery-import-absent-');
      writeFileSync(join(process.env.XEZ_HOME!, 'agent-accounts.json'), JSON.stringify(MACHINE_ACCOUNTS), 'utf8');
      let answer = await call(root);
      expect(answer.discovery.onboarding).not.toHaveProperty('globalImport');
      expect(answer.text).not.toContain('Agent accounts:');
      setActiveStateLayout(projectStateLayout(root));
      process.env.XEZ_REMOTE = '1';
      answer = await call(root);
      expect(answer.discovery.capabilities.localHandoff).toBe(false);
      expect(answer.discovery.onboarding).not.toHaveProperty('globalImport');
    }, 60_000);
  });

  it('states the issue-filing fact in the text block, for both answers', () => {
    const open = discoveryText(buildDiscovery(facts()));
    expect(open).toContain('Issue filing: available (skill xez-issue-create).');
    const closed = discoveryText(
      buildDiscovery(
        facts({
          onboarding: {
            issueFiling: {
              status: 'unavailable',
              reason: 'Not available: The GitHub CLI (gh) is not signed in. A person can run `gh auth login`.',
              skill: 'xez-issue-create',
            },
          },
        }),
      ),
    );
    expect(closed).toContain('Issue filing: not available: The GitHub CLI (gh) is not signed in.');
    expect(closed).not.toContain('Issue filing: available');
  });

  it('reads --bind-host from the serving process, in both spellings', () => {
    expect(bindHostFromArgv(['node', 'xezar', 'serve'])).toBeUndefined();
    expect(bindHostFromArgv(['node', 'xezar', '--bind-host', '0.0.0.0'])).toBe('0.0.0.0');
    expect(bindHostFromArgv(['node', 'xezar', 'serve', '--bind-host=10.0.0.5'])).toBe('10.0.0.5');
    // An empty value is the flag being absent, as it is for the CLI (#838 item A).
    expect(bindHostFromArgv(['node', 'xezar', 'serve', '--bind-host', ''])).toBeUndefined();
    expect(bindHostFromArgv(['node', 'xezar', 'serve', '--bind-host='])).toBeUndefined();
  });

  it('resolves a repeated --bind-host the same way the CLI itself does: last-wins (#838 item H)', () => {
    // Before the fix this reader was a hand-written FIRST-match scanner while `index.ts`'s own
    // `parseArgs` call is last-wins, so the running server bound one host and this told an MCP
    // caller a different one for the exact same argv. `parseArgs` here (independently, with only
    // `bind-host` declared) is the reference for "what index.ts's parse would answer" — the two
    // agreeing on an ad hoc option table is the property under test, not a hardcoded literal.
    const argv = ['node', 'xezar', 'serve', '--bind-host', '10.0.0.1', '--bind-host', '10.0.0.2'];
    const { values } = parseArgs({ args: argv, options: { 'bind-host': { type: 'string' } }, allowPositionals: true, strict: false });
    expect(bindHostFromArgv(argv)).toBe(values['bind-host']);
    expect(bindHostFromArgv(argv)).toBe('10.0.0.2');

    // Both spellings, repeated.
    expect(bindHostFromArgv(['node', 'xezar', '--bind-host=10.0.0.1', '--bind-host=10.0.0.2'])).toBe('10.0.0.2');
    expect(bindHostFromArgv(['node', 'xezar', '--bind-host', '10.0.0.1', '--bind-host=10.0.0.2'])).toBe('10.0.0.2');

    // A repeated flag ending on an empty value still reads as absent, exactly like a single one (#838 item A).
    expect(bindHostFromArgv(['node', 'xezar', '--bind-host', '10.0.0.1', '--bind-host', ''])).toBeUndefined();
  });
});


/**
 * #819 item 8 — `discover_project.cockpit`: where the PERSON opens this cockpit, so a leader hands
 * them a link instead of a page name. The URL is the running server's REAL listen origin, and the
 * block is ABSENT when that is unknown. Each case names the break it fails against.
 */
describe('discover_project — the cockpit address (#819 item 8)', () => {
  const dirs: string[] = [];
  const servers: HttpServer[] = [];
  const saved = { home: process.env.XEZ_HOME, dry: process.env.XEZ_DRY_RUN, remote: process.env.XEZ_REMOTE };
  beforeEach(() => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'xez-discovery-cockpit-home-')));
    dirs.push(home);
    process.env.XEZ_HOME = home;
    process.env.XEZ_DRY_RUN = '1';
    delete process.env.XEZ_REMOTE;
  });
  afterEach(async () => {
    recordOwnListen(null, true);
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of [['XEZ_HOME', saved.home], ['XEZ_DRY_RUN', saved.dry], ['XEZ_REMOTE', saved.remote]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  async function discover(): Promise<{ discovery: McpDiscovery; text: string }> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'xez-discovery-cockpit-')));
    dirs.push(root);
    mkdirSync(join(root, '.xezar'), { recursive: true });
    writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    const result = await discoverProjectTool.call({}, { project: { id: 'proj a', name: 'Project A', root }, xezarVersion: '1.2.3' });
    return { discovery: mcpDiscoverySchema.parse(result.structuredContent), text: result.content[0]!.text };
  }
  async function listening(): Promise<{ server: HttpServer; port: number }> {
    const server = createHttpServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: (server.address() as { port: number }).port };
  }

  // Break: the MCP layer's in-process base (`http://127.0.0.1`, no port) or a requested port leaking
  // into the answer instead of the port the OS really handed out.
  it('equals the real listen origin of a socket listening on a random port', async () => {
    const { server, port } = await listening();
    recordOwnListen(server, true);
    const { discovery, text } = await discover();
    const origin = `http://127.0.0.1:${port}`;
    expect(discovery.cockpit).toEqual({
      url: `${origin}/p/proj%20a/`,
      pages: {
        providers: `${origin}/p/proj%20a/settings/agents#providers`,
        accounts: `${origin}/settings/global/accounts`,
        mcpConnection: `${origin}/p/proj%20a/settings/mcp-connection`,
      },
    });
    expect(text).toContain(`Cockpit: ${origin}/p/proj%20a/ — the address to give the person`);
  });

  // Break: a made-up loopback URL when nothing recorded a listen.
  it('is absent when no address was recorded', async () => {
    const { discovery, text } = await discover();
    expect(discovery).not.toHaveProperty('cockpit');
    expect(text).not.toMatch(/https?:\/\//);
  });

  // Break: a hosted cockpit handing out a loopback link nobody's browser can open.
  it('is absent in hosted mode, even with an address recorded', async () => {
    const { server } = await listening();
    recordOwnListen(server, true);
    process.env.XEZ_REMOTE = '1';
    const { discovery } = await discover();
    expect(discovery).not.toHaveProperty('cockpit');
  });

  // Break: recording a hosted listen at all.
  it('records nothing when the listen is not on the host', async () => {
    const { server } = await listening();
    expect(recordOwnListen(server, false)).toBeNull();
    expect((await discover()).discovery).not.toHaveProperty('cockpit');
  });
});

/**
 * #838 E1, E2 and E5 — what `discover_project` tells a leader about reaching the person's cockpit
 * and about installing an agent. Each case names the break it fails against.
 */
const RUNNERS_ALL = ['claude', 'codex', 'opencode', 'pi'] as const;
const BIN_VARS = ['XEZ_CLAUDE_BIN', 'XEZ_CODEX_BIN', 'XEZ_OPENCODE_BIN', 'XEZ_PI_BIN'] as const;
const PROBE_VARS = [...BIN_VARS, 'XEZ_DRY_RUN'] as const;

describe('discover_project — links, description and install text (#838)', () => {
  // E1. Break: the Providers link without the card's anchor, landing the person at the top of the
  // Agents page instead of on the Providers card every cockpit link already points at.
  it('links the Providers page to the Providers card itself', () => {
    const links = cockpitLinks('p', 'http://127.0.0.1:4321');
    expect(links?.pages.providers).toBe('http://127.0.0.1:4321/p/p/settings/agents#providers');
    expect(links?.pages.providers.endsWith('/settings/agents#providers')).toBe(true);
  });

  // E2. Break: a description that never names the field, so a leader learning the tools from their
  // descriptions does not know the address is there, or expects it in hosted mode.
  it('names the cockpit field in its description, and says it is absent in hosted mode', () => {
    expect(discoverProjectTool.description).toMatch(/\bcockpit\b: the address of this cockpit/);
    expect(discoverProjectTool.description).toContain('absent in hosted mode');
  });

  // E5. Break: a not-installed reason naming a login but no way to install, or a second copy of
  // the install text that has drifted from the health checks' copy.
  it.each([
    ['claude', 'Claude Code', '`npm i -g @anthropic-ai/claude-code`'],
    ['codex', 'Codex', '`npm i -g @openai/codex`'],
    ['opencode', 'OpenCode', 'from https://opencode.ai'],
  ] as const)('names the install command or page for %s when it is not installed', (runner, label, how) => {
    const discovery = buildDiscovery(facts({
      providers: { providers: RUNNERS_ALL.map((provider) => ({ provider, status: provider === runner ? 'not-installed' : 'connected', enabled: true })) },
    }));
    const agent = discovery.agents.find((a) => a.runner === runner)!;
    expect(agent.reason).toContain(`${label} is not installed on this machine.`);
    expect(agent.reason).toContain(how);
    const install = PROVIDER_INSTALL[runner]!;
    expect(agent.reason).toContain(install.value);
  });

  it('says plainly that no install command is known for pi, rather than leaving it blank or inventing one', () => {
    expect(PROVIDER_INSTALL.pi).toBeNull();
    const discovery = buildDiscovery(facts());
    const reason = discovery.agents.find((a) => a.runner === 'pi')!.reason!;
    expect(reason).toContain('pi is not installed on this machine.');
    expect(reason).toContain('xezar knows no install command for it');
    expect(reason).not.toMatch(/npm i|https?:\/\//);
  });

  // E5. Break: two sources of install text. The health checks' hints must carry exactly the
  // command or page the sign-in rows carry, both read from the one table.
  it('gives the health checks the same install text the sign-in rows use', async () => {
    const saved = Object.fromEntries(PROBE_VARS.map((key) => [key, process.env[key]]));
    // Every CLI missing, so every health check takes its not-installed branch.
    delete process.env.XEZ_DRY_RUN;
    for (const key of BIN_VARS) process.env[key] = '/nonexistent/xez-838-no-such-cli';
    try {
      const checks = await detectEnvironment();
      for (const runner of RUNNERS_ALL) {
        const hint = checks.find((c) => c.name === runner)?.hint ?? '';
        const install = PROVIDER_INSTALL[runner];
        if (install) expect(hint, runner).toContain(`(${install.value})`);
        else expect(hint, runner).not.toContain('(');
        expect(providerInstallHint(runner), runner).toContain(install ? install.value : 'xezar knows no install command');
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
