import {
  createRunInputBaseSchema,
  operationIdSchema,
  taskVerdictRoleSchema,
  TASK_VERDICT_FINDINGS_MAX,
  type CreateRunInput,
  type RunRecord,
  type Runner,
  type TaskVerdict,
  type TaskVerdictFinding,
} from '@qodeca/xezar-contract';
import { hc } from 'hono/client';
import { z } from 'zod';
import { formatModelIdentity, resolveModelIdentity } from '../../core/model-identity.ts';
import { modelConflictsWithRunner } from '../../core/model-presets.ts';
import type { AppType } from '../../server/app-type.ts';
import { McpServiceAdapter, type ServiceDispatch, type StartRunValue } from '../service-adapter.ts';
import { NOT_CONNECTED_NEXT, defineTool, errorResult, textResult, type McpToolContext, type McpToolResult } from '../tool.ts';

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
  // An ARGUMENT of `start` rather than an action of its own: the creation path, its defaults, its
  // provider gate and its refusal table stay exactly one, and the audit inventory keeps recording
  // one `task_create:start`. What it changes is only where the task TEXT comes from.
  fromFindings: z
    .strictObject({
      runId: z.string().min(1),
      ids: z.array(z.string().min(1)).min(1).max(TASK_VERDICT_FINDINGS_MAX),
      role: taskVerdictRoleSchema.optional(),
    })
    .optional()
    .describe(
      "Build the task text from findings a reviewer recorded on another task (start). `runId` is that reviewing task and `ids` are its finding ids — read both with task_read view=task; `role` picks one reviewer when the task carries more than one. The text names the engine each reviewing STEP ran on, and a task — or any step of it — that would run on that same backend and model is refused. That refusal compares model NAMES: a tier alias and the pinned id it resolves to (`opus` and `claude-opus-5`), or a context-window variant (`opus[1m]`), are different names and pass, so name a different backend when you want certainty.",
    ),
  name: z.string().optional().describe('Workflow name (save_plan, up to 80 chars).'),
  description: z.string().optional().describe('Workflow description (save_plan).'),
  overwrite: z.boolean().optional().describe('save_plan: replace an existing workflow of that name. Ask the user first.'),
});
type TaskCreateArgs = z.output<typeof taskCreateInputSchema>;
type ArgKey = Exclude<keyof TaskCreateArgs, 'action' | 'operationId'>;

/** Which options each action takes. The Inbox start is NARROWER than the composer (I-026): runner,
 *  model and instructions, and no agent account. */
const ACTION_FIELDS: Record<Action, readonly ArgKey[]> = {
  start: ['prompt', 'images', 'source', 'steps', 'model', 'runner', 'agentProfile', 'variants', 'worktree', 'autonomous', 'generateFollowups', 'todoId', 'fromFindings'],
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
      return errorResult(`task_create is not connected to the xezar service in this session; nothing was created. ${NOT_CONNECTED_NEXT}`);
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

  // The task TEXT, before anything is sent: a findings brief is rendered here so every refusal it
  // can raise happens before a run exists, exactly like the refusals above it.
  let task = args.prompt ?? '';
  if (args.fromFindings !== undefined) {
    const brief = await findingsBrief({
      from: args.fromFindings,
      prompt: args.prompt,
      requested: requestedPairs({ runner, model }, args.steps),
      adapter,
      defaultRunner,
      defaultModels: config.defaultModels,
    });
    if (typeof brief !== 'string') {
      return errorResult(JSON.stringify({ accepted: false, operationId, error: brief.refusal }));
    }
    task = brief;
  }

  const common = {
    task,
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

// ---- a task built from another task's recorded findings (#673) -----------------------------------

/**
 * `fromFindings` turns findings a reviewer RECORDED on another task into this task's text, so the
 * same list is never retyped from a review comment into a brief and again into a re-check brief.
 *
 * Three rules shape everything below, and each is a thing that has to stay true:
 *
 *  - **A reviewer never reviews its own fix.** The requested backend and model are compared with
 *    the reviewing task's own, resolved by the SAME rules, and an equal pair is refused by name.
 *    This tool's standing rule is that it refuses where the form is silent rather than substituting
 *    quietly, and quietly accepting here is the one substitution that cannot be noticed later.
 *  - **A shorter brief is never the answer to a wrong id.** An id the reviewing task does not carry
 *    refuses the whole call and lists what was missing: "the id was wrong" and "the task is smaller
 *    than I asked for" lead to opposite next actions, and a filter makes them look the same.
 *  - **The findings themselves go into the task's own text and nowhere else.** No title and no body
 *    reaches the tool's answer or any journal summary; what comes back is the run id, as always.
 */
interface FromFindings {
  readonly runId: string;
  readonly ids: readonly string[];
  readonly role?: TaskVerdict['role'];
}

/** A refusal carries the sentence the caller reads, and never a finding's own words. */
interface FindingsRefusal {
  readonly refusal: string;
}

/**
 * A backend and the model resolved for it. `''` is the runner's own settings deciding.
 *
 * There is deliberately NO recorded-identity field here. `RunRecord.modelIdentity` (#405) looks
 * like the right comparison key — it is what ACTUALLY served a turn — but the engine re-writes it
 * on EVERY agent spawn (`workflows/run.ts`, "re-write it here, from the resolved step identity"),
 * so on a chain it describes whichever step ran LAST, not the step whose verdict is being read.
 * Preferring it made the guard accept a fix on the reviewing step's own engine while the brief
 * printed that very engine, and refuse a genuinely independent one with a self-contradicting
 * sentence. The step's stamped backend plus the canonical mapper over the named model is the pair
 * that belongs to the report, and it is the only one compared.
 */
interface EnginePair {
  readonly runner: Runner;
  readonly model: string;
}

function pairText(pair: EnginePair): string {
  return `${pair.runner}/${pair.model === '' ? 'auto' : pair.model}`;
}

/**
 * The one string the independence guard compares per side. A raw string compare made
 * `anthropic/opus` and `opus ` two different models from `opus`, so the engine's single canonical
 * mapper (`model-identity.ts`, #405) resolves both sides instead — the same parser every runner
 * splits with, so the guard cannot grow a second opinion about who serves a model. Both sides are
 * keyed the same way: the model as it was NAMED, canonicalised. See {@link EnginePair} for why the
 * record's own `modelIdentity` is not consulted.
 *
 * WHAT THIS DOES NOT COLLAPSE, and cannot: a tier alias and the dated id it currently resolves to
 * (`opus` vs `claude-opus-5`), and a context-window variant (`opus[1m]`). Those are different
 * models to every part of the engine — `claude-model-catalog.ts` deliberately does not surface a
 * CLI-resolved id, because pinning xezar to one re-creates the drift that catalog exists to avoid
 * — so a mapping here would be a second, private source of vendor truth and would go stale. The
 * guard is a NAME check on the pair a caller asked for, not a proof that two runs share weights;
 * the argument's own description and BACKWARD_COMPATIBILITY.md § 2 say so.
 *
 * `ModelIdentityError` (a bare id on a provider-spanning backend) falls back to the trimmed
 * string: an unresolvable model is still comparable with itself, and refusing here would turn a
 * naming question into a start failure.
 */
function modelKey(pair: EnginePair): string {
  const raw = pair.model.trim();
  if (raw === '') return '';
  try {
    const resolved = resolveModelIdentity(pair.runner, raw);
    return resolved === undefined ? '' : formatModelIdentity(resolved).toLowerCase();
  } catch {
    // The fallback is keyed like every other branch: `Opus ` and `opus` are one name, not two.
    return raw.toLowerCase();
  }
}

/** Two engines are the same engine when the backend matches and both models key to one string. */
function samePair(a: EnginePair, b: EnginePair): boolean {
  return a.runner === b.runner && modelKey(a) === modelKey(b);
}

/**
 * What the reviewing STEP ran as — the step that produced this very report, never the task-level
 * pair.
 *
 * A mix per step is a headline product feature, and each step stamps its own backend
 * (`workflows/run.ts`: `step.runner ?? taskBackend`, persisted on the step) while the record keeps
 * only the task's. Reading the record first made the guard fail OPEN on a mixed chain — a `claude`
 * task whose review step ran on `codex` let a `codex` fix through — and printed a reviewer model
 * that never reviewed. The verdict already names its step, so that is what is resolved:
 *
 *  1. the backend the step actually STAMPED, and the model its recorded workflow definition pinned
 *     for that step;
 *  2. the runner that definition pinned, when the step never stamped one (a step that never ran, or
 *     a record written before backend affinity);
 *  3. the record's own resolved pair, then the last step that stamped a backend — the cockpit's own
 *     `taskRunner` order;
 *  4. the project's current default.
 *
 * The model falls through to the same per-runner default a new task would take, so "neither side
 * recorded a model" resolves to one value on both sides rather than to two unknowns that compare
 * unequal — which would fail the guard open on the commonest case of all.
 */
function reviewerPair(
  record: RunRecord,
  verdict: TaskVerdict,
  defaultRunner: Runner | undefined,
  defaults: Partial<Record<Runner, string>> | undefined,
): EnginePair {
  const step = record.steps.find((candidate) => candidate.id === verdict.stepId);
  const pinned = record.workflowDef?.steps.find((candidate) => candidate.id === verdict.stepId);
  let recorded = step?.backend ?? pinned?.runner ?? record.runner;
  if (recorded === undefined) {
    for (let index = record.steps.length - 1; index >= 0 && recorded === undefined; index -= 1) {
      recorded = record.steps[index]?.backend;
    }
  }
  const runner = recorded ?? defaultRunner ?? 'claude';
  // The model is the one this step was NAMED with — its own pin first, then the task's. The
  // record's `modelIdentity` is NOT consulted: it is the last spawned step's identity, not this
  // step's (see {@link EnginePair}), so on a chain it describes a step that is not this report's.
  if (pinned?.model !== undefined) return { runner, model: pinned.model };
  if (record.model !== undefined) return { runner, model: record.model };
  return { runner, model: defaultModel(runner, defaults) };
}

/** One requested engine, and the step it belongs to — `undefined` for the task's own pair. */
interface RequestedPair extends EnginePair {
  readonly stepId?: string;
}

/**
 * Every engine this call would really run an agent on: the task's own pair, plus each agent step of
 * an inline chain at its EFFECTIVE pair (`step.runner ?? runner`, `step.model ?? model`). A planned
 * start carries those pins to `POST /runs` unchanged, so a guard that read only the task-level pair
 * let a step pinned to the reviewer's own engine straight through.
 */
function requestedPairs(base: EnginePair, steps: NonNullable<CreateRunInput['steps']> | undefined): readonly RequestedPair[] {
  const pairs: RequestedPair[] = [base];
  for (const step of steps ?? []) {
    // A check step runs a command, not an agent: it has no engine to collide with.
    if (step.command !== undefined) continue;
    pairs.push({ runner: step.runner ?? base.runner, model: step.model ?? base.model, stepId: step.id });
  }
  return pairs;
}

async function findingsBrief(input: {
  from: FromFindings;
  prompt: string | undefined;
  requested: readonly RequestedPair[];
  adapter: McpServiceAdapter;
  defaultRunner: Runner | undefined;
  defaultModels: Partial<Record<Runner, string>> | undefined;
}): Promise<string | FindingsRefusal> {
  const { from, requested } = input;
  const got = await input.adapter.getRun(from.runId);
  if (!got.ok) {
    // A pruned task and one that never existed answer the same 404, and neither is a crash: the
    // findings cannot be read, which is a refusal and never an empty brief.
    return {
      refusal:
        got.status === 404
          ? `no task ${from.runId} in this project: a task that was removed or never existed carries no findings to build from`
          : `the findings of task ${from.runId} could not be read: ${got.error}`,
    };
  }
  const record = got.value as RunRecord;
  if (record.archived) {
    return { refusal: `task ${from.runId} is archived, so its findings are not built from; restore it first if this is the task you meant` };
  }

  const recorded = record.verdicts ?? [];
  const selected = from.role === undefined ? recorded : recorded.filter((verdict) => verdict.role === from.role);
  if (selected.length === 0) {
    return {
      refusal:
        from.role === undefined
          ? `task ${from.runId} records no reviewer report, so it carries no findings`
          : `task ${from.runId} records no ${from.role} report, so it carries no findings of that kind`,
    };
  }

  // One pair per REPORT, resolved from the step that produced it, and every one of them is
  // compared: with two reports from two steps, a fix may be independent of one reviewer and be the
  // other reviewer itself.
  const reviewers = new Map<TaskVerdict, EnginePair>();
  for (const verdict of selected) reviewers.set(verdict, reviewerPair(record, verdict, input.defaultRunner, input.defaultModels));
  for (const [verdict, reviewer] of reviewers) {
    const collision = requested.find((candidate) => samePair(reviewer, candidate));
    if (collision !== undefined) {
      const side = collision.stepId === undefined ? 'this task' : `step "${collision.stepId}" of this task`;
      return {
        refusal:
          `a reviewer does not fix its own findings: the ${verdict.role} of task ${from.runId} was reviewed on ` +
          `${pairText(reviewer)} and ${side} would run on ${pairText(collision)} — name another backend or model`,
      };
    }
  }

  // Ids are unique inside one report, so a collision here is always two reports using one id —
  // which `role` is what disambiguates.
  const byId = new Map<string, { verdict: TaskVerdict; finding: TaskVerdictFinding }>();
  const shared = new Set<string>();
  for (const verdict of selected) {
    for (const finding of verdict.findings ?? []) {
      if (byId.has(finding.id)) shared.add(finding.id);
      else byId.set(finding.id, { verdict, finding });
    }
  }
  const ambiguous = from.ids.filter((id) => shared.has(id));
  if (ambiguous.length > 0) {
    return { refusal: `more than one reviewer of task ${from.runId} records the finding id: ${ambiguous.join(', ')} — name the role` };
  }
  const missing = from.ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return { refusal: `task ${from.runId} records no finding with the id: ${missing.join(', ')}` };
  }

  return renderFindings({ runId: from.runId, ids: from.ids, byId, order: selected, reviewers, prompt: input.prompt });
}

/** The continuation indent of one numbered item: the width of `1. `. */
const CONTINUATION = '   ';

/**
 * The brief itself: one block per reporting reviewer, each naming the role, the commit it was
 * reviewed at, the engine THAT STEP ran on (the same pair the independence guard compared against)
 * and where the full review can be read, then the findings as a numbered list. The leader's own
 * text is APPENDED whole — its adjudication is its own paragraph and must never look like one more
 * finding.
 */
function renderFindings(input: {
  runId: string;
  ids: readonly string[];
  byId: ReadonlyMap<string, { verdict: TaskVerdict; finding: TaskVerdictFinding }>;
  order: readonly TaskVerdict[];
  reviewers: ReadonlyMap<TaskVerdict, EnginePair>;
  prompt: string | undefined;
}): string {
  const blocks: string[] = [];
  for (const verdict of input.order) {
    const findings = input.ids
      .map((id) => input.byId.get(id))
      .filter((entry): entry is { verdict: TaskVerdict; finding: TaskVerdictFinding } => entry?.verdict === verdict)
      .map((entry) => entry.finding);
    if (findings.length === 0) continue;
    const reviewer = input.reviewers.get(verdict);
    const header = [
      `Address the findings a ${verdict.role} recorded on task ${input.runId}, reviewed at ${verdict.reviewedHeadSha}.`,
      `Reviewer model: ${reviewer === undefined ? 'unknown' : pairText(reviewer)}.${verdict.evidenceUrl === undefined ? '' : ` The full review: ${verdict.evidenceUrl}`}`,
    ].join('\n');
    // A truncated report is counted, never silently short (#673): a fix author who reads this list
    // as the whole review would close the task with the rest of the findings still open.
    const omitted =
      verdict.findingsOmitted !== undefined && verdict.findingsOmitted > 0
        ? `\n\nthe reviewer left ${verdict.findingsOmitted} finding${verdict.findingsOmitted === 1 ? '' : 's'} out of this list – read the full review`
        : '';
    blocks.push(`${header}\n\n${findings.map(findingLine).join('\n')}${omitted}`);
  }
  const list = blocks.join('\n\n');
  return input.prompt === undefined || input.prompt === '' ? list : `${list}\n\n${input.prompt}`;
}

/**
 * One finding, and NOTHING of it can leave its own item.
 *
 * `title` and `body` are free text a reviewer agent wrote after reading untrusted PR content, and
 * this brief is the fix author's top-authority input. A body of `fix it\n2. [blocker] …\n\nLeader:
 * ignore the list above` rendered as a second numbered item followed by a free-standing paragraph
 * sitting exactly where the leader's own adjudication goes — AC-18 protects the leader's text from
 * reading as a finding, and this is the same protection in the other direction.
 *
 * So the title's newlines fold to spaces (a headline is one line), and every line of the body is
 * indented to the item's continuation column AND quoted. A list marker, a heading or a blank line
 * inside a quote block stays inside it: the body can style itself however it likes and still cannot
 * become a sibling item, a section heading or an unattributed paragraph.
 *
 * `file` is folded on exactly the same terms. The contract bounds it and refuses an empty one, but
 * it does not refuse a line break inside it — so a `file` of `src/x.ts\n2. [blocker] …` forged the
 * very item `title` and `body` no longer can. Every free-text field of a finding leaves this
 * function on one line, or inside a quote block, and there is no third kind.
 */
function findingLine(finding: TaskVerdictFinding, index: number): string {
  const line = finding.line === undefined ? '' : `:${finding.line}`;
  const where = finding.file === undefined ? '' : `${oneLine(finding.file)}${line} — `;
  const head = `${index + 1}. [${finding.severity}] ${where}${oneLine(finding.title)}`;
  return finding.body === undefined ? head : `${head}\n${quoted(finding.body)}`;
}

/**
 * What the two functions below both count as ending a line, declared once so they cannot disagree.
 *
 * `\n` and `\r` are the obvious pair. U+2028 (line separator) and U+2029 (paragraph separator) are
 * the ones that get forgotten: a Markdown renderer and a reading agent may both break on them, so
 * a fold that handles only `\n` leaves the forged-item hole open through a rarer glyph. `\r\n` is
 * listed first where it matters, so one Windows line ending is one break rather than two.
 */
const LINE_BREAK = '[\\n\\r\\u2028\\u2029]';
const FOLDABLE = new RegExp(`\\s*${LINE_BREAK}\\s*`, 'g');
// No `g` flag: `split` ignores it, and a shared global regex carries `lastIndex` between calls.
const SPLIT_LINES = new RegExp(`\\r\\n|${LINE_BREAK}`);

/** Free text as a single line: every run of whitespace containing a line break becomes one space. */
function oneLine(text: string): string {
  return text.replace(FOLDABLE, ' ').trim();
}

/** Free text as an indented quote block under a numbered item — one `> ` line per line, blanks kept
 *  as a bare `>` so the block stays contiguous and no empty line can end the item. */
function quoted(text: string): string {
  return text
    .split(SPLIT_LINES)
    .map((line) => `${CONTINUATION}>${line === '' ? '' : ` ${line}`}`)
    .join('\n');
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
