import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  RUN_HISTORY_PAGE_ITEMS,
  apiRunSchema,
  capabilitiesSchema,
  groupResponseSchema,
  runHistoryContextSchema,
  runHistoryCursorSchema,
  runHistoryPageSchema,
  runIdParamSchema,
  runStatusSchema,
  todoItemSchema,
  type ApiRun,
  type RunHistoryEvent,
} from '@qodeca/xezar-contract';
import { collectSecretValues, redactDeep } from '../../core/secret-redaction.ts';
import { decodeLiveCursor, decodePageCursor } from '../../runs/event-history.ts';
import {
  openCursor,
  ownGroup,
  ownRun,
  ownershipScope,
  sealCursor,
  type OwnershipScope,
} from '../resource-ownership.ts';
import type { ServiceDispatch } from '../service-adapter.ts';
import { defineTool, errorResult, textResult, type McpToolContext, type McpToolResult } from '../tool.ts';

/**
 * `task_read` — the project leader's READ side of tasks (#91, epic #67): list and filter the
 * bound project's tasks, read one task's record, its paginated history and context, its handoff
 * journal, the project's Inbox and a variant group.
 *
 * WHERE THE DATA COMES FROM. Every read is dispatched IN-PROCESS into the service's own
 * project-scoped routes — `runsRoutes`, `todosRoutes`, `groupsRoutes` — under
 * `/api/v1/p/<bound project>/…`, through the same entry #89's service adapter takes. So the
 * payload is the cockpit's payload by construction (N-02, A-08): the same `withUsage`, the same
 * variant diff stats, the same Inbox capability ceiling. Nothing here opens a store or a file.
 *
 * ISOLATION (F-01, F-02, N-01, M-01, M-07, A-04). The project is `ctx.project` — the project
 * whose socket this call arrived on — and no argument can name another: the input schema is
 * strict, so a `project` key is refused rather than silently ignored. The only non-project path
 * this module requests is `/api/v1/health`, and only for the one Inbox capability boolean. There
 * is no path to the workspace runs index (`GET /api/v1/workspace/runs-index`, which spans every
 * project). A task and every member of a variant group are proved to be the bound project's by
 * #88's `ownRun` / `ownGroup` before anything about them is read, and every cursor is sealed
 * with #88's `sealCursor` to the project and the resource it pages. A refusal names nothing.
 *
 * BOUNDS (N-06, D-09). One result is at most B-01's 40 000 serialized bytes and B-02's 100
 * items; a caller may ask for fewer items, never more, and a history read without a page size
 * is bounded all the same. The task list, which the cockpit does not paginate, is keyset-paged
 * over a summary projection (B-05). One item larger than the budget is split into parts with an
 * explicit continuation, never dropped and never cut (B-03). Cursors stay within B-04's 2 048
 * bytes.
 *
 * RESULTS (D-05 § 6.8). The text block is a compact JSON object and is authoritative; no
 * `structuredContent` is added, because a second copy would double the bytes B-01 budgets.
 * Every payload passes the transcript's own secret scrub before it leaves (F-15).
 */

// ---- bounds (D-09) -------------------------------------------------------------------------

/** D-09 B-01: serialized bytes of one tool result's text. */
export const TASK_READ_RESULT_BUDGET_BYTES = 40_000;
/** D-09 B-02: the cockpit's own history page size, reused for every MCP list and history page. */
export const TASK_READ_PAGE_ITEMS = RUN_HISTORY_PAGE_ITEMS;

// ---- the service entry ---------------------------------------------------------------------

/**
 * `McpToolContext` does not carry the service entry yet (the tool context is widened by the
 * wiring that follows #89). Until the service hands it over, the tool answers that it is not
 * connected instead of guessing.
 */
type TaskReadContext = McpToolContext & { readonly service?: ServiceDispatch };

// ---- input ---------------------------------------------------------------------------------

const VIEWS = ['list', 'task', 'history', 'context', 'handoff', 'inbox', 'group'] as const;
type View = (typeof VIEWS)[number];

const idSchema = runIdParamSchema.shape.id;
const archivedModeSchema = z.enum(['exclude', 'include', 'only']);

const inputSchema = z.strictObject({
  view: z
    .enum(VIEWS)
    .describe(
      'list = the project’s tasks (summaries, newest first); task = one task’s full record; history = one task’s event history, newest page first; context = the plan and agent episode that frame a task’s history; handoff = a task’s handoff journal (markdown); inbox = the project’s Inbox items; group = one variant group, its tasks side by side.',
    ),
  taskId: idSchema.optional().describe('Task id. Required for task, history, context and handoff.'),
  groupId: idSchema
    .optional()
    .describe('Variant group id. Required for group; with list, keeps only that group’s tasks.'),
  cursor: runHistoryCursorSchema
    .optional()
    .describe(
      'The nextCursor of a previous task_read answer, to read the next page or part. Send it with the same view, task and filters as that call.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(TASK_READ_PAGE_ITEMS)
    .optional()
    .describe(`list and history: at most this many tasks or events per page (default and ceiling ${TASK_READ_PAGE_ITEMS}).`),
  status: z.array(runStatusSchema).min(1).max(runStatusSchema.options.length).optional().describe('list: keep only these statuses.'),
  archived: archivedModeSchema.optional().describe('list: exclude archived tasks (default), include them, or show only them.'),
  query: z.string().min(1).max(200).optional().describe('list: case-insensitive text to find in a task’s title, prompt or branch.'),
});
type Args = z.output<typeof inputSchema>;
type ArgKey = Exclude<keyof Args, 'view'>;

/** Which arguments each view reads. Anything else is refused, never silently ignored. */
const VIEW_ARGS: Record<View, { required: readonly ArgKey[]; allowed: readonly ArgKey[] }> = {
  list: { required: [], allowed: ['cursor', 'limit', 'status', 'archived', 'query', 'groupId'] },
  task: { required: ['taskId'], allowed: ['cursor'] },
  history: { required: ['taskId'], allowed: ['cursor', 'limit'] },
  context: { required: ['taskId'], allowed: ['cursor'] },
  handoff: { required: ['taskId'], allowed: ['cursor'] },
  inbox: { required: [], allowed: ['cursor'] },
  group: { required: ['groupId'], allowed: ['cursor'] },
};

// ---- output projections (derived from the contract, never re-declared) ---------------------

/**
 * The task-list row (D-09 B-05): what a leader needs to pick a task to read — without the
 * record's `steps[]`, `workflowDef`, prompt text, system prompt and worktree path, which are what
 * make a full record ~6 KB. `task` view returns the whole record.
 */
export const taskSummarySchema = apiRunSchema.pick({
  id: true,
  title: true,
  titleSummary: true,
  status: true,
  activity: true,
  workflow: true,
  runner: true,
  model: true,
  autonomous: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  currentStepId: true,
  error: true,
  archived: true,
  pinned: true,
  groupId: true,
  variant: true,
  branch: true,
  baseBranch: true,
  diffStat: true,
  pullRequestUrl: true,
  prNumber: true,
  issueNumber: true,
  autoResumeAt: true,
  tokensUsed: true,
  costUsd: true,
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;

interface ListFilter {
  status?: string[];
  archived: z.infer<typeof archivedModeSchema>;
  groupId?: string;
  query?: string;
}

// ---- cursors -------------------------------------------------------------------------------

/** A part of one oversized item: which item, how far in, and a digest of what part 1 read. */
const partSchema = z.object({ id: z.string(), o: z.number().int().nonnegative(), h: z.string().regex(/^[a-f0-9]{16}$/) });
type Part = z.infer<typeof partSchema>;

const pageSizeSchema = z.number().int().min(1).max(TASK_READ_PAGE_ITEMS).optional();

/**
 * What a cursor carries INSIDE #88's seal. The seal binds it to the project and the resource
 * (`tasks`, `run:<id>:history`, …), so nothing here names either.
 */
const cursorPayloadSchema = z.discriminatedUnion('k', [
  z.object({
    v: z.literal(1),
    k: z.literal('list'),
    /** A digest of the filters, not the filters: a 200-character query must not cost B-04. */
    f: z.string().regex(/^[a-f0-9]{16}$/),
    /** The page size the walk started with, so a continuation need not repeat it. */
    n: pageSizeSchema,
    /** Keyset: the last row already delivered. */
    after: z.object({ createdAt: z.string(), id: z.string() }).optional(),
    x: partSchema.optional(),
  }),
  z.object({
    v: z.literal(1),
    k: z.literal('history'),
    n: pageSizeSchema,
    /** The cockpit's history view this walk started from: its file size and correction. */
    fs: z.number().int().nonnegative(),
    co: z.string().optional(),
    /** Only events with a `seq` below this are still to be read. */
    before: z.number().int().nonnegative(),
    x: partSchema.optional(),
  }),
  z.object({ v: z.literal(1), k: z.enum(['task', 'context', 'handoff', 'inbox', 'group']), x: partSchema }),
]);
type CursorPayload = z.infer<typeof cursorPayloadSchema>;

/** The resource a view's cursors page — the key #88's seal binds them to. */
function resourceOf(view: View, key: string): string {
  if (view === 'list') return 'tasks';
  if (view === 'inbox') return 'inbox';
  if (view === 'group') return `group:${key}`;
  return `run:${key}:${view}`;
}

const INVALID_CURSOR = 'Invalid cursor: it was not issued for this read. Read again without a cursor to start from the first page.';

function encodeCursor(scope: OwnershipScope, view: View, key: string, payload: CursorPayload): string {
  return sealCursor(scope, resourceOf(view, key), JSON.stringify(payload));
}

/** Open a cursor sealed for THIS project and resource, or say it was not. */
function decodeCursor<K extends CursorPayload['k']>(
  scope: OwnershipScope,
  view: View,
  key: string,
  cursor: string,
): Extract<CursorPayload, { k: K }> | undefined {
  const opened = openCursor(scope, resourceOf(view, key), cursor);
  if (!opened.ok) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(opened.value);
  } catch {
    return undefined;
  }
  const parsed = cursorPayloadSchema.safeParse(json);
  return parsed.success && parsed.data.k === view ? (parsed.data as Extract<CursorPayload, { k: K }>) : undefined;
}

/**
 * The #88 ownership scope for the bound project, over the records THIS call read from the
 * project's own routes. It holds no automation records: task reads never touch automations.
 */
function scopeOver(root: string, runs: readonly ApiRun[] = []): OwnershipScope {
  const byId = new Map(runs.map((run) => [run.id, run]));
  return ownershipScope({
    root,
    store: { getRun: (id) => byId.get(id), listRuns: () => [...byId.values()] },
    automationStore: { get: () => undefined, latestReceipts: () => new Map() },
  });
}

// ---- the budget ----------------------------------------------------------------------------

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** A stand-in for the longest cursor, so a page measured with it can never grow past B-01. */
const CURSOR_PLACEHOLDER = 'x'.repeat(2_048);

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Bytes one code point costs inside a JSON string, exactly as `JSON.stringify` escapes it. */
function escapedBytes(cp: number): number {
  if (cp === 0x22 || cp === 0x5c) return 2;
  if (cp === 0x08 || cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d) return 2;
  if (cp < 0x20) return 6;
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp >= 0xd800 && cp <= 0xdfff) return 6; // a lone surrogate is escaped as \uXXXX
  if (cp < 0x10000) return 3;
  return 4;
}

/** The end index of the longest slice of `text` from `start` whose JSON-escaped size fits. */
function sliceEnd(text: string, start: number, room: number): number {
  let used = 0;
  let index = start;
  while (index < text.length) {
    const cp = text.codePointAt(index)!;
    const cost = escapedBytes(cp);
    if (used + cost > room) break;
    used += cost;
    index += cp > 0xffff ? 2 : 1; // never split a surrogate pair
  }
  return index;
}

interface Parted {
  readonly text: string;
  readonly part: number;
  readonly parts: number;
  /** Where the next part starts, or undefined after the last one. */
  readonly next: number | undefined;
}

/**
 * B-03: one item too large for a result is sent in parts. Every part is sized against the same
 * worst-case envelope, so the part count is fixed before part 1 is sent. Answers undefined when
 * an offset does not sit on a part boundary this function produced — a stale cursor.
 */
function partOf(itemJson: string, offset: number, envelope: (chunk: Record<string, unknown>) => string): Parted | undefined {
  const room =
    TASK_READ_RESULT_BUDGET_BYTES -
    bytes(envelope({ part: 999_999, parts: 999_999, text: '', nextCursor: CURSOR_PLACEHOLDER }));
  if (room < 64) throw new Error('task_read envelope leaves no room for a part');
  let part = 0;
  let found: { text: string; part: number; next: number | undefined } | undefined;
  for (let start = 0; start < itemJson.length; ) {
    const end = sliceEnd(itemJson, start, room);
    part += 1;
    if (start === offset) found = { text: itemJson.slice(start, end), part, next: end < itemJson.length ? end : undefined };
    start = end;
  }
  return found ? { ...found, parts: part } : undefined;
}

const STALE_PART =
  'This item changed while it was being read in parts. Read it again without a cursor to start from part 1.';

// ---- dispatch ------------------------------------------------------------------------------

/** Any absolute origin works: the request never leaves the process. The `host` is what the
 *  request-origin guard (#426) checks, and an in-process call genuinely is this machine. */
const IN_PROCESS_BASE = 'http://127.0.0.1';

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** A value read from a route, or the answer that refused it. */
type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly answer: Answer };

class TaskReader {
  private readonly scopePath: string;
  /** A scope for sealing cursors only; ownership checks build theirs over the records read. */
  readonly scope: OwnershipScope;

  constructor(
    private readonly service: ServiceDispatch,
    readonly project: McpToolContext['project'],
  ) {
    this.scopePath = `/api/v1/p/${encodeURIComponent(project.id)}`;
    this.scope = scopeOver(project.root);
  }

  /** A project-scoped route. The path is built here from validated ids only. */
  get(path: string, as: 'json' | 'text' = 'json'): Promise<Answer> {
    return this.dispatch(`${this.scopePath}${path}`, as);
  }

  /** Every task of the project, as the cockpit's `GET /runs` answers them. */
  async runs(): Promise<Read<ApiRun[]>> {
    const answer = await this.get('/runs');
    return answer.status === 200 ? { ok: true, value: z.array(apiRunSchema).parse(answer.body) } : { ok: false, answer };
  }

  /** One task, read from the project's own route AND proved the project's by #88's `ownRun`. */
  async ownedRun(taskId: string): Promise<Read<ApiRun>> {
    const answer = await this.get(`/runs/${encodeURIComponent(taskId)}`);
    if (answer.status !== 200) return { ok: false, answer };
    const run = apiRunSchema.parse(answer.body);
    if (!ownRun(scopeOver(this.project.root, [run]), taskId).ok) return { ok: false, answer: { status: 404, body: undefined } };
    return { ok: true, value: run };
  }

  /** The one capability this module needs outside the project scope: is the Inbox on. */
  async inboxEnabled(): Promise<boolean> {
    const answer = await this.dispatch('/api/v1/health', 'json');
    if (answer.status !== 200) throw new Error(`health answered ${answer.status}`);
    return z.object({ capabilities: capabilitiesSchema.pick({ followups: true }) }).parse(answer.body).capabilities.followups;
  }

  private async dispatch(path: string, as: 'json' | 'text'): Promise<Answer> {
    const res = await this.service.request(`${IN_PROCESS_BASE}${path}`, { headers: { host: '127.0.0.1' } });
    if (as === 'text' && res.status === 200) return { status: res.status, body: await res.text() };
    return { status: res.status, body: await res.json().catch(() => undefined) };
  }
}

const NO_TASK = 'No such task in this project.';
const NO_GROUP = 'No such variant group in this project.';

/**
 * A refusal the service answered with, in words a model can act on. Fixed texts only for "not
 * found": a message that echoed an id or a path could name another project's resource (N-01).
 */
function refusal(answer: Answer, notFound: string): McpToolResult {
  if (answer.status === 404) return errorResult(notFound);
  const message =
    answer.body && typeof answer.body === 'object' && typeof (answer.body as { error?: unknown }).error === 'string'
      ? (answer.body as { error: string }).error
      : `xezar answered ${answer.status}`;
  if (answer.status === 400 || answer.status === 409) return errorResult(`${message}. Read again without a cursor.`);
  throw new Error(`unexpected ${answer.status} for a task read`);
}

// ---- the tool ------------------------------------------------------------------------------

export const taskReadsTool = defineTool({
  name: 'task_read',
  title: 'Read tasks',
  description: [
    'Read this project’s tasks. Choose one view:',
    '- list: task summaries, newest first, filterable by status, archived, groupId and query.',
    '- task: one task’s full record. history: its events, newest page first; follow nextCursor for older events.',
    '- context: the plan and agent episode that frame the history. handoff: the task’s handoff journal.',
    '- inbox: the project’s Inbox items. group: one variant group, its tasks side by side.',
    `Pages are bounded: at most ${TASK_READ_PAGE_ITEMS} items and ${TASK_READ_RESULT_BUDGET_BYTES} bytes. When an answer has a nextCursor, call again with the same view, task and filters plus that cursor.`,
    'An item too large for one answer comes in parts ("part" of "parts"): join the "text" of every part in order, then parse it as JSON.',
    'This reads only the project this connection is bound to. Use it to assess state or recover after a lost answer, not to poll: task events are pushed.',
  ].join('\n'),
  inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async call(args, ctx) {
    const service = (ctx as TaskReadContext).service;
    if (!service) {
      return errorResult(
        'task_read is not connected in this xezar yet: the running service did not hand MCP its task reads. Use the cockpit to read tasks.',
      );
    }
    const argIssue = checkArgs(args);
    if (argIssue) return errorResult(argIssue);
    const reader = new TaskReader(service, ctx.project);
    switch (args.view) {
      case 'list':
        return readList(reader, args);
      case 'history':
        return readHistory(reader, args.taskId!, args);
      case 'inbox':
        return readInbox(reader, args.cursor);
      case 'group':
        return readGroup(reader, args.groupId!, args.cursor);
      default:
        return readTaskView(reader, args.view, args.taskId!, args.cursor);
    }
  },
});

function checkArgs(args: Args): string | undefined {
  const rule = VIEW_ARGS[args.view];
  for (const key of rule.required) {
    if (args[key] === undefined) return `${args.view} needs ${key}.`;
  }
  for (const key of Object.keys(args) as (keyof Args)[]) {
    if (key === 'view' || args[key] === undefined) continue;
    if (!rule.required.includes(key) && !rule.allowed.includes(key)) return `${key} does not apply to the ${args.view} view.`;
  }
  // A dot segment passes the id pattern, and the URL parser would resolve it onto another route.
  for (const id of [args.taskId, args.groupId]) {
    if (id === '.' || id === '..') return `not an id: ${JSON.stringify(id)}`;
  }
  return undefined;
}

/** One pass of the transcript's own secret scrub over everything that leaves (F-15). */
const scrub = <T>(value: T): T => redactDeep(value, collectSecretValues());

// ---- list ----------------------------------------------------------------------------------

/** Newest first, as the cockpit's `listRuns`; the id breaks a tie so the keyset is total. */
function newestFirst(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

function matches(run: ApiRun, filter: ListFilter): boolean {
  if (filter.archived === 'exclude' && run.archived) return false;
  if (filter.archived === 'only' && !run.archived) return false;
  if (filter.status && !filter.status.includes(run.status)) return false;
  if (filter.groupId !== undefined && run.groupId !== filter.groupId) return false;
  if (filter.query !== undefined) {
    const needle = filter.query.toLowerCase();
    const haystack = [run.title, run.titleSummary, run.task, run.branch];
    if (!haystack.some((text) => text?.toLowerCase().includes(needle))) return false;
  }
  return true;
}

function filterFrom(args: Args): ListFilter {
  return {
    ...(args.status ? { status: [...new Set(args.status)].sort() } : {}),
    archived: args.archived ?? 'exclude',
    ...(args.groupId !== undefined ? { groupId: args.groupId } : {}),
    ...(args.query !== undefined ? { query: args.query } : {}),
  };
}

async function readList(reader: TaskReader, args: Args): Promise<McpToolResult> {
  const filter = filterFrom(args);
  const filterDigest = digest(JSON.stringify(filter));
  let position: { after?: { createdAt: string; id: string }; x?: Part } = {};
  let pageSize = args.limit;
  if (args.cursor !== undefined) {
    const decoded = decodeCursor<'list'>(reader.scope, 'list', '', args.cursor);
    if (!decoded) return errorResult(INVALID_CURSOR);
    if (decoded.f !== filterDigest) {
      return errorResult('This cursor belongs to a list with other filters. Send it with the same filters as the call that returned it.');
    }
    position = { ...(decoded.after ? { after: decoded.after } : {}), ...(decoded.x ? { x: decoded.x } : {}) };
    pageSize ??= decoded.n;
  }

  const listed = await reader.runs();
  if (!listed.ok) return refusal(listed.answer, 'This project’s tasks could not be read.');
  const rows = listed.value.filter((run) => matches(run, filter)).sort(newestFirst);
  const after = position.after;
  const remaining = after ? rows.filter((run) => newestFirst(after, run) < 0) : rows;
  const summaries = remaining.map((run) => scrub(taskSummarySchema.parse(run)));
  const limit = pageSize ?? TASK_READ_PAGE_ITEMS;
  const cursor = (fields: { after?: { createdAt: string; id: string }; x?: Part }): string =>
    encodeCursor(reader.scope, 'list', '', {
      v: 1,
      k: 'list',
      f: filterDigest,
      ...(pageSize !== undefined ? { n: pageSize } : {}),
      ...fields,
    });
  const cursorAfter = (row: TaskSummary): string => cursor({ after: { createdAt: row.createdAt, id: row.id } });
  // While an oversized row is read in parts the keyset stays BEFORE it.
  const partCursor = (x: Part): string => cursor({ ...(after ? { after } : {}), x });

  const head = summaries[0];
  if (position.x) {
    // Continuing one oversized row: it must still be the next row, unchanged.
    if (!head || head.id !== position.x.id || digest(JSON.stringify(head)) !== position.x.h) return errorResult(STALE_PART);
    return listPart(head, position.x.o, summaries.length > 1, partCursor, cursorAfter);
  }

  const page: TaskSummary[] = [];
  const envelope = (tasks: TaskSummary[], nextCursor?: string) =>
    JSON.stringify({ view: 'list', total: rows.length, tasks, ...(nextCursor ? { nextCursor } : {}) });
  for (const row of summaries) {
    if (page.length === limit) break;
    if (bytes(envelope([...page, row], CURSOR_PLACEHOLDER)) > TASK_READ_RESULT_BUDGET_BYTES) break;
    page.push(row);
  }
  if (page.length === 0 && head) return listPart(head, 0, summaries.length > 1, partCursor, cursorAfter);
  const last = page.at(-1);
  const more = page.length < summaries.length;
  return textResult(envelope(page, more && last ? cursorAfter(last) : undefined));
}

/** One list row too large for a result; after its last part the keyset moves past it. */
function listPart(
  row: TaskSummary,
  offset: number,
  moreRows: boolean,
  partCursor: (x: Part) => string,
  cursorAfter: (row: TaskSummary) => string,
): McpToolResult {
  const json = JSON.stringify(row);
  const envelope = (chunk: Record<string, unknown>) => JSON.stringify({ view: 'list', taskId: row.id, ...chunk });
  const part = partOf(json, offset, envelope);
  if (!part) return errorResult(STALE_PART);
  const nextCursor =
    part.next !== undefined
      ? partCursor({ id: row.id, o: part.next, h: digest(json) })
      : moreRows
        ? cursorAfter(row)
        : undefined;
  return textResult(envelope({ part: part.part, parts: part.parts, text: part.text, ...(nextCursor ? { nextCursor } : {}) }));
}

// ---- history -------------------------------------------------------------------------------

async function readHistory(reader: TaskReader, taskId: string, args: Args): Promise<McpToolResult> {
  let walk: { fs: number; co?: string; before: number; x?: Part } | undefined;
  let pageSize = args.limit;
  if (args.cursor !== undefined) {
    const decoded = decodeCursor<'history'>(reader.scope, 'history', taskId, args.cursor);
    if (!decoded) return errorResult(INVALID_CURSOR);
    walk = { fs: decoded.fs, before: decoded.before, ...(decoded.co ? { co: decoded.co } : {}), ...(decoded.x ? { x: decoded.x } : {}) };
    pageSize ??= decoded.n;
  }
  const owned = await reader.ownedRun(taskId);
  if (!owned.ok) return refusal(owned.answer, NO_TASK);

  // The cockpit's own page, either the newest or the one that ends just before `before`. The
  // older-page cursor is the cockpit's own shape, rebuilt from the view the walk started on.
  const query = walk
    ? `?cursor=${Buffer.from(
        JSON.stringify({
          v: 1,
          kind: 'page',
          ...(walk.co ? { correction: walk.co } : {}),
          direction: 'older',
          fileSize: walk.fs,
          boundarySeq: walk.before,
        }),
        'utf8',
      ).toString('base64url')}`
    : '';
  const read = await reader.get(`/runs/${encodeURIComponent(taskId)}/history${query}`);
  if (read.status !== 200) return refusal(read, NO_TASK);
  const page = runHistoryPageSchema.parse(read.body);
  // The walk stays on the view it started from: its file size and correction ride every cursor.
  const live = decodeLiveCursor(page.liveCursor);
  const correction = walk ? walk.co : live.correction;
  const view = { fs: walk ? walk.fs : live.offset, ...(correction !== undefined ? { co: correction } : {}) };
  const events = scrub(page.events);
  const limit = pageSize ?? TASK_READ_PAGE_ITEMS;
  const cursorBefore = (before: number, x?: Part): string =>
    encodeCursor(reader.scope, 'history', taskId, {
      v: 1,
      k: 'history',
      ...(pageSize !== undefined ? { n: pageSize } : {}),
      ...view,
      before,
      ...(x ? { x } : {}),
    });
  /** Where the cockpit page itself continues, if anywhere. */
  const olderThanPage = page.olderCursor ? decodePageCursor(page.olderCursor).boundarySeq : undefined;
  const envelope = (payload: Record<string, unknown>) =>
    JSON.stringify({ view: 'history', taskId, asOfSeq: page.asOfSeq, ...payload });

  if (walk?.x) {
    const target = events.at(-1);
    if (!target || String(target.seq) !== walk.x.id || digest(JSON.stringify(target)) !== walk.x.h) return errorResult(STALE_PART);
    return historyPart(target, walk.x.o, events.length > 1 || olderThanPage !== undefined, envelope, cursorBefore);
  }

  // Newest first: take the longest suffix of the cockpit page that fits the item and byte bounds.
  let start = events.length;
  while (start > 0 && events.length - start < limit) {
    const candidate = events.slice(start - 1);
    if (bytes(envelope({ events: candidate, hasOlder: true, nextCursor: CURSOR_PLACEHOLDER })) > TASK_READ_RESULT_BUDGET_BYTES) break;
    start -= 1;
  }
  if (start === events.length && events.length > 0) {
    return historyPart(events.at(-1)!, 0, events.length > 1 || olderThanPage !== undefined, envelope, cursorBefore);
  }
  // Everything before `events[start]` is still to read: the next page is the cockpit's page that
  // ends just below it. Taking the whole page, the cockpit's own older boundary applies.
  const nextBefore = start > 0 ? events[start]!.seq : olderThanPage;
  const nextCursor = nextBefore !== undefined ? cursorBefore(nextBefore) : undefined;
  return textResult(
    envelope({ events: events.slice(start), hasOlder: nextCursor !== undefined, ...(nextCursor ? { nextCursor } : {}) }),
  );
}

function historyPart(
  event: RunHistoryEvent,
  offset: number,
  olderExists: boolean,
  envelope: (payload: Record<string, unknown>) => string,
  cursorBefore: (before: number, x?: Part) => string,
): McpToolResult {
  const json = JSON.stringify(event);
  const h = digest(json);
  const wrap = (chunk: Record<string, unknown>) => envelope({ seq: event.seq, hasOlder: true, ...chunk });
  const part = partOf(json, offset, wrap);
  if (!part) return errorResult(STALE_PART);
  // While parts remain, the walk stays on this event (`before` just above it); after the last
  // part it moves below it.
  const nextCursor =
    part.next !== undefined
      ? cursorBefore(event.seq + 1, { id: String(event.seq), o: part.next, h })
      : olderExists
        ? cursorBefore(event.seq)
        : undefined;
  return textResult(
    envelope({
      seq: event.seq,
      hasOlder: olderExists || part.next !== undefined,
      part: part.part,
      parts: part.parts,
      text: part.text,
      ...(nextCursor ? { nextCursor } : {}),
    }),
  );
}

// ---- inbox ---------------------------------------------------------------------------------

async function readInbox(reader: TaskReader, cursor: string | undefined): Promise<McpToolResult> {
  const read = await reader.get('/todos');
  if (read.status !== 200) return refusal(read, 'This project’s Inbox could not be read.');
  const items = z.array(todoItemSchema).parse(read.body);
  // The route answers `[]` both when the Inbox is empty and when it is switched off. Those must
  // not read the same to a leader (F-03), so an empty answer asks which one it was.
  if (items.length === 0 && !(await reader.inboxEnabled())) {
    if (cursor !== undefined) return errorResult(INVALID_CURSOR);
    return textResult(
      JSON.stringify({
        view: 'inbox',
        available: false,
        reason:
          'The Inbox is off for this xezar, so tasks do not file follow-ups. A human can turn it on in the cockpit (Settings) or start xezar with XEZ_FOLLOWUPS=1.',
      }),
    );
  }
  return whole(reader.scope, 'inbox', '', { available: true }, 'items', scrub(items), cursor);
}

// ---- task, context, handoff, group ---------------------------------------------------------

async function readTaskView(
  reader: TaskReader,
  view: 'task' | 'context' | 'handoff',
  taskId: string,
  cursor: string | undefined,
): Promise<McpToolResult> {
  const run = await reader.ownedRun(taskId);
  if (!run.ok) return refusal(run.answer, NO_TASK);
  if (view === 'task') return whole(reader.scope, 'task', taskId, {}, 'task', scrub(run.value), cursor);
  const id = encodeURIComponent(taskId);
  if (view === 'context') {
    const read = await reader.get(`/runs/${id}/history-context`);
    if (read.status !== 200) return refusal(read, NO_TASK);
    return whole(reader.scope, 'context', taskId, { taskId }, 'context', scrub(runHistoryContextSchema.parse(read.body)), cursor);
  }
  const read = await reader.get(`/runs/${id}/handoff`, 'text');
  if (read.status !== 200) return refusal(read, NO_TASK);
  return whole(reader.scope, 'handoff', taskId, { taskId }, 'markdown', scrub(z.string().parse(read.body)), cursor);
}

async function readGroup(reader: TaskReader, groupId: string, cursor: string | undefined): Promise<McpToolResult> {
  // M-07: a group is ONE resource. Every member is proved the project's — including where its
  // worktree lives, because the group read computes each member's diff there — or none is read.
  const runs = await reader.runs();
  if (!runs.ok) return refusal(runs.answer, NO_GROUP);
  if (!(await ownGroup(scopeOver(reader.project.root, runs.value), groupId)).ok) return errorResult(NO_GROUP);
  const read = await reader.get(`/groups/${encodeURIComponent(groupId)}`);
  if (read.status !== 200) return refusal(read, NO_GROUP);
  return whole(reader.scope, 'group', groupId, {}, 'group', scrub(groupResponseSchema.parse(read.body)), cursor);
}

/**
 * A view whose answer is ONE value: sent whole when it fits, in parts when it does not (B-03).
 * The parts are bound to a digest of the value part 1 read, so a value that changes mid-read is
 * refused instead of being spliced from two versions.
 */
function whole(
  scope: OwnershipScope,
  view: 'task' | 'context' | 'handoff' | 'inbox' | 'group',
  key: string,
  head: Record<string, unknown>,
  field: string,
  value: unknown,
  cursor: string | undefined,
): McpToolResult {
  const json = JSON.stringify(value);
  const h = digest(json);
  let offset = 0;
  if (cursor !== undefined) {
    const decoded = decodeCursor<typeof view>(scope, view, key, cursor);
    if (!decoded) return errorResult(INVALID_CURSOR);
    if (decoded.x.h !== h) return errorResult(STALE_PART);
    offset = decoded.x.o;
  } else {
    const full = JSON.stringify({ view, ...head, [field]: value });
    if (bytes(full) <= TASK_READ_RESULT_BUDGET_BYTES) return textResult(full);
  }
  const envelope = (chunk: Record<string, unknown>) => JSON.stringify({ view, ...head, field, ...chunk });
  const part = partOf(json, offset, envelope);
  if (!part) return errorResult(STALE_PART);
  const nextCursor =
    part.next !== undefined ? encodeCursor(scope, view, key, { v: 1, k: view, x: { id: key, o: part.next, h } }) : undefined;
  return textResult(envelope({ part: part.part, parts: part.parts, text: part.text, ...(nextCursor ? { nextCursor } : {}) }));
}
