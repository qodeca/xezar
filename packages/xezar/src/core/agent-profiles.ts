import type { ProviderId } from './provider-auth.ts';

/**
 * Agent profiles — a second (third, …) login of the SAME agent CLI.
 *
 * The binary never changes; only the environment does. `CLAUDE_CONFIG_DIR=~/.claude-klaudiusz claude`
 * is the same Claude Code talking to a different account, because that one variable relocates the
 * agent's ENTIRE per-user home: credentials, settings, projects and — the part that bites —
 * `sessions/`, so a session id only means something inside the dir it was created in.
 *
 * This module is the single maintenance surface for that vendor knowledge, and it is deliberately
 * the SIBLING of `src/agent-config/catalog.ts` rather than part of it: the catalog owns config
 * *file* knowledge (paths, formats, verbatim precedence strings), this owns the *home-relocation*
 * variable. Splitting them also keeps the layering honest — `agent-config/` may import `paths.ts`,
 * while this is imported BY the runners, provider auth and the terminal handoff.
 *
 * Pure by construction: no filesystem, no `process.env`, nothing to stub. Resolution against the
 * workspace config lives in `src/workspace/agent-profiles.ts`.
 *
 * Facts verified against the shipped CLIs on 2026-07-29; pi re-verified against 0.85.1 on
 * 2026-09-12 (#329), which is when its entry stopped being `null`.
 */

/**
 * Which env var relocates each agent's whole per-user home.
 *
 * `null` means the agent has no such variable and therefore cannot carry profiles:
 *
 * - **claude** → `CLAUDE_CONFIG_DIR`. Documented; moves credentials, settings, projects, sessions.
 * - **codex** → `CODEX_HOME`. Documented; `auth.json` lives inside it, so identity moves too.
 * - **opencode** → nothing usable. `OPENCODE_CONFIG_DIR`/`OPENCODE_CONFIG` move CONFIG ONLY;
 *   credentials live in `~/.local/share/opencode/opencode.db`, behind a separate `OPENCODE_DB`.
 *   A config-dir-only profile would swap settings while still billing the other account — the UI
 *   would say "Work" and the run would not be — so OpenCode is unsupported until it documents a
 *   single home variable. `XDG_CONFIG_HOME` is rejected regardless: it is machine-wide and would
 *   relocate every other XDG-aware tool the agent's own Bash calls touch.
 * - **pi** → `PI_CODING_AGENT_DIR`. Documented; `auth.json` lives inside it, so identity moves too.
 *   This entry read `null` until 2026-09-12 on the strength of a single check made on 2026-09-10,
 *   and that was wrong (#329). The bar OpenCode fails is credentials, so it is the observation
 *   that matters: with the variable pointed at an empty dir, pi 0.85.1 wrote `auth.json` there
 *   and reported "No API key found" while a populated `~/.pi/agent/auth.json` sat on disk. It
 *   READS from there too — a corrupt `settings.json` in the pinned dir produced
 *   `Warning: Invalid settings file <pinned>/settings.json`. Config and credentials both move,
 *   so a pi profile bills the account it names.
 *
 *   One caveat, and it is not a blocker: `PI_CODING_AGENT_SESSION_DIR` overrides session storage
 *   on its own, and `PI_` is in `BACKEND_ALLOW_PREFIXES`, so a host that sets it pulls `sessions/`
 *   out of the profile dir. Credentials still follow the profile, which is the billing boundary
 *   this table exists to protect; a shared session store is untidy, not a wrong-account run.
 */
export const PROFILE_ENV_VAR: Record<ProviderId, string | null> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  opencode: null,
  pi: 'PI_CODING_AGENT_DIR',
};

/** Providers that can carry more than one account — what the UI offers "Add account" for. */
export const PROFILE_CAPABLE_PROVIDERS: readonly ProviderId[] = (
  Object.keys(PROFILE_ENV_VAR) as ProviderId[]
).filter((provider) => PROFILE_ENV_VAR[provider] !== null);

export function supportsProfiles(provider: ProviderId): boolean {
  return PROFILE_ENV_VAR[provider] !== null;
}

/**
 * The env a spawned agent needs to run under `configDir`, or `{}` for the default profile.
 *
 * `{}` is load-bearing, not a convenience: `buildChildEnv` applies `extraEnv` AFTER its allowlist
 * and so bypasses it entirely, which makes this function the only thing standing between a
 * profile and the child environment. Returning nothing for the zero-config case means the
 * overwhelmingly common path adds literally no variable — the same environment xezar has always
 * spawned. It also means this can never emit one provider's variable for another provider's
 * process: the name comes from `PROFILE_ENV_VAR[provider]` and nowhere else.
 */
export function profileEnv(provider: ProviderId, configDir: string | null | undefined): Record<string, string> {
  const name = PROFILE_ENV_VAR[provider];
  const dir = configDir?.trim();
  if (name === null || !dir) return {};
  return { [name]: dir };
}

/**
 * Does `entries` look like a config dir this provider actually wrote?
 *
 * ADVISORY, never a gate. The honest first-run flow for a second account is *add the profile →
 * Connect → the CLI creates the dir on login*, so refusing an unrecognized directory would break
 * the very case the feature exists for. The answer drives a warning line in the UI, nothing more.
 *
 * Takes the directory listing rather than a path so it stays pure; the caller reads the dir.
 */
export function looksLikeProfileDir(provider: ProviderId, entries: readonly string[]): boolean {
  const present = new Set(entries);
  const markers = PROFILE_DIR_MARKERS[provider];
  return markers.some((marker) => present.has(marker));
}

/** What each agent drops into its home on first login. Any one is enough. */
const PROFILE_DIR_MARKERS: Record<ProviderId, readonly string[]> = {
  // `.claude.json` sits INSIDE the dir once it is overridden (see `claudeStateFilePath`), which
  // is exactly the case being probed here.
  claude: ['.claude.json', 'settings.json', 'projects', 'sessions'],
  codex: ['auth.json', 'config.toml'],
  opencode: [],
  // Observed against pi 0.85.1 on 2026-09-12: a single `PI_CODING_AGENT_DIR=<empty dir> pi` run
  // drops `auth.json`, `models-store.json` and `sessions/`; a long-lived home also carries
  // `settings.json` and `models.json`. This list must move with `PROFILE_ENV_VAR.pi` — leaving it
  // `[]` while pi became profile-capable would warn "doesn't look like a pi folder" on every real
  // pi profile, because `looksLikeProfileDir` reads THIS table and not the variable.
  pi: ['auth.json', 'settings.json', 'models.json', 'models-store.json', 'sessions'],
};
