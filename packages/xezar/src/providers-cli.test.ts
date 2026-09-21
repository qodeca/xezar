import { describe, expect, it } from 'vitest';
import type { ProviderConnectionState } from './core/provider-auth.ts';
import { runProvidersCommand, type ProvidersCommandDeps } from './providers-cli.ts';

/**
 * `xezar providers connect` (#819 item 8) — the person's door to the one provider action the MCP
 * refuses. Every case names the break it fails against; the collaborators are fakes that record
 * what was reached, so "refused before anything" is a fact, not a hope.
 */

function harness(state: ProviderConnectionState, opts: { opens?: boolean; env?: NodeJS.ProcessEnv; bindHost?: string } = {}) {
  const reached: string[] = [];
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
      loginCommand: (provider) => {
        reached.push('loginCommand');
        return `${provider} auth login`;
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
  return { deps, reached, out, err };
}

describe('xezar providers connect (#819 item 8)', () => {
  // P7-AC5. Break: a hosted xezar opening (or probing for) a login terminal nobody is sitting at.
  it('refuses in hosted mode before it reads, probes or opens anything', async () => {
    const h = harness('disconnected', { env: { XEZ_REMOTE: '1' } });
    expect(await runProvidersCommand(['connect', 'claude'], undefined, h.deps)).toBe(1);
    expect(h.reached).toEqual([]);
    expect(h.err.join('\n')).toMatch(/refused — this xezar runs in hosted mode/);
  });

  // P7-AC5, the bind half. Break: `--bind-host` on a network interface not counting as hosted.
  it('refuses behind a non-loopback bind host too', async () => {
    const h = harness('disconnected', { bindHost: '0.0.0.0' });
    expect(await runProvidersCommand(['connect', 'claude'], 'work', h.deps)).toBe(1);
    expect(h.reached).toEqual([]);
  });

  // Break: the command not opening the terminal the refused MCP action sends the person to.
  it('opens a login terminal on the host for a provider that is not signed in', async () => {
    const h = harness('disconnected');
    expect(await runProvidersCommand(['connect', 'claude'], undefined, h.deps)).toBe(0);
    expect(h.reached).toEqual(['loginCommand', 'status', 'open:/work/project:claude auth login']);
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
    expect(unknown.err.join('\n')).toContain('To sign in anyway, run: claude auth login');

    const closed = harness('disconnected', { opens: false });
    expect(await runProvidersCommand(['connect', 'claude'], undefined, closed.deps)).toBe(1);
    expect(closed.err.join('\n')).toContain('Run this command yourself: claude auth login');
  });

  // Break: an unknown account silently falling back to the built-in login (the wrong account signs in).
  it('refuses an account id that names no account', async () => {
    const h = harness('disconnected');
    expect(await runProvidersCommand(['connect', 'claude'], 'no-such-account', h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('unknown claude account: no-such-account');
    expect(h.reached).toEqual([]);
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
