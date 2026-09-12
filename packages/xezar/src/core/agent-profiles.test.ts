import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from './provider-auth.ts';
import {
  PROFILE_CAPABLE_PROVIDERS,
  PROFILE_ENV_VAR,
  looksLikeProfileDir,
  profileEnv,
  supportsProfiles,
} from './agent-profiles.ts';

describe('PROFILE_ENV_VAR', () => {
  it('names one variable per provider that can carry an account', () => {
    expect(PROFILE_ENV_VAR.claude).toBe('CLAUDE_CONFIG_DIR');
    expect(PROFILE_ENV_VAR.codex).toBe('CODEX_HOME');
  });

  // #329. This entry was `null` because one check on 2026-09-10 concluded pi has no home
  // variable, and five places in the repo repeated it. It does: `pi --help` lists
  // `PI_CODING_AGENT_DIR - Config directory (default: ~/.pi/agent)`, and pi 0.85.1 was observed
  // both READING it (a corrupt `settings.json` in the pinned dir produced
  // `Warning: Invalid settings file <pinned>/settings.json`) and WRITING `auth.json` into it
  // while reporting "No API key found" against a populated `~/.pi/agent/auth.json`. Credentials
  // moving is the bar OpenCode fails and pi clears.
  it('supports pi — PI_CODING_AGENT_DIR moves credentials, not just config', () => {
    expect(PROFILE_ENV_VAR.pi).toBe('PI_CODING_AGENT_DIR');
    expect(supportsProfiles('pi')).toBe(true);
    expect(profileEnv('pi', '/home/u/.pi-work')).toEqual({ PI_CODING_AGENT_DIR: '/home/u/.pi-work' });
  });

  it('leaves OpenCode unsupported — its credentials do not follow its config dir', () => {
    expect(PROFILE_ENV_VAR.opencode).toBeNull();
    expect(supportsProfiles('opencode')).toBe(false);
    expect(PROFILE_CAPABLE_PROVIDERS).toEqual(['claude', 'codex', 'pi']);
  });

  it('covers every provider, so adding one forces a decision here', () => {
    expect(Object.keys(PROFILE_ENV_VAR).sort()).toEqual([...PROVIDER_IDS].sort());
  });
});

describe('profileEnv', () => {
  it('points the agent at its profile dir', () => {
    expect(profileEnv('claude', '/home/u/.claude-klaudiusz')).toEqual({
      CLAUDE_CONFIG_DIR: '/home/u/.claude-klaudiusz',
    });
    expect(profileEnv('codex', '/home/u/.codex-klaudiusz')).toEqual({ CODEX_HOME: '/home/u/.codex-klaudiusz' });
  });

  it('adds NOTHING for the default profile — the zero-config path must stay untouched', () => {
    expect(profileEnv('claude', null)).toEqual({});
    expect(profileEnv('claude', undefined)).toEqual({});
    expect(profileEnv('claude', '   ')).toEqual({});
  });

  it('adds nothing for a provider with no home variable, even given a dir', () => {
    expect(profileEnv('opencode', '/home/u/.config/opencode-work')).toEqual({});
  });

  it('can never emit another provider\'s variable', () => {
    // `buildChildEnv` applies extraEnv AFTER its allowlist, so this function is the only thing
    // standing between a profile and the child env. A codex step must not be handed
    // CLAUDE_CONFIG_DIR, which would point claude's sibling tooling at the wrong home.
    for (const provider of PROVIDER_IDS) {
      const emitted = Object.keys(profileEnv(provider, '/somewhere'));
      const foreign = Object.values(PROFILE_ENV_VAR).filter(
        (name): name is string => name !== null && name !== PROFILE_ENV_VAR[provider],
      );
      expect(emitted.some((name) => foreign.includes(name))).toBe(false);
    }
  });
});

describe('looksLikeProfileDir', () => {
  it('recognises a real Claude config dir by any one marker', () => {
    expect(looksLikeProfileDir('claude', ['.claude.json', 'projects', 'sessions'])).toBe(true);
    expect(looksLikeProfileDir('claude', ['settings.json'])).toBe(true);
  });

  it('recognises a Codex home', () => {
    expect(looksLikeProfileDir('codex', ['auth.json', 'history.jsonl'])).toBe(true);
    expect(looksLikeProfileDir('codex', ['config.toml'])).toBe(true);
  });

  // The second half of #329, and the half that flipping `PROFILE_ENV_VAR.pi` alone would miss:
  // `looksLikeProfileDir` reads `PROFILE_DIR_MARKERS`, NOT the env-var table. Leaving pi's marker
  // list `[]` while pi became profile-capable would warn "doesn't look like a pi folder" on every
  // real pi profile. The names are what pi 0.85.1 actually wrote into an empty
  // `PI_CODING_AGENT_DIR` on 2026-09-12, plus the two a long-lived home carries.
  it('recognises a pi home', () => {
    expect(looksLikeProfileDir('pi', ['auth.json', 'models-store.json', 'sessions'])).toBe(true);
    expect(looksLikeProfileDir('pi', ['settings.json'])).toBe(true);
    expect(looksLikeProfileDir('pi', ['models.json'])).toBe(true);
  });

  it('says no for an unrelated directory — advisory, so the caller still accepts it', () => {
    expect(looksLikeProfileDir('claude', ['README.md'])).toBe(false);
    expect(looksLikeProfileDir('claude', [])).toBe(false);
    expect(looksLikeProfileDir('pi', ['README.md'])).toBe(false);
    expect(looksLikeProfileDir('pi', [])).toBe(false);
  });

  // A marker table that answers `true` for every provider it is asked about is not a check.
  // OpenCode cannot carry profiles, so nothing may look like an OpenCode profile dir.
  it('still recognises no OpenCode dir — it cannot carry a profile at all', () => {
    expect(looksLikeProfileDir('opencode', ['auth.json', 'opencode.json', 'settings.json'])).toBe(false);
  });
});
