import {
  apiRunSchema,
  changesPayloadSchema,
  createPrResponseSchema,
  gitCommitResponseSchema,
  gitPushResponseSchema,
  githubMergeMethodSchema,
  githubMergeResponseSchema,
  githubPrMergeStateResponseSchema,
  repoBranchResponseSchema,
  repoResponseSchema,
  runIdParamSchema,
  type ApiRun,
  type GithubPrMergeState,
} from '@qodeca/xezar-contract';
import { hc } from 'hono/client';
import { z } from 'zod';
import { collectSecretValues, redactDeep } from '../../core/secret-redaction.ts';
import { resolveForge } from '../../server/forge/index.ts';
import { getRepoInfo } from '../../server/git.ts';
import type { AppType } from '../../server/app-type.ts';
import { ownRun, ownershipScope } from '../resource-ownership.ts';
import type { ServiceDispatch } from '../service-adapter.ts';
import { defineTool, errorResult, textResult, type McpToolContext, type McpToolResult } from '../tool.ts';

/**
 * `handoff_git` (#96) — how the leader hands work onward: commit, push, open the draft PR,
 * inspect merge readiness, invoke the EXISTING merge, and switch or create the repository's own
 * branches.
 *
 * F-11 and D-07: these are the cockpit's own project operations, invoked autonomously — no
 * confirmation parameter, no second click — and nothing here is a new release engine. Every
 * effect is one of the cockpit's routes, dispatched in-process under `/api/v1/p/<bound project>/…`
 * (the same entry #89's adapter takes), so the git commands, the draft-PR flow, the head-sha
 * re-validation and the records they write are the cockpit's by construction (N-02, A-08).
 *
 * The availability rules the cockpit applies BEFORE it offers a button (`gitActionPolicy` in
 * `packages/web/src/lib/git-actions.ts`) are applied here too, with the same sentences: commit
 * needs a worktree, is refused while the agent is working and with no changed files; push needs a
 * worktree, the project's remote (from `/repo`, never the boot project's `/health`) and a branch;
 * the draft PR needs a worktree and branch, an available forge and a run that is not active. When
 * the SERVICE refuses, its own text reaches the leader unchanged (a clean tree, a failing hook, a
 * missing identity, a dirty-tree checkout conflict), and a refused draft PR carries the service's
 * `manual` fallback command.
 *
 * F-22 — THE LINE THIS TOOL MUST NOT CROSS. The cockpit's merge box also sends `overrideRules`,
 * because a repository may let an administrator merge past its forge rules. The leader does NOT
 * get it. From the merge state the forge reports, a forge rule cannot be told apart from a quality
 * requirement: a required check that has not reported yet, one required by a ruleset rather than
 * classic protection, or one that turns red between two reads all surface as a generic `unknown`
 * or a "not required" check, and an admin override would merge past each of them. So the leader
 * merges ONLY what the forge itself calls ready (`canMerge`), and the service's own preflight
 * re-reads the forge at merge time and requires the same, which also closes the gap between the
 * tool's read and the merge. On top of that, a required check that is failing, pending or
 * unreadable and a missing or changes-requested review are refused as QUALITY blockers before
 * anything is dispatched. There is no parameter, action or phrasing that declares an exception,
 * and every refusal is reported as a blocker with the next legitimate action: repair the cause, or
 * report the blocker (A-22). The input schema is strict, so an extra key — `overrideRules`
 * included — is an argument error, not an ignored field.
 *
 * Main-checkout branch operations respect the repository-root lease (M-10): a task running in
 * the main checkout holds that lease for its whole life, and a branch switch under it would move
 * the tree the agent is writing into (#438). While one runs, the switch is refused.
 */

// ---- the service entry ---------------------------------------------------------------------

/**
 * `McpToolContext` does not carry the service entry yet: widening it is the wiring that follows
 * #89, outside this tool's files. Until the service hands it over, the tool answers that it is not
 * connected — the same optional field the other Phase 3 tools read, so one wiring serves them all.
 */
type HandoffContext = McpToolContext & { readonly service?: ServiceDispatch };

const IN_PROCESS_BASE = 'http://127.0.0.1';

/** The typed client over the service's own route table, exactly as #89's adapter builds it. */
const buildClient = (service: ServiceDispatch) =>
  hc<AppType>(IN_PROCESS_BASE, {
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('host', '127.0.0.1');
      headers.delete('origin');
      const url = input instanceof Request ? input.url : String(input);
      return service.request(url, { ...init, headers });
    },
  });

type ScopedApi = ReturnType<typeof buildClient>['api']['v1']['p'][':projectId'];

/** One service answer: the status and the parsed JSON body (undefined when there was none). */
interface Answer {
  status: number;
  body: unknown;
}

const settle = async (pending: Promise<Response>): Promise<Answer> => {
  const res = await pending;
  return { status: res.status, body: await res.json().catch(() => undefined) };
};

/** The service's own refusal sentence, verbatim. */
function serviceError(answer: Answer): string {
  const body = answer.body as { error?: unknown } | undefined;
  return typeof body?.error === 'string' ? body.error : `service answered ${answer.status}`;
}

// ---- the input -----------------------------------------------------------------------------

export const HANDOFF_ACTIONS = ['repo', 'commit', 'push', 'create_pr', 'merge_state', 'merge', 'branch'] as const;

/**
 * ONE strict object: the registry takes one entry per tool, and a strict schema is what turns an
 * invented key (`qualityException`, `approvedBy`, `force`…) into an argument error the leader sees,
 * instead of a field silently ignored. Which fields an action needs is checked in `call`.
 */
const inputSchema = z
  .object({
    action: z.enum(HANDOFF_ACTIONS).describe(
      'repo: read the main checkout (branch, branches, base, whether a remote exists, uncommitted count). ' +
        'commit / push / create_pr: act on one task (taskId). ' +
        'merge_state: read one pull request (number) fresh, with its quality blockers. ' +
        'merge: invoke the existing merge (number, expectedHeadSha). ' +
        'branch: switch to, or create and switch to, a branch of the main checkout (name, from).',
    ),
    taskId: z.string().min(1).max(128).optional().describe('The task to commit, push or publish.'),
    message: z.string().trim().min(1).max(5_000).optional().describe('commit: the commit message.'),
    number: z.number().int().positive().optional().describe('merge_state / merge: the pull request number.'),
    expectedHeadSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional()
      .describe('merge: the headSha of the state you reviewed. A moved head is refused, never merged.'),
    method: githubMergeMethodSchema
      .optional()
      .describe("merge: one of the state's methods; defaults to its defaultMethod."),
    name: z.string().trim().min(1).max(200).optional().describe('branch: the branch to switch to or create.'),
    from: z.string().trim().min(1).max(200).optional().describe('branch: start point when creating.'),
  })
  .strict();

type Input = z.output<typeof inputSchema>;

const REQUIRED: Record<Input['action'], ReadonlyArray<keyof Input>> = {
  repo: [],
  commit: ['taskId', 'message'],
  push: ['taskId'],
  create_pr: ['taskId'],
  merge_state: ['number'],
  merge: ['number', 'expectedHeadSha'],
  branch: ['name'],
};

const ALLOWED: Record<Input['action'], ReadonlyArray<keyof Input>> = {
  repo: ['action'],
  commit: ['action', 'taskId', 'message'],
  push: ['action', 'taskId'],
  create_pr: ['action', 'taskId'],
  merge_state: ['action', 'number'],
  merge: ['action', 'number', 'expectedHeadSha', 'method'],
  branch: ['action', 'name', 'from'],
};

function argumentProblem(args: Input): string | null {
  const missing = REQUIRED[args.action].filter((key) => args[key] === undefined);
  if (missing.length > 0) return `${args.action} needs ${missing.join(', ')}`;
  const extra = (Object.keys(args) as Array<keyof Input>).filter(
    (key) => args[key] !== undefined && !ALLOWED[args.action].includes(key),
  );
  if (extra.length > 0) return `${args.action} does not take ${extra.join(', ')}`;
  if (args.taskId !== undefined) {
    const id = args.taskId;
    if (id === '.' || id === '..' || !runIdParamSchema.safeParse({ id }).success) return 'taskId is not a task id';
  }
  return null;
}

// ---- results -------------------------------------------------------------------------------

/** Every answer leaves through the transcript's own secret scrub (F-15). The text is authoritative
 *  (D-05 § 6.8): compact JSON, no second copy in `structuredContent`. */
const answer = (payload: Record<string, unknown>): McpToolResult =>
  textResult(JSON.stringify(redactDeep(payload, collectSecretValues())));

/** A precondition the cockpit's policy would already have refused, in the cockpit's own words. */
const policyRefusal = (action: Input['action'], error: string, extra: Record<string, unknown> = {}): McpToolResult =>
  answer({ action, status: 'failed', refusedBy: 'policy', error, ...extra });

/** The service refused: its status and its own text, unchanged. */
const serviceRefusal = (action: Input['action'], res: Answer, extra: Record<string, unknown> = {}): McpToolResult =>
  answer({ action, status: 'failed', refusedBy: 'service', httpStatus: res.status, error: serviceError(res), ...extra });

const NO_TASK = 'No such task in this project.';
const NO_WORKTREE_REASON = 'no worktree — this task ran directly in the repo working tree';

/** "Active" as the engine means it — `review` is parked, not active (git-actions.ts `isActive`). */
const isActive = (status: ApiRun['status']): boolean => status === 'running' || status === 'queued' || status === 'waiting';

/** The next legitimate action after a quality blocker. It offers no waiver, to anyone (A-22). */
export const QUALITY_BLOCKER_NEXT_ACTION =
  'This is a blocker. Required quality checks and reviews cannot be bypassed from MCP. Repair the cause on the ' +
  'branch and read merge_state again, or report this blocker.';

const STALE_HEAD_NEXT_ACTION =
  'The pull request head moved after the state you reviewed. Read merge_state again and review the new commits before merging.';

// ---- F-22: what counts as a quality blocker ------------------------------------------------

/**
 * Merge-state blocker codes that mean "quality is not proven" — never "the forge's rules". The
 * forge reports only its FIRST blocker, and its `checks-failing` / `pending` codes do not say
 * whether the check is required, so checks are judged one by one below instead.
 */
const QUALITY_BLOCKER_CODES: ReadonlySet<string> = new Set(['reviews', 'rules-unknown']);

/**
 * Every reason this pull request's quality is not proven, from the fresh merge state. A check the
 * forge could not classify (`required: null`) counts as required: unknown evidence is never a
 * pass. An empty list is the only answer that lets a merge be dispatched at all.
 */
export function qualityBlockers(state: GithubPrMergeState): Array<{ code: string; message: string }> {
  const out: Array<{ code: string; message: string }> = [];
  for (const check of state.checks) {
    if (check.required !== false && check.state !== 'passing') {
      out.push({
        code: `check-${check.state}`,
        message: `Required check "${check.name}" is ${check.state}${check.required === null ? ' (requiredness unknown, so it counts as required)' : ''}.`,
      });
    }
  }
  if (state.reviewDecision === 'changes-requested') out.push({ code: 'review', message: 'Changes were requested.' });
  if (state.reviewDecision === 'review-required') out.push({ code: 'review', message: 'A required review is missing.' });
  for (const blocker of state.blockers) {
    if (QUALITY_BLOCKER_CODES.has(blocker.code) && !out.some((b) => b.message === blocker.message)) out.push(blocker);
  }
  return out;
}

// ---- the actions ---------------------------------------------------------------------------

class Handoff {
  private readonly api: ScopedApi;
  private readonly projectId: string;

  constructor(
    service: ServiceDispatch,
    private readonly project: McpToolContext['project'],
  ) {
    this.api = buildClient(service).api.v1.p[':projectId'];
    this.projectId = project.id;
  }

  private get scope() {
    return { projectId: this.projectId };
  }

  /** One task, read from the project's own route AND proved the project's by #88's `ownRun`. */
  private async task(taskId: string): Promise<ApiRun | null> {
    const res = await settle(this.api.runs[':id'].$get({ param: { ...this.scope, id: taskId } }));
    if (res.status !== 200) return null;
    const run = apiRunSchema.parse(res.body);
    const scope = ownershipScope({
      root: this.project.root,
      store: { getRun: (id) => (id === run.id ? run : undefined), listRuns: () => [run] },
      automationStore: { get: () => undefined, latestReceipts: () => new Map() },
    });
    return ownRun(scope, taskId).ok ? run : null;
  }

  async repo(): Promise<McpToolResult> {
    const res = await settle(this.api.repo.$get({ param: this.scope }));
    if (res.status !== 200) return serviceRefusal('repo', res);
    const repo = repoResponseSchema.parse(res.body);
    if (!repo.info) return answer({ action: 'repo', status: 'done', git: false });
    // No log (it names commit authors) and no remote URL (it can carry credentials): whether a
    // remote exists is what push depends on.
    return answer({
      action: 'repo',
      status: 'done',
      git: true,
      branch: repo.info.branch,
      branches: repo.branches,
      baseBranch: repo.baseBranch,
      hasRemote: repo.info.remote !== undefined,
      uncommittedFiles: repo.status.length,
    });
  }

  async commit(taskId: string, message: string): Promise<McpToolResult> {
    const run = await this.task(taskId);
    if (!run) return answer({ action: 'commit', status: 'failed', refusedBy: 'policy', error: NO_TASK });
    const task = { id: run.id };
    if (!run.worktreePath) return policyRefusal('commit', `Commit unavailable — ${NO_WORKTREE_REASON}`, { task });
    if (run.status === 'running') {
      return policyRefusal('commit', 'Commit unavailable — the agent is still working in this worktree', { task });
    }
    // The cockpit counts changed files from `/changes`; its 409 means the worktree is gone.
    const changes = await settle(this.api.runs[':id'].changes.$get({ param: { ...this.scope, id: run.id } }));
    if (changes.status === 409) return policyRefusal('commit', `Commit unavailable — ${NO_WORKTREE_REASON}`, { task });
    if (changes.status !== 200) return serviceRefusal('commit', changes, { task });
    if (changesPayloadSchema.parse(changes.body).stat.files === 0) {
      return policyRefusal('commit', 'Commit unavailable — no changes to commit', { task });
    }
    const res = await settle(
      this.api.runs[':id'].git.commit.$post({ param: { ...this.scope, id: run.id }, json: { message } }),
    );
    if (res.status !== 200) return serviceRefusal('commit', res, { task });
    const done = gitCommitResponseSchema.parse(res.body);
    return answer({ action: 'commit', status: 'done', task: { id: run.id, revision: done.sha }, sha: done.sha });
  }

  async push(taskId: string): Promise<McpToolResult> {
    const run = await this.task(taskId);
    if (!run) return answer({ action: 'push', status: 'failed', refusedBy: 'policy', error: NO_TASK });
    const task = { id: run.id };
    if (!run.worktreePath) return policyRefusal('push', `Push unavailable — ${NO_WORKTREE_REASON}`, { task });
    // The remote is the BOUND project's (`/repo`), never `/health`'s boot project (#791).
    const repo = await settle(this.api.repo.$get({ param: this.scope }));
    if (repo.status !== 200) return serviceRefusal('push', repo, { task });
    if (repoResponseSchema.parse(repo.body).info?.remote === undefined) {
      return policyRefusal('push', 'Push unavailable — no remote configured', { task });
    }
    if (!run.branch) return policyRefusal('push', 'Push unavailable — the run has no branch to push', { task });
    if (run.status === 'running') {
      return policyRefusal('push', 'Push unavailable — the agent is still working in this worktree', { task });
    }
    const res = await settle(this.api.runs[':id'].git.push.$post({ param: { ...this.scope, id: run.id } }));
    if (res.status !== 200) return serviceRefusal('push', res, { task });
    const done = gitPushResponseSchema.parse(res.body);
    return answer({
      action: 'push',
      status: 'done',
      task,
      branch: done.branch,
      remote: done.remote,
      upstreamSet: done.upstreamSet,
    });
  }

  async createPr(taskId: string): Promise<McpToolResult> {
    const run = await this.task(taskId);
    if (!run) return answer({ action: 'create_pr', status: 'failed', refusedBy: 'policy', error: NO_TASK });
    const task = { id: run.id };
    if (!run.worktreePath || !run.branch) {
      return policyRefusal('create_pr', `Create PR unavailable — ${NO_WORKTREE_REASON}`, { task });
    }
    // The bound project's forge — the same resolution and probe `/health` makes for the boot one.
    const forge = resolveForge(await getRepoInfo(this.project.root));
    if (!forge) {
      return policyRefusal('create_pr', 'Create PR unavailable — no supported forge remote (GitHub) detected', { task });
    }
    const availability = await forge.detect();
    if (!availability.available) {
      return policyRefusal(
        'create_pr',
        `Create PR unavailable — ${availability.reason ?? 'the forge is unreachable'}`,
        { task },
      );
    }
    if (isActive(run.status)) {
      return policyRefusal('create_pr', 'Create PR unavailable — the run is still active; wait for the review gate', {
        task,
      });
    }
    const res = await settle(this.api.runs[':id'].pr.$post({ param: { ...this.scope, id: run.id } }));
    if (res.status !== 201) {
      const manual = (res.body as { manual?: unknown } | undefined)?.manual;
      return serviceRefusal('create_pr', res, { task, ...(typeof manual === 'string' ? { manual } : {}) });
    }
    const done = createPrResponseSchema.parse(res.body);
    return answer({ action: 'create_pr', status: 'done', task, url: done.url, dryRun: done.dryRun });
  }

  /** The fresh merge state — the same read the merge box's refresh makes. */
  private async mergeState(number: number, action: Input['action']): Promise<
    { ok: true; state: GithubPrMergeState } | { ok: false; result: McpToolResult }
  > {
    const res = await settle(
      this.api.github.prs[':number']['merge-state'].$get({
        param: { ...this.scope, number: String(number) },
        query: { refresh: '1' },
      }),
    );
    if (res.status !== 200) return { ok: false, result: serviceRefusal(action, res) };
    const parsed = githubPrMergeStateResponseSchema.parse(res.body);
    if (!parsed.available) {
      return {
        ok: false,
        result: answer({ action, status: 'failed', refusedBy: 'service', error: parsed.reason }),
      };
    }
    return { ok: true, state: parsed.mergeState };
  }

  async readMergeState(number: number): Promise<McpToolResult> {
    const read = await this.mergeState(number, 'merge_state');
    if (!read.ok) return read.result;
    const blockers = qualityBlockers(read.state);
    return answer({ action: 'merge_state', status: 'done', mergeState: read.state, qualityBlockers: blockers });
  }

  async merge(args: { number: number; expectedHeadSha: string; method?: Input['method'] }) {
    const read = await this.mergeState(args.number, 'merge');
    if (!read.ok) return read.result;
    const state = read.state;
    // F-22: the quality verdict comes first, and nothing any argument says can change it.
    const blockers = qualityBlockers(state);
    if (blockers.length > 0) {
      return answer({
        action: 'merge',
        status: 'failed',
        refusedBy: 'quality',
        blocker: true,
        number: args.number,
        blockers,
        nextAction: QUALITY_BLOCKER_NEXT_ACTION,
      });
    }
    // Anything the forge does not call ready is a blocker for the leader: an unmet requirement the
    // forge cannot name may be a quality one (see the header), and there is no override to reach for.
    if (!state.canMerge) {
      return answer({
        action: 'merge',
        status: 'failed',
        refusedBy: 'forge',
        blocker: true,
        number: args.number,
        eligibility: state.eligibility,
        blockers: state.blockers,
        nextAction: QUALITY_BLOCKER_NEXT_ACTION,
      });
    }
    const method = args.method ?? state.defaultMethod ?? state.methods[0];
    if (!method) {
      return answer({
        action: 'merge',
        status: 'failed',
        refusedBy: 'policy',
        error: 'No merge method is available.',
      });
    }
    const res = await settle(
      this.api.github.prs[':number'].merge.$post({
        param: { ...this.scope, number: String(args.number) },
        json: {
          method,
          // The head the LEADER reviewed — never the fresh one read above. The service re-validates
          // it against the forge, so a stale review cannot merge. No `overrideRules`, ever: without
          // it the service's preflight demands a fresh `canMerge` at merge time.
          expectedHeadSha: args.expectedHeadSha,
        },
      }),
    );
    if (res.status === 200) {
      const done = githubMergeResponseSchema.parse(res.body);
      return answer({ action: 'merge', status: 'done', ...done });
    }
    const body = (res.body ?? {}) as { code?: unknown; current?: { blockers?: unknown } };
    if (body.code === 'stale-head') {
      return answer({
        action: 'merge',
        status: 'conflict',
        code: 'stale-head',
        error: serviceError(res),
        nextAction: STALE_HEAD_NEXT_ACTION,
      });
    }
    // Refused on the forge's own eligibility: still a blocker, still the service's own words.
    const eligibility = ['blocked', 'pending', 'unauthorized', 'terminal', 'unknown'];
    if (typeof body.code === 'string' && eligibility.includes(body.code)) {
      return answer({
        action: 'merge',
        status: 'failed',
        refusedBy: 'service',
        blocker: true,
        httpStatus: res.status,
        code: body.code,
        error: serviceError(res),
        nextAction: QUALITY_BLOCKER_NEXT_ACTION,
      });
    }
    return serviceRefusal('merge', res, typeof body.code === 'string' ? { code: body.code } : {});
  }

  async branch(name: string, from: string | undefined): Promise<McpToolResult> {
    // M-10: a task running in the main checkout holds the repository-root lease.
    const runs = await settle(this.api.runs.$get({ param: this.scope }));
    if (runs.status !== 200) return serviceRefusal('branch', runs);
    const holder = z
      .array(apiRunSchema)
      .parse(runs.body)
      .find((run) => !run.worktreePath && (run.status === 'running' || run.status === 'waiting'));
    if (holder) {
      return policyRefusal(
        'branch',
        'Branch switch unavailable — a task is running in the main checkout and holds the repository-root lease; wait for it to finish',
        { task: { id: holder.id } },
      );
    }
    const res = await settle(
      this.api.repo.branch.$post({ param: this.scope, json: { name, ...(from !== undefined ? { from } : {}) } }),
    );
    if (res.status !== 200) return serviceRefusal('branch', res);
    const done = repoBranchResponseSchema.parse(res.body);
    return answer({ action: 'branch', status: 'done', branch: done.branch, created: done.created });
  }
}

export const handoffGitTool = defineTool({
  name: 'handoff_git',
  title: 'Hand work onward: commit, push, draft PR, merge, branches',
  description:
    "Hand a task's work onward through the cockpit's own operations: commit a task's worktree, push its branch, " +
    'open its draft pull request, read a pull request\'s merge readiness, invoke the existing merge, and switch or ' +
    'create branches of the main checkout. Every action runs at once, with the same checks the cockpit applies; ' +
    "a refusal carries the service's own reason unchanged. A merge needs the headSha you reviewed and is refused " +
    'if the head moved. Failing, pending or unreadable required checks and missing reviews are blockers that no ' +
    'argument bypasses: repair the cause or report the blocker.',
  inputSchema,
  annotations: { destructiveHint: true, openWorldHint: true },
  async call(args, ctx) {
    const service = (ctx as HandoffContext).service;
    if (!service) {
      return errorResult(
        'handoff_git is not connected in this xezar yet: the running service did not hand MCP its git operations. Use the cockpit.',
      );
    }
    const problem = argumentProblem(args);
    if (problem) return errorResult(`Invalid arguments for handoff_git: ${problem}`);
    const handoff = new Handoff(service, ctx.project);
    switch (args.action) {
      case 'repo':
        return handoff.repo();
      case 'commit':
        return handoff.commit(args.taskId!, args.message!);
      case 'push':
        return handoff.push(args.taskId!);
      case 'create_pr':
        return handoff.createPr(args.taskId!);
      case 'merge_state':
        return handoff.readMergeState(args.number!);
      case 'merge':
        return handoff.merge({
          number: args.number!,
          expectedHeadSha: args.expectedHeadSha!,
          method: args.method,
        });
      case 'branch':
        return handoff.branch(args.name!, args.from);
    }
  },
});
