/**
 * Test-only (`.testkit.ts`): the shared fixture of the `project_config` tool suites
 * (`project-config*.test.ts`). It never ships in `dist`, and `test:coverage:mcp` excludes it.
 *
 * It imports `mcp-test-home.testkit.ts` FIRST, and every suite that uses it must import that
 * module first as well: the home pin is a module-load side effect and must run before anything
 * that reaches `skills.ts` (#671).
 */
import './mcp-test-home.testkit.ts';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import { onWindows, TEST_DIR_RM_OPTIONS } from '../../../test/helpers/platform.ts';
import { CONFIG_FILES } from '../../agent-config/catalog.ts';
import { RunStore } from '../../runs/store.ts';
import { ProjectContexts, type ProjectContextSource } from '../../server/project-context.ts';
import { PROVIDER_IDS, ProviderAuthService, type ProviderId, type ProviderStatusResponse } from '../../core/provider-auth.ts';
import { connectedProviderAuth } from '../../server/provider-auth.testkit.ts';
import { createApp } from '../../server/server.ts';
import { __settleTeamSkillsLoadsForTests } from '../../skills-remote.ts';
import type { SkillsUpdateService } from '../../skills-update.ts';
import type { RunManager } from '../../workflows/run.ts';
import { mergeWriteWorkspaceConfig } from '../../workspace/config.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import type { ServiceDispatch } from '../service-adapter.ts';
import type { McpToolResult } from '../tool.ts';
import { withOperationId } from './operation-id.testkit.ts';
import { taskCreateTool, type TaskCreateContext } from './task-create.ts';
import { versionForTest } from './version.testkit.ts';
import { projectConfigTool, type ProjectConfigContext } from './project-config.ts';

/**
 * Project configuration tools (#97) — the project-settings security boundary.
 *
 * The end-to-end cases drive the real app `createApp` builds, with real `ProjectContexts`, stores
 * and a real two-project registry in a sandboxed `XEZ_HOME`. `HOME` and every agent's home
 * variable point at temp folders seeded with an account identity (an email, an organisation and a
 * plan), user-scope config files and an MCP token, so every "discloses nothing" assertion is made
 * against data that really is there — and a control test proves the cockpit's own identity route
 * does serve it.
 */

export const COCKPIT_HOST = '127.0.0.1:4321';

export const EMAIL_CLAUDE = 'leader.identity@globex-secret.example';
export const EMAIL_CODEX = 'codex.person@initech-secret.example';
export const EMAIL_LABEL = 'boss@umbrella-secret.example';
export const ORG = 'Globex Secret Organisation';
export const PLAN_CLAUDE = 'max-secret-seat-tier';
export const PLAN_CODEX = 'enterprise-secret-plan';
export const USER_MARKER = 'USER-SCOPE-MARKER-7f3a';
export const MCP_SECRET = 'ghp_MCPSECRETVALUE0123456789';
/** The incident id a leader must never be handed, and never needs to name. */
export const INCIDENT_ID = 'incident-7c21-SECRET-ID';
export const IDENTITY_MARKERS = [EMAIL_CLAUDE, EMAIL_CODEX, EMAIL_LABEL, ORG, PLAN_CLAUDE, PLAN_CODEX];
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/;

export const USER_SCOPE_IDS = CONFIG_FILES.filter((f) => f.scope === 'user').map((f) => f.id);
export const PROJECT_SCOPE_IDS = CONFIG_FILES.filter((f) => f.scope !== 'user').map((f) => f.id);

export interface Workspace {
  app: ReturnType<typeof createApp>;
  roots: { a: string; b: string };
  home: string;
  agentHomes: { claude: string; codex: string; qwen: string };
  skillsUpdateCalls: string[];
}

export const tempDirs: string[] = [];
/** Every store a fixture opens, closed in teardown BEFORE its directory goes. */
export const stores: RunStore[] = [];
export const openStore = (dataDir: string): RunStore => {
  const store = RunStore.open(dataDir, { keepLive: true });
  stores.push(store);
  return store;
};
export const makeDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};

export const makeRoot = (prefix: string): string => {
  const root = makeDir(prefix);
  mkdirSync(join(root, '.xezar'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
  return root;
};

export const ENV_KEYS = [
  'HOME',
  'XEZ_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'QWEN_HOME',
  'XEZ_REMOTE',
  'XEZ_AUTOMATIONS',
  'XEZ_SINGLE_PROJECT',
  'XEZ_DRY_RUN',
] as const;
export const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

export const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A home with a real identity in it: Claude's `.claude.json` and Codex's `auth.json`. */
export function seedAgentHomes(home: string) {
  const claude = join(home, '.claude');
  const codex = join(home, '.codex');
  // Qwen Code's whole home, PINNED. Unpinned, `agentHomePaths()` answers the developer's real
  // `~/.qwen` — and the user-scope case below deletes the file it resolved, so an unpinned run
  // would delete a real `~/.qwen/settings.json`. It is also what makes the leak assertions mean
  // anything: the marker has to be in a file this fixture wrote.
  const qwen = join(home, '.qwen');
  for (const dir of [claude, codex, qwen]) mkdirSync(dir, { recursive: true });
  const oauth = {
    oauthAccount: {
      emailAddress: EMAIL_CLAUDE,
      displayName: 'Hidden Person',
      organizationName: ORG,
      organizationRole: 'admin',
      seatTier: PLAN_CLAUDE,
      billingType: 'stripe_subscription',
    },
    mcpServers: { 'home-server': { command: 'home-cmd' } },
  };
  // Inside the overridden dir AND beside it, so the identity is found whichever rule applies.
  writeFileSync(join(claude, '.claude.json'), JSON.stringify(oauth), 'utf8');
  writeFileSync(join(home, '.claude.json'), JSON.stringify(oauth), 'utf8');
  const idToken = `${b64url({ alg: 'none' })}.${b64url({
    email: EMAIL_CODEX,
    name: 'Codex Person',
    'https://api.openai.com/auth': { chatgpt_plan_type: PLAN_CODEX },
  })}.sig`;
  writeFileSync(join(codex, 'auth.json'), JSON.stringify({ tokens: { id_token: idToken } }), 'utf8');
  // The user-scope files, each carrying the marker a leak would reveal. No model key: the
  // project's model presets must stay writable.
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ env: { NOTE: USER_MARKER } }), 'utf8');
  writeFileSync(join(claude, 'CLAUDE.md'), `# ${USER_MARKER}\n`, 'utf8');
  writeFileSync(join(codex, 'config.toml'), `# ${USER_MARKER}\n`, 'utf8');
  writeFileSync(join(codex, 'AGENTS.md'), `${USER_MARKER}\n`, 'utf8');
  writeFileSync(join(qwen, 'settings.json'), JSON.stringify({ ui: { theme: USER_MARKER } }), 'utf8');
  return { claude, codex, qwen };
}

export async function setup(): Promise<Workspace> {
  const home = makeDir('xez-pc-home-');
  process.env.HOME = home;
  // Outside HOME: the sandbox guard treats `$HOME/.xezar` as the real xezar home.
  process.env.XEZ_HOME = makeDir('xez-pc-xezar-home-');
  const agentHomes = seedAgentHomes(home);
  process.env.CLAUDE_CONFIG_DIR = agentHomes.claude;
  process.env.CODEX_HOME = agentHomes.codex;
  process.env.QWEN_HOME = agentHomes.qwen;
  process.env.XEZ_DRY_RUN = '1';
  delete process.env.XEZ_REMOTE;
  delete process.env.XEZ_AUTOMATIONS;
  delete process.env.XEZ_SINGLE_PROJECT;

  const boot = makeRoot('xez-pc-boot-');
  const roots = { a: makeRoot('xez-pc-a-'), b: makeRoot('xez-pc-b-') };
  const now = new Date().toISOString();
  await mergeWriteWorkspaceConfig((config) => {
    config.projects.push(
      { id: 'proj-a', root: roots.a, name: 'Project A', addedAt: now, lastOpenedAt: now, source: 'local' },
      { id: 'proj-b', root: roots.b, name: 'Project B', addedAt: now, lastOpenedAt: now, source: 'local' },
    );
  });
  const projects: ProjectContextSource[] = [
    { id: 'proj-a', root: roots.a, status: 'ok' },
    { id: 'proj-b', root: roots.b, status: 'ok' },
  ];
  const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2 }, load: async () => ({ maxParallel: 2, memoryLimitMb: null }) });
  const contexts = new ProjectContexts({ listProjects: async () => projects, semaphore });
  const skillsUpdateCalls: string[] = [];
  const scopeState = (scope: 'project' | 'global', skills: string[]) => ({
    scope,
    status: 'available' as const,
    available: true,
    skills,
    checkedAt: now,
    updatedAt: null,
    reason: `checked ${scope} install`,
  });
  const skillsUpdate = {
    snapshot: () => ({}),
    check: async (root: string) => {
      skillsUpdateCalls.push(root);
      return {
        status: 'available',
        available: true,
        autoUpdateEnabled: true,
        inherited: true,
        checkedAt: now,
        updatedAt: null,
        needsUpgradeNotes: false,
        scopes: [scopeState('project', ['project-skill']), scopeState('global', ['global-only-skill'])],
      };
    },
  } as unknown as SkillsUpdateService;
  const app = createApp({
    repoRoot: boot,
    store: openStore(join(boot, '.local/xezar')),
    manager: { isActive: () => false } as unknown as RunManager,
    version: '0.0.0-test',
    bootProjectId: 'boot',
    contexts,
    semaphore,
    providerAuth: connectedProviderAuth(),
    skillsUpdate,
  });
  return { app, roots, home, agentHomes, skillsUpdateCalls };
}

export let ws: Workspace;

/**
 * Registers the per-case workspace: a fresh sandboxed two-project registry before each case, and
 * the environment, stores and folders restored and removed after it. Call it once at the top level
 * of every file that reads `ws`.
 */
export function useProjectConfigWorkspace(): void {
  beforeEach(async () => {
    ws = await setup();
  });

  afterEach(async () => {
    // First, while every folder and the case's own HOME still exist: let each background
    // team-skills load the case started finish reading them. One that reads after the removal below
    // finds no `.xezar/config.json`, falls back to the default source and clones it from the
    // network into the NEXT case's HOME, where it raced that case's cleanup (`ENOTEMPTY` on
    // `.cache/xez/skills/qodeca__xezar-skills`, CI run 39239763879).
    await __settleTeamSkillsLoadsForTests();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    for (const store of stores.splice(0)) store.close();
    // A loaded runner can still hold a folder for a moment: retry for about 9 s, or about 25 s on
    // Windows – each inside its hook limit (#963).
    for (const dir of tempDirs.splice(0)) rmSync(dir, { ...TEST_DIR_RM_OPTIONS, maxRetries: onWindows ? 22 : 13, retryDelay: 100 });
  });
}

/** The cockpit's own request: same-origin, from the loopback deployment a browser talks to. */
export async function cockpit(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  const res = await ws.app.request(path, {
    method,
    headers: {
      host: COCKPIT_HOST,
      origin: `http://${COCKPIT_HOST}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

/** A service that records every request the tool dispatches. */
export function spyService(): ServiceDispatch & { requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    request(url: string, init?: RequestInit) {
      requests.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      return ws.app.request(url, init);
    },
  };
}

export interface Called {
  result: McpToolResult;
  text: string;
  structured: any;
  json: string;
}

/** Call the tool exactly as the service does: validate, then call with the bound context. */
export async function invoke(
  args: Record<string, unknown>,
  opts: { project?: 'a' | 'b'; service?: ServiceDispatch | null } = {},
): Promise<Called> {
  const which = opts.project ?? 'a';
  // A leader reads a task right before it removes its worktree (#250); the read goes to the real
  // app, never through a spy service.
  if (args.action === 'remove_worktree' && !('expectedVersion' in args)) {
    args = { ...args, expectedVersion: await versionForTest(ws.app, `proj-${which}`, args.runId) };
  }
  const ctx: ProjectConfigContext = {
    project: { id: `proj-${which}`, name: `Project ${which.toUpperCase()}`, root: ws.roots[which] },
    xezarVersion: '0.0.0-test',
    ...(opts.service === null ? {} : { service: opts.service ?? ws.app }),
  };
  // Every action that changes something takes an operation key (#264); one fresh key per call, so
  // two calls in a case are never one operation.
  const parsed = projectConfigTool.inputSchema.safeParse(withOperationId(projectConfigTool, args));
  const result: McpToolResult = parsed.success
    ? await projectConfigTool.call(parsed.data, ctx)
    : { content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
  const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
  return { result, text, structured: result.structuredContent, json: JSON.stringify(result) };
}

export const value = (called: Called) => {
  expect(called.result.isError, called.text).toBeFalsy();
  return called.structured.result;
};

/**
 * `task_create` against the ALREADY-RUNNING fixture service, with `POST /runs` captured instead of
 * served: the body is what the composer's own run-mode resolution decided, and no run is started.
 * This is how the workspace `composerDefaults` are observed through their consumer (review m4).
 */
export async function startViaTaskCreate(operationId: string, prompt: string): Promise<{ result: McpToolResult; text: string; body: any }> {
  let body: unknown;
  const service: ServiceDispatch = {
    request(url: string, init?: RequestInit) {
      const path = new URL(url).pathname;
      if ((init?.method ?? 'GET') === 'POST' && path.endsWith('/runs')) {
        body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'stubbed-run', status: 'queued' }), { status: 201, headers: { 'content-type': 'application/json' } }),
        );
      }
      return ws.app.request(url, init);
    },
  };
  const parsed = taskCreateTool.inputSchema.safeParse({ action: 'start', operationId, prompt });
  if (!parsed.success) throw new Error(`task_create arguments rejected: ${parsed.error.message}`);
  const result: McpToolResult = await taskCreateTool.call(parsed.data, {
    project: { id: 'proj-a', name: 'Project A', root: ws.roots.a },
    xezarVersion: '0.0.0-test',
    service,
  } as TaskCreateContext);
  return { result, text: result.content.map((c) => ('text' in c ? c.text : '')).join('\n'), body };
}

/** Every file under `dir` (runtime state and git excluded), relative, with a content hash. */
export function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const rel = relative(dir, path);
      if (rel === '.local' || rel === '.git') continue;
      if (entry.isDirectory()) walk(path);
      else if (statSync(path).isFile()) files[rel] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(dir);
  return files;
}

/** A second cockpit over the same workspace home, with a semaphore that really loads.
 *  `bindHost: '0.0.0.0'` builds the same cockpit in HOSTED mode (`localHandoff: false`). */
export function hotCockpit(bindHost?: string, providerAuth?: ProviderAuthService): { app: ReturnType<typeof createApp>; semaphore: WorkspaceSemaphore } {
  const semaphore = new WorkspaceSemaphore();
  const projects: ProjectContextSource[] = [
    { id: 'proj-a', root: ws.roots.a, status: 'ok' },
    { id: 'proj-b', root: ws.roots.b, status: 'ok' },
  ];
  const app = createApp({
    repoRoot: ws.roots.a,
    store: openStore(join(ws.roots.a, '.local/xezar')),
    manager: { isActive: () => false } as unknown as RunManager,
    version: '0.0.0-test',
    bootProjectId: 'proj-a',
    contexts: new ProjectContexts({ listProjects: async () => projects, semaphore }),
    semaphore,
    providerAuth: providerAuth ?? connectedProviderAuth(),
    ...(bindHost === undefined ? {} : { bindHost }),
  });
  return { app, semaphore };
}

/**
 * A provider auth service with one RUNTIME authentication incident on `claude` (#677 B4).
 *
 * The real `ProviderAuthService.reportRuntimeAuthFailure` returns null under `XEZ_DRY_RUN=1`,
 * which this whole fixture sets, so the incident is stated here instead: the row carries an
 * `authFailureId` exactly as `withRuntimeFailures` would stamp one in, and `clearRuntimeAuthFailure`
 * keeps the real rule — it accepts ONLY the id the caller observed, so a stale retry is refused
 * with the route's own 409.
 */
export class IncidentProviderAuth extends ProviderAuthService {
  /** The incident the status answer carries; `null` once it has been cleared. */
  incident: string | null = INCIDENT_ID;
  /** What `POST /providers/:provider/retry` was really asked to clear. */
  readonly cleared: string[] = [];

  override status(): Promise<ProviderStatusResponse> {
    return Promise.resolve({
      providers: PROVIDER_IDS.map((provider) =>
        provider === 'claude' && this.incident
          ? { provider, status: 'disconnected' as const, hint: 'Sign in again.', authFailureId: this.incident }
          : { provider, status: 'connected' as const },
      ),
    });
  }

  override clearRuntimeAuthFailure(provider: ProviderId, authFailureId: string): boolean {
    if (provider !== 'claude' || this.incident === null || authFailureId !== this.incident) return false;
    this.cleared.push(authFailureId);
    this.incident = null;
    return true;
  }
}

/** A cockpit over the same workspace home whose `claude` row carries that incident. */
export function incidentCockpit(): { app: ReturnType<typeof createApp>; auth: IncidentProviderAuth } {
  const auth = new IncidentProviderAuth();
  return { app: hotCockpit(undefined, auth).app, auth };
}
