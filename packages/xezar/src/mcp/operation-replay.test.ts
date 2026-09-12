import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectDataDir } from '../project-data-paths.ts';
import { RunStore } from '../runs/store.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { WorkspaceEventBus, createApp } from '../server/server.ts';
import { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { runBridge } from './bridge.ts';
import { resolveMcpTarget, startMcpService } from './index.ts';
import { LineFramer, encodeFrame, type McpToolResult } from './ipc.ts';
import type { ServiceDispatch } from './service-adapter.ts';
import { tools } from './tools/index.ts';

/**
 * #264 — A REPLAY RETURNS THE FIRST ANSWER AND REPEATS NO EFFECT, for every mutating tool.
 *
 * D-06 § 5.2 requires a client `operationId` on every mutating tool so that N-10 holds: a leader that
 * loses the answer to a call can send the call again and find out what happened, instead of doing it
 * twice. Before #264 only `task_create` could; `composition.test.ts` has covered that one since #101.
 * This file covers the other six, and it covers the property itself rather than the schema — the
 * registry-wide schema rule is `tools/operation-id.test.ts`.
 *
 * Each case sends the SAME arguments under the SAME key three times and asks three questions:
 *
 *   1. did the effect happen exactly ONCE? Every case picks a probe where a second effect is
 *      visible: a second queued message, a second task, a second branch, a second dispatch, a
 *      second acknowledgement, or (for `save_workflow`) a second attempt that would have been
 *      refused as a conflict rather than answered `ok`;
 *   2. is the second answer the receipt's, naming what the first call did? That is D-06 § 6's
 *      replay: the stored outcome and `resultRef`, with `replayed: true`. It is deliberately NOT a
 *      copy of the tool's own body — a receipt stores a reference, never content (§ 7.1, § 10.3);
 *   3. is the third answer byte-identical to the second? A replay that drifts is not a replay.
 *
 * The stack is the real one: the cockpit's own app, store and manager, the composed MCP service and
 * the real stdio bridge in front of it. Only two things are stood in for — the agent CLI, by the
 * bundled mock (`XEZ_DRY_RUN=1`), and the two routes that would launch an application on the host
 * machine, which the recording service answers itself so a test never opens a window.
 */

const VERSION = '9.9.9-replay';
const tempDirs: string[] = [];
const closers: Array<() => unknown> = [];
const saved = { home: process.env.XEZ_HOME, dryRun: process.env.XEZ_DRY_RUN };

// A short home under /tmp, never the per-worker sandbox: the sandbox sits under the task's TMPDIR,
// which is already past the 104-byte socket limit on macOS (D-01 E5).
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  tempDirs.push(dir);
  return dir;
};

beforeEach(() => {
  process.env.XEZ_HOME = tmp('xzh-');
  process.env.XEZ_DRY_RUN = '1';
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await Promise.resolve(close()).catch(() => undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [['XEZ_HOME', saved.home], ['XEZ_DRY_RUN', saved.dryRun]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A registered git project with the cockpit's own app, store and manager over it. */
async function cockpit(maxParallel = 0) {
  const root = tmp('xzp-');
  mkdirSync(join(root, '.xezar'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
  writeFileSync(join(root, '.gitignore'), '.local/\n', 'utf8');
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const { id } = await registerProject(root);
  const semaphore = new WorkspaceSemaphore({ initial: { maxParallel }, load: async () => ({ maxParallel, memoryLimitMb: null }) });
  const store = RunStore.open(projectDataDir(root), { keepLive: true });
  const manager = new RunManager(store, root, { semaphore });
  const contexts = new ProjectContexts({ listProjects: async () => [{ id, root, status: 'ok' }], semaphore });
  const app = createApp({
    repoRoot: root,
    store,
    manager,
    version: VERSION,
    bootProjectId: id,
    contexts,
    semaphore,
    workspaceEvents: new WorkspaceEventBus(),
    providerAuth: connectedProviderAuth(),
  });
  closers.push(() => {
    manager.dispose();
    store.flush();
    contexts.disposeAll();
  });
  return { root, id, store, app, dataDir: store.dataDir };
}

/** The two routes that would open an application on the HOST are answered here and never reach it;
 *  everything else is the cockpit's own app. Every request is recorded, so "how many times did the
 *  effect happen" is a question about this list. */
function recording(app: ServiceDispatch): { service: ServiceDispatch; seen: string[] } {
  const seen: string[] = [];
  const service: ServiceDispatch = {
    request: (input, init) => {
      const url = new URL(typeof input === 'string' ? input : String(input));
      const method = init?.method ?? 'GET';
      seen.push(`${method} ${url.pathname}`);
      if (method === 'POST' && /\/(open-in|open-in-cli)$/.test(url.pathname)) {
        return Promise.resolve(
          new Response(JSON.stringify({ opened: true, target: 'finder', path: '/somewhere' }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return app.request(input, init);
    },
  };
  return { service, seen };
}

/** The real stdio bridge with a tiny JSON-RPC client in front of it. */
function agent(root: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<number, (result: McpToolResult) => void>();
  const framer = new LineFramer(
    (line) => {
      const message = JSON.parse(line) as { id: number; result: McpToolResult };
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    },
    () => {},
  );
  output.on('data', (chunk: Buffer) => framer.push(chunk));
  const done = runBridge({ input, output, version: VERSION, tools, resolveTarget: () => resolveMcpTarget(root) });
  closers.push(() => {
    input.end();
    return done;
  });
  let next = 1;
  return {
    call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
      const id = next++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        input.write(encodeFrame({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }));
      });
    },
  };
}

type Client = ReturnType<typeof agent>;

const body = (result: McpToolResult): Record<string, any> => JSON.parse((result.content[0] as { text: string }).text);

/**
 * Send one call three times under one key: the real attempt, the replay a leader makes after it
 * loses the answer, and a third that proves the replay does not drift. Returns all three.
 */
async function threeTimes(client: Client, tool: string, args: Record<string, unknown>) {
  const first = await client.call(tool, args);
  const second = await client.call(tool, args);
  const third = await client.call(tool, args);
  return { first, second, third };
}

/** What every replay must look like: the receipt's own answer, naming the first call's outcome. */
function expectReplay(
  answers: { first: McpToolResult; second: McpToolResult; third: McpToolResult },
  expected: { action: string; resultRef?: { kind: string; id: string } },
): void {
  expect(answers.first.isError, JSON.stringify(answers.first)).toBeFalsy();
  expect(answers.second.isError, JSON.stringify(answers.second)).toBeFalsy();
  expect(answers.second.structuredContent).toMatchObject({
    status: 'ok',
    replayed: true,
    action: expected.action,
    ...(expected.resultRef ? { resultRef: expected.resultRef } : {}),
  });
  // A replay is stable: the third answer is the second, to the byte.
  expect(answers.third).toEqual(answers.second);
}

/** Wait for something the engine reaches on its own — bounded, never an unbounded poll. */
async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Start one task and leave it queued (`maxParallel: 0`), so only the calls under test move it. */
async function queuedTask(client: Client, operationId: string, prompt = 'a brief'): Promise<string> {
  const started = await client.call('task_create', { action: 'start', operationId, prompt });
  expect(started.isError, JSON.stringify(started)).toBeFalsy();
  return (started.structuredContent as { subject: { id: string } }).subject.id;
}

const versionOf = async (client: Client, taskId: string): Promise<string> =>
  body(await client.call('task_read', { view: 'task', taskId })).version as string;

describe('#264 — a replay under the same operationId returns the first answer and repeats no effect', () => {
  it('execution_control: a resent message is queued ONCE, and the resend answers with the first call’s receipt', async () => {
    const c = await cockpit();
    const rec = recording(c.app);
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: rec.service, store: c.store });
    closers.push(() => handle.close());
    const client = agent(c.root);
    const runId = await queuedTask(client, 'op-replay-ec-task');

    const args = {
      action: 'send_message',
      runId,
      text: 'the one message',
      expectedVersion: await versionOf(client, runId),
      operationId: 'op-replay-ec-0001',
    };
    const answers = await threeTimes(client, 'execution_control', args);

    // The decisive probe: a repeated effect would be a SECOND queued message on the task.
    expect(c.store.getRun(runId)?.queuedMessages?.map((message) => message.text)).toEqual(['the one message']);
    expect(rec.seen.filter((entry) => entry.startsWith('POST') && entry.endsWith('/messages'))).toHaveLength(1);
    expectReplay(answers, { action: 'executionControl.sendMessage', resultRef: { kind: 'run', id: runId } });
    // The first answer is the tool's own body; only the resends are the receipt's (D-06 § 6).
    expect(body(answers.first)).toMatchObject({ action: 'send_message', accepted: true, subject: { type: 'run', id: runId } });
  });

  it('organise_work: a resent rename is applied ONCE, even though the version it carries went stale', async () => {
    const c = await cockpit();
    const rec = recording(c.app);
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: rec.service, store: c.store });
    closers.push(() => handle.close());
    const client = agent(c.root);
    const runId = await queuedTask(client, 'op-replay-ow-task');

    const args = {
      action: 'set_title',
      runId,
      title: 'the leader’s title',
      expectedVersion: await versionOf(client, runId),
      operationId: 'op-replay-ow-0001',
    };
    const answers = await threeTimes(client, 'organise_work', args);

    expect(c.store.getRun(runId)?.title).toBe('the leader’s title');
    expect(rec.seen.filter((entry) => entry.startsWith('PATCH'))).toHaveLength(1);
    // The rename moved the task's version, so a resend that reached the route would now be refused
    // as a stale write (#250). It answers `ok` instead, which is what proves the receipt answered
    // BEFORE the effect was reconsidered — the leader learns what happened, not why it may not.
    // No `subject` in this tool's answer, so the receipt refers to the OPERATION rather than to the
    // run (D-06 § 7.1: a reference, never content). Either way the leader learns the outcome.
    expectReplay(answers, { action: 'organiseWork.setTitle', resultRef: { kind: 'operation', id: 'op-replay-ow-0001' } });
  });

  it('project_config: a resent save_workflow answers ok, where a real second save would be a conflict', async () => {
    const c = await cockpit();
    const rec = recording(c.app);
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: rec.service, store: c.store });
    closers.push(() => handle.close());
    const client = agent(c.root);

    const args = {
      action: 'save_workflow',
      workflow: { name: 'from-leader', steps: [{ id: 'work', prompt: '{{task}}' }] },
      operationId: 'op-replay-pc-0001',
    };
    const answers = await threeTimes(client, 'project_config', args);

    expect(rec.seen.filter((entry) => entry === `POST /api/v1/p/${c.id}/workflows`)).toHaveLength(1);
    expectReplay(answers, { action: 'projectConfig.saveWorkflow' });
    // The proof that no second save was attempted: without `overwrite` the route refuses an existing
    // workflow, so a repeated effect would have come back as a conflict rather than as `ok`.
    const conflict = await client.call('project_config', { ...args, operationId: 'op-replay-pc-0002' });
    expect(conflict.structuredContent).toMatchObject({ action: 'save_workflow', status: 409, exists: true });
  });

  it('handoff_git: a resent branch creation runs ONCE, and the resend does not fail on the branch it made', async () => {
    const c = await cockpit();
    const rec = recording(c.app);
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: rec.service, store: c.store });
    closers.push(() => handle.close());
    const client = agent(c.root);

    const args = { action: 'branch', name: 'leader-branch', from: 'main', operationId: 'op-replay-hg-0001' };
    const answers = await threeTimes(client, 'handoff_git', args);

    expect(rec.seen.filter((entry) => entry.startsWith('POST') && entry.endsWith('/repo/branch'))).toHaveLength(1);
    expect(execFileSync('git', ['-C', c.root, 'branch', '--list', 'leader-branch'], { encoding: 'utf8' })).toContain('leader-branch');
    expectReplay(answers, { action: 'handoffGit.branch' });
  });

  it('local_handoff: a resent open dispatches ONCE, so a lost answer never opens two windows', async () => {
    const c = await cockpit();
    const rec = recording(c.app);
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: rec.service, store: c.store });
    closers.push(() => handle.close());
    const client = agent(c.root);

    const args = { action: 'open_project_in_app', target: 'finder', operationId: 'op-replay-lh-0001' };
    const answers = await threeTimes(client, 'local_handoff', args);

    expect(rec.seen.filter((entry) => entry.startsWith('POST') && entry.endsWith('/open-in'))).toHaveLength(1);
    expectReplay(answers, { action: 'localHandoff.openProjectInApp' });
  });

  it('leader_events: a resent ack is one acknowledgement, and the resend is the receipt, not a second ack', async () => {
    const c = await cockpit();
    const rec = recording(c.app);
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: rec.service, store: c.store });
    closers.push(() => handle.close());
    const client = agent(c.root);
    // One row to acknowledge: a person changes the project's base branch in the cockpit (E-05).
    const changed = await c.app.request(`/api/v1/p/${c.id}/config`, {
      method: 'PUT',
      headers: { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321', 'content-type': 'application/json' },
      body: JSON.stringify({ baseBranch: 'develop' }),
    });
    expect(changed.status).toBe(200);
    const read = await until('an outstanding event to acknowledge', async () => {
      const answer = (await client.call('leader_events', { action: 'read' })).structuredContent as Record<string, any>;
      return answer.status === 'ok' && (answer.events as unknown[]).length > 0 ? answer : undefined;
    });

    const args = { action: 'ack', cursor: read.nextCursor as string, operationId: 'op-replay-le-0001' };
    const answers = await threeTimes(client, 'leader_events', args);

    expect(answers.first.structuredContent).toMatchObject({ status: 'acked' });
    expectReplay(answers, { action: 'leaderEvents.ack' });
    // The position is where the one acknowledgement put it, and reading again returns nothing new.
    expect((await client.call('leader_events', { action: 'read' })).structuredContent).toMatchObject({ events: [] });
  });
});
