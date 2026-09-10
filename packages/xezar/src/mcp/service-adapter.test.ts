import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { ProjectContexts, type ProjectContextSource } from '../server/project-context.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { createApp } from '../server/server.ts';
import type { RunManager } from '../workflows/run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import {
  MCP_ORIGIN,
  McpServiceAdapter,
  McpServiceAdapterError,
  type ServiceDispatch,
  type StartRunRequest,
  type StartRunValue,
} from './service-adapter.ts';

/**
 * The shared business-service adapter (#89): the cockpit and MCP reach the SAME services, so they
 * cannot drift apart (N-02, A-08).
 *
 * Every case drives the real app `createApp` builds, with real `ProjectContexts`, real stores and
 * real `RunManager`s sharing ONE `WorkspaceSemaphore` — nothing between the adapter and the
 * services is stubbed except provider auth (always connected) and the agent CLIs (`XEZ_DRY_RUN`).
 * The runs use shell CHECK steps, so they reach a terminal state without any model and every
 * event they write is deterministic enough to compare.
 */

const COCKPIT_HOST = '127.0.0.1:4321';
const OK_COMMAND = `node -e "process.stdout.write('ok')"`;
const HOLD_COMMAND = `node -e "setTimeout(() => {}, 20000)"`;

interface Workspace {
  app: ReturnType<typeof createApp>;
  contexts: ProjectContexts;
  roots: { a: string; b: string };
}

const tempDirs: string[] = [];
const makeDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};

const makeRoot = (prefix: string): string => {
  const root = makeDir(prefix);
  mkdirSync(join(root, '.xezar'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
  return root;
};

let workspace: Workspace | undefined;
const savedDryRun = process.env.XEZ_DRY_RUN;
const savedHome = process.env.XEZ_HOME;

function setup(maxParallel = 2): Workspace {
  const home = makeDir('xez-mcp-home-');
  process.env.XEZ_HOME = home;
  const boot = makeRoot('xez-mcp-boot-');
  const roots = { a: makeRoot('xez-mcp-a-'), b: makeRoot('xez-mcp-b-') };
  const projects: ProjectContextSource[] = [
    { id: 'proj-a', root: roots.a, status: 'ok' },
    { id: 'proj-b', root: roots.b, status: 'ok' },
    { id: 'gone', root: join(boot, 'no-such-dir'), status: 'missing' },
  ];
  // ONE semaphore for the whole workspace, exactly as boot builds it (`ProjectContexts` hands it
  // to every manager). The stubbed loader keeps a stray `refresh()` from resetting the cap.
  const semaphore = new WorkspaceSemaphore({
    initial: { maxParallel },
    load: async () => ({ maxParallel, memoryLimitMb: null }),
  });
  const contexts = new ProjectContexts({ listProjects: async () => projects, semaphore });
  const app = createApp({
    repoRoot: boot,
    store: RunStore.open(join(boot, '.local/xezar'), { keepLive: true }),
    manager: { isActive: () => false } as unknown as RunManager,
    version: '0.0.0-test',
    bootProjectId: 'boot',
    contexts,
    semaphore,
    providerAuth: connectedProviderAuth(),
  });
  workspace = { app, contexts, roots };
  return workspace;
}

/** The cockpit's own request: same-origin, from the loopback deployment a browser talks to. */
const cockpit = (app: Workspace['app'], path: string, method = 'GET', body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      host: COCKPIT_HOST,
      origin: `http://${COCKPIT_HOST}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const store = async (ws: Workspace, projectId: string) => (await ws.contexts.context(projectId)).store;

const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'review', 'waiting']);

/** `POST /runs` answers one record, or `{runs}` for variants — the id of the one this test made. */
const startedId = (value: StartRunValue): string => ('runs' in value ? value.runs[0]!.id : value.id);

/** Every file under `dir`, relative, with a content hash. */
function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (statSync(path).isFile()) {
        files.set(relative(dir, path), createHash('sha256').update(readFileSync(path)).digest('hex'));
      }
    }
  };
  walk(dir);
  return files;
}

/** A snapshot's file names with the run id and the per-context writer claim (a random name the
 *  project writer takes at context build, before any operation) spelled generically. */
const fileKeys = (files: Map<string, string>, runId: string): string[] =>
  [...files.keys()]
    .map((file) => (runId ? file.split(runId).join('<run>') : file).replace(/^(\.local\/xezar\/writer-claims\/).+\.json$/, '$1<claim>.json'))
    .sort();

/** Keys whose value is a clock reading, a process id or the origin marker — equal by nature only
 *  up to "when" and "who asked", which is exactly what the parity claim excludes. */
const VOLATILE_KEY = /(At|Ms|Time)$|^(ts|time|pid|elapsed)$/;

function normalize(value: unknown, substitutions: ReadonlyArray<readonly [string, string]>): unknown {
  let text = JSON.stringify(value);
  for (const [from, to] of substitutions) text = text.split(from).join(to);
  return JSON.parse(text, (key: string, v: unknown) => {
    if (key === 'origin') return undefined;
    return VOLATILE_KEY.test(key) ? '<volatile>' : v;
  });
}

const readEvents = (root: string, runId: string): unknown[] =>
  readFileSync(join(root, '.local/xezar/runs', `${runId}.ndjson`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

beforeEach(() => {
  process.env.XEZ_DRY_RUN = '1';
});

afterEach(async () => {
  const ws = workspace;
  workspace = undefined;
  if (ws) {
    for (const id of ws.contexts.ids()) {
      const ctx = ws.contexts.peek(id);
      if (!ctx) continue;
      const runs = ctx.store.listRuns().map((run) => run.id);
      for (const id of runs) ctx.manager.cancel(id);
      // A cancelled check step still writes its closing event when its process exits; removing
      // the data root before that is an ENOENT in whichever test runs next (#125).
      await waitFor(() => runs.every((id) => !ctx.manager.isActive(id)), 'cancelled runs to settle');
      await ctx.manager.dispose();
    }
    ws.contexts.disposeAll();
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedDryRun === undefined) delete process.env.XEZ_DRY_RUN;
  else process.env.XEZ_DRY_RUN = savedDryRun;
  if (savedHome === undefined) delete process.env.XEZ_HOME;
  else process.env.XEZ_HOME = savedHome;
});

describe('one operation, two doors: cockpit route and MCP adapter end in the same state', () => {
  it('produces an equivalent RunRecord, NDJSON event sequence and on-disk state', async () => {
    const ws = setup();
    const input: StartRunRequest = {
      task: 'parity check',
      steps: [{ id: 'check', name: 'Check', command: OK_COMMAND }],
    };
    // Identical starting state: two fresh projects, built before either operation runs.
    await store(ws, 'proj-a');
    await store(ws, 'proj-b');
    const before = { a: snapshot(ws.roots.a), b: snapshot(ws.roots.b) };
    expect(fileKeys(before.b, '')).toEqual(fileKeys(before.a, ''));

    const viaCockpit = await cockpit(ws.app, '/api/v1/p/proj-a/runs', 'POST', input);
    expect(viaCockpit.status).toBe(201);
    const cockpitId = startedId((await viaCockpit.json()) as StartRunValue);

    const viaMcp = await new McpServiceAdapter({ projectId: 'proj-b', service: ws.app }).startRun(input);
    if (!viaMcp.ok) throw new Error(viaMcp.error);
    expect(viaMcp.status).toBe(201);
    expect(viaMcp.origin).toBe(MCP_ORIGIN);
    const mcpId = startedId(viaMcp.value);

    const storeA = await store(ws, 'proj-a');
    const storeB = await store(ws, 'proj-b');
    await waitFor(
      () => TERMINAL.has(storeA.getRun(cockpitId)?.status ?? '') && TERMINAL.has(storeB.getRun(mcpId)?.status ?? ''),
      'both runs to finish',
    );
    expect(storeA.getRun(cockpitId)?.status).toBe('done');
    // Flush both indexes so the on-disk comparison sees the state the stores hold.
    storeA.flush();
    storeB.flush();

    const subsA = [[cockpitId, '<run>'], [ws.roots.a, '<root>'], ['proj-a', '<project>']] as const;
    const subsB = [[mcpId, '<run>'], [ws.roots.b, '<root>'], ['proj-b', '<project>']] as const;

    // The record.
    expect(normalize(storeB.getRun(mcpId), subsB)).toEqual(normalize(storeA.getRun(cockpitId), subsA));
    // The event log, in order.
    const eventsA = readEvents(ws.roots.a, cockpitId);
    expect(eventsA.length).toBeGreaterThan(0);
    expect(normalize(readEvents(ws.roots.b, mcpId), subsB)).toEqual(normalize(eventsA, subsA));
    // The files: the same set exists, the same set changed, and the index has equivalent content.
    const afterA = snapshot(ws.roots.a);
    const afterB = snapshot(ws.roots.b);
    expect(fileKeys(afterB, mcpId)).toEqual(fileKeys(afterA, cockpitId));
    const changed = (earlier: Map<string, string>, later: Map<string, string>, id: string) =>
      fileKeys(new Map([...later].filter(([file, hash]) => earlier.get(file) !== hash)), id);
    expect(changed(before.b, afterB, mcpId)).toEqual(changed(before.a, afterA, cockpitId));
    const index = (root: string) => JSON.parse(readFileSync(join(root, '.local/xezar/runs.json'), 'utf8')) as unknown;
    expect(normalize(index(ws.roots.b), subsB)).toEqual(normalize(index(ws.roots.a), subsA));
  }, 30_000);

  it('answers a refusal with the same status and message the cockpit gets', async () => {
    const ws = setup();
    const adapter = new McpServiceAdapter({ projectId: 'proj-a', service: ws.app });
    const refusals: StartRunRequest[] = [
      // the validator middleware (an empty task)
      { task: '', steps: [{ id: 'check', command: OK_COMMAND }] },
      // the handler's own rule (an unknown workflow)
      { task: 'x', workflow: 'no-such-workflow' },
      // the `stepsIssue` rule (a retry that points forward)
      { task: 'x', steps: [{ id: 'one', command: OK_COMMAND, onFail: { retry: 'two' } }, { id: 'two', command: OK_COMMAND }] },
    ];
    for (const body of refusals) {
      const viaCockpit = await cockpit(ws.app, '/api/v1/p/proj-a/runs', 'POST', body);
      const viaMcp = await adapter.startRun(body);
      expect(viaMcp.ok).toBe(false);
      expect(viaMcp.status).toBe(viaCockpit.status);
      expect(viaMcp).toMatchObject({ error: ((await viaCockpit.json()) as { error: string }).error });
    }
    // Neither door created anything on a refusal.
    expect((await store(ws, 'proj-a')).listRuns()).toEqual([]);
  });
});

describe('the adapter cannot bypass WorkspaceSemaphore', () => {
  const holdAndQueue = async (ws: Workspace, mcpProject: 'proj-a' | 'proj-b') => {
    const held = await cockpit(ws.app, '/api/v1/p/proj-a/runs', 'POST', {
      task: 'hold the only slot',
      steps: [{ id: 'hold', name: 'Hold', command: HOLD_COMMAND }],
    });
    expect(held.status).toBe(201);
    const heldId = startedId((await held.json()) as StartRunValue);
    const storeA = await store(ws, 'proj-a');
    await waitFor(() => storeA.getRun(heldId)?.status === 'running', 'the cockpit run to take the slot');

    const adapter = new McpServiceAdapter({ projectId: mcpProject, service: ws.app });
    const started = await adapter.startRun({ task: 'wait for a slot', steps: [{ id: 'check', command: OK_COMMAND }] });
    if (!started.ok) throw new Error(started.error);
    const mcpId = startedId(started.value);
    const mcpStore = await store(ws, mcpProject);

    // Given time to misbehave, the MCP run still waits in the ONE queue behind the cockpit's run.
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(mcpStore.getRun(mcpId)?.status).toBe('queued');
    expect(storeA.getRun(heldId)?.status).toBe('running');

    // Freeing the slot through the cockpit is what lets it run — the scheduler's own hand-off.
    expect((await cockpit(ws.app, `/api/v1/p/proj-a/runs/${heldId}/cancel`, 'POST')).status).toBe(200);
    await waitFor(() => mcpStore.getRun(mcpId)?.status === 'done', 'the MCP run to take the freed slot');
  };

  it('queues an MCP start behind a cockpit-started run in the same project when maxParallel is 1', async () => {
    await holdAndQueue(setup(1), 'proj-a');
  }, 30_000);

  it('queues an MCP start behind a cockpit-started run in ANOTHER project — the cap is workspace-wide', async () => {
    await holdAndQueue(setup(1), 'proj-b');
  }, 30_000);

  it('control: with a second slot free, the same MCP start runs at once', async () => {
    // Without this case the two above could pass because MCP starts never run at all.
    const ws = setup(2);
    const held = await cockpit(ws.app, '/api/v1/p/proj-a/runs', 'POST', {
      task: 'hold one slot',
      steps: [{ id: 'hold', command: HOLD_COMMAND }],
    });
    const heldId = startedId((await held.json()) as StartRunValue);
    const storeA = await store(ws, 'proj-a');
    await waitFor(() => storeA.getRun(heldId)?.status === 'running', 'the cockpit run to take a slot');

    const started = await new McpServiceAdapter({ projectId: 'proj-b', service: ws.app }).startRun({
      task: 'runs beside it',
      steps: [{ id: 'check', command: OK_COMMAND }],
    });
    if (!started.ok) throw new Error(started.error);
    const storeB = await store(ws, 'proj-b');
    await waitFor(() => storeB.getRun(startedId(started.value))?.status === 'done', 'the MCP run to finish');
    expect(storeA.getRun(heldId)?.status).toBe('running');
  }, 30_000);
});

describe('the adapter writes nothing to .local/xezar except through the stores', () => {
  it('imports no file-system module, no store and no manager — only the typed route table', () => {
    // A static pin, because a behavioural test only covers the operations it calls: a new
    // import of `node:fs`, a store or a runner here is how a second writer would arrive.
    const source = readFileSync(new URL('./service-adapter.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms)].map((m) => m[1]).sort();
    expect(imports).toEqual([
      '../server/app-type.ts',
      '../workspace/config.ts',
      '@qodeca/xezar-contract',
      'hono/client',
    ]);
    expect(source).toMatch(/^import type \{ AppType \} from '\.\.\/server\/app-type\.ts';$/m);
    expect(source).not.toMatch(/node:fs|writeFile|appendFile|RunStore\.open|new RunManager|new WorkspaceSemaphore/);
  });

  it('leaves every project file, the home and the other project untouched on reads and refusals', async () => {
    const ws = setup();
    const created = await cockpit(ws.app, '/api/v1/p/proj-a/runs', 'POST', {
      task: 'something to read',
      steps: [{ id: 'check', command: OK_COMMAND }],
    });
    const runId = startedId((await created.json()) as StartRunValue);
    const storeA = await store(ws, 'proj-a');
    await waitFor(() => storeA.getRun(runId)?.status === 'done', 'the run to finish');
    await store(ws, 'proj-b');
    storeA.flush();
    const home = process.env.XEZ_HOME!;
    const before = { a: snapshot(ws.roots.a), b: snapshot(ws.roots.b), home: snapshot(home) };

    const adapter = new McpServiceAdapter({ projectId: 'proj-a', service: ws.app });
    expect((await adapter.listRuns()).ok).toBe(true);
    expect((await adapter.getRun(runId)).ok).toBe(true);
    expect((await adapter.getRun('..')).ok).toBe(false);
    expect((await adapter.startRun({ task: '', steps: [{ id: 'c', command: OK_COMMAND }] })).ok).toBe(false);
    storeA.flush();

    expect(snapshot(ws.roots.a)).toEqual(before.a);
    expect(snapshot(ws.roots.b)).toEqual(before.b);
    expect(snapshot(home)).toEqual(before.home);
  }, 30_000);
});

describe('the project is narrowed to the one the connection is bound to', () => {
  it('refuses to bind to anything that is not a project id', () => {
    const service: ServiceDispatch = { request: () => new Response('{}') };
    for (const projectId of ['', '../proj-b', 'proj-a/runs', 'Proj-A', 'proj-a?x=1']) {
      expect(() => new McpServiceAdapter({ projectId, service })).toThrow(McpServiceAdapterError);
    }
    expect(new McpServiceAdapter({ projectId: 'default', service }).projectId).toBe('default');
  });

  it("cannot read or cancel another project's run", async () => {
    const ws = setup();
    const created = await cockpit(ws.app, '/api/v1/p/proj-b/runs', 'POST', {
      task: 'belongs to b',
      steps: [{ id: 'hold', command: HOLD_COMMAND }],
    });
    const bRun = startedId((await created.json()) as StartRunValue);
    const storeB = await store(ws, 'proj-b');
    await waitFor(() => storeB.getRun(bRun)?.status === 'running', "b's run to start");

    const adapter = new McpServiceAdapter({ projectId: 'proj-a', service: ws.app });
    expect(await adapter.getRun(bRun)).toMatchObject({ ok: false, status: 404 });
    expect(await adapter.cancelRun(bRun)).toMatchObject({ ok: false, status: 404 });
    expect(await adapter.archiveRun(bRun)).toMatchObject({ ok: false, status: 404 });
    expect(storeB.getRun(bRun)?.status).toBe('running');
    expect(storeB.getRun(bRun)?.archived).toBeFalsy();
  }, 30_000);

  it('refuses a run id that would change the route, without dispatching anything', async () => {
    const seen: string[] = [];
    const service: ServiceDispatch = {
      request: (input) => {
        seen.push(input);
        return new Response('{}', { status: 200 });
      },
    };
    const adapter = new McpServiceAdapter({ projectId: 'proj-a', service });
    for (const id of ['..', '.', '', 'a/b', '../../proj-b/runs/x', '%2e%2e', 'x?y=1', 'x#y']) {
      for (const result of [await adapter.getRun(id), await adapter.cancelRun(id), await adapter.pinRun(id)]) {
        expect(result).toMatchObject({ ok: false, status: 400, origin: MCP_ORIGIN });
      }
    }
    expect(seen).toEqual([]);
  });

  it('addresses only the bound project, as a local non-browser caller', async () => {
    const seen: Array<{ url: string; host: string | null; origin: string | null }> = [];
    const service: ServiceDispatch = {
      request: (input, init) => {
        const headers = new Headers(init?.headers);
        seen.push({ url: input, host: headers.get('host'), origin: headers.get('origin') });
        return new Response('[]', { status: 200 });
      },
    };
    const adapter = new McpServiceAdapter({ projectId: 'proj-a', service });
    await adapter.listRuns();
    await adapter.getRun('r1');
    await adapter.cancelRun('r1');
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual([
      '/api/v1/p/proj-a/runs',
      '/api/v1/p/proj-a/runs/r1',
      '/api/v1/p/proj-a/runs/r1/cancel',
    ]);
    expect(seen.every((s) => s.host === '127.0.0.1' && s.origin === null)).toBe(true);
  });
});

describe('an empty answer never reads as a missing one', () => {
  it('tells "no runs" apart from "no such project" and "project folder gone"', async () => {
    const ws = setup();
    expect(await new McpServiceAdapter({ projectId: 'proj-a', service: ws.app }).listRuns()).toEqual({
      ok: true,
      origin: MCP_ORIGIN,
      status: 200,
      value: [],
    });
    expect(await new McpServiceAdapter({ projectId: 'ghost', service: ws.app }).listRuns()).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await new McpServiceAdapter({ projectId: 'gone', service: ws.app }).listRuns()).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it('treats a success status without a JSON body as an error, not as an empty value', async () => {
    const answer = (body: string | null) =>
      new McpServiceAdapter({ projectId: 'proj-a', service: { request: () => new Response(body, { status: 200 }) } });
    expect(await answer(null).listRuns()).toMatchObject({ ok: false, status: 502 });
    expect(await answer('not json').listRuns()).toMatchObject({ ok: false, status: 502 });
    expect(await answer('[]').listRuns()).toEqual({ ok: true, origin: MCP_ORIGIN, status: 200, value: [] });
  });
});
