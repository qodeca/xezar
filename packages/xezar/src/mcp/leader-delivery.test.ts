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

describe('attaching pi (#330 WP2)', () => {
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
