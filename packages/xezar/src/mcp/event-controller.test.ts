import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MCP_JOURNAL_PAGE_ROWS,
  mcpProjectOccupiedErrorSchema,
  mcpSessionExpiredErrorSchema,
  type McpJournalAppendInput,
} from '@qodeca/xezar-contract';

import { OWNER_CLAIM_DIR, ProjectOwnership } from '../workspace/project-owner.ts';
import {
  EVENT_CONTROLLER_HEARTBEAT_MS,
  EVENT_DELIVERY_ATTEMPTS,
  EventController,
  type EventControllerOptions,
  type EventDispatch,
  type ReactionAdapter,
} from './event-controller.ts';
import { EventJournal } from './event-journal.ts';

/**
 * #107 — the non-model event controller. The three acceptance tests of the issue are the first
 * three `describe` blocks; the rest pin the D-05 cursor rules the controller implements.
 *
 * The fake adapter stands in for a client: `deliver` is the non-model transport hand-off, and a
 * delivery that succeeds is followed by exactly one simulated model turn, reported back through
 * `recordReaction` the way a real adapter reports one. So `turns` counts model turns, and every
 * other call — heartbeats, failed attempts, acknowledgements — must leave it where it was.
 */

const T0 = Date.parse('2026-09-01T00:00:00.000Z');

let dataDir: string;
let journals: EventJournal[] = [];
let owners: ProjectOwnership[] = [];
let controllers: EventController[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  dataDir = mkdtempSync(join(tmpdir(), 'xez-event-controller-'));
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.close();
  for (const owner of owners.splice(0)) owner.dispose();
  for (const journal of journals.splice(0)) journal.close();
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
});

function openJournal(projectId = 'alpha', dir = dataDir): EventJournal {
  const journal = EventJournal.open({ dataDir: dir, projectId, secretValues: [], warn: () => {}, now: () => T0 });
  journals.push(journal);
  return journal;
}

function ownerFor(projectId = 'alpha', dir = dataDir): ProjectOwnership {
  const owner = new ProjectOwnership({ dataDir: dir, projectId, autoRenew: false, now: () => T0 });
  owners.push(owner);
  return owner;
}

function event(n: number): McpJournalAppendInput {
  return {
    category: 'E-01',
    kind: 'task.terminal',
    subject: { type: 'run', id: `run-${n}`, version: null },
    origin: 'human',
    causedBy: null,
    summary: `task ${n} finished`,
  };
}

function appendMany(journal: EventJournal, count: number): void {
  const from = journal.latestSeq + 1;
  for (let n = from; n < from + count; n++) journal.append(event(n));
}

/** Let every microtask and resolved adapter promise run. `setImmediate` is not faked. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

class FakeClient implements ReactionAdapter {
  dispatches: EventDispatch[] = [];
  attempts = 0;
  heartbeats = 0;
  turns = 0;
  /** Fail this many next delivery attempts (a dropped transport). */
  failNext = 0;
  /** Deliver without ever starting a turn (an idle client that got the event and did not react). */
  react = true;
  /** When set, `deliver` waits on it — a dispatch held in flight. */
  gate: Promise<void> | undefined;
  heartbeatFails = false;
  controller: EventController | undefined;

  async deliver(dispatch: EventDispatch): Promise<void> {
    this.attempts++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('transport dropped');
    }
    if (this.gate) await this.gate;
    this.dispatches.push(dispatch);
    const last = dispatch.events.at(-1);
    if (this.react && last) {
      this.turns++;
      queueMicrotask(() => this.controller?.recordReaction(last.journalSeq));
    }
  }

  async heartbeat(): Promise<void> {
    this.heartbeats++;
    if (this.heartbeatFails) throw new Error('no pong');
  }

  deliveredIds(): string[] {
    return this.dispatches.flatMap((d) => d.events.map((row) => row.eventId));
  }
}

function start(
  journal: EventJournal,
  owner: ProjectOwnership,
  client: FakeClient | undefined,
  over: Partial<EventControllerOptions> = {},
) {
  const result = EventController.start({
    journal,
    ownership: owner,
    sessionKey: 'session-a',
    ...(client ? { adapter: client } : {}),
    sleep: async () => {},
    random: () => 0,
    warn: () => {},
    ...over,
  });
  if (result.outcome !== 'refused') {
    controllers.push(result.controller);
    if (client) client.controller = result.controller;
  }
  return result;
}

async function startedFor(journal: EventJournal, owner: ProjectOwnership, client: FakeClient, over: Partial<EventControllerOptions> = {}) {
  const result = start(journal, owner, client, over);
  if (result.outcome !== 'started') throw new Error(`expected started, got ${result.outcome}`);
  await settle();
  return result.controller;
}

const claimFiles = (dir = dataDir) => {
  const path = join(dir, OWNER_CLAIM_DIR);
  return existsSync(path) ? readdirSync(path) : [];
};

describe('acceptance 1 — a burst is coalesced, costs no extra model turn, and survives a transport drop', () => {
  it('coalesces a burst into ceil(N / 100) dispatches, every row intact, once, in order', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    await owner.acquire('session-a');
    const client = new FakeClient();
    const controller = await startedFor(journal, owner, client);
    expect(client.dispatches).toHaveLength(0);

    appendMany(journal, 250);
    await settle();

    // The documented number: D-05 N3 forbids merging rows, so what coalesces is dispatches — one page
    // (B-20) per dispatch.
    expect(client.dispatches.map((d) => d.events.length)).toEqual([100, 100, 50]);
    expect(client.dispatches).toHaveLength(Math.ceil(250 / MCP_JOURNAL_PAGE_ROWS));
    expect(client.deliveredIds()).toEqual(Array.from({ length: 250 }, (_, i) => `alpha:${i + 1}`));
    expect(controller.status()).toMatchObject({ state: 'idle', deliveredSeq: 250, reactedSeq: 250 });
  });

  it('sends rows that arrive while a dispatch is in flight together in the next one', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    await owner.acquire('session-a');
    const client = new FakeClient();
    await startedFor(journal, owner, client);

    let open!: () => void;
    client.gate = new Promise((resolve) => (open = resolve));
    journal.append(event(1));
    await settle();
    // Seven more land while the first dispatch is still held by the client.
    for (let n = 2; n <= 8; n++) {
      journal.append(event(n));
      await settle();
    }
    expect(client.attempts).toBe(1);
    client.gate = undefined;
    open();
    await settle();

    expect(client.dispatches.map((d) => d.events.map((row) => row.journalSeq))).toEqual([[1], [2, 3, 4, 5, 6, 7, 8]]);
  });

  it('consumes zero model turns for heartbeats, retries and acknowledgements', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    await owner.acquire('session-a');
    const client = new FakeClient();
    const controller = await startedFor(journal, owner, client);

    // Heartbeats: five liveness periods with nothing to deliver.
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(EVENT_CONTROLLER_HEARTBEAT_MS);
    await settle();
    expect(client.heartbeats).toBe(5);
    expect(client.turns).toBe(0);
    expect(client.attempts).toBe(0);

    // Retries: the transport drops three times, then takes the rows. One event batch, one turn.
    client.failNext = 3;
    appendMany(journal, 4);
    await settle();
    expect(client.attempts).toBe(4);
    expect(client.dispatches).toHaveLength(1);
    expect(client.turns).toBe(1);

    // Acknowledgements: ten of them, including repeats and an out-of-range one. No adapter call at all.
    const before = { attempts: client.attempts, heartbeats: client.heartbeats, turns: client.turns };
    for (const seq of [1, 2, 2, 3, 4, 4, 1, 4, 99, 0]) controller.ack(seq);
    await settle();
    expect({ attempts: client.attempts, heartbeats: client.heartbeats, turns: client.turns }).toEqual(before);
    expect(controller.status().ackedSeq).toBe(4);

    // And heartbeats after a delivery do not re-send what was delivered.
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(EVENT_CONTROLLER_HEARTBEAT_MS);
    await settle();
    expect(client.turns).toBe(1);
    expect(client.deliveredIds()).toEqual(['alpha:1', 'alpha:2', 'alpha:3', 'alpha:4']);
  });

  it('bounds recovery: one round is at most the documented attempts, then it waits for the next heartbeat', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    await owner.acquire('session-a');
    const client = new FakeClient();
    const warnings: string[] = [];
    const controller = await startedFor(journal, owner, client, { warn: (m) => warnings.push(m) });

    client.failNext = Number.POSITIVE_INFINITY;
    appendMany(journal, 3);
    await settle();
    expect(client.attempts).toBe(EVENT_DELIVERY_ATTEMPTS);
    expect(controller.state).toBe('disconnected');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('task 1 finished');

    // More rows while disconnected queue in the journal; they do not start another round.
    appendMany(journal, 2);
    await settle();
    expect(client.attempts).toBe(EVENT_DELIVERY_ATTEMPTS);

    // The heartbeat starts exactly one more bounded round.
    await vi.advanceTimersByTimeAsync(EVENT_CONTROLLER_HEARTBEAT_MS);
    await settle();
    expect(client.attempts).toBe(2 * EVENT_DELIVERY_ATTEMPTS);
    expect(client.turns).toBe(0);

    // The transport comes back: the next heartbeat delivers everything outstanding, in one dispatch.
    client.failNext = 0;
    await vi.advanceTimersByTimeAsync(EVENT_CONTROLLER_HEARTBEAT_MS);
    await settle();
    expect(client.dispatches.map((d) => d.events.map((row) => row.journalSeq))).toEqual([[1, 2, 3, 4, 5]]);
    expect(client.turns).toBe(1);
    expect(controller.status()).toMatchObject({ state: 'idle', deliveredSeq: 5 });
  });

  it('recovers at once when the adapter signals that its transport is back', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    await owner.acquire('session-a');
    const client = new FakeClient();
    const controller = await startedFor(journal, owner, client);

    client.failNext = Number.POSITIVE_INFINITY;
    journal.append(event(1));
    await settle();
    expect(controller.state).toBe('disconnected');
    client.failNext = 0;
    controller.wake();
    await settle();
    expect(client.deliveredIds()).toEqual(['alpha:1']);
  });

  it('treats a delivery that never settles as a transport drop after one heartbeat interval', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    await owner.acquire('session-a');
    const client = new FakeClient();
    const controller = await startedFor(journal, owner, client);

    client.gate = new Promise(() => {}); // a client that swallowed the dispatch and never answers
    journal.append(event(1));
    await settle();
    expect(controller.state).toBe('dispatching');

    // The client recovers, but the swallowed attempt never answers: only the timeout can free the queue.
    client.gate = undefined;
    await vi.advanceTimersByTimeAsync(EVENT_CONTROLLER_HEARTBEAT_MS - 1);
    await settle();
    expect(controller.state).toBe('dispatching');
    expect(client.attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(client.attempts).toBe(2);
    expect(client.deliveredIds()).toEqual(['alpha:1']);
    expect(controller.state).toBe('idle');
  });

  it('marks the transport disconnected on a failed heartbeat and probes again on the next one', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    await owner.acquire('session-a');
    const client = new FakeClient();
    const controller = await startedFor(journal, owner, client);

    client.heartbeatFails = true;
    await vi.advanceTimersByTimeAsync(EVENT_CONTROLLER_HEARTBEAT_MS);
    await settle();
    expect(controller.state).toBe('disconnected');

    // A row that arrives now is not stranded: the next heartbeat delivers it.
    client.heartbeatFails = false;
    journal.append(event(1));
    await settle();
    await vi.advanceTimersByTimeAsync(EVENT_CONTROLLER_HEARTBEAT_MS);
    await settle();
    expect(client.deliveredIds()).toEqual(['alpha:1']);
    expect(controller.state).toBe('idle');
  });

  it('never strands a row appended while a heartbeat probe is in flight', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    await owner.acquire('session-a');
    const client = new FakeClient();
    await startedFor(journal, owner, client);

    let pong!: () => void;
    client.heartbeat = async () => {
      client.heartbeats++;
      await new Promise<void>((resolve) => (pong = resolve));
    };
    await vi.advanceTimersByTimeAsync(EVENT_CONTROLLER_HEARTBEAT_MS);
    journal.append(event(1));
    await settle();
    expect(client.attempts).toBe(0);
    pong();
    await settle();
    expect(client.deliveredIds()).toEqual(['alpha:1']);
  });
});

describe('acceptance 2 — the controller and the bridge are one owner with one lease', () => {
  it('rides the transport session’s lease and never acquires one of its own', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    // The transport acquires on the session's `initialize` — the only acquisition there is.
    const acquired = await owner.acquire('session-a');
    if (acquired.outcome !== 'owner') throw new Error('expected to own the project');
    expect(claimFiles()).toHaveLength(1);

    const acquire = vi.spyOn(owner, 'acquire');
    const release = vi.spyOn(owner, 'release');
    const client = new FakeClient();
    const controller = await startedFor(journal, owner, client);
    appendMany(journal, 3);
    await settle();
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(EVENT_CONTROLLER_HEARTBEAT_MS);
    await settle();

    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(claimFiles()).toHaveLength(1);
    expect(owner.sessionToken('session-a')).toBe(acquired.token);
    expect(client.deliveredIds()).toEqual(['alpha:1', 'alpha:2', 'alpha:3']);

    // A-17: more requests of the same logical owner are not more clients — same token, one claim.
    acquire.mockRestore();
    expect(await owner.acquire('session-a')).toEqual({ outcome: 'owner', token: acquired.token });
    expect(claimFiles()).toHaveLength(1);

    // Closing the controller ends the controller only; the lease is the transport's to release.
    controller.close();
    expect(release).not.toHaveBeenCalled();
    expect(owner.sessionToken('session-a')).toBe(acquired.token);
    expect(claimFiles()).toHaveLength(1);
  });

  it('refuses a second controller for the same project, from the same session or a competing one', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    await owner.acquire('session-a');
    const first = new FakeClient();
    await startedFor(journal, owner, first);

    const sameSession = start(journal, owner, new FakeClient());
    expect(sameSession.outcome).toBe('refused');
    if (sameSession.outcome !== 'refused') return;
    expect(mcpProjectOccupiedErrorSchema.parse(sameSession.error).data.projectId).toBe('alpha');

    // A competing session is refused by ownership itself: it cannot acquire, and cannot start.
    expect((await owner.acquire('session-b')).outcome).toBe('occupied');
    const competing = start(journal, owner, new FakeClient(), { sessionKey: 'session-b' });
    expect(competing.outcome).toBe('refused');
    if (competing.outcome !== 'refused') return;
    expect(mcpProjectOccupiedErrorSchema.safeParse(competing.error).success).toBe(true);
    // N-01: the refusal names nothing about the owner.
    expect(JSON.stringify(competing.error)).not.toContain('session-a');

    // Only the first controller dispatches.
    journal.append(event(1));
    await settle();
    expect(first.deliveredIds()).toEqual(['alpha:1']);
    expect(claimFiles()).toHaveLength(1);
  });

  it('refuses a session that owns nothing with session-expired, and lets another project run its own controller', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    const orphan = start(journal, owner, new FakeClient(), { sessionKey: 'never-acquired' });
    expect(orphan.outcome).toBe('refused');
    if (orphan.outcome === 'refused') expect(mcpSessionExpiredErrorSchema.safeParse(orphan.error).success).toBe(true);
    expect(claimFiles()).toHaveLength(0);

    await owner.acquire('session-a');
    await startedFor(journal, owner, new FakeClient());

    const betaDir = mkdtempSync(join(tmpdir(), 'xez-event-controller-beta-'));
    try {
      const betaJournal = openJournal('beta', betaDir);
      const betaOwner = ownerFor('beta', betaDir);
      await betaOwner.acquire('session-b');
      const betaClient = new FakeClient();
      await startedFor(betaJournal, betaOwner, betaClient, { sessionKey: 'session-b' });
      betaJournal.append(event(1));
      await settle();
      expect(betaClient.deliveredIds()).toEqual(['beta:1']);
    } finally {
      for (const c of controllers.filter((c) => c.projectId === 'beta')) c.close();
      rmSync(betaDir, { recursive: true, force: true });
    }
  });

  it('ends when the session loses the project, and a new owner’s controller then starts', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    await owner.acquire('session-a');
    const client = new FakeClient();
    const controller = await startedFor(journal, owner, client);

    owner.release('session-a'); // the transport saw the connection close
    journal.append(event(1));
    await settle();
    expect(controller.state).toBe('ended');
    expect(client.attempts).toBe(0);

    await owner.acquire('session-b');
    const next = new FakeClient();
    await startedFor(journal, owner, next, { sessionKey: 'session-b' });
    // The row the old session never acknowledged is owed to the new one (F-21, at-least-once).
    await settle();
    expect(next.deliveredIds()).toEqual(['alpha:1']);
  });

  it('ends at the next heartbeat when the lease lapses with nobody calling close', async () => {
    let now = T0;
    const journal = openJournal();
    const owner = new ProjectOwnership({ dataDir, projectId: 'alpha', autoRenew: false, now: () => now });
    owners.push(owner);
    await owner.acquire('session-a');
    const controller = await startedFor(journal, owner, new FakeClient());

    now += 31_000; // a frozen owner: no renewal, lease over
    await vi.advanceTimersByTimeAsync(EVENT_CONTROLLER_HEARTBEAT_MS);
    await settle();
    expect(controller.state).toBe('ended');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('acceptance 3 — with no adapter configured the controller is inert', () => {
  it('lets events accumulate in the journal and nothing fails', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    const subscribe = vi.spyOn(journal, 'subscribe');
    const read = vi.spyOn(journal, 'read');
    const sessionToken = vi.spyOn(owner, 'sessionToken');

    const result = start(journal, owner, undefined);
    expect(result.outcome).toBe('inert');
    if (result.outcome !== 'inert') return;
    const controller = result.controller;

    expect(() => appendMany(journal, 30)).not.toThrow();
    await vi.advanceTimersByTimeAsync(10 * EVENT_CONTROLLER_HEARTBEAT_MS);
    await settle();

    expect(read).not.toHaveBeenCalled();
    const page = journal.read();
    expect(page.status === 'ok' && page.events.map((row) => row.journalSeq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(controller.status()).toMatchObject({ state: 'inert', latestSeq: 30 });
    expect(controller.ack(3).status).toBe('inactive');
    expect(controller.recordReaction(3).status).toBe('inactive');
    expect(() => controller.close()).not.toThrow();

    // Nothing was touched: no subscription, no timer, no ownership read, no claim, no state file.
    expect(subscribe).not.toHaveBeenCalled();
    expect(sessionToken).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(claimFiles()).toHaveLength(0);
    expect(existsSync(join(dataDir, 'mcp', 'event-controller.json'))).toBe(false);

    // And it holds no slot: a real client can still attach.
    await owner.acquire('session-a');
    const client = new FakeClient();
    await startedFor(journal, owner, client);
    journal.append(event(31));
    await settle();
    expect(client.deliveredIds()).toEqual(['alpha:31']);
  });
});

describe('the D-05 § 6.6 cursors', () => {
  it('records delivery and reaction as separate outcomes (F-20)', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    await owner.acquire('session-a');
    const client = new FakeClient();
    client.react = false;
    const controller = await startedFor(journal, owner, client);

    appendMany(journal, 3);
    await settle();
    expect(controller.status()).toMatchObject({ deliveredSeq: 3, reactedSeq: 0 });
    expect(controller.recordReaction(4).status).toBe('ahead');
    expect(controller.recordReaction(2)).toEqual({ status: 'advanced', seq: 2 });
    expect(controller.recordReaction(1)).toEqual({ status: 'unchanged', seq: 2 });
  });

  it('treats an ack as monotonic and idempotent, never a rewind', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    await owner.acquire('session-a');
    const controller = await startedFor(journal, owner, new FakeClient());
    appendMany(journal, 5);
    await settle();

    expect(controller.ack(3)).toEqual({ status: 'advanced', seq: 3 });
    expect(controller.ack(3)).toEqual({ status: 'unchanged', seq: 3 });
    expect(controller.ack(1)).toEqual({ status: 'unchanged', seq: 3 });
    expect(controller.ack(6)).toEqual({ status: 'ahead', seq: 3 });
    expect(() => controller.ack(-1)).toThrow(RangeError);
    expect(controller.status().ackedSeq).toBe(3);
  });

  it('persists the cursors and resumes a new session after the last ack', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    await owner.acquire('session-a');
    const first = await startedFor(journal, owner, new FakeClient());
    appendMany(journal, 5);
    await settle();
    first.ack(3);
    const saved = JSON.parse(readFileSync(join(dataDir, 'mcp', 'event-controller.json'), 'utf8'));
    expect(saved).toMatchObject({ v: 1, projectId: 'alpha', epoch: journal.epoch, deliveredSeq: 5, ackedSeq: 3, reactedSeq: 5 });
    first.close();
    owner.release('session-a');

    await owner.acquire('session-b');
    const client = new FakeClient();
    const second = await startedFor(journal, owner, client, { sessionKey: 'session-b' });
    expect(client.deliveredIds()).toEqual(['alpha:4', 'alpha:5']);
    expect(client.dispatches[0]?.recovery).toBeUndefined();
    expect(second.status()).toMatchObject({ ackedSeq: 3, deliveredSeq: 5 });
  });

  it('starts a project’s first session at the journal head', async () => {
    const journal = openJournal();
    appendMany(journal, 4); // history from before any client existed
    const owner = ownerFor();
    await owner.acquire('session-a');
    const client = new FakeClient();
    await startedFor(journal, owner, client);
    expect(client.attempts).toBe(0);
    journal.append(event(5));
    await settle();
    expect(client.deliveredIds()).toEqual(['alpha:5']);
  });

  it('states the gap when the journal it was following is gone', async () => {
    const journal = openJournal();
    appendMany(journal, 2);
    mkdirSync(join(dataDir, 'mcp'), { recursive: true });
    writeFileSync(
      join(dataDir, 'mcp', 'event-controller.json'),
      JSON.stringify({ v: 1, projectId: 'alpha', epoch: 'a-journal-that-was-deleted', deliveredSeq: 9, ackedSeq: 9, reactedSeq: 9 }),
    );
    const owner = ownerFor();
    await owner.acquire('session-a');
    const client = new FakeClient();
    await startedFor(journal, owner, client);

    expect(client.dispatches).toHaveLength(1);
    expect(client.dispatches[0]?.recovery).toMatchObject({ required: 'current-state', oldestSeq: 1, latestSeq: 2 });
    expect(client.deliveredIds()).toEqual(['alpha:1', 'alpha:2']);
  });

  it('states the gap, and starts at the head, when its own state file is unreadable', async () => {
    const journal = openJournal();
    appendMany(journal, 2);
    mkdirSync(join(dataDir, 'mcp'), { recursive: true });
    writeFileSync(join(dataDir, 'mcp', 'event-controller.json'), '{ not json');
    const owner = ownerFor();
    await owner.acquire('session-a');
    const client = new FakeClient();
    const warnings: string[] = [];
    await startedFor(journal, owner, client, { warn: (m) => warnings.push(m) });

    expect(warnings).toHaveLength(1);
    expect(client.dispatches).toHaveLength(1);
    expect(client.dispatches[0]?.events).toEqual([]);
    expect(client.dispatches[0]?.recovery?.required).toBe('current-state');
  });

  it('logs an internal error once instead of throwing into the cockpit, and recovers at the next heartbeat', async () => {
    const journal = openJournal();
    const owner = ownerFor();
    await owner.acquire('session-a');
    const client = new FakeClient();
    const warnings: string[] = [];
    await startedFor(journal, owner, client, { warn: (m) => warnings.push(m) });

    const read = vi.spyOn(journal, 'read').mockImplementationOnce(() => {
      throw new Error('disk on fire');
    });
    journal.append(event(1));
    await settle();
    expect(warnings).toEqual([expect.stringContaining('internal error')]);
    expect(client.attempts).toBe(0);

    read.mockRestore();
    await vi.advanceTimersByTimeAsync(EVENT_CONTROLLER_HEARTBEAT_MS);
    await settle();
    expect(client.deliveredIds()).toEqual(['alpha:1']);
  });

  it('refuses to pair a journal and an owner slot of two different projects', () => {
    const journal = openJournal();
    const owner = ownerFor('beta');
    expect(() => start(journal, owner, new FakeClient())).toThrow(/different projects/);
  });
});
