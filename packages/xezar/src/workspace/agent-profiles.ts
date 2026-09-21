import { readdir, realpath } from 'node:fs/promises';
import { profileEnv, looksLikeProfileDir } from '../core/agent-profiles.ts';
import { PROVIDER_IDS, type ProviderId } from '../core/provider-auth.ts';
import { agentHomePaths, expandTilde } from '../paths.ts';
import type { AgentHomePaths } from '../agent-config/catalog.ts';
import { unavailableAgentAccountRefusal, type AgentAccountProblem } from '@qodeca/xezar-contract';
import { activeStateLayout } from '../state-layout.ts';
import {
  DEFAULT_AGENT_ACCOUNT_ID,
  loadAgentAccounts,
  selectionFor,
  type AgentAccount,
  type AgentAccountStore,
} from './agent-accounts.ts';

/**
 * Resolving an agent account against `~/.xezar/agent-accounts.json` — the I/O half of
 * `src/core/agent-profiles.ts` (which stays pure and owns the vendor knowledge).
 *
 * Nothing here is cached. `~/.xezar/` is shared by every xezar process on the machine (a `serve`
 * per repo, headless `xezar run`s, a settings PUT), so a snapshot is a staleness bug waiting to
 * happen — and one small JSON read is free next to spawning an agent CLI.
 */

/** An account as the rest of the codebase consumes it: id, provider, and the dir to point at. */
export interface ResolvedAgentProfile {
  id: string;
  provider: ProviderId;
  label: string;
  /** As stored (`~` kept) — what the user typed, or the discovered default's path. */
  configDir: string;
  /** Expanded absolute path — what actually gets handed to the CLI. */
  path: string;
  /** True for the discovered account, which is never stored and cannot be edited or deleted. */
  isDefault: boolean;
}

/**
 * Which slot of `AgentHomePaths` is a provider's home. **One table, read in both directions**, and
 * that is the fix rather than the style.
 *
 * Two sites used to answer this question separately and both got pi wrong:
 *
 * - reading, here: a ternary chain ending in `: home.claude`, so `pi` — the one provider it never
 *   named — resolved to `~/.claude`. `GET /api/v1/workspace/agent-profiles` lists over
 *   `PROVIDER_IDS`, so the pi row reported Claude's folder as pi's home before pi could carry
 *   accounts at all;
 * - writing, in `server.ts`'s `accountFiles()`: a run of conditional spreads that named claude,
 *   codex and opencode and silently did nothing for pi, so one pi account would have resolved its
 *   files inside the DEFAULT pi home.
 *
 * Half a fix twice. AGENTS.md § Changing a mechanism says to route both sites through one helper
 * rather than remember to edit both, so they now read the same table and a fifth provider is a
 * compile error in one place (#329).
 *
 * `opencode` maps to `opencodeConfig`, the one case where the provider id and the slot name
 * differ — the exact thing a lookup states plainly and a conditional spread hides.
 *
 * What the slot RESOLVES to is `agentHomePaths()`'s business, and it already honours the vendors'
 * own `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `XDG_CONFIG_HOME` / `PI_CODING_AGENT_DIR`, so setting
 * one of those on the xezar process moves that provider's DEFAULT account rather than being
 * ignored.
 */
export const HOME_SLOT: Record<ProviderId, keyof AgentHomePaths> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencodeConfig',
  pi: 'pi',
};

/** That provider's home out of a resolved set — the READ direction of `HOME_SLOT`. */
export function providerHome(provider: ProviderId, home: AgentHomePaths): string {
  return home[HOME_SLOT[provider]];
}

/** One account's folder as an `AgentHomePaths` patch — the WRITE direction of `HOME_SLOT`. */
export function accountHomePatch(provider: ProviderId, path: string): Partial<AgentHomePaths> {
  return { [HOME_SLOT[provider]]: path };
}

export function defaultAgentProfile(
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAgentProfile {
  const home = agentHomePaths(env);
  const path = providerHome(provider, home);
  return {
    id: DEFAULT_AGENT_ACCOUNT_ID,
    provider,
    label: 'Default',
    configDir: path,
    path,
    isDefault: true,
  };
}

/** Expand a stored account into its resolved form. Pure; the caller supplies the row. */
export function resolveStoredProfile(account: AgentAccount): ResolvedAgentProfile {
  return {
    id: account.id,
    provider: account.provider,
    label: account.label || account.id,
    configDir: account.configDir,
    path: expandTilde(account.configDir),
    isDefault: false,
  };
}

/** Every account for `provider`, discovered default first, then the stored extras in file order. */
export function profilesForProvider(
  store: Pick<AgentAccountStore, 'accounts'>,
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAgentProfile[] {
  return [
    defaultAgentProfile(provider, env),
    ...store.accounts.filter((a) => a.provider === provider).map(resolveStoredProfile),
  ];
}

/** Every account across every provider — the listing route's source. */
export function listAgentProfiles(
  store: Pick<AgentAccountStore, 'accounts'>,
  providers: readonly ProviderId[],
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAgentProfile[] {
  return providers.flatMap((provider) => profilesForProvider(store, provider, env));
}

/**
 * Stored references that name no account (issue #819 item 2) — a dangling `defaults.<provider>` or
 * a project selection whose account has since been deleted (or never existed, in a hand-edited
 * file).
 *
 * PURE and ADVISORY. Resolution deliberately keeps its silent fall back to the discovered account
 * (`selectProfile`): a dangling reference names no account, so the default is the only safe answer
 * and zero config still means "degrade, never fail". What was missing was any way to SAY that the
 * stored choice has no effect — this is that answer, and nothing here changes resolution.
 *
 * `profiles` is the resolved listing, discovered defaults included, because "known" has to mean
 * the same thing to the reporter and to `selectProfile`: an id that belongs to a DIFFERENT provider
 * is reported for this one, exactly as the selection route refuses it. The reserved `default` id is
 * never reported because the discovered default profile carries it for every provider.
 *
 * A store that was never loaded is EMPTY, and an empty store has no references to be dangling, so
 * this answers `[]`. That fail-open direction is deliberate and the route only serves it after a
 * successful load (and withholds the whole listing in hosted mode), so "we could not read the
 * file" is never presented as "the file is clean".
 */
export function accountProblems(
  store: Pick<AgentAccountStore, 'defaults' | 'selections'>,
  profiles: readonly Pick<ResolvedAgentProfile, 'id' | 'provider'>[],
): AgentAccountProblem[] {
  const known = new Map<ProviderId, Set<string>>();
  for (const profile of profiles) {
    const ids = known.get(profile.provider) ?? new Set<string>();
    ids.add(profile.id);
    known.set(profile.provider, ids);
  }
  const problems: AgentAccountProblem[] = [];
  const report = (where: 'defaults' | 'selection', provider: ProviderId, handle: string): void => {
    if (known.get(provider)?.has(handle)) return;
    problems.push({ kind: 'unknown-account' as const, where, provider, handle });
  };
  for (const provider of PROVIDER_IDS) {
    const handle = store.defaults[provider];
    if (handle !== undefined) report('defaults', provider, handle);
  }
  for (const selection of Object.values(store.selections)) {
    for (const provider of PROVIDER_IDS) {
      const handle = selection[provider];
      if (handle !== undefined) report('selection', provider, handle);
    }
  }
  return problems;
}

/**
 * The account a given `(project, provider)` pair resolves to.
 *
 * `profileId` is the caller's explicit choice — a run's recorded account, or a composer override.
 * When it is absent the project's stored selection decides, and when THAT is absent (or names an
 * account that no longer exists) the answer is the discovered default.
 *
 * Note the deliberate asymmetry with a missing DIRECTORY: an UNKNOWN id degrades silently to the
 * default, because a dangling reference names no account and the default is the only safe answer.
 * A KNOWN id whose directory has vanished does NOT degrade — see `profileDirState`. Falling back
 * there would run the task on the personal subscription while the UI still said "Work", and a
 * billing boundary is not a preference to degrade quietly across.
 */
export function selectProfile(
  store: AgentAccountStore,
  options: { provider: ProviderId; repoRoot?: string; profileId?: string; env?: NodeJS.ProcessEnv },
): ResolvedAgentProfile {
  const { provider, repoRoot, profileId } = options;
  const env = options.env ?? process.env;
  const chosen = profileId ?? selectionFor(store, repoRoot, provider);
  if (chosen === undefined || chosen === DEFAULT_AGENT_ACCOUNT_ID) return defaultAgentProfile(provider, env);
  const stored = store.accounts.find((a) => a.id === chosen && a.provider === provider);
  return stored ? resolveStoredProfile(stored) : defaultAgentProfile(provider, env);
}

/**
 * The env a spawned `provider` process needs for the account selected by `repoRoot`/`profileId`.
 *
 * `{}` for the default account, which is the whole point: the zero-config path adds nothing to the
 * child environment. Reads the store per call (see the module note) and never throws — an
 * unreadable home degrades to the default account, which is the behaviour xezar had before
 * accounts existed.
 */
export async function resolveProfileEnvForRoot(
  repoRoot: string | undefined,
  provider: ProviderId,
  profileId?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ profile: ResolvedAgentProfile; env: Record<string, string> }> {
  let store: AgentAccountStore;
  try {
    store = await loadAgentAccounts();
  } catch {
    return { profile: defaultAgentProfile(provider, env), env: {} };
  }
  const profile = selectProfile(store, { provider, repoRoot, profileId, env });
  // The default account contributes nothing: `agentHomePaths()` already reflects whatever the host
  // env says, so re-exporting it would be a no-op at best and a surprise at worst.
  return { profile, env: profile.isDefault ? {} : profileEnv(provider, profile.path) };
}

/** Whether an account's directory exists and looks like the agent wrote it. Never throws. */
export async function profileDirState(
  provider: ProviderId,
  path: string,
): Promise<{ exists: boolean; looksValid: boolean }> {
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    // Any read failure lands here, not only ENOENT: a folder that exists but cannot be read
    // (EACCES) or a path through a file (ENOTDIR) also reports `exists: false`, so the
    // single-project refusal's "does not exist on this machine" covers those too (#612 review n2).
    return { exists: false, looksValid: false };
  }
  return { exists: true, looksValid: looksLikeProfileDir(provider, entries) };
}

/**
 * A task asked for a committed account whose folder does not exist on this machine
 * (single-project mode, #600 FR-6.3, BR-4). The message is the Settings row's own sentence with the
 * account's name in front — `unavailableAgentAccountRefusal` builds both — so the person who reads
 * the refusal recognises the row it came from.
 */
export class AgentAccountUnavailableError extends Error {
  constructor(profile: Pick<ResolvedAgentProfile, 'label' | 'configDir'>) {
    super(unavailableAgentAccountRefusal(profile.label, profile.configDir));
    this.name = 'AgentAccountUnavailableError';
  }
}

/**
 * Refuse a task on an account the project carries but this machine lacks — single-project mode
 * only, where accounts are committed project state and a clone can arrive naming a folder that was
 * never created here.
 *
 * Global mode keeps its own, older answer on purpose: there an account whose folder is missing is
 * one the user just ADDED, and "add, then Connect, and the CLI creates the folder" is the real flow
 * (`agentProfileSchema.exists`). The discovered default account is never refused — it IS what this
 * machine has. And there is no fallback in either mode: running on the default login while the task
 * names "Work" would bill the wrong subscription (BR-4, "no silent fallback").
 */
export async function assertAgentAccountAvailable(profile: ResolvedAgentProfile): Promise<void> {
  if (profile.isDefault || activeStateLayout().mode !== 'project') return;
  if ((await profileDirState(profile.provider, profile.path)).exists) return;
  throw new AgentAccountUnavailableError(profile);
}

/**
 * Is `path` the same directory as an existing account's (or the default's)?
 *
 * Compared through `realpath` so two spellings of one dir — a symlink, a trailing slash — cannot
 * become two accounts that silently share a session store. A path that does not exist yet cannot
 * collide with anything, which is correct: the CLI has not created it, so it is nobody's home.
 */
export async function sameProfileDir(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}
