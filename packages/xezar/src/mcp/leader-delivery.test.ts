import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mcpLeaderDoorResultSchema, mcpLeaderSelfStatusSchema, mcpLeaderStatusSchema, mcpLeaderTopicSchema } from '@qodeca/xezar-contract';

import { CodexAttachError } from './adapters/codex-link.ts';
import { EchoGuard } from './echo-guard.ts';
import { EventJournal } from './event-journal.ts';
import { LEADER_EVENTS_TOOL_NAME, LeaderDelivery, type LeaderDeliveryOptions, leaderClientOf } from './leader-delivery.ts';
import { leaderEventsTool } from './tools/leader-events.ts';
import { type FakeOpenCodeSession, fakeOpenCodeSession } from './leader-delivery.testkit.ts';

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

const servers: FakeOpenCodeSession[] = [];

afterEach(async () => {
  for (const delivery of deliveries.splice(0)) delivery.close();
  for (const server of servers.splice(0)) await server.stop();
  for (const journal of journals.splice(0)) journal.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The shared fake `opencode serve` (#651), kept so `afterEach` closes it whatever the case did. */
const fakeOpenCode = async (opts: { directory: string; sessionId?: string }): Promise<FakeOpenCodeSession> => {
  const fake = await fakeOpenCodeSession(opts);
  servers.push(fake);
  return fake;
};

/**
 * A fake `opencode serve` that ACCEPTS the TCP connection and then never answers (#703). Nothing it
 * returns is a valid OpenCode answer — the point is that a request to it hangs until the caller's
 * own bound ends it, which is exactly what a paused `opencode serve` does. Kept in `servers`, so
 * `afterEach` closes it whatever the case did.
 */
const neverAnsweringOpenCode = async (): Promise<FakeOpenCodeSession> => {
  const server = createServer(() => {
    // Deliberately writes no response and no headers: the request stays open until the caller aborts.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const fake: FakeOpenCodeSession = {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sessionId: 'ses_never_answers_000000001',
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  servers.push(fake);
  return fake;
};

/** A journal of its own, and the owner slot answering as the case needs. */
function delivery(owns: boolean, warnings: string[] = [], guard?: Pick<EchoGuard, 'isOwn'>, attachCheckMs?: number, pushNotSeenMs?: number, extra: Partial<LeaderDeliveryOptions> = {}) {
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
    guard,
    warn: (message) => warnings.push(message),
    heartbeatMs: 200,
    ...(attachCheckMs === undefined ? {} : { opencodeAttachCheckMs: attachCheckMs }),
    ...(pushNotSeenMs === undefined ? {} : { pushNotSeenMs }),
    ...extra,
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
    const { delivery: made, dataDir } = delivery(true);
    made.sessionOpened('session-1');
    const oc = await fakeOpenCode({ directory: dataDir });
    const attached = await made.act({ action: 'attach', client: 'opencode', baseUrl: oc.baseUrl, sessionId: oc.sessionId });
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

  it('keeps routine omission metadata until a dispatch survives the real own-echo guard', async () => {
    // RED against: resetting EventController.#omittedRoutineCount after LeaderDelivery settles the
    // echo-only dispatch without pushing it. The task row then arrives with no omission metadata.
    const guard = new EchoGuard({ projectId: PROJECT });
    const { delivery: made, journal } = delivery(true, [], guard);
    const t = channelTransport();
    made.sessionOpened('session-1', t.transport as never);
    expect((await made.act({ action: 'attach', client: 'claude-code' })).ok).toBe(true);

    journal.append({
      category: 'E-03',
      kind: 'gate.passed',
      subject: { type: 'run', id: 'run-gates', version: 'routine-1' },
      origin: 'system',
      causedBy: null,
      summary: 'routine check passed',
      gate: { stepId: 'routine-check', resultScope: 'routine' },
    });
    const operationId = 'review-512-own-operation';
    await guard.issue(operationId, () =>
      journal.append({
        category: 'E-05',
        kind: 'config.changed',
        subject: { type: 'config', id: 'project', version: null },
        origin: 'leader',
        causedBy: operationId,
        summary: 'leader changed the base branch',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.pushed).toHaveLength(0);

    journal.append({
      category: 'E-01',
      kind: 'task.terminal',
      subject: { type: 'run', id: 'run-finished', version: null },
      origin: 'system',
      causedBy: null,
      summary: 'task finished',
    });
    await until('the task push after the own echo', () => t.pushed.length === 1);

    expect(t.pushed[0]?.meta).toMatchObject({ last_seq: '3', omitted_routine_count: '1' });
    expect(t.pushed[0]?.content).toContain('omittedRoutineCount: 1 routine successful check');
    const raw = journal.read();
    expect(raw.status === 'ok' ? raw.events.map((event) => event.journalSeq) : []).toEqual([1, 2, 3]);
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

  /** #886: the owner's calls, as the service reports them — a tool name and its string `action`. */
  const other = { tool: 'task_read' } as const;
  const read = { tool: LEADER_EVENTS_TOOL_NAME, action: 'read' } as const;

  it('names leader_events by the tool’s own name (#886)', () => {
    // RED against: the delivery seam's copy of the name drifting from the tool it stands for, which
    // would count every recovery read as "other activity" again.
    expect(LEADER_EVENTS_TOOL_NAME).toBe(leaderEventsTool.name);
  });

  it('reports claude-code-push-not-seen when the owner keeps calling other tools after an unacknowledged push (#886)', async () => {
    // RED against: not wiring the owner's tool calls into the adapter (`sessionCalled` a no-op, or
    // `ownerActivity` not passed), so an active leader that never saw its pushes stays "unconfirmed".
    const { delivery: made, journal } = delivery(true, [], undefined, undefined, 300); // heartbeat 200, bound 300
    const t = channelTransport();
    made.sessionOpened('session-1', t.transport as never);
    expect((await made.act({ action: 'attach', client: 'claude-code' })).ok).toBe(true);
    row(journal);
    await until('the push', () => t.pushed.length === 1);
    await until('the unconfirmed blocker', () => blockerOf(made)?.code === 'claude-code-push-unconfirmed');
    await new Promise((r) => setTimeout(r, 320));
    // A call from a session that does not own the project says nothing about the leader.
    for (let i = 0; i < 3; i++) made.sessionCalled('someone-else', other);
    expect(blockerOf(made)?.code).toBe('claude-code-push-unconfirmed');
    // One call, or two, is not sustained activity (#890 review, finding 1).
    made.sessionCalled('session-1', other);
    made.sessionCalled('session-1', other);
    expect(blockerOf(made)?.code).toBe('claude-code-push-unconfirmed');
    made.sessionCalled('session-1', other);
    expect(blockerOf(made)?.code).toBe('claude-code-push-not-seen');
    const own = made.sessionStatus('session-1');
    expect(own.available && own.blocker?.code).toBe('claude-code-push-not-seen');
  });

  it('never reports a working polling fallback as not-seen: a read after the bound, a heartbeat, then ack clears (#890 review, finding 1)', async () => {
    // RED against: counting a `leader_events` read, status or ack as unrelated activity (the reviewed
    // head: every known tool call, recorded before it ran), so the documented read-then-ack fallback
    // publishes the strong blocker at the next heartbeat, before its own ack lands.
    let acked = 0;
    const published: Array<string | null> = [];
    let made: LeaderDelivery | undefined;
    const made1 = delivery(true, [], undefined, undefined, 300, {
      leaderRecord: { acknowledged: () => acked, owedAfter: () => ({ seq: acked, sameEpoch: true }) },
      onStatusChange: () => {
        const status = made?.status();
        if (status?.available) published.push(status.blocker?.code ?? null);
      },
    });
    made = made1.delivery;
    const t = channelTransport();
    made.sessionOpened('session-1', t.transport as never);
    expect((await made.act({ action: 'attach', client: 'claude-code' })).ok).toBe(true);
    row(made1.journal);
    await until('the push', () => t.pushed.length === 1);
    await new Promise((r) => setTimeout(r, 320)); // past the not-seen bound
    // The fallback, exactly as documented: status, read, reconcile state with other tools, then ack.
    made.sessionCalled('session-1', { tool: LEADER_EVENTS_TOOL_NAME, action: 'status' });
    made.sessionCalled('session-1', read);
    for (let i = 0; i < 4; i++) made.sessionCalled('session-1', other);
    const before = published.length;
    await until('a delivery heartbeat after the read', () => published.length >= before + 2, 3_000);
    expect(published.slice(before)).not.toContain('claude-code-push-not-seen');
    expect(blockerOf(made)?.code).toBe('claude-code-push-unconfirmed');
    // The ack lands: the adapter prunes the row, and nothing is outstanding.
    acked = 1;
    made.sessionCalled('session-1', { tool: LEADER_EVENTS_TOOL_NAME, action: 'ack' });
    expect(blockerOf(made) ?? null).toBeNull();
    const afterAck = published.length;
    await until('a heartbeat after the ack', () => published.length > afterAck, 3_000);
    expect(published.slice(afterAck).every((code) => code === null)).toBe(true);
    expect(published).not.toContain('claude-code-push-not-seen');
  });

  it('still fires for a leader that read BEFORE the push and then kept working without the new one (#890 review, finding 1)', async () => {
    // RED against: letting any read, however old, suppress the blocker — a read made before the push
    // cannot have seen it.
    const { delivery: made, journal } = delivery(true, [], undefined, undefined, 300);
    const t = channelTransport();
    made.sessionOpened('session-1', t.transport as never);
    expect((await made.act({ action: 'attach', client: 'claude-code' })).ok).toBe(true);
    made.sessionCalled('session-1', read);
    await new Promise((r) => setTimeout(r, 5));
    row(journal);
    await until('the push', () => t.pushed.length === 1);
    await new Promise((r) => setTimeout(r, 320));
    for (let i = 0; i < 3; i++) made.sessionCalled('session-1', other);
    expect(blockerOf(made)?.code).toBe('claude-code-push-not-seen');
  });

  it('forgets the owner’s activity when another session takes the project over (#886)', async () => {
    // RED against: keeping the previous owner's calls when a new owner opens without the old one
    // closing (a lapsed lease), so the new session reads as active and silent before it did anything.
    const { delivery: made, journal } = delivery(true, [], undefined, undefined, 300);
    const t = channelTransport();
    made.sessionOpened('session-1', t.transport as never);
    expect((await made.act({ action: 'attach', client: 'claude-code' })).ok).toBe(true);
    row(journal);
    await until('the push', () => t.pushed.length === 1);
    await new Promise((r) => setTimeout(r, 320));
    for (let i = 0; i < 3; i++) made.sessionCalled('session-1', other);
    expect(blockerOf(made)?.code).toBe('claude-code-push-not-seen');
    made.sessionOpened('session-2', t.transport as never);
    expect(blockerOf(made)?.code).toBe('claude-code-push-unconfirmed');
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

/**
 * #651 — the OpenCode session is checked AT ATTACH, against the address the person gave.
 *
 * The defect: `checkSession()` ran only on the DELIVERY path, and `#blocker()` answers
 * `no-owner-session` before it reads the adapter at all, so a session belonging to another project —
 * or one that does not exist — was accepted as "attached" with no error, and the refusal appeared
 * only once an MCP session owned the project. Observed on 0.16.0 with two cockpits side by side;
 * `docs/guide/13-mcp-leader.md` had always promised the check happens now.
 *
 * Each refusal below fails against the pre-fix module (the red proof is in the PR body). The last
 * case is the GUARD: it passes both ways, and pins the default path — a session that really is this
 * project's still attaches, with no blocker.
 */
describe('attaching OpenCode: the session is checked before the attachment is recorded (#651)', () => {
  it('refuses a session id OpenCode does not know, with session-not-found and nothing attached', async () => {
    const { delivery: made, dataDir } = delivery(true);
    made.sessionOpened('session-1');
    const oc = await fakeOpenCode({ directory: dataDir });
    const attached = await made.act({ action: 'attach', client: 'opencode', baseUrl: oc.baseUrl, sessionId: 'ses_does_not_exist_at_all' });
    // `act` answers the route, which carries strings, not the blocker object (#450). The CODE for
    // this same refusal is pinned on the checker itself, in `adapters/opencode.test.ts`.
    expect(attached.ok).toBe(false);
    expect(attached.ok === false && attached.error).toContain('OpenCode has no session ses_does_not_exist_at_all');
    expect(attached.ok === false && attached.error).toContain('opencode serve');
    // Nothing was recorded, so the status still says there is no leader — never "attached" for a
    // session that cannot receive anything.
    const status = made.status();
    expect(status.available && status.leader).toBeNull();
    expect(status.available && status.blocker).toMatchObject({ code: 'no-leader-session' });
  });

  it('refuses a session whose directory is another project, with wrong-project naming that directory', async () => {
    const { delivery: made } = delivery(true);
    made.sessionOpened('session-1');
    const elsewhere = join(tmp(), 'another-project');
    const oc = await fakeOpenCode({ directory: elsewhere });
    const attached = await made.act({ action: 'attach', client: 'opencode', baseUrl: oc.baseUrl, sessionId: oc.sessionId });
    expect(attached.ok).toBe(false);
    expect(attached.ok === false && attached.error).toContain(elsewhere);
    expect(attached.ok === false && attached.error).toContain('not to this project');
    expect(made.status()).toMatchObject({ leader: null });
  });

  it('refuses an address that does not answer — attaching to what it cannot check is the bug', async () => {
    const { delivery: made } = delivery(true);
    made.sessionOpened('session-1');
    // Port 1 is not open, so the very first request fails outright.
    const attached = await made.act({ action: 'attach', client: 'opencode', baseUrl: 'http://127.0.0.1:1', sessionId: 'ses_closed0000000000000001' });
    expect(attached.ok).toBe(false);
    // The ATTACH-time wording, never the delivery path's (#651 review, Minor 2). The delivery
    // sentence promises "xezar retries on its own", which is false before anything is attached: the
    // person would wait for a retry that never comes.
    expect(attached.ok === false && attached.error).toContain('xezar could not reach the OpenCode server, so nothing was attached.');
    expect(attached.ok === false && attached.error).toContain('Start `opencode serve` in this project, then attach the session again.');
    expect(attached.ok === false && attached.error).not.toContain('retries on its own');
    expect(made.status()).toMatchObject({ leader: null });
  });

  it('keeps a leader that is already working when a second attach is refused', async () => {
    const { delivery: made, dataDir } = delivery(true);
    made.sessionOpened('session-1');
    const good = await fakeOpenCode({ directory: dataDir });
    expect(await made.act({ action: 'attach', client: 'opencode', baseUrl: good.baseUrl, sessionId: good.sessionId })).toMatchObject({ ok: true });
    const refused = await made.act({ action: 'attach', client: 'opencode', baseUrl: good.baseUrl, sessionId: 'ses_not_a_session' });
    expect(refused.ok).toBe(false);
    expect(made.status()).toMatchObject({ leader: { client: 'opencode', state: 'attached' } });
  });

  /**
   * GUARD TEST: green before this change and after it, on purpose. It pins the DEFAULT path — the
   * session a person really opened in this project — which the refusals above must not narrow.
   */
  it('attaches a session opened in this project, with no blocker', async () => {
    const { delivery: made, dataDir } = delivery(true);
    made.sessionOpened('session-1');
    const oc = await fakeOpenCode({ directory: dataDir });
    expect(await made.act({ action: 'attach', client: 'opencode', baseUrl: oc.baseUrl, sessionId: oc.sessionId })).toMatchObject({ ok: true });
    const status = made.status();
    expect(status.available && status.leader).toEqual({ client: 'opencode', state: 'attached' });
    expect(status.available && status.blocker).toBeNull();
  });
});

/**
 * #703 — the attach-time check's bound is INJECTABLE, and a server that accepts a connection and
 * then never answers is refused within it.
 *
 * The bound itself is load-bearing (#651): `POST /api/v1/mcp/leader` awaits this check, so an
 * address that accepts a TCP connection and then says nothing — a paused `opencode serve` is
 * exactly that — would otherwise hang the person's Attach leader click with no answer at all. The
 * shipped default stays 10 s; this case injects a small bound so it can assert the bound instead of
 * sleeping for ten seconds. Without the option the injected value is ignored, the default applies,
 * and this case fails (the red proof is in the PR body).
 */
describe('the OpenCode attach-time check is bounded, and the bound is injectable (#703)', () => {
  it('refuses a server that accepts the connection and never answers, within the injected bound', async () => {
    const { delivery: made } = delivery(true, [], undefined, 150);
    made.sessionOpened('session-1');
    const silent = await neverAnsweringOpenCode();
    // The deterministic proof that the INJECTED bound (150 ms) — never the shipped 10 s default,
    // `OPENCODE_ATTACH_CHECK_MS` — is what ends the attach: `checkOpenCodeAttach` builds the abort
    // signal that bounds the check from exactly the value `LeaderDelivery` was constructed with, so
    // the value that reaches `AbortSignal.timeout` is a direct signal from the system under test.
    // (#846: a wall-clock measurement around the call was flaky — a Node timer can fire a tick
    // before `Date.now()` reads the bound it was given, e.g. 149 instead of 150.)
    // With that `< 5_000` wall-clock guard gone, nothing here re-checks that the bound is actually
    // HONOURED — only that it was CREATED with the right value. If `checkOpenCodeAttach` stopped
    // wiring the injected signal into the fetch and the check hung instead, this case's own
    // assertions would never run; the backstop is vitest's `testTimeout` (15 s, `vitest.config.ts`),
    // which fails the case rather than hanging the suite.
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const attached = await made.act({ action: 'attach', client: 'opencode', baseUrl: silent.baseUrl, sessionId: silent.sessionId });
      expect(timeoutSpy).toHaveBeenCalledWith(150);
      // Refused with the attach-time unreachable wording, and nothing was attached.
      expect(attached.ok).toBe(false);
      expect(attached.ok === false && attached.error).toContain('the server did not answer');
      expect(attached.ok === false && attached.error).toContain('Nothing was attached.');
      expect(made.status()).toMatchObject({ leader: null });
    } finally {
      // Local to this case (preferred over a file-wide `vi.restoreAllMocks()` in `afterEach`,
      // :38): a failing assertion above must not leave the global `AbortSignal.timeout` patched
      // for every later case in this file.
      timeoutSpy.mockRestore();
    }
  });
});

describe('an attached leader that does not answer at all', () => {
  it('is reported with the adapter’s own reason, not with a guess of xezar’s', async () => {
    const { delivery: made, journal, dataDir } = delivery(true);
    made.sessionOpened('session-1');
    // Attached against a server that was answering (#651 refuses one that is not), which then goes
    // away — the shape this case is about: a leader that stops answering AFTER it was attached.
    const oc = await fakeOpenCode({ directory: dataDir });
    const attached = await made.act({ action: 'attach', client: 'opencode', baseUrl: oc.baseUrl, sessionId: oc.sessionId });
    expect(attached.ok).toBe(true);
    await oc.stop();
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
    // #439: attached is the normal path, the pull the fallback. #450 (T-27): the fix names the MCP door
    // the leader uses itself, never an HTTP route.
    expect(blocker?.message).toContain('Attached is how a leader normally receives them; reading with leader_events is the fallback.');
    expect(blocker?.fix).toContain('call leader_events with action attach and a new operationId; xezar takes the client from the session, so you never name it');
    expect(blocker?.fix).toContain('a person attaches the session you run with `opencode serve` in Settings → MCP connection');
    expect(blocker?.fix).not.toMatch(/POST|\/api\/v1|no MCP action attaches/);
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
    return { made, journal, dataDir };
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
    const { made, journal, dataDir } = counted(() => {
      changes += 1;
    });
    made.sessionOpened('owner');
    // Attached against a live server (#651 refuses an address that does not answer), which then goes
    // away: the delivery attempt fails, which is itself a status change.
    const oc = await fakeOpenCode({ directory: dataDir });
    await made.act({ action: 'attach', client: 'opencode', baseUrl: oc.baseUrl, sessionId: oc.sessionId });
    await oc.stop();
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


/**
 * #450 — the MCP door (`leader_events` attach, stop, status) over the same delivery path the route
 * uses, for the calling session only. Every case reads the real `LeaderDelivery`; only the owner slot
 * and the transports are stand-ins, because who owns the project and what a bridge announced are
 * exactly what these rules are about.
 */
describe('the MCP leader door (#450)', () => {
  type Transport = { push: (content: string, meta?: Record<string, string>) => Promise<void>; clientName?: string; leaderPush?: boolean; channelAdvertised?: boolean };
  const claude = (over: Partial<Transport> = {}): Transport & { pushed: string[] } => {
    const pushed: string[] = [];
    return { pushed, push: async (content) => void pushed.push(content), clientName: 'claude-code', leaderPush: true, ...over };
  };
  function door(opts: { localHandoff?: () => boolean; heartbeatMs?: number; connectCodex?: () => void; connectPi?: () => void } = {}) {
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
      heartbeatMs: opts.heartbeatMs ?? 60_000,
      ...(opts.localHandoff ? { localHandoff: opts.localHandoff } : {}),
      codexLeader: {
        home: () => dataDir,
        connect: async (announcement) => {
          opts.connectCodex?.();
          return {
            threadId: announcement.threadId,
            state: { waiting: false },
            link: {
              closed: false,
              subscribe: () => () => {},
              async request(method: string): Promise<Record<string, unknown>> {
                if (method === 'thread/loaded/list') return { data: [announcement.threadId] };
                if (method === 'thread/resume') return { thread: { id: announcement.threadId, status: { type: 'idle' } } };
                return {};
              },
              close: () => {},
            },
          };
        },
      },
      piLeader: {
        read: () => ({ ok: true, descriptor: { version: 1, socket: '/tmp/none.sock', pid: 1, startedAt: 'x' } as never }),
        connect: () => {
          opts.connectPi?.();
          return {
            closed: false,
            subscribe: () => () => {},
            async request(command: Record<string, unknown>) {
              if (command.type === 'get_state') return { success: true, data: { isStreaming: false, pendingMessageCount: 0 } };
              return { success: true, data: { messages: [] } };
            },
            close: () => {},
          } as never;
        },
      },
    });
    deliveries.push(made);
    return { made, journal, dataDir };
  }
  const self = (made: LeaderDelivery, key: string) => {
    const status = mcpLeaderSelfStatusSchema.parse(made.sessionStatus(key));
    if (!status.available) throw new Error('unavailable');
    return status;
  };

  it('T-4: derives the client from the session, exactly, one case per row', () => {
    // RED against: `startsWith` for pi-mcp-xezar, or dropping the Codex announcement branch.
    expect(leaderClientOf({ codexAnnounced: true, clientName: 'claude-code' })).toBe('codex');
    expect(leaderClientOf({ codexAnnounced: false, clientName: 'claude-code' })).toBe('claude-code');
    expect(leaderClientOf({ codexAnnounced: false, clientName: 'codex-mcp-client' })).toBe('codex');
    expect(leaderClientOf({ codexAnnounced: false, clientName: 'pi-mcp-xezar' })).toBe('pi');
    expect(leaderClientOf({ codexAnnounced: false, clientName: 'opencode' })).toBe('opencode');
    for (const name of [undefined, 'pi-mcp-xezar-2', 'claude-code ', 'Claude-Code', 'codex', 'pi']) {
      expect(leaderClientOf({ codexAnnounced: false, clientName: name }), String(name)).toBeNull();
    }
  });

  it('T-5: a Claude Code owner attaches itself; a second attach changes nothing and keeps the unconfirmed-push age', async () => {
    // RED against: re-running the attach for a Claude Code leader, which builds a new adapter and hides
    // the push-unconfirmed blocker behind a fresh age.
    const { made, journal } = door({ heartbeatMs: 150 });
    const t = claude();
    made.sessionOpened('s1', t);
    const first = mcpLeaderDoorResultSchema.parse(await made.attachSession('s1'));
    expect(first).toMatchObject({ ok: true, outcome: 'attached', status: { leader: { client: 'claude-code' }, self: { client: 'claude-code', isOwner: true, attached: true } } });
    row(journal);
    await until('the unconfirmed-push blocker', () => self(made, 's1').blocker?.code === 'claude-code-push-unconfirmed');
    const again = await made.attachSession('s1');
    expect(again).toMatchObject({ ok: true, outcome: 'already-attached' });
    expect(self(made, 's1').blocker?.code).toBe('claude-code-push-unconfirmed');
  });

  it('T-6: a Codex or pi attach from its own session re-runs the attach, so the link is dialled again', async () => {
    // RED against: answering already-attached for every client.
    let codexDials = 0;
    const codex = door({ connectCodex: () => void codexDials++ });
    codex.made.sessionOpened('c1', { push: async () => {}, clientName: 'codex-mcp-client' });
    codex.made.codexAnnounced('c1', { threadId: 'thread-c1' });
    expect(await codex.made.attachSession('c1')).toMatchObject({ ok: true, outcome: 'attached', status: { leader: { client: 'codex' }, self: { attached: true } } });
    expect(await codex.made.attachSession('c1')).toMatchObject({ ok: true, outcome: 'attached' });
    expect(codexDials).toBe(2);

    let piDials = 0;
    const pi = door({ connectPi: () => void piDials++ });
    pi.made.sessionOpened('p1', { push: async () => {}, clientName: 'pi-mcp-xezar' });
    expect(await pi.made.attachSession('p1')).toMatchObject({ ok: true, outcome: 'attached', status: { leader: { client: 'pi' } } });
    expect(await pi.made.attachSession('p1')).toMatchObject({ ok: true, outcome: 'attached' });
    expect(piDials).toBe(2);
  });

  it('T-7: a leader never replaces or detaches a leader of another client', async () => {
    // RED against: removing the other-client check — the model would replace the person's OpenCode leader.
    const { made, dataDir } = door();
    made.sessionOpened('s1', claude());
    const oc = await fakeOpenCode({ directory: dataDir });
    expect((await made.act({ action: 'attach', client: 'opencode', baseUrl: oc.baseUrl, sessionId: oc.sessionId })).ok).toBe(true);
    const attach = mcpLeaderDoorResultSchema.parse(await made.attachSession('s1'));
    expect(attach).toMatchObject({ ok: false, code: 'leader-attached-elsewhere', blocker: null });
    expect(attach.ok === false && attach.message).toBe('An OpenCode leader is already attached to this project, and xezar does not replace it from another session. Nothing was attached.');
    const stop = await made.stopSession('s1');
    expect(stop).toMatchObject({ ok: false, code: 'leader-not-this-session', message: 'The attached leader is an OpenCode session, not this one, so nothing was detached.' });
    expect(made.status()).toMatchObject({ leader: { client: 'opencode', state: 'attached' } });
    expect(self(made, 's1')).toMatchObject({ self: { client: 'claude-code', attached: false } });
  });

  it('T-7: a Codex session does not detach the Codex leader another thread attached', async () => {
    // RED against: comparing only the client for stop.
    const { made } = door();
    made.sessionOpened('c1', { push: async () => {}, clientName: 'codex-mcp-client' });
    made.codexAnnounced('c1', { threadId: 'thread-one' });
    expect(await made.attachSession('c1')).toMatchObject({ ok: true });
    made.sessionClosed('c1');
    made.sessionOpened('c2', { push: async () => {}, clientName: 'codex-mcp-client' });
    made.codexAnnounced('c2', { threadId: 'thread-two' });
    expect(await made.stopSession('c2')).toMatchObject({ ok: false, code: 'leader-not-this-session' });
    expect(made.status()).toMatchObject({ leader: { client: 'codex' } });
  });

  it('T-8: hosted mode refuses attach and stop before any connector, and a stale session is not the owner', async () => {
    // RED against: deleting the hosted check (the Codex connector would be dialled), or flipping the
    // owner comparison.
    let dials = 0;
    const hosted = door({ localHandoff: () => false, connectCodex: () => void dials++ });
    hosted.made.sessionOpened('c1', { push: async () => {}, clientName: 'codex-mcp-client' });
    hosted.made.codexAnnounced('c1', { threadId: 'thread-c1' });
    for (const result of [await hosted.made.attachSession('c1'), await hosted.made.stopSession('c1')]) {
      expect(result).toMatchObject({ ok: false, code: 'hosted-mode', fix: 'Run the leader on the xezar host against a cockpit bound to 127.0.0.1, or read events with leader_events.' });
    }
    expect(dials).toBe(0);
    expect(self(hosted.made, 'c1')).toMatchObject({ canPush: false, pushUnavailable: { code: 'hosted-mode' }, leader: null });

    const { made } = door();
    made.sessionOpened('old', claude());
    made.sessionOpened('new', claude());
    expect(await made.attachSession('old')).toMatchObject({ ok: false, code: 'not-owner' });
    expect(await made.stopSession('old')).toMatchObject({ ok: false, code: 'not-owner' });
    expect(self(made, 'old').self).toEqual({ client: null, isOwner: false, attached: false });
    expect(await made.attachSession('new')).toMatchObject({ ok: true, outcome: 'attached' });
    expect(await made.stopSession('new')).toMatchObject({ ok: true, outcome: 'stopped', status: { leader: null } });
    expect(await made.stopSession('new')).toMatchObject({ ok: true, outcome: 'already-stopped' });
  });

  it('T-8: unknown and OpenCode clients are refused with their own reasons, before anything is attached', async () => {
    const { made } = door();
    made.sessionOpened('u', { push: async () => {}, clientName: 'some-client' });
    expect(await made.attachSession('u')).toMatchObject({ ok: false, code: 'client-unknown' });
    made.sessionOpened('o', { push: async () => {}, clientName: 'opencode' });
    expect(await made.attachSession('o')).toMatchObject({ ok: false, code: 'client-needs-address', fix: expect.stringContaining('Settings → MCP connection') });
    expect(made.status()).toMatchObject({ leader: null });
  });

  it('T-8: a refused Claude Code attach answers attach-refused with the client’s own blocker', async () => {
    const { made } = door();
    made.sessionOpened('s1', claude({ leaderPush: undefined }));
    const refused = mcpLeaderDoorResultSchema.parse(await made.attachSession('s1'));
    expect(refused).toMatchObject({ ok: false, code: 'attach-refused', blocker: { code: 'claude-code-bridge-too-old' } });
    expect(refused.ok === false && refused.fix).toContain('Restart Claude Code so it starts the current xezar bridge');
  });

  it('T-9: push capability answers each reason in order, and the unregistered channel is its own blocker', async () => {
    // RED against: reordering the too-old and channel checks, or deleting the new channel line.
    const open = door();
    const cap = (key: string, t: Partial<Transport> | undefined) => open.made.pushCapability(key, t === undefined ? undefined : { push: async () => {}, ...t });
    expect(cap('k', undefined)).toMatchObject({ canPush: false, pushUnavailable: { code: 'client-unknown' } });
    expect(cap('k', { clientName: 'opencode' })).toMatchObject({ pushUnavailable: { code: 'client-needs-address' } });
    expect(cap('k', { clientName: 'claude-code', channelAdvertised: false })).toMatchObject({ pushUnavailable: { code: 'bridge-too-old' } });
    expect(cap('k', { clientName: 'claude-code', leaderPush: true, channelAdvertised: false })).toMatchObject({
      pushUnavailable: { code: 'channel-not-advertised', message: expect.stringContaining('did not register the channel') },
    });
    expect(cap('k', { clientName: 'claude-code', leaderPush: true })).toEqual({ canPush: true });
    expect(cap('k', { clientName: 'pi-mcp-xezar' })).toEqual({ canPush: true });
    expect(door({ localHandoff: () => false }).made.pushCapability('k', { push: async () => {}, clientName: 'claude-code', leaderPush: true })).toMatchObject({ pushUnavailable: { code: 'hosted-mode' } });
    const unwritable = new LeaderDelivery({ projectId: PROJECT, projectRoot: tmp(), journal: { writable: false } as never, ownership: { projectId: PROJECT, sessionToken: () => 'token', state: () => 'owned' }, guard: undefined, warn: () => {}, localHandoff: () => false });
    expect(unwritable.pushCapability('k', { push: async () => {}, clientName: 'claude-code', leaderPush: true })).toMatchObject({ pushUnavailable: { code: 'delivery-unavailable' } });
    expect(await unwritable.attachSession('k')).toMatchObject({ ok: false, code: 'delivery-unavailable' });

    // The blocker reaches the route's attach and the status too, with its fix.
    const { made } = door();
    made.sessionOpened('s1', claude({ channelAdvertised: false }));
    const http = await made.act({ action: 'attach', client: 'claude-code' });
    expect(http).toMatchObject({ ok: false, error: expect.stringContaining('fix: Reconnect the xezar MCP server in Claude Code') });
    const viaDoor = await made.attachSession('s1');
    expect(viaDoor).toMatchObject({ ok: false, code: 'attach-refused', blocker: { code: 'claude-code-channel-not-advertised' } });
    expect(self(made, 's1')).toMatchObject({ canPush: false, pushUnavailable: { code: 'channel-not-advertised' } });
  });

  it('T-10 (guard, green before #450): the route’s refusal texts are byte-identical', async () => {
    const { made } = door();
    made.sessionOpened('s1', { push: async () => {}, clientName: 'opencode', leaderPush: true });
    expect(await made.act({ action: 'attach', client: 'claude-code' })).toEqual({
      ok: false,
      error: 'The MCP session that owns this project is not a Claude Code session, so there is no Claude Code leader to push events to. Events are kept in the journal. fix: Start Claude Code in this project with --dangerously-load-development-channels server:xezar, let it call a xezar tool once, then attach it again.',
    });
    made.sessionClosed('s1');
    made.sessionOpened('s2', { push: async () => {}, clientName: 'claude-code' });
    expect(await made.act({ action: 'attach', client: 'claude-code' })).toEqual({
      ok: false,
      error: 'This Claude Code session is connected through an older xezar MCP bridge that cannot push events. Events are kept in the journal. fix: Restart Claude Code so it starts the current xezar bridge (npx -y @qodeca/xezar mcp), then attach it again.',
    });
    const plain = delivery(true).delivery;
    plain.sessionOpened('s3');
    expect(await plain.act({ action: 'attach', client: 'pi' })).toEqual({
      ok: false,
      error: 'xezar has no live link to a pi leader for this project (no pi leader has announced itself to this project). pi speaks RPC over its own stdin and stdout only — it has no port, socket or attach mode — so a pi you run yourself can be reached only from inside it, by the xezar leader extension. Events stay in the project journal and nothing is lost.',
    });
    expect(await plain.act({ action: 'attach', client: 'codex' })).toEqual({
      ok: false,
      error: 'xezar cannot reach this running Codex session for project-event delivery. Your events are saved. Use leader_events in Codex to read them; retry connecting when this session is available on Codex’s local app-server. Your Codex session has not called a xezar tool yet, so xezar does not know which session it is. Let it call one once (for example leader_events), then attach it again. Until then, use leader_events in Codex to read saved events.',
    });
    const unwritable = new LeaderDelivery({ projectId: PROJECT, projectRoot: tmp(), journal: { writable: false } as never, ownership: { projectId: PROJECT, sessionToken: () => 'token', state: () => 'owned' }, guard: undefined, warn: () => {} });
    expect(await unwritable.act({ action: 'attach', client: 'pi' })).toEqual({
      ok: false,
      error: 'xezar cannot write this project’s event journal, so no event is recorded and none can be delivered. The cockpit log names the file and the error.',
    });
    plain.close();
    expect(await plain.act({ action: 'stop' })).toEqual({ ok: false, error: 'the MCP service for this project is stopping' });
  });

  it('status answers for the calling session, and only unavailable while the service stops', async () => {
    const { made } = door();
    made.sessionOpened('s1', claude());
    expect(self(made, 's1')).toMatchObject({ canPush: true, pushUnavailable: null, owner: { client: 'claude-code' }, leader: null, blocker: { code: 'no-leader-session' } });
    made.close();
    expect(made.sessionStatus('s1')).toEqual({ available: false, reason: 'the MCP service for this project is stopping' });
    expect(await made.attachSession('s1')).toMatchObject({ ok: false, code: 'delivery-unavailable', status: { available: false } });
  });

  /**
   * #532 G4: an owner-session change (another MCP session taking the project — the ordinary case an
   * OpenCode `xezar` MCP server connects lazily into) must never itself detach or replace the
   * attached leader. OpenCode's leader is attached by a PERSON (`act`, the HTTP door), never derived
   * from a session, so it is the sharpest instance of the rule — nothing about who currently owns the
   * project may touch it, and the client-mismatched owner sessions that pass through in between never
   * become the leader either. Claude Code is the contrast worth proving end to end, not just in
   * status: its leader IS the live owner transport by design, so an owner switch to a new same-client
   * session carries the attachment forward with no reattach call — but only correctly if a row
   * appended after the switch is really pushed down the NEW session's bridge, never the old, closed
   * one that would silently swallow it.
   * Named break: calling `#detach()` from `sessionOpened` (an owner switch made "helpfully" clean up
   * the previous leader) — a Claude Code or OpenCode person's attachment would be silently dropped
   * the moment their coding agent reconnects, with no attach/stop call and no blocker explaining why.
   */
  it('G4: an owner-session switch alone never detaches or replaces the attached leader, OpenCode’s person-attach included', async () => {
    const { made, dataDir } = door();
    made.sessionOpened('s1', claude());
    const oc = await fakeOpenCode({ directory: dataDir, sessionId: 'ses_g4owner00000000000001' });
    expect(await made.act({ action: 'attach', client: 'opencode', baseUrl: oc.baseUrl, sessionId: oc.sessionId })).toMatchObject({ ok: true });
    expect(made.status()).toMatchObject({ leader: { client: 'opencode', state: 'attached' } });

    // The session that owns the project changes twice, with no attach or stop call in between.
    made.sessionOpened('s2', claude());
    expect(made.status()).toMatchObject({ leader: { client: 'opencode', state: 'attached' }, blocker: null });
    made.sessionClosed('s2');
    made.sessionOpened('s3', { push: async () => {}, clientName: 'codex-mcp-client' });
    expect(made.status()).toMatchObject({ leader: { client: 'opencode', state: 'attached' }, blocker: null });
    // Neither of the sessions that merely OWNED the project in passing became the leader.
    expect(self(made, 's3')).toMatchObject({ self: { client: 'codex', isOwner: true, attached: false } });

    // Contrast: Claude Code's push target IS the live owner transport by design (the class comment:
    // "the target is the owner MCP session itself"), so its attachment follows an owner switch to a
    // new same-client session with no reattach call — but delivery must really follow it: the row
    // appended after the switch reaches the NEW session's bridge, never the old, closed one.
    const claudeCase = door({ heartbeatMs: 30 });
    const c1 = claude();
    claudeCase.made.sessionOpened('c1', c1);
    expect(await claudeCase.made.attachSession('c1')).toMatchObject({ ok: true, outcome: 'attached' });
    row(claudeCase.journal);
    await until('c1 to receive the first push', () => c1.pushed.length > 0);

    claudeCase.made.sessionClosed('c1');
    const c2 = claude();
    claudeCase.made.sessionOpened('c2', c2);
    expect(self(claudeCase.made, 'c2').self).toMatchObject({ isOwner: true, attached: true });
    row(claudeCase.journal);
    await until('c2 to receive the second push', () => c2.pushed.length > 0);
    // The old, closed session's bridge never received a row appended after it stopped owning.
    expect(c1.pushed).toHaveLength(1);
  });
});
