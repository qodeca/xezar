import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { McpJournalRow } from '@qodeca/xezar-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectDataDir } from '../project-data-paths.ts';
import { RunStore } from '../runs/store.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { WorkspaceEventBus, createApp } from '../server/server.ts';
import { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { AUDIT_TRAIL_FILE, LEGACY_AUDIT_TRAIL_FILE } from './audit-trail.ts';
import { runBridge } from './bridge.ts';
import { EventJournal } from './event-journal.ts';
import { resolveMcpTarget, startMcpService } from './index.ts';
import { LineFramer, encodeFrame, type McpToolResult } from './ipc.ts';
import { runVersion } from './stale-write.ts';
import { tools } from './tools/index.ts';

/**
 * #243 — the composed MCP service, driven the way a coding agent meets it: the real `runBridge`
 * over the real project socket that `startMcpService` opens, dispatching into a real `createApp`
 * over a real store and run manager (`XEZ_DRY_RUN=1` mocks only the agent CLI). No stand-ins for
 * any part the composition wires.
 */

const VERSION = '9.9.9-compose';
const tempDirs: string[] = [];
const closers: Array<() => unknown> = [];
const saved = { home: process.env.XEZ_HOME, dryRun: process.env.XEZ_DRY_RUN };

// A short home under /tmp, never the per-worker sandbox: the sandbox sits under the task's
// TMPDIR, which is already past the 104-byte socket limit on macOS (D-01 E5, § 9.5).
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

/** A registered project with the cockpit's own app, store and manager over it. */
async function cockpit(maxParallel = 2) {
  const root = tmp('xzp-');
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

async function until<T>(what: string, probe: () => T | undefined, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const auditLines = (dataDir: string): Array<Record<string, unknown>> => {
  const path = join(dataDir, AUDIT_TRAIL_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
};

/** The rows the catalog actually wrote, straight from the journal file on disk. */
const journalRows = (dataDir: string): McpJournalRow[] => {
  const path = join(dataDir, 'mcp', 'event-journal.ndjson');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as McpJournalRow);
};

/** The E-01–E-03 rows a settled task can end in (done, review, waiting with or without a question). */
const SETTLED_KINDS = ['task.done', 'result.ready', 'task.blocked', 'question.asked'];

describe('the composed MCP service, through the real bridge and socket', () => {
  it('starts a task through the cockpit services, takes it through its lifecycle, and records the operation', async () => {
    const c = await cockpit();
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store });
    closers.push(() => handle.close());
    const client = agent(c.root);

    const started = await client.call('task_create', { action: 'start', operationId: 'op-compose-0001', prompt: 'say hello' });
    // Unwired, every service-backed tool answers "not connected" here.
    expect(started.isError, JSON.stringify(started)).toBeFalsy();
    const subject = (started.structuredContent as { subject: { type: string; id: string } }).subject;
    expect(subject.type).toBe('run');
    const runId = subject.id;

    // The task runs to the end of its lifecycle on the cockpit's own manager.
    const status = await until('the task to settle', () => {
      const s = c.store.getRun(runId)?.status;
      return s === 'done' || s === 'review' || s === 'waiting' || s === 'failed' ? s : undefined;
    });
    expect(status).not.toBe('failed');

    // #104: the catalog wrote the task's outcome into the project journal — a real row, on disk.
    // The engine settled it, so it is `system`, even though the leader started the task: a
    // completion the leader asked for is still news to the leader (F-13).
    const outcome = await until('the outcome row', () =>
      journalRows(c.dataDir).find((row) => row.subject.id === runId && SETTLED_KINDS.includes(row.kind)),
    );
    expect(outcome).toMatchObject({ projectId: c.id, subject: { type: 'run', id: runId }, origin: 'system', causedBy: null });
    expect(outcome.category).toMatch(/^E-0[123]$/);
    expect(outcome.subject.version).toMatch(/^rev1:run:/);

    // #101: a dropped response retried under the same key replays — no second task.
    const retried = await client.call('task_create', { action: 'start', operationId: 'op-compose-0001', prompt: 'say hello' });
    expect(retried.structuredContent).toMatchObject({ status: 'ok', replayed: true, resultRef: { kind: 'run', id: runId } });
    expect(c.store.listRuns().map((run) => run.id)).toEqual([runId]);

    // #102: the MCP door stamped the operation `mcp`, with its operation key and the run it made.
    const reads = await client.call('discover_project', {});
    expect(reads.isError).toBeFalsy();
    const entries = auditLines(c.dataDir);
    expect(entries).toHaveLength(2); // the start and its replay; the read is not an operation
    expect(entries[0]).toMatchObject({
      v: 2,
      seq: 1,
      kind: 'action',
      origin: 'mcp',
      actor: { type: 'mcp' },
      projectId: c.id,
      // #306 part 2: the shared inventory's id, the one the cockpit's `POST /runs` records too.
      action: 'run.start',
      outcome: { status: 'applied' },
      resource: { kind: 'run', id: runId },
      operationKey: `${c.id}/op-compose-0001`,
    });
    expect(entries[1]).toMatchObject({ seq: 2, outcome: { status: 'applied' } });
    // #306: no opt-in flag, the new file name, owner-only, and nothing under the legacy name.
    expect(statSync(join(c.dataDir, 'audit.ndjson')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(c.dataDir, 'mcp-audit.ndjson'))).toBe(false);

    // #103: the project's journal is open while the service runs, and released by close().
    expect(existsSync(join(c.dataDir, 'mcp', 'event-journal.json'))).toBe(true);
    expect(() => EventJournal.open({ dataDir: c.dataDir, projectId: c.id, secretValues: [] })).toThrow(/already open/);
    handle.close();
    const reopened = EventJournal.open({ dataDir: c.dataDir, projectId: c.id, secretValues: [] });
    reopened.close();
  });

  it("writes an MCP cancel as the leader's change, naming the operation that caused it", async () => {
    // No free slot: the task the leader starts stays queued in the cockpit's own manager.
    const c = await cockpit(0);
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store });
    closers.push(() => handle.close());
    const client = agent(c.root);
    const started = await client.call('task_create', { action: 'start', operationId: 'op-compose-0003', prompt: 'wait' });
    expect(started.isError, JSON.stringify(started)).toBeFalsy();
    const queued = { id: (started.structuredContent as { subject: { id: string } }).subject.id };
    expect(c.store.getRun(queued.id)?.status).toBe('queued');

    // A leader reads the task before it acts on it, and acts on the version it read (#250).
    const read = await client.call('task_read', { view: 'task', taskId: queued.id });
    const expectedVersion = (JSON.parse((read.content[0] as { text: string }).text) as { version: string }).version;
    const cancelled = await client.call('execution_control', { action: 'cancel', runId: queued.id, expectedVersion, operationId: 'op-compose-0004' });
    expect(cancelled.isError, JSON.stringify(cancelled)).toBeFalsy();
    expect(cancelled.structuredContent, JSON.stringify(cancelled)).toMatchObject({ runStatus: 'cancelled' });
    const row = await until('the cancel row', () =>
      journalRows(c.dataDir).find((r) => r.subject.id === queued.id && r.kind === 'task.cancelled'),
    );
    // Without the door's origin marker the catalog reads a cancel as a person's (its honest default).
    expect(row).toMatchObject({ category: 'E-01', origin: 'leader' });
    // #264: the row names the leader's OWN operation key, the one it can replay the cancel under.
    expect(row.causedBy).toBe('op-compose-0004');
    expect(auditLines(c.dataDir).map((entry) => entry.action)).toEqual(['run.start', 'run.cancel']);
    expect(auditLines(c.dataDir)[1]).toMatchObject({ origin: 'mcp', outcome: { status: 'applied' }, resource: { kind: 'run', id: queued.id } });
  });

  it("A-13: a leader write based on a stale read is refused, and the human's state stays byte-identical (#250)", async () => {
    // No free slot: the task stays queued, so nothing but the two writers below can move it.
    const c = await cockpit(0);
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store });
    closers.push(() => handle.close());
    const client = agent(c.root);
    const body = (result: McpToolResult) => JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
    const started = await client.call('task_create', { action: 'start', operationId: 'op-compose-0013', prompt: 'the first brief' });
    expect(started.isError, JSON.stringify(started)).toBeFalsy();
    const runId = (started.structuredContent as { subject: { id: string } }).subject.id;

    // 1. The leader reads the task and keeps the version its answer carries.
    const leaderRead = body(await client.call('task_read', { view: 'task', taskId: runId })).version as string;
    expect(leaderRead).toBe(runVersion(c.store, runId));

    // 2. A human changes it from the cockpit — the second path, which sends no token at all.
    const human = await c.app.request(`/api/v1/p/${c.id}/runs/${runId}`, {
      method: 'PATCH',
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'the human’s title', task: 'the human’s brief' }),
    });
    expect(human.status).toBe(200);
    const humanVersion = runVersion(c.store, runId);
    expect(humanVersion).not.toBe(leaderRead);

    // 3. The leader acts on its old read, through every tool that could change this task.
    c.store.flush();
    const bytes = () => {
      c.store.flush();
      return {
        index: readFileSync(join(c.dataDir, 'runs.json')),
        events: existsSync(join(c.dataDir, 'runs', `${runId}.ndjson`)) ? readFileSync(join(c.dataDir, 'runs', `${runId}.ndjson`)) : null,
      };
    };
    const before = bytes();
    const attempts = [
      await client.call('organise_work', { action: 'set_title', runId, title: 'the leader’s title', expectedVersion: leaderRead, operationId: 'op-compose-0014' }),
      await client.call('organise_work', { action: 'edit_brief', runId, task: 'the leader’s brief', expectedVersion: leaderRead, operationId: 'op-compose-0015' }),
      await client.call('execution_control', { action: 'send_message', runId, text: 'and this', expectedVersion: leaderRead, operationId: 'op-compose-0016' }),
      await client.call('execution_control', { action: 'cancel', runId, expectedVersion: leaderRead, operationId: 'op-compose-0017' }),
    ];
    for (const attempt of attempts) {
      expect(attempt.isError, JSON.stringify(attempt)).toBeFalsy();
      expect(body(attempt)).toMatchObject({
        status: 'conflict',
        applied: false,
        error: 'stale_version',
        resource: { kind: 'run', id: runId },
        currentVersion: humanVersion,
        changedSince: true,
      });
    }
    // Refused, and PROVED unapplied: the task's files are the same bytes the human left.
    expect(bytes()).toEqual(before);
    expect(c.store.getRun(runId)).toMatchObject({ status: 'queued', title: 'the human’s title', task: 'the human’s brief' });

    // The trail says what happened — refused, with the version the decision was based on.
    const rejected = auditLines(c.dataDir).slice(-attempts.length);
    for (const entry of rejected) {
      expect(entry).toMatchObject({ origin: 'mcp', outcome: { status: 'refused', reason: 'stale_version' }, versionToken: leaderRead });
      expect(entry).not.toHaveProperty('errorCode');
    }

    // 4. Read again, decide again: the new decision goes through.
    const freshRead = body(await client.call('task_read', { view: 'task', taskId: runId })).version as string;
    const renamed = await client.call('organise_work', {
      action: 'set_title',
      runId,
      title: 'the leader’s title',
      expectedVersion: freshRead,
      operationId: 'op-compose-0018',
    });
    expect(body(renamed)).toMatchObject({ status: 'done', run: { id: runId, title: 'the leader’s title' } });
    expect(c.store.getRun(runId)?.title).toBe('the leader’s title');
  });

  it('#306: a boundary refusal is recorded as refused, a tool error that may have started is not recorded, and the legacy file is never touched', async () => {
    const c = await cockpit();
    // A trail 0.15.0 left behind, under the old name.
    const legacy = join(c.dataDir, LEGACY_AUDIT_TRAIL_FILE);
    copyFileSync(fileURLToPath(new URL('../../test/fixtures/audit-0.15.0/data-dir/mcp-audit.ndjson', import.meta.url)), legacy);
    const legacyBytes = readFileSync(legacy);
    const warnings: string[] = [];
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store, warn: (m) => warnings.push(m) });
    closers.push(() => handle.close());
    const client = agent(c.root);

    // Refused before any effect, and the tool says so in its structured answer (spec § 6.2).
    // `set_workspace_ui_state` left this case with #677 B3 (it is a write now); the provider
    // switch is the `workspace-settings` boundary that is still refused.
    const boundary = await client.call('project_config', { action: 'set_provider_enabled', operationId: 'op-compose-0031' });
    expect(boundary.isError, JSON.stringify(boundary)).toBe(true);
    expect(boundary.structuredContent, JSON.stringify(boundary)).toBeDefined();
    expect(boundary.structuredContent).toMatchObject({ refused: true, boundary: 'workspace-settings' });
    // A task this project does not have: looked up before any effect, so a refusal too (#573).
    const missing = await client.call('execution_control', { action: 'cancel', runId: 'no-such-run', expectedVersion: 'rev1:run:no-such-run:1:0123456789ab', operationId: 'op-compose-0032' });
    expect(missing.isError, JSON.stringify(missing)).toBe(true);
    const started = await client.call('task_create', { action: 'start', operationId: 'op-compose-0033', prompt: 'hello' });
    expect(started.isError, JSON.stringify(started)).toBeFalsy();
    const runId = (started.structuredContent as { subject: { id: string } }).subject.id;
    const read = await client.call('task_read', { view: 'task', taskId: runId });
    const version = (JSON.parse((read.content[0] as { text: string }).text) as { version: string }).version;
    // An error answer that does not say it refused: the door cannot tell it from one that followed an
    // effect, so no record (spec § 3.2).
    const failed = await client.call('execution_control', { action: 'edit_queued_message', runId, messageId: 'not a message id', text: 'x', expectedVersion: version, operationId: 'op-compose-0034' });
    expect(failed.isError, JSON.stringify(failed)).toBe(true);

    expect(auditLines(c.dataDir).map((entry) => [entry.seq, entry.action, entry.outcome])).toEqual([
      [1, 'provider.setEnabled', { status: 'refused', reason: 'workspace_settings' }],
      [2, 'run.cancel', { status: 'refused', reason: 'not_found' }],
      [3, 'run.start', { status: 'applied' }],
    ]);
    // One warning for the unrecorded call, carrying a code and never the call's own text.
    const auditWarnings = warnings.filter((m) => m.includes('audit trail'));
    expect(auditWarnings).toEqual(['xezar: audit trail write failed (tool_error); the action continued without an audit record.']);
    // The legacy file is read-only: same bytes, and still where 0.15.0 left it.
    expect(readFileSync(legacy).equals(legacyBytes)).toBe(true);
  });

  /**
   * #677 wave 2 B1: the workspace write is an ordinary mutation of the generic door, so it takes
   * an operation key and REPLAYS under it. The tool's own suite cannot show this — it calls the
   * tool directly, and the receipt belongs to the door — so the assertion lives here, where the
   * real bridge, the real receipt store and the real route are all in play (review M2).
   */
  it('a workspace write replayed under the same operation key re-answers and does not re-apply', async () => {
    const c = await cockpit();
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store });
    closers.push(() => handle.close());
    const client = agent(c.root);
    const limit = async (): Promise<number> => {
      const read = await client.call('project_config', { action: 'get_limits' });
      return (read.structuredContent as { result: { workspace: { resources: { maxParallel: number } } } }).result.workspace.resources.maxParallel;
    };

    const body = { action: 'set_workspace_config', operationId: 'op-compose-0061', workspaceConfig: { resources: { maxParallel: 6 } } };
    const first = await client.call('project_config', body);
    expect(first.isError, JSON.stringify(first)).toBeFalsy();
    expect(await limit()).toBe(6);

    // A person moves the same limit in the cockpit, between the two calls.
    const byHand = await c.app.request('/api/v1/workspace/config', {
      method: 'PUT',
      headers: { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321', 'content-type': 'application/json' },
      body: JSON.stringify({ resources: { maxParallel: 3 } }),
    });
    expect(byHand.status).toBe(200);

    const replay = await client.call('project_config', body);
    expect(replay.isError, JSON.stringify(replay)).toBeFalsy();
    expect(replay.structuredContent).toMatchObject({ status: 'ok', replayed: true });
    // The person's 3 stands: the replay re-answered, it did not write the leader's 6 a second time.
    expect(await limit()).toBe(3);

    // The same key with a DIFFERENT body is a conflict, and writes nothing either.
    const conflict = await client.call('project_config', {
      action: 'set_workspace_config',
      operationId: 'op-compose-0061',
      workspaceConfig: { resources: { maxParallel: 5 } },
    });
    expect(conflict.isError, JSON.stringify(conflict)).toBe(true);
    expect(JSON.stringify(conflict)).toContain('operation_key_conflict');
    expect(await limit()).toBe(3);
  });

  it('F-15: no secret from the host environment enters a journal row', async () => {
    const c = await cockpit();
    const secret = 'Zq8vK2mW9xR4tY7pL3nB';
    const handle = await startMcpService({
      projectId: c.id,
      version: VERSION,
      service: c.app,
      store: c.store,
      env: { ...process.env, COMPOSE_PROBE_TOKEN: secret },
    });
    closers.push(() => handle.close());
    // A failing quality gate whose step id carries the value — the catalog names the step in its summary.
    const run = c.store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [{ id: `gate-${secret}`, name: 'Gate', kind: 'check' }] });
    c.store.updateRun(run.id, { status: 'running' });
    c.store.updateStep(run.id, `gate-${secret}`, { status: 'failed' });
    c.store.updateRun(run.id, { status: 'failed' });

    const rows = journalRows(c.dataDir).filter((r) => r.subject.id === run.id);
    expect(rows.map((r) => r.kind)).toEqual(['gate.failed', 'task.failed']);
    const raw = readFileSync(join(c.dataDir, 'mcp', 'event-journal.ndjson'), 'utf8');
    expect(raw).not.toContain(secret);
  });

  it('#450 T-29: the composition hands leader_events the delivery path, and the hosted boundary reaches it', async () => {
    // RED against: dropping the `leaderControl` context spread — status would answer "not connected".
    const c = await cockpit();
    const local = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store, warn: () => {} });
    closers.push(() => local.close());
    const leader = agent(c.root);
    const status = await leader.call('leader_events', { action: 'status' });
    expect(status.isError, status.content[0]?.text).toBeFalsy();
    expect(status.structuredContent).toMatchObject({ available: true, canPush: false, pushUnavailable: { code: 'client-unknown' }, self: { isOwner: true } });
    local.close();

    const hosted = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store, warn: () => {}, localHandoff: () => false });
    closers.push(() => hosted.close());
    const remote = agent(c.root);
    const refused = await remote.call('leader_events', { action: 'status' });
    expect(refused.structuredContent).toMatchObject({ available: true, canPush: false, pushUnavailable: { code: 'hosted-mode' } });
  });

  it('a key reused for different work is refused without running the tool again', async () => {
    const c = await cockpit();
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store });
    closers.push(() => handle.close());
    const client = agent(c.root);

    const first = await client.call('task_create', { action: 'start', operationId: 'op-compose-0002', prompt: 'one' });
    expect(first.isError, JSON.stringify(first)).toBeFalsy();
    const conflict = await client.call('task_create', { action: 'start', operationId: 'op-compose-0002', prompt: 'two' });
    expect(conflict.isError).toBe(true);
    expect(conflict.structuredContent).toMatchObject({ error: 'operation_key_conflict', mismatch: 'payload' });
    expect(c.store.listRuns()).toHaveLength(1);
  });
});

describe('N-07: composition can never break ordinary startup', () => {
  it('releases every part it composed when the socket cannot open', async () => {
    const c = await cockpit();
    // Past the local-socket length limit: the socket half throws after the journal and receipts opened.
    const longHome = join(tmp('xzl-'), 'h'.repeat(120));
    await expect(
      startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store, env: { ...process.env, XEZ_HOME: longHome } }),
    ).rejects.toThrow(/too long for a local socket/);
    // Nothing composed outlived the throw: the journal is free for the next start.
    const journal = EventJournal.open({ dataDir: c.dataDir, projectId: c.id, secretValues: [] });
    journal.close();
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store });
    handle.close();
  });

  it('`xezar serve` still boots and answers /api/v1/health when the MCP composition throws', async () => {
    const repo = tmp('xzr-');
    // Registry and cockpit work under this home; only the MCP socket path is too long for it.
    const home = join(tmp('xzc-'), 'h'.repeat(120));
    const TSX = import.meta.resolve('tsx');
    const CLI = fileURLToPath(new URL('../index.ts', import.meta.url));
    const child: ChildProcess = spawn(process.execPath, ['--import', TSX, CLI, 'serve', '--no-open', '--port', '0'], {
      cwd: repo,
      env: { ...process.env, XEZ_HOME: home, XEZ_DRY_RUN: '1', XEZ_SKILLS_AUTO_UPDATE: '0', XEZ_NO_BANNER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid;
    closers.push(() => {
      if (pid !== undefined) process.kill(pid, 'SIGKILL');
    });
    let stderr = '';
    let stdout = '';
    child.stdout!.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr!.on('data', (chunk) => (stderr += String(chunk)));

    const boundPort = await untilAsync('the cockpit URL', async () => /cockpit → http:\/\/localhost:(\d+)/.exec(stdout)?.[1]);
    const base = `http://127.0.0.1:${boundPort}`;
    const health = await untilAsync('the cockpit', async () => {
      const res = await fetch(`${base}/api/v1/health`).catch(() => undefined);
      return res?.ok ? res : undefined;
    });
    expect(health.status).toBe(200);
    // Since #467 PR 3 the warning is an activity line rather than a bare `console.warn`, so off
    // a terminal it is one logfmt row — and the module's own reason is carried in its `reason`
    // field, which is what the next assertion still reads.
    await untilAsync('the MCP warning', async () =>
      stderr.includes('event=mcp.unavailable') ? true : undefined,
    );
    expect(stderr).toMatch(/too long for a local socket/);
    // Still serving after the failure was reported.
    expect((await fetch(`${base}/api/v1/health`)).status).toBe(200);
  }, 60_000);

  it('uses the bound port when a neighbour owns the requested port', async () => {
    const neighbour = createServer((socket) => {
      socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"repoRoot":"neighbour-cockpit"}');
    });
    neighbour.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => neighbour.once('listening', resolve));
    const requested = (neighbour.address() as { port: number }).port;
    const home = join(tmp('xzc-'), 'h'.repeat(120));
    const repo = tmp('xzr-');
    const TSX = import.meta.resolve('tsx');
    const CLI = fileURLToPath(new URL('../index.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', TSX, CLI, 'serve', '--no-open', '--port', String(requested)], {
      cwd: repo,
      env: { ...process.env, XEZ_HOME: home, XEZ_DRY_RUN: '1', XEZ_SKILLS_AUTO_UPDATE: '0', XEZ_NO_BANNER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid;
    closers.push(() => {
      if (pid !== undefined) process.kill(pid, 'SIGKILL');
      neighbour.close();
    });
    let stdout = '';
    child.stdout!.on('data', (chunk) => (stdout += String(chunk)));
    const port = await untilAsync('the cockpit URL after the requested port was taken', async () => /cockpit → http:\/\/localhost:(\d+)/.exec(stdout)?.[1]);
    expect(Number(port)).not.toBe(requested);
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/v1/health`)).json()) as { repoRoot?: string };
    expect(health.repoRoot).toBe(realpathSync(repo));
  }, 60_000);
});

async function untilAsync<T>(what: string, probe: () => Promise<T | undefined>, ms = 40_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
