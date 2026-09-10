import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { detectEnvironment, readHostGithubToken } from './backend-detect.js';

/**
 * #45 (gap R6) — `detectEnvironment()` is where AGENTS.md's zero-config promise is kept:
 * "A missing dependency, an absent peer, a read-only home: degrade to a smaller working
 * cockpit, never fail the boot." A probe that throws instead of reporting "absent" takes
 * the whole boot down on a host that is simply missing one CLI — and it is invisible on
 * every machine that HAS the tool, which is every maintainer's machine.
 *
 * Nothing here spawns a real agent CLI. `node:child_process.execFile` is mocked (the shape
 * `opencode-server-runner.test.ts` uses for `spawn`) so each probe's binary can answer, be
 * missing, exit non-zero, or hang past its own timeout — the last one on fake timers, so a
 * 10-second probe timeout costs the suite nothing.
 */

type FakeReply =
  | { kind: 'ok'; stdout: string }
  /** The binary exists and runs, but exits non-zero — execFile rejects. */
  | { kind: 'exit'; code: number }
  /** The binary never answers; node kills it at `options.timeout` and rejects. */
  | { kind: 'hang' };

const execHook = vi.hoisted(() => ({
  /** Keyed by the exact binary string the probe passed to execFile. */
  replies: new Map<string, FakeReply>(),
  calls: [] as { file: string; args: string[]; timeout: number | undefined }[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  type Callback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;
  const fakeExecFile = (
    file: string,
    args: string[],
    optionsOrCallback: { timeout?: number } | Callback | undefined,
    maybeCallback?: Callback,
  ): void => {
    // execFile's options argument is optional; a probe that drops it must still be
    // answered here, so the "every probe bounds its wait" assertion is what fails,
    // not the mock.
    const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
    const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback)!;
    execHook.calls.push({ file, args, timeout: options?.timeout });
    // An unregistered binary is simply not installed on this fake host.
    const reply: FakeReply | undefined = execHook.replies.get(file);
    if (reply?.kind === 'hang') {
      // Node's own behaviour: the timeout kills the child and the promise rejects.
      // A probe that passed no timeout would fire immediately here rather than wedge
      // the suite — `every probe bounds its own wait` is asserted separately.
      const ms = typeof options?.timeout === 'number' && options.timeout > 0 ? options.timeout : 0;
      setTimeout(() => {
        callback(Object.assign(new Error(`Command failed: ${file} (timed out)`), { killed: true }));
      }, ms);
      return;
    }
    queueMicrotask(() => {
      if (!reply) {
        callback(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }));
        return;
      }
      if (reply.kind === 'exit') {
        callback(Object.assign(new Error(`Command failed: ${file}`), { code: reply.code }));
        return;
      }
      callback(null, { stdout: reply.stdout, stderr: '' });
    });
  };
  return { ...actual, execFile: fakeExecFile as unknown as typeof actual.execFile };
});

/** The probe binaries, as `detectEnvironment` spells them with no env override set. */
const CLAUDE_BANNER = '2.0.14 (Claude Code)';

function reply(bin: string, r: FakeReply): void {
  execHook.replies.set(bin, r);
}

/** A host where every probe finds its tool and every tool answers. */
function everythingInstalled(): void {
  reply('claude', { kind: 'ok', stdout: `${CLAUDE_BANNER}\n` });
  reply('codex', { kind: 'ok', stdout: 'codex-cli 0.21.0\n' });
  reply('opencode', { kind: 'ok', stdout: '0.4.2\n' });
  reply('pi', { kind: 'ok', stdout: 'pi 1.2.3\n' });
  reply('gh', { kind: 'ok', stdout: 'gho_exampletoken\n' });
  reply('git', { kind: 'ok', stdout: 'git version 2.45.2\n' });
}

async function check(name: string) {
  const checks = await detectEnvironment();
  const found = checks.find((c) => c.name === name);
  expect(found, `no check reported for ${name}`).toBeDefined();
  return found!;
}

beforeEach(() => {
  execHook.replies.clear();
  execHook.calls.length = 0;
  // The dry-run short-circuit would answer for claude and pi before any probe runs.
  vi.stubEnv('XEZ_DRY_RUN', undefined);
  vi.stubEnv('XEZ_CLAUDE_BIN', undefined);
  vi.stubEnv('XEZ_CODEX_BIN', undefined);
  vi.stubEnv('XEZ_OPENCODE_BIN', undefined);
  vi.stubEnv('XEZ_PI_BIN', undefined);
  vi.stubEnv('GITHUB_TOKEN', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('a host where every tool is installed', () => {
  it('reports each agent CLI available with the version string it printed', async () => {
    everythingInstalled();
    const checks = await detectEnvironment();

    expect(checks.map((c) => c.name)).toEqual(['claude', 'codex', 'opencode', 'pi', 'gh', 'git']);
    expect(checks.find((c) => c.name === 'claude')).toMatchObject({
      available: true,
      version: CLAUDE_BANNER,
    });
    expect(checks.find((c) => c.name === 'codex')).toMatchObject({
      available: true,
      version: 'codex-cli 0.21.0',
    });
    expect(checks.find((c) => c.name === 'opencode')).toMatchObject({
      available: true,
      version: '0.4.2',
    });
  });

  it('reports gh authenticated and git with its version', async () => {
    everythingInstalled();

    expect(await check('gh')).toMatchObject({ available: true, version: 'authenticated' });
    expect(await check('git')).toMatchObject({ available: true, version: 'git version 2.45.2' });
  });

  it('asks each agent CLI for its version and bounds every wait with a timeout', async () => {
    everythingInstalled();
    await detectEnvironment();

    for (const bin of ['claude', 'codex', 'opencode', 'pi', 'git']) {
      const call = execHook.calls.find((c) => c.file === bin);
      expect(call, `${bin} was never probed`).toBeDefined();
      expect(call!.args).toEqual(['--version']);
    }
    expect(execHook.calls.find((c) => c.file === 'gh')!.args).toEqual(['auth', 'token']);
    // A probe with no timeout is an unbounded boot hang, not a degraded cockpit.
    for (const call of execHook.calls) {
      expect(call.timeout, `${call.file} probed with no timeout`).toBeGreaterThan(0);
    }
  });

  it('honours the documented XEZ_*_BIN overrides instead of a bare name', async () => {
    vi.stubEnv('XEZ_CLAUDE_BIN', '/opt/tools/claude');
    vi.stubEnv('XEZ_CODEX_BIN', '/opt/tools/codex');
    vi.stubEnv('XEZ_OPENCODE_BIN', '/opt/tools/opencode');
    reply('/opt/tools/claude', { kind: 'ok', stdout: '2.0.14 (Claude Code)\n' });
    reply('/opt/tools/codex', { kind: 'ok', stdout: 'codex-cli 0.21.0\n' });
    reply('/opt/tools/opencode', { kind: 'ok', stdout: '0.4.2\n' });
    // The bare names are NOT installed on this host — only the custom paths are.

    const checks = await detectEnvironment();

    expect(checks.find((c) => c.name === 'claude')!.available).toBe(true);
    expect(checks.find((c) => c.name === 'codex')!.available).toBe(true);
    expect(checks.find((c) => c.name === 'opencode')!.available).toBe(true);
    expect(execHook.calls.map((c) => c.file)).toContain('/opt/tools/claude');
    expect(execHook.calls.map((c) => c.file)).not.toContain('claude');
  });
});

describe('a missing binary degrades to unavailable with a reason', () => {
  it.each([
    ['claude', 'Claude Code'],
    ['codex', 'Codex'],
    ['opencode', 'OpenCode'],
    ['gh', 'GitHub CLI'],
    ['git', 'install git'],
  ])('reports %s unavailable with a hint, and never rejects', async (name, hintFragment) => {
    everythingInstalled();
    execHook.replies.delete(name);

    const result = await check(name);
    expect(result.available).toBe(false);
    expect(result.version).toBeUndefined();
    expect(result.hint).toContain(hintFragment);
  });
});

describe('a binary that exists but does not answer cleanly', () => {
  it.each(['claude', 'codex', 'opencode', 'gh', 'git'])(
    'degrades %s to unavailable when it exits non-zero',
    async (name) => {
      everythingInstalled();
      reply(name, { kind: 'exit', code: 1 });

      const result = await check(name);
      expect(result.available).toBe(false);
      expect(result.hint).toBeTruthy();
    },
  );

  it('degrades every probe to unavailable when the binary hangs past the probe timeout', async () => {
    vi.useFakeTimers();
    for (const bin of ['claude', 'codex', 'opencode', 'pi', 'gh', 'git']) {
      reply(bin, { kind: 'hang' });
    }

    const pending = detectEnvironment();
    // Nothing has answered yet; only the probes' own timeouts can end this.
    await vi.advanceTimersByTimeAsync(60_000);
    const checks = await pending;

    expect(checks).toHaveLength(6);
    for (const c of checks) {
      expect(c.available, `${c.name} should be unavailable after a hang`).toBe(false);
      expect(c.hint, `${c.name} should explain itself`).toBeTruthy();
    }
  });

  it('rejects a `claude` on PATH that is not Claude Code', async () => {
    everythingInstalled();
    reply('claude', { kind: 'ok', stdout: 'GNU bash, version 5.2.37\n' });

    const result = await check('claude');
    expect(result.available).toBe(false);
    expect(result.hint).toContain("doesn't look like Claude Code");
  });

  it('reports gh unavailable when `gh auth token` prints nothing', async () => {
    everythingInstalled();
    reply('gh', { kind: 'ok', stdout: '   \n' });

    // Current behaviour: not available, and (unlike every other negative branch)
    // no hint is attached. Pinned as-is — see the PR body.
    const result = await check('gh');
    expect(result.available).toBe(false);
    expect(result.hint).toBeUndefined();
  });
});

describe('a host with nothing installed at all', () => {
  it('still returns a complete result rather than rejecting the boot', async () => {
    // No replies registered: every single probe fails.
    const checks = await detectEnvironment();

    expect(checks).toHaveLength(6);
    expect(checks.map((c) => c.name)).toEqual(['claude', 'codex', 'opencode', 'pi', 'gh', 'git']);
    for (const c of checks) {
      expect(c.available, `${c.name} should be unavailable`).toBe(false);
      expect(c.hint, `${c.name} should carry a hint`).toBeTruthy();
    }
  });
});

describe('the XEZ_DRY_RUN short-circuit', () => {
  it('reports the mocked claude and pi runners without probing any binary', async () => {
    vi.stubEnv('XEZ_DRY_RUN', '1');

    const checks = await detectEnvironment();

    expect(checks.find((c) => c.name === 'claude')).toMatchObject({
      available: true,
      version: 'mock (XEZ_DRY_RUN=1)',
    });
    expect(checks.find((c) => c.name === 'pi')).toMatchObject({
      available: true,
      version: 'mock (XEZ_DRY_RUN=1)',
    });
    expect(execHook.calls.map((c) => c.file)).not.toContain('claude');
    expect(execHook.calls.map((c) => c.file)).not.toContain('pi');
  });
});

describe('readHostGithubToken', () => {
  it('returns the token a logged-in gh prints', async () => {
    reply('gh', { kind: 'ok', stdout: 'gho_from_gh\n' });
    vi.stubEnv('GITHUB_TOKEN', 'gho_from_env');

    expect(await readHostGithubToken()).toBe('gho_from_gh');
  });

  it('falls back to GITHUB_TOKEN when gh is absent', async () => {
    vi.stubEnv('GITHUB_TOKEN', ' gho_from_env \n');

    expect(await readHostGithubToken()).toBe('gho_from_env');
  });

  it('falls back to GITHUB_TOKEN when gh answers with an empty token', async () => {
    reply('gh', { kind: 'ok', stdout: '\n' });
    vi.stubEnv('GITHUB_TOKEN', 'gho_from_env');

    expect(await readHostGithubToken()).toBe('gho_from_env');
  });

  it('returns null when neither gh nor the environment has one', async () => {
    expect(await readHostGithubToken()).toBeNull();
  });
});
