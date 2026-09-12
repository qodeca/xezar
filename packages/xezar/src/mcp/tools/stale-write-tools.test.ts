import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_STALE_VERSION_GUIDANCE } from '@qodeca/xezar-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../../runs/store.ts';
import { apiRequest } from '../../server/loopback-request.testkit.ts';
import { connectedProviderAuth } from '../../server/provider-auth.testkit.ts';
import { createApp } from '../../server/server.ts';
import type { RunManager } from '../../workflows/run.ts';
import type { ServiceDispatch } from '../service-adapter.ts';
import { runVersion } from '../stale-write.ts';
import type { McpTool, McpToolContext, McpToolResult } from '../tool.ts';
import { executionControlTool } from './execution-control.ts';
import { handoffGitTool } from './handoff-git.ts';
import { projectConfigTool } from './project-config.ts';
import { withOperationId } from './operation-id.testkit.ts';
import { taskReadsTool } from './task-reads.ts';
import { organiseWorkTool } from './work-organisation.ts';

/**
 * #250 — the MCP half of stale-write rejection: every tool action that changes a task REQUIRES the
 * version a read handed out, sends it to the route, and turns the route's refusal into D-06
 * § 4.4's answer. Driven through the real app over a real store; the engine is a recording
 * stand-in, so "the effect never ran" is observed, and the task's files are compared as BYTES.
 *
 * The route half (every route, the absent-token cockpit path, the version route itself) is pinned
 * in `server/stale-write-routes.test.ts`.
 */

const ENGINE_EFFECTS = new Set([
  'cancel',
  'finish',
  'continueRun',
  'sendMessage',
  'editTask',
  'editQueuedMessage',
  'removeQueuedMessage',
  'cancelAutoResume',
]);

let repoRoot: string;
let store: RunStore;
let app: ReturnType<typeof createApp>;
let calls: string[];
let dispatched: string[];
let service: ServiceDispatch;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'xez-stale-tools-'));
  store = RunStore.open(join(repoRoot, '.local/xezar'));
  calls = [];
  dispatched = [];
  const manager = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== 'string' || name === 'then') return undefined;
        return (...args: unknown[]) => {
          if (ENGINE_EFFECTS.has(name)) calls.push(name);
          if (name === 'isActive') return false;
          if (name === 'continueRun') return { ok: true };
          if (name === 'editQueuedMessage') return { id: String(args[1]), text: 'edited', createdAt: new Date(0).toISOString() };
          return true;
        };
      },
    },
  ) as unknown as RunManager;
  app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  // The service the tools dispatch into, recording each path in order.
  service = {
    request: (input, init) => {
      dispatched.push(`${init?.method ?? 'GET'} ${new URL(input).pathname}`);
      return app.request(input, init);
    },
  };
});

afterEach(() => {
  store.flush();
  rmSync(repoRoot, { recursive: true, force: true });
});

const ctx = (): McpToolContext =>
  ({ project: { id: 'default', name: 'default', root: repoRoot }, xezarVersion: '0.0.0-test', service }) as McpToolContext;

/** A tools/call as the service answers it: the tool's own schema first, then the tool. */
async function call(tool: McpTool, args: Record<string, unknown>): Promise<McpToolResult> {
  // Every changing action also takes an operation key (#264); this file is about the VERSION guard,
  // so the key is supplied for it and a fresh one each time.
  const parsed = tool.inputSchema.safeParse(withOperationId(tool, args));
  if (!parsed.success) {
    return { content: [{ type: 'text', text: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }], isError: true };
  }
  return tool.call(parsed.data, ctx());
}

const text = (result: McpToolResult): string => (result.content[0] as { text: string }).text;

/** What a leader does first: read the task, and keep the version its answer carries. */
async function readVersion(taskId: string): Promise<string> {
  const read = await call(taskReadsTool, { view: 'task', taskId });
  expect(read.isError, text(read)).toBeFalsy();
  return (JSON.parse(text(read)) as { version: string }).version;
}

/** A human renames the task in the cockpit: a PATCH with no token — the second path. */
async function humanRenames(id: string): Promise<void> {
  const res = await apiRequest(app, `/api/v1/runs/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'renamed by a human' }),
  });
  expect(res.status).toBe(200);
}

function onDisk(record: RunRecord) {
  store.flush();
  const worktree = record.worktreePath;
  return {
    index: readFileSync(join(store.dataDir, 'runs.json')),
    events: existsSync(join(store.dataDir, 'runs', `${record.id}.ndjson`))
      ? readFileSync(join(store.dataDir, 'runs', `${record.id}.ndjson`))
      : null,
    worktree: worktree && existsSync(worktree) ? readdirSync(worktree).map((f) => [f, readFileSync(join(worktree, f))]) : null,
  };
}

const newRun = (): RunRecord =>
  store.createRun({ title: 'the task', workflow: 'quick-task', task: 'do the thing', steps: [{ id: 's1', name: 'Step', kind: 'agent' }] });

const status = (value: RunRecord['status']) => (id: string) => void store.updateRun(id, { status: value });
const queuedWithMessage = (id: string) =>
  void store.updateRun(id, { status: 'queued', queuedMessages: [{ id: 'm1', text: 'first', createdAt: new Date(0).toISOString() }] });
const closedWithSession = (id: string) => {
  store.updateStep(id, 's1', { status: 'done', sessionId: 'sess-1' });
  store.updateRun(id, { status: 'done' });
};
const waitingWithQuestion = (id: string) => {
  store.updateStep(id, 's1', { status: 'running', sessionId: 'sess-1' });
  store.updateRun(id, { status: 'waiting' });
  store.appendEvent(id, {
    type: 'ask.requested',
    requestId: 'q1',
    questions: [{ header: 'Lib', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }],
  });
};
const withWorktree = (id: string) => {
  const worktree = join(repoRoot, '.local/xezar/worktrees', id);
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, 'keep.txt'), 'the agent’s work\n', 'utf8');
  store.updateRun(id, { status: 'done', worktreePath: worktree, branch: `xez/${id.slice(0, 8)}` });
};

interface Case {
  name: string;
  tool: McpTool;
  args: (id: string) => Record<string, unknown>;
  prepare?: (id: string) => void;
  effect?: string;
}

/** Every run-mutating MCP action that reaches a route in this world, with the state it needs. */
const CASES: Case[] = [
  { name: 'organise_work set_title', tool: organiseWorkTool, args: (runId) => ({ action: 'set_title', runId, title: 'the leader’s title' }) },
  { name: 'organise_work edit_brief', tool: organiseWorkTool, args: (runId) => ({ action: 'edit_brief', runId, task: 'a new brief' }), prepare: status('queued'), effect: 'editTask' },
  {
    name: 'organise_work edit_queued_message',
    tool: organiseWorkTool,
    args: (runId) => ({ action: 'edit_queued_message', runId, messageId: 'm1', text: 'edited' }),
    prepare: queuedWithMessage,
    effect: 'editQueuedMessage',
  },
  {
    name: 'organise_work remove_queued_message',
    tool: organiseWorkTool,
    args: (runId) => ({ action: 'remove_queued_message', runId, messageId: 'm1' }),
    prepare: queuedWithMessage,
    effect: 'removeQueuedMessage',
  },
  { name: 'organise_work pin', tool: organiseWorkTool, args: (runId) => ({ action: 'pin', runId }) },
  { name: 'organise_work unpin', tool: organiseWorkTool, args: (runId) => ({ action: 'unpin', runId }), prepare: (id) => void store.setPinned(id, true) },
  { name: 'organise_work archive', tool: organiseWorkTool, args: (runId) => ({ action: 'archive', runId }), prepare: status('done') },
  { name: 'organise_work restore', tool: organiseWorkTool, args: (runId) => ({ action: 'restore', runId }), prepare: (id) => void store.setArchived(id, true) },
  { name: 'organise_work delete', tool: organiseWorkTool, args: (runId) => ({ action: 'delete', runId }), prepare: status('done') },
  { name: 'execution_control cancel', tool: executionControlTool, args: (runId) => ({ action: 'cancel', runId }), prepare: status('running'), effect: 'cancel' },
  {
    name: 'execution_control finish',
    tool: executionControlTool,
    args: (runId) => ({ action: 'finish', runId, finishAs: 'close_session' }),
    prepare: status('waiting'),
    effect: 'finish',
  },
  {
    name: 'execution_control continue',
    tool: executionControlTool,
    args: (runId) => ({ action: 'continue', runId, text: 'go on' }),
    prepare: closedWithSession,
    effect: 'continueRun',
  },
  {
    name: 'execution_control send_message',
    tool: executionControlTool,
    args: (runId) => ({ action: 'send_message', runId, text: 'hello' }),
    prepare: status('waiting'),
    effect: 'sendMessage',
  },
  {
    name: 'execution_control answer_question',
    tool: executionControlTool,
    args: (runId) => ({ action: 'answer_question', runId, questionId: 'q1', answers: [{ choices: ['B'] }] }),
    prepare: waitingWithQuestion,
    effect: 'sendMessage',
  },
  {
    name: 'execution_control edit_queued_message',
    tool: executionControlTool,
    args: (runId) => ({ action: 'edit_queued_message', runId, messageId: 'm1', text: 'edited' }),
    prepare: queuedWithMessage,
    effect: 'editQueuedMessage',
  },
  {
    name: 'execution_control remove_queued_message',
    tool: executionControlTool,
    args: (runId) => ({ action: 'remove_queued_message', runId, messageId: 'm1' }),
    prepare: queuedWithMessage,
    effect: 'removeQueuedMessage',
  },
  {
    name: 'execution_control cancel_auto_resume',
    tool: executionControlTool,
    args: (runId) => ({ action: 'cancel_auto_resume', runId }),
    effect: 'cancelAutoResume',
  },
  { name: 'project_config remove_worktree', tool: projectConfigTool, args: (runId) => ({ action: 'remove_worktree', runId }), prepare: withWorktree },
  {
    name: 'organise_work pick_variant',
    tool: organiseWorkTool,
    args: (runId) => ({ action: 'pick_variant', groupId: `g-${runId}`, runId }),
    prepare: (id) => void store.updateRun(id, { status: 'done', groupId: `g-${id}`, variant: 'a' }),
  },
];

describe('a leader mutation based on a stale read is refused, and nothing changes (#250, N-03)', () => {
  it.each(CASES)('$name', async (c) => {
    const task = newRun();
    c.prepare?.(task.id);
    const read = await readVersion(task.id); // the leader reads the task…
    await humanRenames(task.id); // …a human changes it in the cockpit…
    const current = runVersion(store, task.id);
    expect(current).not.toBe(read);

    const before = onDisk(store.getRun(task.id)!);
    calls.length = 0;
    const result = await call(c.tool, { ...c.args(task.id), expectedVersion: read }); // …and the leader acts on its old read

    // An ordinary answer the leader reasons about (D-05), never an error to correct.
    expect(result.isError, text(result)).toBeFalsy();
    expect(JSON.parse(text(result))).toMatchObject({
      status: 'conflict',
      applied: false,
      error: 'stale_version',
      resource: { kind: 'run', id: task.id },
      currentVersion: current,
      changedSince: true,
      guidance: MCP_STALE_VERSION_GUIDANCE,
    });
    expect(calls).toEqual([]);
    expect(onDisk(store.getRun(task.id)!)).toEqual(before);
  });

  it.each(CASES)('$name goes through on a fresh read', async (c) => {
    const task = newRun();
    c.prepare?.(task.id);
    await humanRenames(task.id);
    calls.length = 0;
    const result = await call(c.tool, { ...c.args(task.id), expectedVersion: await readVersion(task.id) });
    expect(text(result)).not.toContain('stale_version');
    if (c.effect) expect(calls).toEqual([c.effect]);
  });
});

describe('a stale variant pick deletes nothing (#271)', () => {
  it('keeps the other variant, its worktree and its branch when the kept variant moved since the read', async () => {
    const winner = newRun();
    const loser = newRun();
    const groupId = `g-${winner.id}`;
    store.updateRun(winner.id, { status: 'done', groupId, variant: 'a' });
    withWorktree(loser.id);
    store.updateRun(loser.id, { groupId, variant: 'b' });
    const loserTree = store.getRun(loser.id)!.worktreePath!;
    const read = await readVersion(winner.id); // the leader reads the variant it will keep…
    await humanRenames(winner.id); // …a human changes it…
    const before = onDisk(store.getRun(loser.id)!);
    calls.length = 0;
    const result = await call(organiseWorkTool, { action: 'pick_variant', groupId, runId: winner.id, expectedVersion: read });

    expect(result.isError, text(result)).toBeFalsy();
    expect(JSON.parse(text(result))).toMatchObject({ status: 'conflict', applied: false, error: 'stale_version', resource: { kind: 'run', id: winner.id } });
    expect(calls).toEqual([]);
    expect(onDisk(store.getRun(loser.id)!)).toEqual(before);
    expect(existsSync(join(loserTree, 'keep.txt'))).toBe(true);
    expect(store.getRun(loser.id)).toMatchObject({ worktreePath: loserTree, branch: `xez/${loser.id.slice(0, 8)}` });
    expect(store.getRun(loser.id)?.archived).toBeFalsy();
  });
});

describe('a version is required, never optional, on every action that changes a task', () => {
  const REQUIRED: Array<Pick<Case, 'name' | 'tool'> & { args: Record<string, unknown> }> = [
    ...CASES.map((c) => ({ name: c.name, tool: c.tool, args: c.args('some-task') })),
    { name: 'handoff_git commit', tool: handoffGitTool, args: { action: 'commit', taskId: 'some-task', message: 'wip' } },
    { name: 'handoff_git push', tool: handoffGitTool, args: { action: 'push', taskId: 'some-task' } },
    { name: 'handoff_git create_pr', tool: handoffGitTool, args: { action: 'create_pr', taskId: 'some-task' } },
  ];

  it.each(REQUIRED)('$name without expectedVersion is refused before anything is dispatched', async ({ tool, args }) => {
    const result = await call(tool, args);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/expectedVersion/);
    expect(dispatched).toEqual([]);
  });

  it('the read-state flags and the sweeps take none: they name no task decision the version covers', async () => {
    const task = newRun();
    store.updateRun(task.id, { status: 'done', finishedAt: new Date().toISOString() });
    for (const args of [{ action: 'mark_read', runId: task.id }, { action: 'mark_unread', runId: task.id }, { action: 'mark_all_read' }]) {
      expect((await call(organiseWorkTool, args)).isError).toBeFalsy();
    }
    expect((await call(organiseWorkTool, { action: 'pin', runId: task.id, expectedVersion: 'x', title: 'no' })).isError).toBe(true);
  });
});

describe('task_read hands out the version (#250)', () => {
  it('on every view of one task, equal to the task’s own token', async () => {
    const task = newRun();
    for (const view of ['task', 'history', 'context', 'handoff'] as const) {
      const result = await call(taskReadsTool, { view, taskId: task.id });
      expect(result.isError, `${view}: ${text(result)}`).toBeFalsy();
      expect((JSON.parse(text(result)) as { version?: string }).version, view).toBe(runVersion(store, task.id));
    }
  });

  it('reads the version BEFORE the value it goes out with, so it can only be older than what was seen', async () => {
    const task = newRun();
    dispatched.length = 0;
    await call(taskReadsTool, { view: 'task', taskId: task.id });
    const version = dispatched.indexOf(`GET /api/v1/p/default/runs/${task.id}/version`);
    const record = dispatched.indexOf(`GET /api/v1/p/default/runs/${task.id}`);
    expect(version).toBeGreaterThanOrEqual(0);
    expect(record).toBeGreaterThan(version);
  });

  it('only the first answer of a walk carries one: a later history page is pinned to an older view', async () => {
    const task = newRun();
    for (let i = 0; i < 5; i++) store.appendEvent(task.id, { type: 'note', message: `step ${i}` });
    const first = JSON.parse(text(await call(taskReadsTool, { view: 'history', taskId: task.id, limit: 2 }))) as Record<string, unknown>;
    expect(first.version).toBe(runVersion(store, task.id));
    expect(typeof first.nextCursor).toBe('string');
    // A human acts between the pages: the version moves, and the older page must not vouch for it.
    await humanRenames(task.id);
    const next = JSON.parse(text(await call(taskReadsTool, { view: 'history', taskId: task.id, limit: 2, cursor: first.nextCursor }))) as Record<string, unknown>;
    expect(next).not.toHaveProperty('version');
    expect((next.events as unknown[]).length).toBeGreaterThan(0);
  });

  it('the list view carries none — a leader reads the one task it means to change', async () => {
    newRun();
    const list = JSON.parse(text(await call(taskReadsTool, { view: 'list' }))) as Record<string, unknown>;
    expect(list).not.toHaveProperty('version');
  });
});
