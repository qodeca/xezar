import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditOrigin, McpJournalOrigin, McpJournalRow, RunRecord } from '@qodeca/xezar-contract';
import { MCP_JOURNAL_RETAINED_ROWS } from '@qodeca/xezar-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { ProjectContexts, type ProjectContextSource } from '../server/project-context.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { WorkspaceEventBus, createApp } from '../server/server.ts';
import type { RunManager } from '../workflows/run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { AuditTrail, type AuditChannel } from './audit-trail.ts';
import {
  EchoGuard,
  PRESENTATION_EVENT_KINDS,
  WORKSPACE_ONLY_EVENT_NAMES,
  attachLeaderFeed,
} from './echo-guard.ts';
import { EventJournal } from './event-journal.ts';
import { RECEIPT_MAX_KEPT } from './operation-receipts.ts';
import { McpServiceAdapter } from './service-adapter.ts';

/**
 * The echo guard (#106, F-13, A-20): a project-bound leader sees human changes and new outcomes,
 * and never reacts to its own echoes.
 *
 * The first half is the guard alone, rule by rule. The second half drives the REAL app `createApp`
 * builds — real `ProjectContexts`, stores and routes, the real MCP service adapter and the real
 * workspace SSE stream — and a real per-project `EventJournal`.
 *
 * One piece is a stand-in, said plainly: the journal EMITTER. Turning store changes into E-01–E-06
 * rows is issue #104's catalog, not this module. The stand-in below appends one E-04 row per title
 * change, SYNCHRONOUSLY inside the route that made it — which is when the real service writes, and
 * the case that makes echo ordering hard — and takes the row's origin from the door the change came
 * through, the way the audit trail (#102) stamps it: `ui` → `human`, `mcp` → `leader`.
 */

// ---- the guard alone ------------------------------------------------------------------------

const PROJECT = 'proj-a';
const OWN_OP = 'op-own-00000001';

const row = (over: Partial<McpJournalRow> = {}): McpJournalRow => ({
  eventId: `${PROJECT}:1`,
  journalSeq: 1,
  ts: '2026-09-11T00:00:00.000Z',
  projectId: PROJECT,
  category: 'E-04',
  kind: 'task.edited',
  subject: { type: 'run', id: 'run-1', version: null },
  origin: 'human',
  causedBy: null,
  summary: 'task title changed',
  ...over,
});

describe('EchoGuard.admit — the six rules', () => {
  it('delivers a human change', () => {
    const guard = new EchoGuard({ projectId: PROJECT });
    expect(guard.admit(row())).toEqual({ deliver: true, row: row() });
  });

  it("drops a leader row caused by this guard's own operation", async () => {
    const guard = new EchoGuard({ projectId: PROJECT });
    await guard.issue(OWN_OP, () => undefined);
    expect(guard.admit(row({ origin: 'leader', causedBy: OWN_OP }))).toEqual({ deliver: false, reason: 'own-echo' });
  });

  it('delivers a leader row caused by an operation this guard never issued — another session is news', async () => {
    const guard = new EchoGuard({ projectId: PROJECT });
    await guard.issue(OWN_OP, () => undefined);
    const foreign = row({ origin: 'leader', causedBy: 'op-other-session-1' });
    expect(guard.admit(foreign)).toEqual({ deliver: true, row: foreign });
  });

  it('never drops a row merely because it recognises the run: a system outcome and a human edit of a run the leader started both arrive', async () => {
    const guard = new EchoGuard({ projectId: PROJECT });
    await guard.issue(OWN_OP, () => undefined);
    const finished = row({ eventId: `${PROJECT}:2`, journalSeq: 2, category: 'E-01', kind: 'task.terminal', origin: 'system' });
    const edited = row({ eventId: `${PROJECT}:3`, journalSeq: 3, origin: 'human' });
    expect(guard.admit(finished).deliver).toBe(true);
    expect(guard.admit(edited).deliver).toBe(true);
  });

  it("drops a row stamped with another project's id (N-01)", () => {
    const guard = new EchoGuard({ projectId: PROJECT });
    expect(guard.admit(row({ projectId: 'proj-b', eventId: 'proj-b:1' }))).toEqual({
      deliver: false,
      reason: 'foreign-project',
    });
  });

  it.each(WORKSPACE_ONLY_EVENT_NAMES)('drops a row whose kind is the workspace-only name %s (N-01)', (name) => {
    const guard = new EchoGuard({ projectId: PROJECT });
    expect(guard.admit(row({ kind: name }))).toEqual({ deliver: false, reason: 'workspace-only' });
  });

  it.each(PRESENTATION_EVENT_KINDS)('drops the presentation/log/counter kind %s', (kind) => {
    const guard = new EchoGuard({ projectId: PROJECT });
    expect(guard.admit(row({ kind }))).toEqual({ deliver: false, reason: 'presentation' });
  });

  it('drops a second delivery of the same eventId, and delivers again after forgetDelivered', () => {
    const guard = new EchoGuard({ projectId: PROJECT });
    expect(guard.admit(row()).deliver).toBe(true);
    expect(guard.admit(row())).toEqual({ deliver: false, reason: 'duplicate' });
    guard.forgetDelivered();
    expect(guard.admit(row()).deliver).toBe(true);
  });

  it('keeps its own operations across forgetDelivered — an echo is still an echo after a new journal epoch', async () => {
    const guard = new EchoGuard({ projectId: PROJECT });
    await guard.issue(OWN_OP, () => undefined);
    guard.forgetDelivered();
    expect(guard.admit(row({ origin: 'leader', causedBy: OWN_OP })).deliver).toBe(false);
  });

  it('refuses anything that is not a journal row, including a leader row with no operation id', () => {
    const guard = new EchoGuard({ projectId: PROJECT });
    for (const candidate of [undefined, null, 'run', { event: 'run' }, { ...row(), category: 'E-99' }, { ...row(), origin: 'leader', causedBy: null }]) {
      expect(guard.admit(candidate)).toEqual({ deliver: false, reason: 'invalid' });
    }
  });

  it('records the operation BEFORE dispatching it, and refuses a malformed id before any dispatch', async () => {
    const guard = new EchoGuard({ projectId: PROJECT });
    let seenInside = false;
    await guard.issue(OWN_OP, () => {
      seenInside = guard.isOwn(OWN_OP);
    });
    expect(seenInside).toBe(true);

    let dispatched = false;
    await expect(guard.issue('short', () => { dispatched = true; })).rejects.toThrow();
    expect(dispatched).toBe(false);
  });

  it('remembers no more than the bounds it reuses: B-21 operations and B-19 rows', async () => {
    const guard = new EchoGuard({ projectId: PROJECT });
    for (let i = 0; i <= RECEIPT_MAX_KEPT; i++) await guard.issue(`op-bound-${i}`, () => undefined);
    expect(guard.isOwn('op-bound-0')).toBe(false);
    expect(guard.isOwn(`op-bound-${RECEIPT_MAX_KEPT}`)).toBe(true);

    for (let seq = 1; seq <= MCP_JOURNAL_RETAINED_ROWS + 1; seq++) {
      guard.admit(row({ eventId: `${PROJECT}:${seq}`, journalSeq: seq }));
    }
    expect(guard.admit(row({ eventId: `${PROJECT}:1`, journalSeq: 1 })).deliver).toBe(true);
    expect(guard.admit(row({ eventId: `${PROJECT}:${MCP_JOURNAL_RETAINED_ROWS + 1}`, journalSeq: MCP_JOURNAL_RETAINED_ROWS + 1 })).deliver).toBe(false);
  });

  it('binds only to a resolved project slug', () => {
    expect(() => new EchoGuard({ projectId: 'default' })).toThrow();
    expect(() => new EchoGuard({ projectId: '../proj-a' })).toThrow();
  });
});

// ---- the real app ---------------------------------------------------------------------------

const COCKPIT_HOST = '127.0.0.1:4321';

interface Harness {
  app: ReturnType<typeof createApp>;
  contexts: ProjectContexts;
  bus: WorkspaceEventBus;
  storeA: RunStore;
  storeB: RunStore;
  journalA: EventJournal;
  journalB: EventJournal;
  adapter: McpServiceAdapter;
  runId: string;
  otherRunId: string;
  /** A human edit through the cockpit's own route. */
  human: (runId: string, title: string, project?: string) => Promise<void>;
  /** A leader edit through the MCP adapter, attributed to `operationId`. */
  leader: (operationId: string, runId: string, title: string) => Promise<void>;
  /** The audit entries the two doors wrote, oldest first. */
  audit: () => ReturnType<AuditTrail['read']>['entries'];
}

const tempDirs: string[] = [];
const closers: Array<() => unknown> = [];
const savedDryRun = process.env.XEZ_DRY_RUN;
const savedHome = process.env.XEZ_HOME;

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

/** The audit trail's door spelling, mapped onto the journal's (both as they landed, #102/#103). */
const journalOrigin = (door: AuditOrigin): McpJournalOrigin => (door === 'mcp' ? 'leader' : 'human');

/**
 * The stand-in emitter (see the file comment). `door` is set by whichever door is dispatching and
 * read synchronously from inside the store's `run` event — so a leader's echo is appended while its
 * operation is still in flight, before the adapter's answer exists.
 */
function standInEmitter(store: RunStore, journal: EventJournal) {
  const door: { current: { origin: AuditOrigin; operationId?: string } | null } = { current: null };
  const titles = new Map(store.listRuns().map((run) => [run.id, run.title]));
  const onRun = (run: RunRecord): void => {
    if (titles.get(run.id) === run.title) return;
    titles.set(run.id, run.title);
    const via = door.current;
    const origin: McpJournalOrigin = via ? journalOrigin(via.origin) : 'system';
    journal.append({
      category: 'E-04',
      kind: 'task.edited',
      subject: { type: 'run', id: run.id, version: null },
      origin,
      causedBy: origin === 'leader' ? (via?.operationId ?? null) : null,
      summary: 'task title changed',
    });
  };
  store.on('run', onRun);
  closers.push(() => store.off('run', onRun));
  return door;
}

async function harness(): Promise<Harness> {
  process.env.XEZ_HOME = makeDir('xez-echo-home-');
  const boot = makeRoot('xez-echo-boot-');
  const roots = { a: makeRoot('xez-echo-a-'), b: makeRoot('xez-echo-b-') };
  const projects: ProjectContextSource[] = [
    { id: 'proj-a', root: roots.a, status: 'ok' },
    { id: 'proj-b', root: roots.b, status: 'ok' },
  ];
  const semaphore = new WorkspaceSemaphore({
    initial: { maxParallel: 2 },
    load: async () => ({ maxParallel: 2, memoryLimitMb: null }),
  });
  const contexts = new ProjectContexts({ listProjects: async () => projects, semaphore });
  const bus = new WorkspaceEventBus();
  const app = createApp({
    repoRoot: boot,
    store: RunStore.open(join(boot, '.local/xezar'), { keepLive: true }),
    manager: { isActive: () => false } as unknown as RunManager,
    version: '0.0.0-test',
    bootProjectId: 'boot',
    contexts,
    semaphore,
    workspaceEvents: bus,
    providerAuth: connectedProviderAuth(),
  });
  closers.push(() => contexts.disposeAll());

  const ctxA = await contexts.context('proj-a');
  const ctxB = await contexts.context('proj-b');
  const runId = ctxA.store.createRun({ title: 'first title', workflow: 'quick-task', task: 't', steps: [] }).id;
  const otherRunId = ctxB.store.createRun({ title: 'b title', workflow: 'quick-task', task: 't', steps: [] }).id;

  const journalA = EventJournal.open({ dataDir: ctxA.dataDir, projectId: 'proj-a', secretValues: [] });
  const journalB = EventJournal.open({ dataDir: ctxB.dataDir, projectId: 'proj-b', secretValues: [] });
  closers.push(() => journalA.close(), () => journalB.close());
  const doorA = standInEmitter(ctxA.store, journalA);
  const doorB = standInEmitter(ctxB.store, journalB);

  const trail = new AuditTrail({ projectId: 'proj-a', dataDir: ctxA.dataDir }, { warn: () => undefined });
  const channels: Record<'ui' | 'mcp', AuditChannel> = { ui: trail.channel('ui'), mcp: trail.channel('mcp') };
  const adapter = new McpServiceAdapter({ projectId: 'proj-a', service: app });

  return {
    app,
    contexts,
    bus,
    storeA: ctxA.store,
    storeB: ctxB.store,
    journalA,
    journalB,
    adapter,
    runId,
    otherRunId,
    async human(id, title, project = 'proj-a') {
      const door = project === 'proj-a' ? doorA : doorB;
      door.current = { origin: 'ui' };
      try {
        const res = await app.request(`/api/v1/p/${project}/runs/${id}`, {
          method: 'PATCH',
          headers: { host: COCKPIT_HOST, origin: `http://${COCKPIT_HOST}`, 'content-type': 'application/json' },
          body: JSON.stringify({ title }),
        });
        expect(res.status).toBe(200);
        if (project === 'proj-a') channels.ui.recordStatus({ action: 'runs.update', resource: { kind: 'run', id } }, res.status);
      } finally {
        door.current = null;
      }
    },
    async leader(operationId, id, title) {
      doorA.current = { origin: 'mcp', operationId };
      try {
        const result = await adapter.patchRun(id, { title });
        expect(result.ok).toBe(true);
        channels.mcp.recordStatus({ action: 'runs.update', resource: { kind: 'run', id }, operationId }, result.status);
      } finally {
        doorA.current = null;
      }
    },
    audit: () => trail.read().entries,
  };
}

/** Open one SSE stream through the real route and collect it. */
async function openStream(app: Harness['app'], url: string) {
  const res = await apiRequest(app, url);
  expect(res.status).toBe(200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  closers.push(() => reader.cancel());
  const decoder = new TextDecoder();
  let body = '';
  const readUntil = async (done: (body: string) => boolean): Promise<string> => {
    const deadline = Date.now() + 5_000;
    while (!done(body) && Date.now() < deadline) {
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())));
      const next = await Promise.race([reader.read(), timeout]);
      if (next === null || next.done) break;
      body += decoder.decode(next.value, { stream: true });
    }
    return body;
  };
  return { readUntil };
}

const payloadsOf = <T>(body: string, event: string): T[] =>
  [...body.matchAll(new RegExp(`event: ${event}\\ndata: (.*)\\n`, 'g'))].map((m) => JSON.parse(m[1] as string) as T);

/** A leader that reacts to EVERY row it is handed with one MCP mutation — the worst case. */
function reactiveLeader(h: Harness, guard: EchoGuard | null) {
  const inbox: McpJournalRow[] = [];
  const delivered: McpJournalRow[] = [];
  const dropped: string[] = [];
  let reactions = 0;
  const take = (r: McpJournalRow): void => {
    delivered.push(r);
    inbox.push(r);
  };
  // `null` is the control: the raw journal feed with no guard in front of it.
  const detach = guard
    ? attachLeaderFeed({ journal: h.journalA, guard, deliver: take, onDrop: (reason) => dropped.push(reason) })
    : h.journalA.subscribe(take);
  closers.push(detach);

  const act = async (operationId: string, runId: string, title: string): Promise<void> => {
    if (guard) await guard.issue(operationId, () => h.leader(operationId, runId, title));
    else await h.leader(operationId, runId, title);
  };
  return {
    delivered,
    dropped,
    get reactions() {
      return reactions;
    },
    act,
    /** React to everything in the inbox — and to whatever those reactions cause — up to `cap`. */
    async drain(cap: number): Promise<void> {
      while (inbox.length > 0 && reactions < cap) {
        const next = inbox.shift()!;
        reactions += 1;
        await act(`op-react-${reactions}`, next.subject.id, `leader reply ${reactions}`);
      }
    },
  };
}

/** Let anything asynchronous that a mutation could still cause arrive. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200));

beforeEach(() => {
  process.env.XEZ_DRY_RUN = '1';
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await Promise.resolve(close()).catch(() => undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedDryRun === undefined) delete process.env.XEZ_DRY_RUN;
  else process.env.XEZ_DRY_RUN = savedDryRun;
  if (savedHome === undefined) delete process.env.XEZ_HOME;
  else process.env.XEZ_HOME = savedHome;
});

describe('an MCP-caused change reaches the open cockpit through the shared source', () => {
  it('an MCP patch arrives on /api/v1/workspace/events as a project-stamped run frame, no new transport', async () => {
    const h = await harness();
    const stream = await openStream(h.app, '/api/v1/workspace/events');
    await stream.readUntil((body) => body.includes('event: ping'));

    await h.leader('op-cockpit-sync-1', h.runId, 'renamed by the leader');

    const body = await stream.readUntil((b) => b.includes('renamed by the leader'));
    const frames = payloadsOf<RunRecord & { project: string }>(body, 'run').filter((run) => run.id === h.runId);
    expect(frames.length).toBeGreaterThan(0);
    // Exactly the shape the cockpit's parser takes: the store's own record plus the project stamp.
    const { project, ...record } = frames.at(-1)!;
    expect(project).toBe('proj-a');
    expect(record).toEqual(JSON.parse(JSON.stringify(h.storeA.getRun(h.runId))));
    expect(record.title).toBe('renamed by the leader');
  });

  it('an MCP start arrives too — the created run is on the stream before anyone reloads', async () => {
    const h = await harness();
    const stream = await openStream(h.app, '/api/v1/workspace/events');
    await stream.readUntil((body) => body.includes('event: ping'));

    const started = await h.adapter.startRun({ task: 'started by the leader', steps: [{ id: 'check', command: 'node -e "0"' }] });
    if (!started.ok) throw new Error(started.error);
    const id = 'runs' in started.value ? started.value.runs[0]!.id : started.value.id;

    const body = await stream.readUntil((b) => b.includes(id));
    expect(payloadsOf<{ id: string; project: string }>(body, 'run').some((run) => run.id === id && run.project === 'proj-a')).toBe(true);
    // dispose() does not end a live step, and a step still writing when the temp root is removed
    // is #125's ENOENT in whichever test runs next — so let the run finish first.
    const deadline = Date.now() + 20_000;
    while (!['done', 'failed', 'cancelled'].includes(h.storeA.getRun(id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the MCP-started run to finish');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await (await h.contexts.context('proj-a')).manager.dispose();
  });
});

describe('the leader side: human changes arrive, its own echoes do not', () => {
  it("delivers a human change, and the leader's own acknowledged operation produces no inbound event", async () => {
    const h = await harness();
    const guard = new EchoGuard({ projectId: 'proj-a' });
    const leader = reactiveLeader(h, guard);

    await h.human(h.runId, 'narrowed by a human');
    expect(leader.delivered).toHaveLength(1);
    expect(leader.delivered[0]).toMatchObject({ origin: 'human', causedBy: null, subject: { id: h.runId } });

    await leader.act('op-own-edit-1', h.runId, 'edited by the leader');
    await settle();
    // The operation was acknowledged and its effect is real — in the store and in the journal …
    expect(h.storeA.getRun(h.runId)?.title).toBe('edited by the leader');
    expect(h.journalA.latestSeq).toBe(2);
    expect(h.journalA.read().status === 'ok' && h.journalA.read()).toMatchObject({
      events: [{ origin: 'human' }, { origin: 'leader', causedBy: 'op-own-edit-1' }],
    });
    // … and the leader was handed nothing for it.
    expect(leader.delivered).toHaveLength(1);
    expect(leader.dropped).toEqual(['own-echo']);
    // The two landed spellings agree: the audit door said `mcp` for exactly that operation.
    expect(h.audit().map((entry) => [entry.origin, entry.operationKey])).toEqual([
      ['ui', undefined],
      ['mcp', 'proj-a/op-own-edit-1'],
    ]);
  });

  it('control: an operation recorded only on ACKNOWLEDGEMENT misses its echo — the echo is written while the call is in flight', async () => {
    const h = await harness();
    const guard = new EchoGuard({ projectId: 'proj-a' });
    const delivered: McpJournalRow[] = [];
    closers.push(attachLeaderFeed({ journal: h.journalA, guard, deliver: (r) => delivered.push(r) }));

    // Dispatch first, record after: the order `issue` exists to forbid.
    await h.leader('op-late-record-1', h.runId, 'late record');
    await guard.issue('op-late-record-1', () => undefined);

    expect(delivered.map((r) => r.causedBy)).toEqual(['op-late-record-1']);
  });
});

describe('the loop test: an MCP mutation converges instead of feeding itself', () => {
  const CAP = 25;

  it('a leader that reacts to everything performs one mutation, sees no echo, and the event count stays put', async () => {
    const h = await harness();
    const leader = reactiveLeader(h, new EchoGuard({ projectId: 'proj-a' }));

    await leader.act('op-kickoff-01', h.runId, 'leader kicks off');
    await leader.drain(CAP);
    const afterFirst = h.journalA.latestSeq;
    expect(afterFirst).toBe(1);

    // Converged, not merely slow: nothing more arrives, and draining again does nothing.
    for (let round = 0; round < 3; round++) {
      await settle();
      await leader.drain(CAP);
      expect(h.journalA.latestSeq).toBe(afterFirst);
    }
    expect(leader.reactions).toBe(0);
    expect(leader.delivered).toEqual([]);
  });

  it('a human change gets exactly one reaction, and the reaction does not re-trigger the leader', async () => {
    const h = await harness();
    const leader = reactiveLeader(h, new EchoGuard({ projectId: 'proj-a' }));

    await h.human(h.runId, 'a human asks for more');
    await leader.drain(CAP);
    for (let round = 0; round < 3; round++) {
      await settle();
      await leader.drain(CAP);
    }
    expect(leader.reactions).toBe(1);
    expect(h.journalA.latestSeq).toBe(2);
    expect(h.storeA.getRun(h.runId)?.title).toBe('leader reply 1');
  });

  it('control: the same leader on the raw journal feed loops until the cap — the loop is real and the guard is what stops it', async () => {
    const h = await harness();
    const leader = reactiveLeader(h, null);

    await leader.act('op-kickoff-01', h.runId, 'leader kicks off');
    await leader.drain(CAP);

    expect(leader.reactions).toBe(CAP);
    expect(h.journalA.latestSeq).toBe(CAP + 1);
  });
});

describe('N-01: workspace-only events never reach a project-bound session', () => {
  it('project-added, project-removed and checkout-progress fire on the shared source, and none of them reaches the leader', async () => {
    const h = await harness();
    const guard = new EchoGuard({ projectId: 'proj-a' });
    const delivered: McpJournalRow[] = [];
    closers.push(attachLeaderFeed({ journal: h.journalA, guard, deliver: (r) => delivered.push(r) }));
    const stream = await openStream(h.app, '/api/v1/workspace/events');
    await stream.readUntil((body) => body.includes('event: ping'));

    h.bus.emit('project-added', { id: 'proj-z', name: 'another project', root: '/elsewhere' });
    h.bus.emit('checkout-progress', { id: 'checkout-1', line: 'Receiving objects: 50%' });
    h.bus.emit('project-removed', { id: 'proj-z' });
    // Activity in both projects on the same source: only this project's may arrive.
    await h.human(h.otherRunId, 'changed in project b', 'proj-b');
    await h.human(h.runId, 'changed in project a');

    // Control: every one of those names really was on the workspace stream …
    const body = await stream.readUntil((b) => b.includes('changed in project a'));
    for (const name of WORKSPACE_ONLY_EVENT_NAMES) expect(body).toContain(`event: ${name}\n`);
    expect(h.journalB.latestSeq).toBe(1);

    // … and the leader got exactly its own project's one human change.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ projectId: 'proj-a', origin: 'human', subject: { id: h.runId } });
    const text = JSON.stringify(delivered);
    for (const name of WORKSPACE_ONLY_EVENT_NAMES) expect(text).not.toContain(name);
    expect(text).not.toContain('proj-b');
    expect(text).not.toContain('proj-z');
  });

  it("a session cannot be attached to another project's journal", async () => {
    const h = await harness();
    const guard = new EchoGuard({ projectId: 'proj-a' });
    expect(() => attachLeaderFeed({ journal: h.journalB, guard, deliver: () => undefined })).toThrow(
      "a leader feed attaches only to its own project's journal",
    );
  });
});
