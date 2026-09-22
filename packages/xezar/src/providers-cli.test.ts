import { afterEach, describe, expect, it } from 'vitest';
import { ProviderAuthService, type ProviderConnectionState } from './core/provider-auth.ts';
import { runProvidersCommand, type ProvidersCommandDeps } from './providers-cli.ts';
import { mergeWriteAgentAccounts } from './workspace/agent-accounts.ts';

/**
 * `xezar providers connect` (#819 item 8) — the person's door to the one provider action the MCP
 * refuses. Every case names the break it fails against; the collaborators are fakes that record
 * what was reached, so "refused before anything" is a fact, not a hope.
 */

/**
 * The REAL login-command renderer, on a fixed platform. The fake below records calls and delegates
 * the answer here, never to a copy: its round-1 predecessor re-implemented the control-character
 * refusal with a wider regex than the product had, so the test was green while the built CLI wrote
 * a raw U+009B to the terminal (#833 review round 2). `loginCommand` spawns nothing.
 */
const realAuth = new ProviderAuthService({ platform: 'linux' });
const LOGIN = realAuth.loginCommand('claude', null);

function harness(state: ProviderConnectionState, opts: { opens?: boolean; env?: NodeJS.ProcessEnv; bindHost?: string } = {}) {
  const reached: string[] = [];
  /** The `configDir` every `loginCommand` call was given — which login the command signs in. */
  const loginDirs: (string | null | undefined)[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: ProvidersCommandDeps = {
    cwd: '/work/project',
    ...(opts.bindHost ? { bindHost: opts.bindHost } : {}),
    env: opts.env ?? {},
    io: { log: (line) => out.push(line), error: (line) => err.push(line) },
    providerAuth: {
      status: async () => {
        reached.push('status');
        return { providers: [{ provider: 'claude', status: state, ...(state === 'not-installed' ? { hint: 'Install it first.' } : {}) }] };
      },
      profileStatus: async (provider, profile) => {
        reached.push(`profileStatus:${profile.id}`);
        return { provider, status: state };
      },
      loginCommand: (provider, configDir) => {
        reached.push('loginCommand');
        loginDirs.push(configDir);
        return realAuth.loginCommand(provider, configDir);
      },
      installHint: () => 'Install it first.',
      forgetProfileStatus: () => {
        reached.push('forget');
      },
    },
    openTerminal: async (cwd, command) => {
      reached.push(`open:${cwd}:${command}`);
      return opts.opens ?? true;
    },
  };
  return { deps, reached, loginDirs, out, err };
}

describe('xezar providers connect (#819 item 8)', () => {
  // P7-AC5. Break: a hosted xezar opening (or probing for) a login terminal nobody is sitting at.
  // Naming the login command is the one call it makes: a static string that reads, probes and
  // opens nothing.
  it('refuses in hosted mode before it reads, probes or opens anything', async () => {
    const h = harness('disconnected', { env: { XEZ_REMOTE: '1' } });
    expect(await runProvidersCommand(['connect', 'claude'], undefined, h.deps)).toBe(1);
    expect(h.reached).toEqual(['loginCommand']);
    expect(h.err.join('\n')).toMatch(/refused — this xezar runs in hosted mode/);
  });

  // Review round 1 (F2). Break: the hosted refusal ending at "its own login command" without
  // naming one, which sends the person back to where they started.
  it('names the login command in its hosted-mode refusal', async () => {
    const h = harness('disconnected', { env: { XEZ_REMOTE: '1' } });
    expect(await runProvidersCommand(['connect', 'claude'], undefined, h.deps)).toBe(1);
    expect(h.err.join('\n').endsWith(`with its own login command: ${LOGIN}`)).toBe(true);
  });

  // P7-AC5, the bind half. Break: `--bind-host` on a network interface not counting as hosted.
  it('refuses behind a non-loopback bind host too', async () => {
    const h = harness('disconnected', { bindHost: '0.0.0.0' });
    expect(await runProvidersCommand(['connect', 'claude'], 'work', h.deps)).toBe(1);
    expect(h.reached).toEqual(['loginCommand']);
  });

  // Break: the command not opening the terminal the refused MCP action sends the person to.
  it('opens a login terminal on the host for a provider that is not signed in', async () => {
    const h = harness('disconnected');
    expect(await runProvidersCommand(['connect', 'claude'], undefined, h.deps)).toBe(0);
    expect(h.reached).toEqual(['loginCommand', 'status', `open:/work/project:${LOGIN}`]);
    expect(h.out.join('\n')).toContain('A login terminal opened for claude');
  });

  // Guard: an account already signed in opens nothing.
  it('opens nothing when the provider is already signed in', async () => {
    const h = harness('connected');
    expect(await runProvidersCommand(['connect', 'claude'], 'default', h.deps)).toBe(0);
    expect(h.reached.some((step) => step.startsWith('open:'))).toBe(false);
    expect(h.out.join('\n')).toContain('already signed in');
  });

  // Break: a missing agent, an unverifiable sign-in or a terminal that did not open reading as success.
  it('exits 1 with what to do when the agent is missing, unverifiable, or no terminal opens', async () => {
    const missing = harness('not-installed');
    expect(await runProvidersCommand(['connect', 'claude'], undefined, missing.deps)).toBe(1);
    expect(missing.err.join('\n')).toContain('Install it first.');

    const unknown = harness('unknown');
    expect(await runProvidersCommand(['connect', 'claude'], undefined, unknown.deps)).toBe(1);
    expect(unknown.err.join('\n')).toContain(`To sign in anyway, run: ${LOGIN}`);

    const closed = harness('disconnected', { opens: false });
    expect(await runProvidersCommand(['connect', 'claude'], undefined, closed.deps)).toBe(1);
    expect(closed.err.join('\n')).toContain(`Run this command yourself: ${LOGIN}`);
  });

  // Break: an unknown account silently falling back to the built-in login (the wrong account signs in).
  it('refuses an account id that names no account', async () => {
    const h = harness('disconnected');
    expect(await runProvidersCommand(['connect', 'claude'], 'no-such-account', h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('unknown claude account: no-such-account');
    expect(h.reached).toEqual([]);
  });

  describe('a stored account', () => {
    afterEach(async () => {
      await mergeWriteAgentAccounts((store) => ({ ...store, accounts: [] }));
    });

    // Review round 1 (F6). Break: `loginCommand(provider, null)` for a stored account — the command
    // then signs the person into the BUILT-IN login instead of the account they named.
    it('signs in the named account, with that account’s own folder', async () => {
      await mergeWriteAgentAccounts((store) => ({
        ...store,
        accounts: [{ id: 'work', provider: 'claude', configDir: '/accounts/work', label: 'Work', addedAt: '2026-09-22T00:00:00.000Z' }],
      }));
      const h = harness('disconnected');
      expect(await runProvidersCommand(['connect', 'claude'], 'work', h.deps)).toBe(0);
      expect(h.loginDirs).toEqual(['/accounts/work']);
      expect(h.reached).toContain(`open:/work/project:export CLAUDE_CONFIG_DIR='/accounts/work'; ${LOGIN}`);
      expect(h.reached).toContain('profileStatus:work');
    });

    // Review round 1 (F5). Break: the refusal writing a committed file's folder to a real terminal
    // raw. The 7-bit ESC is refused when the accounts file is read; the 8-bit CSI (U+009B) is not,
    // and it is the one that reaches this refusal.
    it('never writes a control character from the folder to the terminal', async () => {
      await mergeWriteAgentAccounts((store) => ({
        ...store,
        accounts: [{ id: 'work', provider: 'claude', configDir: '/accounts/\u009b31mred\u009b0m', label: 'Work', addedAt: '2026-09-22T00:00:00.000Z' }],
      }));
      const h = harness('disconnected');
      expect(await runProvidersCommand(['connect', 'claude'], 'work', h.deps)).toBe(1);
      const written = h.err.join('\n');
      expect(written).toContain("this account's folder cannot be used in a terminal command: /accounts/?31mred?0m");
      expect(written).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(h.reached.some((step) => step.startsWith('open:'))).toBe(false);
    });
  });

  // Break: a typo reaching the terminal instead of a named usage error.
  it('names the usage error for an unknown verb, a missing or unknown provider, and a stray argument', async () => {
    for (const args of [[], ['disconnect', 'claude'], ['connect'], ['connect', 'gemini'], ['connect', 'claude', 'extra']]) {
      const h = harness('disconnected');
      expect(await runProvidersCommand(args, undefined, h.deps), JSON.stringify(args)).toBe(1);
      expect(h.err.at(-1), JSON.stringify(args)).toBe('usage: xezar providers connect <claude|codex|opencode|pi> [--account <id>]');
      expect(h.reached).toEqual([]);
    }
  });
});
