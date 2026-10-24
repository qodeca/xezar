// FIRST import on purpose: the home pin is a module-load side effect and must run before anything
// that reaches `skills.ts` (#671).
import './tools/mcp-test-home.testkit.ts';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
// The background repo-handle lookup (`gh`, #945) would still be running in a project folder these
// cases move on purpose, and Windows refuses to move a folder a live process works in (#963).
vi.mock('../runs/arm-repo-handle.ts', () => ({ armRepoHandle: () => undefined }));
import { projectDataDir } from '../project-data-paths.ts';
import { RunStore } from '../runs/store.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { WorkspaceEventBus, createApp, type McpContextResolver } from '../server/server.ts';
import { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { startMcpService } from './index.ts';
import { IPC_PROTOCOL_VERSION, LineFramer, encodeFrame, type IpcResponse } from './ipc.ts';
import { listenMcpSocket } from './service.ts';
import { McpScopeError } from './session-binding.ts';
import { defineTool, textResult } from './tool.ts';
import { connectRaw } from '../../test/helpers/mcp-raw.ts';
import { onWindows, shortTmpRoot, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';

/**
 * OD-1: the MCP door re-checks its session's project binding on every tool call.
 *
 * The socket fixes WHICH project a session serves; this pins that it also keeps serving the very
 * FOLDER it was bound to. The cockpit caches a built project context and would go on handing it
 * out after its folder was deleted, moved away or re-created at the same path, so `session/open`
 * binds through `bindMcpSession` (realpath, device, inode) and every `tools/call` is refused with
 * the binding's own fixed `missing-root` sentence once that folder is no longer the same one —
 * before the tool runs, read-only tools included.
 *
 * Driven over the real socket with raw frames, against a real `ProjectContexts`, and once through
 * the production composition (`createApp`'s resolver into `startMcpService`, real tools).
 */

const MISSING_ROOT = new McpScopeError('missing-root', 'x').message;

let home: string;
let env: NodeJS.ProcessEnv;
const closers: Array<() => unknown> = [];
const saved = { home: process.env.XEZ_HOME, dryRun: process.env.XEZ_DRY_RUN };

beforeEach(() => {
  // A short home: the socket path must stay under the OS limit (D-01 E5).
  home = realpathSync(mkdtempSync(join(shortTmpRoot(), 'xzb-')));
  env = { XEZ_HOME: home };
  process.env.XEZ_HOME = home;
  process.env.XEZ_DRY_RUN = '1';
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await Promise.resolve(close()).catch(() => undefined);
  vi.restoreAllMocks();
  rmSync(home, TEST_DIR_RM_OPTIONS);
  for (const [key, value] of [['XEZ_HOME', saved.home], ['XEZ_DRY_RUN', saved.dryRun]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Move a folder away; Windows refuses while a short-lived child still works in it (#963). */
async function moveFolder(from: string, to: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!onWindows || (code !== 'EBUSY' && code !== 'EPERM') || tries >= 100) throw error;
      await new Promise((done) => setTimeout(done, 100));
    }
  }
}

/** One raw connection; `request` writes a frame and resolves with the answer to its id. */
async function rawSession(path: string, projectId: string) {
  const socket: Socket = await connectRaw(path, { projectId, env });
  closers.push(() => socket.destroy());
  const waiting = new Map<number, (r: IpcResponse) => void>();
  const framer = new LineFramer(
    (line) => {
      const response = JSON.parse(line) as IpcResponse;
      if (typeof response.id === 'number') {
        waiting.get(response.id)?.(response);
        waiting.delete(response.id);
      }
    },
    () => undefined,
  );
  socket.on('data', (chunk: Buffer) => framer.push(chunk));
  let next = 1;
  const request = (method: string, params?: unknown): Promise<IpcResponse> => {
    const id = next++;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      socket.write(encodeFrame({ v: IPC_PROTOCOL_VERSION, id, method, ...(params === undefined ? {} : { params }) }));
    });
  };
  return { request, call: (name: string, args: Record<string, unknown> = {}) => request('tools/call', { name, arguments: args }) };
}

describe('the MCP door re-checks the bound project folder on every call (OD-1)', () => {
  let runs: { write: number; read: number };
  const write = defineTool({
    name: 'write_thing',
    description: 'A mutating tool: counts its runs.',
    inputSchema: z.object({}),
    async call() {
      runs.write++;
      return textResult('written');
    },
  });
  const read = defineTool({
    name: 'read_thing',
    description: 'A read-only tool: counts its runs.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
    async call() {
      runs.read++;
      return textResult('read');
    },
  });

  /** A registered project folder, a real context map over it, and its MCP socket. */
  async function door() {
    runs = { write: 0, read: 0 };
    const root = join(home, 'alpha');
    mkdirSync(root);
    const project = { id: 'alpha', name: 'Alpha', root };
    const contexts = new ProjectContexts({ listProjects: async () => [{ id: project.id, root, status: 'not-git' }] });
    closers.push(() => contexts.disposeAll());
    // Built once, as the cockpit has it before any session opens: the cache a stale folder hides behind.
    await contexts.context(project.id);
    const handle = await listenMcpSocket({ project, version: '1.2.3', tools: [write, read], env, contexts });
    closers.push(() => handle.close());
    return { root, session: () => rawSession(handle.path, project.id) };
  }

  it('serves calls while the folder is the one the session was bound to', async () => {
    const d = await door();
    const s = await d.session();
    expect(await s.request('session/open')).toMatchObject({ ok: true, result: { owner: true } });
    expect(await s.call('write_thing')).toMatchObject({ ok: true, result: { content: [{ text: 'written' }] } });
    expect(await s.call('read_thing')).toMatchObject({ ok: true, result: { content: [{ text: 'read' }] } });
    expect(runs).toEqual({ write: 1, read: 1 });
  });

  it('refuses every call, reads included, once the folder was re-created at the same path', async () => {
    const d = await door();
    const s = await d.session();
    expect(await s.request('session/open')).toMatchObject({ ok: true });
    expect(await s.call('write_thing')).toMatchObject({ ok: true });

    await moveFolder(d.root, `${d.root}-moved`);
    mkdirSync(d.root);
    writeFileSync(join(d.root, 'planted.txt'), 'not the project the session was bound to\n');

    for (const tool of ['write_thing', 'read_thing']) {
      expect(await s.call(tool)).toMatchObject({ ok: false, error: { code: 'internal', message: MISSING_ROOT } });
    }
    expect(runs).toEqual({ write: 1, read: 0 });
  });

  it('refuses calls once the folder is deleted, and the refusal names no path', async () => {
    const d = await door();
    const s = await d.session();
    expect(await s.request('session/open')).toMatchObject({ ok: true });
    rmSync(d.root, TEST_DIR_RM_OPTIONS);
    const answer = await s.call('read_thing');
    expect(answer).toMatchObject({ ok: false, error: { message: MISSING_ROOT } });
    expect(JSON.stringify(answer)).not.toContain(d.root);
    expect(runs).toEqual({ write: 0, read: 0 });
  });

  it('opens no session for a folder that is already gone, so no call runs', async () => {
    const d = await door();
    rmSync(d.root, TEST_DIR_RM_OPTIONS);
    const s = await d.session();
    expect(await s.request('session/open')).toMatchObject({ ok: false, error: { code: 'internal', message: MISSING_ROOT } });
    expect(await s.call('read_thing')).toMatchObject({ ok: false, error: { code: 'session-expired' } });
    expect(runs).toEqual({ write: 0, read: 0 });
  });
});

describe('the production composition binds through the cockpit context (OD-1)', () => {
  /** A registered boot project with the cockpit's own app, store and manager over it. */
  async function cockpit() {
    const root = realpathSync(mkdtempSync(join(shortTmpRoot(), 'xzbp-')));
    closers.push(() => rmSync(root, TEST_DIR_RM_OPTIONS));
    mkdirSync(join(root, '.xezar'), { recursive: true });
    writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    const { id } = await registerProject(root);
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2 }, load: async () => ({ maxParallel: 2, memoryLimitMb: null }) });
    const store = RunStore.open(projectDataDir(root), { keepLive: true });
    const manager = new RunManager(store, root, { semaphore });
    const contexts = new ProjectContexts({ listProjects: async () => [{ id, root, status: 'ok' }], semaphore });
    let resolver: McpContextResolver | undefined;
    const app = createApp({
      repoRoot: root,
      store,
      manager,
      version: '9.9.9-bind',
      bootProjectId: id,
      contexts,
      semaphore,
      workspaceEvents: new WorkspaceEventBus(),
      providerAuth: connectedProviderAuth(),
      onContexts: (_contexts, mcp) => {
        resolver = mcp;
      },
    });
    closers.push(() => {
      manager.dispose();
      store.flush();
      return contexts.disposeAll();
    });
    if (!resolver) throw new Error('createApp offered no MCP context resolver');
    return { root, id, store, app, contexts, resolver };
  }

  it('resolves the boot project to the boot context itself, never a second build', async () => {
    const c = await cockpit();
    const ctx = await c.resolver.context(c.id);
    expect(ctx.store).toBe(c.store);
    expect(ctx).toMatchObject({ id: c.id, root: c.root });
    expect(c.contexts.ids()).toEqual([]);
  });

  it('refuses a real tool call once the boot project folder was replaced', async () => {
    const c = await cockpit();
    const handle = await startMcpService({ projectId: c.id, version: '9.9.9-bind', service: c.app, store: c.store, contexts: c.resolver, env, warn: () => {} });
    closers.push(() => handle.close());
    const s = await rawSession(handle.path, c.id);
    expect(await s.request('session/open')).toMatchObject({ ok: true });
    const before = await s.call('task_read', { view: 'list', limit: 1 });
    expect(before).toMatchObject({ ok: true });
    expect((before as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);

    await moveFolder(c.root, `${c.root}-moved`);
    closers.push(() => rmSync(`${c.root}-moved`, TEST_DIR_RM_OPTIONS));
    mkdirSync(c.root);

    expect(await s.call('task_read', { view: 'list', limit: 1 })).toMatchObject({
      ok: false,
      error: { code: 'internal', message: MISSING_ROOT },
    });
  });
});
