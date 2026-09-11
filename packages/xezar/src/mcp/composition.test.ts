import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectDataDir } from '../project-data-paths.ts';
import { RunStore } from '../runs/store.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { WorkspaceEventBus, createApp } from '../server/server.ts';
import { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { AUDIT_TRAIL_FILE } from './audit-trail.ts';
import { runBridge } from './bridge.ts';
import { EventJournal } from './event-journal.ts';
import { resolveMcpTarget, startMcpService } from './index.ts';
import { LineFramer, encodeFrame, type McpToolResult } from './ipc.ts';
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
      origin: 'mcp',
      projectId: c.id,
      action: 'taskCreate.start',
      outcome: 'ok',
      resource: { kind: 'run', id: runId },
      operationKey: `${c.id}/op-compose-0001`,
    });

    // #103: the project's journal is open while the service runs, and released by close().
    expect(existsSync(join(c.dataDir, 'mcp', 'event-journal.json'))).toBe(true);
    expect(() => EventJournal.open({ dataDir: c.dataDir, projectId: c.id, secretValues: [] })).toThrow(/already open/);
    handle.close();
    const reopened = EventJournal.open({ dataDir: c.dataDir, projectId: c.id, secretValues: [] });
    reopened.close();
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
    const port = await freePort();
    const TSX = import.meta.resolve('tsx');
    const CLI = fileURLToPath(new URL('../index.ts', import.meta.url));
    const child: ChildProcess = spawn(process.execPath, ['--import', TSX, CLI, 'serve', '--no-open', '--port', String(port)], {
      cwd: repo,
      env: { ...process.env, XEZ_HOME: home, XEZ_DRY_RUN: '1', XEZ_SKILLS_AUTO_UPDATE: '0', XEZ_NO_BANNER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid;
    closers.push(() => {
      if (pid !== undefined) process.kill(pid, 'SIGKILL');
    });
    let stderr = '';
    child.stderr!.on('data', (chunk) => (stderr += String(chunk)));

    const health = await untilAsync('the cockpit', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`).catch(() => undefined);
      return res?.ok ? res : undefined;
    });
    expect(health.status).toBe(200);
    await untilAsync('the MCP warning', async () => (stderr.includes('MCP bridge unavailable') ? true : undefined));
    expect(stderr).toMatch(/too long for a local socket/);
    // Still serving after the failure was reported.
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status).toBe(200);
  }, 60_000);
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function untilAsync<T>(what: string, probe: () => Promise<T | undefined>, ms = 40_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
