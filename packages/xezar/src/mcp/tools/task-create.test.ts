import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CreateRunInput, ProviderStatusResponse, Runner, WorkflowStepDef } from '@qodeca/xezar-contract';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_MODELS_LOCKED_ERROR } from '../../core/agent-model-policy.ts';
import { ProviderAuthService, PROVIDER_IDS } from '../../core/provider-auth.ts';
import { RunStore } from '../../runs/store.ts';
import { ProjectContexts, type ProjectContextSource } from '../../server/project-context.ts';
import { createApp } from '../../server/server.ts';
import type { RunManager } from '../../workflows/run.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import type { ServiceDispatch } from '../service-adapter.ts';
import type { McpToolResult } from '../tool.ts';
import { tools } from './index.ts';
import { taskCreateTool, type TaskCreateContext } from './task-create.ts';

/**
 * `task_create` against the composer form (#92, A-05): every field set, omitted and invalid.
 *
 * PARITY IS MEASURED, NOT ASSERTED BY HAND. Each "set/omitted" row runs two paths over the SAME
 * real service state (`createApp` with real `ProjectContexts`, stores and managers):
 *   - MCP: the tool, whose `POST /runs` body is captured on its way into the service;
 *   - the cockpit: the web package's OWN functions — `resolveRunner`, `resolveModel`,
 *     `resolveSource`, `resolveComposerRunMode`, `usableRunners`, `buildCreateRunBody` — fed the
 *     answers of the same routes the composer reads, in the order `NewTaskRoute` applies them.
 * The two bodies must be identical key for key. A default changed in only one of the two paths
 * fails the row that exercises it.
 *
 * The web modules are loaded by PATH at run time: they are the cockpit's source, not a package the
 * service may depend on, and a dynamic import keeps the server's typecheck from compiling DOM code
 * under Node settings. The shape each is used through is declared below, from contract types.
 *
 * "Invalid" rows send the same bad value through both doors and require the same rejection text.
 * Where the composer cannot express a value at all (an unknown skill, another runner's model), the
 * row pins the tool's refusal instead, and says so.
 */

// ---- the cockpit's own functions -----------------------------------------------------------------

type TaskSource = { source: 'skill' | 'workflow'; ref: string };
interface WebComposer {
  usableRunners(status: ProviderStatusResponse | undefined): Runner[];
  resolveRunner(picked: Runner | null, available: readonly Runner[], preferred: Runner): Runner;
  resolveModel(picked: string | null, runner: Runner, defaults?: Partial<Record<Runner, string>>): string;
  resolveSource(candidate: TaskSource | null, skills: readonly { name: string }[], workflows: readonly { name: string }[]): TaskSource | null;
  runnerOverride(runner: Runner, defaultRunner: Runner | undefined, explicit?: boolean): Runner | undefined;
  resolveComposerRunMode(input: {
    hasGit: boolean;
    variants: number;
    planFirst: boolean;
    explicitAutonomous: boolean | null;
    explicitWorktree: boolean | null;
    interactive?: boolean;
    configuredAutonomous: boolean | 'source-dependent';
    configuredWorktree: boolean;
    source: 'skill' | 'workflow';
  }): { autonomous: boolean; worktree: boolean };
  buildCreateRunBody(opts: {
    task: string;
    source: TaskSource | null;
    model: string;
    modelsLocked?: boolean;
    runner: Runner;
    runnerExplicit?: boolean;
    defaultRunner?: Runner;
    agentProfile?: string | null;
    variants: number;
    images: NonNullable<CreateRunInput['images']>;
    worktree?: boolean;
    autonomous?: boolean;
    generateFollowups?: boolean;
    todoId?: string;
  }): CreateRunInput;
  buildPlannedRunBody(opts: {
    task: string;
    steps: readonly WorkflowStepDef[];
    model: string;
    modelsLocked?: boolean;
    runner: Runner;
    runnerExplicit?: boolean;
    defaultRunner?: Runner;
    variants: number;
    images: NonNullable<CreateRunInput['images']>;
    generateFollowups?: boolean;
    todoId?: string;
  }): CreateRunInput;
}

let web: WebComposer;
beforeAll(async () => {
  const load = async (path: string): Promise<object> =>
    (await import(/* @vite-ignore */ fileURLToPath(new URL(`../../../../web/src/${path}`, import.meta.url)))) as object;
  web = Object.assign(
    {},
    await load('lib/provider-status.ts'),
    await load('routes/new-task-form.ts'),
    await load('routes/new-task-draft.ts'),
    await load('routes/new-task-plan.ts'),
  ) as WebComposer;
});

// ---- the service -------------------------------------------------------------------------------

type ProviderRow = ProviderStatusResponse['providers'][number];

class FixedProviderAuth extends ProviderAuthService {
  constructor(private readonly rows: ProviderRow[]) {
    super();
  }
  override status(): Promise<ProviderStatusResponse> {
    return Promise.resolve({ providers: this.rows });
  }
}

const connected = (...runners: Runner[]): ProviderRow[] =>
  PROVIDER_IDS.map((provider) => ({ provider, status: runners.includes(provider) ? 'connected' : 'disconnected' }));

interface SetupOptions {
  git?: 'commit' | 'none' | 'blocked-worktrees';
  providers?: ProviderRow[];
  followups?: boolean;
  /** The project's own `.xezar/config.json` keys (`defaultRunner`, `defaultModels`, `modelsLocked`). */
  project?: Record<string, unknown>;
  /** `~/.xezar/config.json` → `composerDefaults`. */
  composerDefaults?: { autonomous?: boolean; worktree?: boolean };
  skills?: { name: string; interactive?: boolean }[];
  workflows?: string[];
  todos?: { id: string; summary: string }[];
}

interface Fixture {
  app: ReturnType<typeof createApp>;
  contexts: ProjectContexts;
  root: string;
  ctx: TaskCreateContext;
  /** Every request the tool sent into the service, in order. */
  calls: { method: string; path: string; body: unknown }[];
}

const PROJECT = 'proj-a';
const COCKPIT_HOST = '127.0.0.1:4321';
const tempDirs: string[] = [];
let fixture: Fixture | undefined;
// Every variable the fixture pins, restored after each case. The three agent homes and
// ANTHROPIC_MODEL keep the developer's own agent settings out of `/config`'s `defaultModels`.
// XEZ_HANDOFF_FILE / XEZ_TODOS_FILE are unset because the real (dry-run) starts below spawn the
// mock agent, which writes to whatever those name — inside a xezar task, that is the developer's
// own handoff file and follow-up inbox.
const PINNED = [
  'XEZ_DRY_RUN',
  'XEZ_HOME',
  'XEZ_AUTONOMOUS_DEFAULT',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'OPENCODE_CONFIG_DIR',
  'ANTHROPIC_MODEL',
  'XEZ_HANDOFF_FILE',
  'XEZ_TODOS_FILE',
] as const;
const saved = Object.fromEntries(PINNED.map((key) => [key, process.env[key]])) as Record<(typeof PINNED)[number], string | undefined>;

const makeDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
};

function setup(options: SetupOptions = {}, stubStart = true): Fixture {
  const home = makeDir('xez-task-create-home-');
  process.env.XEZ_HOME = home;
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR'] as const) {
    process.env[key] = join(home, key.toLowerCase());
  }
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.XEZ_HANDOFF_FILE;
  delete process.env.XEZ_TODOS_FILE;
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ composerDefaults: options.composerDefaults ?? {} }),
    'utf8',
  );
  const root = makeDir('xez-task-create-root-');
  mkdirSync(join(root, '.xezar', 'skills'), { recursive: true });
  mkdirSync(join(root, '.xezar', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), JSON.stringify({ skillsRepos: [], ...options.project }), 'utf8');
  for (const skill of options.skills ?? []) {
    const front = [`name: ${skill.name}`, `description: the ${skill.name} skill`, ...(skill.interactive ? ['interactive: true'] : [])];
    writeFileSync(join(root, '.xezar', 'skills', `${skill.name}.md`), `---\n${front.join('\n')}\n---\nDo it.\n`, 'utf8');
  }
  for (const name of options.workflows ?? []) {
    writeFileSync(join(root, '.xezar', 'workflows', `${name}.yaml`), `name: ${name}\nsteps:\n  - id: a\n    prompt: "{{task}}"\n`, 'utf8');
  }
  if (options.todos) {
    mkdirSync(join(root, '.local', 'xezar'), { recursive: true });
    writeFileSync(join(root, '.local', 'xezar', 'todos.json'), JSON.stringify(options.todos), 'utf8');
  }
  const mode = options.git ?? 'commit';
  if (mode !== 'none') {
    git(root, 'init', '-q', '-b', 'main');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
  }
  if (mode === 'blocked-worktrees') {
    // A FILE where the worktrees directory must go: `git worktree add` cannot create the task tree.
    mkdirSync(join(root, '.local', 'xezar'), { recursive: true });
    writeFileSync(join(root, '.local', 'xezar', 'worktrees'), 'not a directory\n', 'utf8');
  }

  const limits = { maxParallel: 2, memoryLimitMb: null, followups: options.followups ?? false };
  const semaphore = new WorkspaceSemaphore({ initial: limits, load: async () => limits });
  const projects: ProjectContextSource[] = [{ id: PROJECT, root, status: 'ok' }];
  const contexts = new ProjectContexts({ listProjects: async () => projects, semaphore });
  const boot = makeDir('xez-task-create-boot-');
  const app = createApp({
    repoRoot: boot,
    store: RunStore.open(join(boot, '.local/xezar'), { keepLive: true }),
    manager: { isActive: () => false } as unknown as RunManager,
    version: '0.0.0-test',
    bootProjectId: 'boot',
    contexts,
    semaphore,
    providerAuth: new FixedProviderAuth(options.providers ?? connected(...PROVIDER_IDS)),
  });

  const calls: Fixture['calls'] = [];
  const service: ServiceDispatch = {
    request(input, init) {
      const path = new URL(input).pathname;
      const method = init?.method ?? 'GET';
      calls.push({ method, path, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined });
      // The parity rows compare BODIES; starting dozens of real runs would prove nothing more.
      if (stubStart && method === 'POST' && (path.endsWith('/runs') || path.endsWith('/start'))) {
        const record = { id: 'stubbed-run', status: 'queued' };
        return new Response(JSON.stringify(path.endsWith('/runs') ? record : { run: record }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return app.request(input, init);
    },
  };
  fixture = {
    app,
    contexts,
    root,
    calls,
    ctx: { project: { id: PROJECT, name: 'proj-a', root }, xezarVersion: '0.0.0-test', service },
  };
  return fixture;
}

/** The cockpit's own request: same-origin, from the loopback deployment a browser talks to. */
const cockpit = (app: Fixture['app'], path: string, method = 'GET', body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      host: COCKPIT_HOST,
      origin: `http://${COCKPIT_HOST}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const cockpitJson = async <T>(app: Fixture['app'], path: string): Promise<T> => (await (await cockpit(app, path)).json()) as T;

/** The cockpit's refusal for a body: the route's `{ error }`. */
const cockpitRefusal = async (app: Fixture['app'], path: string, body: unknown): Promise<{ status: number; error: string }> => {
  const res = await cockpit(app, path, 'POST', body);
  return { status: res.status, error: ((await res.json()) as { error: string }).error };
};

/** Call the tool the way the service does: schema first (`service.ts` callTool), then `call`. */
async function callTool(f: Fixture, args: Record<string, unknown>): Promise<McpToolResult> {
  const parsed = taskCreateTool.inputSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`);
    return { content: [{ type: 'text', text: `Invalid arguments for task_create: ${issues.join('; ')}` }], isError: true };
  }
  return taskCreateTool.call(parsed.data, f.ctx);
}

const text = (result: McpToolResult): string => {
  const block = result.content[0];
  return block && block.type === 'text' ? block.text : '';
};
const json = (result: McpToolResult): Record<string, unknown> => JSON.parse(text(result)) as Record<string, unknown>;
/** The refusal a caller reads: the JSON answer's `error`, or the plain text of a schema rejection. */
const message = (result: McpToolResult): string => {
  try {
    const error = json(result).error;
    return typeof error === 'string' ? error : text(result);
  } catch {
    return text(result);
  }
};
const startBodies = (f: Fixture): unknown[] => f.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/runs')).map((c) => c.body);

/** The cockpit's composer state for this project, read the way `NewTaskRoute` reads it. */
async function cockpitState(app: Fixture['app']) {
  const scope = `/api/v1/p/${PROJECT}`;
  const [providers, config, workspace, repo, health, skills, workflows] = await Promise.all([
    cockpitJson<ProviderStatusResponse>(app, '/api/v1/providers/status'),
    cockpitJson<{ defaultRunner?: Runner; defaultModels?: Partial<Record<Runner, string>>; modelsLocked?: boolean }>(app, `${scope}/config`),
    cockpitJson<{ composerDefaults?: { autonomous?: boolean | null; worktree?: boolean | null; inheritedAutonomous?: boolean | 'source-dependent'; inheritedWorktree?: boolean } }>(app, '/api/v1/workspace/config'),
    cockpitJson<{ info: unknown }>(app, `${scope}/repo`),
    cockpitJson<{ capabilities: { followups: boolean } }>(app, '/api/v1/health'),
    cockpitJson<{ name: string; interactive?: true }[]>(app, `${scope}/skills`),
    cockpitJson<{ workflows: { name: string }[] }>(app, `${scope}/workflows`),
  ]);
  return { providers, config, workspace, repo, health, skills, workflows };
}

/** A composer draft: what the user touched. `null` means "never touched" (the draft store's rule). */
interface Draft {
  text: string;
  source: TaskSource | null;
  runner: Runner | null;
  agentProfile: string | null;
  model: string | null;
  variants: number;
  worktree: boolean | null;
  autonomous: boolean | null;
  generateFollowups: boolean | null;
  images: NonNullable<CreateRunInput['images']>;
  todoId: string;
  steps?: WorkflowStepDef[];
}

/** `NewTaskRoute` from its picker values to `submit`, with the web package's own functions. */
async function cockpitBody(app: Fixture['app'], draft: Draft): Promise<CreateRunInput> {
  const s = await cockpitState(app);
  const runners = web.usableRunners(s.providers);
  const defaultRunner = s.config.defaultRunner;
  const runner = web.resolveRunner(draft.runner, runners, defaultRunner ?? 'claude');
  const modelsLocked = s.config.modelsLocked === true;
  const model = web.resolveModel(modelsLocked ? null : draft.model, runner, s.config.defaultModels);
  const source = web.resolveSource(draft.source, s.skills, s.workflows.workflows);
  const selectedSkill = source?.source === 'skill' ? s.skills.find((skill) => skill.name === source.ref) : undefined;
  const hasGit = s.repo.info !== null;
  const variants = hasGit ? draft.variants : 1;
  const defaults = s.workspace.composerDefaults;
  const runMode = web.resolveComposerRunMode({
    hasGit,
    variants,
    planFirst: draft.steps !== undefined,
    explicitAutonomous: draft.autonomous,
    explicitWorktree: draft.worktree,
    interactive: selectedSkill?.interactive,
    configuredAutonomous: defaults?.autonomous ?? defaults?.inheritedAutonomous ?? 'source-dependent',
    configuredWorktree: defaults?.worktree ?? defaults?.inheritedWorktree ?? true,
    source: source?.source ?? 'workflow',
  });
  // A fresh project has no `lastGenerateFollowups` memory, and MCP never reads that memory (D-03).
  const generateFollowups = s.health.capabilities.followups ? (draft.generateFollowups ?? true) : false;
  const common = {
    task: draft.text,
    model,
    modelsLocked,
    runner,
    runnerExplicit: draft.runner !== null,
    defaultRunner,
    variants,
    images: draft.images,
    generateFollowups,
    todoId: draft.todoId,
  };
  const body = draft.steps
    ? web.buildPlannedRunBody({ ...common, steps: draft.steps })
    : web.buildCreateRunBody({ ...common, source, agentProfile: draft.agentProfile, worktree: runMode.worktree, autonomous: runMode.autonomous });
  return JSON.parse(JSON.stringify(body)) as CreateRunInput;
}

const DRAFT: Draft = {
  text: 'fix the flaky test',
  source: null,
  runner: null,
  agentProfile: null,
  model: null,
  variants: 1,
  worktree: null,
  autonomous: null,
  generateFollowups: null,
  images: [],
  todoId: '',
};

/** The MCP arguments that express the same draft: an untouched control is an omitted field. */
function argsFor(draft: Draft): Record<string, unknown> {
  return {
    operationId: 'op-parity-0001',
    prompt: draft.text,
    ...(draft.source ? { source: draft.source } : {}),
    ...(draft.steps ? { steps: draft.steps } : {}),
    ...(draft.runner !== null ? { runner: draft.runner } : {}),
    ...(draft.agentProfile !== null ? { agentProfile: draft.agentProfile } : {}),
    ...(draft.model !== null ? { model: draft.model } : {}),
    ...(draft.variants !== 1 ? { variants: draft.variants } : {}),
    ...(draft.worktree !== null ? { worktree: draft.worktree } : {}),
    ...(draft.autonomous !== null ? { autonomous: draft.autonomous } : {}),
    ...(draft.generateFollowups !== null ? { generateFollowups: draft.generateFollowups } : {}),
    ...(draft.images.length > 0 ? { images: draft.images } : {}),
    ...(draft.todoId ? { todoId: draft.todoId } : {}),
  };
}

const PNG = { mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' };
const STEPS: WorkflowStepDef[] = [
  { id: 'build', name: 'Build it', prompt: '{{task}}' },
  { id: 'verify', name: 'Verify', prompt: 'check {{task}}' },
];

beforeEach(() => {
  process.env.XEZ_DRY_RUN = '1';
  delete process.env.XEZ_AUTONOMOUS_DEFAULT;
});

const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

afterEach(async () => {
  const f = fixture;
  fixture = undefined;
  if (f) {
    for (const id of f.contexts.ids()) {
      const ctx = f.contexts.peek(id);
      if (!ctx) continue;
      const runs = ctx.store.listRuns().map((run) => run.id);
      // Cancel on every poll, not once. This was written for engine bug #229: a cancel that
      // landed while an agent session was still being spawned set `cancelled` with no session
      // to interrupt, and the interactive last step then stayed open with no wall clock (CI run
      // 34542479208). The engine now re-checks the flag once the session opens
      // (`publishSession`, #249; pinned by `run-cancel-spawn.test.ts`). Re-issuing stays as a
      // cheap belt: cleanup must never be what hangs a suite.
      await waitFor(() => {
        for (const runId of runs) if (ctx.manager.isActive(runId)) ctx.manager.cancel(runId);
        return runs.every((runId) => !ctx.manager.isActive(runId));
      }, 'cancelled runs to settle');
      await ctx.manager.dispose();
    }
    f.contexts.disposeAll();
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of PINNED) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}, 60_000);

// ---- set and omitted: the same body through both doors --------------------------------------------

interface ParityRow {
  name: string;
  setup?: SetupOptions;
  env?: Record<string, string>;
  draft: Partial<Draft>;
  /** What the resolved body must say — pinned so a row cannot pass by both paths drifting together. */
  expected: Partial<CreateRunInput>;
  /** Keys that must be ABSENT from the body (the composer's "default stays implicit" rule). */
  absent?: (keyof CreateRunInput)[];
}

const TWO_MODELS = { project: { defaultModels: { claude: 'opus', codex: 'gpt-5.1-codex' } } };

const PARITY: ParityRow[] = [
  // prompt / source
  { name: 'prompt set, every other field omitted → quick-task with no optional key', setup: { followups: true }, draft: {}, expected: { task: DRAFT.text, workflow: 'quick-task' }, absent: ['model', 'runner', 'agentProfile', 'variants', 'images', 'worktree', 'autonomous', 'generateFollowups', 'todoId', 'steps'] },
  { name: 'source: skill → one inline step, autonomous by the source-dependent default', setup: { skills: [{ name: 'fixer' }] }, draft: { source: { source: 'skill', ref: 'fixer' } }, expected: { steps: [{ id: 'task', name: 'fixer', skill: 'fixer', prompt: '{{task}}' }], autonomous: true }, absent: ['workflow'] },
  { name: 'source: interactive skill → interactive AND in the checkout (the skill recommends both)', setup: { skills: [{ name: 'asker', interactive: true }] }, draft: { source: { source: 'skill', ref: 'asker' } }, expected: { worktree: false }, absent: ['autonomous'] },
  { name: 'source: workflow → by name, not autonomous', setup: { workflows: ['review-flow'] }, draft: { source: { source: 'workflow', ref: 'review-flow' } }, expected: { workflow: 'review-flow' }, absent: ['autonomous', 'steps'] },
  // images
  { name: 'images set → carried', draft: { images: [PNG] }, expected: { images: [PNG] } },
  // model
  { name: 'model set → sent', draft: { model: 'sonnet' }, expected: { model: 'sonnet' } },
  { name: "model '' (auto) → implicit", setup: TWO_MODELS, draft: { model: '' }, absent: ['model'], expected: {} },
  { name: "model omitted → the runner's configured default", setup: TWO_MODELS, draft: {}, expected: { model: 'opus' } },
  { name: 'model omitted under modelsLocked → no model at all', setup: { project: { ...TWO_MODELS.project, modelsLocked: true } }, draft: {}, absent: ['model'], expected: {} },
  // runner
  { name: 'runner set → sent, and the model re-resolves for THAT runner (the pin does not carry)', setup: TWO_MODELS, draft: { runner: 'codex' }, expected: { runner: 'codex', model: 'gpt-5.1-codex' } },
  { name: 'runner set to the default → still sent (an explicit pick always rides)', draft: { runner: 'claude' }, expected: { runner: 'claude' } },
  { name: 'runner omitted → implicit when the default is usable', draft: {}, absent: ['runner'], expected: {} },
  { name: 'runner omitted, default disconnected → the first usable runner, explicitly', setup: { providers: connected('codex', 'pi') }, draft: {}, expected: { runner: 'codex' } },
  // agentProfile
  { name: 'agentProfile set → sent', draft: { agentProfile: 'default' }, expected: { agentProfile: 'default' } },
  // variants / worktree
  { name: 'variants: 2 → sent, worktree implicit (variants isolate)', draft: { variants: 2 }, expected: { variants: 2 }, absent: ['worktree'] },
  { name: 'variants: 2 with worktree: false → worktree forced on, as the UI does', draft: { variants: 2, worktree: false }, expected: { variants: 2 }, absent: ['worktree'] },
  { name: 'worktree: false → run in the checkout', draft: { worktree: false }, expected: { worktree: false } },
  { name: 'worktree omitted, workspace composerDefaults.worktree false → in the checkout', setup: { composerDefaults: { worktree: false } }, draft: {}, expected: { worktree: false } },
  { name: 'worktree omitted in a non-git folder → in place', setup: { git: 'none' }, draft: {}, expected: { worktree: false } },
  // autonomous
  { name: 'autonomous: true → sent', draft: { autonomous: true }, expected: { autonomous: true } },
  { name: 'autonomous: false on a skill → overrides the source-dependent default', setup: { skills: [{ name: 'fixer' }] }, draft: { source: { source: 'skill', ref: 'fixer' }, autonomous: false }, absent: ['autonomous'], expected: {} },
  { name: 'autonomous omitted, composerDefaults.autonomous true → autonomous for a workflow', setup: { composerDefaults: { autonomous: true } }, draft: {}, expected: { autonomous: true } },
  { name: 'autonomous omitted, XEZ_AUTONOMOUS_DEFAULT=0 → not autonomous even for a skill', setup: { skills: [{ name: 'fixer' }] }, env: { XEZ_AUTONOMOUS_DEFAULT: '0' }, draft: { source: { source: 'skill', ref: 'fixer' } }, absent: ['autonomous'], expected: {} },
  // generateFollowups
  { name: 'generateFollowups: false with the inbox on → sent', setup: { followups: true }, draft: { generateFollowups: false }, expected: { generateFollowups: false } },
  { name: 'generateFollowups omitted with the inbox on → implicit (on)', setup: { followups: true }, draft: {}, absent: ['generateFollowups'], expected: {} },
  { name: 'generateFollowups omitted with the inbox off → false', setup: { followups: false }, draft: {}, expected: { generateFollowups: false } },
  { name: 'generateFollowups: true with the inbox off → still false (the capability is the ceiling)', setup: { followups: false }, draft: { generateFollowups: true }, expected: { generateFollowups: false } },
  // todoId
  { name: 'todoId set → sent', draft: { todoId: 't-1' }, expected: { todoId: 't-1' } },
  // a reviewed plan
  { name: 'steps (a reviewed plan) with runner/model/variants → the plan-review body', setup: TWO_MODELS, draft: { steps: STEPS, runner: 'codex', variants: 2, images: [PNG] }, expected: { steps: STEPS, runner: 'codex', model: 'gpt-5.1-codex', variants: 2, images: [PNG] }, absent: ['workflow', 'worktree', 'autonomous', 'agentProfile'] },
];

describe('task_create start: every field set or omitted lands where the composer lands', () => {
  it.each(PARITY)('$name', async (row) => {
    for (const [key, value] of Object.entries(row.env ?? {})) process.env[key] = value;
    const f = setup(row.setup);
    const draft = { ...DRAFT, ...row.draft };
    const result = await callTool(f, argsFor(draft));
    expect(result.isError, text(result)).toBeFalsy();
    expect(json(result)).toMatchObject({ accepted: true, status: 'accepted', subject: { type: 'run', id: 'stubbed-run' } });

    const [sent, ...more] = startBodies(f);
    expect(more).toEqual([]);
    expect(sent).toEqual(await cockpitBody(f.app, draft));
    expect(sent).toMatchObject(row.expected);
    for (const key of row.absent ?? []) expect(sent, `${key} must stay implicit`).not.toHaveProperty(key);
  });

  it('reports the forced worktree and the effective options it resolved', async () => {
    const f = setup({ skills: [{ name: 'fixer' }] });
    const result = json(await callTool(f, { ...argsFor(DRAFT), source: { source: 'skill', ref: 'fixer' }, variants: 2, worktree: false }));
    expect(result.notes).toEqual(['worktree forced on: parallel variants always use isolated worktrees']);
    expect(result.effective).toEqual({
      source: { source: 'skill', ref: 'fixer' },
      runner: 'claude',
      model: 'auto',
      variants: 2,
      worktree: true,
      autonomous: true,
      generateFollowups: false,
    });
  });
});

// ---- invalid: the same rejection the cockpit gets ----------------------------------------------------

interface InvalidRow {
  name: string;
  setup?: SetupOptions;
  args: Record<string, unknown>;
  /** The same bad value, as the cockpit would put it on the wire. */
  wire: Record<string, unknown>;
  status?: 'conflict';
}

const BASE_WIRE = { task: DRAFT.text, workflow: 'quick-task' };

const INVALID: InvalidRow[] = [
  { name: 'prompt omitted', args: {}, wire: { task: '', workflow: 'quick-task' } },
  { name: 'prompt empty', args: { prompt: '' }, wire: { task: '', workflow: 'quick-task' } },
  { name: 'prompt over 100000 characters', args: { prompt: 'x'.repeat(100_001) }, wire: { task: 'x'.repeat(100_001), workflow: 'quick-task' } },
  { name: 'images: five', args: { images: [PNG, PNG, PNG, PNG, PNG] }, wire: { ...BASE_WIRE, images: [PNG, PNG, PNG, PNG, PNG] } },
  { name: 'images: an unsupported type', args: { images: [{ mediaType: 'application/zip', data: 'UEsDBA==' }] }, wire: { ...BASE_WIRE, images: [{ mediaType: 'application/zip', data: 'UEsDBA==' }] } },
  { name: 'source: an unknown workflow', args: { source: { source: 'workflow', ref: 'nope' } }, wire: { task: DRAFT.text, workflow: 'nope' } },
  { name: 'runner: not a runner', args: { runner: 'gemini' }, wire: { ...BASE_WIRE, runner: 'gemini' } },
  { name: 'runner: a disconnected one', setup: { providers: connected('claude') }, args: { runner: 'codex' }, wire: { ...BASE_WIRE, runner: 'codex' }, status: 'conflict' },
  { name: 'model: an override under modelsLocked', setup: { project: { modelsLocked: true } }, args: { model: 'opus' }, wire: { ...BASE_WIRE, model: 'opus' }, status: 'conflict' },
  { name: 'agentProfile: an unknown account', args: { agentProfile: 'nobody' }, wire: { ...BASE_WIRE, agentProfile: 'nobody' } },
  { name: 'agentProfile: over 64 characters', args: { agentProfile: 'a'.repeat(65) }, wire: { ...BASE_WIRE, agentProfile: 'a'.repeat(65) } },
  { name: 'variants: 4', args: { variants: 4 }, wire: { ...BASE_WIRE, variants: 4 } },
  { name: 'variants: 1.5', args: { variants: 1.5 }, wire: { ...BASE_WIRE, variants: 1.5 } },
  { name: 'variants: 2 in a non-git folder (refused, never clamped)', setup: { git: 'none' }, args: { variants: 2 }, wire: { ...BASE_WIRE, variants: 2 } },
  { name: 'worktree: not a boolean', args: { worktree: 'no' }, wire: { ...BASE_WIRE, worktree: 'no' } },
  { name: 'autonomous: not a boolean', args: { autonomous: 'yes' }, wire: { ...BASE_WIRE, autonomous: 'yes' } },
  { name: 'generateFollowups: not a boolean', args: { generateFollowups: 1 }, wire: { ...BASE_WIRE, generateFollowups: 1 } },
  { name: 'todoId: empty', args: { todoId: '' }, wire: { ...BASE_WIRE, todoId: '' } },
  { name: 'todoId: over 200 characters', args: { todoId: 't'.repeat(201) }, wire: { ...BASE_WIRE, todoId: 't'.repeat(201) } },
  { name: 'steps: nine', args: { steps: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, prompt: 'p' })) }, wire: { task: DRAFT.text, steps: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, prompt: 'p' })) } },
  { name: 'steps: a retry that points forward', args: { steps: [{ id: 'a', command: 'true', onFail: { retry: 'b' } }, { id: 'b', prompt: 'p' }] }, wire: { task: DRAFT.text, steps: [{ id: 'a', command: 'true', onFail: { retry: 'b' } }, { id: 'b', prompt: 'p' }] } },
];

describe('task_create start: every invalid field gets the cockpit\'s own rejection', () => {
  it.each(INVALID)('$name', async (row) => {
    // Unstubbed: the route itself must answer.
    const f = setup(row.setup, false);
    const cockpitAnswer = await cockpitRefusal(f.app, `/api/v1/p/${PROJECT}/runs`, row.wire);
    expect(cockpitAnswer.status).toBeGreaterThanOrEqual(400);

    const result = await callTool(f, { operationId: 'op-invalid-01', ...(row.args.prompt === undefined && row.name !== 'prompt omitted' ? { prompt: DRAFT.text } : {}), ...row.args });
    // Every issue the route names, the tool names too — the same zod definition or the route itself.
    for (const issue of cockpitAnswer.error.split('; ')) expect(message(result)).toContain(issue);
    if (row.status === 'conflict') {
      expect(result.isError).toBeFalsy();
      expect(json(result)).toMatchObject({ accepted: false, status: 'conflict', error: cockpitAnswer.error });
    } else {
      expect(result.isError).toBe(true);
    }
    // Nothing reached the store: a refusal starts no task.
    const ctx = f.contexts.peek(PROJECT);
    expect(ctx?.store.listRuns() ?? []).toEqual([]);
  });

  it('refuses a model override under modelsLocked with the route\'s own words', async () => {
    const f = setup({ project: { modelsLocked: true } }, false);
    const result = json(await callTool(f, { operationId: 'op-locked-01', prompt: 'x', model: 'sonnet' }));
    expect(result).toMatchObject({ accepted: false, status: 'conflict', error: AGENT_MODELS_LOCKED_ERROR });
  });
});

describe('task_create start: values the composer cannot express are refused, never swapped', () => {
  it('an unknown skill (the composer would silently drop it and run quick-task)', async () => {
    const f = setup();
    const result = await callTool(f, { operationId: 'op-skill-01', prompt: 'x', source: { source: 'skill', ref: 'nope' } });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ accepted: false, error: 'unknown skill: nope' });
    expect(startBodies(f)).toEqual([]);
  });

  it("another runner's model (the picker never lists it)", async () => {
    const f = setup();
    const result = await callTool(f, { operationId: 'op-model-01', prompt: 'x', runner: 'codex', model: 'opus' });
    expect(result.isError).toBe(true);
    expect(json(result).error).toBe('model "opus" belongs to another runner than codex');
    expect(startBodies(f)).toEqual([]);
  });

  it('a misspelled field (strict arguments, so nothing is ignored silently)', async () => {
    const f = setup();
    const result = await callTool(f, { operationId: 'op-typo-001', prompt: 'x', agent_profile: 'default' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/agent_profile|Unrecognized key/);
  });

  it.each([
    ['source', { source: { source: 'workflow', ref: 'quick-task' } }],
    ['agentProfile', { agentProfile: 'default' }],
    ['worktree', { worktree: false }],
    ['autonomous', { autonomous: true }],
  ])('a planned start refuses %s, which the plan review never sends', async (key, extra) => {
    const f = setup();
    const result = await callTool(f, { operationId: 'op-plan-start', prompt: 'x', steps: STEPS, ...extra });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(key);
    expect(startBodies(f)).toEqual([]);
  });

  it('with no provider connected answers the composer\'s disabled reason, as a conflict', async () => {
    const f = setup({ providers: connected() });
    const result = await callTool(f, { operationId: 'op-noprov-1', prompt: 'x' });
    expect(result.isError).toBeFalsy();
    expect(json(result)).toMatchObject({ accepted: false, status: 'conflict', error: 'Connect an agent provider before starting a task.' });
    expect(startBodies(f)).toEqual([]);
  });

  it('needs an operationId (D-06 § 5.2)', async () => {
    const f = setup();
    for (const operationId of [undefined, 'short', 'has space in it']) {
      const result = await callTool(f, { prompt: 'x', ...(operationId ? { operationId } : {}) });
      expect(result.isError, String(operationId)).toBe(true);
      expect(text(result)).toContain('operationId');
    }
  });

  it('says it is not connected when the session carries no service', async () => {
    const f = setup();
    const { service: _service, ...bare } = f.ctx;
    const result = await taskCreateTool.call({ action: 'start', operationId: 'op-bare-0001', prompt: 'x' }, bare);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not connected');
  });
});

// ---- real starts: what the service does with the body ------------------------------------------------

describe('task_create start against the real service', () => {
  it('a git task that cannot get its worktree fails closed: one start, no fallback, no retry', async () => {
    const f = setup({ git: 'blocked-worktrees' }, false);
    const result = await callTool(f, { operationId: 'op-wt-fail-1', prompt: 'isolate me' });
    expect(result.isError).toBeFalsy();
    const answer = json(result);
    expect(answer.accepted).toBe(true);
    expect(['accepted', 'running', 'failed']).toContain(answer.status);
    const runId = (answer.subject as { id: string }).id;

    const ctx = f.contexts.peek(PROJECT)!;
    await waitFor(() => ctx.store.getRun(runId)?.status === 'failed', 'the run to fail closed');
    const run = ctx.store.getRun(runId)!;
    expect(run.error).toMatch(/^worktree creation failed/);
    // Stopped before any step: no step ever left `pending`, and it never ran in the checkout.
    expect(run.steps.every((step) => step.status === 'pending')).toBe(true);
    expect(run.worktreePath).toBeUndefined();
    // Exactly one start was sent and exactly one task exists — the tool did not retry it.
    expect(startBodies(f)).toHaveLength(1);
    expect(ctx.store.listRuns()).toHaveLength(1);
    expect(text(result)).not.toMatch(/checkout|in place/);
  });

  it('variants: 2 with worktree: false starts two isolated runs, as the UI does', async () => {
    const f = setup({}, false);
    const answer = json(await callTool(f, { operationId: 'op-variants1', prompt: 'race', variants: 2, worktree: false }));
    expect(answer).toMatchObject({ accepted: true, notes: ['worktree forced on: parallel variants always use isolated worktrees'] });
    const ids = answer.variants as string[];
    expect(ids).toHaveLength(2);
    expect((answer.subject as { id: string }).id).toBe(ids[0]);
    const ctx = f.contexts.peek(PROJECT)!;
    await waitFor(() => ids.every((id) => ctx.store.getRun(id)?.worktreePath !== undefined), 'both variant worktrees');
  });

  it('a started task is the same record the cockpit sees', async () => {
    const f = setup({}, false);
    const answer = json(await callTool(f, { operationId: 'op-record-01', prompt: 'look' }));
    const runId = (answer.subject as { id: string }).id;
    const seen = (await cockpitJson<{ id: string; task: string }>(f.app, `/api/v1/p/${PROJECT}/runs/${runId}`));
    expect(seen).toMatchObject({ id: runId, task: 'look' });
  });
});

// ---- the Inbox start: a narrower option set ------------------------------------------------------

describe('task_create start_from_inbox', () => {
  const TODO = { id: 'todo-1', summary: 'Tidy the README' };

  it.each([
    ['agentProfile', { agentProfile: 'default' }],
    ['variants', { variants: 2 }],
    ['worktree', { worktree: false }],
    ['autonomous', { autonomous: true }],
    ['source', { source: null }],
    ['images', { images: [PNG] }],
    ['generateFollowups', { generateFollowups: false }],
  ])('rejects %s, which the Inbox start does not take', async (key, extra) => {
    const f = setup({ followups: true, todos: [TODO] });
    const result = await callTool(f, { operationId: 'op-inbox-001', action: 'start_from_inbox', todoId: TODO.id, ...extra });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`action "start_from_inbox" does not take: ${key}`);
    expect(f.calls).toEqual([]);
  });

  it('needs the entry id', async () => {
    const f = setup({ followups: true, todos: [TODO] });
    const result = await callTool(f, { operationId: 'op-inbox-002', action: 'start_from_inbox' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('todoId');
  });

  it.each([
    ['nothing', {}, { runner: null, model: null, prompt: '' }],
    ['runner', { runner: 'codex' }, { runner: 'codex', model: null, prompt: '' }],
    ['model', { model: 'sonnet' }, { runner: null, model: 'sonnet', prompt: '' }],
    ['instructions', { prompt: '  add a table  ' }, { runner: null, model: null, prompt: '  add a table  ' }],
  ] as const)('sends what the Inbox card sends for %s', async (_label, args, pick) => {
    const f = setup({ followups: true, todos: [TODO], ...TWO_MODELS });
    const result = await callTool(f, { operationId: 'op-inbox-003', action: 'start_from_inbox', todoId: TODO.id, ...args });
    expect(result.isError, text(result)).toBeFalsy();
    const sent = f.calls.find((c) => c.method === 'POST' && c.path.endsWith(`/todos/${TODO.id}/start`))?.body;

    // `useResolvedEngine` + `engineBody` + the card's trimmed note, with the web package's functions.
    const s = await cockpitState(f.app);
    const runners = web.usableRunners(s.providers);
    const runner = web.resolveRunner(pick.runner, runners, s.config.defaultRunner ?? runners[0] ?? 'claude');
    const model = web.resolveModel(s.config.modelsLocked ? null : pick.model, runner, s.config.defaultModels);
    const card = JSON.parse(JSON.stringify({
      runner: web.runnerOverride(runner, s.config.defaultRunner, pick.runner !== null),
      model: s.config.modelsLocked ? undefined : model || undefined,
      prompt: pick.prompt.trim() || undefined,
    })) as unknown;
    expect(sent).toEqual(card);
    expect(json(result)).toMatchObject({ accepted: true, subject: { type: 'run' } });
  });

  it('marks the entry started, and a second start is the route\'s conflict', async () => {
    const f = setup({ followups: true, todos: [TODO] }, false);
    const first = json(await callTool(f, { operationId: 'op-inbox-004', action: 'start_from_inbox', todoId: TODO.id }));
    expect(first).toMatchObject({ accepted: true, status: expect.stringMatching(/accepted|running/) });
    const todos = await cockpitJson<{ id: string; startedTaskId?: string }[]>(f.app, `/api/v1/p/${PROJECT}/todos`);
    expect(todos.find((t) => t.id === TODO.id)?.startedTaskId).toBe((first.subject as { id: string }).id);

    const again = await callTool(f, { operationId: 'op-inbox-005', action: 'start_from_inbox', todoId: TODO.id });
    expect(again.isError).toBeFalsy();
    expect(json(again)).toMatchObject({ accepted: false, status: 'conflict', error: 'already started' });
  });

  it('caps instructions at 20000 characters with the route\'s own rejection', async () => {
    const f = setup({ followups: true, todos: [TODO] }, false);
    const cockpitAnswer = await cockpitRefusal(f.app, `/api/v1/p/${PROJECT}/todos/${TODO.id}/start`, { prompt: 'x'.repeat(20_001) });
    expect(cockpitAnswer.status).toBe(400);
    const result = await callTool(f, { operationId: 'op-inbox-006', action: 'start_from_inbox', todoId: TODO.id, prompt: 'x'.repeat(20_001) });
    expect(result.isError).toBe(true);
    expect(json(result).error).toBe(cockpitAnswer.error);
  });

  it('with the inbox off answers the route\'s conflict', async () => {
    const f = setup({ followups: false, todos: [TODO] }, false);
    const cockpitAnswer = await cockpitRefusal(f.app, `/api/v1/p/${PROJECT}/todos/${TODO.id}/start`, {});
    const result = json(await callTool(f, { operationId: 'op-inbox-007', action: 'start_from_inbox', todoId: TODO.id }));
    expect(result).toMatchObject({ accepted: false, status: 'conflict', error: cockpitAnswer.error });
  });

  it('refuses a dot-segment id before dispatching anything', async () => {
    const f = setup({ followups: true, todos: [TODO] });
    const result = await callTool(f, { operationId: 'op-inbox-008', action: 'start_from_inbox', todoId: '..' });
    expect(result.isError).toBe(true);
    expect(f.calls).toEqual([]);
  });
});

// ---- planning and saving a plan ------------------------------------------------------------------

describe('task_create plan and save_plan', () => {
  it('plans with the same answer the cockpit gets from POST /plan', async () => {
    const f = setup();
    const cockpitPlan = (await (await cockpit(f.app, `/api/v1/p/${PROJECT}/plan`, 'POST', { task: 'add a changelog' })).json()) as Record<string, unknown>;
    const result = json(await callTool(f, { operationId: 'op-plan-0001', action: 'plan', prompt: 'add a changelog' }));
    expect(result).toMatchObject({ status: 'done', steps: cockpitPlan.steps, rationale: cockpitPlan.rationale, fallback: cockpitPlan.fallback });
  });

  it('refuses a plan request with options the planner does not take', async () => {
    const f = setup();
    const result = await callTool(f, { operationId: 'op-plan-0002', action: 'plan', prompt: 'x', images: [PNG] });
    expect(text(result)).toBe('action "plan" does not take: images');
  });

  it('refuses an empty plan request with the route\'s own words', async () => {
    const f = setup();
    const cockpitAnswer = await cockpitRefusal(f.app, `/api/v1/p/${PROJECT}/plan`, { task: '   ' });
    const result = await callTool(f, { operationId: 'op-plan-0003', action: 'plan', prompt: '   ' });
    expect(result.isError).toBe(true);
    expect(json(result).error).toBe(cockpitAnswer.error);
  });

  it('saves a plan, reports the overwrite decision as a conflict, and overwrites only when asked', async () => {
    const f = setup();
    const save = (overwrite?: boolean) =>
      callTool(f, { operationId: 'op-save-0001', action: 'save_plan', name: 'Ship it', steps: STEPS, ...(overwrite ? { overwrite } : {}) });

    expect(json(await save())).toEqual({ accepted: true, operationId: 'op-save-0001', status: 'done', subject: { type: 'workflow', id: 'Ship it' } });
    const clash = await save();
    expect(clash.isError).toBeFalsy();
    expect(json(clash)).toMatchObject({ accepted: false, status: 'conflict', exists: true });
    // The route's 409 names an absolute file path; the tool's answer does not.
    expect(text(clash)).not.toContain(f.root);
    expect(json(await save(true))).toMatchObject({ accepted: true, status: 'done' });

    const listed = await cockpitJson<{ workflows: { name: string }[] }>(f.app, `/api/v1/p/${PROJECT}/workflows`);
    expect(listed.workflows.map((w) => w.name)).toContain('Ship it');
  });

  it('refuses a bad workflow name with the route\'s own words', async () => {
    const f = setup();
    const cockpitAnswer = await cockpitRefusal(f.app, `/api/v1/p/${PROJECT}/workflows`, { name: 'n'.repeat(81), steps: STEPS });
    const result = await callTool(f, { operationId: 'op-save-0002', action: 'save_plan', name: 'n'.repeat(81), steps: STEPS });
    expect(result.isError).toBe(true);
    expect(json(result).error).toBe(cockpitAnswer.error);
  });
});

describe('task_create in the registry', () => {
  it('is listed once, as task_create', () => {
    expect(tools.filter((tool) => tool.name === 'task_create')).toEqual([taskCreateTool]);
  });
});
