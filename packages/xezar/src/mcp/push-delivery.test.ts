import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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
 * task agent), the real `runBridge` a client spawns as `xez mcp`, and a leader attached through the
 * real `POST /api/v1/mcp/leader`.
 *
 * xezar starts no agent process (owner decision on #311): the person runs their own leader and
 * connects it over MCP, and the only leader an event can be PUSHED to is one they attach — today an
 * OpenCode `serve` session. The one stand-in here is that server: a fake `opencode serve` that
 * answers the routes the OpenCode adapter calls and records every `prompt_async`. It never answers
 * as a model, so nothing here is a model REACTION (A-19's second half) — only delivery: rows that
 * left the journal and reached the leader's session. The leader's MCP tool calls go through the
 * in-process bridge, the connection that owns the project, as OpenCode's own `xezar` MCP server would.
 *
 * Before #309 nothing in the service constructed an `EventController` or any adapter, so every
 * assertion on a delivered row below fails there — and the route answers 404.
 */

const VERSION = '9.9.9-push';
const SESSION = 'ses_pushdelivery00000000001';
const tempDirs: string[] = [];
const closers: Array<() => unknown> = [];
const saved = {
  home: process.env.XEZ_HOME,
  dryRun: process.env.XEZ_DRY_RUN,
  remote: process.env.XEZ_REMOTE,
  claudeBin: process.env.XEZ_CLAUDE_BIN,
  codexBin: process.env.XEZ_CODEX_BIN,
};

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
  for (const [key, value] of [
    ['XEZ_HOME', saved.home],
    ['XEZ_DRY_RUN', saved.dryRun],
    ['XEZ_REMOTE', saved.remote],
    ['XEZ_CLAUDE_BIN', saved.claudeBin],
    ['XEZ_CODEX_BIN', saved.codexBin],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Submission {
  tools?: Record<string, boolean>;
  parts: Array<{ text: string; metadata?: { xezar?: { rows: string[] } } }>;
}

/**
 * The OpenCode session the person runs (`opencode serve`), as far as the adapter talks to it: the
 * session in the project folder, its `/event` stream, idle status, no pending prompt, and
 * `prompt_async`. Records every submission; never starts a turn.
 */
async function fakeOpenCode(directory: string) {
  const submissions: Submission[] = [];
  /**
   * `failPrompts`: answer every submission with a 500 — delivery failing for no nameable reason.
   * `hangPrompts`: accept every submission and never answer — a paused or hung `opencode serve`.
   */
  const control = { failPrompts: false, hangPrompts: false };
  const streams = new Set<ServerResponse>();
  const history: unknown[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route = `${req.method} ${url.pathname}`;
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      };
      if (route === 'GET /event') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
        streams.add(res);
        res.on('close', () => streams.delete(res));
        return;
      }
      if (route === `GET /session/${SESSION}`) return json(200, { id: SESSION, directory });
      if (route === 'GET /session/status') return json(200, {});
      if (route === 'GET /permission' || route === 'GET /question') return json(200, []);
      if (route === `GET /session/${SESSION}/message`) return json(200, history);
      if (route === `POST /session/${SESSION}/prompt_async`) {
        if (control.failPrompts) return json(500, { name: 'UnknownError' });
        if (control.hangPrompts) return; // accepted, never answered: the client's own timeout ends it
        const body = JSON.parse(raw) as Submission;
        submissions.push(body);
        history.push({ info: { id: `msg_${submissions.length}`, role: 'user' }, parts: body.parts });
        res.writeHead(204).end();
        return;
      }
      json(404, { name: 'NotFoundError', route });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    for (const stream of streams) stream.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    submissions,
    control,
    /** The event ids each submission carried, from its own `metadata.xezar` marker. */
    delivered: (): string[] => submissions.flatMap((s) => s.parts.flatMap((p) => (p.metadata?.xezar?.rows ?? []).map((key) => key.split('@')[0]!))),
  };
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

async function serve(c: Cockpit) {
  const handle = await startMcpService({
    projectId: c.id,
    version: VERSION,
    service: c.app,
    store: c.store,
    warn: () => {},
    leader: { heartbeatMs: 500 },
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

const attach = (c: Cockpit, baseUrl: string) => c.human('POST', '/mcp/leader', { action: 'attach', client: 'opencode', baseUrl, sessionId: SESSION });

describe('#309 — push delivery in the running service (A-19 delivery, A-20 no-echo-loop)', () => {
  it('delivers a human change and a task outcome to the OpenCode leader the person attached, and never the leader’s own echo', async () => {
    const c = await cockpit();
    const oc = await fakeOpenCode(c.root);
    await serve(c);

    // Nothing is attached yet: the route says so, and why.
    expect(await c.status()).toMatchObject({ available: true, leader: null, delivery: null, blocker: { code: 'no-leader-session' } });

    // The leader's MCP connection opens its session: it owns the project, and a controller follows the journal for it.
    const leader = agent(c.root);
    okResult(await leader.call('leader_events', { action: 'read' }));
    await until('the owner session’s controller', async () => ((await c.status()) as { delivery: { state: string } | null }).delivery?.state === 'idle' || undefined);

    // The person tells xezar where their OpenCode leader runs.
    const attached = await attach(c, oc.baseUrl);
    expect(attached.status).toBe(200);
    expect(await attached.json()).toMatchObject({ available: true, leader: { client: 'opencode', state: 'attached' }, blocker: null });

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

    // Delivery: the human change and the task outcome reached the attached session.
    const got = await until('both rows to reach the leader', () => {
      const ids = oc.delivered();
      return ids.includes(human!.eventId) && ids.includes(done!.eventId) ? ids : undefined;
    });
    // The echo guard held: no row the leader itself caused was delivered to it.
    const ownRows = journal.filter((row) => row.origin === 'leader');
    expect(ownRows.length).toBeGreaterThan(0);
    for (const row of ownRows) expect(got, `own echo ${row.kind} was delivered`).not.toContain(row.eventId);
    // Every submission allows the turn only the xezar tools (#309 F-1).
    for (const submission of oc.submissions) expect(submission.tools).toEqual({ '*': false, 'xezar_*': true });

    // No loop and no repeat: once everything is delivered, delivery goes quiet across several
    // heartbeats (500 ms here), each row was submitted once, and no log, token or presentation
    // event ever became a delivered row.
    const settled = await until('delivery to settle', async () => {
      const s = await c.status();
      return s.available && s.delivery?.state === 'idle' && s.delivery.deliveredSeq === s.delivery.latestSeq ? s : undefined;
    });
    expect(settled.available && settled.delivery?.deliveredSeq).toBe(journalRows(c.dataDir).at(-1)!.journalSeq);
    const writes = oc.submissions.length;
    await new Promise((r) => setTimeout(r, 2_000));
    expect(oc.submissions).toHaveLength(writes);
    const all = oc.delivered();
    expect(new Set(all).size).toBe(all.length);
    const byId = new Map(journalRows(c.dataDir).map((row) => [row.eventId, row]));
    for (const id of all) expect(PRESENTATION_EVENT_KINDS as readonly string[]).not.toContain(byId.get(id)?.kind);
    // Delivery is not reaction: the fake never answers as a model, so nothing is recorded as one.
    expect(settled.available && settled.delivery?.reactedSeq).toBeLessThan(done!.journalSeq);
  }, 60_000);

  it('keeps events while nothing is attached, says why, and delivers them once a leader is attached', async () => {
    const c = await cockpit();
    const oc = await fakeOpenCode(c.root);
    await serve(c);

    // A client the person opened (Claude Code or Codex in a terminal) owns the project: delivery is on,
    // but there is no address to push to.
    const own = agent(c.root);
    okResult(await own.call('leader_events', { action: 'read' }));
    expect((await c.human('PUT', '/config', { baseBranch: 'develop' })).status).toBe(200);
    const kept = journalRows(c.dataDir).find((row) => row.kind === 'config.changed')!;
    const blocked = await until('the controller to report the blocker', async () => {
      const s = await c.status();
      return s.available && s.delivery?.state === 'disconnected' ? s : undefined;
    });
    expect(blocked).toMatchObject({ leader: null, blocker: { code: 'no-leader-session' } });
    expect(blocked.available && blocked.blocker?.message).toMatch(/leader_events/);
    expect(blocked.available && blocked.delivery?.deliveredSeq).toBeLessThan(kept.journalSeq);
    // The pull still works for that leader: the kept row is there to read.
    const read = okResult(await own.call('leader_events', { action: 'read' }));
    expect(JSON.stringify(read.structuredContent)).toContain(kept.eventId);

    // Hosted mode cannot attach a leader at all.
    process.env.XEZ_REMOTE = '1';
    expect((await attach(c, oc.baseUrl)).status).toBe(409);
    delete process.env.XEZ_REMOTE;
    expect(oc.submissions).toHaveLength(0);

    // Attaching delivers exactly what was never acknowledged, at once.
    expect((await attach(c, oc.baseUrl)).status).toBe(200);
    await until('the kept row to reach the leader', () => (oc.delivered().includes(kept.eventId) ? true : undefined));

    // Detaching lets the session go; the owner keeps its controller, and the blocker is back.
    const stopped = await c.human('POST', '/mcp/leader', { action: 'stop' });
    expect(await stopped.json()).toMatchObject({ available: true, leader: null, blocker: { code: 'no-leader-session' } });
  }, 60_000);

  it('#331: says why nothing is delivered while a leader is attached but no MCP session owns the project', async () => {
    const c = await cockpit();
    const oc = await fakeOpenCode(c.root);
    await serve(c);

    // The ordinary first state: OpenCode connects its MCP server lazily, so attach comes first.
    expect((await attach(c, oc.baseUrl)).status).toBe(200);
    const before = await c.status();
    expect(before).toMatchObject({ available: true, leader: { client: 'opencode', state: 'attached' }, delivery: null });
    expect(before.available && before.blocker).toMatchObject({ code: 'no-owner-session' });
    expect(before.available && before.blocker?.message).toMatch(/no MCP session owns this project/);

    // The leader's MCP connection opens: now a controller follows the journal, and nothing is wrong.
    const leader = agent(c.root);
    okResult(await leader.call('leader_events', { action: 'read' }));
    const after = await until('the controller to start', async () => {
      const s = await c.status();
      return s.available && s.delivery?.state === 'idle' ? s : undefined;
    });
    expect(after).toMatchObject({ leader: { client: 'opencode', state: 'attached' }, blocker: null });
  });

  it('#332: a new MCP session does not push again what the leader acknowledged through leader_events', async () => {
    const c = await cockpit();
    const oc = await fakeOpenCode(c.root);
    await serve(c);

    // Session 1 owns the project and the leader is attached: a human change is pushed.
    const first = agent(c.root);
    okResult(await first.call('leader_events', { action: 'read' }));
    await until('session 1’s controller', async () => ((await c.status()) as { delivery: { state: string } | null }).delivery?.state === 'idle' || undefined);
    expect((await attach(c, oc.baseUrl)).status).toBe(200);
    expect((await c.human('PUT', '/config', { baseBranch: 'develop' })).status).toBe(200);
    const a = journalRows(c.dataDir).find((row) => row.kind === 'config.changed')!;
    await until('row A to be pushed', () => (oc.delivered().includes(a.eventId) ? true : undefined));

    // The leader takes it into account and acknowledges it — through the pull tool, the only ack it has.
    const read = okResult(await first.call('leader_events', { action: 'read' }));
    const cursor = (read.structuredContent as { nextCursor: string }).nextCursor;
    const acked = okResult(await first.call('leader_events', { action: 'ack', cursor }));
    expect(acked.structuredContent).toMatchObject({ status: 'acked', ackedSeq: a.journalSeq });

    // Session 1 ends. The person opens a fresh OpenCode conversation and attaches it; its MCP session
    // opens. A fresh conversation has no memory of what the old one was sent, so before #332 every
    // retained row from ackedSeq 0 was pushed into it again — a model turn the user pays for.
    await first.end();
    await until('session 1’s controller to end', async () => ((await c.status()) as { delivery: unknown }).delivery === null || undefined);
    const fresh = await fakeOpenCode(c.root);
    expect((await attach(c, fresh.baseUrl)).status).toBe(200);
    const second = agent(c.root);
    okResult(await second.call('leader_events', { action: 'read' }));
    await until('session 2’s controller', async () => ((await c.status()) as { delivery: { state: string } | null }).delivery?.state === 'idle' || undefined);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(fresh.delivered(), 'an acknowledged row was pushed again').not.toContain(a.eventId);
    expect(await c.status()).toMatchObject({ delivery: { ackedSeq: a.journalSeq } });

    // And session 2 still pushes what is new, once.
    expect((await c.human('PUT', '/config', { baseBranch: 'main' })).status).toBe(200);
    const b = journalRows(c.dataDir).filter((row) => row.kind === 'config.changed').at(-1)!;
    await until('row B to be pushed', () => (fresh.delivered().includes(b.eventId) ? true : undefined));
    expect(fresh.delivered()).toEqual([b.eventId]);
  }, 60_000);

  it('QA on #311: the first session pushes what arrived before it, and no cursor claims what did not happen — across a restart too', async () => {
    const c = await cockpit();
    const oc = await fakeOpenCode(c.root);
    let service = await serve(c);

    // QA's exact state: a fresh project, a leader attached, two cockpit changes, THEN the first MCP session.
    expect((await attach(c, oc.baseUrl)).status).toBe(200);
    expect((await c.human('PUT', '/config', { baseBranch: 'develop' })).status).toBe(200);
    expect((await c.human('PUT', '/config', { baseBranch: 'main' })).status).toBe(200);
    const rows = journalRows(c.dataDir).filter((row) => row.kind === 'config.changed');
    expect(rows.map((row) => row.journalSeq)).toEqual([1, 2]);

    const leader = agent(c.root);
    const read = okResult(await leader.call('leader_events', { action: 'read' }));
    // The rows arrived after the leader's record began, so they are owed — and they are pushed.
    await until('both rows to be pushed', () => (rows.every((row) => oc.delivered().includes(row.eventId)) ? true : undefined));
    const settled = await until('delivery to settle', async () => {
      const st = await c.status();
      return st.available && st.delivery?.state === 'idle' && st.delivery.deliveredSeq === 2 ? st : undefined;
    });
    // Delivered: yes, really. Acknowledged: no — nobody called ack. Reacted: no — the fake never answers as a model.
    expect(settled.available && settled.delivery).toMatchObject({ deliveredSeq: 2, ackedSeq: 0, reactedSeq: 0 });
    // One acknowledgement: the pull tool's record and the push status say the same thing.
    expect((read.structuredContent as { position: { ackedSeq: number } }).position.ackedSeq).toBe(0);

    // A restart keeps them agreeing: history stays history, and nothing is invented.
    await leader.end();
    service.close();
    service = await serve(c);
    const again = agent(c.root);
    const after = okResult(await again.call('leader_events', { action: 'read' }));
    const resumed = await until('the new session’s controller', async () => {
      const st = await c.status();
      return st.available && st.delivery ? st : undefined;
    });
    expect(resumed.available && resumed.delivery).toMatchObject({ deliveredSeq: 2, ackedSeq: 0, reactedSeq: 0 });
    expect((after.structuredContent as { position: { ackedSeq: number; reactedSeq: number } }).position).toMatchObject({ ackedSeq: 0, reactedSeq: 0 });
  }, 60_000);

  it('QA on #311: rows the leader acknowledged through leader_events while nothing was attached are not pushed later', async () => {
    const c = await cockpit();
    const oc = await fakeOpenCode(c.root);
    await serve(c);

    // A session owns the project and nothing is attached: a change waits in the journal.
    const leader = agent(c.root);
    okResult(await leader.call('leader_events', { action: 'read' }));
    expect((await c.human('PUT', '/config', { baseBranch: 'develop' })).status).toBe(200);
    const r = journalRows(c.dataDir).find((row) => row.kind === 'config.changed')!;
    await until('the controller to hold it', async () => ((await c.status()) as { delivery: { state: string } | null }).delivery?.state === 'disconnected' || undefined);

    // The leader reads it and acknowledges it, by pull — mid-session, after this controller started.
    const read = okResult(await leader.call('leader_events', { action: 'read' }));
    okResult(await leader.call('leader_events', { action: 'ack', cursor: (read.structuredContent as { nextCursor: string }).nextCursor }));

    // Now a leader is attached. The acknowledged row is not owed any more; a new one is.
    expect((await attach(c, oc.baseUrl)).status).toBe(200);
    expect((await c.human('PUT', '/config', { baseBranch: 'main' })).status).toBe(200);
    const s2 = journalRows(c.dataDir).filter((row) => row.kind === 'config.changed').at(-1)!;
    await until('the new row to be pushed', () => (oc.delivered().includes(s2.eventId) ? true : undefined));
    expect(oc.delivered(), 'a row the leader acknowledged was pushed').toEqual([s2.eventId]);
    expect(await c.status()).toMatchObject({ delivery: { ackedSeq: r.journalSeq } });
  }, 60_000);

  it('QA on #311: a leader record created after rows already exist replays none of them, and claims none of them', async () => {
    const c = await cockpit();
    const oc = await fakeOpenCode(c.root);
    let service = await serve(c);
    expect((await c.human('PUT', '/config', { baseBranch: 'develop' })).status).toBe(200);
    expect((await c.human('PUT', '/config', { baseBranch: 'main' })).status).toBe(200);
    service.close();
    // The leader's record is gone (an upgrade from before it existed, or a person deleted it).
    rmSync(join(c.dataDir, 'mcp', 'leader-cursors.json'));
    service = await serve(c);

    expect((await attach(c, oc.baseUrl)).status).toBe(200);
    const leader = agent(c.root);
    const read = okResult(await leader.call('leader_events', { action: 'read' }));
    expect((read.structuredContent as { fresh: boolean; position: unknown }).fresh).toBe(true);
    // A new leader reads current state; the backlog is not owed, and not pretended to be acknowledged.
    expect((read.structuredContent as { position: unknown }).position).toEqual({ deliveredSeq: 0, ackedSeq: 0, reactedSeq: 0 });
    await until('the controller', async () => ((await c.status()) as { delivery: { state: string } | null }).delivery?.state === 'idle' || undefined);
    expect(await c.status()).toMatchObject({ delivery: { deliveredSeq: 0, ackedSeq: 0, reactedSeq: 0, latestSeq: 2 } });

    expect((await c.human('PUT', '/config', { baseBranch: 'develop' })).status).toBe(200);
    const next = journalRows(c.dataDir).at(-1)!;
    await until('the new row to be pushed', () => (oc.delivered().includes(next.eventId) ? true : undefined));
    expect(oc.delivered()).toEqual([next.eventId]);
  }, 60_000);

  it('QA on #311: a delivery that keeps failing for no nameable reason is a blocker, never "nothing wrong"', async () => {
    const c = await cockpit();
    const oc = await fakeOpenCode(c.root);
    await serve(c);
    const leader = agent(c.root);
    okResult(await leader.call('leader_events', { action: 'read' }));
    expect((await attach(c, oc.baseUrl)).status).toBe(200);

    oc.control.failPrompts = true;
    expect((await c.human('PUT', '/config', { baseBranch: 'develop' })).status).toBe(200);
    const failing = await until('the controller to give up this round', async () => {
      const st = await c.status();
      return st.available && st.delivery?.state === 'disconnected' ? st : undefined;
    });
    expect(failing.available && failing.blocker).toMatchObject({ code: 'delivery-failing' });

    // It recovers on its own at the next heartbeat, and the blocker goes with it.
    oc.control.failPrompts = false;
    const ok = await until('delivery to recover', async () => {
      const st = await c.status();
      return st.available && st.delivery?.state === 'idle' && st.delivery.deliveredSeq === st.delivery.latestSeq ? st : undefined;
    });
    expect(ok.available && ok.blocker).toBeNull();
  }, 60_000);

  it('QA on #311, round four: a hung leader is a blocker in every state a retry passes through, not only disconnected', async () => {
    const c = await cockpit();
    const oc = await fakeOpenCode(c.root);
    await serve(c);
    const leader = agent(c.root);
    okResult(await leader.call('leader_events', { action: 'read' }));
    expect((await attach(c, oc.baseUrl)).status).toBe(200);

    // SIGSTOP in miniature: the server takes the request and never answers.
    oc.control.hangPrompts = true;
    expect((await c.human('PUT', '/config', { baseBranch: 'develop' })).status).toBe(200);
    // The first attempt times out after one heartbeat (500 ms here). From then on the controller KNOWS.
    await until('the first attempt to fail', async () => ((await c.status()) as { blocker: { code: string } | null }).blocker?.code === 'delivery-failing' || undefined);
    const samples: Array<{ state: string | undefined; blocker: string | null }> = [];
    const end = Date.now() + 2_500;
    while (Date.now() < end) {
      const st = await c.status();
      if (st.available) samples.push({ state: st.delivery?.state, blocker: st.blocker?.code ?? null });
      await new Promise((r) => setTimeout(r, 20));
    }
    // Every read, in every state, names the failure — and the reads really span the retry states.
    expect(samples.filter((sample) => sample.blocker !== 'delivery-failing'), JSON.stringify(samples.slice(0, 5))).toEqual([]);
    expect(new Set(samples.map((sample) => sample.state))).toContain('recovering');

    // The server comes back: the row goes through, and the blocker goes with the failure.
    oc.control.hangPrompts = false;
    const ok = await until('delivery to recover', async () => {
      const st = await c.status();
      return st.available && st.delivery?.deliveredSeq === st.delivery?.latestSeq && st.blocker === null ? st : undefined;
    });
    expect(ok.available && ok.delivery?.deliveredSeq).toBe(1);
  }, 60_000);

  it('QA on #311, round four: deliveredSeq counts only rows really handed over — never the leader’s own echo', async () => {
    const c = await cockpit();
    const oc = await fakeOpenCode(c.root);
    await serve(c);
    const leader = agent(c.root);
    okResult(await leader.call('leader_events', { action: 'read' }));
    await until('the controller', async () => ((await c.status()) as { delivery: { state: string } | null }).delivery?.state === 'idle' || undefined);
    expect((await attach(c, oc.baseUrl)).status).toBe(200);

    // The leader changes the configuration itself: its echo is settled, never sent, never counted.
    okResult(await leader.call('project_config', { action: 'set_config', config: { baseBranch: 'develop' } }));
    const echo = journalRows(c.dataDir).find((row) => row.kind === 'config.changed' && row.origin === 'leader')!;
    await new Promise((r) => setTimeout(r, 1_200));
    expect(oc.submissions).toHaveLength(0);
    expect(await c.status()).toMatchObject({ delivery: { state: 'idle', deliveredSeq: 0, latestSeq: echo.journalSeq }, blocker: null });

    // A person's change right after it is handed over — and counted.
    expect((await c.human('PUT', '/config', { baseBranch: 'main' })).status).toBe(200);
    const human = journalRows(c.dataDir).at(-1)!;
    await until('the human row to be pushed', () => (oc.delivered().includes(human.eventId) ? true : undefined));
    await until('the count to follow', async () => ((await c.status()) as { delivery: { deliveredSeq: number } }).delivery.deliveredSeq === human.journalSeq || undefined);
    expect(oc.delivered()).toEqual([human.eventId]);
  }, 60_000);

  it('starts no agent process: `start` and `resume` do not exist, for any client (owner decision on #311)', async () => {
    // If a spawn path ever comes back, these stand-ins record it.
    const dir = tmp('xzs-');
    const marks = { claude: join(dir, 'claude-ran'), codex: join(dir, 'codex-ran') };
    for (const [name, mark] of Object.entries(marks)) {
      const bin = join(dir, name);
      writeFileSync(bin, `#!/bin/sh\ntouch ${JSON.stringify(mark)}\nexit 1\n`, 'utf8');
      chmodSync(bin, 0o755);
    }
    process.env.XEZ_CLAUDE_BIN = join(dir, 'claude');
    process.env.XEZ_CODEX_BIN = join(dir, 'codex');
    const c = await cockpit();
    await serve(c);

    for (const body of [
      { action: 'start', client: 'claude-code' },
      { action: 'start', client: 'codex' },
      { action: 'start', client: 'opencode' },
      { action: 'resume', client: 'claude-code' },
    ]) {
      expect((await c.human('POST', '/mcp/leader', body)).status, JSON.stringify(body)).toBe(400);
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(marks.claude)).toBe(false);
    expect(existsSync(marks.codex)).toBe(false);
    expect(await c.status()).toMatchObject({ available: true, leader: null });
  });

  it('says the journal cannot be written, and refuses to attach a leader that could never hear an event (O-3)', async () => {
    const c = await cockpit();
    const oc = await fakeOpenCode(c.root);
    // QA's reproduction: the journal's folder is a file, so no row can ever be recorded.
    mkdirSync(c.dataDir, { recursive: true });
    writeFileSync(join(c.dataDir, 'mcp'), 'not a folder\n', 'utf8');
    await serve(c);

    expect(await c.status()).toMatchObject({ available: true, leader: null, blocker: { code: 'journal-unwritable' } });
    const refused = await attach(c, oc.baseUrl);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/cannot write this project’s event journal/);
    expect(oc.submissions).toHaveLength(0);
  });

  it('ends delivery with the service, and reports no delivery for a project whose MCP service is not running', async () => {
    const c = await cockpit();
    expect(await c.status()).toEqual({ available: false, reason: expect.any(String) });
    expect((await c.human('POST', '/mcp/leader', { action: 'stop' })).status).toBe(409);

    const handle = await serve(c);
    expect((await c.status()).available).toBe(true);
    handle.close();
    expect(await c.status()).toEqual({ available: false, reason: expect.any(String) });
  });
});
