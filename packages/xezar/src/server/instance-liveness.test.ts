import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { foreignWriterClaimIsLive } from '../runs/project-writer.ts';
import {
  InstanceLiveness,
  instanceStateOf,
  instanceUrl,
  parseInstanceAddress,
  type HealthProbe,
  type ProbeAnswer,
} from './instance-liveness.ts';

/**
 * The liveness checker behind `instance?` (#467, PR 3, spec § 5).
 *
 * Every case here is about ONE promise: a remembered address is a question, never an answer.
 * `BACKWARD_COMPATIBILITY.md` § 9 says `lastListen` must never be rendered as running without a
 * liveness check, so the three named breaks of the spec are each pinned by a case below:
 * `probe-trusts-lastListen`, `wrong-project-accepted` and `port-zero-reads-as-stopped`.
 */
describe('instance liveness: the five states (#467, PR 3)', () => {
  const address = { host: '127.0.0.1', port: 4322 };
  const named = (bootProject: string): ProbeAnswer => ({ kind: 'named', bootProject });
  const silent: ProbeAnswer = { kind: 'no-answer' };

  describe('the state machine', () => {
    it('running: the address answered and named THIS project', () => {
      expect(
        instanceStateOf({ projectId: 'beta', address, answer: named('beta'), claimLive: false }),
      ).toEqual({ state: 'running', url: 'http://127.0.0.1:4322/p/beta/' });
    });

    it('named break `probe-trusts-lastListen`: a remembered address that answers nothing is stopped', () => {
      // The registry still holds beta's port from its last start. Nothing is listening. A
      // checker that trusted the hint would render a dead project as running.
      expect(
        instanceStateOf({ projectId: 'beta', address, answer: silent, claimLive: false }),
      ).toEqual({ state: 'stopped' });
    });

    it('named break `wrong-project-accepted`: another project on the remembered port is not beta', () => {
      // gamma's cockpit took the port beta used to hold. Health answers, and it answers well —
      // it just names gamma. Without the identity check this row would link a person into the
      // wrong project's cockpit.
      expect(
        instanceStateOf({ projectId: 'beta', address, answer: named('gamma'), claimLive: false }),
      ).toEqual({ state: 'stopped' });
    });

    it('a live claim turns an unanswered address into running-unknown-address, never running', () => {
      expect(
        instanceStateOf({ projectId: 'beta', address, answer: silent, claimLive: true }),
      ).toEqual({ state: 'running-unknown-address' });
    });

    it('named break `port-zero-reads-as-stopped`: a live process with no address is running', () => {
      // `--port 0` never writes `lastListen` (cli-settings.ts, Q-4), so there is nothing to ask
      // and the claim is the only evidence there is. Reading that as "not running" would tell a
      // person a cockpit they are looking at is stopped.
      expect(
        instanceStateOf({ projectId: 'beta', address: null, answer: null, claimLive: true }),
      ).toEqual({ state: 'running-unknown-address' });
    });

    it('no address and no claim is stopped', () => {
      expect(
        instanceStateOf({ projectId: 'beta', address: null, answer: null, claimLive: false }),
      ).toEqual({ state: 'stopped' });
    });

    it('only running carries a url', () => {
      const states = [
        instanceStateOf({ projectId: 'beta', address, answer: silent, claimLive: true }),
        instanceStateOf({ projectId: 'beta', address: null, answer: null, claimLive: false }),
      ];
      for (const state of states) expect(state.url).toBeUndefined();
    });
  });

  describe('the address', () => {
    it('reads the remembered port and host', () => {
      expect(parseInstanceAddress({ port: 4400, host: '127.0.0.1' })).toEqual({
        host: '127.0.0.1',
        port: 4400,
      });
    });

    it('is null for an absent hint and for port 0 — both mean "no address to ask"', () => {
      expect(parseInstanceAddress(undefined)).toBeNull();
      expect(parseInstanceAddress({ port: 0, host: '127.0.0.1' })).toBeNull();
      expect(parseInstanceAddress({ port: 'nonsense', host: '127.0.0.1' })).toBeNull();
    });

    it('falls back to loopback when the hint carries no usable host', () => {
      expect(parseInstanceAddress({ port: 4400 })).toEqual({ host: '127.0.0.1', port: 4400 });
    });

    it('a host that is not a host is an absent one — it reaches neither fetch nor a rendered link', () => {
      // The file is hand-editable, and this value becomes both a URL this server asks and a URL
      // the cockpit renders. Anything carrying a path, userinfo or a query is not a host.
      for (const host of ['example.com/evil#', 'user@example.com', 'example.com?x=1', 'a b']) {
        expect(parseInstanceAddress({ port: 4400, host })).toEqual({ host: '127.0.0.1', port: 4400 });
      }
      expect(parseInstanceAddress({ port: 4400, host: 'my-host.local' })?.host).toBe('my-host.local');
    });

    it('a wildcard bind is never a url a browser follows; an IPv6 literal is bracketed', () => {
      expect(instanceUrl({ host: '0.0.0.0', port: 4322 }, 'beta')).toBe('http://localhost:4322/p/beta/');
      expect(instanceUrl({ host: '::', port: 4322 }, 'beta')).toBe('http://localhost:4322/p/beta/');
      expect(instanceUrl({ host: '::1', port: 4322 }, 'beta')).toBe('http://[::1]:4322/p/beta/');
    });
  });

  describe('the checker', () => {
    const make = (over: {
      probe?: HealthProbe;
      claimLive?: (root: string) => boolean;
      now?: () => number;
    } = {}) =>
      new InstanceLiveness({
        probe: over.probe ?? (async () => silent),
        claimLive: over.claimLive ?? (() => false),
        now: over.now ?? (() => 1_000),
      });

    const beta = { id: 'beta', root: '/tmp/beta', lastListen: { port: 4322, host: '127.0.0.1' } };

    it('the boot project is `this`, and nothing is probed for it', async () => {
      const probe = vi.fn<HealthProbe>(async () => named('beta'));
      const liveness = make({ probe });

      expect(liveness.answer(beta, 'beta')).toEqual({ state: 'this' });
      await liveness.settled();
      expect(probe).not.toHaveBeenCalled();
    });

    it('a first read of an address says `checking`, and the answer follows', async () => {
      const liveness = make({ probe: async () => named('beta') });

      expect(liveness.answer(beta, 'alpha')).toEqual({ state: 'checking' });
      await liveness.settled();
      expect(liveness.answer(beta, 'alpha')).toEqual({
        state: 'running',
        url: 'http://127.0.0.1:4322/p/beta/',
      });
    });

    it('a project with nothing remembered answers at once — no `checking`, no probe', async () => {
      const probe = vi.fn<HealthProbe>(async () => silent);
      const liveness = make({ probe, claimLive: () => true });

      expect(liveness.answer({ id: 'beta', root: '/tmp/beta' }, 'alpha')).toEqual({
        state: 'running-unknown-address',
      });
      await liveness.settled();
      expect(probe).not.toHaveBeenCalled();
    });

    it('caches for the window, and asks again after it', async () => {
      const probe = vi.fn<HealthProbe>(async () => named('beta'));
      let clock = 1_000;
      const liveness = make({ probe, now: () => clock });

      liveness.answer(beta, 'alpha');
      await liveness.settled();
      clock += 9_000;
      liveness.answer(beta, 'alpha');
      await liveness.settled();
      expect(probe).toHaveBeenCalledTimes(1);

      clock += 2_000;
      liveness.answer(beta, 'alpha');
      await liveness.settled();
      expect(probe).toHaveBeenCalledTimes(2);
    });

    it('a stale read keeps the last answer rather than blinking back to `checking`', async () => {
      let clock = 1_000;
      const liveness = make({ probe: async () => named('beta'), now: () => clock });

      liveness.answer(beta, 'alpha');
      await liveness.settled();
      clock += 60_000;
      expect(liveness.answer(beta, 'alpha').state).toBe('running');
    });

    it('a project that moved port is a new question, not the old answer', async () => {
      const liveness = make({ probe: async (a) => (a.port === 4322 ? named('beta') : silent) });

      liveness.answer(beta, 'alpha');
      await liveness.settled();
      expect(liveness.answer(beta, 'alpha').state).toBe('running');

      const moved = { ...beta, lastListen: { port: 4999, host: '127.0.0.1' } };
      expect(liveness.answer(moved, 'alpha')).toEqual({ state: 'checking' });
      await liveness.settled();
      expect(liveness.answer(moved, 'alpha')).toEqual({ state: 'stopped' });
    });

    it('a probe that throws is an answer of no answer — a list render never fails on one', async () => {
      const liveness = make({
        probe: async () => {
          throw new Error('ECONNREFUSED');
        },
      });

      liveness.answer(beta, 'alpha');
      await liveness.settled();
      expect(liveness.answer(beta, 'alpha')).toEqual({ state: 'stopped' });
    });

    it('a claim reader that throws is no live claim, not a failed request', async () => {
      const liveness = make({
        claimLive: () => {
          throw new Error('EACCES');
        },
      });

      expect(liveness.answer({ id: 'beta', root: '/tmp/beta' }, 'alpha')).toEqual({
        state: 'stopped',
      });
    });
  });
});

describe('the writer-claim reader (#467, PR 3)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const dataDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'xez-claim-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'writer-claims'), { recursive: true });
    return dir;
  };

  const claim = (dir: string, pid: number, body: Record<string, unknown>): void => {
    writeFileSync(
      join(dir, 'writer-claims', `${pid}-00000000-0000-0000-0000-000000000000.json`),
      JSON.stringify(body),
    );
  };

  it('a directory that does not exist is no live claim', () => {
    expect(foreignWriterClaimIsLive(join(tmpdir(), 'xez-claim-absent-dir'))).toBe(false);
  });

  it('OUR OWN claim never counts — a workspace cockpit holds one for every project it opened', () => {
    const dir = dataDir();
    claim(dir, process.pid, { pid: process.pid, host: hostname() });

    expect(foreignWriterClaimIsLive(dir)).toBe(false);
  });

  it('another live process on this machine counts', () => {
    const dir = dataDir();
    // PID 1 exists on every unix host and is never this vitest worker.
    claim(dir, 1, { pid: 1, host: hostname() });

    expect(foreignWriterClaimIsLive(dir)).toBe(true);
  });

  it('a dead PID does not count, and neither does a claim from another machine', () => {
    const dead = dataDir();
    claim(dead, 2_147_483_600, { pid: 2_147_483_600, host: hostname() });
    expect(foreignWriterClaimIsLive(dead)).toBe(false);

    const foreign = dataDir();
    // PID 1 is live here, but the claim was written somewhere else: on shared storage a PID
    // number from another host is not evidence about any process on this one.
    claim(foreign, 1, { pid: 1, host: 'some-other-host', machine: 'machine-b' });
    expect(foreignWriterClaimIsLive(foreign)).toBe(false);
  });

  it('an unreadable claim is skipped rather than believed', () => {
    const dir = dataDir();
    writeFileSync(join(dir, 'writer-claims', '1-00000000-0000-0000-0000-000000000000.json'), '{');
    expect(foreignWriterClaimIsLive(dir)).toBe(false);
  });
});
