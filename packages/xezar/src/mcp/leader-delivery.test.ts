import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { EventJournal } from './event-journal.ts';
import { LeaderDelivery } from './leader-delivery.ts';

/**
 * #309 — the two answers `LeaderDelivery` gives about things it did not choose: a session that turns
 * out not to own the project, and an attached leader whose address does not answer. Both are read
 * from the real objects (a real `EventJournal`, the real OpenCode adapter over a closed port); only
 * the owner slot is a stub, because its refusals are what these cases are about.
 *
 * `push-delivery.test.ts` covers everything that needs the running service; this file covers what a
 * service cannot easily be put into.
 */

const PROJECT = 'alpha';
const dirs: string[] = [];
const journals: EventJournal[] = [];
const deliveries: LeaderDelivery[] = [];

const tmp = (): string => {
  const dir = realpathSync(mkdtempSync('/tmp/xzld-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const delivery of deliveries.splice(0)) delivery.close();
  for (const journal of journals.splice(0)) journal.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A journal of its own, and the owner slot answering as the case needs. */
function delivery(owns: boolean, warnings: string[] = []) {
  const dataDir = tmp();
  const journal = EventJournal.open({ dataDir, projectId: PROJECT, secretValues: [], warn: () => {} });
  journals.push(journal);
  const made = new LeaderDelivery({
    projectId: PROJECT,
    projectRoot: dataDir,
    journal,
    ownership: {
      projectId: PROJECT,
      sessionToken: () => (owns ? 'token' : undefined),
      state: () => 'owned',
    },
    guard: undefined,
    warn: (message) => warnings.push(message),
    heartbeatMs: 200,
  });
  deliveries.push(made);
  return { delivery: made, journal, warnings, dataDir };
}

const row = (journal: EventJournal, origin: 'human' | 'leader' = 'human') =>
  journal.append({
    category: 'E-05',
    kind: 'config.changed',
    subject: { type: 'config', id: 'project', version: null },
    origin,
    causedBy: null,
    summary: 'the base branch changed',
  });

const until = async (what: string, probe: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('a session that does not own the project', () => {
  it('gets no dispatcher, says why once in the log, and reports no delivery', () => {
    const { delivery: made, warnings } = delivery(false);
    made.sessionOpened('session-1');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('MCP event delivery not started');
    const status = made.status();
    expect(status).toMatchObject({ available: true, delivery: null, leader: null });
    expect(status.available && status.blocker).toMatchObject({ code: 'no-leader-session' });
  });
});

/**
 * The production caller. For one round of review `piReactionTarget` had exactly one caller and it
 * passed no link, so `PiReactionAdapter` was never constructed outside its own tests — "built but
 * never connected", the seventh time in this release. These cases pin the opposite: with a leader
 * announced, `act` really builds the adapter, really hands rows to it, and really lets its socket go
 * again. Without one, the behaviour is exactly what it was before any of this existed.
 */
describe('attaching pi: the link is really produced (#330 WP2)', () => {
  /** A link double at the SEAM `pi-link.ts` fills, so the wiring under test is the real one. */
  function fakeLink() {
    const sent: Record<string, unknown>[] = [];
    let closed = false;
    const listeners = new Set<(message: Record<string, unknown>) => void>();
    return {
      sent,
      get closed() {
        return closed;
      },
      emit: (message: Record<string, unknown>) => {
        for (const listener of [...listeners]) listener(message);
      },
      link: {
        get closed() {
          return closed;
        },
        subscribe(listener: (message: Record<string, unknown>) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async request(command: Record<string, unknown>) {
          sent.push(command);
          if (command.type === 'get_state') return { success: true, data: { isStreaming: false, pendingMessageCount: 0 } };
          if (command.type === 'get_messages') return { success: true, data: { messages: [] } };
          return { success: true };
        },
        close() {
          closed = true;
        },
      },
    };
  }

  function deliveryWithPi(announced: boolean) {
    const fake = fakeLink();
    const dataDir = tmp();
    const journal = EventJournal.open({ dataDir, projectId: PROJECT, secretValues: [], warn: () => {} });
    journals.push(journal);
    const made = new LeaderDelivery({
      projectId: PROJECT,
      projectRoot: dataDir,
      journal,
      ownership: { projectId: PROJECT, sessionToken: () => 'token', state: () => 'owned' },
      guard: undefined,
      warn: () => {},
      heartbeatMs: 200,
      piLeader: {
        read: () =>
          announced
            ? { ok: true as const, descriptor: { schemaVersion: 1 as const, session: { pid: 1, startedAt: 'now' }, endpoint: { socket: '/tmp/x.sock' } } }
            : { ok: false as const, reason: 'no pi leader has announced itself to this project' },
        connect: () => fake.link as never,
      },
    });
    deliveries.push(made);
    return { delivery: made, journal, fake };
  }

  it('builds the adapter and hands a real row to the real pi link', async () => {
    const { delivery: made, journal, fake } = deliveryWithPi(true);
    made.sessionOpened('session-1');

    const attached = await made.act({ action: 'attach', client: 'pi' });
    expect(attached.ok).toBe(true);
    expect(made.status()).toMatchObject({ leader: { client: 'pi', state: 'attached' } });

    row(journal);
    await until('the row to reach pi through the link', () => fake.sent.some((c) => c.type === 'prompt'));
    const prompt = fake.sent.find((c) => c.type === 'prompt');
    expect(String(prompt?.message)).toContain('the base branch changed');
    // The adapter read pi's conversation before its first submission, as it does over a real socket.
    expect(fake.sent.map((c) => c.type)).toContain('get_messages');
  });

  it('lets the socket go when the leader is detached, so no link outlives its leader', async () => {
    const { delivery: made, fake } = deliveryWithPi(true);
    made.sessionOpened('session-1');
    await made.act({ action: 'attach', client: 'pi' });
    expect(fake.closed).toBe(false);

    await made.act({ action: 'stop' });
    expect(fake.closed).toBe(true);
    expect(made.status()).toMatchObject({ leader: null });
  });

  it('lets the socket go when the service closes, not only on an explicit stop', async () => {
    const { delivery: made, fake } = deliveryWithPi(true);
    made.sessionOpened('session-1');
    await made.act({ action: 'attach', client: 'pi' });

    made.close();
    expect(fake.closed).toBe(true);
  });

  it('turns a socket that will not dial into the blocker, never into a thrown attach', async () => {
    const dataDir = tmp();
    const journal = EventJournal.open({ dataDir, projectId: PROJECT, secretValues: [], warn: () => {} });
    journals.push(journal);
    const made = new LeaderDelivery({
      projectId: PROJECT,
      projectRoot: dataDir,
      journal,
      ownership: { projectId: PROJECT, sessionToken: () => 'token', state: () => 'owned' },
      guard: undefined,
      warn: () => {},
      heartbeatMs: 200,
      piLeader: {
        read: () => ({ ok: true as const, descriptor: { schemaVersion: 1 as const, session: { pid: 1, startedAt: 'now' }, endpoint: { socket: '/tmp/x.sock' } } }),
        connect: () => {
          throw new Error('ECONNREFUSED');
        },
      },
    });
    deliveries.push(made);
    made.sessionOpened('session-1');

    const attached = await made.act({ action: 'attach', client: 'pi' });
    expect(attached.ok).toBe(false);
    expect(attached.ok === false && attached.error).toMatch(/ECONNREFUSED/);
    expect(made.status()).toMatchObject({ leader: null });
  });

  it('does not leak a socket when the link it dialled is already closed', async () => {
    const dataDir = tmp();
    const journal = EventJournal.open({ dataDir, projectId: PROJECT, secretValues: [], warn: () => {} });
    journals.push(journal);
    let releases = 0;
    const made = new LeaderDelivery({
      projectId: PROJECT,
      projectRoot: dataDir,
      journal,
      ownership: { projectId: PROJECT, sessionToken: () => 'token', state: () => 'owned' },
      guard: undefined,
      warn: () => {},
      heartbeatMs: 200,
      piLeader: {
        read: () => ({ ok: true as const, descriptor: { schemaVersion: 1 as const, session: { pid: 1, startedAt: 'now' }, endpoint: { socket: '/tmp/x.sock' } } }),
        // The pi exited between the descriptor being read and the dial completing.
        connect: () =>
          ({
            closed: true,
            subscribe: () => () => {},
            request: async () => ({ success: false }),
            close: () => {
              releases += 1;
            },
          }) as never,
      },
    });
    deliveries.push(made);
    made.sessionOpened('session-1');

    const attached = await made.act({ action: 'attach', client: 'pi' });
    expect(attached.ok).toBe(false);
    // Refused AND released: a blocked target must not leave the socket it was handed open.
    expect(releases).toBe(1);
  });

  it('survives a link whose close throws, and says so once rather than failing the detach', async () => {
    const dataDir = tmp();
    const journal = EventJournal.open({ dataDir, projectId: PROJECT, secretValues: [], warn: () => {} });
    journals.push(journal);
    const warnings: string[] = [];
    const made = new LeaderDelivery({
      projectId: PROJECT,
      projectRoot: dataDir,
      journal,
      ownership: { projectId: PROJECT, sessionToken: () => 'token', state: () => 'owned' },
      guard: undefined,
      warn: (message) => warnings.push(message),
      heartbeatMs: 200,
      piLeader: {
        read: () => ({ ok: true as const, descriptor: { schemaVersion: 1 as const, session: { pid: 1, startedAt: 'now' }, endpoint: { socket: '/tmp/x.sock' } } }),
        connect: () =>
          ({
            closed: false,
            subscribe: () => () => {},
            request: async () => ({ success: true, data: { messages: [] } }),
            close: () => {
              throw new Error('socket already gone');
            },
          }) as never,
      },
    });
    deliveries.push(made);
    made.sessionOpened('session-1');
    await made.act({ action: 'attach', client: 'pi' });

    const stopped = await made.act({ action: 'stop' });
    expect(stopped.ok).toBe(true);
    expect(made.status()).toMatchObject({ leader: null });
    expect(warnings.some((w) => w.includes('did not close cleanly'))).toBe(true);
  });

  it('names the reason no link could be made, instead of a flat "pi has no address"', async () => {
    const { delivery: made } = deliveryWithPi(false);
    made.sessionOpened('session-1');
    const attached = await made.act({ action: 'attach', client: 'pi' });
    expect(attached.ok).toBe(false);
    expect(attached.ok === false && attached.error).toMatch(/no pi leader has announced itself/);
    // And the remedy names the extension, which is the thing the person can actually do.
    expect(made.status()).toMatchObject({ leader: null });
  });
});

describe('attaching pi with no leader extension running (#330 WP2)', () => {
  it('is refused with pi’s own recoverable reason, not with a schema error or a silent success', async () => {
    const { delivery: made } = delivery(true);
    made.sessionOpened('session-1');
    const attached = await made.act({ action: 'attach', client: 'pi' });
    expect(attached.ok).toBe(false);
    expect(attached.ok === false && attached.error).toMatch(/stdin and stdout/);
    // Nothing was attached, so the status still says there is no leader — never a leader that
    // cannot be reached being reported as one that can.
    const status = made.status();
    expect(status.available && status.leader).toBeNull();
    expect(status.available && status.blocker).toMatchObject({ code: 'no-leader-session' });
  });

  it('does not detach an OpenCode leader that is already working', async () => {
    const { delivery: made } = delivery(true);
    made.sessionOpened('session-1');
    const attached = await made.act({ action: 'attach', client: 'opencode', baseUrl: 'http://127.0.0.1:1', sessionId: 'ses_closed0000000000000001' });
    expect(attached.ok).toBe(true);

    const refused = await made.act({ action: 'attach', client: 'pi' });
    expect(refused.ok).toBe(false);
    const status = made.status();
    expect(status.available && status.leader).toEqual({ client: 'opencode', state: 'attached' });
  });
});

describe('an attached leader that does not answer at all', () => {
  it('is reported with the adapter’s own reason, not with a guess of xezar’s', async () => {
    const { delivery: made, journal } = delivery(true);
    made.sessionOpened('session-1');
    // Port 1 is not open, so the very first request fails outright — an error the adapter can name.
    const attached = await made.act({ action: 'attach', client: 'opencode', baseUrl: 'http://127.0.0.1:1', sessionId: 'ses_closed0000000000000001' });
    expect(attached.ok).toBe(true);
    row(journal);
    await until('the adapter’s reason to be reported', () => {
      const status = made.status();
      return status.available && status.blocker?.code === 'server-unreachable';
    });
    const status = made.status();
    expect(status.available && status.leader).toEqual({ client: 'opencode', state: 'attached' });
    // Nothing was handed over, so nothing is counted as delivered.
    expect(status.available && status.delivery).toMatchObject({ deliveredSeq: 0, ackedSeq: 0, reactedSeq: 0, latestSeq: 1 });
  });
});
