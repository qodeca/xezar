import { createRunInputBaseSchema, operationIdSchema, type CreateRunInput, type RunRecord, type Runner } from '@qodeca/xezar-contract';
import { hc } from 'hono/client';
import { z } from 'zod';
import { modelConflictsWithRunner } from '../../core/model-presets.ts';
import type { AppType } from '../../server/app-type.ts';
import { McpServiceAdapter, type ServiceDispatch, type StartRunValue } from '../service-adapter.ts';
import { defineTool, errorResult, textResult, type McpToolContext, type McpToolResult } from '../tool.ts';

/**
 * `task_create` — create and plan tasks with the composer form's options, defaults and validation
 * (#92, F-06, A-05, A-06; inventory I-001, I-002, I-003, I-005, I-007, I-008, I-009, I-026, I-085).
 *
 * WHERE THE RULES LIVE. The server's routes own validation and every refusal: the tool sends each
 * action to the route the cockpit calls (`POST /runs`, `POST /plan`, `POST /todos/:id/start`,
 * `POST /workflows`) through the shared service seam, so a bad value gets the cockpit's own 400,
 * 404 or 409. What the server does NOT own is the composer's DEFAULTS: `resolveComposerRunMode`,
 * `resolveRunner`, `resolveModel` and `buildCreateRunBody` run in the browser and decide which
 * keys the body carries at all. An MCP task that omits a field must land where a cockpit task
 * would (N-02), so those rules are mirrored below from `packages/web/src/routes/new-task-form.ts`,
 * `new-task-draft.ts`, `new-task-plan.ts`, `components/engine-pills.tsx` and
 * `lib/provider-status.ts`. The web package cannot ship in the published CLI (it is a private
 * workspace), so a copy is the only runtime option; `task-create.test.ts` runs the cockpit's own
 * functions against the same server state and fails when the two disagree.
 *
 * WHAT IS DELIBERATELY NOT MIRRORED. The composer's per-browser PRESELECTION memory (`lastTask`,
 * `lastWorktree`, `lastAutonomous`, `lastGenerateFollowups`) is excluded by the settings
 * classification: MCP states every option on the call. The workspace `composerDefaults` ARE read,
 * exactly as the composer reads them.
 *
 * WHERE THE COMPOSER IS SILENT, MCP REFUSES. The form cannot express some values a caller can send
 * — an unknown skill, a model that belongs to another runner, `worktree` on a planned start. The
 * composer's resolvers would quietly replace them; a silent substitution is the wrong answer for a
 * caller that cannot see a picker, so the tool refuses them instead and says why.
 *
 * NO FALLBACK, NO RETRY. A git task that asks for isolation and cannot get a worktree is marked
 * `failed` by `RunManager` before any step runs; it never falls back to the checkout. The tool
 * starts ONCE, reports the status it can see, and never re-issues a start on its own.
 */

const ACTIONS = ['start', 'plan', 'start_from_inbox', 'save_plan'] as const;
type Action = (typeof ACTIONS)[number];

/** The composer's field shapes are the CONTRACT's: the same zod definition, so the same bound and
 *  the same message the route answers with. */
const run = createRunInputBaseSchema.shape;

export const taskCreateInputSchema = z.strictObject({
  action: z
    .enum(ACTIONS)
    .default('start')
    .describe(
      '`start` (default) creates a task like the New task form. `plan` asks the planner for steps. `start_from_inbox` starts an Inbox entry. `save_plan` saves a step list as a project workflow.',
    ),
  // D-06 § 5.2: the one zod definition of an operation id lives in the contract; every mutating
  // tool takes it, and every one of them describes it in its own terms.
  operationId: operationIdSchema.describe(
    'Client-generated key for this operation (8–128 chars). Reuse it only to repeat the same operation.',
  ),
  prompt: z
    .string()
    .optional()
    .describe('The task text (start, plan; up to 100000 chars), or extra instructions (start_from_inbox; up to 20000 chars).'),
  images: run.images.describe('Attachments (start): up to 4, base64 images, plain text, markdown or PDF.'),
  source: z
    .strictObject({ source: z.enum(['skill', 'workflow']), ref: z.string().min(1) })
    .nullable()
    .optional()
    .describe('What the task runs (start): a skill or a workflow by name. Omit or null for the plain built-in `quick-task`.'),
  steps: run.steps.describe('An inline step list (start from a reviewed plan, or save_plan). Not combined with `source`.'),
  model: run.model.describe("Model id (start, start_from_inbox). Omit for the runner's configured default; '' means auto."),
  runner: run.runner.describe('Agent backend (start, start_from_inbox). Omit for the project default.'),
  agentProfile: run.agentProfile.describe("Agent account id (start only). Omit to follow the project's selection."),
  variants: run.variants.describe('1–3 competing runs (start). Above 1 needs git and always uses worktrees.'),
  worktree: run.worktree.describe('false runs in the repo working tree (start, single runs only). Omit for the workspace default.'),
  autonomous: run.autonomous.describe('true never pauses for the user (start). Omit for the workspace default.'),
  generateFollowups: run.generateFollowups.describe('false stops follow-up inbox entries (start). Omit for on.'),
  todoId: run.todoId.describe('The Inbox entry: the one to start (start_from_inbox), or the one this task came from (start).'),
  name: z.string().optional().describe('Workflow name (save_plan, up to 80 chars).'),
  description: z.string().optional().describe('Workflow description (save_plan).'),
  overwrite: z.boolean().optional().describe('save_plan: replace an existing workflow of that name. Ask the user first.'),
});
type TaskCreateArgs = z.output<typeof taskCreateInputSchema>;
type ArgKey = Exclude<keyof TaskCreateArgs, 'action' | 'operationId'>;

/** Which options each action takes. The Inbox start is NARROWER than the composer (I-026): runner,
 *  model and instructions, and no agent account. */
const ACTION_FIELDS: Record<Action, readonly ArgKey[]> = {
  start: ['prompt', 'images', 'source', 'steps', 'model', 'runner', 'agentProfile', 'variants', 'worktree', 'autonomous', 'generateFollowups', 'todoId'],
  plan: ['prompt'],
  start_from_inbox: ['todoId', 'prompt', 'runner', 'model'],
  save_plan: ['name', 'description', 'steps', 'overwrite'],
};

/** A planned start sends what `buildPlannedRunBody` sends: no source, no account, and the run-mode
 *  toggles stay at the server's defaults (plan-first is interactive and isolated). */
const PLANNED_START_EXCLUDES: readonly ArgKey[] = ['source', 'agentProfile', 'worktree', 'autonomous'];

/**
 * What this tool needs beyond the base context: the running service's in-process entry, the same
 * `ServiceDispatch` the shared adapter (#89) takes. The socket wiring that passes it in belongs to
 * the session work; until it does, the tool answers that it is not connected rather than guessing.
 */
export interface TaskCreateContext extends McpToolContext {
  readonly service?: ServiceDispatch;
}

export const taskCreateTool = defineTool({
  name: 'task_create',
  title: 'Create or plan a task',
  description: [
    "Create a task in this project with the New task form's options, defaults and validation, plan one first, start an Inbox entry, or save a planned step list as a workflow.",
    'Options you omit resolve exactly as the form resolves them for this project. `start` returns promptly with the run id and status `accepted`; it does not wait for the task, so read the task status separately.',
    'A git task that asks for a worktree and cannot get one is marked failed before any step runs; it never falls back to the checkout.',
  ].join(' '),
  inputSchema: taskCreateInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async call(args, ctx) {
    const service = (ctx as TaskCreateContext).service;
    if (!service) {
      return errorResult('task_create is not connected to the xezar service in this session.');
    }
    const refused = fieldRefusal(args);
    if (refused) return errorResult(refused);
    const api = scopedClient(service, ctx.project.id);
    switch (args.action) {
      case 'start':
        return startTask(args, api, new McpServiceAdapter({ projectId: ctx.project.id, service }));
      case 'plan':
        return planTask(args, api);
      case 'start_from_inbox':
        return startFromInbox(args, api);
      case 'save_plan':
        return savePlan(args, api);
    }
  },
});

function fieldRefusal(args: TaskCreateArgs): string | null {
  const allowed = new Set<ArgKey>(ACTION_FIELDS[args.action]);
  const sent = (Object.keys(args) as (keyof TaskCreateArgs)[]).filter(
    (key): key is ArgKey => key !== 'action' && key !== 'operationId' && args[key] !== undefined,
  );
  const foreign = sent.filter((key) => !allowed.has(key));
  if (foreign.length > 0) {
    return `action "${args.action}" does not take: ${foreign.join(', ')}`;
  }
  if (args.action === 'start' && args.steps !== undefined) {
    const planned = sent.filter((key) => PLANNED_START_EXCLUDES.includes(key));
    if (planned.length > 0) {
      return `a start from a step list takes no ${planned.join(', ')} — a planned start runs interactively in a worktree, as the plan review does`;
    }
  }
  if (args.action === 'start_from_inbox' && args.todoId === undefined) {
    return 'action "start_from_inbox" needs the todoId of the Inbox entry';
  }
  return null;
}

// ---- the service seam --------------------------------------------------------------------------

/** The adapter's in-process transport, for the read and write routes its closed table does not
 *  name. Same `host`, same absent `Origin`, same scoped prefix — the request never leaves the
 *  process and no argument chooses the project. */
function client(service: ServiceDispatch) {
  return hc<AppType>('http://127.0.0.1', {
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('host', '127.0.0.1');
      headers.delete('origin');
      const url = input instanceof Request ? input.url : String(input);
      return service.request(url, { ...init, headers });
    },
  });
}

function scopedClient(service: ServiceDispatch, projectId: string) {
  const api = client(service).api.v1;
  return { workspace: api, project: api.p[':projectId'], param: { projectId } };
}
type Api = ReturnType<typeof scopedClient>;

type Settled<T> = { ok: true; status: number; value: T } | { ok: false; status: number; error: string };

async function settle<T>(pending: Promise<Response>): Promise<Settled<T>> {
  let res: Response;
  try {
    res = await pending;
  } catch {
    return { ok: false, status: 500, error: 'the service did not answer' };
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok && body !== undefined) return { ok: true, status: res.status, value: body as T };
  const error =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `service answered ${res.status}`;
  return { ok: false, status: res.status, error };
}

/** Everything the composer reads before it enables Start, fetched the way it fetches it. */
async function composerState(api: Api) {
  const [providers, config, workspace, repo, health] = await Promise.all([
    settle<{ providers: { provider: string; status: string; enabled?: boolean }[] }>(
      api.workspace.providers.status.$get({ query: {} }),
    ),
    settle<{ defaultRunner?: Runner; defaultModels?: Partial<Record<Runner, string>>; modelsLocked?: boolean }>(
      api.project.config.$get({ param: api.param }),
    ),
    settle<{
      composerDefaults?: {
        autonomous?: boolean | null;
        worktree?: boolean | null;
        inheritedAutonomous?: boolean | 'source-dependent';
        inheritedWorktree?: boolean;
      };
    }>(api.workspace.workspace.config.$get()),
    settle<{ info: unknown }>(api.project.repo.$get({ param: api.param })),
    settle<{ capabilities: { followups: boolean } }>(api.workspace.health.$get()),
  ]);
  return { providers, config, workspace, repo, health };
}

// ---- the composer's rules, mirrored (see the module comment) -------------------------------------

const RUNNER_ORDER: readonly Runner[] = ['claude', 'codex', 'opencode', 'pi'];

/** `usableRunners` (web `lib/provider-status.ts`): enabled AND connected, in catalog order. */
function usableRunners(rows: readonly { provider: string; status: string; enabled?: boolean }[]): Runner[] {
  const usable = new Set(rows.filter((row) => row.enabled === true && row.status === 'connected').map((row) => row.provider));
  return RUNNER_ORDER.filter((runner) => usable.has(runner));
}

/** `resolveRunner` (web `new-task-form.ts`). */
function resolveRunner(available: readonly Runner[], preferred: Runner): Runner {
  if (available.includes(preferred)) return preferred;
  return available[0] ?? 'claude';
}

/** `runnerOverride` (web `new-task-form.ts`): an explicit pick always rides the request. */
function runnerOverride(runner: Runner, defaultRunner: Runner | undefined, explicit: boolean): Runner | undefined {
  return !explicit && runner === defaultRunner ? undefined : runner;
}

/** `resolveModel(null, …)` (web `new-task-form.ts`): the configured per-runner default when it is
 *  not recognizably another runner's, else auto. */
function defaultModel(runner: Runner, defaults: Partial<Record<Runner, string>> | undefined): string {
  const preset = defaults?.[runner];
  return preset !== undefined && preset !== '' && !modelConflictsWithRunner(preset, runner) ? preset : '';
}

/** `resolveComposerRunMode` (web `new-task-draft.ts`), for a composer that is not in plan-first. */
function resolveRunMode(input: {
  hasGit: boolean;
  variants: number;
  explicitAutonomous: boolean | null;
  explicitWorktree: boolean | null;
  interactive?: boolean;
  configuredAutonomous: boolean | 'source-dependent';
  configuredWorktree: boolean;
  source: 'skill' | 'workflow';
}): { autonomous: boolean; worktree: boolean } {
  const autonomousFallback =
    input.configuredAutonomous === 'source-dependent' ? input.source === 'skill' : input.configuredAutonomous;
  const recommended = input.interactive === true ? false : undefined;
  const autonomous = input.explicitAutonomous ?? recommended ?? autonomousFallback;
  const worktree = !input.hasGit
    ? false
    : input.variants > 1
      ? true
      : (input.explicitWorktree ?? recommended ?? input.configuredWorktree);
  return { autonomous, worktree };
}

const QUICK_TASK = 'quick-task';

type TaskSource = { source: 'skill' | 'workflow'; ref: string };

/** `buildCreateRunBody` (web `new-task-form.ts`), key for key. */
function composerRunBody(opts: {
  task: string;
  source: TaskSource | null;
  model: string;
  modelsLocked: boolean;
  runner: Runner;
  runnerExplicit: boolean;
  defaultRunner: Runner | undefined;
  agentProfile: string | undefined;
  variants: number;
  images: CreateRunInput['images'];
  worktree: boolean;
  autonomous: boolean;
  generateFollowups: boolean;
  todoId: string | undefined;
}): CreateRunInput {
  const images = opts.images ?? [];
  return {
    task: opts.task,
    ...(opts.source?.source === 'skill'
      ? { steps: [{ id: 'task', name: opts.source.ref, skill: opts.source.ref, prompt: '{{task}}' }] }
      : { workflow: opts.source?.ref ?? QUICK_TASK }),
    model: opts.modelsLocked ? undefined : opts.model || undefined,
    runner: runnerOverride(opts.runner, opts.defaultRunner, opts.runnerExplicit),
    agentProfile: opts.agentProfile || undefined,
    variants: opts.variants > 1 ? opts.variants : undefined,
    images: images.length > 0 ? [...images] : undefined,
    worktree: opts.worktree === false && opts.variants <= 1 ? false : undefined,
    autonomous: opts.autonomous === true ? true : undefined,
    generateFollowups: opts.generateFollowups === false ? false : undefined,
    todoId: opts.todoId || undefined,
  };
}

/** `buildPlannedRunBody` (web `new-task-plan.ts`), key for key. */
function plannedRunBody(opts: {
  task: string;
  steps: NonNullable<CreateRunInput['steps']>;
  model: string;
  modelsLocked: boolean;
  runner: Runner;
  runnerExplicit: boolean;
  defaultRunner: Runner | undefined;
  variants: number;
  images: CreateRunInput['images'];
  generateFollowups: boolean;
  todoId: string | undefined;
}): CreateRunInput {
  const images = opts.images ?? [];
  return {
    task: opts.task,
    steps: [...opts.steps],
    model: opts.modelsLocked ? undefined : opts.model || undefined,
    runner: runnerOverride(opts.runner, opts.defaultRunner, opts.runnerExplicit),
    variants: opts.variants > 1 ? opts.variants : undefined,
    images: images.length > 0 ? [...images] : undefined,
    generateFollowups: opts.generateFollowups === false ? false : undefined,
    todoId: opts.todoId || undefined,
  };
}

/** JSON drops `undefined`; strip it here too so the body is exactly what goes on the wire. */
function compact<T extends object>(body: T): T {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) as T;
}

// ---- results (D-05 § 6.8: the text block is a compact JSON object and is authoritative) ----------

type McpStatus = 'accepted' | 'running' | 'done' | 'failed' | 'cancelled' | 'conflict';

function statusOf(status: RunRecord['status']): McpStatus {
  switch (status) {
    case 'queued':
      return 'accepted';
    case 'done':
    case 'failed':
    case 'cancelled':
      return status;
    default:
      return 'running';
  }
}

function jsonResult(body: Record<string, unknown>): McpToolResult {
  return textResult(JSON.stringify(body), body);
}

/** A 409 is a business conflict — an ordinary result with `status: "conflict"` (D-05). Anything
 *  else the service refused is an argument the caller must change: an error result. */
function refusal(operationId: string, status: number, error: string): McpToolResult {
  if (status === 409) return jsonResult({ accepted: false, operationId, status: 'conflict', error });
  const body = { accepted: false, operationId, error };
  return errorResult(JSON.stringify(body), body);
}

// ---- actions -----------------------------------------------------------------------------------

async function startTask(args: TaskCreateArgs, api: Api, adapter: McpServiceAdapter): Promise<McpToolResult> {
  const { operationId } = args;
  const [state, skills, workflows] = await Promise.all([
    composerState(api),
    settle<{ name: string; interactive?: true }[]>(api.project.skills.$get({ param: api.param, query: {} })),
    settle<{ workflows: { name: string }[] }>(api.project.workflows.$get({ param: api.param })),
  ]);

  // The composer's two gates: providers resolved with a usable runner, and the catalogs loaded.
  if (!state.providers.ok) return refusal(operationId, 409, 'Provider authentication could not be verified.');
  const runners = usableRunners(state.providers.value.providers);
  if (runners.length === 0) return refusal(operationId, 409, 'Connect an agent provider before starting a task.');
  if (!skills.ok || !workflows.ok) return errorResult('The workflows and skills could not be read — try again.');
  if (!state.config.ok) return errorResult('The project settings could not be read — try again.');

  const source = args.source ?? null;
  const skill = source?.source === 'skill' ? skills.value.find((s) => s.name === source.ref) : undefined;
  if (source?.source === 'skill' && !skill) {
    return errorResult(JSON.stringify({ accepted: false, operationId, error: `unknown skill: ${source.ref}` }));
  }
  if (source?.source === 'workflow' && !workflows.value.workflows.some((w) => w.name === source.ref)) {
    return errorResult(JSON.stringify({ accepted: false, operationId, error: `unknown workflow: ${source.ref}` }));
  }

  const config = state.config.value;
  const defaultRunner = config.defaultRunner;
  // An explicit runner rides as sent: a disconnected one gets the server's own 409 rather than a
  // quiet swap to another backend.
  const runner = args.runner ?? resolveRunner(runners, defaultRunner ?? 'claude');
  const modelsLocked = config.modelsLocked === true;
  if (args.model !== undefined && !modelsLocked && modelConflictsWithRunner(args.model, runner)) {
    return errorResult(
      JSON.stringify({ accepted: false, operationId, error: `model "${args.model}" belongs to another runner than ${runner}` }),
    );
  }
  // A model sent under the lock goes to the route, which answers its own 409 (I-007).
  const model = args.model ?? (modelsLocked ? '' : defaultModel(runner, config.defaultModels));
  const sendModel = modelsLocked && args.model !== undefined && args.model.trim() !== '';

  // Loading or failing, the composer assumes git and an enabled inbox so its controls do not
  // flicker; the same fallbacks apply here.
  const hasGit = !state.repo.ok || state.repo.value.info !== null;
  const followupsOn = !state.health.ok || state.health.value.capabilities.followups;
  const defaults = state.workspace.ok ? state.workspace.value.composerDefaults : undefined;
  // Variants are sent as asked: without git the route refuses them (I-008), where the composer
  // would have disabled the picker.
  const variants = args.variants ?? 1;
  const mode = resolveRunMode({
    hasGit,
    variants,
    explicitAutonomous: args.autonomous ?? null,
    explicitWorktree: args.worktree ?? null,
    interactive: skill?.interactive,
    configuredAutonomous: defaults?.autonomous ?? defaults?.inheritedAutonomous ?? 'source-dependent',
    configuredWorktree: defaults?.worktree ?? defaults?.inheritedWorktree ?? true,
    source: source?.source ?? 'workflow',
  });
  const generateFollowups = followupsOn ? (args.generateFollowups ?? true) : false;

  const notes: string[] = [];
  if (args.worktree === false && variants > 1) notes.push('worktree forced on: parallel variants always use isolated worktrees');
  if (args.worktree === true && !hasGit) notes.push('no git repository: the task runs in place');
  if (args.generateFollowups === true && !followupsOn) notes.push('the follow-up inbox is off on this xezar: the task runs without follow-ups');

  const common = {
    task: args.prompt ?? '',
    model,
    modelsLocked: modelsLocked && !sendModel,
    runner,
    runnerExplicit: args.runner !== undefined,
    defaultRunner,
    variants,
    images: args.images,
    generateFollowups,
    todoId: args.todoId,
  };
  const body = compact(
    args.steps !== undefined
      ? plannedRunBody({ ...common, steps: args.steps })
      : composerRunBody({ ...common, source, agentProfile: args.agentProfile, worktree: mode.worktree, autonomous: mode.autonomous }),
  );

  const started = await adapter.startRun(body as Parameters<McpServiceAdapter['startRun']>[0]);
  if (!started.ok) return refusal(operationId, started.status, started.error);

  const records = runsOf(started.value);
  const first = records[0];
  if (!first) return errorResult('The service accepted the task but named no run.');
  // One read back, never a retry: an isolation failure is already recorded when it is this fast.
  const current = await adapter.getRun(first.id);
  const record = current.ok ? (current.value as RunRecord) : first;
  const status = statusOf(record.status);

  return jsonResult({
    accepted: true,
    operationId,
    status,
    subject: { type: 'run', id: first.id },
    ...(records.length > 1 ? { variants: records.map((r) => r.id) } : {}),
    ...(status === 'failed' && record.error ? { error: record.error } : {}),
    effective: {
      source: args.steps !== undefined ? { steps: args.steps.length } : (source ?? { source: 'workflow', ref: QUICK_TASK }),
      runner,
      // Under the lock no model rides the request: the agent's own settings choose, not "auto".
      model: modelsLocked ? 'native settings' : (body.model ?? 'auto'),
      ...(args.agentProfile ? { agentProfile: args.agentProfile } : {}),
      variants,
      worktree: args.steps !== undefined ? hasGit : mode.worktree,
      autonomous: args.steps !== undefined ? false : mode.autonomous,
      generateFollowups,
    },
    ...(notes.length > 0 ? { notes } : {}),
  });
}

function runsOf(value: StartRunValue): RunRecord[] {
  return ('runs' in value ? value.runs : [value]) as RunRecord[];
}

async function planTask(args: TaskCreateArgs, api: Api): Promise<McpToolResult> {
  const planned = await settle<{ name?: string; steps: unknown[]; rationale: string; fallback: boolean }>(
    api.project.plan.$post({ param: api.param, json: { task: args.prompt ?? '' } }),
  );
  if (!planned.ok) return refusal(args.operationId, planned.status, planned.error);
  const { name, steps, rationale, fallback } = planned.value;
  return jsonResult({
    operationId: args.operationId,
    status: 'done',
    ...(name ? { name } : {}),
    steps,
    rationale,
    fallback,
    ...(fallback ? { notes: ['the planner was unavailable: this is the one-step quick-task fallback'] } : {}),
  });
}

async function startFromInbox(args: TaskCreateArgs, api: Api): Promise<McpToolResult> {
  const { operationId } = args;
  const todoId = args.todoId ?? '';
  // Same rule as the adapter's run ids: a dot segment would resolve to a different route.
  if (todoId === '.' || todoId === '..' || todoId.includes('/')) {
    return errorResult(JSON.stringify({ accepted: false, operationId, error: `not an inbox entry id: ${JSON.stringify(todoId)}` }));
  }
  const state = await composerState(api);
  // The Inbox card's gate (`canRun`) is the composer's provider gate.
  if (!state.providers.ok) return refusal(operationId, 409, 'Provider authentication could not be verified.');
  const runners = usableRunners(state.providers.value.providers);
  if (runners.length === 0) return refusal(operationId, 409, 'Connect an agent provider before starting a task.');
  if (!state.config.ok) return errorResult('The project settings could not be read — try again.');
  const config = state.config.value;
  // `useResolvedEngine` + `engineBody` (web `components/engine-pills.tsx`).
  const runner = args.runner ?? resolveRunner(runners, config.defaultRunner ?? runners[0] ?? 'claude');
  const modelsLocked = config.modelsLocked === true;
  if (args.model !== undefined && !modelsLocked && modelConflictsWithRunner(args.model, runner)) {
    return errorResult(
      JSON.stringify({ accepted: false, operationId, error: `model "${args.model}" belongs to another runner than ${runner}` }),
    );
  }
  const model = args.model ?? (modelsLocked ? '' : defaultModel(runner, config.defaultModels));
  const sendModel = modelsLocked && args.model !== undefined && args.model.trim() !== '';
  const body = compact({
    runner: runnerOverride(runner, config.defaultRunner, args.runner !== undefined),
    model: modelsLocked && !sendModel ? undefined : model || undefined,
    // The route trims and bounds it (20000); the card sends the trimmed note or nothing.
    prompt: args.prompt?.trim() || undefined,
  });
  const started = await settle<{ run: RunRecord }>(
    api.project.todos[':id'].start.$post({ param: { ...api.param, id: todoId }, json: body }),
  );
  if (!started.ok) return refusal(operationId, started.status, started.error);
  const record = started.value.run;
  return jsonResult({
    accepted: true,
    operationId,
    status: statusOf(record.status),
    subject: { type: 'run', id: record.id },
    effective: { runner, model: body.model ?? 'auto' },
  });
}

async function savePlan(args: TaskCreateArgs, api: Api): Promise<McpToolResult> {
  const { operationId } = args;
  const saved = await settle<{ name: string }>(
    api.project.workflows.$post({
      param: api.param,
      json: compact({
        name: args.name ?? '',
        description: args.description,
        steps: args.steps,
        overwrite: args.overwrite,
      }) as Parameters<Api['project']['workflows']['$post']>[0]['json'],
    }),
  );
  if (!saved.ok) {
    // The route's 409 names the absolute file path; the caller needs the decision, not the path.
    if (saved.status === 409) {
      return jsonResult({
        accepted: false,
        operationId,
        status: 'conflict',
        exists: true,
        error: 'a workflow with this name already exists',
        guidance: 'ask the user, then call again with overwrite: true to replace it',
      });
    }
    return refusal(operationId, saved.status, saved.error);
  }
  return jsonResult({ accepted: true, operationId, status: 'done', subject: { type: 'workflow', id: saved.value.name } });
}
