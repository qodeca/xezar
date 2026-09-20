import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { auditActionRecordSchema, type AuditActionRecord, type OperationAnswer } from '@qodeca/xezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectDataDir } from '../project-data-paths.ts';
import { RunStore } from '../runs/store.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { WorkspaceEventBus, createApp } from '../server/server.ts';
import { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { AUDIT_TRAIL_FILE } from './audit-trail.ts';
import { runBridge } from './bridge.ts';
import { resolveMcpTarget, startMcpService } from './index.ts';
import { LineFramer, encodeFrame, type McpToolResult } from './ipc.ts';
import { OperationReceiptStore, RECEIPT_JOURNAL_FILE } from './operation-receipts.ts';
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
  vi.restoreAllMocks();
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

// #536: known refusals must remain rejected across retries and service reopen.
// The companion controls pin non-repetition independently of receipt classification.
describe('#532 structured stale refusal through the composed MCP door', () => {
  for (const action of ['cancel', 'send_message'] as const) {
    async function scenario() {
      const c = await cockpit();
      const rec = recording(c.app);
      let handle = await startMcpService({ projectId: c.id, version: VERSION, service: rec.service, store: c.store });
      closers.push(() => handle.close());
      const client = agent(c.root);
      const runId = await queuedTask(client, `refusal-task-${action}`);
      const token = await versionOf(client, runId);
      c.store.setPinned(runId, true);
      const args = { action, runId, expectedVersion: token, operationId: `refusal-${action}`, ...(action === 'send_message' ? { text: 'must not send' } : {}) };
      const before = structuredClone(c.store.getRun(runId));
      const first = await client.call('execution_control', args);
      expect(body(first)).toMatchObject({ applied: false, error: 'stale_version' });
      expect(c.store.getRun(runId)).toEqual(before);
      c.store.setPinned(runId, false);
      const dispatches = rec.seen.filter(entry => entry.startsWith('POST')).length;
      const second = await client.call('execution_control', args);
      handle.close();
      handle = await startMcpService({ projectId: c.id, version: VERSION, service: rec.service, store: c.store });
      const third = await agent(c.root).call('execution_control', args);
      expect(third).toEqual(second);
      expect(rec.seen.filter(entry => entry.startsWith('POST'))).toHaveLength(dispatches);
      expect(c.store.getRun(runId)?.queuedMessages ?? []).toEqual([]);
      expect(c.store.getRun(runId)?.status).toBe('queued');
      return second;
    }
    it(`${action}: a rejected operation never dispatches again after state changes and reopen`, async () => { await scenario(); });
    it(`${action}: defect — applied:false must replay as rejected, not ok`, async () => {
      const answer = await scenario();
      expect(answer.structuredContent).toMatchObject({ status: 'rejected', replayed: true });
    });
  }
});

/**
 * #743 — ONE OPERATION, ONE `applied` AUDIT ROW.
 *
 * The audit trail answers "what was done to this project, and by whom" (#306 part 2), so it counts
 * operations, not calls. A replay under the same `operationId` is answered from the receipt and
 * repeats no effect — but the door used to record its audit row AFTER `idempotent(...)` returned,
 * without asking which of the two it had just been, so a leader that resent a call it had lost the
 * answer to put a second `applied` row in the trail for one operation. A reader then saw two pins,
 * two writes, two hand-offs.
 *
 * `BREAK-743-REPLAY-DOUBLE-AUDIT` is the break: with the pre-fix door in place the replay case
 * below reads three `run.pin` rows where it asks for one. The control beside it passes both ways —
 * it pins the behaviour the fix must NOT change, that a call which really runs the effect still
 * writes its one row.
 */
describe('#743 — a replayed operation writes no second audit row', () => {
  const auditRecords = (dataDir: string): AuditActionRecord[] => {
    const path = join(dataDir, AUDIT_TRAIL_FILE);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => auditActionRecordSchema.parse(JSON.parse(line)));
  };

  it('BREAK-743-REPLAY-DOUBLE-AUDIT: three calls under one operationId leave exactly one applied row', async () => {
    const c = await cockpit();
    const rec = recording(c.app);
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: rec.service, store: c.store });
    closers.push(() => handle.close());
    const client = agent(c.root);
    const runId = await queuedTask(client, 'op-replay-audit-task');

    const before = auditRecords(c.dataDir).length;
    const args = { action: 'pin', runId, expectedVersion: await versionOf(client, runId), operationId: 'op-replay-audit-0001' };
    const answers = await threeTimes(client, 'organise_work', args);

    // The effect itself happened once — the property #264 already pins, restated here so a failure
    // says which half broke.
    expect(rec.seen.filter((entry) => entry.startsWith('POST') && entry.endsWith('/pin'))).toHaveLength(1);
    expectReplay(answers, { action: 'organiseWork.pin', resultRef: { kind: 'operation', id: 'op-replay-audit-0001' } });

    const added = auditRecords(c.dataDir).slice(before);
    expect(added.map((record) => [record.action, record.outcome.status])).toEqual([['run.pin', 'applied']]);
  });

  it('control: a call that really runs the effect still writes its one applied row', async () => {
    const c = await cockpit();
    const rec = recording(c.app);
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: rec.service, store: c.store });
    closers.push(() => handle.close());
    const client = agent(c.root);
    const runId = await queuedTask(client, 'op-replay-audit-control-task');

    const before = auditRecords(c.dataDir).length;
    // Two DIFFERENT operations on the same task: two effects, two rows. This passes with and
    // without the fix — it is the behaviour the fix must leave alone.
    for (const [index, action] of (['pin', 'unpin'] as const).entries()) {
      const answer = await client.call('organise_work', {
        action,
        runId,
        expectedVersion: await versionOf(client, runId),
        operationId: `op-replay-audit-control-000${index + 1}`,
      });
      expect(answer.isError, JSON.stringify(answer)).toBeFalsy();
    }

    const added = auditRecords(c.dataDir).slice(before);
    expect(added.map((record) => [record.action, record.outcome.status])).toEqual([
      ['run.pin', 'applied'],
      ['run.unpin', 'applied'],
    ]);
  });

  /**
   * `BREAK-743-REFUSAL-AS-REPLAY` is the break the review of the first fix found: that fix read
   * every non-throwing receipt-layer answer as a replay, and a replay writes no row. But the
   * receipt layer also refuses a FIRST attempt before any effect — here by being unable to append
   * its intent to an unwritable operation journal (D-06 § 7.5). Nothing ran, no earlier call
   * recorded anything, and the pre-fix door at least warned `tool_error`; the first fix left the
   * call silent AND unrecorded. v2's `refused` is exactly "the door rejected it before any effect"
   * (spec § 3.2), so the refusal is this call's own row.
   *
   * Red on a scratch copy of the pre-fix `index.ts`: zero rows where this asks for one.
   */
  it('BREAK-743-REFUSAL-AS-REPLAY: a first attempt the receipt journal refuses writes exactly one refused row', async () => {
    const c = await cockpit();
    const rec = recording(c.app);
    const warnings: string[] = [];
    const handle = await startMcpService({
      projectId: c.id,
      version: VERSION,
      service: rec.service,
      store: c.store,
      warn: (message) => warnings.push(message),
    });
    closers.push(() => handle.close());
    // Only the OPERATION journal is unwritable — a directory where the file goes, made after the
    // store opened it with an empty history. The audit destination beside it stays writable, so
    // the refusal is recordable and "no row" can only mean the door chose not to record one.
    rmSync(join(c.dataDir, RECEIPT_JOURNAL_FILE), { force: true });
    mkdirSync(join(c.dataDir, RECEIPT_JOURNAL_FILE), { recursive: true });
    const client = agent(c.root);

    const before = auditRecords(c.dataDir).length;
    const answer = await client.call('project_config', {
      action: 'save_workflow',
      workflow: { name: 'refused-by-journal', steps: [{ id: 'work', prompt: '{{task}}' }] },
      operationId: 'op-refusal-audit-0001',
    });

    // The refusal is the receipt layer's, before any effect: the save route was never reached.
    expect(answer.structuredContent).toMatchObject({ error: 'operation_receipt_unavailable', reason: 'journal_unwritable' });
    expect(rec.seen.filter((entry) => entry === `POST /api/v1/p/${c.id}/workflows`)).toHaveLength(0);

    const added = auditRecords(c.dataDir).slice(before);
    expect(added.map((record) => [record.action, record.outcome.status, record.outcome.status === 'refused' ? record.outcome.reason : undefined])).toEqual([
      ['workflow.save', 'refused', 'receipt_journal_unwritable'],
    ]);
    // The refusal reached the trail, so the door has nothing to warn about it.
    expect(warnings.filter((line) => line.includes('audit'))).toEqual([]);
  });

  it('a changed payload under an existing operation key writes one receipt_key_conflict refusal', async () => {
    const c = await cockpit();
    const rec = recording(c.app);
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: rec.service, store: c.store });
    closers.push(() => handle.close());
    const client = agent(c.root);

    const before = auditRecords(c.dataDir).length;
    const operationId = 'op-refusal-conflict-0001';
    const first = await client.call('project_config', {
      action: 'save_workflow',
      workflow: { name: 'first-payload', steps: [{ id: 'work', prompt: '{{task}}' }] },
      operationId,
    });
    expect(first.isError, JSON.stringify(first)).toBeFalsy();

    const conflict = await client.call('project_config', {
      action: 'save_workflow',
      workflow: { name: 'changed-payload', steps: [{ id: 'work', prompt: '{{task}}' }] },
      operationId,
    });
    expect(conflict.structuredContent).toMatchObject({ error: 'operation_key_conflict' });
    // Only the first payload reached the route; the receipt layer rejected the changed one.
    expect(rec.seen.filter((entry) => entry === `POST /api/v1/p/${c.id}/workflows`)).toHaveLength(1);

    const added = auditRecords(c.dataDir).slice(before);
    expect(added.map((record) => [record.action, record.outcome.status, record.outcome.status === 'refused' ? record.outcome.reason : undefined])).toEqual([
      ['workflow.save', 'applied', undefined],
      ['workflow.save', 'refused', 'receipt_key_conflict'],
    ]);
  });

  it('a refusal the trail cannot record either is the audit-gap warning, not silence', async () => {
    const c = await cockpit();
    const rec = recording(c.app);
    const warnings: string[] = [];
    const handle = await startMcpService({
      projectId: c.id,
      version: VERSION,
      service: rec.service,
      store: c.store,
      warn: (message) => warnings.push(message),
    });
    closers.push(() => handle.close());
    // Both destinations blocked: the operation journal refuses the call, and the trail cannot
    // record the refusal. Best-effort recording then owes the reader its one warning.
    rmSync(join(c.dataDir, RECEIPT_JOURNAL_FILE), { force: true });
    mkdirSync(join(c.dataDir, RECEIPT_JOURNAL_FILE), { recursive: true });
    mkdirSync(join(c.dataDir, AUDIT_TRAIL_FILE), { recursive: true });
    const client = agent(c.root);

    const answer = await client.call('project_config', {
      action: 'save_workflow',
      workflow: { name: 'refused-and-unrecordable', steps: [{ id: 'work', prompt: '{{task}}' }] },
      operationId: 'op-refusal-gap-0001',
    });

    expect(answer.structuredContent).toMatchObject({ error: 'operation_receipt_unavailable' });
    expect(warnings.filter((line) => line.includes('audit trail'))).not.toEqual([]);
  });

  /**
   * `BREAK-743-FALLBACK-AS-REPLAY`: change the `replayed: false` fallback in `receiptAttemptOf`
   * to `{ kind: 'replayed' }` and every row below disappears. These answers are injected at the
   * receipt seam because today's composed MCP wrapper supplies no precheck that naturally returns
   * them; the rest is the real bridge, composed door, audit trail and service boundary.
   */
  it.each(['ok', 'rejected', 'not-applied'] as const)(
    'BREAK-743-FALLBACK-AS-REPLAY: %s with replayed false records one refusal and dispatches no effect',
    async (status) => {
      const c = await cockpit();
      const rec = recording(c.app);
      const answer: OperationAnswer = {
        status,
        operationId: `op-unexpected-${status}`,
        action: 'projectConfig.saveWorkflow',
        replayed: false,
        ...(status === 'ok'
          ? { resultRef: { kind: 'operation', id: `op-unexpected-${status}` } }
          : { errorCode: 'injected pre-effect answer' }),
      };
      const execute = vi.spyOn(OperationReceiptStore.prototype, 'execute').mockResolvedValueOnce(answer);
      const handle = await startMcpService({ projectId: c.id, version: VERSION, service: rec.service, store: c.store });
      closers.push(() => handle.close());
      const client = agent(c.root);

      const before = auditRecords(c.dataDir).length;
      await client.call('project_config', {
        action: 'save_workflow',
        workflow: { name: `unexpected-${status}`, steps: [{ id: 'work', prompt: '{{task}}' }] },
        operationId: `op-unexpected-${status}`,
      });

      expect(execute).toHaveBeenCalledOnce();
      expect(rec.seen.filter((entry) => entry === `POST /api/v1/p/${c.id}/workflows`)).toHaveLength(0);
      const added = auditRecords(c.dataDir).slice(before);
      expect(added.map((record) => [record.action, record.outcome.status, record.outcome.status === 'refused' ? record.outcome.reason : undefined])).toEqual([
        ['workflow.save', 'refused', 'receipt_unexpected_answer'],
      ]);
      execute.mockRestore();
    },
  );

  /**
   * Fault injection, not a naturally occurring failure: the review of the first fix injected a
   * throwing handler behind the real bridge and door, and this retains that probe for the branch
   * it exercised. The receipt layer swallows the throw into an `unverified` answer, so the door
   * cannot tell it from a replay without `DoorAttempt`. Before #743 it recorded `applied` for an
   * effect that threw — a record of work that may never have happened; now it records nothing and
   * warns `effect_failed`, and the retries under the same key run nothing at all.
   */
  it('fault injection: an effect that throws under the receipt layer records nothing and warns effect_failed', async () => {
    const c = await cockpit();
    const rec = recording(c.app);
    let calls = 0;
    const throwing: ServiceDispatch = {
      request: (input, init) => {
        const url = new URL(typeof input === 'string' ? input : String(input));
        if ((init?.method ?? 'GET') === 'POST' && url.pathname.endsWith('/workflows')) {
          calls += 1;
          return Promise.reject(new Error('injected: the save handler threw part-way'));
        }
        return rec.service.request(input, init);
      },
    };
    const warnings: string[] = [];
    const handle = await startMcpService({
      projectId: c.id,
      version: VERSION,
      service: throwing,
      store: c.store,
      warn: (message) => warnings.push(message),
    });
    closers.push(() => handle.close());
    const client = agent(c.root);

    const before = auditRecords(c.dataDir).length;
    const args = {
      action: 'save_workflow',
      workflow: { name: 'thrown-part-way', steps: [{ id: 'work', prompt: '{{task}}' }] },
      operationId: 'op-thrown-effect-0001',
    };
    await threeTimes(client, 'project_config', args);

    // The injected handler ran once: the two retries were answered from the dangling intent and
    // never reached it again — the receipt layer reconciles, it never repeats (D-06 § 9).
    expect(calls).toBe(1);
    // No `applied` row for an effect nobody can say happened, and no row at all: v2 has no honest
    // outcome for it (spec § 3.2).
    expect(auditRecords(c.dataDir).slice(before)).toEqual([]);
    expect(warnings.filter((line) => line.includes('effect_failed'))).not.toEqual([]);
  });
});
