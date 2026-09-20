import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveStateLayout, setActiveStateLayout } from '../state-layout.ts';
import { isLoopbackHost, isLoopbackHostHeader, normalizeHostname, resolveCapabilities } from './capabilities.ts';

/**
 * `resolveCapabilities` takes its env as a parameter, so these drive it
 * directly rather than mutating `process.env`.
 *
 * The two loopback predicates sit at different trust seams and must not be
 * collapsed into one (#426 / #467 review):
 *   - `isLoopbackHost(bindHost)`   — our own config. Undefined = "we defaulted
 *                                     to the loopback bind" ⇒ trusted.
 *   - `isLoopbackHostHeader(host)` — an attacker-controlled request header.
 *                                     Absent or unparseable ⇒ untrusted.
 * Both share an *anchored* address match: a `127.` string prefix also matches
 * registrable hostnames like `127.0.0.1.evil.com`, which was the DNS-rebinding
 * bypass this pair replaced.
 */

const REAL_LOOPBACK = [
  'localhost',
  'LOCALHOST',
  '127.0.0.1',
  '127.1.2.3',
  '127.255.255.255',
  '::1',
  '[::1]',
  '0:0:0:0:0:0:0:1',
];

// Every one of these is registrable by an attacker and resolvable to 127.0.0.1.
const NOT_LOOPBACK = [
  '127.0.0.1.evil.com',
  '127.evil.com',
  '127.0.0.1.nip.io',
  '1270.0.0.1',
  '127.0.0.1x',
  '127.0.0.256',
  '127.0.0',
  'localhost.evil.com',
  // Malformed authorities: a lax parser normalizes each of these down to a
  // loopback name. They must fail closed instead.
  '[::1]@evil.com',
  '[::1]evil.com',
  '[::1]x',
  '127.0.0.1%2eevil.com',
  'localhost%.evil.com',
  '127.0.0.1:evil.com',
  'evil.com:80:127.0.0.1',
  '0.0.0.0',
  '192.168.1.10',
  'example.com',
  '::2',
  '::1:1',
];

describe('normalizeHostname', () => {
  it.each([
    ['127.0.0.1:4321', '127.0.0.1'],
    // IPv6 is canonicalized to all 8 groups, so every spelling of ::1 — and the
    // compressed form `new URL().hostname` emits — compares equal.
    ['[::1]:4321', '0:0:0:0:0:0:0:1'],
    ['[0:0:0:0:0:0:0:1]:4321', '0:0:0:0:0:0:0:1'],
    ['[0000:0000:0000:0000:0000:0000:0000:0001]', '0:0:0:0:0:0:0:1'],
    ['::1', '0:0:0:0:0:0:0:1'], // bare IPv6 literal: >1 colon, so never `name:port`
    ['LocalHost.:4321', 'localhost'], // lowercased, trailing FQDN dot dropped
    ['fe80::1%eth0', 'fe80:0:0:0:0:0:0:1'], // IPv6 zone id stripped
    ['[::1%25eth0]:4321', '0:0:0:0:0:0:0:1'], // bracketed, zone id + port
  ])('normalizes %s → %s', (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
  });

  it.each([
    '[::1]@evil.com', // trailing junk after the bracket
    '[::1]evil.com',
    '127.0.0.1:evil.com', // port that is not digits
    'evil.com:80:127.0.0.1',
  ])('returns "" for the unparseable authority %s', (input) => {
    expect(normalizeHostname(input)).toBe('');
  });

  it('only strips a % zone id at the end, never mid-hostname', () => {
    // `.replace(/%.*$/, '')` would truncate these to a loopback name.
    expect(normalizeHostname('127.0.0.1%2eevil.com')).toBe('127.0.0.1%2eevil.com');
    expect(normalizeHostname('localhost%.evil.com')).toBe('localhost%.evil.com');
  });
});

describe('isLoopbackHostHeader (untrusted request header)', () => {
  it.each(REAL_LOOPBACK)('accepts the real loopback host %s', (host) => {
    expect(isLoopbackHostHeader(host)).toBe(true);
  });

  it.each(NOT_LOOPBACK)('rejects the non-loopback host %s', (host) => {
    expect(isLoopbackHostHeader(host)).toBe(false);
  });

  it('rejects a missing Host header — absent is untrusted, not "defaulted"', () => {
    expect(isLoopbackHostHeader(undefined)).toBe(false);
    expect(isLoopbackHostHeader('')).toBe(false);
  });

  it('accepts loopback hosts that carry a port or brackets', () => {
    expect(isLoopbackHostHeader('127.0.0.1:4321')).toBe(true);
    expect(isLoopbackHostHeader('[::1]:4321')).toBe(true);
    expect(isLoopbackHostHeader('localhost.:4321')).toBe(true);
  });
});

describe('isLoopbackHost (our own bind host)', () => {
  it('treats the default bind (undefined) as loopback', () => {
    expect(isLoopbackHost(undefined)).toBe(true);
  });

  it.each(REAL_LOOPBACK)('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(NOT_LOOPBACK)('rejects %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('resolveCapabilities — localHandoff', () => {
  it('is on for a default local bind', () => {
    expect(resolveCapabilities({}, undefined).localHandoff).toBe(true);
  });

  it('is on for an explicit loopback bind', () => {
    expect(resolveCapabilities({}, '127.0.0.1').localHandoff).toBe(true);
  });

  it('is off when XEZ_REMOTE=1', () => {
    expect(resolveCapabilities({ XEZ_REMOTE: '1' }, undefined).localHandoff).toBe(false);
  });

  it('is off for a non-loopback bind host', () => {
    expect(resolveCapabilities({}, '0.0.0.0').localHandoff).toBe(false);
  });
});

describe('resolveCapabilities — followups (#471)', () => {
  it('is OFF by default — the global inbox is opt-in', () => {
    expect(resolveCapabilities({}, undefined).followups).toBe(false);
  });

  it('is on with XEZ_FOLLOWUPS=1', () => {
    expect(resolveCapabilities({ XEZ_FOLLOWUPS: '1' }, undefined).followups).toBe(true);
  });

  it.each(['0', 'true', 'yes', '', 'on'])(
    'stays off for XEZ_FOLLOWUPS=%j — only an exact "1" opts in',
    (value) => {
      expect(resolveCapabilities({ XEZ_FOLLOWUPS: value }, undefined).followups).toBe(false);
    },
  );

  it('is independent of the deployment mode', () => {
    expect(resolveCapabilities({ XEZ_FOLLOWUPS: '1', XEZ_REMOTE: '1' }, '0.0.0.0')).toEqual({
      localHandoff: false,
      followups: true,
      singleProject: false,
      automations: false,
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    });
  });
});

describe('resolveCapabilities — singleProject', () => {
  it('is off by default', () => {
    expect(resolveCapabilities({}).singleProject).toBe(false);
  });

  it('is on with XEZ_SINGLE_PROJECT=1', () => {
    expect(resolveCapabilities({ XEZ_SINGLE_PROJECT: '1' }).singleProject).toBe(true);
  });

  it.each(['0', 'true', 'yes', '', 'on'])(
    'stays off for XEZ_SINGLE_PROJECT=%j — only an exact "1" opts in',
    (value) => {
      expect(resolveCapabilities({ XEZ_SINGLE_PROJECT: value }).singleProject).toBe(false);
    },
  );
});

describe('resolveCapabilities — automations (#801)', () => {
  it('is OFF by default — GitHub automations are opt-in', () => {
    expect(resolveCapabilities({}).automations).toBe(false);
  });

  it('is on with XEZ_AUTOMATIONS=1', () => {
    expect(resolveCapabilities({ XEZ_AUTOMATIONS: '1' }).automations).toBe(true);
  });

  it.each(['0', 'true', 'yes', '', 'on'])(
    'stays off for XEZ_AUTOMATIONS=%j — only an exact "1" opts in',
    (value) => {
      expect(resolveCapabilities({ XEZ_AUTOMATIONS: value }).automations).toBe(false);
    },
  );

  // The three opt-in capabilities are independent switches; turning one on must never
  // imply another, or a user enabling automations would silently get the inbox too.
  it('does not turn on any other opt-in capability', () => {
    expect(resolveCapabilities({ XEZ_AUTOMATIONS: '1' })).toMatchObject({
      automations: true,
      followups: false,
      singleProject: false,
    });
  });
});

describe('resolveCapabilities — usage presentation', () => {
  it('shows token usage and cost by default', () => {
    expect(resolveCapabilities({})).toMatchObject({
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    });
  });

  it.each([
    [{ XEZ_HIDE_TOKEN_METRICS: '1' }, false, false, false],
    [{ XEZ_HIDE_TOKEN_USAGE: '1' }, false, false, true],
    [{ XEZ_HIDE_COST: '1' }, false, true, false],
    [{ XEZ_HIDE_TOKEN_USAGE: '1', XEZ_HIDE_COST: '1' }, false, false, false],
    [{ XEZ_HIDE_TOKEN_METRICS: '1', XEZ_HIDE_TOKEN_USAGE: '0', XEZ_HIDE_COST: '0' }, false, false, false],
  ] as const)(
    'resolves strict visibility for %o',
    (env, tokenMetrics, tokenUsageMetrics, costMetrics) => {
      expect(resolveCapabilities(env)).toMatchObject({ tokenMetrics, tokenUsageMetrics, costMetrics });
    },
  );

  it.each(['0', 'true', 'yes', '', 'on'])(
    'stays visible for XEZ_HIDE_TOKEN_METRICS=%j — only an exact "1" opts out',
    (value) => {
      expect(resolveCapabilities({
        XEZ_HIDE_TOKEN_METRICS: value,
        XEZ_HIDE_TOKEN_USAGE: value,
        XEZ_HIDE_COST: value,
      })).toMatchObject({ tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true });
    },
  );

  it('does not change telemetry visibility when another deployment capability is enabled', () => {
    expect(resolveCapabilities({ XEZ_REMOTE: '1', XEZ_FOLLOWUPS: '1' })).toMatchObject({
      tokenMetrics: true,
      tokenUsageMetrics: true,
      costMetrics: true,
    });
  });
});

/**
 * SP-1.3 / risk R4: `XEZ_SINGLE_PROJECT` must not change meaning, and the new
 * mode must not be reachable from the environment.
 *
 * The cross-product is the test, not the two single cases: the regression this
 * closes is one of the two narrowings quietly implying the other, and that is
 * invisible to any test that varies only one of them. `singleProject` is
 * `XEZ_SINGLE_PROJECT=1` (one project, no project management, GLOBAL state);
 * `singleProjectRoot` is the resolved layout (#600), and nothing in the
 * environment can turn it on.
 */
describe('resolveCapabilities — singleProject and singleProjectRoot are independent (#600)', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(realpathSync(tmpdir()), 'xez-cap-layout-'));
  });

  afterEach(() => {
    setActiveStateLayout(null);
    rmSync(project, { recursive: true, force: true });
  });

  const enterMode = (): void => {
    setActiveStateLayout(resolveStateLayout(project, ['--single-project'], {}));
  };

  it('neither: a plain xez', () => {
    expect(resolveCapabilities({})).toMatchObject({ singleProject: false });
    expect(resolveCapabilities({}).singleProjectRoot).toBeUndefined();
  });

  it('env only: today’s exact behaviour, and the state stays global', () => {
    expect(resolveCapabilities({ XEZ_SINGLE_PROJECT: '1' })).toMatchObject({ singleProject: true });
    expect(resolveCapabilities({ XEZ_SINGLE_PROJECT: '1' }).singleProjectRoot).toBeUndefined();
  });

  it('mode only: the state is in the project, and the env narrowing is untouched', () => {
    enterMode();

    expect(resolveCapabilities({})).toMatchObject({ singleProject: false, singleProjectRoot: true });
  });

  it('both: each answers its own question', () => {
    enterMode();

    expect(resolveCapabilities({ XEZ_SINGLE_PROJECT: '1' })).toMatchObject({
      singleProject: true,
      singleProjectRoot: true,
    });
  });

  it('omits the key entirely in the global layout, so the payload is additive on the wire', () => {
    // A `false` would be a new REQUIRED-looking field for every consumer; an
    // absent one is what makes a 0.15.0 and a global-layout 0.16.0 payload the
    // same bytes (SP-1.6).
    expect('singleProjectRoot' in resolveCapabilities({})).toBe(false);
    expect(JSON.stringify(resolveCapabilities({}))).not.toContain('singleProjectRoot');
  });
});

/**
 * `instanceMode` (#467, PR 2) against the two narrowings — the same cross-product discipline the
 * block above follows, and for the same reason: the regression that matters is one narrowing
 * quietly implying another, which no test that varies a single input can see.
 *
 * The load-bearing half is what is NOT sent. `workspace` is the default and every xezar so far
 * has done it, so a `workspace` payload must be the same bytes as one from a server that never
 * heard of this key (AC-2.1) — and a `narrowed` cockpit says what it is through `singleProject`
 * / `singleProjectRoot` already, so a third spelling of the same fact never reaches the wire.
 */
describe('resolveCapabilities — instanceMode is sent only for project (#467)', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(realpathSync(tmpdir()), 'xez-cap-instance-'));
  });

  afterEach(() => {
    setActiveStateLayout(null);
    rmSync(project, { recursive: true, force: true });
  });

  const enterMode = (): void => {
    setActiveStateLayout(resolveStateLayout(project, ['--single-project'], {}));
  };

  it('named break `capability-sent-in-workspace-mode`: workspace omits the key entirely', () => {
    // Not `instanceMode: 'workspace'`: `JSON.stringify` keeps a present key, so sending it
    // unconditionally changes the default payload for every consumer that diffs it.
    expect('instanceMode' in resolveCapabilities({}, undefined, undefined, 'workspace')).toBe(false);
    expect(JSON.stringify(resolveCapabilities({}, undefined, undefined, 'workspace'))).not.toContain(
      'instanceMode',
    );
  });

  it('an absent argument is the same payload as an explicit workspace — legacy callers unchanged', () => {
    expect(JSON.stringify(resolveCapabilities({}))).toBe(
      JSON.stringify(resolveCapabilities({}, undefined, undefined, 'workspace')),
    );
  });

  it('project sends it, and sends the literal `project`', () => {
    expect(resolveCapabilities({}, undefined, undefined, 'project')).toMatchObject({
      instanceMode: 'project',
    });
  });

  it('narrowed omits it — the narrowing already speaks through its own two keys', () => {
    expect(resolveCapabilities({}, undefined, undefined, 'narrowed').instanceMode).toBeUndefined();
  });

  it('project mode does NOT imply either narrowing', () => {
    const caps = resolveCapabilities({}, undefined, undefined, 'project');
    expect(caps.singleProject).toBe(false);
    expect(caps.singleProjectRoot).toBeUndefined();
  });

  it('the env narrowing keeps its exact answer whatever the instance argument says', () => {
    for (const mode of ['workspace', 'project', 'narrowed'] as const) {
      expect(resolveCapabilities({ XEZ_SINGLE_PROJECT: '1' }, undefined, undefined, mode)).toMatchObject({
        singleProject: true,
      });
    }
  });

  it('the project-root layout keeps its own key, and a narrowed process sends no instanceMode', () => {
    enterMode();
    const caps = resolveCapabilities({ XEZ_SINGLE_PROJECT: '1' }, undefined, undefined, 'narrowed');
    expect(caps).toMatchObject({ singleProject: true, singleProjectRoot: true });
    expect(caps.instanceMode).toBeUndefined();
  });
});
