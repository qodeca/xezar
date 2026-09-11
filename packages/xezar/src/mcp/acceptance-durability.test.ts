import { afterEach, describe, expect, it, vi } from 'vitest';

import { MCP_STALE_VERSION_GUIDANCE } from '@qodeca/xezar-contract';

import { assertIsolated, createAbWorld, leaked, resultText, snapshotChanges, type AbWorld } from '../../test/helpers/ab-fixture.ts';
import { RunStore } from '../runs/store.ts';
import { EventCatalog } from './event-catalog.ts';
import { EventJournal } from './event-journal.ts';
import { type McpToolResult } from './ipc.ts';
import { OperationReceiptStore } from './operation-receipts.ts';
import { LeaderCursors, LeaderFeed, LeaderInbox, reactionOperationId, runStateReader, type LeaderDelivery } from './reconnect.ts';
import { listenMcpSocket } from './service.ts';
import { McpServiceAdapter, type ServiceDispatch } from './service-adapter.ts';
import { guardedRunMutation, runVersion } from './stale-write.ts';
import type { McpToolContext } from './tool.ts';
import { QUALITY_BLOCKER_NEXT_ACTION, handoffGitTool } from './tools/handoff-git.ts';

/**
 * #117 — the correctness and durability suite, whole-feature half: A-13, A-14, A-15, A-16, A-21 and
 * A-22 judged in the shared A/B world (#115, `test/helpers/ab-fixture.ts`). The human acts through
 * the cockpit's own door (`world.cockpit`), the leader through A's MCP socket (`world.call`) and the
 * in-process service every wired tool dispatches through (`world.service`), with XEZ_DRY_RUN=1 and
 * no account or secret. The store-level half is `test/unit/mcp-durability.test.ts`; the packed-CLI
 * upgrade half of A-16 is `test/e2e/mcp-upgrade.test.ts`.
 *
 * WHAT IS BLOCKED, AND WHY (the COMPOSITION NOTE of #117). The mechanisms these cases rest on — the
 * #100 stale-write check, the #101 receipts, the #103 journal, the #104 catalog and the #105
 * reconnect — are real and are exercised here over the project's real stores and doors. What was not
 * found in the files examined is their PRODUCTION CALLER: no registry tool hands out or checks a
 * version token, `task_create` keeps no receipt for its `operationId`, `startMcpService` passes the
 * socket only `tools` (no service entry, no journal, no catalog, no controller), and no tool exposes
 * a reconnect or an acknowledgement. Each of those tool-level halves is an `it.todo` below that names
 * exactly what is missing. A todo is not a pass: vitest reports it as a todo, and #117 records it as
 * BLOCKED until the composition lands.
 */

const PROJECT_A = 'alpha-proj';

let world: AbWorld | undefined;
const opened: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const handle of opened.splice(0).reverse()) handle.close();
  await world?.dispose();
  world = undefined;
});

async function openWorld(): Promise<AbWorld> {
  world = await createAbWorld();
  return world;
}

/** Wait for a condition the real engine reaches on its own — bounded, never a leader poll. */
async function until(what: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const json = async (response: Response): Promise<unknown> => response.json();

/** The cockpit's own "New task" request, same-origin, into A. */
async function humanCreatesTask(w: AbWorld, task: string): Promise<string> {
  const res = await w.cockpit(`/api/v1/p/${PROJECT_A}/runs`, 'POST', { task, workflow: 'quick-task', worktree: false });
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return ((await json(res)) as { id: string }).id;
}

// ---- A-13 ----------------------------------------------------------------------------------------

describe('A-13 — a human changed a resource after the leader read it (N-03)', () => {
  it("rejects the stale leader write with nothing applied: A's state is byte-identical and B is untouched", async () => {
    const w = await openWorld();
    const id = w.a.ids.queued;
    // The leader reads the task over MCP, and holds the version that read corresponds to.
    const read = await w.call('a', 'task_read', { view: 'task', taskId: id });
    expect(read.isError ?? false).toBe(false);
    const leaderVersion = runVersion(w.a.store, id);

    // The human renames the task in the cockpit. (A brief edit goes through the run manager's own
    // queue, which the seeded tasks are not in; the title is in the decision projection too.)
    const edited = await w.cockpit(`/api/v1/p/${PROJECT_A}/runs/${id}`, 'PATCH', { title: 'the title the HUMAN wrote' });
    expect(edited.status).toBe(200);
    w.a.store.flush();

    const seen = await w.observe(() => {
      const beforeA = w.snapshot('a');
      let effects = 0;
      const result = guardedRunMutation(w.a.store, id, leaderVersion, () => {
        effects += 1;
        return w.a.store.updateRun(id, { title: 'the title the LEADER wanted' });
      });
      return { result, effects, beforeA, afterA: w.snapshot('a') };
    });
    const { result, effects, beforeA, afterA } = seen.response;
    expect(result).toMatchObject({ status: 'conflict', applied: false, error: 'stale_version', guidance: MCP_STALE_VERSION_GUIDANCE });
    expect(effects).toBe(0);
    expect(snapshotChanges(beforeA, afterA)).toEqual([]);
    expect(afterA).toBe(beforeA);
    assertIsolated(w, seen);

    // What the human sees is the human's title, through the cockpit and through MCP alike.
    const current = (await json(await w.cockpit(`/api/v1/p/${PROJECT_A}/runs/${id}`))) as { title: string };
    expect(current.title).toBe('the title the HUMAN wrote');
    expect(resultText(await w.call('a', 'task_read', { view: 'task', taskId: id }))).toContain('the title the HUMAN wrote');

    // The leader decides again only after a fresh read.
    const decided = guardedRunMutation(w.a.store, id, runVersion(w.a.store, id), () =>
      w.a.store.updateRun(id, { title: 'the leader, after reading the human title' }),
    );
    expect(decided.status).toBe('done');
  });

  it('concurrent leader calls racing a human cockpit edit: the human edit stands, at most one leader call applies', async () => {
    const w = await openWorld();
    const id = w.a.ids.queued2;
    const leaderVersion = runVersion(w.a.store, id);
    let effects = 0;
    const leaderCall = (n: number) =>
      Promise.resolve().then(() =>
        guardedRunMutation(w.a.store, id, leaderVersion, () => {
          effects += 1;
          return w.a.store.updateRun(id, { title: `leader call ${n}` });
        }),
      );
    const [human, ...leader] = await Promise.all([
      w.cockpit(`/api/v1/p/${PROJECT_A}/runs/${id}`, 'PATCH', { title: 'the human title' }),
      ...Array.from({ length: 6 }, (_, n) => leaderCall(n)),
    ]);
    expect(human.status).toBe(200);
    expect(leader.filter((r) => r.status === 'done').length).toBeLessThanOrEqual(1);
    expect(effects).toBeLessThanOrEqual(1);
    expect(leader.filter((r) => r.status === 'conflict').length).toBeGreaterThanOrEqual(5);
    expect(w.a.store.getRun(id)?.title).toBe('the human title');
    // Any leader write that did land was based on the pre-edit read, so it is now stale as well.
    expect(guardedRunMutation(w.a.store, id, leaderVersion, () => undefined).status).toBe('conflict');
  });

  it.todo(
    'BLOCKED (#117 composition): over the MCP socket — no registry tool hands the leader a version token or accepts `expectedVersion`, and `guardedRunMutation` has no production caller (not found in src/mcp/tools/*.ts)',
  );
});

// ---- A-14 ----------------------------------------------------------------------------------------

describe('A-14 — a mutation executed but its response lost (N-10)', () => {
  it("one key through the cockpit's create route: EXACTLY ONE task for a repeated key, TWO for two keys", async () => {
    const w = await openWorld();
    const receipts = OperationReceiptStore.open(w.a.dataDir);
    // The same in-process door `task_create` starts a task through (#89), scoped to A.
    const adapter = new McpServiceAdapter({ projectId: PROJECT_A, service: w.service });
    const title = 'mock:done idempotent create';
    let effects = 0;
    const create = (operationId: string) =>
      receipts.execute({
        projectId: PROJECT_A,
        operationId,
        action: 'runs.create',
        payload: { task: title },
        reconcile: { kind: 'none' },
        // The effect is the cockpit's own route, reached through the same in-process door as every tool.
        effect: async () => {
          effects += 1;
          const started = await adapter.startRun({ task: title, workflow: 'quick-task', worktree: false });
          if (!started.ok) return { outcome: 'rejected', errorCode: `http_${started.status}` };
          return { outcome: 'ok', resultRef: { kind: 'run', id: (started.value as { id: string }).id } };
        },
      });
    const tasks = () => w.a.store.listRuns().filter((run) => run.task === title);

    const first = await create('op-117-lost-response');
    expect(first).toMatchObject({ status: 'ok', replayed: false });
    // The response was lost; the leader retries with the same key — twice, and once after a restart.
    expect(await create('op-117-lost-response')).toEqual({ ...first, replayed: true });
    receipts.close();
    const reopened = OperationReceiptStore.open(w.a.dataDir);
    const replay = await reopened.execute({
      projectId: PROJECT_A,
      operationId: 'op-117-lost-response',
      action: 'runs.create',
      payload: { task: title },
      reconcile: { kind: 'none' },
      effect: () => {
        effects += 1;
        return { outcome: 'ok', resultRef: { kind: 'run', id: 'must-not-happen' } };
      },
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(effects).toBe(1);
    expect(tasks()).toHaveLength(1);

    // Deliberately new identical work takes a new key, and is a second task.
    const second = await create('op-117-deliberately-new');
    expect(second).toMatchObject({ status: 'ok', replayed: false });
    expect(effects).toBe(2);
    expect(tasks()).toHaveLength(2);
    reopened.close();
  });

  it.todo(
    'BLOCKED (#117 composition): over the MCP socket — `task_create` accepts an `operationId` but keeps no #101 receipt for it, so a repeated key is not answered from a receipt (OperationReceiptStore has no production caller in src/mcp/tools/*.ts)',
  );
});

// ---- A-15 ----------------------------------------------------------------------------------------

describe('A-15 — a task completes while the client is offline (F-19–F-21, N-05, N-06, N-10)', () => {
  it('the task and its result survive; reconnect delivers the outstanding event and the current state; nothing polls; a replay repeats no effect', async () => {
    const w = await openWorld();
    // The project half, attached where the project opens — never by a leader connection (N-05).
    const catalog = EventCatalog.attach({ journal: w.a.journal, store: w.a.store, warn: () => {} });
    opened.push({ close: () => catalog.detach() });
    const cursors = LeaderCursors.open({ dataDir: w.a.dataDir, projectId: PROJECT_A, journal: w.a.journal, warn: () => {} });
    const wakes: LeaderDelivery[] = [];
    const feed = new LeaderFeed({ journal: w.a.journal, cursors, readState: runStateReader(w.a.store, w.a.journal), wake: (d) => wakes.push(d) });

    const timers = { setInterval: vi.spyOn(globalThis, 'setInterval'), setTimeout: vi.spyOn(globalThis, 'setTimeout') };
    const first = feed.connect();
    feed.disconnect();
    const leaderTimers = timers.setInterval.mock.calls.length + timers.setTimeout.mock.calls.length;
    timers.setInterval.mockRestore();
    timers.setTimeout.mockRestore();
    expect(leaderTimers, 'the leader side starts no timer: no status poll, no heartbeat').toBe(0);
    expect(first.status).toBe('ok');

    // Offline: the human starts a task, and the real RunManager runs it to the end.
    const runsBefore = w.a.store.listRuns().length;
    const id = await humanCreatesTask(w, 'mock:done completed while the leader was away');
    await until('the task to finish', () => w.a.store.getRun(id)?.status === 'done');
    await until('its significant event', () => {
      const page = w.a.journal.read({ limit: 100 });
      return page.status === 'ok' && page.events.some((row) => row.subject.id === id && row.kind === 'task.done');
    });
    expect(wakes, 'nobody was woken while the leader was offline').toEqual([]);
    expect(w.a.store.listRuns().length, 'no run was created for the leader — it holds no slot').toBe(runsBefore + 1);

    // Reconnect: the outstanding event plus the current, authoritative state.
    const back = feed.connect();
    opened.push({ close: () => feed.disconnect() });
    expect(back.status).toBe('ok');
    if (back.status !== 'ok') return;
    const terminal = back.events.find((delivered) => delivered.row.subject.id === id && delivered.row.kind === 'task.done');
    expect(terminal, 'the completion is delivered on reconnect').toBeDefined();
    expect(back.state.tasks.find((task) => task.id === id)).toMatchObject({ status: 'done' });
    // …and the result reads back over MCP as well.
    expect(resultText(await w.call('a', 'task_read', { view: 'task', taskId: id }))).toMatch(/"status":\s*"done"/);

    // At-least-once: a redelivery (no ack yet) is dropped by the leader's inbox and never a second effect.
    const inbox = new LeaderInbox({ projectId: PROJECT_A, afterSeq: first.status === 'ok' ? first.state.latestSeq : 0 });
    const rows = back.events.map((delivered) => delivered.row);
    expect(inbox.accept(rows).deliver.length).toBe(rows.length);
    const again = feed.connect();
    expect(again.status).toBe('ok');
    if (again.status !== 'ok') return;
    expect(inbox.accept(again.events.map((delivered) => delivered.row)).deliver).toEqual([]);
    const receipts = OperationReceiptStore.open(w.a.dataDir);
    let effects = 0;
    const react = () =>
      receipts.execute({
        projectId: PROJECT_A,
        operationId: reactionOperationId(back.journalEpoch, terminal!.row, 'start-review'),
        action: 'runs.create',
        payload: { reactingTo: terminal!.row.eventId },
        reconcile: { kind: 'none' },
        effect: () => {
          effects += 1;
          return { outcome: 'ok', resultRef: { kind: 'run', id } };
        },
      });
    await react();
    await react();
    expect(effects).toBe(1);
    receipts.close();
  });

  it.todo(
    'BLOCKED (#117 composition): through the running service — `startMcpService` attaches no EventCatalog, EventJournal or EventController, so a task finishing while no client is connected leaves no journal row a reconnecting leader could be delivered (no production caller of EventCatalog.attach / EventJournal.open in src/)',
  );
});

// ---- A-16 ----------------------------------------------------------------------------------------

describe('A-16 — MCP state absent or corrupt, the MCP service restarting (N-07, N-08)', () => {
  it('a second MCP service for the same project is refused, and the first keeps serving: never two owners', async () => {
    const w = await openWorld();
    await expect(
      listenMcpSocket({ project: { id: PROJECT_A, name: 'alpha project', root: w.a.root }, version: '0.0.0-ab', tools: w.tools }),
    ).rejects.toThrow(/already serving this project/);
    expect((await w.call('a', 'task_read', { view: 'list' })).isError ?? false).toBe(false);
    expect((await w.cockpit(`/api/v1/p/${PROJECT_A}/runs`)).status).toBe(200);
  });

  it("A's MCP state corrupt, then deleted, then reopened as a restart would: the cockpit and the socket keep working, A's tasks survive and B is untouched", async () => {
    const w = await openWorld();
    const tasksBefore = w.a.store.listRuns().map((run) => run.id).sort();
    const seen = await w.observe(async () => {
      const warnings: string[] = [];
      w.a.journal.close();
      const { writeFileSync, rmSync } = await import('node:fs');
      writeFileSync(w.a.journal.rowsPath, '{"corrupt": true\n', 'utf8');
      const corrupt = EventJournal.open({ dataDir: w.a.dataDir, projectId: PROJECT_A, secretValues: [], warn: (m) => warnings.push(m) });
      corrupt.close();
      rmSync(w.a.journal.rowsPath, { force: true });
      rmSync(w.a.journal.indexPath, { force: true });
      const fresh = EventJournal.open({ dataDir: w.a.dataDir, projectId: PROJECT_A, secretValues: [], warn: (m) => warnings.push(m) });
      opened.push(fresh);
      const list = await w.call('a', 'task_read', { view: 'list' });
      const page = await w.cockpit(`/api/v1/p/${PROJECT_A}/runs`);
      return { warnings, listOk: !(list.isError ?? false), pageStatus: page.status, latestSeq: fresh.latestSeq };
    });
    expect(seen.response.warnings).toHaveLength(1);
    expect(seen.response.warnings[0]).toMatch(/corrupt/);
    expect(seen.response).toMatchObject({ listOk: true, pageStatus: 200, latestSeq: 0 });
    expect(w.a.store.listRuns().map((run) => run.id).sort()).toEqual(tasksBefore);
    expect(seen.after).toBe(seen.before);
    // Reopening A's own store from disk (a restart of the service) keeps every task.
    w.a.store.flush();
    expect(RunStore.open(w.a.dataDir, { keepLive: true }).listRuns().map((run) => run.id).sort()).toEqual(tasksBefore);
  });
});

// ---- A-21 ----------------------------------------------------------------------------------------

describe('A-21 — reconnect with a valid or an old cursor (F-21, N-10)', () => {
  it('an old cursor after the journal was recreated is an explicit gap naming current-state recovery, with the current state beside it', async () => {
    const w = await openWorld();
    const cursors = LeaderCursors.open({ dataDir: w.a.dataDir, projectId: PROJECT_A, journal: w.a.journal, warn: () => {} });
    const oldCursor = cursors.ackedCursor;
    const feed = new LeaderFeed({ journal: w.a.journal, cursors, readState: runStateReader(w.a.store, w.a.journal), wake: () => {} });
    expect(feed.connect(oldCursor).status).toBe('ok');
    feed.disconnect();

    // The journal is lost and recreated (a new epoch) while the leader is offline.
    w.a.journal.close();
    const { rmSync } = await import('node:fs');
    rmSync(w.a.journal.rowsPath, { force: true });
    const recreated = EventJournal.open({ dataDir: w.a.dataDir, projectId: PROJECT_A, secretValues: [], warn: () => {} });
    opened.push(recreated);
    const again = new LeaderFeed({
      journal: recreated,
      cursors: LeaderCursors.open({ dataDir: w.a.dataDir, projectId: PROJECT_A, journal: recreated, warn: () => {} }),
      readState: runStateReader(w.a.store, recreated),
      wake: () => {},
    });
    const gap = again.connect(oldCursor);
    again.disconnect();
    expect(gap.status).toBe('cursor_too_old');
    if (gap.status !== 'cursor_too_old') return;
    expect(gap.gap.recovery.required).toBe('current-state');
    expect(gap.gap.recovery.message).toMatch(/Read the current state first, then continue from resumeCursor/);
    expect(gap.state.tasks.map((task) => task.id)).toEqual(expect.arrayContaining([w.a.ids.queued, w.a.ids.queued2]));
    expect(JSON.stringify(gap)).not.toContain(w.b.id);
  });

  it.todo(
    'BLOCKED (#117 composition): over the MCP socket — no registry tool exposes the #105 reconnect or an acknowledgement, so a leader cannot present a cursor or receive cursor_too_old through MCP (not found in src/mcp/tools/index.ts)',
  );
});

// ---- A-22 ----------------------------------------------------------------------------------------

describe('A-22 — global administration and weakening gates, including by an approval request (F-12, F-22)', () => {
  const GLOBAL_ADMIN = [
    'set_workspace_config',
    'set_workspace_ui_state',
    'create_account',
    'select_account',
    'get_account_details',
    'apply_skill_updates',
    'add_project',
    'remove_project',
    'retry_provider',
    'get_launch_key',
  ] as const;

  it('every global administration action is refused with its boundary, dispatches nothing and changes nothing', async () => {
    const w = await openWorld();
    const workspaceBefore = await (await w.cockpit('/api/v1/workspace/config')).text();
    const beforeA = w.snapshot('a');
    for (const action of GLOBAL_ADMIN) {
      const seen = await w.observe(() => w.call('a', 'project_config', { action }));
      const result = seen.response;
      expect(result.isError, action).toBe(true);
      expect(result.structuredContent, action).toMatchObject({ action, refused: true });
      expect(resultText(result), action).toMatch(/^Refused \(.+\): .+ Nothing was changed\.$/s);
      expect(seen.dispatched, `${action} dispatched nothing`).toEqual([]);
      assertIsolated(w, seen, { echoes: [action] });
    }
    expect(await (await w.cockpit('/api/v1/workspace/config')).text()).toBe(workspaceBefore);
    // The only change in A is the door's own audit record of each refused call (D-06 § 10).
    expect(snapshotChanges(beforeA, w.snapshot('a')).filter((line) => !line.includes('mcp-audit') && line !== '~ audit')).toEqual([]);
  });

  it('only safe effective reads are allowed, and they carry no account identity or secret', async () => {
    const w = await openWorld();
    for (const action of ['get_limits', 'get_capabilities', 'get_account'] as const) {
      const seen = await w.observe(() => w.call('a', 'project_config', { action }));
      expect(seen.response.isError ?? false, action).toBe(false);
      const text = resultText(seen.response);
      expect(text, `${action}: no email address`).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(text, `${action}: no organisation or plan`).not.toMatch(/"(organi[sz]ation|orgName|plan|planName|subscription)"\s*:/i);
      // A read: nothing but GETs, and nothing of B or any secret in what the leader sees. These reads
      // may consult the workspace registry to narrow it (D-03 E-NARROW), so the dispatch allowlist of
      // `assertIsolated` is not the bar here — what reaches the leader is.
      expect(seen.dispatched.filter((entry) => !entry.startsWith('GET ')), `${action} only reads`).toEqual([]);
      const surface = JSON.stringify({ response: seen.response, leaderLog: seen.leaderLog });
      expect(leaked(surface, w.b.names), `${action}: nothing of B`).toEqual([]);
      expect(leaked(surface, w.secrets), `${action}: no secret`).toEqual([]);
      expect(seen.after, `${action}: B unchanged`).toBe(seen.before);
    }
  });

  it('an approval-shaped request to bypass a failing required check is refused, and the gate is reported as a blocker', async () => {
    const w = await openWorld();
    // A controlled forge: the pull request's required check is failing and a review is missing. Every
    // other request goes to the real service through the world's door.
    const mergeState = {
      number: 7,
      title: 'leader work',
      url: 'https://example.invalid/pr/7',
      state: 'open',
      isDraft: false,
      headRef: 'xez/abcdef12',
      baseRef: 'main',
      headSha: 'a'.repeat(40),
      mergeable: 'mergeable',
      reviewDecision: 'review-required',
      checks: [{ name: 'Validate', state: 'failing', required: true }],
      methods: ['squash'],
      defaultMethod: 'squash',
      eligibility: 'blocked',
      blockers: [{ code: 'reviews', message: 'A required review is missing.' }],
      canMerge: false,
      canOverride: true,
    };
    const forwarded: string[] = [];
    const forge: ServiceDispatch = {
      request: (input, init) => {
        const url = new URL(input);
        forwarded.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (url.pathname.endsWith('/merge-state')) {
          return Promise.resolve(new Response(JSON.stringify({ available: true, mergeState }), { headers: { 'content-type': 'application/json' } }));
        }
        return w.service.request(input, init);
      },
    };
    const ctx = { project: { id: PROJECT_A, name: 'alpha project', root: w.a.root }, xezarVersion: '0.0.0-ab', service: forge } as McpToolContext;
    const call = async (args: Record<string, unknown>): Promise<McpToolResult> => {
      const parsed = handoffGitTool.inputSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: 'text', text: parsed.error.message }], isError: true };
      return handoffGitTool.call(parsed.data, ctx);
    };

    // 1. The approval-shaped request: every bypass-looking key is refused outright, never ignored.
    for (const approval of [
      { approvedBy: 'the human', reason: 'the human approved skipping the failing check' },
      { qualityException: true },
      { overrideRules: true },
      { force: true },
    ]) {
      const refused = await call({ action: 'merge', number: 7, expectedHeadSha: 'a'.repeat(40), ...approval });
      expect(refused.isError, JSON.stringify(approval)).toBe(true);
    }
    expect(forwarded, 'a refused approval dispatched nothing').toEqual([]);

    // 2. The same merge without the approval: the gate stands and is REPORTED AS A BLOCKER.
    const blocked = await call({ action: 'merge', number: 7, expectedHeadSha: 'a'.repeat(40) });
    const body = JSON.parse(resultText(blocked)) as Record<string, unknown>;
    expect(body).toMatchObject({ action: 'merge', status: 'failed', blocker: true, nextAction: QUALITY_BLOCKER_NEXT_ACTION });
    expect(String(body.nextAction)).toMatch(/cannot be bypassed/);
    expect(String(body.nextAction)).toMatch(/report this blocker/);
    expect(forwarded.some((entry) => entry.startsWith('POST') && entry.endsWith('/merge')), 'no merge was attempted').toBe(false);
    // The input contract offers no waiver to anyone: no key of the schema reads as an approval.
    const keys = Object.keys((handoffGitTool.inputSchema as unknown as { shape: Record<string, unknown> }).shape);
    expect(keys.filter((key) => /approv|waiv|bypass|override|exception|force/i.test(key))).toEqual([]);
  });

  // FINDING (F-22, A-22), observed 2026-09-11 on this suite's first run: `project_config save_workflow`
  // with `overwrite: true` REPLACES a human-authored project workflow, so a leader can drop its check
  // step (`command: npm test`) — a quality gate — with no refusal and no blocker. MCP refuses to SAVE
  // a check step, but not to DELETE one. D-03 (mcp-settings-classification.md) is silent on it. This
  // suite changes no production code, so the reproduction stays here, skipped and named, until the
  // tool refuses (or reports as a blocker) an overwrite that removes a check step. It is NOT a pass.
  it.skip("FINDING (F-22): overwriting a project workflow to drop its check step (a quality gate) must leave the human's gate in place", async () => {
    const w = await openWorld();
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const path = join(w.a.root, '.xezar', 'workflows', 'gated.yaml');
    const gated = 'name: gated\ndescription: the human gate\nsteps:\n  - id: work\n    prompt: "{{task}}"\n  - id: tests\n    command: npm test\n';
    writeFileSync(path, gated, 'utf8');
    const result = await w.call('a', 'project_config', {
      action: 'save_workflow',
      workflow: { name: 'gated', steps: [{ id: 'work', prompt: '{{task}}' }], overwrite: true },
    });
    expect(readFileSync(path, 'utf8'), `the gate file after the leader's overwrite: ${resultText(result)}`).toBe(gated);
  });
});
