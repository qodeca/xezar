import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../../runs/store.ts';
import { ProjectContexts, type ProjectContextSource } from '../../server/project-context.ts';
import { connectedProviderAuth } from '../../server/provider-auth.testkit.ts';
import { createApp } from '../../server/server.ts';
import type { RunManager } from '../../workflows/run.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import type { ServiceDispatch } from '../service-adapter.ts';
import { toolListing, type McpTool } from '../tool.ts';
import {
  IDLE_TEARDOWN_RETRY_DELAYS_MS,
  createExecutionControlTool,
  executionControlTool,
  formatAnswers,
  pendingQuestionIn,
  type ExecutionControlResult,
} from './execution-control.ts';
import { tools } from './index.ts';

/**
 * Execution control (#94). The end-to-end cases drive the real app `createApp` builds, with real
 * `ProjectContexts`, stores and `RunManager`s sharing ONE `WorkspaceSemaphore` — the agent CLI is
 * the bundled mock (`XEZ_DRY_RUN`), whose `mock:ask` reply ends in a real `XEZ:ASK` marker, and
 * provider auth is always connected. The fake-service cases pin the routing table and the retry
 * schedule without any process at all.
 */

const OK_COMMAND = `node -e "process.stdout.write('ok')"`;
const HOLD_COMMAND = `node -e "setTimeout(() => {}, 30000)"`;
const AGENT_STEPS = [{ id: 'task', name: 'Task', prompt: '{{task}}' }];

interface Workspace {
  app: ReturnType<typeof createApp>;
  contexts: ProjectContexts;
  roots: { 'proj-a': string; 'proj-b': string };
}

const tempDirs: string[] = [];
const makeDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};
/** A git project, so every task runs in its own worktree: tasks that run in the project folder
 *  itself share one repository-root lease, and a waiting session holds it for its lifetime. */
const makeRoot = (prefix: string): string => {
  const root = makeDir(prefix);
  mkdirSync(join(root, '.xezar'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return root;
};

let workspace: Workspace | undefined;
const savedDryRun = process.env.XEZ_DRY_RUN;
const savedHome = process.env.XEZ_HOME;

function setup(maxParallel = 2): Workspace {
  process.env.XEZ_HOME = makeDir('xez-ec-home-');
  const boot = makeRoot('xez-ec-boot-');
  const roots = { 'proj-a': makeRoot('xez-ec-a-'), 'proj-b': makeRoot('xez-ec-b-') };
  const projects: ProjectContextSource[] = [
    { id: 'proj-a', root: roots['proj-a'], status: 'ok' },
    { id: 'proj-b', root: roots['proj-b'], status: 'ok' },
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

type ProjectId = keyof Workspace['roots'];

const store = async (ws: Workspace, projectId: ProjectId) => (await ws.contexts.context(projectId)).store;

/** Validate exactly as the service does (`callTool` in ../service.ts), then call. */
async function invoke(
  ws: { app: ServiceDispatch; roots?: Workspace['roots'] },
  projectId: string,
  args: Record<string, unknown>,
  tool: McpTool = executionControlTool,
): Promise<{ isError: boolean; value: ExecutionControlResult }> {
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) throw new Error(`invalid arguments: ${parsed.error.message}`);
  const ctx = {
    project: { id: projectId, name: projectId, root: ws.roots?.[projectId as ProjectId] ?? '/nowhere' },
    xezarVersion: '0.0.0-test',
    service: ws.app,
  };
  const res = await tool.call(parsed.data, ctx);
  const block = res.content[0] as { type: 'text'; text: string };
  const value = JSON.parse(block.text) as ExecutionControlResult;
  expect(res.structuredContent).toEqual(value);
  return { isError: res.isError === true, value };
}

const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Start a task through the cockpit's own route, as a human would. */
async function start(ws: Workspace, projectId: ProjectId, body: Record<string, unknown>): Promise<string> {
  const res = await ws.app.request(`/api/v1/p/${projectId}/runs`, {
    method: 'POST',
    headers: { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** The cockpit's own request for any other route. */
const cockpit = (ws: Workspace, path: string, method: string, body?: unknown) =>
  ws.app.request(path, {
    method,
    headers: {
      host: '127.0.0.1:4321',
      origin: 'http://127.0.0.1:4321',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const asks = (s: RunStore, id: string) => s.readEvents(id).filter((e) => e.type === 'ask.requested');
const userMessages = (s: RunStore, id: string) =>
  s.readEvents(id).filter((e) => e.type === 'user-message').map((e) => String(e.text));

/** A xezar task running this suite has its OWN handoff file, inbox and task id in the env, and a
 *  mock agent spawned here inherits the process env — so without this it appends its dry-run
 *  lines to the real task's handoff file and inbox. */
const AGENT_SESSION_ENV = ['XEZ_HANDOFF_FILE', 'XEZ_TODOS_FILE', 'XEZ_TASK_ID'] as const;
const savedSessionEnv = Object.fromEntries(AGENT_SESSION_ENV.map((key) => [key, process.env[key]]));

beforeEach(() => {
  process.env.XEZ_DRY_RUN = '1';
  for (const key of AGENT_SESSION_ENV) delete process.env[key];
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
      await waitFor(() => runs.every((runId) => !ctx.manager.isActive(runId)), 'cancelled runs to settle');
      await ctx.manager.dispose();
    }
    ws.contexts.disposeAll();
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedDryRun === undefined) delete process.env.XEZ_DRY_RUN;
  else process.env.XEZ_DRY_RUN = savedDryRun;
  if (savedHome === undefined) delete process.env.XEZ_HOME;
  else process.env.XEZ_HOME = savedHome;
  for (const key of AGENT_SESSION_ENV) {
    if (savedSessionEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedSessionEnv[key];
  }
});

describe('no tool can terminate an arbitrary process', () => {
  it('no registered tool takes a process id, a signal, a command or a path', () => {
    // Matched per WORD of a camelCase / snake_case name, so `groupId` is not read as `pid`.
    const forbiddenWord = /^(pids?|signals?|process(es)?|commands?|kill|paths?|cwd|exec)$/;
    const forbidden = (name: string) =>
      name.split(/(?=[A-Z])|[_-]/).some((word) => forbiddenWord.test(word.toLowerCase()));
    for (const name of ['pid', 'processId', 'signal', 'filePath', 'cwd', 'exec_args', 'killSwitch', 'command'])
      expect(forbidden(name), name).toBe(true);
    for (const name of ['groupId', 'runId', 'rapid', 'messageId']) expect(forbidden(name), name).toBe(false);
    const names = (schema: unknown): string[] => {
      if (!schema || typeof schema !== 'object') return [];
      const node = schema as { properties?: Record<string, unknown>; items?: unknown };
      return [
        ...Object.keys(node.properties ?? {}),
        ...Object.values(node.properties ?? {}).flatMap(names),
        ...names(node.items),
      ];
    };
    // The one exception, by exact tool and field: a file read's `path` is relative to the task's
    // own worktree and confined there by `ownWorktreeFile` (A-04: absolute, `..`, `.git` and
    // symlinked paths are refused — pinned in results-evidence.test.ts). It names no process.
    const confinedPaths = new Set(['read_results_evidence.path']);
    expect(tools).toContain(executionControlTool);
    for (const tool of tools) {
      for (const name of names(toolListing(tool).inputSchema)) {
        if (confinedPaths.has(`${tool.name}.${name}`)) continue;
        expect(forbidden(name), `${tool.name}.${name}`).toBe(false);
      }
    }
    // This tool names a task, never a process: its whole argument surface, pinned.
    const schema = toolListing(executionControlTool).inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['action', 'answers', 'finishAs', 'images', 'messageId', 'questionId', 'runId', 'text'].sort(),
    );
  });

  it('starts, signals and spawns nothing itself — every effect is a cockpit route', () => {
    const source = readFileSync(new URL('./execution-control.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../../server/app-type.ts', '../service-adapter.ts', '../tool.ts', '@qodeca/xezar-contract', 'hono/client', 'zod']);
    expect(source).not.toMatch(/process\.kill|child_process|node:fs|RunStore|new RunManager|\.cancel\(/);
  });

  it('refuses arguments that do not apply to the action instead of dropping them', () => {
    const parse = (args: Record<string, unknown>) => executionControlTool.inputSchema.safeParse(args).success;
    expect(parse({ action: 'cancel', runId: 'r1' })).toBe(true);
    expect(parse({ action: 'cancel', runId: 'r1', pid: 4242 })).toBe(false);
    expect(parse({ action: 'cancel', runId: 'r1', text: 'why' })).toBe(false);
    expect(parse({ action: 'finish', runId: 'r1' })).toBe(false);
    expect(parse({ action: 'send_message', runId: 'r1' })).toBe(false);
    expect(parse({ action: 'send_message', runId: 'r1', text: '   ' })).toBe(false);
    expect(parse({ action: 'answer_question', runId: 'r1', questionId: 'q' })).toBe(false);
    expect(parse({ action: 'answer_question', runId: 'r1', questionId: 'q', text: 'x', answers: [{ choices: ['a'] }] })).toBe(false);
    expect(parse({ action: 'remove_queued_message', runId: 'r1' })).toBe(false);
  });

  it('changes nothing and says so when the service is not wired into the context', async () => {
    const res = await executionControlTool.call(
      { action: 'cancel', runId: 'r1' },
      { project: { id: 'proj-a', name: 'a', root: '/nowhere' }, xezarVersion: '0.0.0-test' },
    );
    expect(res.isError).toBe(true);
  });
});

describe('A has queued, running, waiting and completed tasks; B runs one too', () => {
  it("cancelling in A never stops B's process, and every invalid transition leaves state unchanged", async () => {
    const ws = setup(2);
    const storeA = await store(ws, 'proj-a');
    const storeB = await store(ws, 'proj-b');

    const waiting = await start(ws, 'proj-a', { task: 'mock:ask which library?', steps: AGENT_STEPS });
    await waitFor(() => storeA.getRun(waiting)?.status === 'waiting', 'the agent task to park at its question');
    const completed = await start(ws, 'proj-a', { task: 'finish at once', steps: [{ id: 'ok', command: OK_COMMAND }] });
    await waitFor(() => storeA.getRun(completed)?.status === 'done', 'the check task to finish');
    const running = await start(ws, 'proj-a', { task: 'hold a slot', steps: [{ id: 'hold', command: HOLD_COMMAND }] });
    const runningB = await start(ws, 'proj-b', { task: 'belongs to b', steps: [{ id: 'hold', command: HOLD_COMMAND }] });
    await waitFor(
      () => storeA.getRun(running)?.status === 'running' && storeB.getRun(runningB)?.status === 'running',
      'both holds to take the two slots',
    );
    const queued = await start(ws, 'proj-a', { task: 'wait for a slot', steps: [{ id: 'ok', command: OK_COMMAND }] });
    expect(storeA.getRun(queued)?.status).toBe('queued');

    // B's task is invisible from A: a 404 before anything is dispatched, and B keeps running.
    for (const action of ['cancel', 'cancel_auto_resume'] as const) {
      const other = await invoke(ws, 'proj-a', { action, runId: runningB });
      expect(other.isError).toBe(true);
      expect(other.value).toMatchObject({ accepted: false, status: 'failed', reason: 'not found' });
    }
    expect(storeB.getRun(runningB)?.status).toBe('running');

    // Invalid transitions: refused as a conflict, the record and its log exactly as they were.
    const frozen = (id: string) => JSON.stringify({ run: storeA.getRun(id), events: storeA.readEvents(id).length });
    const invalid: Array<[string, Record<string, unknown>]> = [
      [completed, { action: 'cancel' }],
      [completed, { action: 'finish', finishAs: 'close_session' }],
      [completed, { action: 'edit_queued_message', messageId: 'm1', text: 'x' }],
      [completed, { action: 'send_message', text: 'hello' }], // closed, and no agent session to reopen
      [completed, { action: 'continue' }],
      [waiting, { action: 'finish', finishAs: 'accept_review' }], // wrong meaning for a waiting task
      [waiting, { action: 'continue', text: 'go on' }],
      [waiting, { action: 'remove_queued_message', messageId: 'm1' }],
      [queued, { action: 'finish', finishAs: 'close_session' }],
      [queued, { action: 'continue' }],
    ];
    for (const [runId, args] of invalid) {
      const before = frozen(runId);
      const answer = await invoke(ws, 'proj-a', { ...args, runId });
      expect(answer.isError, JSON.stringify(args)).toBe(false);
      expect(answer.value, JSON.stringify(args)).toMatchObject({ accepted: false, status: 'conflict' });
      expect(answer.value.reason, JSON.stringify(args)).toBeTruthy();
      expect(frozen(runId), JSON.stringify(args)).toBe(before);
    }

    // Cancelling A's running task stops it — and only it.
    const cancelled = await invoke(ws, 'proj-a', { action: 'cancel', runId: running });
    expect(cancelled.value).toMatchObject({ accepted: true, subject: { type: 'run', id: running } });
    await waitFor(() => storeA.getRun(running)?.status === 'cancelled', "A's task to end cancelled");
    // The freed slot goes to A's queued task through the scheduler, as after a cockpit cancel.
    await waitFor(() => storeA.getRun(queued)?.status === 'done', 'the queued task to take the slot');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(storeB.getRun(runningB)?.status).toBe('running');
    expect(storeB.getRun(runningB)?.steps[0]?.status).toBe('running');
    expect((await ws.contexts.context('proj-b')).manager.isActive(runningB)).toBe(true);
  }, 60_000);
});

describe('an answer reaches the pending question it names', () => {
  it('refuses a question that is not the named task\'s pending one, and delivers the right one', async () => {
    const ws = setup(2);
    const storeA = await store(ws, 'proj-a');
    const first = await start(ws, 'proj-a', { task: 'mock:ask one', steps: AGENT_STEPS });
    const second = await start(ws, 'proj-a', { task: 'mock:ask two', steps: AGENT_STEPS });
    await waitFor(
      () => storeA.getRun(first)?.status === 'waiting' && storeA.getRun(second)?.status === 'waiting',
      'two tasks to park at their questions',
    );
    const q1 = String(asks(storeA, first)[0]!.requestId);
    const q2 = String(asks(storeA, second)[0]!.requestId);
    expect(q1).not.toBe(q2);
    const sentBefore = { first: userMessages(storeA, first), second: userMessages(storeA, second) };

    // Two questions are open. The second task's question named against the first task is refused:
    // delivering it would answer the FIRST task's question with the second one's answer.
    const crossed = await invoke(ws, 'proj-a', { action: 'answer_question', runId: first, questionId: q2, answers: [{ choices: ['Luxon'] }] });
    expect(crossed.value).toMatchObject({ accepted: false, status: 'conflict' });
    expect(userMessages(storeA, first)).toEqual(sentBefore.first);
    expect(userMessages(storeA, second)).toEqual(sentBefore.second);
    expect(storeA.getRun(first)?.status).toBe('waiting');

    // A choice the question does not offer is refused before anything is sent.
    const bogus = await invoke(ws, 'proj-a', { action: 'answer_question', runId: second, questionId: q2, answers: [{ choices: ['Moment'] }] });
    expect(bogus).toMatchObject({ isError: true, value: { accepted: false } });
    expect(userMessages(storeA, second)).toEqual(sentBefore.second);

    // The right pairing lands on the right task, live, formatted as the ask card formats it.
    const answered = await invoke(ws, 'proj-a', { action: 'answer_question', runId: second, questionId: q2, answers: [{ choices: ['date-fns'] }] });
    expect(answered.value).toMatchObject({ accepted: true, status: 'accepted', delivery: 'live', questionId: q2 });
    expect(userMessages(storeA, second)).toEqual([...sentBefore.second, 'Library: date-fns']);
    expect(userMessages(storeA, first)).toEqual(sentBefore.first);

    // A newer question supersedes an older unanswered one in the same task (a native backend ask
    // arriving while the first is still open): only the newer one can be answered.
    await waitFor(() => storeA.getRun(second)?.status === 'waiting', 'the answered task to park again');
    const newer = storeA.appendEvent(first, {
      type: 'ask.requested',
      requestId: 'q-newer',
      questions: [{ header: 'Scope', question: 'How far?', options: [{ label: 'Narrow' }, { label: 'Wide' }] }],
    });
    expect(newer.type).toBe('ask.requested');
    const stale = await invoke(ws, 'proj-a', { action: 'answer_question', runId: first, questionId: q1, answers: [{ choices: ['Luxon'] }] });
    expect(stale.value).toMatchObject({ accepted: false, status: 'conflict' });
    expect(userMessages(storeA, first)).toEqual(sentBefore.first);
    const current = await invoke(ws, 'proj-a', { action: 'answer_question', runId: first, questionId: 'q-newer', text: 'Narrow, please' });
    expect(current.value).toMatchObject({ accepted: true, delivery: 'live' });
    expect(userMessages(storeA, first)).toEqual([...sentBefore.first, 'Narrow, please']);

    // Once answered, nothing is pending: a second answer to the same question is refused.
    const again = await invoke(ws, 'proj-a', { action: 'answer_question', runId: first, questionId: 'q-newer', text: 'Wide' });
    expect(again.value).toMatchObject({ accepted: false, status: 'conflict' });
  }, 60_000);

  it('reopens a closed session to deliver an answer, and refuses when no session was recorded', async () => {
    const ws = setup(2);
    const storeA = await store(ws, 'proj-a');
    const asked = await start(ws, 'proj-a', { task: 'mock:ask then close', steps: AGENT_STEPS });
    await waitFor(() => storeA.getRun(asked)?.status === 'waiting', 'the task to park at its question');
    const questionId = String(asks(storeA, asked)[0]!.requestId);
    const closed = await invoke(ws, 'proj-a', { action: 'finish', runId: asked, finishAs: 'close_session' });
    expect(closed.value).toMatchObject({ accepted: true, status: 'accepted' });
    await waitFor(() => storeA.getRun(asked)?.status === 'done', 'the session to close');

    const resumed = await invoke(ws, 'proj-a', { action: 'answer_question', runId: asked, questionId, answers: [{ choices: ['Luxon'] }] });
    expect(resumed.value).toMatchObject({ accepted: true, delivery: 'resumed', questionId });
    expect(userMessages(storeA, asked).at(-1)).toBe('Library: Luxon');
    await waitFor(() => storeA.getRun(asked)?.status === 'waiting', 'the reopened session to answer');

    // A check task never recorded an agent session: the answer has nowhere to go.
    const check = await start(ws, 'proj-a', { task: 'no session', steps: [{ id: 'ok', command: OK_COMMAND }] });
    await waitFor(() => storeA.getRun(check)?.status === 'done', 'the check task to finish');
    storeA.appendEvent(check, { type: 'ask.requested', requestId: 'q-orphan', questions: [{ header: 'H', question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }] });
    const orphan = await invoke(ws, 'proj-a', { action: 'answer_question', runId: check, questionId: 'q-orphan', text: 'A' });
    expect(orphan.value).toMatchObject({ accepted: false, status: 'conflict' });
    expect(orphan.value.reason).toMatch(/no agent session was recorded/);
    expect(storeA.getRun(check)?.status).toBe('done');
  }, 60_000);
});

describe('finish, continue and messages follow the session state', () => {
  it('closes a waiting session, reopens it with a message, and sends a review back with its prefix', async () => {
    const ws = setup(2);
    const storeA = await store(ws, 'proj-a');
    const task = await start(ws, 'proj-a', { task: 'say hello', steps: AGENT_STEPS });
    await waitFor(() => storeA.getRun(task)?.status === 'waiting', 'the task to wait for a reply');

    // Session open → the message is delivered live.
    const live = await invoke(ws, 'proj-a', { action: 'send_message', runId: task, text: 'and goodbye' });
    expect(live.value).toMatchObject({ accepted: true, delivery: 'live' });
    expect(userMessages(storeA, task).at(-1)).toBe('and goodbye');
    await waitFor(() => storeA.getRun(task)?.status === 'waiting', 'the reply to settle');

    // Finish on a waiting task closes the session; the run completes.
    const finished = await invoke(ws, 'proj-a', { action: 'finish', runId: task, finishAs: 'close_session' });
    expect(finished.value).toMatchObject({ accepted: true, status: 'accepted' });
    await waitFor(() => storeA.getRun(task)?.status === 'done', 'the session to close');
    expect(storeA.readEvents(task).some((e) => e.type === 'lifecycle' && e.message === 'session closed by user')).toBe(true);

    // Closed with a recorded session → the message continues it, and the session reopens.
    const reopened = await invoke(ws, 'proj-a', { action: 'send_message', runId: task, text: 'one more thing' });
    expect(reopened.value).toMatchObject({ accepted: true, delivery: 'continued' });
    expect(userMessages(storeA, task).at(-1)).toBe('one more thing');
    await waitFor(() => storeA.getRun(task)?.status === 'waiting', 'the reopened session to reply');

    // Close it again, then put it at review: finish now means accept, and continue means send back.
    await invoke(ws, 'proj-a', { action: 'finish', runId: task, finishAs: 'close_session' });
    await waitFor(() => storeA.getRun(task)?.status === 'done', 'the session to close again');
    storeA.updateRun(task, { status: 'review' });
    const blind = await invoke(ws, 'proj-a', { action: 'continue', runId: task });
    expect(blind.value).toMatchObject({ accepted: false, status: 'conflict' });
    expect(storeA.getRun(task)?.status).toBe('review');
    const wrongMeaning = await invoke(ws, 'proj-a', { action: 'finish', runId: task, finishAs: 'close_session' });
    expect(wrongMeaning.value).toMatchObject({ accepted: false, status: 'conflict' });
    const sentBack = await invoke(ws, 'proj-a', { action: 'continue', runId: task, text: 'tighten the wording' });
    expect(sentBack.value).toMatchObject({ accepted: true, delivery: 'continued' });
    expect(userMessages(storeA, task).at(-1)).toBe('Review feedback:\ntighten the wording');
    await waitFor(() => storeA.getRun(task)?.status === 'waiting', 'the sent-back session to reply');
    await invoke(ws, 'proj-a', { action: 'finish', runId: task, finishAs: 'close_session' });
    await waitFor(() => storeA.getRun(task)?.status === 'done', 'the session to close a third time');
    storeA.updateRun(task, { status: 'review' });
    const accepted = await invoke(ws, 'proj-a', { action: 'finish', runId: task, finishAs: 'accept_review' });
    expect(accepted.value).toMatchObject({ accepted: true, status: 'done', runStatus: 'done' });
    expect(storeA.readEvents(task).at(-1)).toMatchObject({ type: 'lifecycle', message: 'review accepted — finished without a PR' });
  }, 90_000);
});

describe('a queued task: amend, edit, remove — with the same effect as the cockpit', () => {
  it('stacks, edits and removes a queued message, and cancels exactly as the cockpit does', async () => {
    const ws = setup(1);
    const storeA = await store(ws, 'proj-a');
    const hold = await start(ws, 'proj-a', { task: 'hold the slot', steps: [{ id: 'hold', command: HOLD_COMMAND }] });
    await waitFor(() => storeA.getRun(hold)?.status === 'running', 'the hold to take the slot');
    const viaTool = await start(ws, 'proj-a', { task: 'queued one', steps: [{ id: 'ok', command: OK_COMMAND }] });
    const viaCockpit = await start(ws, 'proj-a', { task: 'queued one', steps: [{ id: 'ok', command: OK_COMMAND }] });

    // Queued → the message is folded into the prompt (the "amend" rung).
    const amended = await invoke(ws, 'proj-a', { action: 'send_message', runId: viaTool, text: 'also this' });
    expect(amended.value).toMatchObject({ accepted: true, status: 'done', delivery: 'amended' });
    const messageId = amended.value.messageId!;
    const cockpitSend = await cockpit(ws, `/api/v1/p/proj-a/runs/${viaCockpit}/messages`, 'POST', { text: 'also this' });
    const cockpitMessageId = ((await cockpitSend.json()) as { message: { id: string } }).message.id;

    const edited = await invoke(ws, 'proj-a', { action: 'edit_queued_message', runId: viaTool, messageId, text: 'also that' });
    expect(edited.value).toMatchObject({ accepted: true, status: 'done', messageId });
    await cockpit(ws, `/api/v1/p/proj-a/runs/${viaCockpit}/queued-messages/${cockpitMessageId}`, 'PATCH', { text: 'also that' });
    const stack = (id: string) => (storeA.getRun(id)?.queuedMessages ?? []).map((m) => m.text);
    expect(stack(viaTool)).toEqual(['also that']);
    expect(stack(viaTool)).toEqual(stack(viaCockpit));

    // An unknown message id is a failure, not a silent success; the stack is untouched.
    const missing = await invoke(ws, 'proj-a', { action: 'remove_queued_message', runId: viaTool, messageId: 'no-such-message' });
    expect(missing).toMatchObject({ isError: true, value: { accepted: false } });
    expect(stack(viaTool)).toEqual(['also that']);
    const dotted = await invoke(ws, 'proj-a', { action: 'remove_queued_message', runId: viaTool, messageId: '..' });
    expect(dotted.isError).toBe(true);

    const removed = await invoke(ws, 'proj-a', { action: 'remove_queued_message', runId: viaTool, messageId });
    expect(removed.value).toMatchObject({ accepted: true, status: 'done' });
    await cockpit(ws, `/api/v1/p/proj-a/runs/${viaCockpit}/queued-messages/${cockpitMessageId}`, 'DELETE');
    expect(stack(viaTool)).toEqual([]);
    expect(stack(viaCockpit)).toEqual([]);

    // Cancel while queued: dropped at once — the same record and log as the cockpit's cancel.
    const cancelled = await invoke(ws, 'proj-a', { action: 'cancel', runId: viaTool });
    expect(cancelled.value).toMatchObject({ accepted: true, status: 'cancelled', runStatus: 'cancelled' });
    expect((await cockpit(ws, `/api/v1/p/proj-a/runs/${viaCockpit}/cancel`, 'POST')).status).toBe(200);
    const shape = (id: string) => ({
      status: storeA.getRun(id)?.status,
      queuedMessages: storeA.getRun(id)?.queuedMessages,
      events: storeA.readEvents(id).map((e) => [e.type, e.message ?? e.text ?? null]),
    });
    expect(shape(viaTool)).toEqual(shape(viaCockpit));
    expect(storeA.getRun(hold)?.status).toBe('running');
  }, 60_000);
});

describe('automatic resumes', () => {
  it('cancels a scheduled resume for this task and reports whether one was pending', async () => {
    const ws = setup(2);
    const storeA = await store(ws, 'proj-a');
    const task = await start(ws, 'proj-a', { task: 'finish', steps: [{ id: 'ok', command: OK_COMMAND }] });
    await waitFor(() => storeA.getRun(task)?.status === 'done', 'the task to finish');

    const nothing = await invoke(ws, 'proj-a', { action: 'cancel_auto_resume', runId: task });
    expect(nothing.value).toMatchObject({ accepted: true, status: 'done', hadPendingAutoResume: false });

    storeA.updateRun(task, { status: 'failed', autoResumeAt: new Date(Date.now() + 3_600_000).toISOString(), autoResumeAttempts: 1 });
    const pending = await invoke(ws, 'proj-a', { action: 'cancel_auto_resume', runId: task });
    expect(pending.value).toMatchObject({ accepted: true, status: 'done', hadPendingAutoResume: true });
    expect(storeA.getRun(task)?.autoResumeAt).toBeUndefined();
    expect(storeA.readEvents(task).at(-1)).toMatchObject({ type: 'note', message: 'automatic resume cancelled for this task' });
  }, 30_000);
});

// ---- the routing table and the retry schedule, over a fake service ------------------------------

interface FakeRun {
  status: string;
  sessionId?: string;
}

/** A service that answers the run read, its history and the given writes, and records each call. */
function fakeService(run: FakeRun, writes: Record<string, Array<{ status: number; body: unknown }>>) {
  const calls: string[] = [];
  const service: ServiceDispatch = {
    request: (input, init) => {
      const url = new URL(input);
      const route = `${init?.method ?? 'GET'} ${url.pathname.replace('/api/v1/p/proj-a/runs/r1', '')}`;
      calls.push(route);
      if (route === 'GET ') {
        return Response.json({
          id: 'r1',
          status: run.status,
          steps: [{ id: 's', name: 'S', status: 'done', ...(run.sessionId ? { sessionId: run.sessionId } : {}) }],
        });
      }
      if (route === 'GET /history') {
        return Response.json({
          events: [{ seq: 1, ts: 't', type: 'ask.requested', requestId: 'q1', questions: [{ header: 'H', question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }] }],
          itemCount: 1,
          liveCursor: 'c',
          asOfSeq: 1,
          hasOlder: false,
        });
      }
      const queue = writes[route];
      const next = queue?.shift();
      if (!next) return Response.json({ error: `unexpected ${route}` }, { status: 500 });
      return Response.json(next.body, { status: next.status });
    },
  };
  return { service, calls };
}

describe('send_message routes by state, exactly as the composer does', () => {
  const table: Array<[FakeRun, string | null]> = [
    [{ status: 'running', sessionId: 's1' }, 'POST /messages'],
    [{ status: 'waiting', sessionId: 's1' }, 'POST /messages'],
    [{ status: 'queued' }, 'POST /messages'],
    [{ status: 'done', sessionId: 's1' }, 'POST /continue'],
    [{ status: 'failed', sessionId: 's1' }, 'POST /continue'],
    [{ status: 'cancelled', sessionId: 's1' }, 'POST /continue'],
    [{ status: 'review', sessionId: 's1' }, 'POST /continue'],
    [{ status: 'done' }, null],
    [{ status: 'failed' }, null],
  ];
  it.each(table)('%o → %s', async (run, route) => {
    const { service, calls } = fakeService(run, {
      'POST /messages': [{ status: 200, body: { delivered: true } }],
      'POST /continue': [{ status: 200, body: { continued: true } }],
    });
    const answer = await invoke({ app: service }, 'proj-a', { action: 'send_message', runId: 'r1', text: 'hi' });
    const writes = calls.filter((call) => call.startsWith('POST'));
    if (route === null) {
      expect(answer.value).toMatchObject({ accepted: false, status: 'conflict', reason: 'Session closed — no session to resume.' });
      expect(writes).toEqual([]);
    } else {
      expect(answer.value.accepted).toBe(true);
      expect(writes).toEqual([route]);
    }
  });
});

describe('an answer on the resume seam retries only the idle-teardown refusal', () => {
  it('retries "run is still active" on the cockpit schedule, then delivers', async () => {
    const { service, calls } = fakeService({ status: 'done', sessionId: 's1' }, {
      'POST /continue': [
        { status: 409, body: { error: 'run is still active' } },
        { status: 409, body: { error: 'run is still active' } },
        { status: 200, body: { continued: true } },
      ],
    });
    const waits: number[] = [];
    const tool = createExecutionControlTool(async (ms) => void waits.push(ms));
    const answer = await invoke({ app: service }, 'proj-a', { action: 'answer_question', runId: 'r1', questionId: 'q1', answers: [{ choices: ['B'] }] }, tool);
    expect(answer.value).toMatchObject({ accepted: true, delivery: 'resumed' });
    expect(waits).toEqual(IDLE_TEARDOWN_RETRY_DELAYS_MS.slice(0, 2));
    expect(calls.filter((c) => c === 'POST /continue')).toHaveLength(3);
  });

  it('gives up after the schedule, and never retries any other refusal', async () => {
    const endless = Array.from({ length: 20 }, () => ({ status: 409, body: { error: 'run is still active' } }));
    const exhausted = fakeService({ status: 'done', sessionId: 's1' }, { 'POST /continue': endless });
    const waits: number[] = [];
    const tool = createExecutionControlTool(async (ms) => void waits.push(ms));
    const gaveUp = await invoke({ app: exhausted.service }, 'proj-a', { action: 'answer_question', runId: 'r1', questionId: 'q1', text: 'A' }, tool);
    expect(gaveUp.value).toMatchObject({ accepted: false, status: 'conflict', reason: 'run is still active' });
    expect(waits).toEqual([...IDLE_TEARDOWN_RETRY_DELAYS_MS]);

    const provider = fakeService({ status: 'done', sessionId: 's1' }, {
      'POST /continue': [{ status: 409, body: { error: 'Claude Code is disabled. Enable it in Settings → Agents → Providers.' } }],
    });
    const noRetry: number[] = [];
    const blocked = await invoke(
      { app: provider.service },
      'proj-a',
      { action: 'answer_question', runId: 'r1', questionId: 'q1', text: 'A' },
      createExecutionControlTool(async (ms) => void noRetry.push(ms)),
    );
    expect(blocked.value).toMatchObject({ accepted: false, status: 'conflict' });
    expect(noRetry).toEqual([]);
  });

  it('falls back from a live 409 to a resume when the task has a session', async () => {
    const { service, calls } = fakeService({ status: 'waiting', sessionId: 's1' }, {
      'POST /messages': [{ status: 409, body: { error: 'session closed' } }],
      'POST /continue': [{ status: 200, body: { continued: true } }],
    });
    const answer = await invoke({ app: service }, 'proj-a', { action: 'answer_question', runId: 'r1', questionId: 'q1', text: 'A' });
    expect(answer.value).toMatchObject({ accepted: true, delivery: 'resumed' });
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual(['POST /messages', 'POST /continue']);
  });
});

describe('the pending question and the answer text', () => {
  const ask = (seq: number, requestId: string) => ({
    seq,
    type: 'ask.requested',
    requestId,
    questions: [{ header: 'H', question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }],
  });
  it('is the newest ask with no user message after it — never a superseded or answered one', () => {
    expect(pendingQuestionIn([ask(1, 'old'), ask(2, 'new')])?.requestId).toBe('new');
    expect(pendingQuestionIn([ask(2, 'new'), ask(1, 'old')])?.requestId).toBe('new');
    expect(pendingQuestionIn([ask(1, 'q'), { seq: 2, type: 'user-message', text: 'A' }])).toBeNull();
    // A malformed newer ask is skipped, as the cockpit's reducer skips it.
    expect(pendingQuestionIn([ask(1, 'q'), { seq: 2, type: 'ask.requested', requestId: 'bad', questions: [] }])?.requestId).toBe('q');
    // Nothing decisive in THESE events: undefined, so the caller reads older ones — never "none".
    expect(pendingQuestionIn([])).toBeUndefined();
    expect(pendingQuestionIn([{ seq: 1, type: 'text', text: 'hi' }])).toBeUndefined();
  });

  it('formats one line per question, as the ask card does, and refuses what the card could not send', () => {
    const questions = [
      { header: 'Library', options: [{ label: 'date-fns' }, { label: 'Luxon' }] },
      { header: 'Targets', multiSelect: true, options: [{ label: 'web' }, { label: 'cli' }] },
    ];
    expect(formatAnswers(questions, [{ choices: ['Luxon'] }, { choices: ['web', 'cli'] }])).toEqual({
      ok: true,
      text: 'Library: Luxon\nTargets: web, cli',
    });
    expect(formatAnswers(questions, [{ choices: ['Luxon'] }]).ok).toBe(false);
    expect(formatAnswers(questions, [{ choices: ['Luxon', 'date-fns'] }, { choices: ['web'] }]).ok).toBe(false);
    expect(formatAnswers(questions, [{ choices: ['Moment'] }, { choices: ['web'] }]).ok).toBe(false);
    expect(formatAnswers(questions, [{ choices: ['Luxon'] }, { choices: ['web', 'web'] }]).ok).toBe(false);
  });
});
