// FIRST import on purpose: the home pin is a module-load side effect and must run before anything
// that reaches `skills.ts` (#671).
import './tools/mcp-test-home.testkit.ts';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectDataDir } from '../project-data-paths.ts';
import { RunStore } from '../runs/store.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { ProjectContexts, type ContextDisposal, type ProjectContext } from '../server/project-context.ts';
import { WorkspaceEventBus, createApp } from '../server/server.ts';
import { RunManager } from '../workflows/run.ts';
import { listProjects, registerProject } from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { runBridge } from './bridge.ts';
import { resolveMcpTarget, startMcpService } from './index.ts';
import { LineFramer, encodeFrame, mcpSocketLocation, type McpToolResult } from './ipc.ts';
import { followProjectDoors, type ProjectDoorContexts, type ProjectDoorHandle } from './project-doors.ts';
import { tools } from './tools/index.ts';

/**
 * #557 — a project registered into a running cockpit gets the same MCP door the boot project has:
 * opened when its context is built, closed when it is disposed, and the boot door left alone.
 */

// ---- the lifecycle, over a stand-in context map -------------------------------------------------

type Ctx = { id: string; generation: number };

/**
 * A stand-in for the real map, generations and all (#647). `build`/`dispose` keep the shape every
 * existing case here already uses; `disposeDeferred` is the one thing the real map does that a
 * synchronous fake cannot show — it bumps the generation and drops the context at once but
 * notifies only after the old context's teardown has finished, which is the whole race window.
 */
function fakeContexts(initial: string[] = []) {
  const built = new Set<(ctx: Ctx) => void>();
  const disposed = new Set<(id: string, disposal: ContextDisposal) => void>();
  const live = new Map(initial.map((id) => [id, { id, generation: 0 }]));
  const generations = new Map<string, number>();
  const generation = (id: string) => generations.get(id) ?? 0;
  const contexts: ProjectDoorContexts<Ctx> = {
    ids: () => [...live.keys()],
    peek: (id) => live.get(id),
    onContextBuilt: (l) => (built.add(l), () => built.delete(l)),
    onContextDisposed: (l) => (disposed.add(l), () => disposed.delete(l)),
  };
  /** End the id's registration, the way `dispose()` does before it awaits anything. */
  const endRegistration = (id: string): number => {
    const ending = generation(id);
    generations.set(id, ending + 1);
    live.delete(id);
    return ending;
  };
  const notifyDisposed = (id: string, ending: number): void => {
    // Published context only: the real `superseded` also counts a build still in flight, which no case here starts.
    const published = live.get(id)?.generation;
    const disposal: ContextDisposal = {
      generation: ending,
      superseded: published !== undefined && published > ending,
    };
    for (const l of [...disposed]) l(id, disposal);
  };
  return {
    contexts,
    build(id: string) {
      const ctx = { id, generation: generation(id) };
      live.set(id, ctx);
      for (const l of [...built]) l({ ...ctx });
    },
    dispose(id: string) {
      notifyDisposed(id, endRegistration(id));
    },
    /** Dispose with the notification parked; the returned function is the teardown finishing. */
    disposeDeferred(id: string): () => void {
      const ending = endRegistration(id);
      return () => notifyDisposed(id, ending);
    },
    listeners: () => built.size + disposed.size,
  };
}

/** An `open` whose every call is recorded and settled by the test. */
function controlledOpen() {
  const calls: Array<{ id: string; resolve: (h: ProjectDoorHandle | undefined) => void; reject: (e: unknown) => void }> = [];
  const events: string[] = [];
  const open = (ctx: Ctx) =>
    new Promise<ProjectDoorHandle | undefined>((resolve, reject) => {
      events.push(`open ${ctx.id}`);
      calls.push({ id: ctx.id, resolve, reject });
    });
  const handle = (label: string): ProjectDoorHandle => ({ close: () => events.push(`close ${label}`) });
  return { open, calls, events, handle };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('followProjectDoors', () => {
  it('opens a door for a project built after it attached, and closes it on dispose', async () => {
    const map = fakeContexts();
    const o = controlledOpen();
    followProjectDoors(map.contexts, { bootProjectId: 'boot', open: o.open });
    map.build('b');
    await tick();
    expect(o.events).toEqual(['open b']);
    o.calls[0]!.resolve(o.handle('b'));
    await tick();
    map.dispose('b');
    expect(o.events).toEqual(['open b', 'close b']);
  });

  it('never opens the boot project, whose door serve opens itself (guard)', async () => {
    const map = fakeContexts(['boot']);
    const o = controlledOpen();
    followProjectDoors(map.contexts, { bootProjectId: 'boot', open: o.open });
    map.build('boot');
    await tick();
    map.dispose('boot');
    expect(o.events).toEqual([]);
  });

  it('opens doors for contexts that were already built when it attached', async () => {
    const map = fakeContexts(['a', 'b']);
    const o = controlledOpen();
    followProjectDoors(map.contexts, { open: o.open });
    await tick();
    expect(o.events).toEqual(['open a', 'open b']);
  });

  it('opens once for a context reported twice without a dispose between', async () => {
    const map = fakeContexts();
    const o = controlledOpen();
    followProjectDoors(map.contexts, { open: o.open });
    map.build('b');
    map.build('b');
    await tick();
    expect(o.events).toEqual(['open b']);
  });

  it('releases a door whose project was disposed while it was still opening', async () => {
    const map = fakeContexts();
    const o = controlledOpen();
    followProjectDoors(map.contexts, { open: o.open });
    map.build('b');
    await tick();
    map.dispose('b');
    o.calls[0]!.resolve(o.handle('late b'));
    await tick();
    expect(o.events).toEqual(['open b', 'close late b']);
  });

  it('never calls onOpened for a door whose project was disposed while it was still opening', async () => {
    const map = fakeContexts();
    const o = controlledOpen();
    const opened: string[] = [];
    followProjectDoors(map.contexts, { open: o.open, onOpened: (ctx) => opened.push(ctx.id) });
    map.build('b');
    await tick();
    map.dispose('b');
    o.calls[0]!.resolve(o.handle('late b'));
    await tick();
    expect(o.events).toEqual(['open b', 'close late b']);
    expect(opened).toEqual([]);
  });

  it('calls onOpened once a door is kept', async () => {
    const map = fakeContexts();
    const o = controlledOpen();
    const opened: string[] = [];
    followProjectDoors(map.contexts, { open: o.open, onOpened: (ctx) => opened.push(ctx.id) });
    map.build('b');
    await tick();
    o.calls[0]!.resolve(o.handle('b'));
    await tick();
    expect(opened).toEqual(['b']);
  });

  it('opens a re-added project only after the door it replaces has settled', async () => {
    const map = fakeContexts();
    const o = controlledOpen();
    followProjectDoors(map.contexts, { open: o.open });
    map.build('b');
    await tick();
    map.dispose('b');
    map.build('b');
    await tick();
    // The second open waits: the first may still be about to listen on the same socket path.
    expect(o.events).toEqual(['open b']);
    o.calls[0]!.resolve(o.handle('old b'));
    await tick();
    await tick();
    expect(o.events).toEqual(['open b', 'close old b', 'open b']);
    o.calls[1]!.resolve(o.handle('new b'));
    await tick();
    map.dispose('b');
    expect(o.events.at(-1)).toBe('close new b');
  });

  /**
   * #647 (RP-2) — the reported symptom. `dispose()` ends the registration and drops the context
   * synchronously, but notifies only once the teardown has finished, and that teardown awaits
   * `RunManager.dispose()`. A project re-added and rebuilt inside that window already has its NEW
   * door open when the OLD registration's dispose finally lands; keyed on the id alone, that
   * dispose closed the live door, and `xez mcp` in the project's folder answered "xezar is not
   * running" while the same process served its routes.
   *
   * The existing re-add case at :147 cannot see this: its fake notifies the dispose synchronously,
   * so the order is never the racing one.
   */
  it('keeps a rebuilt project\'s door when the dispose it replaced lands after the rebuild', async () => {
    const map = fakeContexts();
    const o = controlledOpen();
    followProjectDoors(map.contexts, { open: o.open });
    map.build('b');
    await tick();
    o.calls[0]!.resolve(o.handle('old b'));
    await tick();

    // Removal starts: generation bumped, context dropped — teardown still running, nobody told.
    const teardownFinished = map.disposeDeferred('b');
    // Re-added and rebuilt inside that window: the same id, the next registration.
    map.build('b');
    await tick();
    await tick();
    // The rebuild retires the door it replaces itself, and still waits for it to settle first.
    expect(o.events).toEqual(['open b', 'close old b', 'open b']);
    o.calls[1]!.resolve(o.handle('new b'));
    await tick();

    // The late dispose names generation 0 — a registration this id no longer holds a door for.
    teardownFinished();
    expect(o.events).toEqual(['open b', 'close old b', 'open b']);

    // Still the live door, and still released by its OWN dispose.
    map.dispose('b');
    expect(o.events).toEqual(['open b', 'close old b', 'open b', 'close new b']);
  });

  it('skips the open entirely when the project went away before its turn came', async () => {
    const map = fakeContexts();
    const o = controlledOpen();
    followProjectDoors(map.contexts, { open: o.open });
    map.build('b');
    await tick();
    map.dispose('b');
    map.build('b');
    map.dispose('b');
    o.calls[0]!.resolve(undefined);
    await tick();
    await tick();
    expect(o.events).toEqual(['open b']);
  });

  it('treats a door that could not open as no door, and tries again on the next build', async () => {
    const map = fakeContexts();
    const o = controlledOpen();
    followProjectDoors(map.contexts, { open: o.open });
    map.build('b');
    await tick();
    o.calls[0]!.reject(new Error('socket refused'));
    await tick();
    map.dispose('b');
    map.build('c');
    await tick();
    o.calls[1]!.resolve(undefined);
    await tick();
    map.dispose('c');
    map.build('b');
    await tick();
    await tick();
    expect(o.events).toEqual(['open b', 'open c', 'open b']);
  });

  it('close() releases every door, stops following, and is idempotent', async () => {
    const map = fakeContexts();
    const o = controlledOpen();
    const doors = followProjectDoors(map.contexts, { open: o.open });
    map.build('b');
    map.build('c');
    await tick();
    o.calls[0]!.resolve(o.handle('b'));
    await tick();
    doors.close();
    doors.close();
    o.calls[1]!.resolve(o.handle('c'));
    await tick();
    map.build('d');
    await tick();
    expect(o.events).toEqual(['open b', 'open c', 'close b', 'close c']);
    expect(map.listeners()).toBe(0);
  });
});

// ---- the real thing: a running app, a registered second project, the real bridge ---------------

const VERSION = '9.9.9-doors';
const tempDirs: string[] = [];
const closers: Array<() => unknown> = [];
const saved = { home: process.env.XEZ_HOME, dryRun: process.env.XEZ_DRY_RUN };

// Short paths under /tmp: the per-worker sandbox is past the 104-byte socket limit on macOS.
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  tempDirs.push(dir);
  return dir;
};

const project = (): string => {
  const root = tmp('xzd-');
  mkdirSync(join(root, '.xezar'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
  return root;
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

/** One `health` call through the real stdio bridge, run from `root` the way a client spawns it. */
async function healthFrom(root: string): Promise<McpToolResult> {
  const input = new PassThrough();
  const output = new PassThrough();
  const answer = new Promise<McpToolResult>((resolve) => {
    const framer = new LineFramer(
      (line) => resolve((JSON.parse(line) as { result: McpToolResult }).result),
      () => {},
    );
    output.on('data', (chunk: Buffer) => framer.push(chunk));
  });
  const done = runBridge({ input, output, version: VERSION, tools, resolveTarget: () => resolveMcpTarget(root) });
  input.write(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'health', arguments: {} } }));
  const result = await answer;
  input.end();
  await done;
  return result;
}

const text = (result: McpToolResult): string => result.content.map((part) => ('text' in part ? part.text : '')).join('\n');

async function until(what: string, probe: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('a project registered into a running cockpit (#557)', () => {
  it('gets its own MCP door once built, loses it on removal, and leaves the boot door alone', async () => {
    const bootRoot = project();
    const { id: bootId } = await registerProject(bootRoot);
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2 }, load: async () => ({ maxParallel: 2, memoryLimitMb: null }) });
    const store = RunStore.open(projectDataDir(bootRoot), { keepLive: true });
    const manager = new RunManager(store, bootRoot, { semaphore });
    const contexts = new ProjectContexts({ listProjects: () => listProjects(), semaphore });
    const workspaceEvents = new WorkspaceEventBus();
    const app = createApp({
      repoRoot: bootRoot,
      store,
      manager,
      version: VERSION,
      bootProjectId: bootId,
      contexts,
      semaphore,
      workspaceEvents,
      providerAuth: connectedProviderAuth(),
    });
    // What `serve` composes: the boot door, then the doors that follow the context map.
    const bootDoor = await startMcpService({ projectId: bootId, version: VERSION, service: app, store, workspaceEvents });
    const doors = followProjectDoors(contexts, {
      bootProjectId: bootId,
      open: (ctx: ProjectContext) =>
        startMcpService({ projectId: ctx.id, version: VERSION, service: app, store: ctx.store, workspaceEvents }),
    });
    closers.push(async () => {
      doors.close();
      bootDoor.close();
      await manager.dispose();
      store.flush();
      await contexts.disposeAll();
    });

    // Guard (passes with or without the fix): the boot door is where it always was, and answers.
    expect(bootDoor.path).toBe((mcpSocketLocation({ id: bootId, root: bootRoot }) as { path: string }).path);
    expect(text(await healthFrom(bootRoot))).toContain(`is running for project`);

    // The "Add project" flow, then the first scoped request that builds B's context.
    const secondRoot = project();
    const added = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({ root: secondRoot }),
    });
    expect(added.status).toBe(200);
    const secondId = (await listProjects()).find((p) => p.root === secondRoot)!.id;
    expect((await app.request(`/api/v1/p/${secondId}/runs`, { headers: { host: '127.0.0.1' } })).status).toBe(200);

    // B's own door answers from B's folder, bound to B and not to the boot project.
    const secondSocket = (mcpSocketLocation({ id: secondId, root: secondRoot }) as { path: string }).path;
    await until('the second project MCP door', async () => existsSync(secondSocket));
    const second = await healthFrom(secondRoot);
    expect(second.isError).toBeFalsy();
    expect(text(second)).toContain(`(${secondId})`);
    expect(text(second)).not.toContain(`(${bootId})`);

    // Removal disposes B's context, which closes its door; the boot door is untouched.
    const removed = await app.request(`/api/v1/projects/${secondId}`, { method: 'DELETE', headers: { host: '127.0.0.1' } });
    expect(removed.status).toBe(200);
    await until('the second project MCP door to close', async () => !existsSync(secondSocket));
    expect((await healthFrom(secondRoot)).isError).toBe(true);
    const boot = await healthFrom(bootRoot);
    expect(boot.isError).toBeFalsy();
    expect(text(boot)).toContain(`(${bootId})`);
  }, 30_000);
});
