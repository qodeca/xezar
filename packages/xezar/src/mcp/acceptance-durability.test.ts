import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MCP_STALE_VERSION_GUIDANCE } from '@qodeca/xezar-contract';

import { assertIsolated, createAbWorld, leaked, resultText, snapshotChanges, type AbWorld } from '../../test/helpers/ab-fixture.ts';
import { projectDataDir } from '../project-data-paths.ts';
import { RunStore } from '../runs/store.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { WorkspaceEventBus, createApp } from '../server/server.ts';
import { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { runBridge } from './bridge.ts';
import { EventCatalog } from './event-catalog.ts';
import { EventJournal } from './event-journal.ts';
import { resolveMcpTarget, startMcpService } from './index.ts';
import { LineFramer, encodeFrame, type McpToolResult } from './ipc.ts';
import { OperationReceiptStore } from './operation-receipts.ts';
import { LeaderCursors, LeaderFeed, LeaderInbox, reactionOperationId, runStateReader, type LeaderDelivery } from './reconnect.ts';
import { listenMcpSocket } from './service.ts';
import { McpServiceAdapter, type ServiceDispatch } from './service-adapter.ts';
import { guardedRunMutation, runVersion } from './stale-write.ts';
import type { McpToolContext } from './tool.ts';
import { QUALITY_BLOCKER_NEXT_ACTION, handoffGitTool } from './tools/handoff-git.ts';
import { tools } from './tools/index.ts';

/**
 * #117 — the correctness and durability suite, whole-feature half: A-13, A-14, A-15, A-16, A-21 and
 * A-22 judged in the shared A/B world (#115, `test/helpers/ab-fixture.ts`). The human acts through
 * the cockpit's own door (`world.cockpit`), the leader through A's MCP socket (`world.call`) and the
 * in-process service every wired tool dispatches through (`world.service`), with XEZ_DRY_RUN=1 and
 * no account or secret. The store-level half is `test/unit/mcp-durability.test.ts`; the packed-CLI
 * upgrade half of A-16 is `test/e2e/mcp-upgrade.test.ts`.
 *
 * THE TOOL-LEVEL HALVES. A-13, A-14, A-15 and A-21 each have a second half that runs through the
 * REAL composed MCP service (#243): `startMcpService` over the cockpit's own app, store and run
 * manager, reached through the real `runBridge` over the project socket — the version on every read
 * and `expectedVersion` on every run write (#250), a receipt for every `operationId` (#101, in the
 * door), the journal and catalog (#103, #104) and `leader_events` (#251). The A/B world's sockets
 * are bare `listenMcpSocket`s with none of those parts, so these halves build the world
 * `composition.test.ts` builds instead. They were `it.todo` (BLOCKED) in #117's first delivery,
 * before the composition landed.
 */

const PROJECT_A = 'alpha-proj';

let world: AbWorld | undefined;
const opened: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const handle of opened.splice(0).reverse()) handle.close();
  await world?.dispose();
  world = undefined;
});

async function openWorld(): Promise<AbWorld> {
  world = await createAbWorld();
  return world;
}

/** Wait for a condition the real engine reaches on its own — bounded, never a leader poll. */
async function until(what: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const json = async (response: Response): Promise<unknown> => response.json();

/** The cockpit's own "New task" request, same-origin, into A. */
async function humanCreatesTask(w: AbWorld, task: string): Promise<string> {
  const res = await w.cockpit(`/api/v1/p/${PROJECT_A}/runs`, 'POST', { task, workflow: 'quick-task', worktree: false });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return ((await json(res)) as { id: string }).id;
}

// ---- the composed service (#243, #250, #251) -----------------------------------------------------

const COMPOSED_VERSION = '0.0.0-117';
const composedDirs: string[] = [];
const composedClosers: Array<() => unknown> = [];
const savedEnv = { home: process.env.XEZ_HOME, dryRun: process.env.XEZ_DRY_RUN };

afterEach(async () => {
  for (const close of composedClosers.splice(0).reverse()) {
    try {
      await close();
    } catch {
      // A part the case already closed on purpose (a service restart).
    }
  }
  for (const dir of composedDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [['XEZ_HOME', savedEnv.home], ['XEZ_DRY_RUN', savedEnv.dryRun]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// A short directory under /tmp, never the per-worker sandbox: that sits under the task's TMPDIR,
// already past the 104-byte socket-path limit on macOS (D-01 E5).
function shortTmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  composedDirs.push(dir);
  return dir;
}

/** A registered project with the cockpit's own app, store and run manager over it. */
async function composedCockpit(maxParallel: number) {
  process.env.XEZ_HOME = shortTmp('x117h-');
  process.env.XEZ_DRY_RUN = '1';
  const root = shortTmp('x117p-');
  mkdirSync(join(root, '.xezar'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
  const { id } = await registerProject(root);
  const semaphore = new WorkspaceSemaphore({ initial: { maxParallel }, load: async () => ({ maxParallel, memoryLimitMb: null }) });
  const store = RunStore.open(projectDataDir(root), { keepLive: true });
  const manager = new RunManager(store, root, { semaphore });
  const contexts = new ProjectContexts({ listProjects: async () => [{ id, root, status: 'ok' }], semaphore });
  const app = createApp({
    repoRoot: root,
    store,
    manager,
    version: COMPOSED_VERSION,
    bootProjectId: id,
    contexts,
    semaphore,
    workspaceEvents: new WorkspaceEventBus(),
    providerAuth: connectedProviderAuth(),
  });
  composedClosers.push(() => {
    manager.dispose();
    store.flush();
    contexts.disposeAll();
  });
  /** A person at the cockpit: the routes the browser calls, scoped to this project. */
  const human = (method: string, path: string, body?: unknown): Promise<Response> =>
    apiRequest(app as unknown as Hono, `/api/v1/p/${id}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { root, id, store, human, dataDir: store.dataDir, app };
}
type ComposedCockpit = Awaited<ReturnType<typeof composedCockpit>>;

/** `startMcpService` exactly as `xezar serve` calls it, with an idempotent close for restarts. */
async function serveComposed(c: ComposedCockpit): Promise<{ close(): void }> {
  const handle = await startMcpService({ projectId: c.id, version: COMPOSED_VERSION, service: c.app, store: c.store, warn: () => {} });
  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    handle.close();
  };
  composedClosers.push(close);
  return { close };
}

/** The real stdio bridge, with a tiny JSON-RPC client in front of it — a coding agent's view. */
function leaderClient(root: string) {
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
  const done = runBridge({ input, output, version: COMPOSED_VERSION, tools, resolveTarget: () => resolveMcpTarget(root) });
  composedClosers.push(() => {
    input.end();
    return done;
  });
  let next = 1;
  return {
    call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
      const rid = next++;
      return new Promise((resolve) => {
        pending.set(rid, resolve);
        input.write(encodeFrame({ jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name, arguments: args } }));
      });
    },
  };
}
type Leader = ReturnType<typeof leaderClient>;

const bodyOf = (result: McpToolResult): Record<string, unknown> =>
  JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
const isStale = (result: McpToolResult): boolean => {
  try {
    return !result.isError && bodyOf(result).error === 'stale_version';
  } catch {
    return false;
  }
};

/** What a leader does first: read the one task it means to change, and keep the version. */
async function taskVersion(leader: Leader, runId: string): Promise<string> {
  const read = await leader.call('task_read', { view: 'task', taskId: runId });
  expect(read.isError, JSON.stringify(read)).toBeFalsy();
  const version = bodyOf(read).version;
  expect(typeof version).toBe('string');
  return version as string;
}

/** The task's stored record as BYTES: the run index and the task's own event log. */
function storedBytes(c: ComposedCockpit, runId: string): { index: Buffer; events: Buffer | null } {
  c.store.flush();
  const events = join(c.dataDir, 'runs', `${runId}.ndjson`);
  return { index: readFileSync(join(c.dataDir, 'runs.json')), events: existsSync(events) ? readFileSync(events) : null };
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}

async function humanStarts(c: ComposedCockpit, task: string): Promise<string> {
  const res = await c.human('POST', '/runs', { task, workflow: 'quick-task', worktree: false });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return ((await res.json()) as { id: string }).id;
}

interface LeaderEvent {
  eventId: string;
  kind: string;
  journalSeq: number;
  origin: string;
  subject: { id: string };
  standing: string;
}
interface LeaderTaskState {
  id: string;
  status: string | null;
}
interface LeaderRead {
  status: 'ok';
  events: LeaderEvent[];
  nextCursor: string;
  hasMore: boolean;
  state: { tasks: LeaderTaskState[] };
  position: { deliveredSeq: number; ackedSeq: number };
  journalEpoch: string;
}
interface LeaderGap {
  status: 'gap';
  gap: { resumeCursor: string; recovery: { required: string; message: string } };
  state: { tasks: LeaderTaskState[]; complete: boolean };
}

async function leaderRead<T = LeaderRead>(leader: Leader, args: Record<string, unknown> = {}): Promise<T> {
  const result = await leader.call('leader_events', { action: 'read', ...args });
  expect(result.isError, JSON.stringify(result)).toBeFalsy();
  return result.structuredContent as T;
}

async function leaderAck(leader: Leader, cursor: string): Promise<{ status: string; ackedSeq: number }> {
  const result = await leader.call('leader_events', { action: 'ack', cursor });
  expect(result.isError, JSON.stringify(result)).toBeFalsy();
  return result.structuredContent as { status: string; ackedSeq: number };
}

/** The rows the catalog actually wrote, straight from the journal file on disk. */
function journalRowsOnDisk(dataDir: string): Array<{ kind: string; subject: { id: string } }> {
  const path = join(dataDir, 'mcp', 'event-journal.ndjson');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; subject: { id: string } });
}

// ---- A-13 ----------------------------------------------------------------------------------------

describe('A-13 — a human changed a resource after the leader read it (N-03)', () => {
  it("rejects the stale leader write with nothing applied: A's state is byte-identical and B is untouched", async () => {
    const w = await openWorld();
    const id = w.a.ids.queued;
    // The leader reads the task over MCP, and holds the version that read corresponds to.
    const read = await w.call('a', 'task_read', { view: 'task', taskId: id });
    expect(read.isError ?? false).toBe(false);
    const leaderVersion = runVersion(w.a.store, id);

    // The human renames the task in the cockpit. (A brief edit goes through the run manager's own
    // queue, which the seeded tasks are not in; the title is in the decision projection too.)
    const edited = await w.cockpit(`/api/v1/p/${PROJECT_A}/runs/${id}`, 'PATCH', { title: 'the title the HUMAN wrote' });
    expect(edited.status).toBe(200);
    w.a.store.flush();

    const seen = await w.observe(() => {
      const beforeA = w.snapshot('a');
      let effects = 0;
      const result = guardedRunMutation(w.a.store, id, leaderVersion, () => {
        effects += 1;
        return w.a.store.updateRun(id, { title: 'the title the LEADER wanted' });
      });
      return { result, effects, beforeA, afterA: w.snapshot('a') };
    });
    const { result, effects, beforeA, afterA } = seen.response;
    expect(result).toMatchObject({ status: 'conflict', applied: false, error: 'stale_version', guidance: MCP_STALE_VERSION_GUIDANCE });
    expect(effects).toBe(0);
    expect(snapshotChanges(beforeA, afterA)).toEqual([]);
    expect(afterA).toBe(beforeA);
    assertIsolated(w, seen);

    // What the human sees is the human's title, through the cockpit and through MCP alike.
    const current = (await json(await w.cockpit(`/api/v1/p/${PROJECT_A}/runs/${id}`))) as { title: string };
    expect(current.title).toBe('the title the HUMAN wrote');
    expect(resultText(await w.call('a', 'task_read', { view: 'task', taskId: id }))).toContain('the title the HUMAN wrote');

    // The leader decides again only after a fresh read.
    const decided = guardedRunMutation(w.a.store, id, runVersion(w.a.store, id), () =>
      w.a.store.updateRun(id, { title: 'the leader, after reading the human title' }),
    );
    expect(decided.status).toBe('done');
  });

  it('concurrent leader calls racing a human cockpit edit: the human edit stands, at most one leader call applies', async () => {
    const w = await openWorld();
    const id = w.a.ids.queued2;
    const leaderVersion = runVersion(w.a.store, id);
    let effects = 0;
    const leaderCall = (n: number) =>
      Promise.resolve().then(() =>
        guardedRunMutation(w.a.store, id, leaderVersion, () => {
          effects += 1;
          return w.a.store.updateRun(id, { title: `leader call ${n}` });
        }),
      );
    const [human, ...leader] = await Promise.all([
      w.cockpit(`/api/v1/p/${PROJECT_A}/runs/${id}`, 'PATCH', { title: 'the human title' }),
      ...Array.from({ length: 6 }, (_, n) => leaderCall(n)),
    ]);
    expect(human.status).toBe(200);
    expect(leader.filter((r) => r.status === 'done').length).toBeLessThanOrEqual(1);
    expect(effects).toBeLessThanOrEqual(1);
    expect(leader.filter((r) => r.status === 'conflict').length).toBeGreaterThanOrEqual(5);
    expect(w.a.store.getRun(id)?.title).toBe('the human title');
    // Any leader write that did land was based on the pre-edit read, so it is now stale as well.
    expect(guardedRunMutation(w.a.store, id, leaderVersion, () => undefined).status).toBe('conflict');
  });

  it("through the composed MCP service: a read version a human has since moved is refused on every write tool, the stored record stays byte-identical, and only a fresh read decides again", async () => {
    // No free slot: the task stays queued, so only the two writers below can move it.
    const c = await composedCockpit(0);
    await serveComposed(c);
    const leader = leaderClient(c.root);
    const started = await leader.call('task_create', { action: 'start', operationId: 'op-117-a13-start', prompt: 'the first brief' });
    expect(started.isError, JSON.stringify(started)).toBeFalsy();
    const runId = (started.structuredContent as { subject: { id: string } }).subject.id;

    // 1. The leader reads the task, and keeps the version its answer carries.
    const leaderRead = await taskVersion(leader, runId);
    expect(leaderRead).toBe(runVersion(c.store, runId));

    // 2. The second path moves it: a human renames the task in the cockpit, sending no token at all.
    expect((await c.human('PATCH', `/runs/${runId}`, { title: 'the title the HUMAN wrote' })).status).toBe(200);
    const humanVersion = runVersion(c.store, runId);
    expect(humanVersion).not.toBe(leaderRead);
    const humanBytes = storedBytes(c, runId);
    const humanRecord = JSON.stringify(c.store.getRun(runId));

    // 3. The leader acts on its old read, through every tool that could change this task.
    const attempts = [
      await leader.call('organise_work', { action: 'set_title', runId, title: 'the title the LEADER wanted', expectedVersion: leaderRead }),
      await leader.call('organise_work', { action: 'edit_brief', runId, task: 'the leader brief', expectedVersion: leaderRead }),
      await leader.call('execution_control', { action: 'send_message', runId, text: 'and this', expectedVersion: leaderRead }),
      await leader.call('execution_control', { action: 'cancel', runId, expectedVersion: leaderRead }),
    ];
    for (const attempt of attempts) {
      expect(attempt.isError, JSON.stringify(attempt)).toBeFalsy();
      expect(bodyOf(attempt)).toMatchObject({
        status: 'conflict',
        applied: false,
        error: 'stale_version',
        resource: { kind: 'run', id: runId },
        currentVersion: humanVersion,
        changedSince: true,
        guidance: MCP_STALE_VERSION_GUIDANCE,
      });
    }
    // Compared, not asserted: what is stored now is the very bytes the human left.
    const after = storedBytes(c, runId);
    expect(sameBytes(after.index, humanBytes.index), 'runs.json is byte-identical').toBe(true);
    expect(sameBytes(after.events, humanBytes.events), "the task's event log is byte-identical").toBe(true);
    expect(JSON.stringify(c.store.getRun(runId))).toBe(humanRecord);
    expect(runVersion(c.store, runId)).toBe(humanVersion);

    // 4. Concurrent leader calls on one fresh read: exactly one applies, every other is refused as stale.
    const fresh = await taskVersion(leader, runId);
    const racing = await Promise.all(
      Array.from({ length: 6 }, (_, n) => leader.call('organise_work', { action: 'set_title', runId, title: `leader call ${n}`, expectedVersion: fresh })),
    );
    const bodies = racing.map(bodyOf);
    expect(bodies.filter((body) => body.status === 'done'), JSON.stringify(bodies)).toHaveLength(1);
    expect(bodies.filter((body) => body.status === 'conflict' && body.error === 'stale_version')).toHaveLength(5);
    const winner = bodies.find((body) => body.status === 'done') as { run: { title: string } };
    expect(c.store.getRun(runId)?.title).toBe(winner.run.title);
  });

  it('through the composed MCP service: a RUNNING task — a stale cancel is refused and the task keeps running; the leader re-reads and retries until its cancel lands (the #250 contract)', async () => {
    const c = await composedCockpit(2);
    await serveComposed(c);
    const leader = leaderClient(c.root);
    const runId = await humanStarts(c, 'mock:slow a task the leader will cancel');
    await until('the task to run', () => c.store.getRun(runId)?.status === 'running');

    // A cancel decided on a read that a human has since overtaken is refused, and nothing stops.
    const stale = await taskVersion(leader, runId);
    expect((await c.human('PATCH', `/runs/${runId}`, { title: 'renamed while it runs' })).status).toBe(200);
    const refused = await leader.call('execution_control', { action: 'cancel', runId, expectedVersion: stale });
    expect(bodyOf(refused)).toMatchObject({ status: 'conflict', applied: false, error: 'stale_version' });
    expect(c.store.getRun(runId)?.status).toBe('running');

    // Re-read, then retry. A running task's version also moves with every agent event, so a cancel
    // can be refused as stale between the read and the call: that is the accepted #250 contract, not
    // a defect, and the answer is to read again. The bound is only this test's, not a product limit.
    let landed: McpToolResult | undefined;
    let staleRetries = 0;
    for (let attempt = 0; attempt < 10 && landed === undefined; attempt++) {
      const result = await leader.call('execution_control', { action: 'cancel', runId, expectedVersion: await taskVersion(leader, runId) });
      if (isStale(result)) staleRetries += 1;
      else landed = result;
    }
    expect(landed, `still refused as stale after ${staleRetries} fresh reads`).toBeDefined();
    expect(landed!.isError, JSON.stringify(landed)).toBeFalsy();
    await until('the task to stop', () => c.store.getRun(runId)?.status === 'cancelled', 30_000);
  }, 60_000);
});

// ---- A-14 ----------------------------------------------------------------------------------------

describe('A-14 — a mutation executed but its response lost (N-10)', () => {
  it("one key through the cockpit's create route: EXACTLY ONE task for a repeated key, TWO for two keys", async () => {
    const w = await openWorld();
    const receipts = OperationReceiptStore.open(w.a.dataDir);
    // The same in-process door `task_create` starts a task through (#89), scoped to A.
    const adapter = new McpServiceAdapter({ projectId: PROJECT_A, service: w.service });
    const title = 'mock:done idempotent create';
    let effects = 0;
    const create = (operationId: string) =>
      receipts.execute({
        projectId: PROJECT_A,
        operationId,
        action: 'runs.create',
        payload: { task: title },
        reconcile: { kind: 'none' },
        // The effect is the cockpit's own route, reached through the same in-process door as every tool.
        effect: async () => {
          effects += 1;
          const started = await adapter.startRun({ task: title, workflow: 'quick-task', worktree: false });
          if (!started.ok) return { outcome: 'rejected', errorCode: `http_${started.status}` };
          return { outcome: 'ok', resultRef: { kind: 'run', id: (started.value as { id: string }).id } };
        },
      });
    const tasks = () => w.a.store.listRuns().filter((run) => run.task === title);

    const first = await create('op-117-lost-response');
    expect(first).toMatchObject({ status: 'ok', replayed: false });
    // The response was lost; the leader retries with the same key — twice, and once after a restart.
    expect(await create('op-117-lost-response')).toEqual({ ...first, replayed: true });
    receipts.close();
    const reopened = OperationReceiptStore.open(w.a.dataDir);
    const replay = await reopened.execute({
      projectId: PROJECT_A,
      operationId: 'op-117-lost-response',
      action: 'runs.create',
      payload: { task: title },
      reconcile: { kind: 'none' },
      effect: () => {
        effects += 1;
        return { outcome: 'ok', resultRef: { kind: 'run', id: 'must-not-happen' } };
      },
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(effects).toBe(1);
    expect(tasks()).toHaveLength(1);

    // Deliberately new identical work takes a new key, and is a second task.
    const second = await create('op-117-deliberately-new');
    expect(second).toMatchObject({ status: 'ok', replayed: false });
    expect(effects).toBe(2);
    expect(tasks()).toHaveLength(2);
    reopened.close();
  });

  it('through the composed MCP service: a repeated key is EXACTLY ONE task, also after the service restarts; a new key is TWO; a key reused for other work is refused', async () => {
    // No free slot: every task stays queued, so the count is the count of effects.
    const c = await composedCockpit(0);
    const first = await serveComposed(c);
    const leader = leaderClient(c.root);
    const prompt = 'mock:done one piece of work, created over MCP';
    const args = { action: 'start', operationId: 'op-117-a14-key-1', prompt };
    const tasks = () => c.store.listRuns().filter((run) => run.task === prompt);

    const created = await leader.call('task_create', args);
    expect(created.isError, JSON.stringify(created)).toBeFalsy();
    const runId = (created.structuredContent as { subject: { id: string } }).subject.id;
    // The response was lost: the leader retries under the same key.
    expect((await leader.call('task_create', args)).structuredContent).toMatchObject({ status: 'ok', replayed: true, resultRef: { kind: 'run', id: runId } });
    expect(tasks()).toHaveLength(1);

    // The service restarts between the call and the retry: the receipt survives it.
    first.close();
    await serveComposed(c);
    const afterRestart = leaderClient(c.root);
    expect((await afterRestart.call('task_create', args)).structuredContent).toMatchObject({ status: 'ok', replayed: true, resultRef: { kind: 'run', id: runId } });
    expect(tasks()).toHaveLength(1);

    // A collision: the same key for different work is refused, with no effect.
    const collision = await afterRestart.call('task_create', { ...args, prompt: `${prompt}, but different` });
    expect(collision.isError).toBe(true);
    expect(collision.structuredContent).toMatchObject({ error: 'operation_key_conflict', mismatch: 'payload' });
    expect(c.store.listRuns()).toHaveLength(1);

    // Deliberately new identical work takes a new key, and is a second task.
    const second = await afterRestart.call('task_create', { ...args, operationId: 'op-117-a14-key-2' });
    expect(second.isError, JSON.stringify(second)).toBeFalsy();
    expect(tasks()).toHaveLength(2);
  });

  it('through the composed MCP service: a crash between the effect and its receipt answers an explicit UNVERIFIED on retry, and the effect is never repeated', async () => {
    const c = await composedCockpit(0);
    const prompt = 'mock:done created just before the crash';
    const args = { action: 'start', operationId: 'op-117-a14-crash', prompt };
    const tasks = () => c.store.listRuns().filter((run) => run.task === prompt);

    // The process that crashed: its receipt store wrote the intent under the door's own action id,
    // ran the effect (a real task, through the cockpit's route) and died before the settled line —
    // exactly what a SIGKILL leaves behind (the real SIGKILL is `test/unit/mcp-durability.test.ts`).
    const crashed = OperationReceiptStore.open(c.dataDir);
    void crashed.execute({
      projectId: c.id,
      operationId: args.operationId,
      action: 'taskCreate.start',
      payload: args,
      reconcile: { kind: 'none' },
      effect: async () => {
        await humanStarts(c, prompt);
        return new Promise(() => {}); // never settles: the process is gone
      },
    });
    await until('the effect before the crash', () => tasks().length === 1);

    // The service comes back, and the leader retries the key it never got an answer for.
    await serveComposed(c);
    const leader = leaderClient(c.root);
    for (let retry = 0; retry < 2; retry++) {
      const answer = await leader.call('task_create', args);
      expect(answer.structuredContent, JSON.stringify(answer)).toMatchObject({ status: 'unverified', operationId: args.operationId });
      expect(tasks(), 'the effect is never run a second time for the key').toHaveLength(1);
    }
  });
});

// ---- A-15 ----------------------------------------------------------------------------------------

describe('A-15 — a task completes while the client is offline (F-19–F-21, N-05, N-06, N-10)', () => {
  it('the task and its result survive; reconnect delivers the outstanding event and the current state; nothing polls; a replay repeats no effect', async () => {
    const w = await openWorld();
    // The project half, attached where the project opens — never by a leader connection (N-05).
    const catalog = EventCatalog.attach({ journal: w.a.journal, store: w.a.store, warn: () => {} });
    opened.push({ close: () => catalog.detach() });
    const cursors = LeaderCursors.open({ dataDir: w.a.dataDir, projectId: PROJECT_A, journal: w.a.journal, warn: () => {} });
    const wakes: LeaderDelivery[] = [];
    const feed = new LeaderFeed({ journal: w.a.journal, cursors, readState: runStateReader(w.a.store, w.a.journal), wake: (d) => wakes.push(d) });

    const timers = { setInterval: vi.spyOn(globalThis, 'setInterval'), setTimeout: vi.spyOn(globalThis, 'setTimeout') };
    const first = feed.connect();
    feed.disconnect();
    const leaderTimers = timers.setInterval.mock.calls.length + timers.setTimeout.mock.calls.length;
    timers.setInterval.mockRestore();
    timers.setTimeout.mockRestore();
    expect(leaderTimers, 'the leader side starts no timer: no status poll, no heartbeat').toBe(0);
    expect(first.status).toBe('ok');

    // Offline: the human starts a task, and the real RunManager runs it to the end.
    const runsBefore = w.a.store.listRuns().length;
    const id = await humanCreatesTask(w, 'mock:done completed while the leader was away');
    await until('the task to finish', () => w.a.store.getRun(id)?.status === 'done');
    await until('its significant event', () => {
      const page = w.a.journal.read({ limit: 100 });
      return page.status === 'ok' && page.events.some((row) => row.subject.id === id && row.kind === 'task.done');
    });
    expect(wakes, 'nobody was woken while the leader was offline').toEqual([]);
    expect(w.a.store.listRuns().length, 'no run was created for the leader — it holds no slot').toBe(runsBefore + 1);

    // Reconnect: the outstanding event plus the current, authoritative state.
    const back = feed.connect();
    opened.push({ close: () => feed.disconnect() });
    expect(back.status).toBe('ok');
    if (back.status !== 'ok') return;
    const terminal = back.events.find((delivered) => delivered.row.subject.id === id && delivered.row.kind === 'task.done');
    expect(terminal, 'the completion is delivered on reconnect').toBeDefined();
    expect(back.state.tasks.find((task) => task.id === id)).toMatchObject({ status: 'done' });
    // …and the result reads back over MCP as well.
    expect(resultText(await w.call('a', 'task_read', { view: 'task', taskId: id }))).toMatch(/"status":\s*"done"/);

    // At-least-once: a redelivery (no ack yet) is dropped by the leader's inbox and never a second effect.
    const inbox = new LeaderInbox({ projectId: PROJECT_A, afterSeq: first.status === 'ok' ? first.state.latestSeq : 0 });
    const rows = back.events.map((delivered) => delivered.row);
    expect(inbox.accept(rows).deliver.length).toBe(rows.length);
    const again = feed.connect();
    expect(again.status).toBe('ok');
    if (again.status !== 'ok') return;
    expect(inbox.accept(again.events.map((delivered) => delivered.row)).deliver).toEqual([]);
    const receipts = OperationReceiptStore.open(w.a.dataDir);
    let effects = 0;
    const react = () =>
      receipts.execute({
        projectId: PROJECT_A,
        operationId: reactionOperationId(back.journalEpoch, terminal!.row, 'start-review'),
        action: 'runs.create',
        payload: { reactingTo: terminal!.row.eventId },
        reconcile: { kind: 'none' },
        effect: () => {
          effects += 1;
          return { outcome: 'ok', resultRef: { kind: 'run', id } };
        },
      });
    await react();
    await react();
    expect(effects).toBe(1);
    receipts.close();
  });

  it('through the composed MCP service: a task that finishes with no leader connected is delivered by leader_events on reconnect, with its current state; a redelivery repeats no effect', async () => {
    const c = await composedCockpit(2);
    await serveComposed(c);

    // Offline: no leader is connected. A human starts a task and the real RunManager finishes it.
    const id = await humanStarts(c, 'mock:done finished while the leader was away');
    await until('the task to finish', () => c.store.getRun(id)?.status === 'done');
    await until('its journal row on disk', () => journalRowsOnDisk(c.dataDir).some((row) => row.kind === 'task.done' && row.subject.id === id));
    const runsWhileAway = c.store.listRuns().length;

    // Reconnect: one read hands over the outstanding event, then the current, authoritative state.
    const leader = leaderClient(c.root);
    const back = await leaderRead(leader);
    expect(back).toMatchObject({ status: 'ok', hasMore: false });
    const terminal = back.events.find((event) => event.kind === 'task.done' && event.subject.id === id);
    expect(terminal, 'the completion is delivered on reconnect').toBeDefined();
    expect(back.state.tasks).toContainEqual(expect.objectContaining({ id, status: 'done' }));
    expect(bodyOf(await leader.call('task_read', { view: 'task', taskId: id }))).toMatchObject({ view: 'task', task: { id, status: 'done' } });
    // Connecting and reading made no run and holds no slot: no leader heartbeat, no poll loop.
    expect(c.store.listRuns()).toHaveLength(runsWhileAway);

    // Not yet acknowledged: the same events come again, with the same identity (at-least-once).
    const again = await leaderRead(leader);
    expect(again.events.map((event) => event.eventId)).toEqual(back.events.map((event) => event.eventId));

    // The leader's reaction is keyed by the event, so a redelivery repeats no effect.
    const reactionKey = `op-117-react-${createHash('sha256').update(terminal!.eventId).digest('hex').slice(0, 24)}`;
    const reaction = { action: 'start', operationId: reactionKey, prompt: 'mock:done review what finished' };
    const reacted = await leader.call('task_create', reaction);
    expect(reacted.isError, JSON.stringify(reacted)).toBeFalsy();
    expect((await leader.call('task_create', reaction)).structuredContent).toMatchObject({ status: 'ok', replayed: true });
    expect(c.store.listRuns().filter((run) => run.task === reaction.prompt)).toHaveLength(1);

    // Acknowledged: the delivered events are never handed over again.
    expect(await leaderAck(leader, back.nextCursor)).toMatchObject({ status: 'acked' });
    const handled = new Set(back.events.map((event) => event.eventId));
    expect((await leaderRead(leader)).events.filter((event) => handled.has(event.eventId))).toEqual([]);
  }, 60_000);
});

// ---- A-16 ----------------------------------------------------------------------------------------

describe('A-16 — MCP state absent or corrupt, the MCP service restarting (N-07, N-08)', () => {
  it('a second MCP service for the same project is refused, and the first keeps serving: never two owners', async () => {
    const w = await openWorld();
    await expect(
      listenMcpSocket({ project: { id: PROJECT_A, name: 'alpha project', root: w.a.root }, version: '0.0.0-ab', tools: w.tools }),
    ).rejects.toThrow(/already serving this project/);
    expect((await w.call('a', 'task_read', { view: 'list' })).isError ?? false).toBe(false);
    expect((await w.cockpit(`/api/v1/p/${PROJECT_A}/runs`)).status).toBe(200);
  });

  it("A's MCP state corrupt, then deleted, then reopened as a restart would: the cockpit and the socket keep working, A's tasks survive and B is untouched", async () => {
    const w = await openWorld();
    const tasksBefore = w.a.store.listRuns().map((run) => run.id).sort();
    const seen = await w.observe(async () => {
      const warnings: string[] = [];
      w.a.journal.close();
      const { writeFileSync, rmSync } = await import('node:fs');
      writeFileSync(w.a.journal.rowsPath, '{"corrupt": true\n', 'utf8');
      const corrupt = EventJournal.open({ dataDir: w.a.dataDir, projectId: PROJECT_A, secretValues: [], warn: (m) => warnings.push(m) });
      corrupt.close();
      rmSync(w.a.journal.rowsPath, { force: true });
      rmSync(w.a.journal.indexPath, { force: true });
      const fresh = EventJournal.open({ dataDir: w.a.dataDir, projectId: PROJECT_A, secretValues: [], warn: (m) => warnings.push(m) });
      opened.push(fresh);
      const list = await w.call('a', 'task_read', { view: 'list' });
      const page = await w.cockpit(`/api/v1/p/${PROJECT_A}/runs`);
      return { warnings, listOk: !(list.isError ?? false), pageStatus: page.status, latestSeq: fresh.latestSeq };
    });
    expect(seen.response.warnings).toHaveLength(1);
    expect(seen.response.warnings[0]).toMatch(/corrupt/);
    expect(seen.response).toMatchObject({ listOk: true, pageStatus: 200, latestSeq: 0 });
    expect(w.a.store.listRuns().map((run) => run.id).sort()).toEqual(tasksBefore);
    expect(seen.after).toBe(seen.before);
    // Reopening A's own store from disk (a restart of the service) keeps every task.
    w.a.store.flush();
    expect(RunStore.open(w.a.dataDir, { keepLive: true }).listRuns().map((run) => run.id).sort()).toEqual(tasksBefore);
  });
});

// ---- A-21 ----------------------------------------------------------------------------------------

describe('A-21 — reconnect with a valid or an old cursor (F-21, N-10)', () => {
  it('an old cursor after the journal was recreated is an explicit gap naming current-state recovery, with the current state beside it', async () => {
    const w = await openWorld();
    const cursors = LeaderCursors.open({ dataDir: w.a.dataDir, projectId: PROJECT_A, journal: w.a.journal, warn: () => {} });
    const oldCursor = cursors.ackedCursor;
    const feed = new LeaderFeed({ journal: w.a.journal, cursors, readState: runStateReader(w.a.store, w.a.journal), wake: () => {} });
    expect(feed.connect(oldCursor).status).toBe('ok');
    feed.disconnect();

    // The journal is lost and recreated (a new epoch) while the leader is offline.
    w.a.journal.close();
    const { rmSync } = await import('node:fs');
    rmSync(w.a.journal.rowsPath, { force: true });
    const recreated = EventJournal.open({ dataDir: w.a.dataDir, projectId: PROJECT_A, secretValues: [], warn: () => {} });
    opened.push(recreated);
    const again = new LeaderFeed({
      journal: recreated,
      cursors: LeaderCursors.open({ dataDir: w.a.dataDir, projectId: PROJECT_A, journal: recreated, warn: () => {} }),
      readState: runStateReader(w.a.store, recreated),
      wake: () => {},
    });
    const gap = again.connect(oldCursor);
    again.disconnect();
    expect(gap.status).toBe('cursor_too_old');
    if (gap.status !== 'cursor_too_old') return;
    expect(gap.gap.recovery.required).toBe('current-state');
    expect(gap.gap.recovery.message).toMatch(/Read the current state first, then continue from resumeCursor/);
    expect(gap.state.tasks.map((task) => task.id)).toEqual(expect.arrayContaining([w.a.ids.queued, w.a.ids.queued2]));
    expect(JSON.stringify(gap)).not.toContain(w.b.id);
  });

  it('through the composed MCP service: a valid cursor, an old cursor, duplicates and out-of-order acks — and a lost journal is an EXPLICIT gap that names the recovery path and recovers', async () => {
    const c = await composedCockpit(0);
    let service = await serveComposed(c);
    const leader = leaderClient(c.root);

    // A task that stays in flight (no free slot): the current state always carries it.
    const inFlight = await humanStarts(c, 'mock:done waiting for a slot');
    const first = await leaderRead(leader);
    expect(first).toMatchObject({ status: 'ok', hasMore: false });
    // The leader has taken in everything so far; its position is the cursor it will later present as OLD.
    await leaderAck(leader, first.nextCursor);
    const oldCursor = first.nextCursor;

    // Away: a human changes the configuration, and two tasks fail.
    expect((await c.human('PUT', '/config', { baseBranch: 'develop' })).status).toBe(200);
    const failed = [0, 1].map((n) => {
      const run = c.store.createRun({ title: `t${n}`, workflow: 'quick-task', task: `t${n}`, steps: [{ id: 'gate', name: 'Gate', kind: 'check' }] });
      c.store.updateRun(run.id, { status: 'running' });
      c.store.updateRun(run.id, { status: 'failed' });
      return run.id;
    });

    // A valid cursor: exactly the outstanding events, in journal order, then the current state.
    const valid = await leaderRead(leader);
    expect(valid.events.map((event) => [event.kind, event.subject.id])).toEqual([
      ['config.changed', 'project'],
      ['task.failed', failed[0]],
      ['task.failed', failed[1]],
    ]);
    const seqs = valid.events.map((event) => event.journalSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    for (const id of failed) expect(valid.state.tasks).toContainEqual(expect.objectContaining({ id, status: 'failed' }));

    // Duplicates: until acknowledged, the same events come again with the same identity.
    const duplicate = await leaderRead(leader);
    expect(duplicate.events.map((event) => event.eventId)).toEqual(valid.events.map((event) => event.eventId));
    const middle = (await leaderRead(leader, { limit: 1 })).nextCursor;

    // Out-of-order acknowledgements: the newest wins; an older or repeated one never rewinds.
    const lastSeq = seqs.at(-1)!;
    expect(await leaderAck(leader, valid.nextCursor)).toMatchObject({ status: 'acked', ackedSeq: lastSeq });
    expect(await leaderAck(leader, middle)).toMatchObject({ status: 'no-op', ackedSeq: lastSeq });
    expect(await leaderAck(leader, valid.nextCursor)).toMatchObject({ status: 'no-op', ackedSeq: lastSeq });
    expect(await leaderRead(leader)).toMatchObject({ status: 'ok', events: [] });

    // An old cursor, presented explicitly, replays what is retained and leaves the acknowledgement alone.
    const replay = await leaderRead(leader, { cursor: oldCursor });
    expect(replay.events.map((event) => event.eventId)).toEqual(valid.events.map((event) => event.eventId));
    expect(replay.position.ackedSeq).toBe(lastSeq);

    // The journal is lost while xezar is down, then an event happens. The leader's position survives.
    service.close();
    rmSync(join(c.dataDir, 'mcp', 'event-journal.json'));
    rmSync(join(c.dataDir, 'mcp', 'event-journal.ndjson'));
    service = await serveComposed(c);
    expect((await c.human('PUT', '/config', { baseBranch: 'main' })).status).toBe(200);

    // An EXPLICIT gap: nothing replayed as if nothing happened, the recovery path named, the state beside it.
    const raw = await leader.call('leader_events', { action: 'read' });
    expect(raw.isError, JSON.stringify(raw)).toBeFalsy();
    const headline = (raw.content[0] as { text: string }).text.split('\n')[0]!;
    expect(headline).toMatch(/^GAP: events after your position are no longer retained/);
    expect(headline).toMatch(/Read the current state below, then ack resumeCursor/);
    const gap = raw.structuredContent as unknown as LeaderGap;
    expect(gap).toMatchObject({ status: 'gap', gap: { recovery: { required: 'current-state' } }, state: { complete: true } });
    expect(gap.gap.recovery.message).toMatch(/Read the current state first, then continue from resumeCursor/);
    expect(gap).not.toHaveProperty('events');
    // The state beside a gap is every task still in flight (no row names one); a settled task is
    // read through the task tool, which is the current state the recovery message sends it to.
    expect(gap.state.tasks).toContainEqual(expect.objectContaining({ id: inFlight, status: 'queued' }));
    for (const id of failed) {
      expect(bodyOf(await leader.call('task_read', { view: 'task', taskId: id }))).toMatchObject({ task: { id, status: 'failed' } });
    }

    // Following the named path recovers: ack the resume cursor, then read what the new journal holds.
    expect(await leaderAck(leader, gap.gap.resumeCursor)).toMatchObject({ status: 'acked' });
    const recovered = await leaderRead(leader);
    expect(recovered.events.map((event) => event.kind)).toEqual(['config.changed']);
    expect(recovered.journalEpoch).not.toBe(valid.journalEpoch);
  });
});

// ---- A-22 ----------------------------------------------------------------------------------------

describe('A-22 — global administration and weakening gates, including by an approval request (F-12, F-22)', () => {
  const GLOBAL_ADMIN = [
    'set_workspace_config',
    'set_workspace_ui_state',
    'create_account',
    'select_account',
    'get_account_details',
    'apply_skill_updates',
    'add_project',
    'remove_project',
    'retry_provider',
    'get_launch_key',
  ] as const;

  it('every global administration action is refused with its boundary, dispatches nothing and changes nothing', async () => {
    const w = await openWorld();
    const workspaceBefore = await (await w.cockpit('/api/v1/workspace/config')).text();
    const beforeA = w.snapshot('a');
    for (const action of GLOBAL_ADMIN) {
      const seen = await w.observe(() => w.call('a', 'project_config', { action }));
      const result = seen.response;
      expect(result.isError, action).toBe(true);
      expect(result.structuredContent, action).toMatchObject({ action, refused: true });
      expect(resultText(result), action).toMatch(/^Refused \(.+\): .+ Nothing was changed\.$/s);
      expect(seen.dispatched, `${action} dispatched nothing`).toEqual([]);
      assertIsolated(w, seen, { echoes: [action] });
    }
    expect(await (await w.cockpit('/api/v1/workspace/config')).text()).toBe(workspaceBefore);
    // The only change in A is the door's own audit record of each refused call (D-06 § 10).
    expect(snapshotChanges(beforeA, w.snapshot('a')).filter((line) => !line.includes('mcp-audit') && line !== '~ audit')).toEqual([]);
  });

  it('only safe effective reads are allowed, and they carry no account identity or secret', async () => {
    const w = await openWorld();
    for (const action of ['get_limits', 'get_capabilities', 'get_account'] as const) {
      const seen = await w.observe(() => w.call('a', 'project_config', { action }));
      expect(seen.response.isError ?? false, action).toBe(false);
      const text = resultText(seen.response);
      expect(text, `${action}: no email address`).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(text, `${action}: no organisation or plan`).not.toMatch(/"(organi[sz]ation|orgName|plan|planName|subscription)"\s*:/i);
      // A read: nothing but GETs, and nothing of B or any secret in what the leader sees. These reads
      // may consult the workspace registry to narrow it (D-03 E-NARROW), so the dispatch allowlist of
      // `assertIsolated` is not the bar here — what reaches the leader is.
      expect(seen.dispatched.filter((entry) => !entry.startsWith('GET ')), `${action} only reads`).toEqual([]);
      const surface = JSON.stringify({ response: seen.response, leaderLog: seen.leaderLog });
      expect(leaked(surface, w.b.names), `${action}: nothing of B`).toEqual([]);
      expect(leaked(surface, w.secrets), `${action}: no secret`).toEqual([]);
      expect(seen.after, `${action}: B unchanged`).toBe(seen.before);
    }
  });

  it('an approval-shaped request to bypass a failing required check is refused, and the gate is reported as a blocker', async () => {
    const w = await openWorld();
    // A controlled forge: the pull request's required check is failing and a review is missing. Every
    // other request goes to the real service through the world's door.
    const mergeState = {
      number: 7,
      title: 'leader work',
      url: 'https://example.invalid/pr/7',
      state: 'open',
      isDraft: false,
      headRef: 'xez/abcdef12',
      baseRef: 'main',
      headSha: 'a'.repeat(40),
      mergeable: 'mergeable',
      reviewDecision: 'review-required',
      checks: [{ name: 'Validate', state: 'failing', required: true }],
      methods: ['squash'],
      defaultMethod: 'squash',
      eligibility: 'blocked',
      blockers: [{ code: 'reviews', message: 'A required review is missing.' }],
      canMerge: false,
      canOverride: true,
    };
    const forwarded: string[] = [];
    const forge: ServiceDispatch = {
      request: (input, init) => {
        const url = new URL(input);
        forwarded.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (url.pathname.endsWith('/merge-state')) {
          return Promise.resolve(new Response(JSON.stringify({ available: true, mergeState }), { headers: { 'content-type': 'application/json' } }));
        }
        return w.service.request(input, init);
      },
    };
    const ctx = { project: { id: PROJECT_A, name: 'alpha project', root: w.a.root }, xezarVersion: '0.0.0-ab', service: forge } as McpToolContext;
    const call = async (args: Record<string, unknown>): Promise<McpToolResult> => {
      const parsed = handoffGitTool.inputSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: 'text', text: parsed.error.message }], isError: true };
      return handoffGitTool.call(parsed.data, ctx);
    };

    // 1. The approval-shaped request: every bypass-looking key is refused outright, never ignored.
    for (const approval of [
      { approvedBy: 'the human', reason: 'the human approved skipping the failing check' },
      { qualityException: true },
      { overrideRules: true },
      { force: true },
    ]) {
      const refused = await call({ action: 'merge', number: 7, expectedHeadSha: 'a'.repeat(40), ...approval });
      expect(refused.isError, JSON.stringify(approval)).toBe(true);
    }
    expect(forwarded, 'a refused approval dispatched nothing').toEqual([]);

    // 2. The same merge without the approval: the gate stands and is REPORTED AS A BLOCKER.
    const blocked = await call({ action: 'merge', number: 7, expectedHeadSha: 'a'.repeat(40) });
    const body = JSON.parse(resultText(blocked)) as Record<string, unknown>;
    expect(body).toMatchObject({ action: 'merge', status: 'failed', blocker: true, nextAction: QUALITY_BLOCKER_NEXT_ACTION });
    expect(String(body.nextAction)).toMatch(/cannot be bypassed/);
    expect(String(body.nextAction)).toMatch(/report this blocker/);
    expect(forwarded.some((entry) => entry.startsWith('POST') && entry.endsWith('/merge')), 'no merge was attempted').toBe(false);
    // The input contract offers no waiver to anyone: no key of the schema reads as an approval.
    const keys = Object.keys((handoffGitTool.inputSchema as unknown as { shape: Record<string, unknown> }).shape);
    expect(keys.filter((key) => /approv|waiv|bypass|override|exception|force/i.test(key))).toEqual([]);
  });

  // FINDING (F-22, A-22), observed 2026-09-11 on this suite's first run: `project_config save_workflow`
  // with `overwrite: true` REPLACED a human-authored project workflow, so a leader could drop its check
  // step (`command: npm test`) — a quality gate — with no refusal and no blocker. Fixed by #262: the
  // overwrite is refused as a quality-gate blocker naming the step, and D-03 states the rule.
  it("FINDING (F-22): overwriting a project workflow to drop its check step (a quality gate) must leave the human's gate in place", async () => {
    const w = await openWorld();
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const path = join(w.a.root, '.xezar', 'workflows', 'gated.yaml');
    const gated = 'name: gated\ndescription: the human gate\nsteps:\n  - id: work\n    prompt: "{{task}}"\n  - id: tests\n    command: npm test\n';
    writeFileSync(path, gated, 'utf8');
    const result = await w.call('a', 'project_config', {
      action: 'save_workflow',
      workflow: { name: 'gated', steps: [{ id: 'work', prompt: '{{task}}' }], overwrite: true },
    });
    expect(readFileSync(path, 'utf8'), `the gate file after the leader's overwrite: ${resultText(result)}`).toBe(gated);
    // Refused and REPORTED as a blocker that names the step it would have removed — never silent.
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ refused: true, blocker: true, boundary: 'quality-gate', checkSteps: [{ id: 'tests' }] });
  });
});
