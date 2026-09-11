import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { MCP_STALE_VERSION_GUIDANCE, runVersionResponseSchema, staleVersionRejectionSchema } from '@qodeca/xezar-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runVersion } from '../mcp/stale-write.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp } from './server.ts';

/**
 * #250 — the stale-write check on every route that mutates one run, through the real Hono app and a
 * real store.
 *
 * The engine is a recording stand-in: every call the routes make into `RunManager` lands in
 * `calls`, so "the effect never ran" is observed rather than inferred, and the store is the real
 * one, so "the state is byte-identical" is compared as BYTES — the flushed `runs.json` index, the
 * run's event file and its worktree's listing — never asserted from the answer.
 *
 * Three facts per route:
 *   - a stale `expectedVersion` is refused with D-06 § 4.4's rejection, nothing applied;
 *   - a current one goes through;
 *   - an ABSENT one is the cockpit, and behaves exactly as before — no check, the effect runs.
 */

/** The engine methods that ARE the effect of some route. `isActive` is a read, not an effect. */
const ENGINE_EFFECTS = new Set([
  'cancel',
  'finish',
  'continueRun',
  'sendMessage',
  'editTask',
  'editQueuedMessage',
  'removeQueuedMessage',
  'cancelAutoResume',
]);

let repoRoot: string;
let store: RunStore;
let app: Hono;
let calls: string[];
const savedDryRun = process.env.XEZ_DRY_RUN;

beforeEach(() => {
  // `POST /runs/:id/pr` fakes its URL under dry run: no push, no `gh`.
  process.env.XEZ_DRY_RUN = '1';
  repoRoot = mkdtempSync(join(tmpdir(), 'xez-stale-routes-'));
  store = RunStore.open(join(repoRoot, '.local/xezar'));
  calls = [];
  const manager = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== 'string' || name === 'then') return undefined;
        return (...args: unknown[]) => {
          if (ENGINE_EFFECTS.has(name)) calls.push(name);
          if (name === 'isActive') return false;
          if (name === 'continueRun') return { ok: true };
          if (name === 'editQueuedMessage') return { id: String(args[1]), text: 'edited', createdAt: new Date(0).toISOString() };
          return true;
        };
      },
    },
  ) as unknown as RunManager;
  app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
});

afterEach(() => {
  store.flush();
  rmSync(repoRoot, { recursive: true, force: true });
  if (savedDryRun === undefined) delete process.env.XEZ_DRY_RUN;
  else process.env.XEZ_DRY_RUN = savedDryRun;
});

const newRun = (): RunRecord => store.createRun({ title: 'the task', workflow: 'quick-task', task: 'do the thing', steps: [] });

/** A task parked with a real worktree directory (with a file in it) and a branch. */
function withWorktree(id: string): void {
  const worktree = join(repoRoot, '.local/xezar/worktrees', id);
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, 'keep.txt'), 'the agent’s work\n', 'utf8');
  store.updateRun(id, { status: 'review', worktreePath: worktree, branch: `xez/${id.slice(0, 8)}` });
}

/** A queued task with one stacked message, `m1`. */
function withQueuedMessage(id: string): void {
  store.updateRun(id, { status: 'queued', queuedMessages: [{ id: 'm1', text: 'first', createdAt: new Date(0).toISOString() }] });
}

interface Case {
  name: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  path: (id: string) => string;
  body?: Record<string, unknown>;
  /** The engine call that IS this route's effect, when the effect is an engine call. */
  effect?: string;
  prepare?: (id: string) => void;
}

const run = (id: string, rest = ''): string => `/api/v1/runs/${id}${rest}`;

const CASES: Case[] = [
  { name: 'PATCH /runs/:id (rename)', method: 'PATCH', path: (id) => run(id), body: { title: 'the leader’s title' } },
  {
    name: 'PATCH /runs/:id (brief)',
    method: 'PATCH',
    path: (id) => run(id),
    body: { task: 'a different brief' },
    effect: 'editTask',
    prepare: (id) => void store.updateRun(id, { status: 'queued' }),
  },
  { name: 'POST /runs/:id/archive', method: 'POST', path: (id) => run(id, '/archive'), body: { archived: true } },
  { name: 'POST /runs/:id/pin', method: 'POST', path: (id) => run(id, '/pin'), body: { pinned: true } },
  { name: 'POST /runs/:id/cancel', method: 'POST', path: (id) => run(id, '/cancel'), effect: 'cancel' },
  { name: 'POST /runs/:id/finish', method: 'POST', path: (id) => run(id, '/finish'), effect: 'finish' },
  { name: 'POST /runs/:id/continue', method: 'POST', path: (id) => run(id, '/continue'), body: { text: 'go on' }, effect: 'continueRun' },
  {
    name: 'POST /runs/:id/messages',
    method: 'POST',
    path: (id) => run(id, '/messages'),
    body: { text: 'hello' },
    effect: 'sendMessage',
    prepare: (id) => void store.updateRun(id, { status: 'queued' }),
  },
  {
    name: 'PATCH /runs/:id/queued-messages/:msgId',
    method: 'PATCH',
    path: (id) => run(id, '/queued-messages/m1'),
    body: { text: 'edited' },
    effect: 'editQueuedMessage',
    prepare: withQueuedMessage,
  },
  {
    name: 'DELETE /runs/:id/queued-messages/:msgId',
    method: 'DELETE',
    path: (id) => run(id, '/queued-messages/m1'),
    effect: 'removeQueuedMessage',
    prepare: withQueuedMessage,
  },
  { name: 'DELETE /runs/:id/auto-resume', method: 'DELETE', path: (id) => run(id, '/auto-resume'), effect: 'cancelAutoResume' },
  { name: 'POST /runs/:id/git/commit', method: 'POST', path: (id) => run(id, '/git/commit'), body: { message: 'wip' }, prepare: withWorktree },
  { name: 'POST /runs/:id/git/push', method: 'POST', path: (id) => run(id, '/git/push'), prepare: withWorktree },
  { name: 'POST /runs/:id/pr', method: 'POST', path: (id) => run(id, '/pr'), prepare: withWorktree },
  { name: 'POST /runs/:id/remove-worktree', method: 'POST', path: (id) => run(id, '/remove-worktree'), prepare: withWorktree },
  { name: 'DELETE /runs/:id', method: 'DELETE', path: (id) => run(id), prepare: withWorktree },
];

/** Send the route's request. No body at all when there is nothing to say — the cockpit's bodyless
 *  calls must keep working exactly as they did. */
function send(c: Case, id: string, body: Record<string, unknown> | undefined): Promise<Response> {
  const hasBody = body !== undefined && Object.keys(body).length > 0;
  return apiRequest(app, c.path(id), {
    method: c.method,
    ...(hasBody ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
}

async function versionOf(id: string): Promise<string> {
  const res = await apiRequest(app, run(id, '/version'));
  expect(res.status).toBe(200);
  return runVersionResponseSchema.parse(await res.json()).version;
}

/** A human changes the task from the cockpit — a PATCH with no token, the second path. */
async function humanRenames(id: string): Promise<void> {
  const res = await send(CASES[0]!, id, { title: 'renamed by a human' });
  expect(res.status).toBe(200);
}

/** Everything the task IS on disk, as bytes: the flushed index, its events and its worktree. */
function onDisk(record: RunRecord) {
  store.flush();
  const worktree = record.worktreePath;
  return {
    index: readFileSync(join(store.dataDir, 'runs.json')),
    events: existsSync(join(store.dataDir, 'runs', `${record.id}.ndjson`))
      ? readFileSync(join(store.dataDir, 'runs', `${record.id}.ndjson`))
      : null,
    worktree: worktree && existsSync(worktree) ? readdirSync(worktree).map((f) => [f, readFileSync(join(worktree, f))]) : null,
  };
}

describe('every run-mutating route refuses a stale expectedVersion (#250)', () => {
  it.each(CASES)('$name: a stale token is refused and the task stays byte-identical', async (c) => {
    const task = newRun();
    c.prepare?.(task.id);
    const read = await versionOf(task.id); // the leader reads the task…
    await humanRenames(task.id); // …a human changes it…
    const current = await versionOf(task.id);
    expect(current).not.toBe(read);

    const before = onDisk(store.getRun(task.id)!);
    calls.length = 0;
    const res = await send(c, task.id, { ...c.body, expectedVersion: read }); // …and the leader acts on its old read

    expect(res.status).toBe(409);
    expect(staleVersionRejectionSchema.parse(await res.json())).toEqual({
      status: 'conflict',
      applied: false,
      error: 'stale_version',
      resource: { kind: 'run', id: task.id },
      currentVersion: current,
      changedSince: true,
      guidance: MCP_STALE_VERSION_GUIDANCE,
    });
    expect(calls).toEqual([]);
    expect(onDisk(store.getRun(task.id)!)).toEqual(before);
    expect(await versionOf(task.id)).toBe(current);
  });

  it.each(CASES)('$name: a current token goes through', async (c) => {
    const task = newRun();
    c.prepare?.(task.id);
    await humanRenames(task.id);
    const res = await send(c, task.id, { ...c.body, expectedVersion: await versionOf(task.id) });
    expect(staleVersionRejectionSchema.safeParse(await res.json().catch(() => undefined)).success).toBe(false);
    if (c.effect) expect(calls).toEqual([c.effect]);
  });

  it.each(CASES)('$name: no token is the cockpit — no check, the effect runs as before', async (c) => {
    const task = newRun();
    c.prepare?.(task.id);
    const read = await versionOf(task.id);
    await humanRenames(task.id);
    expect(await versionOf(task.id)).not.toBe(read); // the task moved, and nobody asked
    const res = await send(c, task.id, c.body);
    // Not a rejection. (A git route's own 409 — this directory is no repository — is the effect
    // running and failing, which is exactly "as before".)
    expect(staleVersionRejectionSchema.safeParse(await res.json().catch(() => undefined)).success).toBe(false);
    expect(res.status).toBeLessThan(500);
    if (c.effect) expect(calls).toEqual([c.effect]);
  });

  it("refuses another task's token, even a current one", async () => {
    const task = newRun();
    const other = newRun();
    const before = onDisk(store.getRun(task.id)!);
    const res = await send(CASES[0]!, task.id, { title: 'x', expectedVersion: await versionOf(other.id) });
    expect(res.status).toBe(409);
    expect(onDisk(store.getRun(task.id)!)).toEqual(before);
  });

  it('refuses a token with an unknown tag rather than reading it', async () => {
    const task = newRun();
    const forged = (await versionOf(task.id)).replace(/^rev1:/, 'rev2:');
    const res = await send(CASES[3]!, task.id, { expectedVersion: forged });
    expect(res.status).toBe(409);
    expect(store.getRun(task.id)?.pinned).not.toBe(true);
  });

  it('refuses an empty token at the validation boundary, never as a pass', async () => {
    const task = newRun();
    const res = await send(CASES[3]!, task.id, { expectedVersion: '' });
    expect(res.status).toBe(400);
    expect(store.getRun(task.id)?.pinned).not.toBe(true);
  });
});

describe('GET /api/v1/runs/:id/version (#250)', () => {
  it('answers the same token runVersion computes, and 404 for an unknown task', async () => {
    const task = newRun();
    expect(await versionOf(task.id)).toBe(runVersion(store, task.id));
    expect((await apiRequest(app, run('no-such-task', '/version'))).status).toBe(404);
  });

  it('moves when a decision field changes, and not when telemetry does', async () => {
    const task = newRun();
    const first = await versionOf(task.id);
    store.updateRun(task.id, { tokensUsed: 12_345, costUsd: 0.42 });
    expect(await versionOf(task.id)).toBe(first);
    store.setPinned(task.id, true);
    expect(await versionOf(task.id)).not.toBe(first);
  });

  it('is only a read: asking for it changes nothing on disk', async () => {
    const task = newRun();
    const before = onDisk(store.getRun(task.id)!);
    await versionOf(task.id);
    expect(onDisk(store.getRun(task.id)!)).toEqual(before);
  });
});
