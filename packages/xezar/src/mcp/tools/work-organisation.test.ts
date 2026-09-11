import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../../runs/store.ts';
import { ProjectContexts, type ProjectContextSource } from '../../server/project-context.ts';
import { connectedProviderAuth } from '../../server/provider-auth.testkit.ts';
import { createApp } from '../../server/server.ts';
import type { RunManager } from '../../workflows/run.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import type { ServiceDispatch } from '../service-adapter.ts';
import { toolListing, type McpToolContext, type McpToolResult } from '../tool.ts';
import { tools } from './index.ts';
import { organiseWorkTool } from './work-organisation.ts';

/**
 * The work-organisation tool (#93). Every case drives the real app `createApp` builds, with real
 * `ProjectContexts`, stores and `RunManager`s sharing one `WorkspaceSemaphore`; only provider auth
 * (always connected) and the agent CLIs (`XEZ_DRY_RUN`) are stubbed. Runs use shell CHECK steps, so
 * they reach a state without any model. Both projects are real git repositories, so a task gets a
 * real worktree and branch for the deletion and variant cases to remove.
 */

const COCKPIT_HOST = '127.0.0.1:4321';
const OK_COMMAND = `node -e "process.stdout.write('ok')"`;
const HOLD_COMMAND = `node -e "setTimeout(() => {}, 20000)"`;

interface Workspace {
  app: ReturnType<typeof createApp>;
  contexts: ProjectContexts;
  roots: { a: string; b: string };
}

const tempDirs: string[] = [];
const makeDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

const makeRoot = (prefix: string): string => {
  const root = makeDir(prefix);
  mkdirSync(join(root, '.xezar'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@xezar.local');
  git(root, 'config', 'user.name', 'xezar-test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'fixture\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
};

let workspace: Workspace | undefined;
const saved = { dryRun: process.env.XEZ_DRY_RUN, home: process.env.XEZ_HOME, followups: process.env.XEZ_FOLLOWUPS };

function setup(maxParallel = 2): Workspace {
  process.env.XEZ_HOME = makeDir('xez-org-home-');
  const boot = makeRoot('xez-org-boot-');
  const roots = { a: makeRoot('xez-org-a-'), b: makeRoot('xez-org-b-') };
  const projects: ProjectContextSource[] = [
    { id: 'proj-a', root: roots.a, status: 'ok' },
    { id: 'proj-b', root: roots.b, status: 'ok' },
  ];
  const semaphore = new WorkspaceSemaphore({
    initial: { maxParallel },
    load: async () => ({ maxParallel, memoryLimitMb: null }),
  });
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

/** The cockpit's own request: same-origin, from the loopback deployment a browser talks to. */
const cockpit = (app: Workspace['app'], path: string, method = 'GET', body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      host: COCKPIT_HOST,
      origin: `http://${COCKPIT_HOST}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const context = async (ws: Workspace, projectId: string) => ws.contexts.context(projectId);
const store = async (ws: Workspace, projectId: string) => (await context(ws, projectId)).store;

/** A tools/call exactly as the service answers it: validate against the tool's schema, then call. */
async function invoke(
  ws: Workspace,
  args: Record<string, unknown>,
  opts: { projectId?: 'proj-a' | 'proj-b'; service?: ServiceDispatch | null } = {},
): Promise<McpToolResult> {
  const projectId = opts.projectId ?? 'proj-a';
  const parsed = organiseWorkTool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: parsed.error.issues.map((i) => i.message).join('; ') }], isError: true };
  }
  const service = opts.service === undefined ? ws.app : opts.service;
  const ctx = {
    project: { id: projectId, name: projectId, root: projectId === 'proj-a' ? ws.roots.a : ws.roots.b },
    xezarVersion: '0.0.0-test',
    ...(service ? { service } : {}),
  } as McpToolContext;
  return organiseWorkTool.call(parsed.data, ctx);
}

const text = (result: McpToolResult): string => result.content[0]!.text;
const body = (result: McpToolResult): Record<string, any> => {
  expect(result.isError, text(result)).toBeFalsy();
  return JSON.parse(text(result)) as Record<string, any>;
};

const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Start a run through the cockpit and answer its id (the first one, for variants). */
async function start(ws: Workspace, projectId: string, body: Record<string, unknown>): Promise<string[]> {
  const res = await cockpit(ws.app, `/api/v1/p/${projectId}/runs`, 'POST', body);
  expect(res.status, await res.clone().text()).toBe(201);
  const value = (await res.json()) as { id: string } | { runs: Array<{ id: string }> };
  return 'runs' in value ? value.runs.map((r) => r.id) : [value.id];
}

const hold = (ws: Workspace, projectId: string, task = 'hold a slot') =>
  start(ws, projectId, { task, steps: [{ id: 'hold', name: 'Hold', command: HOLD_COMMAND }] }).then((ids) => ids[0]!);

/** A finished record, written straight into the store — for the flag and sweep cases, which need
 *  a state rather than an execution. */
function finishedRecord(s: RunStore, status: 'done' | 'failed' | 'cancelled', title: string): RunRecord {
  const run = s.createRun({ title, workflow: 'quick-task', task: title, steps: [] });
  s.updateRun(run.id, { status, finishedAt: new Date(Date.now() - 1_000).toISOString() });
  return s.getRun(run.id)!;
}

/** `running` is stamped before the worktree is on disk; the git cases wait for both. */
const hasWorktree = (run: RunRecord | undefined): boolean =>
  Boolean(run?.worktreePath && run.branch && existsSync(run.worktreePath));

const branchExists = (root: string, branch: string): boolean => git(root, 'branch', '--list', branch).trim() !== '';

beforeEach(() => {
  process.env.XEZ_DRY_RUN = '1';
});

afterEach(async () => {
  const ws = workspace;
  workspace = undefined;
  if (ws) {
    for (const id of ws.contexts.ids()) {
      const ctx = ws.contexts.peek(id);
      if (!ctx) continue;
      const runs = ctx.store.listRuns().map((run) => run.id);
      for (const runId of runs) ctx.manager.cancel(runId);
      // A cancelled check step still writes its closing event when its process exits (#125).
      await waitFor(() => runs.every((runId) => !ctx.manager.isActive(runId)), 'cancelled runs to settle');
      await ctx.manager.dispose();
    }
    ws.contexts.disposeAll();
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ['XEZ_DRY_RUN', saved.dryRun],
    ['XEZ_HOME', saved.home],
    ['XEZ_FOLLOWUPS', saved.followups],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('organise_work is registered and asks for no confirmation', () => {
  it('is in the registry', () => {
    expect(tools).toContain(organiseWorkTool);
  });

  it('has no confirmation, force or approval parameter anywhere in its schema (F-04, F-22)', () => {
    const listed = JSON.stringify(toolListing(organiseWorkTool).inputSchema);
    expect(listed).not.toMatch(/confirm|force|approv|bypass|override/i);
    // And none sneaks in as an unknown key either: extra keys do not reach the call.
    const parsed = organiseWorkTool.inputSchema.parse({ action: 'archive_finished', confirm: false, force: true });
    expect(parsed).toEqual({ action: 'archive_finished' });
  });
});

describe('a queued brief and its queued messages', () => {
  it('are editable while queued, refused once the task started, and the dequeue fold is never written back', async () => {
    const ws = setup(1);
    const holder = await hold(ws, 'proj-a');
    const storeA = await store(ws, 'proj-a');
    await waitFor(() => storeA.getRun(holder)?.status === 'running', 'the holder to take the only slot');
    const [queued] = await start(ws, 'proj-a', {
      task: 'the original brief',
      steps: [{ id: 'work', name: 'Work', command: HOLD_COMMAND }],
    });
    expect(storeA.getRun(queued!)?.status).toBe('queued');
    const stacked = await cockpit(ws.app, `/api/v1/p/proj-a/runs/${queued}/messages`, 'POST', { text: 'a first note' });
    const messageId = ((await stacked.json()) as { message: { id: string } }).message.id;
    const second = await cockpit(ws.app, `/api/v1/p/proj-a/runs/${queued}/messages`, 'POST', { text: 'a second note' });
    const secondId = ((await second.json()) as { message: { id: string } }).message.id;

    // The queue view names the message ids the edits need.
    const queue = body(await invoke(ws, { action: 'list_queue' }));
    expect(queue.items.map((i: { id: string }) => i.id)).toEqual([queued]);
    expect(queue.items[0].messages.map((m: { id: string }) => m.id)).toEqual([messageId, secondId]);

    // While queued: every edit succeeds.
    expect(body(await invoke(ws, { action: 'edit_brief', runId: queued, task: 'the edited brief' }))).toMatchObject({
      status: 'done',
      run: { id: queued, status: 'queued' },
    });
    expect(body(await invoke(ws, { action: 'edit_queued_message', runId: queued, messageId, text: 'an edited note' }))).toMatchObject({
      status: 'done',
      message: { id: messageId },
    });
    expect(body(await invoke(ws, { action: 'remove_queued_message', runId: queued, messageId: secondId }))).toMatchObject({
      status: 'done',
      removed: true,
    });
    expect(storeA.getRun(queued!)?.task).toBe('the edited brief');
    expect(storeA.getRun(queued!)?.queuedMessages?.map((m) => [m.id, m.text])).toEqual([[messageId, 'an edited note']]);

    // Free the slot: the queued task starts.
    expect((await cockpit(ws.app, `/api/v1/p/proj-a/runs/${holder}/cancel`, 'POST')).status).toBe(200);
    await waitFor(() => storeA.getRun(queued!)?.status === 'running', 'the queued task to start');

    // Once started: every edit is a conflict the leader can reason about, and changes nothing.
    for (const args of [
      { action: 'edit_brief', runId: queued, task: 'too late' },
      { action: 'edit_queued_message', runId: queued, messageId, text: 'too late' },
      { action: 'remove_queued_message', runId: queued, messageId },
    ]) {
      expect(body(await invoke(ws, args)), args.action).toMatchObject({ status: 'conflict', reason: 'run already started' });
    }
    // The fold into {{task}} happened in memory only: the record keeps the brief and the stack apart.
    expect(storeA.getRun(queued!)?.task).toBe('the edited brief');
    expect(storeA.getRun(queued!)?.queuedMessages?.map((m) => m.text)).toEqual(['an edited note']);

    // Control: the title is metadata and stays editable on any status.
    expect(body(await invoke(ws, { action: 'set_title', runId: queued, title: 'Renamed while running' }))).toMatchObject({
      status: 'done',
      run: { title: 'Renamed while running', status: 'running' },
    });
  }, 40_000);
});

describe('list_queue', () => {
  it("lists only this project's queued tasks, oldest first, in pages that stay inside the byte budget", async () => {
    const ws = setup(1);
    const holder = await hold(ws, 'proj-a');
    const storeA = await store(ws, 'proj-a');
    await waitFor(() => storeA.getRun(holder)?.status === 'running', 'the holder to take the only slot');
    const quick = [{ id: 'work', command: OK_COMMAND }];
    const [first] = await start(ws, 'proj-a', { task: 'x'.repeat(100_000), steps: quick });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [second] = await start(ws, 'proj-a', { task: 'second', steps: quick });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [third] = await start(ws, 'proj-a', { task: 'third', steps: quick });
    const [foreign] = await start(ws, 'proj-b', { task: 'belongs to b', steps: quick });
    expect((await store(ws, 'proj-b')).getRun(foreign!)?.status).toBe('queued');

    const page1Result = await invoke(ws, { action: 'list_queue', limit: 2 });
    expect(Buffer.byteLength(text(page1Result))).toBeLessThanOrEqual(40_000);
    const page1 = body(page1Result);
    expect(page1).toMatchObject({ status: 'done', total: 3 });
    // The cursor is sealed: it names no task and no project.
    expect(typeof page1.next).toBe('string');
    expect(page1.next).not.toContain(second);
    expect(page1.items.map((i: { id: string; position: number }) => [i.position, i.id])).toEqual([
      [1, first],
      [2, second],
    ]);
    // A long brief is cut, and the cut is stated — never silent (D-09 B-03).
    expect(page1.items[0]).toMatchObject({ briefChars: 100_000, briefTruncated: true });
    expect(page1.items[1]).toMatchObject({ brief: 'second', briefChars: 6 });
    expect(page1.items[1].briefTruncated).toBeUndefined();

    const page2 = body(await invoke(ws, { action: 'list_queue', cursor: page1.next }));
    expect(page2.items.map((i: { id: string }) => i.id)).toEqual([third]);
    expect(page2.next).toBeUndefined();

    // Nothing of project B is visible, and B's id is no cursor here.
    expect(JSON.stringify([page1, page2])).not.toContain(foreign);
    const foreignCursor = await invoke(ws, { action: 'list_queue', cursor: foreign });
    expect(foreignCursor.isError).toBe(true);
    expect(text(foreignCursor)).not.toContain(foreign);
    // Nor is a cursor project B's own queue handed out.
    await start(ws, 'proj-b', { task: 'b two', steps: quick });
    const bPage = body(await invoke(ws, { action: 'list_queue', limit: 1 }, { projectId: 'proj-b' }));
    expect(bPage.next).toBeDefined();
    const bCursor = await invoke(ws, { action: 'list_queue', cursor: bPage.next });
    expect(bCursor.isError).toBe(true);
    expect(text(bCursor)).toMatch(/invalid cursor/);
  }, 40_000);

  it('tells an empty queue apart from a failure', async () => {
    const ws = setup();
    expect(body(await invoke(ws, { action: 'list_queue' }))).toMatchObject({ status: 'done', total: 0, items: [] });
  });
});

describe('per-task flags', () => {
  it('pins, unpins, archives, restores, and marks a finished task read and unread', async () => {
    const ws = setup();
    const storeA = await store(ws, 'proj-a');
    const run = finishedRecord(storeA, 'done', 'finished work');
    const act = async (action: string) => body(await invoke(ws, { action, runId: run.id }));

    expect(await act('pin')).toMatchObject({ status: 'done', run: { id: run.id, pinned: true } });
    expect(storeA.getRun(run.id)?.pinned).toBe(true);
    expect(await act('unpin')).toMatchObject({ run: { pinned: false } });
    expect(await act('mark_read')).toMatchObject({ run: { id: run.id } });
    expect(storeA.getRun(run.id)?.seenAt).toBeDefined();
    expect((await act('mark_unread')).run.seenAt).toBeUndefined();
    expect(storeA.getRun(run.id)?.seenAt).toBeUndefined();
    expect(await act('archive')).toMatchObject({ run: { archived: true } });
    expect(storeA.getRun(run.id)?.archived).toBe(true);
    expect(await act('restore')).toMatchObject({ run: { archived: false } });
    expect(storeA.getRun(run.id)?.archived).toBe(false);
  });
});

describe('delete', () => {
  it('removes the task, its transcript, its worktree and its branch, with no confirmation parameter', async () => {
    const ws = setup();
    const [runId] = await start(ws, 'proj-a', { task: 'to be deleted', steps: [{ id: 'work', command: OK_COMMAND }] });
    const storeA = await store(ws, 'proj-a');
    await waitFor(() => storeA.getRun(runId!)?.status === 'done', 'the task to finish');
    const { worktreePath, branch } = storeA.getRun(runId!)!;
    expect(worktreePath && existsSync(worktreePath)).toBeTruthy();
    expect(branch && branchExists(ws.roots.a, branch)).toBeTruthy();
    const transcript = join(ws.roots.a, '.local/xezar/runs', `${runId}.ndjson`);
    expect(existsSync(transcript)).toBe(true);

    expect(body(await invoke(ws, { action: 'delete', runId }))).toMatchObject({ status: 'done', deleted: true, runId });

    expect(storeA.getRun(runId!)).toBeUndefined();
    expect(existsSync(transcript)).toBe(false);
    expect(existsSync(worktreePath!)).toBe(false);
    expect(branchExists(ws.roots.a, branch!)).toBe(false);
  }, 30_000);
});

describe('pick_variant', () => {
  it('is refused while any variant is active; then keeps the winner and removes the others’ worktrees and branches', async () => {
    const ws = setup(2);
    const [winner, loser] = await start(ws, 'proj-a', {
      task: 'try it two ways',
      variants: 2,
      steps: [{ id: 'hold', name: 'Hold', command: HOLD_COMMAND }],
    });
    const storeA = await store(ws, 'proj-a');
    await waitFor(
      () => [winner!, loser!].every((id) => storeA.getRun(id)?.status === 'running' && hasWorktree(storeA.getRun(id))),
      'both variants to run in their worktrees',
    );
    const groupId = storeA.getRun(winner!)!.groupId!;
    const loserTree = storeA.getRun(loser!)!.worktreePath!;
    const loserBranch = storeA.getRun(loser!)!.branch!;
    const winnerTree = storeA.getRun(winner!)!.worktreePath!;
    expect(existsSync(loserTree) && branchExists(ws.roots.a, loserBranch)).toBe(true);

    // The winner has finished, the other variant has not. The route alone would accept this pick
    // and cancel the running variant; the cockpit's button stays disabled, and so does MCP.
    await cockpit(ws.app, `/api/v1/p/proj-a/runs/${winner}/cancel`, 'POST');
    await waitFor(() => storeA.getRun(winner!)?.status === 'cancelled', 'the winner to stop');
    const early = body(await invoke(ws, { action: 'pick_variant', groupId, runId: winner }));
    expect(early).toMatchObject({ status: 'conflict', active: [{ id: loser, status: 'running' }] });
    expect(storeA.getRun(loser!)).toMatchObject({ status: 'running' });
    expect(storeA.getRun(loser!)?.archived).toBeFalsy();
    expect(existsSync(loserTree) && branchExists(ws.roots.a, loserBranch)).toBe(true);

    await cockpit(ws.app, `/api/v1/p/proj-a/runs/${loser}/cancel`, 'POST');
    await waitFor(() => storeA.getRun(loser!)?.status === 'cancelled', 'the other variant to stop');

    const picked = body(await invoke(ws, { action: 'pick_variant', groupId, runId: winner }));
    expect(picked).toMatchObject({
      status: 'done',
      winner: { id: winner, archived: false },
      others: [{ id: loser, archived: true }],
    });
    expect(storeA.getRun(loser!)).toMatchObject({ archived: true });
    expect(storeA.getRun(loser!)?.worktreePath).toBeUndefined();
    expect(existsSync(loserTree)).toBe(false);
    expect(branchExists(ws.roots.a, loserBranch)).toBe(false);
    // The winner keeps its work.
    expect(existsSync(winnerTree)).toBe(true);
    expect(storeA.getRun(winner!)?.archived).toBeFalsy();
  }, 40_000);
});

describe('the two bulk sweeps', () => {
  it("touch only the bound project's tasks, and say how many", async () => {
    const ws = setup();
    const storeA = await store(ws, 'proj-a');
    const storeB = await store(ws, 'proj-b');
    const a = [finishedRecord(storeA, 'done', 'a done'), finishedRecord(storeA, 'failed', 'a failed')];
    const aCancelled = finishedRecord(storeA, 'cancelled', 'a cancelled');
    const aRunning = storeA.createRun({ title: 'a running', workflow: 'quick-task', task: 'a running', steps: [] });
    storeA.updateRun(aRunning.id, { status: 'running' });
    const b = [finishedRecord(storeB, 'done', 'b done'), finishedRecord(storeB, 'failed', 'b failed')];
    storeB.flush();
    const bIndex = join(ws.roots.b, '.local/xezar/runs.json');
    const bBefore = readFileSync(bIndex, 'utf8');

    expect(body(await invoke(ws, { action: 'mark_all_read' }))).toMatchObject({ status: 'done', read: 2 });
    for (const run of a) expect(storeA.getRun(run.id)?.seenAt).toBeDefined();
    for (const run of b) expect(storeB.getRun(run.id)?.seenAt).toBeUndefined();

    expect(body(await invoke(ws, { action: 'archive_finished' }))).toMatchObject({ status: 'done', archived: 3 });
    for (const run of [...a, aCancelled]) expect(storeA.getRun(run.id)?.archived).toBe(true);
    expect(storeA.getRun(aRunning.id)?.archived).toBeFalsy();
    for (const run of b) expect(storeB.getRun(run.id)?.archived).toBeFalsy();

    storeB.flush();
    expect(readFileSync(bIndex, 'utf8')).toBe(bBefore);
  });
});

describe('Inbox items', () => {
  const writeTodos = (root: string, items: unknown[]) => {
    mkdirSync(join(root, '.local/xezar'), { recursive: true });
    writeFileSync(join(root, '.local/xezar/todos.json'), JSON.stringify(items), 'utf8');
  };
  const readTodos = (root: string) => JSON.parse(readFileSync(join(root, '.local/xezar/todos.json'), 'utf8')) as Array<Record<string, unknown>>;

  it('starts one and removes another; a foreign item is not found; an Inbox that is off is a stated conflict', async () => {
    process.env.XEZ_FOLLOWUPS = '1';
    const ws = setup();
    writeTodos(ws.roots.a, [
      { id: 't-run', summary: 'Follow up on the parser', suggestedPrompt: 'Fix the parser edge case', runnable: true },
      { id: 't-note', summary: 'Remember the release notes', runnable: false },
    ]);
    writeTodos(ws.roots.b, [{ id: 't-b', summary: 'belongs to b', runnable: false }]);
    const bBefore = readFileSync(join(ws.roots.b, '.local/xezar/todos.json'), 'utf8');

    const started = body(await invoke(ws, { action: 'start_inbox_item', todoId: 't-run', prompt: 'keep it small' }));
    expect(started).toMatchObject({ status: 'accepted', accepted: true, subject: { type: 'run' } });
    const storeA = await store(ws, 'proj-a');
    expect(storeA.getRun(started.subject.id)?.task).toContain('keep it small');
    expect(readTodos(ws.roots.a).find((t) => t.id === 't-run')?.startedTaskId).toBe(started.subject.id);

    expect(body(await invoke(ws, { action: 'remove_inbox_item', todoId: 't-note' }))).toMatchObject({ status: 'done', removed: true });
    expect(readTodos(ws.roots.a).map((t) => t.id)).toEqual(['t-run']);

    const foreign = await invoke(ws, { action: 'remove_inbox_item', todoId: 't-b' });
    expect(foreign.isError).toBe(true);
    expect(readFileSync(join(ws.roots.b, '.local/xezar/todos.json'), 'utf8')).toBe(bBefore);

    delete process.env.XEZ_FOLLOWUPS;
    const off = body(await invoke(ws, { action: 'remove_inbox_item', todoId: 't-run' }));
    expect(off).toMatchObject({ status: 'conflict' });
    expect(off.reason).toMatch(/inbox/i);
    expect(readTodos(ws.roots.a).map((t) => t.id)).toEqual(['t-run']);
  }, 30_000);
});

describe('business validation still refuses an invalid transition', () => {
  it('refuses to archive, delete or re-brief an active task, and leaves it untouched', async () => {
    const ws = setup();
    const runId = await hold(ws, 'proj-a', 'still working');
    const storeA = await store(ws, 'proj-a');
    await waitFor(() => storeA.getRun(runId)?.status === 'running' && hasWorktree(storeA.getRun(runId)), 'the task to run');

    expect(body(await invoke(ws, { action: 'archive', runId }))).toMatchObject({ status: 'conflict', run: { status: 'running' } });
    expect(body(await invoke(ws, { action: 'delete', runId }))).toMatchObject({ status: 'conflict', reason: 'run is active — cancel it first' });
    expect(body(await invoke(ws, { action: 'edit_brief', runId, task: 'changed' }))).toMatchObject({ status: 'conflict' });

    expect(storeA.getRun(runId)).toMatchObject({ status: 'running', task: 'still working' });
    expect(storeA.getRun(runId)?.archived).toBeFalsy();
    expect(existsSync(storeA.getRun(runId)!.worktreePath!)).toBe(true);
  }, 30_000);

  it("refuses another project's task, a foreign message inside this project's task, and a foreign group, changing nothing in either", async () => {
    const ws = setup();
    const storeA = await store(ws, 'proj-a');
    const storeB = await store(ws, 'proj-b');
    const now = new Date().toISOString();
    const aRun = storeA.createRun({ title: 'a', workflow: 'quick-task', task: 'a', steps: [] });
    storeA.updateRun(aRun.id, { queuedMessages: [{ id: 'msg-a', text: 'a note', createdAt: now }] });
    const bRun = finishedRecord(storeB, 'done', 'b');
    storeB.updateRun(bRun.id, { groupId: 'group-b', variant: 'A', queuedMessages: [{ id: 'msg-b', text: 'b note', createdAt: now }] });
    storeA.flush();
    storeB.flush();
    const index = (root: string) => readFileSync(join(root, '.local/xezar/runs.json'), 'utf8');
    const before = { a: index(ws.roots.a), b: index(ws.roots.b) };

    for (const args of [
      { action: 'delete', runId: bRun.id },
      { action: 'archive', runId: bRun.id },
      { action: 'pin', runId: bRun.id },
      { action: 'mark_read', runId: bRun.id },
      { action: 'set_title', runId: bRun.id, title: 'taken over' },
      { action: 'edit_queued_message', runId: aRun.id, messageId: 'msg-b', text: 'taken over' },
      { action: 'remove_queued_message', runId: aRun.id, messageId: 'msg-b' },
      { action: 'pick_variant', groupId: 'group-b', runId: bRun.id },
    ]) {
      const result = await invoke(ws, args);
      expect(result.isError, `${args.action}: ${text(result)}`).toBe(true);
      expect(text(result)).toMatch(/not found/);
    }
    storeA.flush();
    storeB.flush();
    expect(index(ws.roots.a)).toBe(before.a);
    expect(index(ws.roots.b)).toBe(before.b);
  });

  it("refuses a task or group whose recorded worktree is another project's tree, and deletes nothing there", async () => {
    const ws = setup();
    const storeA = await store(ws, 'proj-a');
    // B's tree, with work in it.
    const bTree = join(ws.roots.b, '.local/xezar/worktrees', 'b-work');
    mkdirSync(bTree, { recursive: true });
    writeFileSync(join(bTree, 'precious.txt'), 'b', 'utf8');
    // An A record that names B's tree outright.
    const pointsAway = finishedRecord(storeA, 'done', 'points at b');
    storeA.updateRun(pointsAway.id, { worktreePath: bTree, branch: 'xez/b-work' });
    // An A record at A's own worktree path, which is a symlink into B's tree.
    const linked = finishedRecord(storeA, 'done', 'linked into b');
    const linkPath = join(ws.roots.a, '.local/xezar/worktrees', linked.id);
    mkdirSync(join(ws.roots.a, '.local/xezar/worktrees'), { recursive: true });
    symlinkSync(bTree, linkPath);
    storeA.updateRun(linked.id, { worktreePath: linkPath });
    // A variant group with one clean member and the linked one.
    const clean = finishedRecord(storeA, 'done', 'clean variant');
    storeA.updateRun(clean.id, { groupId: 'g-mixed', variant: 'A' });
    storeA.updateRun(linked.id, { groupId: 'g-mixed', variant: 'B' });

    for (const args of [
      { action: 'delete', runId: pointsAway.id },
      { action: 'delete', runId: linked.id },
      { action: 'pick_variant', groupId: 'g-mixed', runId: clean.id },
    ]) {
      const result = await invoke(ws, args);
      expect(result.isError, `${args.action}: ${text(result)}`).toBe(true);
      expect(text(result)).toMatch(/not found in this project/);
      expect(text(result)).not.toContain(ws.roots.b);
    }
    expect(readFileSync(join(bTree, 'precious.txt'), 'utf8')).toBe('b');
    expect(storeA.getRun(pointsAway.id)).toBeDefined();
    expect(storeA.getRun(linked.id)).toBeDefined();
    expect(storeA.getRun(linked.id)?.archived).toBeFalsy();
    expect(storeA.getRun(clean.id)?.archived).toBeFalsy();
  });

  it('refuses input the leader must correct before anything is dispatched', async () => {
    const ws = setup();
    const seen: string[] = [];
    const service: ServiceDispatch = {
      request: (input) => {
        seen.push(input);
        return new Response('{}', { status: 200 });
      },
    };
    for (const args of [
      { action: 'delete' },
      { action: 'delete', runId: '..' },
      { action: 'delete', runId: 'a/b' },
      { action: 'pin', runId: 'r1', title: 'not for pin' },
      { action: 'edit_queued_message', runId: 'r1', messageId: '.', text: 'x' },
      { action: 'pick_variant', runId: 'r1' },
      { action: 'archive_finished', runId: 'r1' },
      { action: 'reprioritise', runId: 'r1' },
    ]) {
      expect((await invoke(ws, args, { service })).isError, JSON.stringify(args)).toBe(true);
    }
    expect(seen).toEqual([]);
  });
});

describe('without a service to dispatch to', () => {
  it('says it is not connected and changes nothing', async () => {
    const ws = setup();
    const storeA = await store(ws, 'proj-a');
    const run = finishedRecord(storeA, 'done', 'keep me');
    const result = await invoke(ws, { action: 'delete', runId: run.id }, { service: null });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not connected/);
    expect(storeA.getRun(run.id)).toBeDefined();
  });
});
