import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { McpJournalRow } from '@qodeca/xezar-contract';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectDataDir } from '../project-data-paths.ts';
import { RunStore } from '../runs/store.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { WorkspaceEventBus, createApp } from '../server/server.ts';
import { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { runBridge } from './bridge.ts';
import { resolveMcpTarget, startMcpService } from './index.ts';
import { LineFramer, encodeFrame, type McpToolResult } from './ipc.ts';
import { tools } from './tools/index.ts';

/**
 * #251 and #252, against the REAL composed service: the real `runBridge` over the real project
 * socket `startMcpService` opens, dispatching into a real `createApp` over a real store — the same
 * world `composition.test.ts` builds. A person's change goes through the cockpit's own routes
 * (`apiRequest`), a leader's through the MCP tools, and every row is read back from the journal
 * file on disk.
 *
 *  - #251: a leader that reconnects reads the events it missed — each once it acknowledges, again
 *    until it does — and an EXPLICIT gap when the events it needed were dropped (A-15, A-21).
 *  - #252: a human configuration, workflow or agent-config change reaches the leader as exactly
 *    one E-05 row with the right origin (A-19, A-20).
 */

const VERSION = '9.9.9-leader-feed';
const SECRET = 'Zq8vK2mW9xR4tY7pL3nB';
const tempDirs: string[] = [];
const closers: Array<() => unknown> = [];
const saved = { home: process.env.XEZ_HOME, dryRun: process.env.XEZ_DRY_RUN, remote: process.env.XEZ_REMOTE };

// A short home under /tmp: the per-worker sandbox is already past the macOS socket-path limit.
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  tempDirs.push(dir);
  return dir;
};

beforeEach(() => {
  process.env.XEZ_HOME = tmp('xzh-');
  process.env.XEZ_DRY_RUN = '1';
  delete process.env.XEZ_REMOTE;
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await Promise.resolve(close()).catch(() => undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [['XEZ_HOME', saved.home], ['XEZ_DRY_RUN', saved.dryRun], ['XEZ_REMOTE', saved.remote]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function cockpit() {
  const root = tmp('xzp-');
  mkdirSync(join(root, '.xezar'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
  const { id } = await registerProject(root);
  const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2 }, load: async () => ({ maxParallel: 2, memoryLimitMb: null }) });
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
  /** A person at the cockpit: the same routes the browser calls. */
  const human = (method: string, path: string, body?: unknown): Promise<Response> =>
    apiRequest(app as unknown as Hono, `/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { root, id, store, app, human, dataDir: store.dataDir };
}

type Cockpit = Awaited<ReturnType<typeof cockpit>>;

async function serve(c: Cockpit, env?: NodeJS.ProcessEnv) {
  const handle = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store, ...(env ? { env } : {}) });
  closers.push(() => handle.close());
  return handle;
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

type Leader = ReturnType<typeof agent>;
type EventOut = McpJournalRow & { standing: 'current' | 'superseded' | 'unjudged' };
interface ReadOk {
  status: 'ok';
  events: EventOut[];
  nextCursor: string;
  hasMore: boolean;
  state: { latestSeq: number; tasks: Array<{ id: string; status: string | null; version: string | null }>; complete: boolean };
  position: { deliveredSeq: number; ackedSeq: number; reactedSeq: number };
  fresh: boolean;
  journalEpoch: string;
}
interface ReadGap {
  status: 'gap';
  gap: { oldestSeq: number | null; latestSeq: number; resumeCursor: string; recovery: { required: string } };
  state: ReadOk['state'];
}

async function readEvents<T = ReadOk>(leader: Leader, args: Record<string, unknown> = {}): Promise<T> {
  const result = await leader.call('leader_events', { action: 'read', ...args });
  expect(result.isError, JSON.stringify(result)).toBeFalsy();
  return result.structuredContent as T;
}

async function ack(leader: Leader, cursor: string): Promise<{ status: string; ackedSeq: number }> {
  const result = await leader.call('leader_events', { action: 'ack', cursor });
  expect(result.isError, JSON.stringify(result)).toBeFalsy();
  return result.structuredContent as { status: string; ackedSeq: number };
}

/** The rows the journal actually holds, straight from the file on disk. */
const journalRows = (dataDir: string): McpJournalRow[] => {
  const path = join(dataDir, 'mcp', 'event-journal.ndjson');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as McpJournalRow);
};
const e05 = (dataDir: string): McpJournalRow[] => journalRows(dataDir).filter((row) => row.category === 'E-05');

const STEPS = [{ id: 'do', prompt: 'do it' }];

describe('#251 — a reconnecting leader reads the events it missed (A-15, A-21)', () => {
  it('delivers the outstanding events and current state, again until acknowledged, then an explicit gap when events were dropped', async () => {
    const c = await cockpit();
    let handle = await serve(c);
    const leader = agent(c.root);

    // First connection: nothing is outstanding, and the leader has no stored position yet.
    const first = await readEvents(leader);
    expect(first).toMatchObject({ status: 'ok', events: [], hasMore: false, fresh: true });
    const oldCursor = first.nextCursor;

    // The leader is away. A person changes the configuration; a task fails.
    expect((await c.human('PUT', '/config', { baseBranch: 'develop' })).status).toBe(200);
    const run = c.store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [{ id: 'gate', name: 'Gate', kind: 'check' }] });
    c.store.updateRun(run.id, { status: 'running' });
    c.store.updateRun(run.id, { status: 'failed' });

    // Reconnect: the outstanding events, in journal order, then the current state of their tasks.
    const back = await readEvents(leader);
    expect(back.events.map((event) => [event.kind, event.origin])).toEqual([
      ['config.changed', 'human'],
      ['task.failed', 'system'],
    ]);
    expect(back.events[1]).toMatchObject({ subject: { type: 'run', id: run.id }, standing: 'current' });
    expect(back.state.tasks).toContainEqual(expect.objectContaining({ id: run.id, status: 'failed' }));
    expect(back.position.deliveredSeq).toBe(back.events[1]!.journalSeq);

    // Not acknowledged: the same events come again, with the same identity (at-least-once).
    const again = await readEvents(leader);
    expect(again.events.map((event) => event.eventId)).toEqual(back.events.map((event) => event.eventId));

    const lastSeq = back.events[1]!.journalSeq;
    expect(await ack(leader, back.nextCursor)).toEqual({ status: 'acked', ackedSeq: lastSeq, position: expect.any(Object) });
    // A duplicate ack and an OLD cursor are no-ops — never a rewind.
    expect(await ack(leader, back.nextCursor)).toMatchObject({ status: 'no-op', ackedSeq: lastSeq });
    expect(await ack(leader, oldCursor)).toMatchObject({ status: 'no-op', ackedSeq: lastSeq });
    expect(await readEvents(leader)).toMatchObject({ status: 'ok', events: [] });

    // Reading from an explicit old cursor replays for review and leaves the acknowledgement alone.
    const replay = await readEvents(leader, { cursor: oldCursor });
    expect(replay.events.map((event) => event.eventId)).toEqual(back.events.map((event) => event.eventId));
    expect(replay.position.ackedSeq).toBe(lastSeq);

    // Events are dropped: the journal is deleted while xezar is down. The leader's cursor survives.
    handle.close();
    rmSync(join(c.dataDir, 'mcp', 'event-journal.json'));
    rmSync(join(c.dataDir, 'mcp', 'event-journal.ndjson'));
    handle = await serve(c);
    expect((await c.human('PUT', '/config', { baseBranch: 'main' })).status).toBe(200);

    const raw = await leader.call('leader_events', { action: 'read' });
    expect(raw.isError).toBeFalsy();
    expect(raw.content[0]!.text).toMatch(/^GAP: /);
    const gap = raw.structuredContent as unknown as ReadGap;
    expect(gap).toMatchObject({ status: 'gap', gap: { recovery: { required: 'current-state' } }, state: { complete: true } });
    expect(gap).not.toHaveProperty('events');

    // Recovery: acknowledge the resume cursor, then read what the new journal holds.
    expect(await ack(leader, gap.gap.resumeCursor)).toMatchObject({ status: 'acked', ackedSeq: 0 });
    const after = await readEvents(leader);
    expect(after.events.map((event) => [event.kind, event.journalSeq])).toEqual([['config.changed', 1]]);
    expect(after.journalEpoch).not.toBe(back.journalEpoch);
  });

  it('refuses another project’s cursor, and keeps a host secret out of the answer (N-01, F-15)', async () => {
    const a = await cockpit();
    const b = await cockpit();
    await serve(a, { ...process.env, LEADER_FEED_PROBE_TOKEN: SECRET });
    await serve(b);
    const leaderA = agent(a.root);
    const leaderB = agent(b.root);

    const foreign = (await readEvents(leaderB)).nextCursor;
    const refused = await leaderA.call('leader_events', { action: 'read', cursor: foreign });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toEqual({ error: 'cursor_project_mismatch', message: expect.any(String) });
    expect(JSON.stringify(refused)).not.toContain(b.id);
    expect((await leaderA.call('leader_events', { action: 'ack', cursor: foreign })).isError).toBe(true);

    // A person saves a workflow whose NAME carries the host's secret — the name is the row's subject.
    // Meanwhile B changes too; none of B's events is A's business.
    await readEvents(leaderA);
    expect((await a.human('POST', '/workflows', { name: `wf-${SECRET}`, steps: STEPS })).status).toBe(201);
    expect((await b.human('POST', '/workflows', { name: 'bravo-only', steps: STEPS })).status).toBe(201);
    const result = await leaderA.call('leader_events', { action: 'read' });
    const events = (result.structuredContent as unknown as ReadOk).events;
    expect(events.map((event) => [event.kind, event.projectId])).toEqual([['workflow.saved', a.id]]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toMatch(new RegExp(`bravo-only|${b.id}`));
  });
});

describe('#252 — a human change to config, a workflow or agent config reaches the leader as E-05', () => {
  it('writes exactly one row per real change, as the human’s, and none for a refused or empty write', async () => {
    const c = await cockpit();
    await serve(c);

    // Configuration: key NAMES only, and a presentation-only key is not news.
    expect((await c.human('PUT', '/config', { baseBranch: 'develop', liveTitleUpdates: true })).status).toBe(200);
    const [config] = e05(c.dataDir);
    expect(e05(c.dataDir)).toHaveLength(1);
    expect(config).toMatchObject({ kind: 'config.changed', origin: 'human', causedBy: null, subject: { type: 'config', id: 'project' } });
    expect(config!.summary).toContain('baseBranch');
    expect(config!.summary).not.toMatch(/develop|liveTitleUpdates/);
    // The same write again changes nothing, so it says nothing.
    expect((await c.human('PUT', '/config', { baseBranch: 'develop' })).status).toBe(200);
    expect(e05(c.dataDir)).toHaveLength(1);

    // A workflow saved, then deleted.
    expect((await c.human('POST', '/workflows', { name: 'nightly', steps: STEPS })).status).toBe(201);
    expect((await c.human('DELETE', '/workflows/nightly')).status).toBe(200);
    expect(e05(c.dataDir).slice(1).map((row) => [row.kind, row.subject.id, row.origin])).toEqual([
      ['workflow.saved', 'nightly', 'human'],
      ['workflow.deleted', 'nightly', 'human'],
    ]);
    // A refused save (the file exists) is no change.
    expect((await c.human('POST', '/workflows', { name: 'twice', steps: STEPS })).status).toBe(201);
    expect((await c.human('POST', '/workflows', { name: 'twice', steps: STEPS })).status).toBe(409);
    expect(e05(c.dataDir).filter((row) => row.subject.id === 'twice')).toHaveLength(1);

    // An agent configuration file.
    const put = (version: string | null) => c.human('PUT', '/agent-config/claude.project.settings', { content: '{"a":1}', version });
    expect((await put(null)).status).toBe(200);
    const agentRows = () => e05(c.dataDir).filter((row) => row.kind === 'agent-config.changed');
    expect(agentRows()).toEqual([
      expect.objectContaining({ origin: 'human', subject: { type: 'agent-config', id: 'claude.project.settings', version: null } }),
    ]);
    // Hosted mode refuses the write BEFORE anything else happens — and so writes no row.
    process.env.XEZ_REMOTE = '1';
    expect((await put(null)).status).toBe(409);
    expect(agentRows()).toHaveLength(1);
  });

  it('marks the same change made through MCP as the leader’s own, naming its operation', async () => {
    const c = await cockpit();
    await serve(c);
    const leader = agent(c.root);

    const set = await leader.call('project_config', { action: 'set_config', config: { baseBranch: 'develop' } });
    expect(set.isError, JSON.stringify(set)).toBeFalsy();
    const saved = await leader.call('project_config', { action: 'save_workflow', workflow: { name: 'from-leader', steps: STEPS } });
    expect(saved.isError, JSON.stringify(saved)).toBeFalsy();

    const rows = e05(c.dataDir);
    expect(rows.map((row) => [row.kind, row.origin])).toEqual([
      ['config.changed', 'leader'],
      ['workflow.saved', 'leader'],
    ]);
    for (const row of rows) expect(row.causedBy).toMatch(/^mcp-door\./);
  });

  it('writes no row and never fails the write for a project with no catalog', async () => {
    const c = await cockpit();
    // No MCP composition for this project at all.
    expect((await c.human('PUT', '/config', { baseBranch: 'develop' })).status).toBe(200);
    expect((await c.human('POST', '/workflows', { name: 'quiet', steps: STEPS })).status).toBe(201);
    expect(existsSync(join(c.dataDir, 'mcp', 'event-journal.ndjson'))).toBe(false);

    // A composition that has shut down has released its registration with it.
    const handle = await serve(c);
    handle.close();
    expect((await c.human('PUT', '/config', { baseBranch: 'main' })).status).toBe(200);
    expect((await c.human('DELETE', '/workflows/quiet')).status).toBe(200);
    expect(e05(c.dataDir)).toEqual([]);
  });
});
