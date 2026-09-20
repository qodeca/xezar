import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { foreignWriterClaimIsLive } from '../runs/project-writer.ts';
import {
  fetchHealth,
  InstanceLiveness,
  instanceOrigin,
  instanceStateOf,
  instanceUrl,
  parseInstanceAddress,
  type HealthProbe,
  type InstanceAddress,
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

    it('named behaviour `non-loopback-host-asked-as-written`: the recorded bind address is the address asked', () => {
      // The probe is NOT loopback-restricted and must not become so (#766, review finding 2): a
      // sibling started with `--bind-host 192.168.1.10` records that host, and refusing it would
      // stop linking a legitimate cockpit. `~/.xezar/config.json` is hand-editable, so a host put
      // there by hand is asked as written too — that is the documented reach, pinned here so a
      // later "tighten it to loopback" has to change this case and say why.
      for (const host of ['192.168.1.10', '10.1.2.3', 'evil.example.com', '169.254.169.254']) {
        expect(parseInstanceAddress({ port: 8080, host })).toEqual({ host, port: 8080 });
        expect(instanceOrigin({ host, port: 8080 })).toBe(`http://${host}:8080`);
      }
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

    it('a project the registry no longer carries keeps no cached answer', async () => {
      // #766, review nit 4. The key carries the address, so an unevicted cache keeps one row per
      // project per port it was ever seen at, for the life of the process.
      const probe = vi.fn<HealthProbe>(async () => named('beta'));
      const liveness = make({ probe });

      liveness.answer(beta, 'alpha');
      await liveness.settled();
      expect(liveness.answer(beta, 'alpha').state).toBe('running');
      expect(probe).toHaveBeenCalledTimes(1);

      // beta is still answered: its row survives.
      liveness.retainOnly(['alpha', 'beta']);
      expect(liveness.answer(beta, 'alpha').state).toBe('running');
      expect(probe).toHaveBeenCalledTimes(1);

      // beta is removed from the registry: the row goes, and the question is new again.
      liveness.retainOnly(['alpha']);
      expect(liveness.answer(beta, 'alpha')).toEqual({ state: 'checking' });
      await liveness.settled();
      expect(probe).toHaveBeenCalledTimes(2);
    });

    it('eviction is by project, so every address a removed project was seen at goes with it', async () => {
      const liveness = make({ probe: async () => named('beta') });
      const moved = { ...beta, lastListen: { port: 4999, host: '127.0.0.1' } };

      liveness.answer(beta, 'alpha');
      liveness.answer(moved, 'alpha');
      await liveness.settled();
      expect(liveness.answer(beta, 'alpha').state).toBe('running');
      expect(liveness.answer(moved, 'alpha').state).toBe('running');

      liveness.retainOnly(['alpha']);
      expect(liveness.answer(beta, 'alpha')).toEqual({ state: 'checking' });
      expect(liveness.answer(moved, 'alpha')).toEqual({ state: 'checking' });
      await liveness.settled();
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

/**
 * The REAL probe, against real listeners (#766, review finding 3).
 *
 * Every other case in this file injects `probe`, so the one function here that touches the network
 * had nothing holding it: its four failure branches and its redirect behaviour could each be
 * reintroduced with a green suite. One `node:http` listener per branch, each answering on loopback
 * on a port the OS picks, and the whole suite stays around a second because the only slow cases are
 * the two bounded by the 300 ms abort.
 */
describe('fetchHealth: the real probe against a real listener (#467, PR 3)', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    // By its saved handle, never by a command-line pattern. `closeAllConnections` matters for the
    // never-answers case, whose socket is still held open when the probe gives up.
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  const listen = async (handler: RequestListener): Promise<InstanceAddress> => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const bound = server.address();
    if (bound === null || typeof bound === 'string') throw new Error('no port');
    return { host: '127.0.0.1', port: bound.port };
  };

  const json = (body: unknown): RequestListener => (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  it('a real cockpit answering health names its project', async () => {
    const address = await listen(json({ bootProject: 'beta', status: 'ok' }));

    await expect(fetchHealth(address)).resolves.toEqual({ kind: 'named', bootProject: 'beta' });
  });

  it('nothing listening on the remembered port is no answer', async () => {
    // Bind, read the port, close it: a port nobody holds, without guessing one.
    const address = await listen(json({ bootProject: 'beta' }));
    const server = servers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    await expect(fetchHealth(address)).resolves.toEqual({ kind: 'no-answer' });
  });

  it('a listener that accepts and never answers is bounded by the 300 ms abort', async () => {
    const address = await listen(() => {
      // deliberately no response: the socket is accepted and then held
    });

    const started = Date.now();
    await expect(fetchHealth(address)).resolves.toEqual({ kind: 'no-answer' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a responder slower than the bound is no answer — the list render does not wait for it', async () => {
    const address = await listen((_req, res) => {
      const slow = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ bootProject: 'beta' }));
      }, 900);
      // The handle is saved and cleared with the response, never left to hold the suite open.
      res.on('close', () => clearTimeout(slow));
    });

    await expect(fetchHealth(address)).resolves.toEqual({ kind: 'no-answer' });
  });

  it('a non-ok status is no answer, whatever the body says', async () => {
    const address = await listen((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ bootProject: 'beta' }));
    });

    await expect(fetchHealth(address)).resolves.toEqual({ kind: 'no-answer' });
  });

  it('a body that is not JSON is no answer — an unrelated web server on the port proves nothing', async () => {
    const address = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>some other service</title>');
    });

    await expect(fetchHealth(address)).resolves.toEqual({ kind: 'no-answer' });
  });

  it('JSON without a string `bootProject` is no answer', async () => {
    for (const body of [{}, { bootProject: 42 }, { bootProject: null }, []]) {
      const address = await listen(json(body));
      await expect(fetchHealth(address)).resolves.toEqual({ kind: 'no-answer' });
    }
  });

  it('named break `BREAK-467-3-REDIRECT-FOLLOWED`: a 3xx is refused, not followed', async () => {
    // The whole point: the second server answers health perfectly, naming beta. With the default
    // `redirect: 'follow'` the probe reads THAT answer and the row renders `running` with a link
    // back to the first address — so the identity check would be satisfied by a server that is not
    // at the address the row points to, and this server's one outbound request would be aimed
    // wherever the remembered port's holder says (#766, review finding 1).
    const elsewhere = await listen(json({ bootProject: 'beta' }));
    const redirector = await listen((_req, res) => {
      res.writeHead(302, { location: `${instanceOrigin(elsewhere)}/api/v1/health` });
      res.end();
    });

    await expect(fetchHealth(redirector)).resolves.toEqual({ kind: 'no-answer' });
    // The control: the redirect target itself answers, so the case fails for the redirect and not
    // because the second listener was unreachable.
    await expect(fetchHealth(elsewhere)).resolves.toEqual({ kind: 'named', bootProject: 'beta' });
  });

  it('the probe carries no credential and no project id — only what it needs to read health', async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    const address = await listen((req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ bootProject: 'beta' }));
    });

    await fetchHealth(address);
    expect(seen.accept).toBe('application/json');
    expect(seen.cookie).toBeUndefined();
    expect(seen.authorization).toBeUndefined();
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
