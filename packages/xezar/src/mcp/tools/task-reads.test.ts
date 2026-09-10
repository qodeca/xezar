import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handoffPath } from '../../handoff.ts';
import { RunStore } from '../../runs/store.ts';
import { apiRequest } from '../../server/loopback-request.testkit.ts';
import { ProjectContexts } from '../../server/project-context.ts';
import { createApp } from '../../server/server.ts';
import type { RunManager } from '../../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../../workspace/projects.ts';
import { IPC_PROTOCOL_VERSION, LineFramer, encodeFrame, type McpToolResult } from '../ipc.ts';
import { listenMcpSocket, type McpServiceHandle } from '../service.ts';
import { defineTool, type McpTool, type McpToolContext } from '../tool.ts';
import { tools } from './index.ts';
import {
  TASK_READ_PAGE_ITEMS,
  TASK_READ_RESULT_BUDGET_BYTES,
  taskReadsTool,
  taskSummarySchema,
  type TaskReadService,
} from './task-reads.ts';

/**
 * `task_read` (#91) driven the way a leader drives it: a `tools/call` frame over the project's
 * own MCP socket, answered by the real service loop, reading a real `createApp` that serves TWO
 * registered projects. The one hop that is not production is `wired()`: `McpToolContext` does not
 * carry the service entry yet, so the test hands it over the way the service will.
 */

const isWindows = process.platform === 'win32';

type Body = Record<string, unknown> & {
  nextCursor?: string;
  part?: number;
  parts?: number;
  text?: string;
};

describe.skipIf(isWindows)('task_read — the task, history, Inbox and variant-group reads (#91)', () => {
  const saved = {
    home: process.env.XEZ_HOME,
    dryRun: process.env.XEZ_DRY_RUN,
    followups: process.env.XEZ_FOLLOWUPS,
    remote: process.env.XEZ_REMOTE,
  };
  let home: string;
  let rootA: string;
  let rootB: string;
  let storeA: RunStore;
  let storeB: RunStore;
  let contexts: ProjectContexts;
  let app: Hono;
  let idA: string;
  let idB: string;
  /** Every path the tool dispatched, in order — the evidence for M-01. */
  let dispatched: string[];
  let sockets: McpServiceHandle[];
  let socketA: string;
  let socketB: string;

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  const wired = (service: TaskReadService): McpTool =>
    defineTool({ ...taskReadsTool, call: (args, ctx) => taskReadsTool.call(args, { ...ctx, service } as McpToolContext) });

  beforeEach(async () => {
    // The socket path has a hard OS limit (~104 bytes); a task's TMPDIR can be longer than that.
    home = mkdtempSync(join(realpathSync('/tmp'), 'xez-tr-'));
    rootA = mkdtempSync(join(realpathSync(tmpdir()), 'xez-tr-a-'));
    rootB = mkdtempSync(join(realpathSync(tmpdir()), 'xez-tr-b-'));
    process.env.XEZ_HOME = home;
    process.env.XEZ_DRY_RUN = '1';
    delete process.env.XEZ_FOLLOWUPS;
    delete process.env.XEZ_REMOTE;
    for (const root of [rootA, rootB]) {
      mkdirSync(join(root, '.local/xezar'), { recursive: true });
      mkdirSync(join(root, '.xezar'), { recursive: true });
      writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    }
    clearProjectProbeCache();
    storeA = RunStore.open(join(rootA, '.local/xezar'), { keepLive: true });
    contexts = new ProjectContexts({ listProjects });
    idA = (await registerProject(rootA)).id;
    idB = (await registerProject(rootB)).id;
    app = createApp({
      repoRoot: rootA,
      store: storeA,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
    });
    storeB = (await contexts.context(idB)).store;

    dispatched = [];
    const service: TaskReadService = {
      request: (input, init) => {
        dispatched.push(new URL(input).pathname);
        return app.request(input, init);
      },
    };
    const tool = wired(service);
    sockets = [
      await listenMcpSocket({ project: { id: idA, name: 'Project A', root: rootA }, version: '0.0.0-test', tools: [tool] }),
      await listenMcpSocket({ project: { id: idB, name: 'Project B', root: rootB }, version: '0.0.0-test', tools: [tool] }),
    ];
    socketA = sockets[0]!.path;
    socketB = sockets[1]!.path;
  });

  afterEach(() => {
    for (const socket of sockets) socket.close();
    contexts.disposeAll();
    storeA.flush();
    for (const dir of [home, rootA, rootB]) rmSync(dir, { recursive: true, force: true });
    restore('XEZ_HOME', saved.home);
    restore('XEZ_DRY_RUN', saved.dryRun);
    restore('XEZ_FOLLOWUPS', saved.followups);
    restore('XEZ_REMOTE', saved.remote);
  });

  /** One `tools/call` over a project's socket, exactly as the bridge sends it. */
  function call(socketPath: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      const framer = new LineFramer(
        (line) => {
          socket.end();
          const response = JSON.parse(line) as { ok: boolean; result?: McpToolResult; error?: { message: string } };
          if (response.ok) resolve(response.result!);
          else reject(new Error(response.error?.message));
        },
        () => reject(new Error('oversized frame')),
      );
      socket.on('data', (chunk: Buffer) => framer.push(chunk));
      socket.on('error', reject);
      socket.on('connect', () =>
        socket.write(
          encodeFrame({ v: IPC_PROTOCOL_VERSION, id: 1, method: 'tools/call', params: { name: 'task_read', arguments: args } }),
        ),
      );
    });
  }

  const text = (result: McpToolResult): string => result.content[0]!.text;

  /** A successful read's payload, with the result-budget bound checked on every answer. */
  async function read(socketPath: string, args: Record<string, unknown>): Promise<Body> {
    const result = await call(socketPath, args);
    expect(result.isError, text(result)).toBeFalsy();
    expect(Buffer.byteLength(text(result), 'utf8')).toBeLessThanOrEqual(TASK_READ_RESULT_BUDGET_BYTES);
    return JSON.parse(text(result)) as Body;
  }

  async function refused(socketPath: string, args: Record<string, unknown>): Promise<string> {
    const result = await call(socketPath, args);
    expect(result.isError, text(result)).toBe(true);
    return text(result);
  }

  const cockpit = async (path: string): Promise<unknown> => {
    const res = await apiRequest(app, path);
    expect(res.status, path).toBe(200);
    return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
  };

  function task(store: RunStore, title: string, over: Record<string, unknown> = {}): string {
    const run = store.createRun({ title, workflow: 'quick-task', task: `do ${title}`, steps: [] });
    store.updateRun(run.id, { status: 'done', ...over });
    return run.id;
  }

  function notes(store: RunStore, runId: string, count: number, text: (i: number) => string = (i) => `note ${i}`): void {
    for (let i = 1; i <= count; i += 1) store.appendEvent(runId, { type: 'note', text: text(i) });
  }

  /** Follow nextCursor to the end; every page is checked against the bounds on the way. */
  async function walk(socketPath: string, args: Record<string, unknown>): Promise<Body[]> {
    const pages: Body[] = [];
    let cursor: string | undefined;
    do {
      const page = await read(socketPath, { ...args, ...(cursor ? { cursor } : {}) });
      pages.push(page);
      cursor = page.nextCursor;
      expect(pages.length).toBeLessThan(200);
    } while (cursor);
    return pages;
  }

  // ---- acceptance 1: the payloads are the cockpit's --------------------------------------

  it('reads a task list, a task, a history page and a variant group exactly as the cockpit does', async () => {
    const first = task(storeA, 'First', { createdAt: '2026-07-01T10:00:00Z' });
    task(storeA, 'Second', { createdAt: '2026-07-02T10:00:00Z', branch: 'xez/second' });
    task(storeA, 'Archived', { createdAt: '2026-07-03T10:00:00Z', archived: true });
    task(storeA, 'Variant A', { createdAt: '2026-07-04T10:00:00Z', groupId: 'g1', variant: 'A' });
    task(storeA, 'Variant B', { createdAt: '2026-07-05T10:00:00Z', groupId: 'g1', variant: 'B' });
    notes(storeA, first, 5);
    writeFileSync(handoffPath(join(rootA, '.local/xezar'), first), '# Handoff\n\n## Progress log\n\n- one line\n', 'utf8');

    const runs = (await cockpit(`/api/v1/p/${idA}/runs`)) as Array<{ archived: boolean }>;
    const list = await read(socketA, { view: 'list' });
    expect(list.tasks).toEqual(runs.filter((run) => !run.archived).map((run) => taskSummarySchema.parse(run)));
    expect(list.nextCursor).toBeUndefined();
    const withArchived = await read(socketA, { view: 'list', archived: 'include' });
    expect(withArchived.tasks).toEqual(runs.map((run) => taskSummarySchema.parse(run)));

    expect((await read(socketA, { view: 'task', taskId: first })).task).toEqual(await cockpit(`/api/v1/p/${idA}/runs/${first}`));

    const page = (await cockpit(`/api/v1/p/${idA}/runs/${first}/history`)) as { events: unknown[]; asOfSeq: number; hasOlder: boolean };
    const history = await read(socketA, { view: 'history', taskId: first });
    expect(history.events).toEqual(page.events);
    expect(history.events).toHaveLength(5);
    expect(history.asOfSeq).toBe(page.asOfSeq);
    expect(history.hasOlder).toBe(page.hasOlder);

    expect((await read(socketA, { view: 'group', groupId: 'g1' })).group).toEqual(await cockpit(`/api/v1/p/${idA}/groups/g1`));
    expect((await read(socketA, { view: 'context', taskId: first })).context).toEqual(
      await cockpit(`/api/v1/p/${idA}/runs/${first}/history-context`),
    );
    expect((await read(socketA, { view: 'handoff', taskId: first })).markdown).toBe(
      await cockpit(`/api/v1/p/${idA}/runs/${first}/handoff`),
    );
  });

  it('reads the Inbox as the cockpit does, and never lets "off" read as "empty"', async () => {
    const todos = [{ id: 'todo-1', ts: '2026-07-17T00:00:00.000Z', summary: 'a follow-up', runnable: false }];
    writeFileSync(join(rootA, '.local/xezar/todos.json'), JSON.stringify(todos), 'utf8');

    // Off (the default): the route answers [] — the tool must say WHY, not "nothing here".
    const off = await read(socketA, { view: 'inbox' });
    expect(off).toMatchObject({ view: 'inbox', available: false });
    expect(off.reason).toMatch(/Inbox is off/);

    process.env.XEZ_FOLLOWUPS = '1';
    const on = await read(socketA, { view: 'inbox' });
    expect(on).toEqual({ view: 'inbox', available: true, items: await cockpit(`/api/v1/p/${idA}/todos`) });
    expect(on.items).toHaveLength(1);

    // On and genuinely empty: available, no items — the other branch of the same `[]`.
    rmSync(join(rootA, '.local/xezar/todos.json'));
    expect(await read(socketA, { view: 'inbox' })).toEqual({ view: 'inbox', available: true, items: [] });
  });

  // ---- acceptance 2: no path to the workspace runs index ----------------------------------

  it('has no path to the workspace runs index: another project, or an unscoped listing, yields only this project', async () => {
    const mine = task(storeA, 'Mine', { groupId: 'ga' });
    const theirs = task(storeB, 'Theirs — confidential', { groupId: 'gb' });
    notes(storeB, theirs, 3);

    // The workspace index genuinely serves B's task — so it is there to leak.
    const index = (await cockpit('/api/v1/workspace/runs-index')) as { runs: Array<{ id: string }> };
    expect(index.runs.map((run) => run.id)).toContain(theirs);

    // An unscoped listing, every filter wide open: only A.
    const all = await read(socketA, { view: 'list', archived: 'include' });
    expect((all.tasks as Array<{ id: string }>).map((t) => t.id)).toEqual([mine]);

    // Naming the other project is refused, not silently answered with A's tasks as if they were B's.
    for (const key of ['project', 'projectId', 'scope']) {
      expect(await refused(socketA, { view: 'list', [key]: idB })).toMatch(/Invalid arguments for task_read/);
    }
    // There is no workspace-wide view to ask for.
    expect(await refused(socketA, { view: 'index' })).toMatch(/Invalid arguments for task_read/);

    // B's ids through A's connection: not found, and the answer reveals nothing of B.
    for (const args of [
      { view: 'task', taskId: theirs },
      { view: 'history', taskId: theirs },
      { view: 'context', taskId: theirs },
      { view: 'handoff', taskId: theirs },
      { view: 'group', groupId: 'gb' },
    ]) {
      const answer = await refused(socketA, args);
      expect(answer).toMatch(/in this project/);
      expect(answer).not.toContain('confidential');
      expect(answer).not.toContain(idB);
    }
    // Search is scoped too: B's title finds nothing from A.
    expect((await read(socketA, { view: 'list', query: 'confidential', archived: 'include' })).tasks).toEqual([]);
    expect((await read(socketA, { view: 'list', groupId: 'gb' })).tasks).toEqual([]);

    // B's own connection sees B, and only B.
    const fromB = await read(socketB, { view: 'list' });
    expect((fromB.tasks as Array<{ id: string }>).map((t) => t.id)).toEqual([theirs]);

    // Every dispatch stayed inside the calling connection's project; the only other path is the
    // health capability read, and nothing ever reached the workspace family.
    expect(dispatched.length).toBeGreaterThan(0);
    for (const path of dispatched) {
      expect(
        path.startsWith(`/api/v1/p/${idA}/`) || path.startsWith(`/api/v1/p/${idB}/`) || path === '/api/v1/health',
        path,
      ).toBe(true);
      expect(path).not.toMatch(/workspace|runs-index/);
    }
  });

  // ---- acceptance 3: bounded history, foreign cursors refused ------------------------------

  it('bounds a history read that names no page size, and walks every event exactly once', async () => {
    const long = task(storeA, 'Long');
    notes(storeA, long, 250);

    const first = await read(socketA, { view: 'history', taskId: long });
    expect((first.events as unknown[]).length).toBeLessThanOrEqual(TASK_READ_PAGE_ITEMS);
    expect(first.hasOlder).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect((first.nextCursor ?? '').length).toBeLessThanOrEqual(2_048);

    const pages = await walk(socketA, { view: 'history', taskId: long });
    const seqs = pages.flatMap((page) => (page.events as Array<{ seq: number }>).map((event) => event.seq));
    const all = (await cockpitSeqs(long)).sort((a, b) => a - b);
    expect([...seqs].sort((a, b) => a - b)).toEqual(all);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(pages.at(-1)!.hasOlder).toBe(false);

    // A smaller page is honoured; a larger one is refused.
    expect(((await read(socketA, { view: 'history', taskId: long, limit: 7 })).events as unknown[]).length).toBe(7);
    expect(await refused(socketA, { view: 'history', taskId: long, limit: TASK_READ_PAGE_ITEMS + 1 })).toMatch(/limit/);

    // Byte-heavy events: the item cap is not reached, the byte budget ends the page instead.
    const heavy = task(storeA, 'Heavy');
    notes(storeA, heavy, 60, (i) => `${i}:${'x'.repeat(1_500)}`);
    const heavyPage = await read(socketA, { view: 'history', taskId: heavy });
    expect((heavyPage.events as unknown[]).length).toBeLessThan(60);
    const heavySeqs = (await walk(socketA, { view: 'history', taskId: heavy })).flatMap((page) =>
      (page.events as Array<{ seq: number }>).map((event) => event.seq),
    );
    expect([...heavySeqs].sort((a, b) => a - b)).toEqual((await cockpitSeqs(heavy)).sort((a, b) => a - b));
  });

  /** Every seq the cockpit's own pages hold, walking its older cursors. */
  async function cockpitSeqs(runId: string): Promise<number[]> {
    const seqs = new Set<number>();
    let cursor: string | undefined;
    do {
      const page = (await cockpit(
        `/api/v1/p/${idA}/runs/${runId}/history${cursor ? `?cursor=${cursor}` : ''}`,
      )) as { events: Array<{ seq: number }>; olderCursor?: string };
      for (const event of page.events) seqs.add(event.seq);
      cursor = page.olderCursor;
    } while (cursor);
    return [...seqs];
  }

  it('refuses a cursor from another project, another task or another view', async () => {
    const mine = task(storeA, 'Mine');
    const other = task(storeA, 'Other');
    const theirs = task(storeB, 'Theirs');
    notes(storeA, mine, 150);
    notes(storeA, other, 150);
    notes(storeB, theirs, 150);
    for (let i = 0; i < 3; i += 1) task(storeA, `A${i}`);
    for (let i = 0; i < 3; i += 1) task(storeB, `B${i}`);

    const fromB = (await read(socketB, { view: 'history', taskId: theirs })).nextCursor!;
    expect(fromB).toEqual(expect.any(String));
    // Project B's cursor, presented to project A — with A's task and with B's own.
    for (const taskId of [mine, theirs]) {
      const answer = await refused(socketA, { view: 'history', taskId, cursor: fromB });
      expect(answer).toMatch(/not issued for this read/);
      expect(answer).not.toContain(idB);
    }
    // B's list cursor is refused by A's list.
    const bList = (await read(socketB, { view: 'list', limit: 1 })).nextCursor!;
    expect(await refused(socketA, { view: 'list', cursor: bList })).toMatch(/not issued for this read/);

    // Inside A: another task's cursor, or a cursor from another view, is refused as well.
    const mineCursor = (await read(socketA, { view: 'history', taskId: mine })).nextCursor!;
    expect(await refused(socketA, { view: 'history', taskId: other, cursor: mineCursor })).toMatch(/not issued for this read/);
    expect(await refused(socketA, { view: 'list', cursor: mineCursor })).toMatch(/not issued for this read/);

    // Garbage and oversized cursors are refused before anything is read.
    expect(await refused(socketA, { view: 'history', taskId: mine, cursor: 'not-a-cursor' })).toMatch(/not a task_read cursor/);
    expect(await refused(socketA, { view: 'history', taskId: mine, cursor: 'x'.repeat(2_049) })).toMatch(/cursor/);
  });

  it('pages the task list by keyset and binds its filters to the cursor', async () => {
    for (let i = 1; i <= 12; i += 1) task(storeA, `Task ${i}`, { createdAt: `2026-07-${String(i).padStart(2, '0')}T10:00:00Z` });
    task(storeA, 'Failed one', { createdAt: '2026-06-01T10:00:00Z', status: 'failed' });

    const pages = await walk(socketA, { view: 'list', status: ['done'], limit: 5 });
    expect(pages.map((page) => (page.tasks as unknown[]).length)).toEqual([5, 5, 2]);
    const ids = pages.flatMap((page) => (page.tasks as Array<{ id: string; status: string }>).map((t) => t.id));
    expect(new Set(ids).size).toBe(12);
    expect(pages.every((page) => page.total === 12)).toBe(true);

    // A task created mid-walk lands at the top and does not shift the pages still to come.
    const firstPage = await read(socketA, { view: 'list', status: ['done'], limit: 5 });
    task(storeA, 'Newest', { createdAt: '2026-08-01T10:00:00Z' });
    const second = await read(socketA, { view: 'list', cursor: firstPage.nextCursor });
    expect(second.tasks).toEqual(pages[1]!.tasks);

    // The cursor keeps its filters; different filters with it are refused.
    expect(await refused(socketA, { view: 'list', cursor: firstPage.nextCursor, status: ['failed'] })).toMatch(/other filters/);
  });

  // ---- B-03: one item larger than the budget -----------------------------------------------

  it('sends an item larger than the result budget in parts that join back exactly', async () => {
    const big = task(storeA, 'Big');
    notes(storeA, big, 2);
    storeA.appendEvent(big, { type: 'note', text: 'y'.repeat(90_000) });

    const history = await walk(socketA, { view: 'history', taskId: big });
    const parts = history.filter((page) => page.part !== undefined);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.map((page) => page.part)).toEqual(parts.map((_, i) => i + 1));
    expect(parts.every((page) => page.parts === parts.length)).toBe(true);
    const joined = JSON.parse(parts.map((page) => page.text).join('')) as { seq: number; text: string };
    const page = (await cockpit(`/api/v1/p/${idA}/runs/${big}/history`)) as { events: Array<{ seq: number }> };
    expect(joined).toEqual(page.events.at(-1));
    // After the last part the walk carries on to the older events.
    const rest = history.flatMap((p) => ((p.events as Array<{ seq: number }> | undefined) ?? []).map((e) => e.seq));
    expect([...rest, joined.seq].sort((a, b) => a - b)).toEqual(page.events.map((e) => e.seq));

    // A whole record too large for one answer: parts, joined, equal the cockpit's record.
    const huge = task(storeA, 'Huge');
    storeA.updateRun(huge, { task: 'é'.repeat(30_000) + '"\\\n'.repeat(2_000) });
    const recordParts = await walk(socketA, { view: 'task', taskId: huge });
    expect(recordParts.length).toBeGreaterThan(1);
    expect(JSON.parse(recordParts.map((p) => p.text).join(''))).toEqual(await cockpit(`/api/v1/p/${idA}/runs/${huge}`));

    // A record that changes between parts is refused, never spliced from two versions.
    const partOne = await read(socketA, { view: 'task', taskId: huge });
    storeA.updateRun(huge, { title: 'Renamed mid-read' });
    expect(await refused(socketA, { view: 'task', taskId: huge, cursor: partOne.nextCursor })).toMatch(/changed while/);
  });

  // ---- the remaining edges ------------------------------------------------------------------

  it('refuses arguments that do not apply to the view, and ids that are dot segments', async () => {
    const id = task(storeA, 'One');
    expect(await refused(socketA, { view: 'task' })).toMatch(/task needs taskId/);
    expect(await refused(socketA, { view: 'task', taskId: id, status: ['done'] })).toMatch(/status does not apply/);
    expect(await refused(socketA, { view: 'list', taskId: id })).toMatch(/taskId does not apply/);
    expect(await refused(socketA, { view: 'task', taskId: '..' })).toMatch(/not an id/);
  });

  it('answers that it is not connected when the service has not handed it the task store', async () => {
    const plain = await listenMcpSocket({
      project: { id: 'plain', name: 'Plain', root: rootA },
      version: '0.0.0-test',
      tools: [taskReadsTool],
    });
    sockets.push(plain);
    const answer = await refused(plain.path, { view: 'list' });
    expect(answer).toMatch(/not connected/);
  });

  it('is registered once, as task_read', () => {
    expect(tools.filter((tool) => tool.name === 'task_read')).toEqual([taskReadsTool]);
    expect(taskReadsTool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});
