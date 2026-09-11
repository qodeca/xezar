import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { McpJournalRow, McpLeaderStatus } from '@qodeca/xezar-contract';
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
import { PRESENTATION_EVENT_KINDS } from './echo-guard.ts';
import { resolveMcpTarget, startMcpService } from './index.ts';
import { LineFramer, encodeFrame, type McpToolResult } from './ipc.ts';
import { tools } from './tools/index.ts';

/**
 * #309 — push delivery against the REAL composed service: `startMcpService` exactly as `xezar
 * serve` calls it, over a real `createApp`, store and run manager (`XEZ_DRY_RUN=1` mocks only the
 * task agent), the real `runBridge` a client spawns as `xez mcp`, and a leader started through the
 * real `POST /api/v1/mcp/leader`.
 *
 * The one stand-in is the `claude` binary the Claude Code adapter spawns for the leader: a script
 * that records every stdin line and echoes it back as Claude Code's `--replay-user-messages` does.
 * It never answers as a model, so nothing here is a model REACTION (A-19's second half) — only
 * delivery: rows that left the journal and reached the leader session's stdin. The leader's MCP
 * tool calls go through the in-process bridge, the connection that owns the project; a real
 * `claude` would spawn that bridge itself from the `--mcp-config` this test also checks.
 *
 * Before #309 nothing in the service constructed an `EventController` or any adapter, so every
 * assertion on a delivered row below fails there — and the route answers 404.
 */

const VERSION = '9.9.9-push';
const tempDirs: string[] = [];
const closers: Array<() => unknown> = [];
const saved = { home: process.env.XEZ_HOME, dryRun: process.env.XEZ_DRY_RUN, remote: process.env.XEZ_REMOTE };

// A short home under /tmp: the socket path must stay under the OS limit (D-01 E5).
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  tempDirs.push(dir);
  return dir;
};

beforeEach(() => {
  process.env.XEZ_HOME = tmp('xzd-');
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

/** The `claude` the adapter spawns: records argv and every stdin line, echoes each as a replay. */
function standInClaude(): { bin: string; received: () => string[]; argv: () => string[] | undefined } {
  const dir = tmp('xzc-');
  const script = join(dir, 'claude.mjs');
  const receivedPath = join(dir, 'received.ndjson');
  const argvPath = join(dir, 'argv.json');
  writeFileSync(
    script,
    `import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(${JSON.stringify(receivedPath)}, line + '\\n');
  const frame = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: 'user', isReplay: true, message: frame.message }) + '\\n');
});
`,
    'utf8',
  );
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, 'utf8');
  chmodSync(bin, 0o755);
  return {
    bin,
    received: () => (existsSync(receivedPath) ? readFileSync(receivedPath, 'utf8').split('\n').filter(Boolean) : []),
    argv: () => (existsSync(argvPath) ? (JSON.parse(readFileSync(argvPath, 'utf8')) as string[]) : undefined),
  };
}

/** The journal rows each message the leader received carries (one JSON row per line, after the header). */
function deliveredRows(lines: readonly string[]): McpJournalRow[] {
  return lines.flatMap((line) => {
    const text = (JSON.parse(line) as { message: { content: Array<{ text: string }> } }).message.content[0]!.text;
    return text
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as McpJournalRow);
  });
}

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
  const status = async (): Promise<McpLeaderStatus> => (await (await human('GET', '/mcp/leader')).json()) as McpLeaderStatus;
  return { root, id, store, app, human, status, dataDir: store.dataDir };
}
type Cockpit = Awaited<ReturnType<typeof cockpit>>;

const BRIDGE = { command: '/usr/bin/env', args: ['xez-under-test', 'mcp'] };

async function serve(c: Cockpit, claudeBin: string) {
  const handle = await startMcpService({
    projectId: c.id,
    version: VERSION,
    service: c.app,
    store: c.store,
    warn: () => {},
    leader: { claudeBin, bridge: BRIDGE, heartbeatMs: 500 },
  });
  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    handle.close();
  };
  closers.push(close);
  return { close };
}

/** A coding agent's MCP connection: the real stdio bridge with a tiny JSON-RPC client in front. */
function agent(root: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<number, (message: { result?: McpToolResult }) => void>();
  const framer = new LineFramer(
    (line) => {
      const message = JSON.parse(line) as { id: number; result?: McpToolResult };
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    },
    () => {},
  );
  output.on('data', (chunk: Buffer) => framer.push(chunk));
  const done = runBridge({ input, output, version: VERSION, tools, resolveTarget: () => resolveMcpTarget(root) });
  let ended = false;
  const end = (): Promise<void> => {
    if (!ended) {
      ended = true;
      input.end();
    }
    return done;
  };
  closers.push(end);
  let next = 1;
  const call = (name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
    const id = next++;
    return new Promise((resolve) => {
      pending.set(id, (message) => resolve(message.result as McpToolResult));
      input.write(encodeFrame({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }));
    });
  };
  return { call, end };
}

const journalRows = (dataDir: string): McpJournalRow[] => {
  const path = join(dataDir, 'mcp', 'event-journal.ndjson');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as McpJournalRow);
};

async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const okResult = (result: McpToolResult): McpToolResult => {
  expect(result.isError, JSON.stringify(result)).toBeFalsy();
  return result;
};

describe('#309 — push delivery in the running service (A-19 delivery, A-20 no-echo-loop)', () => {
  it('delivers a human change and a task outcome to the leader xezar started, and never the leader’s own echo', async () => {
    const c = await cockpit();
    const claude = standInClaude();
    await serve(c, claude.bin);

    // Nothing is attached yet: the route says so, and why.
    expect(await c.status()).toMatchObject({ available: true, leader: null, delivery: null, blocker: { code: 'no-leader-session' } });

    // A person starts the leader. xezar spawns `claude -p` in stream-json mode with its own bridge.
    const started = await c.human('POST', '/mcp/leader', { action: 'start', client: 'claude-code' });
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ available: true, leader: { client: 'claude-code', state: 'running' }, blocker: null });
    const argv = await until('the leader to start', () => claude.argv());
    expect(argv).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--replay-user-messages', '--mcp-config']));
    const mcpConfig = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!) as { mcpServers: { xezar: { command: string; args: string[] } } };
    expect(mcpConfig.mcpServers.xezar).toMatchObject(BRIDGE);

    // The leader's MCP connection opens its session: it owns the project, and a controller follows the journal for it.
    const leader = agent(c.root);
    okResult(await leader.call('leader_events', { action: 'read' }));
    await until('the owner session’s controller', async () => ((await c.status()) as { delivery: { state: string } | null }).delivery?.state === 'idle' || undefined);

    // 1. The leader changes the configuration itself: its echo reaches the journal as origin `leader`.
    okResult(await leader.call('project_config', { action: 'set_config', config: { baseBranch: 'develop' } }));
    // 2. A person changes it back in the cockpit.
    expect((await c.human('PUT', '/config', { baseBranch: 'main' })).status).toBe(200);
    // 3. The leader starts a task under its own operation key; the task finishes on its own.
    const created = okResult(await leader.call('task_create', { action: 'start', operationId: 'op-push-delivery-1', prompt: 'mock:done a quick task' }));
    const runId = (created.structuredContent as { subject: { id: string } }).subject.id;
    await until('the task to finish', () => (c.store.getRun(runId)?.status === 'done' ? true : undefined));

    const journal = journalRows(c.dataDir);
    const echo = journal.find((row) => row.kind === 'config.changed' && row.origin === 'leader');
    const human = journal.find((row) => row.kind === 'config.changed' && row.origin === 'human');
    const done = journal.find((row) => row.kind === 'task.done' && row.subject.id === runId);
    expect(echo?.causedBy).toMatch(/^mcp-door\./);
    expect(human).toBeDefined();
    expect(done?.origin).toBe('system');

    // Delivery: the human change and the task outcome reached the leader session's stdin.
    const got = await until('both rows to reach the leader', () => {
      const ids = deliveredRows(claude.received()).map((row) => row.eventId);
      return ids.includes(human!.eventId) && ids.includes(done!.eventId) ? ids : undefined;
    });
    // The echo guard held: no row the leader itself caused was delivered to it.
    const ownRows = journal.filter((row) => row.origin === 'leader');
    expect(ownRows.length).toBeGreaterThan(0);
    for (const row of ownRows) expect(got, `own echo ${row.kind} was delivered`).not.toContain(row.eventId);

    // No loop and no repeat: once everything is delivered, delivery goes quiet across several
    // heartbeats (500 ms here), each row was written once, and no log, token or presentation
    // event ever became a delivered row.
    const settled = await until('delivery to settle', async () => {
      const s = await c.status();
      return s.available && s.delivery?.state === 'idle' && s.delivery.deliveredSeq === s.delivery.latestSeq ? s : undefined;
    });
    expect(settled.available && settled.delivery?.deliveredSeq).toBe(journalRows(c.dataDir).at(-1)!.journalSeq);
    const writes = claude.received().length;
    await new Promise((r) => setTimeout(r, 2_000));
    expect(claude.received()).toHaveLength(writes);
    const all = deliveredRows(claude.received());
    expect(new Set(all.map((row) => row.eventId)).size).toBe(all.length);
    for (const row of all) expect(PRESENTATION_EVENT_KINDS as readonly string[]).not.toContain(row.kind);
    // Delivery is not reaction: the stand-in never answers as a model, so nothing is recorded as one.
    expect(settled.available && settled.delivery?.reactedSeq).toBeLessThan(done!.journalSeq);
  }, 60_000);

  it('keeps events for a session xezar cannot wake, states why, and delivers them once a leader starts', async () => {
    const c = await cockpit();
    const claude = standInClaude();
    await serve(c, claude.bin);

    // A client the user opened themselves owns the project: delivery is on, but there is nobody to wake.
    const own = agent(c.root);
    okResult(await own.call('leader_events', { action: 'read' }));
    expect((await c.human('PUT', '/config', { baseBranch: 'develop' })).status).toBe(200);
    const kept = journalRows(c.dataDir).find((row) => row.kind === 'config.changed')!;
    const blocked = await until('the controller to report the blocker', async () => {
      const s = await c.status();
      return s.available && s.delivery?.state === 'disconnected' ? s : undefined;
    });
    expect(blocked).toMatchObject({ leader: null, blocker: { code: 'no-leader-session' } });
    expect(blocked.available && blocked.delivery?.deliveredSeq).toBeLessThan(kept.journalSeq);

    // xezar will not start a second leader beside it, and hosted mode cannot start one at all.
    const refused = await c.human('POST', '/mcp/leader', { action: 'start', client: 'claude-code' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/another MCP client owns this project/);
    process.env.XEZ_REMOTE = '1';
    expect((await c.human('POST', '/mcp/leader', { action: 'start', client: 'claude-code' })).status).toBe(409);
    delete process.env.XEZ_REMOTE;
    expect(claude.argv()).toBeUndefined();

    // The user's client exits: its controller ends with its connection, and the row is still owed.
    await own.end();
    await until('the controller to end', async () => ((await c.status()) as { delivery: unknown }).delivery === null || undefined);

    // A leader xezar starts picks up exactly what was never acknowledged.
    expect((await c.human('POST', '/mcp/leader', { action: 'start', client: 'claude-code' })).status).toBe(200);
    const leader = agent(c.root);
    okResult(await leader.call('leader_events', { action: 'read' }));
    await until('the kept row to reach the leader', () =>
      deliveredRows(claude.received()).some((row) => row.eventId === kept.eventId) ? true : undefined,
    );

    // Stopping the leader stops only the leader: the owner session keeps its controller.
    const stopped = await c.human('POST', '/mcp/leader', { action: 'stop' });
    expect(await stopped.json()).toMatchObject({ available: true, leader: null, blocker: { code: 'no-leader-session' } });
  }, 60_000);

  it('ends delivery with the service, and reports no delivery for a project whose MCP service is not running', async () => {
    const c = await cockpit();
    expect(await c.status()).toEqual({ available: false, reason: expect.any(String) });
    expect((await c.human('POST', '/mcp/leader', { action: 'stop' })).status).toBe(409);

    const handle = await serve(c, standInClaude().bin);
    expect((await c.status()).available).toBe(true);
    handle.close();
    expect(await c.status()).toEqual({ available: false, reason: expect.any(String) });
  });
});
