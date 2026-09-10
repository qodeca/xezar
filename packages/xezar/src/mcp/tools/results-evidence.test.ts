import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../../runs/store.ts';
import { ProjectContexts, type ProjectContextSource } from '../../server/project-context.ts';
import { connectedProviderAuth } from '../../server/provider-auth.testkit.ts';
import { createApp } from '../../server/server.ts';
import type { RunManager } from '../../workflows/run.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import type { McpToolContext } from '../tool.ts';
import {
  RESULT_BUDGET_BYTES,
  createResultsEvidenceTool,
  resultsEvidenceInputSchema,
  resultsEvidenceTool,
  type ResultsEvidenceInput,
} from './results-evidence.ts';

/**
 * `read_results_evidence` (#95) against the REAL service: `createApp`, real `ProjectContexts` and
 * stores, and real git repositories and worktrees in tmp dirs. The cockpit's answer to the same
 * route is the oracle for every payload; what these tests pin on top is the REVISION each answer
 * carries, and that stale or missing evidence reads as stale or missing — never as current, never
 * as an empty success (docs/features/mcp-server/mcp-result-evidence-fields.md).
 */

const COCKPIT_HOST = '127.0.0.1:4321';
const DRY_RUN_PR_HEAD = '0123456789abcdef0123456789abcdef01234567';

interface Workspace {
  app: ReturnType<typeof createApp>;
  contexts: ProjectContexts;
  roots: { a: string; b: string };
}

interface Envelope {
  read: string;
  runId?: string;
  evidence: 'available' | 'unavailable' | 'stale';
  status?: number;
  reason?: string;
  revision?: {
    headSha: string;
    uncommitted?: boolean;
    baseSha?: string;
    anchor?: string;
    taskDiffBaseSha?: string;
    repointedHead?: { headBranch: string; taskBranch: string };
    pathClean?: boolean;
    commitSha?: string;
    committedAt?: string;
    reachableFromHead?: boolean;
  } | null;
  freshness?: 'current' | 'stale';
  forgeRevision?: { prHeadSha: string | null; runHeadSha: string | null; match: string };
  notes?: string[];
  page?: {
    from: number;
    to: number;
    total: number;
    unit: string;
    chunk?: { index: number; count: number };
    digest: string;
    next?: string;
  };
  data?: Record<string, unknown>;
  fragment?: string;
}

const tempDirs: string[] = [];
const makeDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};

function g(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** `g` with the clock moved: reflog entries take their instant from the committer ident. */
function gAt(dir: string, iso: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });
}

const head = (dir: string): string => g(dir, 'rev-parse', 'HEAD').trim();

/** A git repository on `main` with one commit, `.local/` ignored, and a GitHub-shaped remote. */
function makeRepo(prefix: string, remote = 'https://github.com/example-org/example-repo.git'): string {
  const root = makeDir(prefix);
  g(root, 'init', '-b', 'main');
  g(root, 'config', 'user.email', 'test@xezar.local');
  g(root, 'config', 'user.name', 'xezar-test');
  g(root, 'config', 'commit.gpgsign', 'false');
  g(root, 'remote', 'add', 'origin', remote);
  mkdirSync(join(root, '.xezar'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n');
  writeFileSync(join(root, '.gitignore'), '.local/\n');
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  gAt(root, '2026-01-01T00:00:00Z', 'add', '-A');
  gAt(root, '2026-01-01T00:00:00Z', 'commit', '-m', 'base');
  return root;
}

let workspace: Workspace | undefined;
const saved = {
  dryRun: process.env.XEZ_DRY_RUN,
  home: process.env.XEZ_HOME,
  path: process.env.PATH,
  githubToken: process.env.GITHUB_TOKEN,
  ghToken: process.env.GH_TOKEN,
};

function setup(remoteA?: string): Workspace {
  process.env.XEZ_HOME = makeDir('xez-evidence-home-');
  const boot = makeDir('xez-evidence-boot-');
  const roots = { a: makeRepo('xez-evidence-a-', remoteA), b: makeRepo('xez-evidence-b-') };
  const projects: ProjectContextSource[] = [
    { id: 'proj-a', root: roots.a, status: 'ok' },
    { id: 'proj-b', root: roots.b, status: 'ok' },
  ];
  const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2 }, load: async () => ({ maxParallel: 2, memoryLimitMb: null }) });
  const contexts = new ProjectContexts({ listProjects: async () => projects, semaphore });
  const app = createApp({
    repoRoot: boot,
    store: RunStore.open(join(boot, '.local/xezar'), { keepLive: true }),
    manager: { isActive: () => false } as unknown as RunManager,
    version: '0.0.0-test',
    bootProjectId: 'boot',
    contexts,
    semaphore,
    providerAuth: connectedProviderAuth(),
  });
  workspace = { app, contexts, roots };
  return workspace;
}

/** The context the service hands a tool, carrying the in-process entry this tool reads from. */
const contextFor = (ws: Workspace, project: 'a' | 'b' = 'a'): McpToolContext & { service: Workspace['app'] } => ({
  project: { id: `proj-${project}`, name: `proj-${project}`, root: ws.roots[project] },
  xezarVersion: '0.0.0-test',
  service: ws.app,
});

/** Call the tool the way the service does (arguments validated first), and hold EVERY result to B-01. */
async function call(ws: Workspace, args: ResultsEvidenceInput, project: 'a' | 'b' = 'a') {
  const parsed = resultsEvidenceInputSchema.parse(args);
  const result = await resultsEvidenceTool.call(parsed, contextFor(ws, project));
  const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
  expect(Buffer.byteLength(JSON.stringify(result.content), 'utf8')).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
  expect(result.structuredContent).toBeUndefined();
  return { isError: result.isError === true, text, envelope: (result.isError ? undefined : JSON.parse(text)) as Envelope };
}

async function evidence(ws: Workspace, args: ResultsEvidenceInput, project: 'a' | 'b' = 'a'): Promise<Envelope> {
  const result = await call(ws, args, project);
  if (result.isError) throw new Error(`tool error: ${result.text}`);
  return result.envelope;
}

/** Every page of one read, following `page.next`. */
async function allPages(ws: Workspace, args: ResultsEvidenceInput): Promise<Envelope[]> {
  const pages: Envelope[] = [];
  let cursor: string | undefined;
  do {
    const page = await evidence(ws, { ...args, ...(cursor ? { cursor } : {}) });
    pages.push(page);
    cursor = page.page?.next;
  } while (cursor && pages.length < 200);
  return pages;
}

/** The data of every page, with fragment pages joined back into the page they came from. */
function payloads(pages: Envelope[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let buffer = '';
  for (const page of pages) {
    const chunk = page.page?.chunk;
    if (!chunk) {
      out.push(page.data ?? {});
      continue;
    }
    buffer += page.fragment ?? '';
    if (chunk.index === chunk.count - 1) {
      out.push(JSON.parse(buffer) as Record<string, unknown>);
      buffer = '';
    }
  }
  return out;
}

const itemsOf = (pages: Envelope[], key: string): unknown[] => payloads(pages).flatMap((data) => (data[key] as unknown[]) ?? []);

/** The cockpit's own request to the same scoped route. */
async function cockpit(ws: Workspace, path: string): Promise<{ status: number; json: () => unknown; text: string }> {
  const res = await ws.app.request(`/api/v1/p/proj-a${path}`, {
    headers: { host: COCKPIT_HOST, origin: `http://${COCKPIT_HOST}` },
  });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) as unknown };
}

const storeOf = async (ws: Workspace, project = 'proj-a') => (await ws.contexts.context(project)).store;

interface Task {
  id: string;
  worktree: string;
  branch: string;
}

/**
 * A FINISHED task with its own worktree at the one path xezar creates for a run, on its own
 * `xez/<id8>` branch off `main`, with one committed file. `startedAt` defaults to "now".
 */
async function finishedTask(ws: Workspace, opts: { startedAt?: string; project?: 'a' | 'b' } = {}): Promise<Task> {
  const project = opts.project ?? 'a';
  const root = ws.roots[project];
  const store = await storeOf(ws, `proj-${project}`);
  const run = store.createRun({
    title: 'fixture task',
    workflow: 'quick-task',
    task: 'change the fixture',
    steps: [{ id: 'gate', name: 'Gate', kind: 'check' }],
  });
  const worktree = join(root, '.local/xezar/worktrees', run.id);
  const branch = `xez/${run.id.slice(0, 8)}`;
  gAt(root, '2026-01-01T00:00:00Z', 'worktree', 'add', '-b', branch, worktree, 'main');
  store.updateRun(run.id, {
    status: 'done',
    startedAt: opts.startedAt ?? new Date(Date.now() - 60_000).toISOString(),
    finishedAt: new Date().toISOString(),
    worktreePath: worktree,
    branch,
    baseBranch: 'main',
    diffStat: { adds: 1, dels: 0, files: 1 },
    prNumber: 42,
  });
  store.updateStep(run.id, 'gate', { status: 'done', iterations: 1 });
  return { id: run.id, worktree, branch };
}

function commitFile(dir: string, path: string, content: string | Buffer, message = `add ${path}`): string {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-m', message);
  return head(dir);
}

const withoutCommittedAt = (commits: Array<Record<string, unknown>>) =>
  commits.map(({ committedAt: _at, ...rest }) => rest);

beforeEach(() => {
  process.env.XEZ_DRY_RUN = '1';
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

afterEach(async () => {
  const ws = workspace;
  workspace = undefined;
  if (ws) {
    for (const id of ws.contexts.ids()) await ws.contexts.peek(id)?.manager.dispose();
    ws.contexts.disposeAll();
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ['XEZ_DRY_RUN', saved.dryRun],
    ['XEZ_HOME', saved.home],
    ['PATH', saved.path],
    ['GITHUB_TOKEN', saved.githubToken],
    ['GH_TOKEN', saved.ghToken],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('a completed task, read through MCP and through the cockpit', () => {
  it('matches the cockpit payload, carries the sha it describes, and reads as stale once the branch moves', async () => {
    const ws = setup();
    const task = await finishedTask(ws);
    const headA = commitFile(task.worktree, 'feature.txt', 'the feature\n');
    // Large enough to need several pages, so a cursor exists before the branch moves.
    commitFile(task.worktree, 'docs/big.md', `${'lorem ipsum dolor sit amet\n'.repeat(4_000)}`);
    const headA2 = head(task.worktree);
    writeFileSync(join(ws.roots.a, '.local/xezar/runs', `${task.id}.handoff.md`), '# Handoff\n\n## Progress log\n- did it\n');
    const store = await storeOf(ws);
    store.appendEvent(task.id, { type: 'text', stepId: 'gate', text: 'hello from the agent' });
    store.appendEvent(task.id, { type: 'step-end', stepId: 'gate', status: 'done' });
    store.flush();
    const main = head(ws.roots.a);
    expect(headA).not.toBe(headA2);

    // Summary: the record's facts, and what they do NOT prove.
    const summary = await evidence(ws, { read: 'summary', runId: task.id });
    expect(summary.revision?.headSha).toBe(headA2);
    expect(summary.data).toMatchObject({ id: task.id, status: 'done', branch: task.branch, workingTreeAvailable: true });
    expect(summary.data?.diffStat).toEqual({ adds: 1, dels: 0, files: 1, measuredAtSha: null });
    expect(summary.notes?.join(' ')).toContain('not proof that checks passed');
    const cockpitRun = (await cockpit(ws, `/runs/${task.id}`)).json() as { status: string; steps: Array<{ status: string }> };
    expect(summary.data?.status).toBe(cockpitRun.status);
    expect((summary.data?.steps as Array<{ status: string }>).map((s) => s.status)).toEqual(cockpitRun.steps.map((s) => s.status));
    // The slim projection never carries the prompt or the workflow definition.
    expect(summary.data).not.toHaveProperty('task');
    expect(summary.data).not.toHaveProperty('workflowDef');

    // Changes: the cockpit's structured diff, anchored by the task-diff rule.
    const changes = await allPages(ws, { read: 'changes', runId: task.id });
    const cockpitChanges = (await cockpit(ws, `/runs/${task.id}/changes`)).json() as { files: Array<{ path: string }>; stat: unknown };
    expect(itemsOf(changes, 'files')).toEqual(cockpitChanges.files);
    expect(changes.length).toBeGreaterThan(1);
    expect(payloads(changes)[0]!.stat).toEqual(cockpitChanges.stat);
    expect(changes[0]!.revision).toMatchObject({ headSha: headA2, baseSha: main, anchor: 'task-diff-base', uncommitted: false });

    // Files: one text file, byte-for-byte the cockpit's content.
    const file = await evidence(ws, { read: 'files', runId: task.id, path: 'feature.txt' });
    const cockpitFile = (await cockpit(ws, `/runs/${task.id}/files?path=feature.txt`)).json() as { content: string };
    expect(file.data).toMatchObject({ type: 'file', path: 'feature.txt', state: 'text', content: cockpitFile.content });
    expect(file.revision).toMatchObject({ headSha: headA2, pathClean: true });

    // Commits and one commit, each tied to a revision.
    const commits = await evidence(ws, { read: 'commits', runId: task.id });
    const cockpitCommits = (await cockpit(ws, `/runs/${task.id}/commits`)).json() as { commits: Array<Record<string, unknown>> };
    const mcpCommits = commits.data?.commits as Array<Record<string, unknown>>;
    expect(withoutCommittedAt(mcpCommits)).toEqual(cockpitCommits.commits);
    for (const commit of mcpCommits) expect(commit.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(commits.revision).toMatchObject({ headSha: headA2, baseSha: main, taskDiffBaseSha: main });
    const one = await allPages(ws, { read: 'commit', runId: task.id, sha: headA });
    const cockpitOne = (await cockpit(ws, `/runs/${task.id}/commit/${headA}`)).json() as { files: unknown[]; sha: string };
    expect(itemsOf(one, 'files')).toEqual(cockpitOne.files);
    expect(one[0]!.revision).toMatchObject({ headSha: headA2, commitSha: headA, reachableFromHead: true });

    // Handoff journal and history: the cockpit's text and page.
    const handoff = await evidence(ws, { read: 'handoff', runId: task.id });
    expect(handoff.data?.markdown).toBe((await cockpit(ws, `/runs/${task.id}/handoff`)).text);
    const history = await evidence(ws, { read: 'history', runId: task.id });
    const cockpitHistory = (await cockpit(ws, `/runs/${task.id}/history`)).json() as { events: unknown[]; asOfSeq: number };
    expect(history.data?.events).toEqual(cockpitHistory.events);
    expect(history.data?.asOfSeq).toBe(cockpitHistory.asOfSeq);

    // PR/CI state: the forge's head is compared with the task's head, never assumed equal.
    const merge = await evidence(ws, { read: 'pr_merge_state', number: 42, runId: task.id });
    expect(merge.data).toEqual((await cockpit(ws, '/github/prs/42/merge-state')).json());
    expect(merge.forgeRevision).toEqual({ prHeadSha: DRY_RUN_PR_HEAD, runHeadSha: headA2, match: 'different' });
    const prChanges = await allPages(ws, { read: 'pr_changes', number: 42, runId: task.id });
    const cockpitPr = (await cockpit(ws, '/github/prs/42/changes')).json() as { files: unknown[]; truncated: boolean };
    expect(itemsOf(prChanges, 'files')).toEqual(cockpitPr.files);
    // `truncated` and the per-file unavailability reasons survive (N-06).
    expect(payloads(prChanges)[0]!.truncated).toBe(cockpitPr.truncated);
    expect(JSON.stringify(cockpitPr.files)).toContain('patchUnavailableReason');
    expect(JSON.stringify(itemsOf(prChanges, 'files'))).toContain('patchUnavailableReason');

    // A multi-page read started at headA2 …
    const bigFirst = await evidence(ws, { read: 'files', runId: task.id, path: 'docs/big.md' });
    expect(bigFirst.page?.next).toBeDefined();

    // … then the branch moves.
    const headB = commitFile(task.worktree, 'fixup.txt', 'a human fixup\n');

    const staleChanges = await allPages(ws, { read: 'changes', runId: task.id, expectedHeadSha: headA2 });
    for (const page of staleChanges) {
      expect(page.freshness).toBe('stale');
      expect(page.revision?.headSha).toBe(headB);
    }
    expect((itemsOf(staleChanges, 'files') as Array<{ path: string }>).map((f) => f.path)).toContain('fixup.txt');
    const staleSummary = await evidence(ws, { read: 'summary', runId: task.id, expectedHeadSha: headA2 });
    expect(staleSummary.freshness).toBe('stale');
    // The stored numbers were never re-measured and still say so — not reused as current.
    expect(staleSummary.data?.diffStat).toEqual({ adds: 1, dels: 0, files: 1, measuredAtSha: null });
    expect((await evidence(ws, { read: 'commits', runId: task.id, expectedHeadSha: headA2 })).freshness).toBe('stale');
    expect((await evidence(ws, { read: 'files', runId: task.id, path: 'feature.txt', expectedHeadSha: headA2 })).freshness).toBe('stale');
    expect((await evidence(ws, { read: 'pr_merge_state', number: 42, runId: task.id, expectedHeadSha: headA2 })).freshness).toBe('stale');

    // Continuing the page set that started at headA2 is refused as stale, not spliced.
    const continued = await evidence(ws, { read: 'files', runId: task.id, path: 'docs/big.md', cursor: bigFirst.page!.next! });
    expect(continued.evidence).toBe('stale');
    expect(continued.data).toBeUndefined();
    expect(continued.revision?.headSha).toBe(headB);

    // Echoing the new head reads as current.
    expect((await evidence(ws, { read: 'changes', runId: task.id, expectedHeadSha: headB })).freshness).toBe('current');
  }, 60_000);

  it('anchors a review-style run at resolveTaskDiffBase, never at the checked-out branch history', async () => {
    const ws = setup();
    const before = '2026-01-01T00:00:00Z';
    const task = await finishedTask(ws, { startedAt: '2026-06-01T00:00:00Z' });
    // The agent checked a reviewed branch out into its worktree. That branch already carried
    // other people's work from BEFORE the run started.
    gAt(task.worktree, before, 'checkout', '-b', 'review/pr-42');
    for (let i = 1; i <= 5; i += 1) {
      writeFileSync(join(task.worktree, `theirs-${i}.txt`), `the reviewed PR's file ${i}\n`);
      g(task.worktree, 'add', '-A');
      gAt(task.worktree, before, 'commit', '-m', `reviewed change ${i}`);
    }
    const asFound = head(task.worktree);
    // During the run: one commit of its own, and uncommitted work.
    commitFile(task.worktree, 'mine.txt', 'the run committed this\n');
    writeFileSync(join(task.worktree, 'wip.txt'), 'uncommitted, also the run\n');
    const main = head(ws.roots.a);

    const changes = await evidence(ws, { read: 'changes', runId: task.id });
    const cockpitChanges = (await cockpit(ws, `/runs/${task.id}/changes`)).json() as { files: Array<{ path: string }> };
    expect(changes.data?.files).toEqual(cockpitChanges.files);
    const paths = (changes.data?.files as Array<{ path: string }>).map((f) => f.path).sort();
    expect(paths).toEqual(['mine.txt', 'wip.txt']);
    for (const path of paths) expect(path).not.toMatch(/^theirs-/);
    // The anchor is the reviewed branch AS THE RUN FOUND IT — not the whole branch (main), and
    // not HEAD (which would report the run's committed work as nothing).
    expect(changes.revision).toMatchObject({
      headSha: head(task.worktree),
      baseSha: asFound,
      anchor: 'task-diff-base',
      uncommitted: true,
      repointedHead: { headBranch: 'review/pr-42', taskBranch: task.branch },
    });
    expect(changes.revision?.baseSha).not.toBe(main);
    expect(changes.revision?.baseSha).not.toBe(changes.revision?.headSha);
    expect(changes.notes?.join(' ')).toContain('uncommitted');

    // The commit list keeps the route's own merge-base anchor (C-6) — and says it differs.
    const commits = await evidence(ws, { read: 'commits', runId: task.id });
    expect(commits.revision).toMatchObject({ baseSha: main, taskDiffBaseSha: asFound });
    expect(commits.notes?.join(' ')).toContain("not the anchor 'changes' uses");
  }, 60_000);
});

describe('a tree that moves during the read', () => {
  /** The real app, behind a door that lets a "human" commit while a changes read is in flight. */
  const movingTool = (ws: Workspace, worktree: string, moves: { left: number }) =>
    createResultsEvidenceTool(() => ({
      request: (input: string, init?: RequestInit) => {
        if (input.includes('/changes') && moves.left > 0) {
          moves.left -= 1;
          commitFile(worktree, `moved-${moves.left}.txt`, 'committed mid-read\n');
        }
        return ws.app.request(input, init);
      },
    }));

  it('labels the answer with the head it was read at after one move, and refuses to label a tree that keeps moving', async () => {
    const ws = setup();
    const task = await finishedTask(ws);
    commitFile(task.worktree, 'feature.txt', 'the feature\n');

    const once = await movingTool(ws, task.worktree, { left: 1 }).call(
      resultsEvidenceInputSchema.parse({ read: 'changes', runId: task.id }),
      contextFor(ws),
    );
    const settled = JSON.parse((once.content[0] as { text: string }).text) as Envelope;
    expect(settled.evidence).toBe('available');
    expect(settled.revision?.headSha).toBe(head(task.worktree));
    expect((settled.data?.files as Array<{ path: string }>).map((f) => f.path)).toContain('moved-0.txt');

    const always = await movingTool(ws, task.worktree, { left: 5 }).call(
      resultsEvidenceInputSchema.parse({ read: 'changes', runId: task.id }),
      contextFor(ws),
    );
    const refused = JSON.parse((always.content[0] as { text: string }).text) as Envelope;
    expect(refused.evidence).toBe('unavailable');
    expect(refused.reason).toContain('moved while it was being read');
    expect(refused.revision).toBeUndefined();
    expect(refused.data).toBeUndefined();
  }, 30_000);
});

describe('missing evidence is an answer, never an empty success', () => {
  it('answers the cockpit 409 for a reclaimed worktree on every tree read, and a summary with no revision', async () => {
    const ws = setup();
    const task = await finishedTask(ws);
    const sha = commitFile(task.worktree, 'feature.txt', 'the feature\n');
    g(ws.roots.a, 'worktree', 'remove', '--force', task.worktree);
    const store = await storeOf(ws);
    store.updateRun(task.id, { worktreeReclaimedAt: '2026-09-10T10:00:00.000Z' });
    const cockpitAnswer = await cockpit(ws, `/runs/${task.id}/changes`);
    expect(cockpitAnswer.status).toBe(409);
    const { error } = cockpitAnswer.json() as { error: string };

    for (const args of [
      { read: 'changes', runId: task.id },
      { read: 'files', runId: task.id, path: 'feature.txt' },
      { read: 'commits', runId: task.id },
      { read: 'commit', runId: task.id, sha },
    ] as const) {
      const answer = await evidence(ws, args);
      expect(answer.evidence, args.read).toBe('unavailable');
      expect(answer.status, args.read).toBe(409);
      expect(answer.reason, args.read).toContain(error);
      expect(answer.reason, args.read).toContain('reclaimed');
      expect(answer.data, args.read).toBeUndefined();
    }
    const summary = await evidence(ws, { read: 'summary', runId: task.id });
    expect(summary.revision).toBeNull();
    expect(summary.data).toMatchObject({ workingTreeAvailable: false, worktreeReclaimedAt: '2026-09-10T10:00:00.000Z' });
    expect(summary.notes?.join(' ')).toContain('no working tree');
  }, 30_000);
});

describe('files: distinct states, bounded pages, refused paths', () => {
  it('keeps text, image, too-large, binary, withheld and directory states distinct', async () => {
    const ws = setup();
    const task = await finishedTask(ws);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    writeFileSync(join(task.worktree, 'shot.png'), png);
    writeFileSync(join(task.worktree, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
    writeFileSync(join(task.worktree, 'blob.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
    writeFileSync(join(task.worktree, 'huge.log'), 'x'.repeat(600_000));
    writeFileSync(join(task.worktree, 'notes.txt'), 'plain text\n');
    writeFileSync(join(task.worktree, '.gitignore'), '.env\n');
    writeFileSync(join(task.worktree, '.env'), 'API_TOKEN=do-not-return-me\n');
    g(task.worktree, 'add', '-A');
    g(task.worktree, 'commit', '-m', 'fixtures');

    const state = async (path: string) => (await evidence(ws, { read: 'files', runId: task.id, path })).data?.state;
    expect(await state('notes.txt')).toBe('text');
    expect(await state('shot.png')).toBe('image');
    expect(await state('icon.svg')).toBe('image');
    expect(await state('blob.dat')).toBe('binary');
    expect(await state('huge.log')).toBe('too-large');
    const env = await evidence(ws, { read: 'files', runId: task.id, path: '.env' });
    expect(env.data?.state).toBe('withheld');
    expect(JSON.stringify(env)).not.toContain('do-not-return-me');
    expect(env.notes?.join(' ')).toContain('credentials');
    // Only the text state carries content.
    for (const path of ['shot.png', 'blob.dat', 'huge.log']) {
      expect((await evidence(ws, { read: 'files', runId: task.id, path })).data).not.toHaveProperty('content');
    }

    const listing = await evidence(ws, { read: 'files', runId: task.id });
    expect(listing.data?.type).toBe('dir');
    expect(listing.data?.entries).toEqual(((await cockpit(ws, `/runs/${task.id}/files`)).json() as { entries: unknown }).entries);
  }, 30_000);

  it('delivers a long text file in pages that stay within B-01 and rebuild it exactly', async () => {
    const ws = setup();
    const task = await finishedTask(ws);
    const content = Array.from({ length: 6_000 }, (_, i) => `line ${i} — ünïcødé ✓ "quoted" \\ ${'é'.repeat(i % 7)}`).join('\n');
    commitFile(task.worktree, 'long.md', content);
    const pages = await allPages(ws, { read: 'files', runId: task.id, path: 'long.md' });
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.map((p) => p.data?.content).join('')).toBe(content);
    expect(new Set(pages.map((p) => p.page?.digest)).size).toBe(1);
    expect(pages.at(-1)!.page?.to).toBe(content.length);
  }, 30_000);

  it('splits one oversized item into fragments with an explicit continuation (B-03)', async () => {
    const ws = setup();
    const task = await finishedTask(ws);
    commitFile(task.worktree, 'giant.txt', Array.from({ length: 3_000 }, (_, i) => `row ${i} "${'<>&'.repeat(4)}"`).join('\n'));
    const pages = await allPages(ws, { read: 'changes', runId: task.id });
    const chunks = pages.filter((p) => p.page?.chunk);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((p) => p.page!.chunk!.index)).toEqual(chunks.map((_, i) => i));
    const rebuilt = JSON.parse(chunks.map((p) => p.fragment).join('')) as { files: Array<{ path: string; patch: string }> };
    const cockpitChanges = (await cockpit(ws, `/runs/${task.id}/changes`)).json() as { files: Array<{ path: string }> };
    expect(rebuilt.files).toEqual(cockpitChanges.files);
  }, 30_000);

  it('refuses absolute, "..", .git and symlinked paths before anything is read', async () => {
    const ws = setup();
    const task = await finishedTask(ws);
    const outside = makeDir('xez-evidence-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'outside the worktree\n');
    symlinkSync(join(outside, 'secret.txt'), join(task.worktree, 'link.txt'));
    symlinkSync(outside, join(task.worktree, 'linkdir'));
    for (const path of ['/etc/passwd', '../README.md', 'a/../../x', '.git/config', 'link.txt', 'linkdir/secret.txt']) {
      const result = await call(ws, { read: 'files', runId: task.id, path });
      expect(result.isError, path).toBe(true);
      expect(result.text, path).not.toContain('outside the worktree');
      expect(result.text, path).not.toContain(outside);
    }
    expect((await call(ws, { read: 'files', runId: task.id, path: 'nope.txt' })).text).toContain('not found');
  }, 30_000);
});

describe('GitHub reads degrade, never fail', () => {
  it('answers {available:false, reason} and no error on every GitHub read when gh is absent', async () => {
    delete process.env.XEZ_DRY_RUN;
    // A PATH that still reaches git but no longer reaches gh.
    const bin = makeDir('xez-evidence-bin-');
    const kept = (saved.path ?? '').split(delimiter).filter((dir) => dir && !existsSync(join(dir, 'gh')));
    const gitDir = (saved.path ?? '').split(delimiter).find((dir) => dir && existsSync(join(dir, 'git')));
    if (gitDir && !kept.includes(gitDir)) symlinkSync(join(gitDir, 'git'), join(bin, 'git'));
    process.env.PATH = [bin, ...kept].join(delimiter);
    expect(() => execFileSync('gh', ['--version'], { stdio: 'ignore' })).toThrow();

    const ws = setup();
    const task = await finishedTask(ws);
    const reads: ResultsEvidenceInput[] = [
      { read: 'github' },
      { read: 'github_comments', kind: 'pr', number: 7 },
      { read: 'github_checks', prs: [7, 8] },
      { read: 'github_search', kind: 'issue', query: 'bug' },
      { read: 'github_ref_status', prs: [7], issues: [9] },
      { read: 'pr_merge_state', number: 7, runId: task.id },
      { read: 'pr_changes', number: 7, runId: task.id },
    ];
    for (const args of reads) {
      const result = await call(ws, args);
      expect(result.isError, `${args.read}: ${result.text}`).toBe(false);
      expect(result.envelope.evidence, args.read).toBe('unavailable');
      expect(result.envelope.data?.available, args.read).toBe(false);
      expect(typeof result.envelope.data?.reason, args.read).toBe('string');
      expect(result.envelope.reason, args.read).toBe(result.envelope.data?.reason);
    }
    // No forge head means no comparison: unknown, never "same".
    const merge = (await call(ws, { read: 'pr_merge_state', number: 7, runId: task.id })).envelope;
    expect(merge.forgeRevision).toMatchObject({ prHeadSha: null, match: 'unknown' });
  }, 60_000);
});

describe('the project repository reads', () => {
  it('reads the main checkout by revision and never returns a credential embedded in the remote URL', async () => {
    const ws = setup('https://someone:ghp_supersecrettoken@github.com/example-org/example-repo.git');
    const repo = await evidence(ws, { read: 'repo' });
    expect(JSON.stringify(repo)).not.toContain('ghp_supersecrettoken');
    expect((repo.data?.info as { remote: string }).remote).toBe('https://github.com/example-org/example-repo.git');
    expect(repo.revision?.headSha).toBe(head(ws.roots.a));
    const cockpitRepo = (await cockpit(ws, '/repo')).json() as { log: unknown; branches: unknown };
    expect(repo.data?.log).toEqual(cockpitRepo.log);
    expect(repo.data?.branches).toEqual(cockpitRepo.branches);

    writeFileSync(join(ws.roots.a, 'README.md'), '# fixture, edited\n');
    const changes = await evidence(ws, { read: 'repo_changes' });
    expect(changes.data?.files).toEqual(((await cockpit(ws, '/repo/changes')).json() as { files: unknown }).files);
    expect(changes.revision).toMatchObject({ headSha: head(ws.roots.a), uncommitted: true, anchor: 'head' });

    const sha = head(ws.roots.a);
    const commit = await evidence(ws, { read: 'repo_commit', sha });
    expect(commit.data?.files).toEqual(((await cockpit(ws, `/repo/commit/${sha}?structured=1`)).json() as { files: unknown }).files);
    expect(commit.revision).toMatchObject({ commitSha: sha, reachableFromHead: true, committedAt: '2026-01-01T00:00:00Z' });
  }, 30_000);
});

describe('isolation and refusals', () => {
  it("answers another project's task as not found, and reads nothing of it", async () => {
    const ws = setup();
    const foreign = await finishedTask(ws, { project: 'b' });
    commitFile(foreign.worktree, 'b-only.txt', 'project B content\n');
    for (const read of ['summary', 'changes', 'files', 'commits', 'handoff', 'history'] as const) {
      const result = await call(ws, { read, runId: foreign.id, ...(read === 'files' ? { path: 'b-only.txt' } : {}) });
      expect(result.isError, read).toBe(true);
      expect(result.text, read).toBe('not found in this project');
    }
  }, 30_000);

  it('refuses a cursor from another read, another task or another project', async () => {
    const ws = setup();
    const task = await finishedTask(ws);
    const other = await finishedTask(ws);
    commitFile(task.worktree, 'long.md', 'x\n'.repeat(60_000));
    commitFile(other.worktree, 'long.md', 'x\n'.repeat(60_000));
    const first = await evidence(ws, { read: 'files', runId: task.id, path: 'long.md' });
    const cursor = first.page!.next!;
    expect((await call(ws, { read: 'files', runId: other.id, path: 'long.md', cursor })).text).toContain('invalid cursor');
    expect((await call(ws, { read: 'handoff', runId: task.id, cursor })).text).toContain('invalid cursor');
    expect((await call(ws, { read: 'files', runId: task.id, path: 'long.md', cursor }, 'b')).text).toContain('invalid cursor');
    expect((await call(ws, { read: 'files', runId: task.id, path: 'long.md', cursor: 'bm90LWEtY3Vyc29y' })).text).toContain('invalid cursor');
  }, 30_000);

  it('names the missing argument and reads nothing', async () => {
    const ws = setup();
    expect((await call(ws, { read: 'changes' })).text).toBe("read 'changes' needs: runId");
    expect((await call(ws, { read: 'commit', runId: 'x' })).text).toBe("read 'commit' needs: sha");
    expect((await call(ws, { read: 'github_ref_status' })).text).toContain('needs prs, issues or both');
  });

  it('reads nothing when the context carries no service entry', async () => {
    const ws = setup();
    const dispatched: string[] = [];
    const counting = createResultsEvidenceTool((ctx) => {
      dispatched.push(ctx.project.id);
      return undefined;
    });
    const result = await counting.call(resultsEvidenceInputSchema.parse({ read: 'summary', runId: 'x' }), contextFor(ws));
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('not connected') });
    expect(dispatched).toEqual(['proj-a']);
    expect(existsSync(join(ws.roots.a, '.local/xezar/runs.json'))).toBe(false);
  });
});
