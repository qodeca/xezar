import { lstat } from 'node:fs/promises';
import { mcpExpectedVersionSchema, operationIdSchema, runIdParamSchema, runnerSchema } from '@qodeca/xezar-contract';
import { hc, type InferResponseType } from 'hono/client';
import { z } from 'zod';
import type { RunRecord } from '../../runs/store.ts';
import type { AppType } from '../../server/app-type.ts';
import {
  openCursor,
  ownGroupMember,
  ownQueuedMessage,
  ownRun,
  ownSweep,
  ownWorktree,
  ownershipScope,
  sealCursor,
  type OwnershipProject,
  type OwnershipRefusal,
  type OwnershipScope,
} from '../resource-ownership.ts';
import { MCP_ORIGIN, McpServiceAdapter, type McpServiceResult, type ServiceDispatch } from '../service-adapter.ts';
import { staleRejectionIn } from '../stale-write.ts';
import { defineTool, errorResult, textResult, type McpToolContext, type McpToolResult } from '../tool.ts';

/**
 * The work-organisation tool (#93, F-07): inspect the queue, edit a queued brief and its queued
 * messages, rename, pin, archive, restore, delete, manage read state and Inbox items, and pick a
 * variant — exactly the set the cockpit offers, and nothing it does not. There is no dependency
 * graph and no priority field in xezar, so this tool has neither: the queue starts tasks oldest
 * first, and that order is reported, not editable.
 *
 * F-04: every action here — deletion and the variant pick included — runs without a confirmation
 * parameter. The cockpit's confirm dialog is a click, not a rule, so MCP does not reproduce it.
 * Business validation still applies, and it applies in the SAME place it does for the cockpit:
 * every operation is dispatched in-process into the service's own chained routes under the bound
 * project (N-02), through `McpServiceAdapter` where it already names the operation and through the
 * same narrowed, typed route table for the rest. No store, manager or file is touched here.
 *
 * Two preconditions live only in the cockpit today, not in the routes, and are mirrored here so an
 * MCP call has the outcome a UI click has (A-05):
 *   - archive is offered only when the task is not active (`isRunActive` in
 *     `packages/web/src/routes/task-thread/run-actions.ts`: queued, running or waiting). The
 *     route archives any status.
 *   - pick is enabled only when EVERY variant is terminal (`allTerminal` in
 *     `packages/web/src/routes/compare-variants.tsx`). The route refuses only an active WINNER, and
 *     would cancel a still-running loser.
 *
 * Results follow D-05 § 6.8: the text block is a compact JSON object and is the only carrier (no
 * `structuredContent`, so a list page's byte budget is not spent twice), a business refusal (409)
 * is an ordinary result with `status: "conflict"`, and `isError` is kept for input the leader must
 * correct and for genuine failures. Runs are returned as a slim projection, never the whole record.
 *
 * Ownership (F-02, #88): before anything is dispatched, every id the leader names — a task, a
 * queued message inside it, a variant group and EVERY member of it, a queue cursor — is proved to
 * be the bound project's by `resource-ownership.ts`, over a read-only snapshot of this project's
 * own task list taken through the same service. A refusal is one fixed `not found in this project`
 * that never echoes the id. The route would answer a foreign id with 404 on its own; what the
 * checks add is the record's FILESYSTEM reach: a task whose recorded worktree is not this
 * project's `.local/xezar/worktrees/<id>` (or is a symlink) is refused, so a delete or a pick can
 * never be steered into another tree. Bulk sweeps (`archive_finished`, `mark_all_read`) take no
 * caller ids: the candidate set is the bound project's own store, owned by construction — rule 3 of
 * #88's partial-success policy — and each applies to every candidate and says how many.
 *
 * Stale writes (#250, N-03): every action that changes ONE task — and the variant pick, whose
 * version is the kept variant's (#271) — requires the `expectedVersion` a
 * `task_read` of that task handed out, and sends it to the route, which compares it with the
 * task's current version in the same synchronous stretch as the store call. A task a human changed
 * since is refused with nothing applied (`status: "conflict"`, `error: "stale_version"`). The
 * bulk sweeps and the read-state flags take none: a sweep names no task, and `seenAt` is
 * presentation, which the version deliberately does not cover (D-06 § 4.3).
 */

/** The in-process service entry the tool dispatches through. `McpToolContext` does not carry it
 *  yet: whoever wires the service into the socket adds `service` to the context, and until then
 *  the tool answers that it is not connected rather than reaching around the services. */
type ServiceBoundContext = McpToolContext & { readonly service?: ServiceDispatch };

// D-09 B-01 and B-02: one tool result is at most 40 000 bytes and one list page at most 100 items.
const RESULT_BUDGET_BYTES = 40_000;
const PAGE_ITEMS = 100;
// How much of a queued brief / message a queue listing carries, in serialized bytes. Chosen so the
// largest possible item (a brief plus `MAX_QUEUED_MESSAGES` = 20 messages, B-07) stays near 10 KB,
// several items fit one page, and no item ever has to be split (B-03). A cut is always marked.
const BRIEF_PREVIEW_BYTES = 1_000;
const MESSAGE_PREVIEW_BYTES = 300;

/** The cockpit's "active" (`isRunActive`) and "terminal" (`TERMINAL_STATUSES`) sets. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'waiting']);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'review', 'cancelled']);

const ACTIONS = [
  'list_queue',
  'set_title',
  'edit_brief',
  'edit_queued_message',
  'remove_queued_message',
  'pin',
  'unpin',
  'archive',
  'restore',
  'archive_finished',
  'mark_read',
  'mark_unread',
  'mark_all_read',
  'delete',
  'start_inbox_item',
  'remove_inbox_item',
  'pick_variant',
] as const;
type Action = (typeof ACTIONS)[number];

type Field =
  | 'runId'
  | 'expectedVersion'
  | 'operationId'
  | 'title'
  | 'task'
  | 'messageId'
  | 'text'
  | 'todoId'
  | 'runner'
  | 'model'
  | 'prompt'
  | 'groupId'
  | 'cursor'
  | 'limit';
const FIELDS: readonly Field[] = [
  'runId',
  'expectedVersion',
  'operationId',
  'title',
  'task',
  'messageId',
  'text',
  'todoId',
  'runner',
  'model',
  'prompt',
  'groupId',
  'cursor',
  'limit',
];

/** Which arguments each action requires, and which it accepts besides. Anything else is refused.
 *  `expectedVersion` is required by every action that changes one task (#250) — a missing one is a
 *  validation refusal, never a write without the check.
 *  `operationId` is required by every action that CHANGES anything (D-06 § 5.2, #264), which here is
 *  every action but `list_queue`: that one reads, and a read has no effect to deduplicate. Giving a
 *  read an operation id would file a receipt whose replay answers with the receipt instead of the
 *  queue, so the read refuses it rather than accepting a key that makes the next call worse. */
const ACTION_FIELDS: Record<Action, { required: readonly Field[]; optional?: readonly Field[] }> = {
  list_queue: { required: [], optional: ['cursor', 'limit'] },
  set_title: { required: ['runId', 'expectedVersion', 'operationId', 'title'] },
  edit_brief: { required: ['runId', 'expectedVersion', 'operationId', 'task'] },
  edit_queued_message: { required: ['runId', 'expectedVersion', 'operationId', 'messageId', 'text'] },
  remove_queued_message: { required: ['runId', 'expectedVersion', 'operationId', 'messageId'] },
  pin: { required: ['runId', 'expectedVersion', 'operationId'] },
  unpin: { required: ['runId', 'expectedVersion', 'operationId'] },
  archive: { required: ['runId', 'expectedVersion', 'operationId'] },
  restore: { required: ['runId', 'expectedVersion', 'operationId'] },
  archive_finished: { required: ['operationId'] },
  mark_read: { required: ['runId', 'operationId'] },
  mark_unread: { required: ['runId', 'operationId'] },
  mark_all_read: { required: ['operationId'] },
  delete: { required: ['runId', 'expectedVersion', 'operationId'] },
  start_inbox_item: { required: ['todoId', 'operationId'], optional: ['runner', 'model', 'prompt'] },
  remove_inbox_item: { required: ['todoId', 'operationId'] },
  // The kept variant's version: the pick deletes every other variant's worktree and branch (#271).
  pick_variant: { required: ['groupId', 'runId', 'expectedVersion', 'operationId'] },
};

/** An id that is safe as ONE path segment: the route id rule, minus the dot segments a URL parser
 *  would resolve into a different route (the same guard `McpServiceAdapter` applies). */
const segmentId = (what: string) =>
  runIdParamSchema.shape.id.refine((id) => id !== '.' && id !== '..', { message: `not a ${what} id` });

const inputSchema = z
  .object({
    action: z.enum(ACTIONS).describe('What to do. See the tool description for each action.'),
    runId: segmentId('task').optional().describe('The task id. For pick_variant: the variant to keep.'),
    expectedVersion: mcpExpectedVersionSchema
      .optional()
      .describe(
        'Required by every action that changes one task (set_title, edit_brief, edit_queued_message, remove_queued_message, pin, unpin, archive, restore, delete) and by pick_variant: the `version` task_read gave you for that task — for pick_variant, the variant you keep. Echo it verbatim.',
      ),
    operationId: operationIdSchema
      .optional()
      .describe(
        'Client-generated key for this operation (8–128 chars). Required by every action except list_queue, which reads and takes none. Reuse it only to repeat the same operation: a repeat returns the first answer and organises nothing twice.',
      ),
    title: z.string().optional().describe('set_title: the new title.'),
    task: z.string().optional().describe('edit_brief: the replacement brief. Only while the task is queued.'),
    messageId: segmentId('message').optional().describe('edit_queued_message / remove_queued_message: the queued message id (list_queue shows them).'),
    text: z.string().optional().describe('edit_queued_message: the replacement text.'),
    todoId: segmentId('Inbox item').optional().describe('start_inbox_item / remove_inbox_item: the Inbox item id.'),
    runner: runnerSchema.optional().describe('start_inbox_item: the agent backend; omitted means the project default.'),
    model: z.string().optional().describe('start_inbox_item: the model; omitted means the backend default.'),
    prompt: z.string().optional().describe('start_inbox_item: extra instructions appended to the item.'),
    groupId: segmentId('variant group').optional().describe('pick_variant: the variant group id.'),
    cursor: z.string().min(1).max(2_048).optional().describe('list_queue: the `next` value of the previous page.'),
    limit: z.number().int().min(1).max(PAGE_ITEMS).optional().describe(`list_queue: at most this many items (default and maximum ${PAGE_ITEMS}).`),
  })
  // Strict, like every other tool's input: an invented key is an argument error, never dropped. A
  // stray `projectId` would otherwise read as scoping the call while it acts on the bound project.
  .strict()
  .superRefine((args, ctx) => {
    const spec = ACTION_FIELDS[args.action];
    for (const field of spec.required) {
      if (args[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: `${args.action} needs ${field}` });
    }
    const allowed = new Set<Field>([...spec.required, ...(spec.optional ?? [])]);
    for (const field of FIELDS) {
      if (args[field] !== undefined && !allowed.has(field)) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${args.action} does not take ${field}` });
      }
    }
  });
type Args = z.output<typeof inputSchema>;

// ---- the narrowed route table ----------------------------------------------------------------

/** The same in-process dispatch `McpServiceAdapter` uses: the request never leaves the process, it
 *  reaches the chained routes as a local non-browser caller, and it can only name routes under
 *  `/api/v1/p/<bound project>`. */
const scopedRoutes = (service: ServiceDispatch) =>
  hc<AppType>('http://127.0.0.1', {
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('host', '127.0.0.1');
      headers.delete('origin');
      return service.request(input instanceof Request ? input.url : String(input), { ...init, headers });
    },
  }).api.v1.p[':projectId'];

type Routes = ReturnType<typeof scopedRoutes>;
type RunRoutes = Routes['runs'][':id'];
type RunValue = InferResponseType<RunRoutes['read']['$post'], 200>;
type GroupValue = InferResponseType<Routes['groups'][':groupId']['$get'], 200>;
type PickValue = InferResponseType<Routes['groups'][':groupId']['pick']['$post'], 200>;
type StartTodoValue = InferResponseType<Routes['todos'][':id']['start']['$post'], 201>;
type ArchiveFinishedValue = InferResponseType<Routes['runs']['archive-finished']['$post'], 200>;
type ReadAllValue = InferResponseType<Routes['runs']['read-all']['$post'], 200>;
type DeleteRunValue = InferResponseType<RunRoutes['$delete'], 200>;
type QueuedMessageRoutes = RunRoutes['queued-messages'][':msgId'];
type EditQueuedMessageValue = InferResponseType<QueuedMessageRoutes['$patch'], 200>;
type RemoveQueuedMessageValue = InferResponseType<QueuedMessageRoutes['$delete'], 200>;
type RemoveTodoValue = InferResponseType<Routes['todos'][':id']['$delete'], 200>;

/** One project's work-organisation operations. Each is one named route; there is no raw path. */
class WorkOrganisation {
  readonly adapter: McpServiceAdapter;
  private readonly routes: Routes;

  constructor(
    private readonly projectId: string,
    service: ServiceDispatch,
  ) {
    this.adapter = new McpServiceAdapter({ projectId, service });
    this.routes = scopedRoutes(service);
  }

  setRead(id: string, read: boolean): Promise<McpServiceResult<RunValue>> {
    const run = this.routes.runs[':id'];
    const param = { projectId: this.projectId, id };
    return settle(read ? run.read.$post({ param }) : run.unread.$post({ param }), [200]);
  }

  archiveFinished(): Promise<McpServiceResult<ArchiveFinishedValue>> {
    return settle(this.routes.runs['archive-finished'].$post({ param: { projectId: this.projectId } }), [200]);
  }

  markAllRead(): Promise<McpServiceResult<ReadAllValue>> {
    return settle(this.routes.runs['read-all'].$post({ param: { projectId: this.projectId } }), [200]);
  }

  deleteRun(id: string, expectedVersion: string): Promise<McpServiceResult<DeleteRunValue>> {
    return settle(this.routes.runs[':id'].$delete({ param: { projectId: this.projectId, id }, json: { expectedVersion } }), [200]);
  }

  editQueuedMessage(id: string, msgId: string, text: string, expectedVersion: string): Promise<McpServiceResult<EditQueuedMessageValue>> {
    const param = { projectId: this.projectId, id, msgId };
    return settle(this.routes.runs[':id']['queued-messages'][':msgId'].$patch({ param, json: { text, expectedVersion } }), [200]);
  }

  removeQueuedMessage(id: string, msgId: string, expectedVersion: string): Promise<McpServiceResult<RemoveQueuedMessageValue>> {
    const param = { projectId: this.projectId, id, msgId };
    return settle(this.routes.runs[':id']['queued-messages'][':msgId'].$delete({ param, json: { expectedVersion } }), [200]);
  }

  getGroup(groupId: string): Promise<McpServiceResult<GroupValue>> {
    return settle(this.routes.groups[':groupId'].$get({ param: { projectId: this.projectId, groupId } }), [200]);
  }

  pick(groupId: string, runId: string, expectedVersion: string): Promise<McpServiceResult<PickValue>> {
    const param = { projectId: this.projectId, groupId };
    return settle(this.routes.groups[':groupId'].pick.$post({ param, json: { runId, expectedVersion } }), [200]);
  }

  startTodo(id: string, body: { runner?: Args['runner']; model?: string; prompt?: string }): Promise<McpServiceResult<StartTodoValue>> {
    return settle(this.routes.todos[':id'].start.$post({ param: { projectId: this.projectId, id }, json: body }), [201]);
  }

  removeTodo(id: string): Promise<McpServiceResult<RemoveTodoValue>> {
    return settle(this.routes.todos[':id'].$delete({ param: { projectId: this.projectId, id } }), [200]);
  }
}

/** The adapter's own mapping: a refusal keeps the service's status and message, and a success
 *  status without a JSON body is an error rather than an empty value. */
async function settle<T>(pending: Promise<Response>, success: readonly number[]): Promise<McpServiceResult<T>> {
  const res = await pending;
  const body: unknown = await res.json().catch(() => undefined);
  if (success.includes(res.status)) {
    if (body === undefined) {
      return { ok: false, origin: MCP_ORIGIN, status: 502, error: `service answered ${res.status} without a body` };
    }
    return { ok: true, origin: MCP_ORIGIN, status: res.status, value: body as T };
  }
  const error =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `service answered ${res.status}`;
  return { ok: false, origin: MCP_ORIGIN, status: res.status, error, body };
}

// ---- results ---------------------------------------------------------------------------------

/** The fields of a run record this tool reads — structural, so every route's run shape fits. */
interface RunLike {
  id: string;
  title?: string;
  titleSummary?: string;
  status: string;
  createdAt?: string;
  workflow?: string;
  runner?: string;
  model?: string;
  task?: string;
  archived?: boolean;
  pinned?: boolean;
  seenAt?: string;
  groupId?: string;
  variant?: string;
  worktreePath?: string;
  queuedMessages?: Array<{ id: string; text: string; images?: string[] }>;
}

/** What a leader needs to know about a task after an action — never the whole record (D-05). */
function slimRun(run: RunLike) {
  return {
    id: run.id,
    title: run.titleSummary ?? run.title ?? '',
    status: run.status,
    archived: run.archived === true,
    pinned: run.pinned === true,
    ...(run.seenAt !== undefined ? { seenAt: run.seenAt } : {}),
    ...(run.groupId !== undefined ? { groupId: run.groupId, variant: run.variant ?? '?' } : {}),
  };
}

const json = (value: unknown): string => JSON.stringify(value);
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

function done(action: Action, payload: Record<string, unknown>): McpToolResult {
  return textResult(json({ status: 'done', action, ...payload }));
}

/** A 409, or a cockpit precondition that did not hold: an ordinary result the leader reasons about
 *  (D-05 § 6.8), carrying the service's own reason. */
function conflict(action: Action, reason: string, extra: Record<string, unknown> = {}): McpToolResult {
  return textResult(json({ status: 'conflict', action, reason, ...extra }));
}

function refused(action: Action, result: { status: number; error: string; body?: unknown }): McpToolResult {
  // The task changed after the leader read it (#250): D-06 § 4.4's rejection, verbatim — nothing
  // was applied, and `currentVersion` makes the next read cheap. Never retried here (rule 3).
  const stale = staleRejectionIn(result.body);
  if (stale) return textResult(json({ ...stale, action }));
  if (result.status === 409) return conflict(action, result.error);
  return errorResult(`${action} was refused (${result.status}): ${result.error}`);
}

/** A prefix of `text` whose JSON encoding fits `maxBytes`, and whether anything was cut. */
function preview(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (bytes(json(text)) <= maxBytes) return { text, truncated: false };
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && bytes(json(text.slice(0, end))) > maxBytes) end = Math.floor(end * 0.8);
  // Never leave half a surrogate pair at the cut.
  if (end > 0 && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function queueItem(run: RunLike, position: number) {
  const brief = preview(run.task ?? '', BRIEF_PREVIEW_BYTES);
  return {
    position,
    id: run.id,
    title: run.titleSummary ?? run.title ?? '',
    ...(run.createdAt !== undefined ? { createdAt: run.createdAt } : {}),
    ...(run.workflow !== undefined ? { workflow: run.workflow } : {}),
    ...(run.runner !== undefined ? { runner: run.runner } : {}),
    ...(run.model !== undefined ? { model: run.model } : {}),
    brief: brief.text,
    briefChars: (run.task ?? '').length,
    ...(brief.truncated ? { briefTruncated: true } : {}),
    messages: (run.queuedMessages ?? []).map((m) => {
      const text = preview(m.text, MESSAGE_PREVIEW_BYTES);
      return {
        id: m.id,
        text: text.text,
        chars: m.text.length,
        ...(text.truncated ? { truncated: true } : {}),
        attachments: m.images?.length ?? 0,
      };
    }),
  };
}

/** The resource a queue cursor is sealed for (`sealCursor`): valid for this project's queue only. */
const QUEUE_CURSOR = 'queue';

function listQueue(scope: OwnershipScope, runs: readonly RunLike[], args: Args): McpToolResult {
  // Queue order is the scheduler's own: oldest `createdAt` first (`RunManager`'s FIFO). Two
  // starts inside one millisecond share a `createdAt`, and the scheduler then keeps them in
  // creation order — the order the store's list carries them in. The sort is stable so that tie
  // survives; breaking it by the random run id listed them in an order nothing starts them in.
  const ordered = [...runs].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  const queue = ordered.filter((r) => r.status === 'queued');
  let start = 0;
  if (args.cursor !== undefined) {
    // The cursor names the last task a page returned. It is sealed to this project and this
    // resource, so another project's cursor — or anything else — is one refusal.
    const opened = openCursor(scope, QUEUE_CURSOR, args.cursor);
    const anchorAt = opened.ok ? ordered.findIndex((r) => r.id === opened.value) : -1;
    if (anchorAt < 0) return errorResult('list_queue: invalid cursor — request the first page again');
    // Resume after the anchor's place in the whole list, which holds even once it has started.
    start = queue.length - ordered.slice(anchorAt + 1).filter((r) => r.status === 'queued').length;
  }
  const limit = args.limit ?? PAGE_ITEMS;
  const page = {
    status: 'done',
    action: 'list_queue',
    order: 'oldest first — the order this project starts queued tasks in',
    total: queue.length,
    items: [] as Array<ReturnType<typeof queueItem>>,
  };
  let index = start;
  for (; index < queue.length && page.items.length < limit; index++) {
    page.items.push(queueItem(queue[index]!, index + 1));
    // Reserve room for the `next` cursor the page would then need.
    if (bytes(json({ ...page, next: sealCursor(scope, QUEUE_CURSOR, queue[index]!.id) })) > RESULT_BUDGET_BYTES) {
      page.items.pop();
      break;
    }
  }
  const last = page.items.at(-1);
  const next = index < queue.length && last ? { next: sealCursor(scope, QUEUE_CURSOR, last.id) } : {};
  return textResult(json({ ...page, ...next }));
}

async function archive(ops: WorkOrganisation, run: RunLike, expectedVersion: string): Promise<McpToolResult> {
  if (!run.archived && ACTIVE_STATUSES.has(run.status)) {
    return conflict('archive', `this task is ${run.status} — cancel it or let it finish, then archive it`, { run: slimRun(run) });
  }
  const result = await ops.adapter.archiveRun(run.id, true, expectedVersion);
  return result.ok ? done('archive', { run: slimRun(result.value as RunLike) }) : refused('archive', result);
}

async function pickVariant(
  ops: WorkOrganisation,
  scope: OwnershipScope,
  groupId: string,
  runId: string,
  expectedVersion: string,
): Promise<McpToolResult> {
  // M-07: the group is owned as a whole — every member, and its worktree — or not at all.
  const owned = await ownGroupMember(scope, groupId, runId);
  if (!owned.ok) return notOwned('pick_variant', owned);
  const active = owned.value.runs.filter((r) => !TERMINAL_STATUSES.has(r.status));
  if (active.length > 0) {
    return conflict('pick_variant', 'a variant is still active — wait for every variant to finish (or cancel it), then pick', {
      active: active.map((r) => ({ id: r.id, variant: r.variant ?? '?', status: r.status })),
    });
  }
  const picked = await ops.pick(groupId, runId, expectedVersion);
  if (!picked.ok) return refused('pick_variant', picked);
  const after = await ops.getGroup(groupId);
  return done('pick_variant', {
    ...(picked.value.winner ? { winner: slimRun(picked.value.winner) } : {}),
    effects: 'every other variant was cancelled if still running, archived, and its worktree and branch deleted',
    ...(after.ok
      ? {
          others: after.value.runs
            .filter((r) => r.id !== runId)
            .map((r) => ({ id: r.id, variant: r.variant, status: r.status, archived: r.archived })),
        }
      : {}),
  });
}

/** Delete removes the task's worktree too, so a recorded worktree that is still on disk must be
 *  this project's real directory. One that is already gone (reclaimed) has nothing to reach. */
async function deletable(scope: OwnershipScope, run: RunLike): Promise<OwnershipRefusal | null> {
  if (run.worktreePath === undefined) return null;
  const worktree = await ownWorktree(scope, run.id);
  if (worktree.ok) return null;
  const present = await lstat(run.worktreePath).then(
    () => true,
    (err: NodeJS.ErrnoException) => err.code !== 'ENOENT',
  );
  return present ? worktree : null;
}

function notOwned(action: Action, refusal: OwnershipRefusal): McpToolResult {
  return errorResult(`${action}: ${refusal.message}`);
}

/** A read-only ownership scope over the bound project's task list as the service just answered
 *  it. `getRun` and `listRuns` hand out the same objects, which `ownGroup` relies on. No
 *  automation is ever looked up here, so that half refuses everything. */
function snapshotScope(root: string, runs: readonly RunRecord[]): OwnershipScope {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const store: OwnershipProject['store'] = { getRun: (id) => byId.get(id), listRuns: () => [...runs] };
  const automationStore = { get: () => undefined, latestReceipts: () => new Map() } as unknown as OwnershipProject['automationStore'];
  return ownershipScope({ root, store, automationStore });
}

async function perform(ops: WorkOrganisation, root: string, args: Args): Promise<McpToolResult> {
  // Every field an action requires was checked by the schema; `need` only narrows the type.
  const need = <T>(value: T | undefined): T => value as T;
  const runResult = async (action: Action, pending: Promise<McpServiceResult<unknown>>): Promise<McpToolResult> => {
    const result = await pending;
    return result.ok ? done(action, { run: slimRun(result.value as RunLike) }) : refused(action, result);
  };

  // Inbox items live in the project's own todos file, which the route reads under the bound scope.
  if (args.action === 'start_inbox_item') {
    const body = {
      ...(args.runner !== undefined ? { runner: args.runner } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
    };
    const result = await ops.startTodo(need(args.todoId), body);
    if (!result.ok) return refused('start_inbox_item', result);
    // D-05: a start is an acknowledgement, never a completion.
    return textResult(
      json({ status: 'accepted', accepted: true, action: 'start_inbox_item', subject: { type: 'run', id: result.value.run.id }, run: slimRun(result.value.run) }),
    );
  }
  if (args.action === 'remove_inbox_item') {
    const todoId = need(args.todoId);
    const result = await ops.removeTodo(todoId);
    return result.ok ? done('remove_inbox_item', { todoId, removed: true }) : refused('remove_inbox_item', result);
  }

  // Everything else names tasks: prove ownership over this project's own list first.
  const listed = await ops.adapter.listRuns();
  if (!listed.ok) return refused(args.action, listed);
  const runs = listed.value as unknown as RunRecord[];
  const scope = snapshotScope(root, runs);

  switch (args.action) {
    case 'list_queue':
      return listQueue(scope, runs, args);
    case 'archive_finished':
    case 'mark_all_read': {
      const sweep = await ownSweep(scope, args.action === 'archive_finished' ? 'archive-finished' : 'read-all');
      if (!sweep.ok) return notOwned(args.action, sweep);
      if (args.action === 'archive_finished') {
        const result = await ops.archiveFinished();
        if (!result.ok) return refused('archive_finished', result);
        return done('archive_finished', {
          archived: result.value.archived,
          scope: "this project's finished (done, failed, cancelled) tasks that were not archived",
        });
      }
      const result = await ops.markAllRead();
      if (!result.ok) return refused('mark_all_read', result);
      return done('mark_all_read', { read: result.value.read, scope: "this project's unread finished tasks" });
    }
    case 'pick_variant':
      return pickVariant(ops, scope, need(args.groupId), need(args.runId), need(args.expectedVersion));
    case 'edit_queued_message':
    case 'remove_queued_message': {
      const owned = ownQueuedMessage(scope, args.runId, args.messageId);
      if (!owned.ok) return notOwned(args.action, owned);
      const { run, message } = owned.value;
      const expectedVersion = need(args.expectedVersion);
      if (args.action === 'remove_queued_message') {
        const result = await ops.removeQueuedMessage(run.id, message.id, expectedVersion);
        return result.ok ? done('remove_queued_message', { runId: run.id, removed: true }) : refused('remove_queued_message', result);
      }
      const result = await ops.editQueuedMessage(run.id, message.id, need(args.text), expectedVersion);
      if (!result.ok) return refused('edit_queued_message', result);
      return done('edit_queued_message', { runId: run.id, message: { id: result.value.message.id, chars: result.value.message.text.length } });
    }
    default:
      break;
  }

  const owned = ownRun(scope, args.runId);
  if (!owned.ok) return notOwned(args.action, owned);
  const run = owned.value;
  // Present for every action below except the read-state pair (the schema requires it), and
  // sent to the route, which is where the check runs.
  const expectedVersion = args.expectedVersion;
  switch (args.action) {
    case 'set_title':
      return runResult('set_title', ops.adapter.patchRun(run.id, { title: need(args.title), expectedVersion }));
    case 'edit_brief':
      return runResult('edit_brief', ops.adapter.patchRun(run.id, { task: need(args.task), expectedVersion }));
    case 'pin':
    case 'unpin':
      return runResult(args.action, ops.adapter.pinRun(run.id, args.action === 'pin', need(expectedVersion)));
    case 'archive':
      return archive(ops, run, need(expectedVersion));
    case 'restore':
      return runResult('restore', ops.adapter.archiveRun(run.id, false, need(expectedVersion)));
    case 'mark_read':
    case 'mark_unread':
      return runResult(args.action, ops.setRead(run.id, args.action === 'mark_read'));
    case 'delete': {
      const refusal = await deletable(scope, run);
      if (refusal) return notOwned('delete', refusal);
      const result = await ops.deleteRun(run.id, need(expectedVersion));
      if (!result.ok) return refused('delete', result);
      return done('delete', {
        runId: run.id,
        deleted: true,
        removed: 'the task, its transcript and journal, and its worktree and branch if it had them — irreversible',
      });
    }
  }
  return errorResult(`unknown action: ${String(args.action)}`);
}

export const organiseWorkTool = defineTool({
  name: 'organise_work',
  title: 'Organise tasks',
  description: [
    "Organise this project's tasks the way the xezar cockpit does. Pick one `action`:",
    '- list_queue: the queued tasks, oldest first (the order they start in), with their brief and queued message ids. Paginated: pass `next` back as `cursor`.',
    '- set_title: rename a task (any status).',
    '- edit_brief / edit_queued_message / remove_queued_message: change a queued task before it starts. Refused once the task has started.',
    '- pin / unpin, archive / restore, mark_read / mark_unread: per-task flags. Archive is refused while the task is queued, running or waiting.',
    '- archive_finished / mark_all_read: sweep every finished task of this project.',
    '- delete: remove a task, its transcript, its worktree and its branch. Irreversible. Refused while the task is active.',
    '- start_inbox_item / remove_inbox_item: act on an Inbox item (needs the Inbox to be on).',
    '- pick_variant: keep one variant of a group. Refused until every variant has finished; then every other variant is archived and its worktree and branch are deleted. Irreversible.',
    'Every action that changes one task needs expectedVersion: the `version` task_read (view task) returned for it — for pick_variant, the variant you keep. If the task changed since you read it, nothing is applied and the answer is status "conflict" with error "stale_version": read it again and decide again.',
    'No confirmation is needed for any action. Tasks have no priority and no dependencies: there is nothing to reorder. A refusal the task state caused comes back with status "conflict" and the reason.',
  ].join('\n'),
  inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async call(args, ctx) {
    const { service } = ctx as ServiceBoundContext;
    if (!service) {
      return errorResult('organise_work is not connected to this xezar service yet, so it changed nothing. Use the cockpit for now.');
    }
    return perform(new WorkOrganisation(ctx.project.id, service), ctx.project.root, args);
  },
});
