import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { mcpLeaderStatusSchema, mcpLeaderTopicSchema } from '@qodeca/xezar-contract';

import { CodexAttachError } from './adapters/codex-link.ts';
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

/**
 * QA on #358, finding 3. Every blocker about an ATTACHED leader used to be written in OpenCode's
 * words, whichever client was really attached, so a pi user who hit one was told to check an
 * `opencode serve` they are not running — the one moment the sentence has a job to do.
 *
 * These cases read the three of them through the real `act` -> `status()` path with a pi leader
 * attached. Their OpenCode halves are in `push-delivery.test.ts`, against the real service and the
 * fake OpenCode server, because that is where those two states are reachable end to end; each of
 * those three cases now also asserts it did NOT regress into pi's words or a generic message.
 *
 * Claude Code and Codex are not here because they cannot be attached at all
 * (`mcpLeaderAttachInputSchema`): their case is `no-leader-session`, pinned below.
 */
describe('a blocker about an attached leader is written in THAT client’s words (QA on #358)', () => {
  /** A link at the `pi-link.ts` seam whose requests can be made to fail, so a leader can stop answering. */
  function failableLink() {
    let failing = false;
    let closed = false;
    return {
      fail: (yes: boolean) => {
        failing = yes;
      },
      link: {
        get closed() {
          return closed;
        },
        subscribe: () => () => {},
        async request(command: Record<string, unknown>) {
          if (failing) throw new Error('the pi leader socket went away');
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

  function withPi() {
    const fake = failableLink();
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
        read: () => ({
          ok: true as const,
          descriptor: { schemaVersion: 1 as const, session: { pid: 1, startedAt: 'now' }, endpoint: { socket: '/tmp/x.sock' } },
        }),
        connect: () => fake.link as never,
      },
    });
    deliveries.push(made);
    return { delivery: made, journal, fake };
  }

  const blockerOf = (made: LeaderDelivery) => {
    const status = made.status();
    if (!status.available) throw new Error('unreachable');
    return status.blocker;
  };

  it('no-owner-session names pi, and never the OpenCode server a pi user is not running', async () => {
    const { delivery: made } = withPi();
    // No `sessionOpened`: a leader is attached and no MCP session owns the project — #331's state.
    expect((await made.act({ action: 'attach', client: 'pi' })).ok).toBe(true);

    const blocker = blockerOf(made);
    expect(blocker).toMatchObject({ code: 'no-owner-session' });
    expect(`${blocker?.message} ${blocker?.fix}`).toContain('pi');
    expect(`${blocker?.message} ${blocker?.fix}`).not.toMatch(/OpenCode|opencode/);
  });

  it('delivery-failing tells a pi user to check pi’s own extension, not `opencode serve`', async () => {
    const { delivery: made, journal, fake } = withPi();
    made.sessionOpened('session-1');
    expect((await made.act({ action: 'attach', client: 'pi' })).ok).toBe(true);

    fake.fail(true);
    row(journal); // something IS waiting, which is what separates this from leader-not-answering
    await until('the failure to be observed', () => blockerOf(made)?.code === 'delivery-failing');

    const blocker = blockerOf(made);
    expect(blocker?.message).toContain('pi leader');
    expect(blocker?.fix).toMatch(/leader extension/);
    expect(`${blocker?.message} ${blocker?.fix}`).not.toMatch(/opencode serve/);
  });

  it('leader-not-answering does the same with nothing waiting', async () => {
    const { delivery: made, fake } = withPi();
    made.sessionOpened('session-1');
    expect((await made.act({ action: 'attach', client: 'pi' })).ok).toBe(true);

    fake.fail(true);
    await until('the liveness failure to be observed', () => blockerOf(made)?.code === 'leader-not-answering');

    const blocker = blockerOf(made);
    expect(blocker?.message).toContain('pi leader');
    expect(blocker?.fix).toMatch(/leader extension/);
    expect(`${blocker?.message} ${blocker?.fix}`).not.toMatch(/opencode serve/);
  });

  /**
   * GUARD TEST: green before this change and after it, on purpose. With NOTHING attached there is no
   * client to name, and this sentence is the one that has to speak to all four — the two that can be
   * attached and the two that can only ever read with `leader_events`. Making the other three
   * client-specific must not narrow it.
   */
  it('with no leader attached, the message still speaks to all four clients', () => {
    const { delivery: made } = delivery(true);
    made.sessionOpened('session-1');
    const blocker = blockerOf(made);
    expect(blocker).toMatchObject({ code: 'no-leader-session' });
    for (const client of ['Claude Code', 'Codex', 'pi']) expect(blocker?.message).toContain(client);
    expect(blocker?.fix).toMatch(/opencode serve/);
  });
});

describe('attaching Claude Code: the channel push travels down the owner session (#374)', () => {
  interface FakeTransport {
    push: (content: string, meta?: Record<string, string>) => Promise<void>;
    clientName?: string;
    leaderPush?: boolean;
  }
  function channelTransport(over: Partial<FakeTransport> = {}) {
    const pushed: { content: string; meta: Record<string, string> }[] = [];
    let rejectWith: string | undefined;
    const transport: FakeTransport = {
      push: async (content, meta) => {
        if (rejectWith !== undefined) throw new Error(rejectWith);
        pushed.push({ content, meta: meta ?? {} });
      },
      clientName: 'claude-code',
      leaderPush: true,
      ...over,
    };
    return { pushed, transport, fail: (why: string | undefined) => (rejectWith = why) };
  }
  const blockerOf = (made: LeaderDelivery) => {
    const status = made.status();
    if (!status.available) throw new Error('unreachable');
    return status.blocker;
  };

  it('diagnoses the genuine pre-PR handshake with neither metadata field', async () => {
    const { delivery: made } = delivery(true);
    made.sessionOpened('old', { push: async () => {} });
    const result = await made.act({ action: 'attach', client: 'claude-code' });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('older xezar MCP bridge') });
  });

  it.each([false, true])('blocks an incompatible rebound owner (attach before owner: %s)', async (beforeOwner) => {
    const { delivery: made, journal } = delivery(true);
    if (!beforeOwner) made.sessionOpened('claude', channelTransport().transport);
    expect((await made.act({ action: 'attach', client: 'claude-code' })).ok).toBe(true);
    if (!beforeOwner) made.sessionClosed('claude');
    const foreign = channelTransport({ clientName: 'codex' });
    made.sessionOpened('codex', foreign.transport);
    expect(blockerOf(made)?.code).toBe('claude-code-not-owner');
    row(journal);
    await new Promise((r) => setTimeout(r, 50));
    expect(foreign.pushed).toHaveLength(0);
    expect(made.status()).toMatchObject({ delivery: { deliveredSeq: 0 } });
    made.sessionClosed('codex');
    const compatible = channelTransport();
    made.sessionOpened('claude-again', compatible.transport);
    await until('compatible reconnect delivery', () => compatible.pushed.length > 0);
    expect(compatible.pushed[0]?.content).toContain('alpha:1');
  });

  it('builds the channel adapter and pushes a real row down the owner transport', async () => {
    // RED against: the claude-code #act branch not attaching, or not pushing through the transport.
    const { delivery: made, journal } = delivery(true);
    const t = channelTransport();
    made.sessionOpened('session-1', t.transport as never);
    expect((await made.act({ action: 'attach', client: 'claude-code' })).ok).toBe(true);
    expect(made.status()).toMatchObject({ leader: { client: 'claude-code', state: 'attached' } });

    row(journal);
    await until('the channel push', () => t.pushed.length > 0);
    expect(t.pushed[0]!.content).toContain('alpha:1');
    expect(t.pushed[0]!.meta).toMatchObject({ source_app: 'xezar', project_id: 'alpha', last_seq: '1' });
    // Reaction is never observed for Claude Code, so reactedSeq stays 0 even after delivery.
    const status = made.status();
    expect(status.available && status.delivery).toMatchObject({ deliveredSeq: 1, reactedSeq: 0 });
  });

  it('refuses attach when the owner session is not a Claude Code session, keeping the previous leader', async () => {
    // RED against: attaching a Claude Code leader over a session that would never register the channel.
    const { delivery: made } = delivery(true);
    made.sessionOpened('session-1', { push: async () => {}, clientName: 'opencode', leaderPush: true } as never);
    const res = await made.act({ action: 'attach', client: 'claude-code' });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain('not a Claude Code session');
    expect(made.status()).toMatchObject({ leader: null });
  });

  it('refuses attach when the owner bridge is too old to push', async () => {
    // RED against: pushing into a bridge that predates leader/push and would choke on the frame.
    const { delivery: made } = delivery(true);
    made.sessionOpened('session-1', { push: async () => {}, clientName: 'claude-code' } as never); // no leaderPush announce
    const res = await made.act({ action: 'attach', client: 'claude-code' });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain('older xezar MCP bridge');
  });

  it('attaches with no owner session yet and reports no-owner-session, in Claude Code’s words', async () => {
    // RED against: refusing an attach just because the MCP session has not opened yet.
    const { delivery: made } = delivery(true);
    expect((await made.act({ action: 'attach', client: 'claude-code' })).ok).toBe(true);
    const blocker = blockerOf(made);
    expect(blocker?.code).toBe('no-owner-session');
    expect(blocker?.message).toContain('Claude Code');
  });

  it('reports the failure in Claude Code’s own words when a push does not get through', async () => {
    // RED against: telling a Claude Code user to check `opencode serve`.
    const { delivery: made, journal } = delivery(true);
    const t = channelTransport();
    made.sessionOpened('session-1', t.transport as never);
    expect((await made.act({ action: 'attach', client: 'claude-code' })).ok).toBe(true);
    t.fail('the bridge did not confirm');
    row(journal);
    await until('the failure to be observed', () => blockerOf(made)?.code === 'delivery-failing');
    const blocker = blockerOf(made);
    expect(blocker?.fix).toMatch(/--dangerously-load-development-channels server:xezar/);
    expect(`${blocker?.message} ${blocker?.fix}`).not.toMatch(/opencode serve/);
  });

  it('reports claude-code-push-unconfirmed once a pushed row sits unacknowledged past a heartbeat', async () => {
    // RED against: the adapter's status() not raising push-unconfirmed on deliveredSeq > ackedSeq.
    const { delivery: made, journal } = delivery(true); // heartbeatMs 200
    made.sessionOpened('session-1', channelTransport().transport as never);
    expect((await made.act({ action: 'attach', client: 'claude-code' })).ok).toBe(true);
    row(journal);
    await until('the unconfirmed blocker', () => blockerOf(made)?.code === 'claude-code-push-unconfirmed');
    expect(blockerOf(made)?.fix).toMatch(/leader_events/);
  });

  it('lets the transport go when its session closes, so nothing is pushed after (#374)', async () => {
    // RED against: keeping a dead owner transport and pushing into a closed connection.
    const { delivery: made } = delivery(true);
    made.sessionOpened('session-1', channelTransport().transport as never);
    expect((await made.act({ action: 'attach', client: 'claude-code' })).ok).toBe(true);
    made.sessionClosed('session-1');
    // The controller ended with its session, so nothing is delivered: the blocker says no owner.
    expect(blockerOf(made)?.code).toBe('no-owner-session');
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

/**
 * #374 — Codex, through `LeaderDelivery` and the real controller. The link double sits at the seam
 * `adapters/codex-link.ts` fills: one loaded thread on the person's shared app-server, with a thread
 * history two links to the same thread share (a re-attach). Every case pins `codexLeader.home` to a
 * path of its own, so nothing here ever looks at a real `~/.codex`.
 */
describe('attaching Codex (#374)', () => {
  function codexThread(threadId = 'thread-owner', history: string[] = []) {
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const listeners = new Set<(message: Record<string, unknown>) => void>();
    const state = { closed: false, loaded: true, flags: [] as string[], loseAnswer: false };
    const emit = (message: Record<string, unknown>): void => {
      for (const listener of [...listeners]) listener(message);
    };
    const link = {
      get closed() {
        return state.closed;
      },
      subscribe(listener: (message: Record<string, unknown>) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (state.closed) throw new Error('the Codex app-server connection is closed');
        sent.push({ method, params });
        if (method === 'thread/loaded/list') return { data: state.loaded ? [threadId] : [] };
        if (method === 'thread/resume') return { thread: { id: threadId, status: state.flags.length > 0 ? { type: 'active', activeFlags: state.flags } : { type: 'idle' } } };
        if (method === 'thread/turns/list') return { data: [{ id: 'turn-0', status: 'completed', items: history.map((clientId) => ({ type: 'userMessage', clientId })) }] };
        if (method === 'turn/start') {
          const clientId = params.clientUserMessageId as string;
          history.push(clientId);
          queueMicrotask(() => emit({ method: 'item/started', params: { threadId, item: { type: 'userMessage', clientId } } }));
          if (state.loseAnswer) {
            // The turn really started; only the answer is lost, with the link.
            state.loseAnswer = false;
            await new Promise((resolve) => setTimeout(resolve, 5));
            state.closed = true;
            throw new Error('the Codex app-server closed xezar’s link');
          }
          return { turn: { id: 'turn-1', status: 'inProgress' } };
        }
        return {};
      },
      close: () => {
        state.closed = true;
      },
    };
    return { link, sent, state, emit, history, turnStarts: () => sent.filter((request) => request.method === 'turn/start') };
  }

  type Connect = NonNullable<NonNullable<ConstructorParameters<typeof LeaderDelivery>[0]['codexLeader']>['connect']>;

  function codexDelivery(opts: { connect?: Connect; home?: string; heartbeatMs?: number } = {}) {
    const dataDir = tmp();
    const journal = EventJournal.open({ dataDir, projectId: PROJECT, secretValues: [], warn: () => {} });
    journals.push(journal);
    const warnings: string[] = [];
    const home = opts.home ?? join(dataDir, 'codex-home-for-this-case');
    const made = new LeaderDelivery({
      projectId: PROJECT,
      projectRoot: dataDir,
      journal,
      ownership: { projectId: PROJECT, sessionToken: () => 'token', state: () => 'owned' },
      guard: undefined,
      warn: (message) => warnings.push(message),
      heartbeatMs: opts.heartbeatMs ?? 60,
      codexLeader: { home: () => home, ...(opts.connect ? { connect: opts.connect } : {}) },
    });
    deliveries.push(made);
    made.sessionOpened('owner');
    made.codexAnnounced('owner', { threadId: 'thread-owner' });
    return { delivery: made, journal, warnings, dataDir, home };
  }

  const settled = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('dials only with the owning session’s announcement and the SERVICE’s Codex home, then delivers into that thread', async () => {
    const thread = codexThread();
    const dialed: unknown[] = [];
    const { delivery: made, journal, dataDir, home } = codexDelivery({
      connect: async (announcement, projectRoot, codexHome) => {
        dialed.push({ announcement, projectRoot, codexHome });
        return { threadId: announcement.threadId, link: thread.link, state: { waiting: false } };
      },
    });
    await expect(made.act({ action: 'attach', client: 'codex' })).resolves.toMatchObject({ ok: true, status: { leader: { client: 'codex', state: 'attached' } } });
    expect(dialed).toEqual([{ announcement: { threadId: 'thread-owner' }, projectRoot: dataDir, codexHome: home }]);
    row(journal);
    await until('the journal row to reach Codex', () => thread.turnStarts().length === 1);
    expect(thread.turnStarts()[0]?.params).toMatchObject({ threadId: 'thread-owner' });
    await until('the reaction to be recorded', () => {
      const status = made.status();
      return status.available && status.delivery?.reactedSeq === 1;
    });
    await made.act({ action: 'stop' });
    expect(thread.state.closed).toBe(true);
  });

  it('a prompt already open at attach holds delivery until app-server says it cleared', async () => {
    const thread = codexThread();
    thread.state.flags = ['waitingOnApproval'];
    const { delivery: made, journal } = codexDelivery({ connect: async () => ({ threadId: 'thread-owner', link: thread.link, state: { waiting: true } }) });
    await made.act({ action: 'attach', client: 'codex' });
    row(journal);
    await settled(400);
    expect(thread.turnStarts()).toHaveLength(0);
    thread.state.flags = [];
    thread.emit({ method: 'thread/status/changed', params: { threadId: 'thread-owner', status: { type: 'idle' } } });
    await until('the held event to go once the prompt cleared', () => thread.turnStarts().length === 1);
    await settled(200);
    expect(thread.turnStarts()).toHaveLength(1);
  });

  it('keeps a working attachment after a failed re-attach, and logs why without the path', async () => {
    const thread = codexThread();
    let fail = false;
    const { delivery: made, journal, warnings, home } = codexDelivery({
      connect: async () => {
        if (fail) throw new Error(`the Codex app-server did not accept xezar’s connection at ${home}/app-server-control`);
        return { threadId: 'thread-owner', link: thread.link, state: { waiting: false } };
      },
    });
    await made.act({ action: 'attach', client: 'codex' });
    fail = true;
    await expect(made.act({ action: 'attach', client: 'codex' })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('cannot reach') });
    const status = made.status();
    expect(status.available && status.leader).toEqual({ client: 'codex', state: 'attached' });
    expect(thread.state.closed).toBe(false);
    expect(warnings.at(-1)).toContain('[xez] Codex leader not attached');
    expect(warnings.at(-1)).toContain('<codex home>');
    expect(warnings.join('\n')).not.toContain(home);
    row(journal);
    await until('the kept attachment to still deliver', () => thread.turnStarts().length === 1);
  });

  it('a lost acceptance is reconciled through the NEW link after a re-attach: the event reaches the model once', async () => {
    const history: string[] = [];
    const first = codexThread('thread-owner', history);
    first.state.loseAnswer = true;
    const second = codexThread('thread-owner', history);
    const links = [first, second];
    const { delivery: made, journal } = codexDelivery({ connect: async () => ({ threadId: 'thread-owner', link: links.shift()!.link, state: { waiting: false } }) });
    await made.act({ action: 'attach', client: 'codex' });
    row(journal);
    await until('the first link to take the turn and drop', () => first.state.closed);
    await until('the Codex blocker to be named', () => {
      const status = made.status();
      return status.available && status.blocker?.code === 'codex-app-server-unreachable';
    });
    await made.act({ action: 'attach', client: 'codex' });
    await until('the new link to reconcile', () => second.sent.some((request) => request.method === 'thread/turns/list'));
    await until('the reconciled event to count as reacted', () => {
      const status = made.status();
      return status.available && status.delivery?.reactedSeq === 1;
    });
    await settled(200);
    expect(second.turnStarts()).toHaveLength(0);
    expect(history.filter((clientId) => clientId.startsWith('xezar-event:'))).toHaveLength(1);
  });

  it('the daemon exits while attached: the journal keeps every row, nothing is marked delivered, and the blocker is Codex’s own', async () => {
    const thread = codexThread();
    const { delivery: made, journal } = codexDelivery({ connect: async () => ({ threadId: 'thread-owner', link: thread.link, state: { waiting: false } }) });
    await made.act({ action: 'attach', client: 'codex' });
    thread.state.closed = true;
    row(journal);
    row(journal);
    await settled(300);
    const status = made.status();
    expect(status.available && status.blocker).toMatchObject({ code: 'codex-app-server-unreachable', fix: expect.stringContaining('leader_events') });
    expect(status.available && status.delivery).toMatchObject({ deliveredSeq: 0, latestSeq: 2 });
    expect(journal.latestSeq).toBe(2);
  });

  it('the TUI exits: once app-server unloads the thread the heartbeat says so, and no turn is started into it', async () => {
    const thread = codexThread();
    const { delivery: made, journal } = codexDelivery({ connect: async () => ({ threadId: 'thread-owner', link: thread.link, state: { waiting: false } }) });
    await made.act({ action: 'attach', client: 'codex' });
    thread.state.loaded = false;
    await until('the heartbeat to find the thread unloaded', () => {
      const status = made.status();
      return status.available && status.blocker?.code === 'codex-thread-not-loaded';
    });
    row(journal);
    await settled(300);
    expect(thread.turnStarts()).toHaveLength(0);
    expect(thread.sent.some((request) => request.method === 'thread/resume')).toBe(false);
    expect(journal.latestSeq).toBe(1);
  });

  it('a missing daemon is refused by the REAL connector, and the log names the reason, not the path', async () => {
    const home = realpathSync(mkdtempSync('/tmp/xzld-codex-'));
    dirs.push(home);
    const { delivery: made, warnings } = codexDelivery({ home });
    await expect(made.act({ action: 'attach', client: 'codex' })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('cannot reach') });
    expect(warnings.at(-1)).toContain('no shared Codex app-server control socket was found in the Codex home (ENOENT)');
    expect(warnings.join('\n')).not.toContain(home);
    const status = made.status();
    expect(status.available && status.leader).toBeNull();
  });

  // Design review NB-1 and the QA FAIL on #403: a refused attach is named in the STATUS, with its own
  // fix, so the cockpit's Attach leader control can say which refusal it was and what to change.
  it('names each refused Codex attach in the status with its own fix, until an attach succeeds', async () => {
    const thread = codexThread();
    let refuse: CodexAttachError | undefined;
    const { delivery: made } = codexDelivery({
      connect: async () => {
        if (refuse) throw refuse;
        return { threadId: 'thread-owner', link: thread.link, state: { waiting: false } };
      },
    });
    for (const [reason, code, fix] of [
      ['home', 'codex-home-mismatch', 'same CODEX_HOME'],
      ['thread', 'codex-thread-not-loaded', 'Open the session in your Codex TUI again'],
      ['app-server', 'codex-app-server-unreachable', 'codex app-server --listen unix://'],
      // Self-review finding 5: a state the app-server reports in a shape xezar does not know is its
      // own refusal, not "not loaded, open it again", which would loop on a newer codex-cli.
      ['state', 'codex-thread-state-unknown', 'codex-cli 0.154.0'],
    ] as const) {
      refuse = new CodexAttachError(reason, `refused: ${reason}`);
      await expect(made.act({ action: 'attach', client: 'codex' })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('cannot reach') });
      const status = made.status();
      expect(status.available && status.blocker, reason).toMatchObject({ code, message: expect.stringContaining('cannot reach'), fix: expect.stringContaining(fix) });
      expect(status.available && status.blocker?.fix).toContain('leader_events');
    }
    refuse = undefined;
    await made.act({ action: 'attach', client: 'codex' });
    const attached = made.status();
    expect(attached.available && attached.blocker).toBeNull();
  });

  // Self-review finding 2: with a leader attached but blocked, the status shows the ADAPTER's blocker,
  // so a refused re-attach must say its own reason in its answer, or the person following one fix
  // meets a different cause and sees nothing new.
  it('a refused re-attach while an attached leader is blocked answers with its own reason and fix', async () => {
    const thread = codexThread();
    let refuse: CodexAttachError | undefined;
    const { delivery: made } = codexDelivery({
      connect: async () => {
        if (refuse) throw refuse;
        return { threadId: 'thread-owner', link: thread.link, state: { waiting: false } };
      },
    });
    await made.act({ action: 'attach', client: 'codex' });
    thread.state.loaded = false;
    await until('the heartbeat to find the thread unloaded', () => {
      const status = made.status();
      return status.available && status.blocker?.code === 'codex-thread-not-loaded';
    });
    refuse = new CodexAttachError('home', 'the Codex app-server did not confirm the Codex home xezar looked in');
    const answer = await made.act({ action: 'attach', client: 'codex' });
    expect(answer).toMatchObject({ ok: false, error: expect.stringMatching(/^xezar cannot reach this running Codex session/) });
    expect(answer.ok === false && answer.error).toContain('same CODEX_HOME');
  });

  // Self-review finding 3: a refusal recorded while NOBODY owned the project matched "nobody owns it"
  // every time again, so a stale "has not called a tool yet" came back for the service's life.
  it('does not remember a refusal made while no session owns the project', async () => {
    const { delivery: made } = delivery(true);
    await made.act({ action: 'attach', client: 'codex' });
    expect(made.status()).toMatchObject({ owner: null, blocker: { code: 'no-leader-session' } });
    made.sessionOpened('owner');
    made.sessionClosed('owner');
    expect(made.status()).toMatchObject({ owner: null, blocker: { code: 'no-leader-session' } });
  });

  it('the REAL connector’s refusals carry their reason: a missing socket gets the app-server fix, an unreadable home the home fix', async () => {
    const home = realpathSync(mkdtempSync('/tmp/xzld-codex-'));
    dirs.push(home);
    const withHome = codexDelivery({ home }).delivery;
    await withHome.act({ action: 'attach', client: 'codex' });
    const missingSocket = withHome.status();
    expect(missingSocket.available && missingSocket.blocker).toMatchObject({ code: 'codex-app-server-unreachable' });
    const noHome = codexDelivery({ home: join(home, 'not-there') }).delivery;
    await noHome.act({ action: 'attach', client: 'codex' });
    const missingHome = noHome.status();
    expect(missingHome.available && missingHome.blocker).toMatchObject({ code: 'codex-home-mismatch' });
  });

  it('reports the owner as identified Codex only once its session announced a thread, and a new owner inherits neither that nor a refusal', async () => {
    const { delivery: made } = delivery(true);
    expect(made.status()).toMatchObject({ owner: null });
    made.sessionOpened('owner');
    expect(made.status()).toMatchObject({ owner: { client: null } });
    await made.act({ action: 'attach', client: 'codex' });
    expect(made.status()).toMatchObject({ blocker: { code: 'codex-session-not-targetable', fix: expect.stringContaining('call one once') } });
    // The tool call that announces the thread answers the not-announced refusal.
    made.codexAnnounced('owner', { threadId: 'thread-owner' });
    expect(made.status()).toMatchObject({ owner: { client: 'codex' }, blocker: { code: 'no-leader-session' } });
    made.sessionClosed('owner');
    expect(made.status()).toMatchObject({ owner: null, blocker: { code: 'no-leader-session' } });
  });

  it('refuses a Codex attach without owner-bound metadata', async () => {
    const { delivery: made } = delivery(true);
    made.sessionOpened('owner');
    await expect(made.act({ action: 'attach', client: 'codex' })).resolves.toMatchObject({ ok: false });
    const status = made.status();
    expect(status.available && status.leader).toBeNull();
  });

  it('refuses hosted-mode Codex attach before invoking the socket connector', async () => {
    let dialed = false;
    const dataDir = tmp();
    const journal = EventJournal.open({ dataDir, projectId: PROJECT, secretValues: [], warn: () => {} });
    journals.push(journal);
    const hosted = new LeaderDelivery({
      projectId: PROJECT, projectRoot: dataDir, journal,
      ownership: { projectId: PROJECT, sessionToken: () => 'token', state: () => 'owned' }, guard: undefined, warn: () => {}, localHandoff: () => false,
      codexLeader: { home: () => join(dataDir, 'codex'), connect: async () => { dialed = true; throw new Error('must not dial'); } },
    });
    deliveries.push(hosted);
    hosted.sessionOpened('owner');
    hosted.codexAnnounced('owner', { threadId: 'thread-owner' });
    await expect(hosted.act({ action: 'attach', client: 'codex' })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('cannot reach') });
    expect(dialed).toBe(false);
  });
});

/**
 * #403 (Codex through the shared app-server) and #404 (Claude Code over Channels) each widened the
 * leader status on their own branch. Merged, both clients must live in the ONE payload the shared
 * cockpit control and the `mcp-leader` topic read: the owner identity each client announces its own
 * way, the attached leader each becomes, and the contract that carries both.
 */
describe('Codex and Claude Code coexist in the leader status payload (#403 merged with #404)', () => {
  it('identifies a Claude Code owner by its bridge’s client name and a Codex owner by its thread, and attaches each as itself', async () => {
    // RED against: `#owner()` knowing only the Codex announcement (a Claude Code owner reads `null`),
    // or the contract's owner enum missing `claude-code` (the status fails to parse), or the Codex
    // attach not replacing the retained Claude Code leader (the last status still names `claude-code`).
    const dataDir = tmp();
    const journal = EventJournal.open({ dataDir, projectId: PROJECT, secretValues: [], warn: () => {} });
    journals.push(journal);
    const dialed: string[] = [];
    const made = new LeaderDelivery({
      projectId: PROJECT,
      projectRoot: dataDir,
      journal,
      ownership: { projectId: PROJECT, sessionToken: () => 'token', state: () => 'owned' },
      guard: undefined,
      warn: () => {},
      heartbeatMs: 60_000,
      codexLeader: {
        home: () => dataDir,
        // A real dial's shape: one loaded, idle thread — the announced one — behind a link xezar closes.
        connect: async (announcement) => {
          dialed.push(announcement.threadId);
          let closed = false;
          return {
            threadId: announcement.threadId,
            state: { waiting: false },
            link: {
              get closed() {
                return closed;
              },
              subscribe: () => () => {},
              async request(method: string): Promise<Record<string, unknown>> {
                if (method === 'thread/loaded/list') return { data: [announcement.threadId] };
                if (method === 'thread/resume') return { thread: { id: announcement.threadId, status: { type: 'idle' } } };
                return {};
              },
              close: () => {
                closed = true;
              },
            },
          };
        },
      },
    });
    deliveries.push(made);
    made.sessionOpened('claude', { push: async () => {}, clientName: 'claude-code', leaderPush: true });
    expect(mcpLeaderStatusSchema.parse(made.status())).toMatchObject({ owner: { client: 'claude-code' }, leader: null });
    await expect(made.act({ action: 'attach', client: 'claude-code' })).resolves.toMatchObject({ ok: true });
    const claude = mcpLeaderStatusSchema.parse(made.status());
    expect(claude).toMatchObject({ owner: { client: 'claude-code' }, leader: { client: 'claude-code', state: 'attached' } });
    // A Codex attach against a Claude Code owner is refused for Codex's own reason (no thread announced),
    // and the Claude Code leader is kept: the two paths do not trample each other.
    await expect(made.act({ action: 'attach', client: 'codex' })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('call one once') });
    expect(made.status()).toMatchObject({ leader: { client: 'claude-code' } });

    // The Claude Code session goes; a Codex session takes the project and announces its thread.
    made.sessionClosed('claude');
    made.sessionOpened('codex', { push: async () => {}, clientName: 'codex-cli', leaderPush: false });
    expect(mcpLeaderStatusSchema.parse(made.status())).toMatchObject({ owner: { client: null } });
    made.codexAnnounced('codex', { threadId: 'thread-codex' });
    // The Claude Code attachment is RETAINED (a compatible Claude reconnect must keep it), so the
    // status now says the owner is Codex, the leader Claude Code, and why nothing is delivered.
    expect(mcpLeaderStatusSchema.parse(made.status())).toMatchObject({ owner: { client: 'codex' }, leader: { client: 'claude-code' }, blocker: { code: 'claude-code-not-owner' } });
    // A Claude Code attach against a Codex owner is refused in Claude Code's words, keeping the leader.
    await expect(made.act({ action: 'attach', client: 'claude-code' })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('not a Claude Code session') });
    expect(made.status()).toMatchObject({ leader: { client: 'claude-code' } });
    // The way out (#404 merge review, major 1): attaching the Codex owner REPLACES the stale
    // attachment through the ordinary action — dialled from the announced thread, nothing fabricated.
    await expect(made.act({ action: 'attach', client: 'codex' })).resolves.toMatchObject({ ok: true, status: { leader: { client: 'codex', state: 'attached' } } });
    expect(dialed).toEqual(['thread-codex']);
    const codex = mcpLeaderStatusSchema.parse(made.status());
    expect(codex).toMatchObject({ owner: { client: 'codex' }, leader: { client: 'codex', state: 'attached' }, blocker: null });

    // Both statuses ride one `mcp-leader` topic frame, project by project — each one as the class answered it.
    const frame = mcpLeaderTopicSchema.parse({ projects: { alpha: claude, beta: codex } });
    expect(Object.values(frame.projects).map((status) => (status.available ? status.leader?.client : null))).toEqual(['claude-code', 'codex']);
  });
});

/**
 * Round-4 review, major 2: the no-leader blocker is where a Codex user lands before attaching, and it
 * used to say a Codex session "has no address xezar can attach to" and offer only an OpenCode
 * remedy. It must tell the pull-only clients from the attachable ones and give Codex's own path.
 */
describe('no leader attached: the blocker says who reads, who can be attached, and how', () => {
  it('tells pull-only clients from attachable ones, and gives the Claude Code and Codex start, discovery and retry remedies', () => {
    const { delivery: made } = delivery(true);
    const status = made.status();
    const blocker = status.available ? status.blocker : null;
    expect(blocker?.code).toBe('no-leader-session');
    expect(blocker?.message).not.toContain('has no address');
    // Pull-only: they read their events.
    expect(blocker?.message).toContain('A pi without xezar’s leader extension reads its events with the leader_events tool');
    // Attachable: Claude Code over its channel, Codex through its shared app-server, and OpenCode.
    expect(blocker?.message).toContain('A Claude Code session started with --dangerously-load-development-channels server:xezar');
    expect(blocker?.message).toContain('a Codex session running on Codex’s shared local app-server');
    expect(blocker?.message).toContain('`opencode serve`');
    expect(blocker?.message).toContain('can be attached');
    // Codex: start, discovery, retry.
    expect(blocker?.fix).toContain('codex app-server --listen unix://');
    expect(blocker?.fix).toContain('call a xezar tool once');
    expect(blocker?.fix).toContain('retry');
    expect(blocker?.fix).toContain('opencode serve');
    // Claude Code: the flag, the tool call, the attach.
    expect(blocker?.fix).toContain('--dangerously-load-development-channels server:xezar');
    // #439: attached is the normal path, the pull the fallback, and the fix names the attach door.
    expect(blocker?.message).toContain('Attached is how a leader normally receives them; reading with leader_events is the fallback.');
    expect(blocker?.fix).toContain('Settings → MCP connection → Attach leader, or POST /api/v1/p/<projectId>/mcp/leader {"action":"attach","client":"claude-code"} against the cockpit (http://127.0.0.1:4321 by default), where <projectId> is project.id from discover_project');
    expect(blocker?.fix).toContain('OpenCode also needs baseUrl and sessionId');
    expect(blocker?.fix).not.toContain('POST /api/v1/mcp/leader');
    expect(blocker?.fix).toContain('no MCP action attaches a leader yet');
  });
});

/**
 * Round 5 on #403, review major 2: the cockpit's `mcp-leader` topic re-derives the status when the
 * delivery path says it may have changed. Every place this class changes what `status()` answers —
 * an owner opening or closing, an announcement, an attach, a stop, a refusal, a delivery attempt, a
 * reaction, the service closing — announces it. A listener that throws never reaches the transport.
 */
describe('announcing status changes to the cockpit topic (round 5 on #403)', () => {
  function counted(onStatusChange: () => void) {
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
      codexLeader: { connect: async () => Promise.reject(new CodexAttachError('thread', 'not loaded')), home: () => dataDir },
      onStatusChange,
    });
    deliveries.push(made);
    return { made, journal };
  }

  it('announces an owner opening and closing, an announcement, a refusal, a stop and the service closing', async () => {
    let changes = 0;
    const { made } = counted(() => {
      changes += 1;
    });
    made.sessionOpened('owner');
    expect(changes).toBe(1);
    made.codexAnnounced('owner', { threadId: 'thread-owner' });
    expect(changes).toBe(2);
    const refused = await made.act({ action: 'attach', client: 'codex' });
    expect(refused.ok).toBe(false);
    expect(changes).toBe(3);
    await made.act({ action: 'stop' });
    expect(changes).toBe(4);
    made.sessionClosed('owner');
    expect(changes).toBe(5);
    made.close();
    expect(changes).toBe(6);
  });

  it('announces each attempt against the attached leader (a delivery or a liveness check), so its cursors and blocker reach the topic', async () => {
    let changes = 0;
    const { made, journal } = counted(() => {
      changes += 1;
    });
    made.sessionOpened('owner');
    // An OpenCode address nothing listens on: the attempt fails, which is itself a status change.
    await made.act({ action: 'attach', client: 'opencode', baseUrl: 'http://127.0.0.1:9', sessionId: 'ses_1' });
    const afterAttach = changes;
    row(journal);
    await until('the failed attempt to be announced', () => changes > afterAttach);
    await until('the blocker it caused', () => {
      const status = made.status();
      return status.available && status.blocker !== null;
    });
  });

  it('a listener that throws never reaches the transport, the controller or the person', async () => {
    const { made } = counted(() => {
      throw new Error('a broken listener');
    });
    expect(() => made.sessionOpened('owner')).not.toThrow();
    await expect(made.act({ action: 'stop' })).resolves.toMatchObject({ ok: true });
    expect(() => made.sessionClosed('owner')).not.toThrow();
    expect(() => made.close()).not.toThrow();
  });
});
