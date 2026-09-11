import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hc } from 'hono/client';
import { z } from 'zod';
import {
  RUN_HISTORY_PAGE_ITEMS,
  apiRunSchema,
  changesPayloadSchema,
  githubChecksDataSchema,
  githubCommentsDataSchema,
  githubDataSchema,
  githubPrChangesDataSchema,
  githubPrMergeStateResponseSchema,
  githubRefStatusDataSchema,
  githubSearchDataSchema,
  repoCommitPayloadSchema,
  repoResponseSchema,
  runCommitsResponseSchema,
  runHistoryPageSchema,
  worktreeEntrySchema,
  type ApiRun,
} from '@qodeca/xezar-contract';
import { resolveTaskDiffBase, type GitRunner } from '../../git-diff-base.ts';
import { isSafeGitRef } from '../../git-refs.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { AppType } from '../../server/app-type.ts';
import { imageMimeType } from '../../server/git-changes.ts';
import {
  MCP_CURSOR_MAX_BYTES,
  openCursor,
  ownRun,
  ownWorkingDirectory,
  ownWorktreeFile,
  ownershipScope,
  sealCursor,
  type OwnershipScope,
} from '../resource-ownership.ts';
import { McpServiceAdapter, type ServiceDispatch } from '../service-adapter.ts';
import { defineTool, errorResult, textResult, type McpToolContext, type McpToolResult } from '../tool.ts';

/**
 * `read_results_evidence` (#95, F-10, M-08, M-10, M-11): the leader's reads of what a task
 * produced — its summary, history, changes, files, commits and handoff journal, the project's own
 * repository, and the GitHub issue, PR, comment, check and merge-state reads — each identified by
 * the REVISION it describes (`docs/features/mcp-server/mcp-result-evidence-fields.md`).
 *
 * WHERE THE DATA COMES FROM. Every payload is the cockpit's own: the read is dispatched in-process
 * into the bound project's chained routes (`/api/v1/p/<bound>/…`), the same way the shared service
 * adapter (#89) reaches the services, and parsed with the route's contract schema. Nothing here
 * re-implements a route, opens a store, or reads `.local/xezar`. What this module ADDS is only what
 * the field record says no run route returns today — the revision — and it gets it from git in the
 * run's own working directory, proved to be the bound project's by the ownership checks (#88):
 *
 *  - `revision.headSha` is read before AND after the route read; a tree that moved in between is
 *    read once more, and then answered as unavailable rather than labelled with a sha it may not
 *    describe.
 *  - `revision.baseSha` for `changes` is `resolveTaskDiffBase` fed the run's `branch` AND
 *    `startedAt` — the one rule AGENTS.md names for "which ref anchors this task's diff", and the
 *    same inputs the Changes route passes. A review run that checked another branch out is
 *    therefore anchored at that branch as the run found it, never at the whole branch's history
 *    (#591, #751). The text `/runs/:id/diff` keeps its whole-branch anchor on purpose, which is why
 *    it is NOT offered here (inventory I-052: "never the whole-branch anchor").
 *  - `commits` keeps the route's own `merge-base` anchor (correction C-6) and reports the task-diff
 *    anchor beside it, so a disagreement between the two lists is visible instead of silent.
 *
 * STALE AND MISSING ARE ANSWERS, NOT EMPTINESS (§ 1, § 4). A gone worktree is `evidence:
 * 'unavailable'` with the route's own 409 — never `{files: []}`. A caller that echoes the sha of an
 * earlier read as `expectedHeadSha` gets `freshness: 'stale'` when the tree moved. A continuation
 * cursor is bound to a digest of the page set it started, so continuing after the evidence changed
 * answers `evidence: 'stale'` instead of splicing two revisions together. `diffStat` from the run
 * record carries no revision, and says so (`measuredAtSha: null`). GitHub's `{available: false,
 * reason}` unions pass through unflattened, with `truncated` and per-file reasons intact (N-06).
 *
 * BOUNDS (D-09). One result is at most `RESULT_BUDGET_BYTES` (B-01) and at most 100 items (B-02);
 * an item larger than the budget is delivered in fragments with an explicit continuation (B-03);
 * cursors are sealed to this project and this read (B-04, A-04). The cockpit's own ceilings stay
 * as they are (B-06). The text block is the whole answer (D-05 § 6.8) — no `structuredContent`,
 * because repeating the payload there would double the result past B-01.
 *
 * WITHHELD. A file git ignores is not returned: that is where `.env` and the seeded personal
 * agent config live, and F-15 forbids a credential in a tool response. An `origin` remote URL
 * loses any embedded userinfo for the same reason.
 */

/** D-09 B-01: the serialized result content of one tool call, in UTF-8 bytes. */
export const RESULT_BUDGET_BYTES = 40_000;
/** D-09 B-02: the one page size, shared with the run history. */
const PAGE_ITEMS = RUN_HISTORY_PAGE_ITEMS;

export const RESULTS_EVIDENCE_READS = [
  'summary',
  'history',
  'changes',
  'files',
  'commits',
  'commit',
  'handoff',
  'repo',
  'repo_changes',
  'repo_commit',
  'github',
  'github_comments',
  'github_checks',
  'github_search',
  'github_ref_status',
  'pr_merge_state',
  'pr_changes',
] as const;
const readSchema = z.enum(RESULTS_EVIDENCE_READS);
export type ResultsEvidenceRead = z.infer<typeof readSchema>;

const shaInput = z.string().regex(/^[0-9a-fA-F]{4,40}$/, 'a commit sha: 4 to 40 hex characters');
const numberInput = z.number().int().positive().max(2 ** 31 - 1);

export const resultsEvidenceInputSchema = z
  .object({
    read: readSchema.describe('Which evidence to read.'),
    runId: z.string().min(1).max(256).optional().describe('The task id. Required by every task read.'),
    path: z.string().max(4096).optional().describe('files: a path relative to the task working directory; omit for its root.'),
    sha: shaInput.optional().describe('commit / repo_commit: the commit to read.'),
    number: numberInput.optional().describe('github_comments / pr_merge_state / pr_changes: the issue or PR number.'),
    kind: z.enum(['issue', 'pr']).optional().describe('github_comments / github_search: issue or pull request.'),
    prs: z.array(numberInput).min(1).max(100).optional().describe('github_checks / github_ref_status: PR numbers.'),
    issues: z.array(numberInput).min(1).max(100).optional().describe('github_ref_status: issue numbers.'),
    query: z.string().trim().min(1).max(256).optional().describe('github_search: the search text.'),
    limit: z.number().int().positive().max(100).optional().describe('github / github_search: how many items to ask GitHub for.'),
    refresh: z.boolean().optional().describe('GitHub reads: bypass the cockpit cache.'),
    expectedHeadSha: z
      .string()
      .regex(/^[0-9a-fA-F]{7,40}$/, 'a commit sha: 7 to 40 hex characters')
      .optional()
      .describe('The revision.headSha of an earlier read. The answer says whether that evidence is still current.'),
    cursor: z.string().min(1).max(MCP_CURSOR_MAX_BYTES).optional().describe('The page.next value of the previous page of this same read.'),
  })
  .strict();
export type ResultsEvidenceInput = z.infer<typeof resultsEvidenceInputSchema>;

/** What each read needs beyond `read`. Checked before anything is dispatched. */
const REQUIRED: Record<ResultsEvidenceRead, readonly (keyof ResultsEvidenceInput)[]> = {
  summary: ['runId'],
  history: ['runId'],
  changes: ['runId'],
  files: ['runId'],
  commits: ['runId'],
  commit: ['runId', 'sha'],
  handoff: ['runId'],
  repo: [],
  repo_changes: [],
  repo_commit: ['sha'],
  github: [],
  github_comments: ['kind', 'number'],
  github_checks: ['prs'],
  github_search: ['kind', 'query'],
  github_ref_status: [],
  pr_merge_state: ['number'],
  pr_changes: ['number'],
};

// ---- the answer's shape -------------------------------------------------------

const revisionSchema = z
  .object({
    /** The commit the evidence was read at. */
    headSha: z.string(),
    /** The working tree differed from `headSha` when it was read — the sha alone does not reproduce it. */
    uncommitted: z.boolean().optional(),
    /** The resolved diff anchor, as a sha. */
    baseSha: z.string().optional(),
    /** Which rule produced `baseSha`. */
    anchor: z.enum(['task-diff-base', 'merge-base', 'head']).optional(),
    /** `commits` only: the anchor `changes` uses, for comparison (correction C-6). */
    taskDiffBaseSha: z.string().optional(),
    /** HEAD was not on the task's own branch — the reason the anchor is what it is. */
    repointedHead: z.object({ headBranch: z.string(), taskBranch: z.string() }).optional(),
    /** `files`: the working-tree copy of this path equals `headSha`'s. */
    pathClean: z.boolean().optional(),
    /** `commit` / `repo_commit`: the commit's own full sha and committer instant. */
    commitSha: z.string().optional(),
    committedAt: z.string().optional(),
    /** `commit` / `repo_commit`: the commit is part of `headSha`'s history. */
    reachableFromHead: z.boolean().optional(),
  })
  .strict();
type Revision = z.infer<typeof revisionSchema>;

const envelopeSchema = z
  .object({
    read: readSchema,
    runId: z.string().optional(),
    /** `available` — here it is. `unavailable` — it cannot be read now (`status`, `reason`).
     *  `stale` — the evidence changed since the page this cursor continues. */
    evidence: z.enum(['available', 'unavailable', 'stale']),
    status: z.number().optional(),
    reason: z.string().optional(),
    /** Null when there is no working tree to read a revision from; absent on GitHub list reads. */
    revision: revisionSchema.nullable().optional(),
    /** Present only when `expectedHeadSha` was supplied. */
    freshness: z.enum(['current', 'stale']).optional(),
    /** `pr_merge_state` / `pr_changes` with a `runId`: whose head the forge evidence describes. */
    forgeRevision: z
      .object({
        prHeadSha: z.string().nullable(),
        runHeadSha: z.string().nullable(),
        match: z.enum(['same', 'different', 'unknown']),
      })
      .strict()
      .optional(),
    notes: z.array(z.string()).optional(),
    page: z
      .object({
        /** Items (or, for text, UTF-16 code units) `[from, to)` of `total`. */
        from: z.number(),
        to: z.number(),
        total: z.number(),
        unit: z.enum(['items', 'characters']),
        /** This page's data is one serialized JSON document delivered in pieces: concatenate
         *  `fragment` from chunk 0 to `count - 1`, then parse. */
        chunk: z.object({ index: z.number(), count: z.number() }).strict().optional(),
        digest: z.string(),
        next: z.string().optional(),
      })
      .strict()
      .optional(),
    data: z.unknown().optional(),
    fragment: z.string().optional(),
  })
  .strict();
type Envelope = z.infer<typeof envelopeSchema>;

const NOTES = {
  done: "status 'done' says the task's chain reached its end. It is not proof that checks passed: per-check outcomes are not recorded, so read them as unknown.",
  diffStat: "diffStat carries no revision (measuredAtSha is null) and may describe an older head. Read 'changes' for numbers tied to revision.headSha.",
  uncommitted: 'The working tree has uncommitted changes, so revision.headSha alone does not reproduce this evidence.',
  commitsAnchor:
    "This list is anchored at the merge-base with the configured base branch (revision.baseSha), which is not the anchor 'changes' uses (revision.taskDiffBaseSha). The two can disagree.",
  checks:
    'Check rows carry no revision of their own, and GitHub may report skipped or neutral checks as passing. They describe prHeadSha at best — compare it with the task head before relying on them.',
  checksAbsent: 'A PR number missing from checks means xezar got no answer for it or it has no checks: unknown, never passing.',
  noWorkingTree: 'The task has no working tree to read a revision from, so nothing here is tied to a revision.',
  withheld:
    'git ignores this path. Ignored files (.env, personal agent config) can hold credentials, so their content is not returned over MCP.',
} as const;

const NOT_FOUND = 'not found in this project';
const NOT_CONNECTED =
  'read_results_evidence is not connected to the running cockpit (the tool context carries no service entry). Nothing was read.';
const MOVED = 'The working tree moved while it was being read, twice. Read it again.';

// ---- the tool -----------------------------------------------------------------

/** How the tool reaches the running service's in-process entry (the Hono app). */
export type ServiceResolver = (ctx: McpToolContext) => ServiceDispatch | undefined;

/**
 * The context field this tool reads its service entry from. `McpToolContext` is widened
 * additively by the tool infrastructure (`../tool.ts`); until the running service puts its app
 * there, the tool answers `NOT_CONNECTED` and reads nothing.
 */
const serviceFromContext: ServiceResolver = (ctx) => (ctx as McpToolContext & { readonly service?: ServiceDispatch }).service;

export function createResultsEvidenceTool(resolveService: ServiceResolver = serviceFromContext) {
  return defineTool({
    name: 'read_results_evidence',
    title: 'Read task results and evidence',
    description: [
      "Read what a task produced and the project's GitHub state, each answer identified by the revision it describes.",
      "Task reads (need runId): summary, history, changes (the task's own diff, anchored like the cockpit's Changes tab), files (path), commits, commit (sha), handoff.",
      'Repository reads: repo, repo_changes, repo_commit (sha). GitHub reads: github, github_comments, github_checks, github_search, github_ref_status, pr_merge_state, pr_changes.',
      "Every task read returns revision.headSha. Pass it back later as expectedHeadSha to learn whether that evidence is still current (freshness: 'stale' when the tree moved).",
      "evidence: 'unavailable' means it cannot be read now (for example the worktree was reclaimed) — never that nothing changed. 'done' is not proof that checks passed.",
      'Answers are paged (page.next); a page that is one large item comes as fragments to concatenate. This is a read for assessment, not a status poll.',
    ].join(' '),
    inputSchema: resultsEvidenceInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async call(args, ctx) {
      const missing = REQUIRED[args.read].filter((key) => args[key] === undefined);
      if (missing.length > 0) return errorResult(`read '${args.read}' needs: ${missing.join(', ')}`);
      if (args.read === 'github_ref_status' && !args.prs && !args.issues) {
        return errorResult("read 'github_ref_status' needs prs, issues or both");
      }
      const service = resolveService(ctx);
      if (!service) return errorResult(NOT_CONNECTED);
      return new EvidenceReader(ctx.project, service).read(args);
    },
  });
}

export const resultsEvidenceTool = createResultsEvidenceTool();

// ---- the typed in-process client ------------------------------------------------

/** The same in-process dispatch the shared adapter uses: loopback `host`, no `Origin`. The
 *  operations below are additional READS the adapter's closed table does not carry yet. */
const buildClient = (service: ServiceDispatch) =>
  hc<AppType>('http://127.0.0.1', {
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('host', '127.0.0.1');
      headers.delete('origin');
      const url = input instanceof Request ? input.url : String(input);
      return service.request(url, { ...init, headers });
    },
  });
type ScopedApi = ReturnType<typeof buildClient>['api']['v1']['p'][':projectId'];

/** A route's answer, read once: its status and its raw body text. */
interface Answer {
  status: number;
  body: string;
}

async function answerOf(pending: Promise<{ status: number; text(): Promise<string> }>): Promise<Answer> {
  const res = await pending;
  return { status: res.status, body: await res.text() };
}

function jsonOf(answer: Answer): unknown {
  try {
    return JSON.parse(answer.body) as unknown;
  } catch {
    return undefined;
  }
}

function errorOf(answer: Answer): string {
  const body = jsonOf(answer);
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return `the service answered ${answer.status}`;
}

// ---- git, read-only ---------------------------------------------------------------

/**
 * A `git` runner bound to one directory. `GIT_OPTIONAL_LOCKS=0` keeps every probe from
 * rewriting the index it reads — `resolveTaskDiffBase` compares anchors with `git diff`, which
 * would otherwise refresh the stat cache of a `worktree: false` run's REAL index. Never throws.
 */
function gitIn(dir: string): GitRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        'git',
        args,
        {
          cwd: dir,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          timeout: 15_000,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        },
        (err, stdout) => resolve({ ok: !err, stdout: stdout ?? '' }),
      );
    });
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/** A ref as a full sha, or null. Refs come from a run record or a resolved anchor, never raw input. */
async function commitSha(git: GitRunner, ref: string): Promise<string | null> {
  if (!isSafeGitRef(ref)) return null;
  const res = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = res.ok ? res.stdout.trim() : '';
  return FULL_SHA.test(sha) ? sha : null;
}

async function isDirty(git: GitRunner, path?: string): Promise<boolean> {
  const res = await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal', ...(path ? ['--', path] : [])]);
  return !res.ok || res.stdout.length > 0;
}

/** The instant a commit was made, ISO-8601 — the comparable sibling of git's relative `when`. */
async function committedAt(git: GitRunner, sha: string): Promise<string | undefined> {
  const res = await git(['show', '-s', '--format=%cI', sha]);
  return res.ok && res.stdout.trim() ? res.stdout.trim() : undefined;
}

/** A remote URL without any `user:token@` it may carry (F-15). */
function withoutUserinfo(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

// ---- paging -----------------------------------------------------------------------

/** Where a continuation resumes: item or character offset `o`, fragment `c`, the digest `d` of the
 *  page set it started, and — for history — the route's own cursor `r`. */
const positionSchema = z.object({ o: z.number().int().nonnegative(), c: z.number().int().nonnegative(), d: z.string(), r: z.string().optional() }).strict();
type Position = z.infer<typeof positionSchema>;
const START: Position = { o: 0, c: 0, d: '' };

/** How a payload pages: across its item lists in order, by one text field, or not at all. */
type Shape = { lists: readonly string[] } | { text: string } | { whole: true };

/** A result's size as the client receives it: the envelope is the text of one content block, so
 *  it is escaped a second time on the wire — that serialized content is what B-01 counts. */
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(value) }]), 'utf8');
}

/** One character's cost inside a fragment on the wire: escaped as JSON text, then again. */
function wireCost(ch: string): number {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(ch).slice(1, -1)), 'utf8') - 2;
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/** A placeholder as long as the longest `next` a page can carry, so a measured page stays within
 *  budget whatever cursor ends up in it. */
const NEXT_PLACEHOLDER = 'x'.repeat(MCP_CURSOR_MAX_BYTES);

interface PageOutcome {
  envelope: Envelope;
  /** Where the next page starts, or null at the end of this payload. */
  next: Position | null;
}

type Page = NonNullable<Envelope['page']>;

function listSlice(data: Record<string, unknown>, lists: readonly string[], from: number, to: number): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  let offset = 0;
  for (const key of lists) {
    const items = Array.isArray(data[key]) ? (data[key] as unknown[]) : undefined;
    if (!items) continue;
    out[key] = items.slice(Math.max(0, from - offset), Math.max(0, to - offset));
    offset += items.length;
  }
  return out;
}

function listTotal(data: Record<string, unknown>, lists: readonly string[]): number {
  return lists.reduce((n, key) => n + (Array.isArray(data[key]) ? (data[key] as unknown[]).length : 0), 0);
}

/**
 * One page of `data` from `at`, under B-01 and B-02. A page that is a single item (or a whole
 * payload with no list) larger than the budget is serialized and cut into fragments whose
 * ESCAPED size on the wire fits (B-03, and D-09 E3b: escaping can inflate a string six-fold).
 */
function pageOf(base: Envelope, data: Record<string, unknown>, shape: Shape, at: Position, digest: string): PageOutcome {
  const fits = (candidate: Envelope): boolean => bytes(candidate) <= RESULT_BUDGET_BYTES;
  const withPage = (page: Omit<Page, 'digest' | 'next'>, extra: Partial<Envelope>): Envelope => ({
    ...base,
    page: { ...page, digest, next: NEXT_PLACEHOLDER },
    ...extra,
  });

  if ('text' in shape) {
    const text = typeof data[shape.text] === 'string' ? (data[shape.text] as string) : '';
    const total = text.length;
    const from = Math.min(at.o, total);
    const envAt = (to: number): Envelope =>
      withPage({ from, to, total, unit: 'characters' }, { data: { ...data, [shape.text]: text.slice(from, to) } });
    // The largest `to` that fits, by bisection over code units, never splitting a surrogate pair.
    let lo = from;
    let hi = total;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(envAt(mid))) lo = mid;
      else hi = mid - 1;
    }
    let to = lo;
    if (to < total && to > from && /[\uD800-\uDBFF]/.test(text[to - 1] ?? '')) to -= 1;
    if (to === from && from < total) to = Math.min(total, from + 1); // pathological: metadata alone fills the budget
    return { envelope: envAt(to), next: to < total ? { o: to, c: 0, d: digest } : null };
  }

  const lists = 'lists' in shape ? shape.lists : [];
  const total = listTotal(data, lists);
  const from = Math.min(at.o, total);
  const envAt = (to: number): Envelope =>
    withPage({ from, to, total, unit: 'items' }, { data: lists.length ? listSlice(data, lists, from, to) : data });

  if (lists.length > 0 && at.c === 0) {
    let to = from;
    while (to < total && to - from < PAGE_ITEMS && fits(envAt(to + 1))) to += 1;
    if (to > from || total === 0) {
      return { envelope: envAt(to), next: to < total ? { o: to, c: 0, d: digest } : null };
    }
  } else if (lists.length === 0 && fits(envAt(0))) {
    return { envelope: envAt(0), next: null };
  }

  // One item (or the whole payload) is larger than a result: deliver it in fragments.
  const to = lists.length ? Math.min(total, from + 1) : 0;
  const pageData = lists.length ? listSlice(data, lists, from, to) : data;
  const json = JSON.stringify(pageData);
  const frame = withPage({ from, to, total, unit: 'items', chunk: { index: 999_999, count: 999_999 } }, { fragment: '' });
  const allowance = RESULT_BUDGET_BYTES - bytes(frame);
  const fragments: string[] = [];
  let current = '';
  let used = 0;
  for (const ch of json) {
    const cost = wireCost(ch);
    if (used + cost > allowance && current) {
      fragments.push(current);
      current = '';
      used = 0;
    }
    current += ch;
    used += cost;
  }
  if (current || fragments.length === 0) fragments.push(current);
  const index = Math.min(at.c, fragments.length - 1);
  const envelope = withPage(
    { from, to, total, unit: 'items', chunk: { index, count: fragments.length } },
    { fragment: fragments[index] ?? '' },
  );
  const next: Position | null =
    index + 1 < fragments.length
      ? { o: from, c: index + 1, d: digest }
      : lists.length && to < total
        ? { o: to, c: 0, d: digest }
        : null;
  return { envelope, next };
}

// ---- the reader ---------------------------------------------------------------------

interface RunView {
  run: ApiRun;
  scope: OwnershipScope;
  /** The run's own working directory, or null when it has none (in-place history, reclaimed). */
  dir: string | null;
}

type Opened = { ok: true; view: RunView } | { ok: false; result: McpToolResult };

/** What one read produced before paging. */
interface Evidence {
  base: Omit<Envelope, 'evidence' | 'page' | 'data' | 'fragment'>;
  data: Record<string, unknown>;
  shape: Shape;
  /** History only: the route cursor of the next older route page. */
  olderRouteCursor?: string;
}

type Produced = { ok: true; evidence: Evidence } | { ok: false; result: McpToolResult };

class EvidenceReader {
  private readonly api: ScopedApi;
  private readonly adapter: McpServiceAdapter;
  private readonly scopeParam: { projectId: string };

  constructor(
    private readonly project: McpToolContext['project'],
    service: ServiceDispatch,
  ) {
    this.adapter = new McpServiceAdapter({ projectId: project.id, service });
    this.api = buildClient(service).api.v1.p[':projectId'];
    this.scopeParam = { projectId: project.id };
  }

  async read(args: ResultsEvidenceInput): Promise<McpToolResult> {
    // A cursor is sealed to this project AND this exact read: the same read of another task, path,
    // sha or number cannot continue from it (A-04 — a foreign cursor never widens scope).
    const resource = JSON.stringify([
      args.read,
      args.runId ?? null,
      args.path ?? null,
      args.sha?.toLowerCase() ?? null,
      args.number ?? null,
      args.kind ?? null,
      args.prs ?? null,
      args.issues ?? null,
      args.query ?? null,
      args.limit ?? null,
    ]);
    const cursorScope = this.projectScope();
    let at = START;
    if (args.cursor !== undefined) {
      const opened = openCursor(cursorScope, resource, args.cursor);
      if (!opened.ok) return errorResult(opened.message);
      const parsed = positionSchema.safeParse(safeJson(opened.value));
      if (!parsed.success) return errorResult('invalid cursor — request the first page again');
      at = parsed.data;
    }

    const produced = await this.produce(args, at.r);
    if (!produced.ok) return produced.result;
    const { base, data, shape } = produced.evidence;
    const digest = digestOf({ revision: base.revision ?? null, forge: base.forgeRevision ?? null, data });
    if (at.d !== '' && at.d !== digest) {
      return this.respond({
        ...base,
        evidence: 'stale',
        reason: 'This evidence changed since the page this cursor continues was read. Read it again from the first page.',
      });
    }
    // A forge that could not answer says so in its own payload; the envelope says it once more at
    // the top, and leaves the union itself exactly as the route sent it.
    const forgeDown = data.available === false;
    const outcome = pageOf(
      {
        ...base,
        evidence: forgeDown ? 'unavailable' : 'available',
        ...(forgeDown && typeof data.reason === 'string' ? { reason: data.reason } : {}),
      },
      data,
      shape,
      at,
      digest,
    );
    // Inside one route page of history the route cursor rides along; past its end, the next
    // position is the route's own older page, whose digest is not known until it is read.
    let next = outcome.next && at.r !== undefined ? { ...outcome.next, r: at.r } : outcome.next;
    if (!next && produced.evidence.olderRouteCursor) next = { o: 0, c: 0, d: '', r: produced.evidence.olderRouteCursor };
    const { next: _placeholder, ...page } = outcome.envelope.page!;
    return this.respond({
      ...outcome.envelope,
      page: { ...page, ...(next ? { next: sealCursor(cursorScope, resource, JSON.stringify(next)) } : {}) },
    });
  }

  /** Validate against the envelope schema (a key nobody declared becomes a failure, not a leak)
   *  and send the text block only. */
  private respond(envelope: Envelope): McpToolResult {
    return textResult(JSON.stringify(envelopeSchema.parse(envelope)));
  }

  private async produce(args: ResultsEvidenceInput, routeCursor: string | undefined): Promise<Produced> {
    switch (args.read) {
      case 'summary':
        return this.summary(args);
      case 'history':
        return this.history(args, routeCursor);
      case 'changes':
        return this.changes(args);
      case 'files':
        return this.files(args);
      case 'commits':
        return this.commits(args);
      case 'commit':
        return this.commit(args);
      case 'handoff':
        return this.handoff(args);
      case 'repo':
        return this.repo(args);
      case 'repo_changes':
        return this.repoChanges(args);
      case 'repo_commit':
        return this.repoCommit(args);
      default:
        return this.github(args);
    }
  }

  // ---- scopes and runs ----

  /** The bound project as ownership sees it, with no run in reach — cursors and GitHub reads. */
  private projectScope(run?: RunRecord): OwnershipScope {
    return ownershipScope({
      root: this.project.root,
      // The one record the SERVICE answered for this project — never a second store.
      store: {
        getRun: (id: string) => (run && run.id === id ? run : undefined),
        listRuns: () => (run ? [run] : []),
      },
      automationStore: { get: () => undefined, latestReceipts: () => new Map() },
    });
  }

  /** The run, from the bound project's own route, with its working directory proved to be ours. */
  private async openRun(runId: string): Promise<Opened> {
    const got = await this.adapter.getRun(runId);
    if (!got.ok) {
      return { ok: false, result: errorResult(got.status === 404 || got.status === 400 ? NOT_FOUND : got.error) };
    }
    const parsed = apiRunSchema.safeParse(got.value);
    if (!parsed.success) return { ok: false, result: errorResult('the service answered an unexpected task shape') };
    const run = parsed.data;
    const scope = this.projectScope(run as RunRecord);
    // Lexical containment first: a record naming another tree is refused before any path is touched.
    const owned = ownRun(scope, run.id);
    if (!owned.ok) return { ok: false, result: errorResult(owned.message) };
    const gone = run.worktree !== false && (run.worktreePath === undefined || !existsSync(run.worktreePath));
    if (gone) return { ok: true, view: { run, scope, dir: null } };
    const dir = await ownWorkingDirectory(scope, run.id);
    if (!dir.ok) return { ok: false, result: errorResult(dir.message) };
    return { ok: true, view: { run, scope, dir: dir.value.directory } };
  }

  private runParam(run: ApiRun): { projectId: string; id: string } {
    return { ...this.scopeParam, id: run.id };
  }

  /**
   * Read `fetch` between two HEAD reads. Equal → the answer describes that head. A tree that
   * moved is read once more, then refused rather than labelled with a sha it may not describe.
   */
  private async atHead<T>(dir: string, fetch: () => Promise<T>): Promise<{ ok: true; head: string | null; value: T } | { ok: false }> {
    const git = gitIn(dir);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await commitSha(git, 'HEAD');
      const value = await fetch();
      const after = await commitSha(git, 'HEAD');
      if (before === after) return { ok: true, head: after, value };
    }
    return { ok: false };
  }

  private unavailable(args: ResultsEvidenceInput, status: number, reason: string, extra: Partial<Envelope> = {}): Produced {
    return {
      ok: false,
      result: this.respond({
        read: args.read,
        ...(args.runId ? { runId: args.runId } : {}),
        evidence: 'unavailable',
        status,
        reason,
        ...extra,
      }),
    };
  }

  /** The route refused, or the worktree is gone: surface the service's own status and words (§ 4). */
  private refused(args: ResultsEvidenceInput, answer: Answer, run?: ApiRun): Produced {
    if (answer.status === 404) return { ok: false, result: errorResult(NOT_FOUND) };
    if (answer.status === 400) return { ok: false, result: errorResult(`read '${args.read}' was refused: ${errorOf(answer)}`) };
    if (answer.status >= 500) return { ok: false, result: errorResult(`read '${args.read}' failed inside xezar; the cockpit's log has the details.`) };
    const reclaimed = run?.worktreeReclaimedAt
      ? ` The worktree was reclaimed at ${run.worktreeReclaimedAt}; its branch is kept.`
      : '';
    return this.unavailable(args, answer.status, `${errorOf(answer)}${reclaimed}`);
  }

  private freshness(args: ResultsEvidenceInput, head: string | null): Partial<Envelope> {
    if (!args.expectedHeadSha) return {};
    const expected = args.expectedHeadSha.toLowerCase();
    return { freshness: head !== null && head.startsWith(expected) ? 'current' : 'stale' };
  }

  private baseFor(args: ResultsEvidenceInput, revision: Revision | null, notes: string[] = []): Evidence['base'] {
    return {
      read: args.read,
      ...(args.runId ? { runId: args.runId } : {}),
      revision,
      ...this.freshness(args, revision?.headSha ?? null),
      ...(notes.length ? { notes } : {}),
    };
  }

  /** Open the run and require its working directory, answering the route's own refusal when it
   *  is gone — the route is still asked, so the 409 and its words are the cockpit's. */
  private async runWithTree(
    args: ResultsEvidenceInput,
    probe: (run: ApiRun) => Promise<Answer>,
  ): Promise<{ ok: true; view: RunView & { dir: string } } | { ok: false; result: McpToolResult }> {
    const opened = await this.openRun(args.runId!);
    if (!opened.ok) return opened;
    const { view } = opened;
    if (view.dir === null) {
      const answer = await probe(view.run);
      const refusal =
        answer.status === 200
          ? this.unavailable(args, 409, "The task's working directory changed while it was being read. Read it again.")
          : this.refused(args, answer, view.run);
      return { ok: false, result: (refusal as { ok: false; result: McpToolResult }).result };
    }
    return { ok: true, view: { ...view, dir: view.dir } };
  }

  // ---- task reads ----

  private async summary(args: ResultsEvidenceInput): Promise<Produced> {
    const opened = await this.openRun(args.runId!);
    if (!opened.ok) return opened;
    const { run, dir } = opened.view;
    const git = dir ? gitIn(dir) : null;
    const head = git ? await commitSha(git, 'HEAD') : null;
    const revision: Revision | null = git && head ? { headSha: head, uncommitted: await isDirty(git) } : null;
    const notes: string[] = [NOTES.done];
    if (run.diffStat) notes.push(NOTES.diffStat);
    if (!revision) notes.push(NOTES.noWorkingTree);
    else if (revision.uncommitted) notes.push(NOTES.uncommitted);
    // A slim projection (D-05 § 6.8): never the prompt, the system prompt, the workflow definition
    // or the agent account.
    const data: Record<string, unknown> = {
      id: run.id,
      title: run.titleSummary ?? run.title,
      status: run.status,
      workflow: run.workflow,
      createdAt: run.createdAt,
      ...pick(run, ['startedAt', 'finishedAt', 'error', 'branch', 'baseBranch', 'worktreeReclaimedAt', 'model', 'runner']),
      worktree: run.worktree === false ? 'in-place' : 'isolated',
      workingTreeAvailable: dir !== null,
      ...(run.diffStat ? { diffStat: { ...run.diffStat, measuredAtSha: null } } : {}),
      ...pick(run, ['pullRequestUrl', 'referencedPullRequestUrl', 'prNumber', 'issueNumber', 'referencedIssueUrl']),
      steps: run.steps.map((step) => ({
        id: step.id,
        name: step.name,
        kind: step.kind,
        status: step.status,
        iterations: step.iterations,
        ...pick(step, ['startedAt', 'finishedAt', 'error']),
      })),
    };
    return { ok: true, evidence: { base: this.baseFor(args, revision, notes), data, shape: { lists: ['steps'] } } };
  }

  private async history(args: ResultsEvidenceInput, routeCursor: string | undefined): Promise<Produced> {
    const opened = await this.openRun(args.runId!);
    if (!opened.ok) return opened;
    const { run, dir } = opened.view;
    const answer = await answerOf(
      this.api.runs[':id'].history.$get({ param: this.runParam(run), query: routeCursor ? { cursor: routeCursor } : {} }),
    );
    if (answer.status !== 200) return this.refused(args, answer, run);
    const page = runHistoryPageSchema.safeParse(jsonOf(answer));
    if (!page.success) return { ok: false, result: errorResult('the service answered an unexpected history shape') };
    const head = dir ? await commitSha(gitIn(dir), 'HEAD') : null;
    const revision: Revision | null = head ? { headSha: head } : null;
    const { olderCursor, newerCursor: _newer, liveCursor: _live, ...data } = page.data;
    return {
      ok: true,
      evidence: {
        base: this.baseFor(args, revision),
        data,
        shape: { lists: ['events'] },
        ...(page.data.hasOlder && olderCursor ? { olderRouteCursor: olderCursor } : {}),
      },
    };
  }

  private async changes(args: ResultsEvidenceInput): Promise<Produced> {
    const probe = (run: ApiRun) => answerOf(this.api.runs[':id'].changes.$get({ param: this.runParam(run) }));
    const target = await this.runWithTree(args, probe);
    if (!target.ok) return target;
    const { run, dir } = target.view;
    const git = gitIn(dir);
    const read = await this.atHead(dir, async () => {
      const answer = await probe(run);
      // The anchor this diff was measured from: the ONE rule, fed the run's branch AND its start,
      // exactly as the route feeds `collectChanges` (AGENTS.md § Git/worktree; #591, #751).
      const baseBranch = run.baseBranch ?? 'HEAD';
      const anchor = isSafeGitRef(baseBranch)
        ? await resolveTaskDiffBase(git, baseBranch, { taskBranch: run.branch, runStartedAt: run.startedAt })
        : null;
      return { answer, anchor };
    });
    if (!read.ok) return this.unavailable(args, 409, MOVED);
    const { answer, anchor } = read.value;
    if (answer.status !== 200) return this.refused(args, answer, run);
    const payload = changesPayloadSchema.safeParse(jsonOf(answer));
    if (!payload.success || !read.head) return { ok: false, result: errorResult('the service answered an unexpected changes shape') };
    const baseSha = anchor ? await commitSha(git, anchor.base) : null;
    const revision: Revision = {
      headSha: read.head,
      uncommitted: await isDirty(git),
      ...(baseSha ? { baseSha, anchor: 'task-diff-base' as const } : {}),
      ...(anchor?.repointedHead ? { repointedHead: anchor.repointedHead } : {}),
    };
    return {
      ok: true,
      evidence: {
        base: this.baseFor(args, revision, revision.uncommitted ? [NOTES.uncommitted] : []),
        data: payload.data,
        shape: { lists: ['files'] },
      },
    };
  }

  private async files(args: ResultsEvidenceInput): Promise<Produced> {
    const probeFor = (run: ApiRun) => (path: string) =>
      answerOf(this.api.runs[':id'].files.$get({ param: this.runParam(run), query: { path } }));
    const target = await this.runWithTree(args, (run) => probeFor(run)(''));
    if (!target.ok) return target;
    const { run, scope, dir } = target.view;
    const probe = probeFor(run);
    // A-04: absolute, `..`, `.git`, `.local` and any symlinked component are refused BEFORE any
    // content is read. The route keeps its own traversal, symlink and size checks behind this.
    const owned = await ownWorktreeFile(scope, run.id, args.path ?? '');
    if (!owned.ok) return { ok: false, result: errorResult(owned.message) };
    const path = owned.value.path;
    const git = gitIn(dir);
    const read = await this.atHead(dir, () => probe(path));
    if (!read.ok) return this.unavailable(args, 409, MOVED);
    const answer = read.value;
    if (answer.status !== 200) return this.refused(args, answer, run);
    const entry = worktreeEntrySchema.safeParse(jsonOf(answer));
    if (!entry.success || !read.head) return { ok: false, result: errorResult('the service answered an unexpected file shape') };
    const revision: Revision = { headSha: read.head };
    if (entry.data.type === 'dir') {
      return {
        ok: true,
        evidence: { base: this.baseFor(args, { ...revision, uncommitted: await isDirty(git, path || '.') }), data: entry.data, shape: { lists: ['entries'] } },
      };
    }
    const file = entry.data;
    const pathRevision: Revision = { ...revision, pathClean: !(await isDirty(git, path)) };
    const ignored = (await git(['check-ignore', '-q', '--', path])).ok;
    const common = { type: 'file' as const, path: file.path, size: file.size };
    // The cockpit's own order (`previewKind`): too large, then image, then binary, then text.
    let data: Record<string, unknown>;
    let shape: Shape = { whole: true };
    const notes: string[] = [];
    if (ignored) {
      data = { ...common, state: 'withheld' };
      notes.push(NOTES.withheld);
    } else if (file.tooLarge) {
      data = { ...common, state: 'too-large' };
    } else if (imageMimeType(file.path) !== null) {
      data = { ...common, state: 'image', mimeType: imageMimeType(file.path) };
    } else if (file.binary) {
      data = { ...common, state: 'binary' };
    } else {
      data = { ...common, state: 'text', content: file.content ?? '' };
      shape = { text: 'content' };
    }
    return { ok: true, evidence: { base: this.baseFor(args, pathRevision, notes), data, shape } };
  }

  private async commits(args: ResultsEvidenceInput): Promise<Produced> {
    const probe = (run: ApiRun) => answerOf(this.api.runs[':id'].commits.$get({ param: this.runParam(run) }));
    const target = await this.runWithTree(args, probe);
    if (!target.ok) return target;
    const { run, dir } = target.view;
    const git = gitIn(dir);
    const baseBranch = run.baseBranch ?? 'HEAD';
    const read = await this.atHead(dir, async () => {
      const answer = await probe(run);
      // The route's own anchor (C-6): `merge-base <baseBranch> HEAD`, falling back to the name.
      const mergeBase = isSafeGitRef(baseBranch) ? await git(['merge-base', baseBranch, 'HEAD']) : { ok: false, stdout: '' };
      const listBase = mergeBase.ok && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : baseBranch;
      const anchor = isSafeGitRef(baseBranch)
        ? await resolveTaskDiffBase(git, baseBranch, { taskBranch: run.branch, runStartedAt: run.startedAt })
        : null;
      const log = isSafeGitRef(listBase) ? await git(['log', '--format=%H%x1f%cI', `${listBase}..HEAD`]) : { ok: false, stdout: '' };
      return { answer, listBase, anchor, log };
    });
    if (!read.ok) return this.unavailable(args, 409, MOVED);
    const { answer, listBase, anchor, log } = read.value;
    if (answer.status !== 200) return this.refused(args, answer, run);
    const payload = runCommitsResponseSchema.safeParse(jsonOf(answer));
    if (!payload.success || !read.head) return { ok: false, result: errorResult('the service answered an unexpected commits shape') };
    const when = new Map(
      log.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\x1f') as [string, string]),
    );
    const baseSha = await commitSha(git, listBase);
    const taskDiffBaseSha = anchor ? await commitSha(git, anchor.base) : null;
    const revision: Revision = {
      headSha: read.head,
      ...(baseSha ? { baseSha, anchor: 'merge-base' as const } : {}),
      ...(taskDiffBaseSha ? { taskDiffBaseSha } : {}),
      ...(anchor?.repointedHead ? { repointedHead: anchor.repointedHead } : {}),
    };
    const notes = baseSha && taskDiffBaseSha && baseSha !== taskDiffBaseSha ? [NOTES.commitsAnchor] : [];
    const data = {
      commits: payload.data.commits.map((commit) => {
        const at = when.get(commit.sha);
        return at ? { ...commit, committedAt: at } : commit;
      }),
    };
    return { ok: true, evidence: { base: this.baseFor(args, revision, notes), data, shape: { lists: ['commits'] } } };
  }

  private async commit(args: ResultsEvidenceInput): Promise<Produced> {
    const sha = args.sha!.toLowerCase();
    const probe = (run: ApiRun) =>
      answerOf(this.api.runs[':id'].commit[':sha'].$get({ param: { ...this.runParam(run), sha } }));
    const target = await this.runWithTree(args, probe);
    if (!target.ok) return target;
    const { run, dir } = target.view;
    return this.commitEvidence(args, dir, () => probe(run), run);
  }

  private async commitEvidence(args: ResultsEvidenceInput, dir: string, probe: () => Promise<Answer>, run?: ApiRun): Promise<Produced> {
    const git = gitIn(dir);
    const read = await this.atHead(dir, probe);
    if (!read.ok) return this.unavailable(args, 409, MOVED);
    const answer = read.value;
    if (answer.status !== 200) return this.refused(args, answer, run);
    const payload = repoCommitPayloadSchema.safeParse(jsonOf(answer));
    if (!payload.success || !read.head) return { ok: false, result: errorResult('the service answered an unexpected commit shape') };
    const full = payload.data.sha;
    const at = FULL_SHA.test(full) ? await committedAt(git, full) : undefined;
    const reachable = FULL_SHA.test(full) ? (await git(['merge-base', '--is-ancestor', full, 'HEAD'])).ok : false;
    const revision: Revision = {
      headSha: read.head,
      commitSha: full,
      ...(at ? { committedAt: at } : {}),
      reachableFromHead: reachable,
    };
    return { ok: true, evidence: { base: this.baseFor(args, revision), data: payload.data, shape: { lists: ['files'] } } };
  }

  private async handoff(args: ResultsEvidenceInput): Promise<Produced> {
    const opened = await this.openRun(args.runId!);
    if (!opened.ok) return opened;
    const { run, dir } = opened.view;
    const answer = await answerOf(this.api.runs[':id'].handoff.$get({ param: this.runParam(run) }));
    if (answer.status !== 200) return this.refused(args, answer, run);
    // The journal is not versioned by git; the head it sits beside is the context it describes.
    const head = dir ? await commitSha(gitIn(dir), 'HEAD') : null;
    return {
      ok: true,
      evidence: {
        base: this.baseFor(args, head ? { headSha: head } : null, head ? [] : [NOTES.noWorkingTree]),
        data: { markdown: answer.body },
        shape: { text: 'markdown' },
      },
    };
  }

  // ---- repository reads (the project's main checkout, M-10) ----

  private async repo(args: ResultsEvidenceInput): Promise<Produced> {
    const root = this.project.root;
    const read = await this.atHead(root, () => answerOf(this.api.repo.$get({ param: this.scopeParam })));
    if (!read.ok) return this.unavailable(args, 409, MOVED);
    if (read.value.status !== 200) return this.refused(args, read.value);
    const payload = repoResponseSchema.safeParse(jsonOf(read.value));
    if (!payload.success) return { ok: false, result: errorResult('the service answered an unexpected repository shape') };
    const data: Record<string, unknown> = { ...payload.data };
    if (payload.data.info?.remote) data.info = { ...payload.data.info, remote: withoutUserinfo(payload.data.info.remote) };
    const revision: Revision | null = read.head ? { headSha: read.head, uncommitted: await isDirty(gitIn(root)) } : null;
    return { ok: true, evidence: { base: this.baseFor(args, revision), data, shape: { lists: ['status', 'log', 'branches'] } } };
  }

  private async repoChanges(args: ResultsEvidenceInput): Promise<Produced> {
    const root = this.project.root;
    const read = await this.atHead(root, () => answerOf(this.api.repo.changes.$get({ param: this.scopeParam })));
    if (!read.ok) return this.unavailable(args, 409, MOVED);
    if (read.value.status !== 200) return this.refused(args, read.value);
    const payload = changesPayloadSchema.safeParse(jsonOf(read.value));
    if (!payload.success || !read.head) return { ok: false, result: errorResult('the service answered an unexpected changes shape') };
    // The main checkout's working diff is measured against HEAD itself.
    const revision: Revision = { headSha: read.head, uncommitted: await isDirty(gitIn(root)), baseSha: read.head, anchor: 'head' };
    return { ok: true, evidence: { base: this.baseFor(args, revision), data: payload.data, shape: { lists: ['files'] } } };
  }

  private async repoCommit(args: ResultsEvidenceInput): Promise<Produced> {
    const sha = args.sha!.toLowerCase();
    return this.commitEvidence(args, this.project.root, () =>
      answerOf(this.api.repo.commit[':sha'].$get({ param: { ...this.scopeParam, sha }, query: { structured: '1' } })),
    );
  }

  // ---- GitHub reads (M-11: the repository is the bound project's — no argument names one) ----

  private async github(args: ResultsEvidenceInput): Promise<Produced> {
    const refresh = args.refresh ? '1' : undefined;
    const q = (query: Record<string, string | undefined>) =>
      Object.fromEntries(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const github = this.api.github;
    let answer: Answer;
    let schema: z.ZodType<Record<string, unknown>>;
    let shape: Shape = { whole: true };
    const notes: string[] = [];
    switch (args.read) {
      case 'github':
        answer = await answerOf(github.$get({ param: this.scopeParam, query: q({ limit: args.limit ? String(args.limit) : undefined, refresh }) }));
        schema = githubDataSchema;
        shape = { lists: ['issues', 'prs'] };
        break;
      case 'github_comments':
        answer = await answerOf(
          github.comments[':kind'][':number'].$get({
            param: { ...this.scopeParam, kind: args.kind!, number: String(args.number) },
            query: q({ refresh }),
          }),
        );
        schema = githubCommentsDataSchema;
        shape = { lists: ['comments', 'events'] };
        break;
      case 'github_checks':
        answer = await answerOf(github.checks.$get({ param: this.scopeParam, query: { prs: args.prs!.join(',') } }));
        schema = githubChecksDataSchema;
        notes.push(NOTES.checksAbsent);
        break;
      case 'github_search':
        answer = await answerOf(
          github.search.$get({
            param: this.scopeParam,
            query: { kind: args.kind!, q: args.query!, ...(args.limit ? { limit: args.limit } : {}) },
          }),
        );
        schema = githubSearchDataSchema;
        shape = { lists: ['items'] };
        break;
      case 'github_ref_status':
        answer = await answerOf(
          github['ref-status'].$get({
            param: this.scopeParam,
            query: q({ prs: args.prs?.join(','), issues: args.issues?.join(',') }),
          }),
        );
        schema = githubRefStatusDataSchema;
        break;
      case 'pr_merge_state':
        answer = await answerOf(
          github.prs[':number']['merge-state'].$get({ param: { ...this.scopeParam, number: String(args.number) }, query: q({ refresh }) }),
        );
        schema = githubPrMergeStateResponseSchema;
        notes.push(NOTES.checks);
        break;
      case 'pr_changes':
        answer = await answerOf(
          github.prs[':number'].changes.$get({ param: { ...this.scopeParam, number: String(args.number) }, query: q({ refresh }) }),
        );
        schema = githubPrChangesDataSchema;
        shape = { lists: ['files'] };
        break;
      default:
        return { ok: false, result: errorResult(`unknown read: ${String(args.read)}`) };
    }
    if (answer.status !== 200) return this.refused(args, answer);
    // The union passes through as the route sent it: `{available: false, reason}` stays that, and
    // `truncated` / `patchUnavailableReason` stay on the payload (N-06, F-10).
    const payload = schema.safeParse(jsonOf(answer));
    if (!payload.success) return { ok: false, result: errorResult('the service answered an unexpected GitHub shape') };
    const data = payload.data;
    if (data.available === false) shape = { whole: true };

    let forgeRevision: Envelope['forgeRevision'];
    let revision: Revision | null | undefined;
    if ((args.read === 'pr_merge_state' || args.read === 'pr_changes') && args.runId !== undefined) {
      const opened = await this.openRun(args.runId);
      if (!opened.ok) return opened;
      const runHead = opened.view.dir ? await commitSha(gitIn(opened.view.dir), 'HEAD') : null;
      const prHead = prHeadOf(data);
      forgeRevision = {
        prHeadSha: prHead,
        runHeadSha: runHead,
        match: prHead && runHead ? (prHead === runHead ? 'same' : 'different') : 'unknown',
      };
      revision = runHead ? { headSha: runHead } : null;
    }
    return {
      ok: true,
      evidence: {
        base: {
          read: args.read,
          ...(args.runId ? { runId: args.runId } : {}),
          ...(revision !== undefined ? { revision } : {}),
          ...(revision !== undefined ? this.freshness(args, revision?.headSha ?? null) : {}),
          ...(forgeRevision ? { forgeRevision } : {}),
          ...(notes.length ? { notes } : {}),
        },
        data,
        shape,
      },
    };
  }
}

function prHeadOf(data: Record<string, unknown>): string | null {
  const direct = typeof data.headSha === 'string' ? data.headSha : null;
  const merge = data.mergeState as { headSha?: unknown } | undefined;
  const nested = merge && typeof merge.headSha === 'string' ? merge.headSha : null;
  return direct ?? nested;
}

function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) if (value[key] !== undefined) out[key] = value[key];
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
