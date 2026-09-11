import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { AuditTrail } from '../../src/mcp/audit-trail.ts';
import { EventController, type EventDispatch } from '../../src/mcp/event-controller.ts';
import { McpJournalCursorError } from '../../src/mcp/event-journal.ts';
import {
  openCursor,
  ownAutomationReceipt,
  ownGroup,
  ownGroupMember,
  ownQueuedMessage,
  ownRun,
  ownSweep,
  ownershipScope,
  partitionOwned,
  sealCursor,
  type OwnershipAuditEntry,
  type OwnershipScope,
} from '../../src/mcp/resource-ownership.ts';
import { McpServiceAdapter, McpServiceAdapterError } from '../../src/mcp/service-adapter.ts';
import { McpScopeError, bindMcpSession } from '../../src/mcp/session-binding.ts';
import { reclaimWorktrees } from '../../src/runs/retention.ts';
import { ProjectOwnership } from '../../src/workspace/project-owner.ts';
import {
  PROJECT_A,
  PROJECT_B,
  assertIsolated,
  auditFile,
  createAbWorld,
  leaked,
  nowhereId,
  type AbWorld,
  type AbWorldOptions,
} from '../helpers/ab-fixture.ts';

/**
 * #115 — the ISOLATION half of the whole-feature acceptance suite, at the CORE-MODULE level: the
 * session binding, the per-resource ownership checks and their partial-success policy, sealed
 * cursors, the event journal and controller, the audit trail and the connection file's Git
 * status. The route-level half — every tool over the real MCP socket and bridge — is
 * `src/mcp/acceptance-isolation.test.ts` (vitest).
 *
 * Fast-gate rules hold: no HTTP server and no browser. The shared A/B world is built without MCP
 * sockets (`sockets: false`); the app answers in-process. Every case follows § 9: `world.observe`
 * records B's full state and external effects before and after, and `assertIsolated` checks the
 * answer, both buses and journals, every log and B's byte-identical state — then the case checks
 * the answer itself, because an error code alone proves nothing.
 */

const skip = process.platform === 'win32';

async function inWorld(options: AbWorldOptions, body: (world: AbWorld) => Promise<void>): Promise<void> {
  const world = await createAbWorld({ sockets: false, ...options });
  try {
    await body(world);
  } finally {
    await world.dispose();
  }
}

function scopeOf(world: AbWorld, side: 'a' | 'b', audit: OwnershipAuditEntry[] = []): OwnershipScope {
  const s = world[side];
  return ownershipScope({ root: s.root, store: s.store, automationStore: s.automations }, (e) => audit.push(e));
}

const REFUSED = { ok: false, code: 'not_found', message: 'not found in this project' } as const;

test('A-02 — no spelling of a project binds a session, and the A binding refuses every B id before acting', { skip }, async () => {
  await inWorld({}, async (world) => {
    const spellings = ['default', 'Default', 'default ', `${PROJECT_B}/`, `./${PROJECT_B}`, world.b.root, `p/${PROJECT_B}`, ''];
    let operations = 0;
    const seen = await world.observe(async () => {
      const refusals: string[] = [];
      for (const spelling of spellings) {
        await bindMcpSession(world.contexts, spelling).then(
          () => refusals.push('BOUND'),
          (err: unknown) => refusals.push(err instanceof McpScopeError ? `${err.reason}|${err.message}|${err.projectId}` : String(err)),
        );
      }
      const bound = await bindMcpSession(world.contexts, PROJECT_A);
      const foreign: string[] = [];
      for (const id of [world.b.ids.done, world.b.ids.queued, ...world.b.ids.variants, '..', `../${world.b.ids.done}`, `/p/${PROJECT_B}`]) {
        await bound
          .withRun(id, () => {
            operations += 1;
          })
          .catch((err: unknown) => foreign.push(err instanceof McpScopeError ? `${err.reason}|${err.message}` : String(err)));
      }
      // The service adapter: a path-shaped id is refused before any dispatch; a B id is looked up
      // under A's scope only, where it does not exist.
      const adapter = new McpServiceAdapter({ projectId: PROJECT_A, service: world.service });
      const adapted = [await adapter.getRun('..'), await adapter.getRun(`../p/${PROJECT_B}/runs/${world.b.ids.done}`), await adapter.getRun(world.b.ids.done)];
      let badBinding = '';
      try {
        new McpServiceAdapter({ projectId: `../${PROJECT_B}`, service: world.service });
      } catch (err) {
        badBinding = err instanceof McpServiceAdapterError ? 'refused' : String(err);
      }
      return { refusals, foreign, boundTo: bound.projectId, own: (await bound.run(world.a.ids.done)).id, adapted, badBinding };
    });
    assertIsolated(world, seen, { echoes: [...spellings.filter(Boolean), world.b.ids.done] });
    assert.deepEqual(
      seen.response.refusals,
      spellings.map(() => 'unknown-project|this MCP session is not bound to a registered xezar project; reconnect from the project folder|'),
    );
    assert.deepEqual(seen.response.foreign, Array(7).fill('not-in-project|no such resource in this project'));
    assert.equal(operations, 0);
    assert.equal(seen.response.boundTo, PROJECT_A);
    assert.equal(seen.response.own, world.a.ids.done);
    assert.equal(seen.response.badBinding, 'refused');
    const [dots, path, foreignRun] = seen.response.adapted;
    assert.deepEqual([dots!.ok, dots!.status, path!.ok, path!.status], [false, 400, false, 400]);
    assert.deepEqual([foreignRun!.ok, foreignRun!.status], [false, 404]);
    // Only the one B-id lookup was dispatched, and inside A.
    assert.deepEqual(seen.dispatched, [`GET /api/v1/p/${PROJECT_A}/runs/${world.b.ids.done}`]);
  });
});

test('A-03 — the partial-success policy: a mixed A/B list, validated whole before any effect', { skip }, async () => {
  await inWorld({}, async (world) => {
    const audit: OwnershipAuditEntry[] = [];
    const nowhere = nowhereId();
    const seen = await world.observe(async () => {
      const scope = scopeOf(world, 'a', audit);
      const runs = await partitionOwned(scope, 'run', [world.b.ids.done, world.a.ids.done, world.a.ids.done, nowhere, world.a.ids.queued2], ownRun);
      // Acting only on `allowed`, and only after every element was checked.
      for (const { value } of runs.allowed) world.a.store.setArchived(value.id, true);
      const messages = await partitionOwned(scope, 'queued-message', [world.b.ids.message, world.a.ids.message], (s, id) =>
        ownQueuedMessage(s, world.a.ids.queued, id),
      );
      const foreignTaskMessage = ownQueuedMessage(scope, world.b.ids.queued, world.b.ids.message);
      const receipts = await partitionOwned(scope, 'automation-receipt', [world.a.ids.receipt, world.b.ids.receipt, world.b.ids.receipt], ownAutomationReceipt);
      const shape = (b: { outcome: string; allowed: Array<{ index: number }>; refused: unknown[] }) => ({
        outcome: b.outcome,
        allowed: b.allowed.map((a) => a.index),
        refused: b.refused,
      });
      return { runs: shape(runs), messages: shape(messages), foreignTaskMessage, receipts: shape(receipts) };
    });
    assertIsolated(world, seen);
    assert.deepEqual(seen.response.runs, {
      outcome: 'partial',
      allowed: [1, 4],
      refused: [
        { index: 0, code: 'not_found' },
        { index: 2, code: 'duplicate' },
        { index: 3, code: 'not_found' },
      ],
    });
    assert.deepEqual(seen.response.messages, { outcome: 'partial', allowed: [1], refused: [{ index: 0, code: 'not_found' }] });
    assert.deepEqual(seen.response.foreignTaskMessage, REFUSED);
    // A repeated foreign element keeps its first position's code: "duplicate" would confirm it exists.
    assert.deepEqual(seen.response.receipts, {
      outcome: 'partial',
      allowed: [0],
      refused: [
        { index: 1, code: 'not_found' },
        { index: 2, code: 'not_found' },
      ],
    });
    // The refusal log: check, code and position — no field that could hold an id.
    assert.deepEqual(audit, [
      { check: 'run', code: 'not_found', index: 0 },
      { check: 'run', code: 'duplicate', index: 2 },
      { check: 'run', code: 'not_found', index: 3 },
      { check: 'queued-message', code: 'not_found', index: 0 },
      { check: 'run', code: 'not_found' },
      { check: 'automation-receipt', code: 'not_found', index: 1 },
      { check: 'automation-receipt', code: 'not_found', index: 2 },
    ]);
    // Exactly the owned runs changed, once each.
    const changed = seen.events.a.filter((e) => e.kind === 'run').map((e) => (e.payload as { id: string }).id);
    assert.deepEqual(changed, [world.a.ids.done, world.a.ids.queued2]);
  });
});

test('A-03 — a group with a member reaching into B is refused whole, and so is the reclaim sweep', { skip }, async () => {
  await inWorld({ hostile: true }, async (world) => {
    const h = world.hostile!;
    const audit: OwnershipAuditEntry[] = [];
    const seen = await world.observe(async () => {
      const scope = scopeOf(world, 'a', audit);
      const sweep = await ownSweep(scope, 'reclaim-worktrees');
      return {
        mixed: await ownGroup(scope, h.mixedGroup),
        mixedMember: await ownGroupMember(scope, h.mixedGroup, h.legit),
        foreignWinner: await ownGroupMember(scope, world.a.ids.group, world.b.ids.variants[0]),
        foreignGroup: await ownGroup(scope, world.b.ids.group),
        // The flow a sweep follows: validate, and only on ok call the service that deletes.
        sweep: sweep.ok ? { ok: true, reclaimed: await reclaimWorktrees(world.a.root, world.a.store, 1) } : sweep,
        ownGroup: (await ownGroup(scope, world.a.ids.group)).ok,
      };
    });
    assertIsolated(world, seen);
    const { ownGroup: control, ...refusals } = seen.response;
    for (const [name, value] of Object.entries(refusals)) assert.deepEqual(value, REFUSED, name);
    assert.equal(control, true);
    assert.deepEqual(audit, [
      { check: 'sweep', code: 'not_found' },
      { check: 'group', code: 'not_found' },
      { check: 'group', code: 'not_found' },
      { check: 'group-member', code: 'not_found' },
      { check: 'group', code: 'not_found' },
    ]);
    assert.ok(existsSync(join(world.b.worktree, 'notes.txt')), "B's worktree is still there");
    assert.deepEqual(seen.events.a, []);
  });
});

test('A-03 control — without the ownership check the same sweep deletes B’s worktree', { skip }, async () => {
  await inWorld({ hostile: true }, async (world) => {
    const before = world.snapshot('b');
    await reclaimWorktrees(world.a.root, world.a.store, 1);
    assert.notEqual(world.snapshot('b'), before);
    assert.equal(existsSync(join(world.b.worktree, 'notes.txt')), false);
  });
});

test('A-04 — a B cursor, a B journal cursor and a forged B trail line give A nothing', { skip }, async () => {
  await inWorld({}, async (world) => {
    const bScope = scopeOf(world, 'b');
    const sealed = [sealCursor(bScope, 'tasks', 'page-2'), sealCursor(bScope, `run:${world.b.ids.done}:history`, 'page-2')];
    const journalCursor = world.b.journal.headCursor();
    // A line naming B, planted into A's own trail file (a copied or hand-edited `.local/xezar`).
    const forged = readFileSync(auditFile(world.b), 'utf8').trim().split('\n')[0]!;
    const audit: OwnershipAuditEntry[] = [];
    const seen = await world.observe(() => {
      appendFileSync(auditFile(world.a), `${forged}\n`);
      const scope = scopeOf(world, 'a', audit);
      let journal: unknown;
      try {
        journal = world.a.journal.read({ cursor: journalCursor });
      } catch (err) {
        journal = err instanceof McpJournalCursorError ? err.rejection : String(err);
      }
      return {
        cursors: [openCursor(scope, 'tasks', sealed[0]), openCursor(scope, `run:${world.b.ids.done}:history`, sealed[1]), openCursor(scope, 'tasks', 'garbage')],
        journal,
        trail: world.a.audit.read(),
        own: openCursor(scope, 'tasks', sealCursor(scope, 'tasks', 'page-2')),
      };
    });
    assertIsolated(world, seen, { echoes: [world.b.ids.done] });
    const invalid = { ok: false, code: 'invalid_cursor', message: 'invalid cursor — request the first page again' };
    assert.deepEqual(seen.response.cursors, [invalid, invalid, invalid]);
    assert.deepEqual(seen.response.journal, { error: 'cursor_project_mismatch', message: 'this cursor belongs to another project' });
    // The forged B line is not A's: the scoped read drops it without saying how many it dropped.
    assert.deepEqual(seen.response.trail, { entries: [], quarantined: 0 });
    assert.deepEqual(seen.response.own, { ok: true, value: 'page-2' });
    // Neither cursor names its project or resource: they are sealed, not labelled.
    for (const cursor of sealed) assert.deepEqual(leaked(Buffer.from(cursor, 'base64url').toString('utf8'), world.b.names), []);
  });
});

test('A-04 — A’s event controller delivers A’s journal only, while B keeps appending', { skip }, async () => {
  await inWorld({}, async (world) => {
    const owner = new ProjectOwnership({ dataDir: world.a.dataDir, projectId: PROJECT_A, autoRenew: false });
    assert.equal((await owner.acquire('ab-core-session')).outcome, 'owner');
    const delivered: EventDispatch[] = [];
    const started = EventController.start({
      journal: world.a.journal,
      ownership: owner,
      sessionKey: 'ab-core-session',
      adapter: { deliver: async (dispatch) => void delivered.push(dispatch) },
      heartbeatMs: 3_600_000,
    });
    assert.equal(started.outcome, 'started');
    const controller = started.outcome === 'started' ? started.controller : undefined;
    try {
      const row = (id: string, summary: string) =>
        ({ category: 'E-01', kind: 'task.terminal', subject: { type: 'run', id, version: null }, origin: 'human', causedBy: null, summary }) as const;
      for (let i = 0; i < 5; i += 1) world.b.journal.append(row(world.b.ids.done, `BRAVO journal row live ${i}`));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const seen = await world.observe(async () => {
        world.a.journal.append(row(world.a.ids.done, 'ALPHA journal row live'));
        for (let i = 0; i < 50 && delivered.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        return delivered;
      });
      assertIsolated(world, seen);
      assert.deepEqual(
        seen.response.flatMap((d) => d.events.map((e) => [d.projectId, e.projectId, e.summary])),
        [[PROJECT_A, PROJECT_A, 'ALPHA journal row live']],
      );
      assert.equal(controller?.status().deliveredSeq, world.a.journal.latestSeq);
    } finally {
      controller?.close();
      owner.dispose();
    }
  });
});

test('A-12 — the connection file stays out of Git, and its secrets out of the journal and the trail', { skip }, async () => {
  await inWorld({ connection: true }, async (world) => {
    const c = world.connection!;
    const seen = await world.observe(() => {
      world.a.journal.append({
        category: 'E-02',
        kind: 'task.attention',
        subject: { type: 'run', id: world.a.ids.done, version: null },
        origin: 'system',
        causedBy: null,
        summary: `ALPHA attention: ${c.credential} and ${c.token}`,
      });
      const mcp = world.a.audit.channel('mcp');
      // A client echoing both secrets in every identifier it controls, and a careless caller
      // spreading the whole connection file into an operation.
      mcp.record(
        { action: 'mcp.task-read', resource: { kind: 'run', id: c.credential }, operationId: c.token, payload: { c } },
        { outcome: 'rejected', errorCode: 'not_found' },
      );
      mcp.record(
        { action: 'mcp.task-read', resource: { kind: 'run', id: c.token }, operationId: c.credential, expectedVersion: `rev1:run:${c.token}:1:0123456789ab` },
        { outcome: 'ok' },
      );
      mcp.record({ ...(JSON.parse(readFileSync(c.path, 'utf8')) as object), action: 'mcp.organise-work' } as never, { outcome: 'ok' });
      return { journal: readFileSync(world.a.journal.rowsPath, 'utf8'), trail: readFileSync(auditFile(world.a), 'utf8') };
    });
    assertIsolated(world, seen);
    // Populated input: the file holds both secrets, the journal row and three trail entries exist.
    assert.ok(readFileSync(c.path, 'utf8').includes(c.credential));
    assert.match(seen.response.journal, /ALPHA attention: \[REDACTED\] and \[REDACTED\]/);
    assert.equal(seen.response.trail.trim().split('\n').length, 3);
    for (const raw of [seen.response.journal, seen.response.trail]) {
      assert.deepEqual(leaked(raw, [c.credential, c.token, world.a.root, 'mcp-connection']), []);
    }
    // A second trail over the same file, handed no secrets, still finds none to read back.
    const reread = new AuditTrail({ projectId: PROJECT_A, dataDir: world.a.dataDir }).read();
    assert.equal(reread.entries.length, 3);
    assert.deepEqual(leaked(JSON.stringify(reread), [c.credential, c.token]), []);

    const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(git(world.a.root, 'check-ignore', '.local/xezar/mcp-connection.json').trim(), '.local/xezar/mcp-connection.json');
    for (const root of [world.a.root, world.b.root]) {
      assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), '');
      assert.equal(git(root, 'add', '-A', '--dry-run'), '');
      assert.deepEqual(leaked(git(root, 'log', '--all', '-p'), [c.credential, c.token]), []);
    }
  });
});
