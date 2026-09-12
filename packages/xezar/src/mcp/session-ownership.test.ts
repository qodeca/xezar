import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  MCP_PROJECT_OCCUPIED_CODE,
  MCP_PROJECT_OCCUPIED_REASON,
  MCP_SESSION_EXPIRED_CODE,
  MCP_SESSION_EXPIRED_REASON,
  mcpProjectOccupiedErrorSchema,
} from '@qodeca/xezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectDataDir } from '../project-data-paths.ts';
import { RunStore } from '../runs/store.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { WorkspaceEventBus, createApp } from '../server/server.ts';
import { RunManager } from '../workflows/run.ts';
import { OWNER_CLAIM_DIR, OWNER_LEASE_MS, ProjectOwnership } from '../workspace/project-owner.ts';
import { registerProject } from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { runBridge } from './bridge.ts';
import { resolveMcpTarget, startMcpService, type StartMcpServiceOptions } from './index.ts';
import { IPC_PROTOCOL_VERSION, LineFramer, encodeFrame, type McpToolResult } from './ipc.ts';
import { runVersion } from './stale-write.ts';
import { tools } from './tools/index.ts';
import { withOperationId } from './tools/operation-id.testkit.ts';

/**
 * #302 — exclusive ownership over a LIVE MCP session (A-17, A-18, the exclusivity half of A-23).
 *
 * Everything here drives the real composed service (`startMcpService` over a real `createApp`,
 * store and run manager; `XEZ_DRY_RUN=1` mocks only the agent CLI) through the real `runBridge`, the
 * same code `xez mcp` runs — or, for the process-death case, a real separate process holding a
 * session on the real socket. The rules under test are D-02's, not this file's:
 *
 * - one owner per project; a second logical client is refused with project-occupied (D-02 § 4);
 * - the owner's own concurrent requests are not additional clients; other projects are unaffected;
 * - model silence releases nothing — only confirmed termination or the lease does (D-02.4, D-02.5);
 * - a stale owner is fenced with session-expired and must reconnect (D-02.3, D-02.6);
 * - a service restart ends every session and never makes two owners (D-02 § 5);
 * - a started task keeps running through all of it (N-05, D-02.7).
 */

const VERSION = '9.9.9-owner';
const tempDirs: string[] = [];
const closers: Array<() => unknown> = [];
const saved = { home: process.env.XEZ_HOME, dryRun: process.env.XEZ_DRY_RUN };

// A short home under /tmp: the socket path must stay under the OS limit (D-01 E5).
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  tempDirs.push(dir);
  return dir;
};

beforeEach(() => {
  process.env.XEZ_HOME = tmp('xzo-');
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
  return { root, id, store, manager, app, dataDir: store.dataDir };
}
type Cockpit = Awaited<ReturnType<typeof cockpit>>;

/** The composed MCP service for a project; `close()` is a service shutdown. */
async function serve(c: Cockpit, extra: Partial<StartMcpServiceOptions> = {}): Promise<{ close(): void }> {
  const handle = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store, warn: () => {}, ...extra });
  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    handle.close();
  };
  closers.push(close);
  return { close };
}

interface RpcMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

/** A coding agent: the real stdio bridge, with a tiny JSON-RPC client in front of it. */
function agent(root: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<number, (message: RpcMessage) => void>();
  const framer = new LineFramer(
    (line) => {
      const message = JSON.parse(line) as RpcMessage;
      if (typeof message.id === 'number') {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
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
  const request = (method: string, params?: unknown): Promise<RpcMessage> => {
    const id = next++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      input.write(encodeFrame({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
    });
  };
  return {
    initialize: () => request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'owner-test', version: '0' } }),
    // Every mutating action takes a fresh operation key (#264); a case about a replay passes its own.
    call: (name: string, args: Record<string, unknown> = {}) => request('tools/call', { name, arguments: withOperationId(name, args) }),
    /** The client application exits: its stdin closes. */
    end,
  };
}

const isOccupied = (m: RpcMessage): boolean =>
  m.error?.code === MCP_PROJECT_OCCUPIED_CODE && m.error.data?.reason === MCP_PROJECT_OCCUPIED_REASON;
const isExpired = (m: RpcMessage): boolean =>
  m.error?.code === MCP_SESSION_EXPIRED_CODE && m.error.data?.reason === MCP_SESSION_EXPIRED_REASON;
const resultOf = (m: RpcMessage): McpToolResult => {
  expect(m.error, JSON.stringify(m)).toBeUndefined();
  return m.result as unknown as McpToolResult;
};
const textOf = (m: RpcMessage): string => (resultOf(m).content[0] as { text: string }).text;

async function until<T>(what: string, probe: () => T | undefined, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The owner claims on disk — the service's own record of who holds the project (D-02.8). */
function claims(c: Cockpit): Array<{ name: string; token: string; pid: number; host: string }> {
  const dir = join(c.dataDir, OWNER_CLAIM_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.map((name) => ({ name, ...(JSON.parse(readFileSync(join(dir, name), 'utf8')) as { token: string; pid: number; host: string }) }));
}

/** Start a slow dry-run task through the owner; it stays `running` for about 25 s. */
async function startSlowTask(c: Cockpit, owner: ReturnType<typeof agent>): Promise<string> {
  const started = await owner.call('task_create', { action: 'start', operationId: `op-owner-${randomUUID()}`, prompt: 'mock:slow a long task' });
  const runId = ((resultOf(started).structuredContent as { subject: { id: string } }).subject).id;
  await until('the task to run', () => (c.store.getRun(runId)?.status === 'running' ? true : undefined));
  return runId;
}

describe('A-17 — only the competing owner is refused', () => {
  it('refuses a second logical client with the occupied error, gives it no tool access, and tells it nothing about the owner', async () => {
    const c = await cockpit();
    await serve(c);
    const run = c.store.createRun({ title: 'a task', workflow: 'quick-task', task: 't', steps: [] });
    const owner = agent(c.root);
    expect(resultOf(await owner.initialize())).toMatchObject({ serverInfo: { name: 'xezar' } });
    const [claim] = claims(c);
    expect(claim, 'the owner holds a claim').toBeDefined();

    const second = agent(c.root);
    const refused = await second.initialize();
    expect(isOccupied(refused), JSON.stringify(refused)).toBe(true);
    // N-01, F-12, F-15: exactly the contract's strict shape — no session id, token, pid or host.
    expect(mcpProjectOccupiedErrorSchema.safeParse(refused.error).success).toBe(true);
    expect(refused.error!.data).toEqual({ reason: MCP_PROJECT_OCCUPIED_REASON, projectId: c.id, retryable: true });
    for (const secret of [claim!.token, claim!.name, String(claim!.pid), claim!.host]) expect(JSON.stringify(refused)).not.toContain(secret);

    // No tool access: its reads and its writes are refused and never run.
    expect(isExpired(await second.call('health'))).toBe(true);
    const write = await second.call('organise_work', { action: 'pin', runId: run.id, expectedVersion: runVersion(c.store, run.id) });
    expect(isExpired(write), JSON.stringify(write)).toBe(true);
    expect(c.store.getRun(run.id)?.pinned).toBeFalsy();

    // The owner is untouched, and its many requests at once are not additional clients.
    const burst = await Promise.all(Array.from({ length: 20 }, () => owner.call('task_read', { view: 'list', limit: 1 })));
    for (const answer of burst) expect(resultOf(answer).isError, JSON.stringify(answer)).toBeFalsy();
    const pinned = await owner.call('organise_work', { action: 'pin', runId: run.id, expectedVersion: runVersion(c.store, run.id) });
    expect(resultOf(pinned).isError, JSON.stringify(pinned)).toBeFalsy();
    expect(c.store.getRun(run.id)?.pinned).toBe(true);
    // Still exactly one owner on disk.
    expect(claims(c)).toHaveLength(1);
  });

  it('leaves another project alone: it has its own socket and its own owner', async () => {
    const a = await cockpit();
    const b = await cockpit();
    await serve(a);
    await serve(b);
    const ownerA = agent(a.root);
    expect(resultOf(await ownerA.initialize())).toBeDefined();
    const clientB = agent(b.root);
    expect(resultOf(await clientB.initialize())).toBeDefined();
    expect(textOf(await clientB.call('health'))).toContain(`(${b.id})`);
    expect(textOf(await ownerA.call('health'))).toContain(`(${a.id})`);
    expect(isOccupied(await agent(a.root).initialize())).toBe(true);
    expect(isOccupied(await agent(b.root).initialize())).toBe(true);
  });
});

describe('A-18 — liveness, fencing and restart', () => {
  it('model silence keeps ownership: an idle owner outlives many leases because the service renews it, not the model', async () => {
    const c = await cockpit();
    let clock = Date.now();
    const ownership = new ProjectOwnership({ dataDir: c.dataDir, projectId: c.id, now: () => clock, autoRenew: false });
    await serve(c, { ownership });
    const owner = agent(c.root);
    resultOf(await owner.initialize());
    // Four leases of silence. The owner sends nothing at all; only the service's own renewal runs —
    // the tick its background timer fires every 5 s (D-02.5), driven here on a controlled clock.
    for (let elapsed = 0; elapsed < 4 * OWNER_LEASE_MS; elapsed += 5_000) {
      clock += 5_000;
      ownership.renewalTick();
    }
    expect(isOccupied(await agent(c.root).initialize())).toBe(true);
    expect(textOf(await owner.call('health'))).toContain(`(${c.id})`);
  });

  it('confirmed termination releases the project at once: the client exits', async () => {
    const c = await cockpit();
    await serve(c);
    const owner = agent(c.root);
    resultOf(await owner.initialize());
    expect(isOccupied(await agent(c.root).initialize())).toBe(true);
    await owner.end();
    const next = agent(c.root);
    const admitted = await (async () => {
      for (let i = 0; i < 40; i += 1) {
        const answer = await next.initialize();
        if (!answer.error) return answer;
        await new Promise((r) => setTimeout(r, 25));
      }
      return undefined;
    })();
    expect(admitted?.result).toBeDefined();
    expect(textOf(await next.call('health'))).toContain(`(${c.id})`);
  });

  it('confirmed termination releases the project at once: the client process is killed', async () => {
    const c = await cockpit();
    await serve(c);
    const target = await resolveMcpTarget(c.root);
    if (target.kind !== 'socket') throw new Error('no socket for the project');
    // A separate process holding a session on the real socket, then SIGKILLed: nothing is closed by
    // it, only by the operating system (D-02.4 signal 1).
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const s = require('net').createConnection(process.argv[1], () => s.write(JSON.stringify({ v: ${IPC_PROTOCOL_VERSION}, id: 1, method: 'session/open' }) + '\\n'));
         s.on('data', (d) => { if (String(d).includes('"ok":true')) process.stdout.write('owned\\n'); });
         setInterval(() => {}, 1000);`,
        target.path,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    closers.push(() => holder.kill('SIGKILL'));
    await new Promise<void>((resolve) => holder.stdout!.on('data', (d) => String(d).includes('owned') && resolve()));
    expect(isOccupied(await agent(c.root).initialize())).toBe(true);

    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.once('exit', resolve));
    const next = agent(c.root);
    let answer = await next.initialize();
    for (let i = 0; i < 40 && answer.error; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      answer = await next.initialize();
    }
    expect(answer.error, JSON.stringify(answer)).toBeUndefined();
    expect(claims(c)).toHaveLength(1);
  });

  it('a stale owner is fenced and must reconnect: after its lease lapsed and a successor took over, its write never runs', async () => {
    const c = await cockpit();
    let clock = Date.now();
    const ownership = new ProjectOwnership({ dataDir: c.dataDir, projectId: c.id, now: () => clock, autoRenew: false });
    await serve(c, { ownership });
    const run = c.store.createRun({ title: 'the original title', workflow: 'quick-task', task: 't', steps: [] });
    const stale = agent(c.root);
    resultOf(await stale.initialize());
    // The frozen-host case (D-02.6): no renewal and no close — the lease is the only exit.
    clock += OWNER_LEASE_MS + 1;
    const successor = agent(c.root);
    resultOf(await successor.initialize());

    const staleWrite = await stale.call('organise_work', { action: 'set_title', runId: run.id, title: 'stale', expectedVersion: runVersion(c.store, run.id) });
    expect(isExpired(staleWrite), JSON.stringify(staleWrite)).toBe(true);
    expect(c.store.getRun(run.id)?.title).toBe('the original title');
    // It must reconnect: the bridge tried to, and the project is the successor's now.
    expect(isOccupied(await stale.call('health'))).toBe(true);

    const successorWrite = await successor.call('organise_work', { action: 'set_title', runId: run.id, title: 'successor', expectedVersion: runVersion(c.store, run.id) });
    expect(resultOf(successorWrite).isError, JSON.stringify(successorWrite)).toBeFalsy();
    expect(c.store.getRun(run.id)?.title).toBe('successor');
  });

  it('a service restart ends every session: a surviving bridge is fenced once, reconnects on its own, and still owns alone', async () => {
    const c = await cockpit();
    let service = await serve(c);
    const run = c.store.createRun({ title: 'before', workflow: 'quick-task', task: 't', steps: [] });
    const owner = agent(c.root);
    resultOf(await owner.initialize());
    const tokenBefore = claims(c)[0]!.token;

    service.close();
    expect(claims(c), 'a stopping service drops its claim').toEqual([]);
    // While it is down, a call reads as "not running" — no hang, and no fencing yet (D-01 § 5). A call
    // that races the close itself is told the connection closed before an answer; the next is not.
    let down = resultOf(await owner.call('health'));
    if ((down.structuredContent as { status?: string }).status === 'unreachable') down = resultOf(await owner.call('health'));
    expect(down).toMatchObject({ isError: true, structuredContent: { status: 'not-running' } });

    service = await serve(c);
    // The write made under the old session is fenced, never run (D-02 § 5).
    const stale = await owner.call('organise_work', { action: 'set_title', runId: run.id, title: 'after', expectedVersion: runVersion(c.store, run.id) });
    expect(isExpired(stale), JSON.stringify(stale)).toBe(true);
    expect(c.store.getRun(run.id)?.title).toBe('before');
    // ...and the bridge already reconnected: a new session, under a new token, owning alone.
    const again = await owner.call('organise_work', { action: 'set_title', runId: run.id, title: 'after', expectedVersion: runVersion(c.store, run.id) });
    expect(resultOf(again).isError, JSON.stringify(again)).toBeFalsy();
    expect(c.store.getRun(run.id)?.title).toBe('after');
    expect(claims(c).map((claim) => claim.token)).not.toContain(tokenBefore);
    expect(isOccupied(await agent(c.root).initialize())).toBe(true);
    service.close();
  });

  it('a claim left by a service that crashed does not block the restarted one, and never yields two owners', async () => {
    const c = await cockpit();
    // The crashed service: a process that is certainly dead now, with a claim renewed a moment ago.
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
    const dir = join(c.dataDir, OWNER_CLAIM_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const at = Date.now();
    writeFileSync(join(dir, `${deadPid}-${randomUUID()}.json`), JSON.stringify({ v: 1, token: `${at}-${randomUUID()}`, pid: deadPid, host: hostname(), acquiredAt: at, renewedAt: at }), { mode: 0o600 });
    await serve(c);
    const owner = agent(c.root);
    resultOf(await owner.initialize());
    expect(claims(c).map((claim) => claim.pid)).toEqual([process.pid]);
    expect(isOccupied(await agent(c.root).initialize())).toBe(true);
  });

  it('N-07: with the service down at initialize the handshake is healthy, and the first call once it starts takes the project', async () => {
    const c = await cockpit();
    const early = agent(c.root);
    expect(resultOf(await early.initialize())).toMatchObject({ serverInfo: { name: 'xezar' } });
    expect(resultOf(await early.call('health'))).toMatchObject({ isError: true, structuredContent: { status: 'not-running' } });
    await serve(c);
    expect(textOf(await early.call('health'))).toContain(`(${c.id})`);
    expect(isOccupied(await agent(c.root).initialize())).toBe(true);
  });
});

describe('N-05 — a started task keeps running through every ownership change', () => {
  it('survives its owner leaving, a successor, a refused client, fencing and a service restart; nothing calls the run manager', async () => {
    const c = await cockpit();
    let service = await serve(c);
    const owner = agent(c.root);
    resultOf(await owner.initialize());
    const runId = await startSlowTask(c, owner);
    const cancel = vi.spyOn(c.manager, 'cancel');

    expect(isOccupied(await agent(c.root).initialize())).toBe(true);
    await owner.end();
    const successor = agent(c.root);
    let answer = await successor.initialize();
    for (let i = 0; i < 40 && answer.error; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      answer = await successor.initialize();
    }
    expect(answer.error).toBeUndefined();
    service.close();
    service = await serve(c);
    expect(isExpired(await successor.call('health'))).toBe(true);
    expect(textOf(await successor.call('health'))).toContain(`(${c.id})`);

    expect(c.store.getRun(runId)?.status).toBe('running');
    expect(cancel).not.toHaveBeenCalled();
    expect(c.store.readEvents(runId).some((event) => (event as { type?: string }).type === 'cancelled')).toBe(false);
  }, 30_000);
});
