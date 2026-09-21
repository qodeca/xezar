import { PROVIDER_IDS, ProviderAuthService, type ProviderId } from './core/provider-auth.ts';
import { resolveCapabilities } from './server/capabilities.ts';
import { openInTerminal } from './server/open-in-terminal.ts';
import { DEFAULT_AGENT_ACCOUNT_ID, loadAgentAccounts } from './workspace/agent-accounts.ts';
import { defaultAgentProfile, resolveStoredProfile, type ResolvedAgentProfile } from './workspace/agent-profiles.ts';

/**
 * `xezar providers connect <provider> [--account <id>]` (#819 item 8) — the person's door to the one
 * provider action a leader may not take.
 *
 * `connect_provider` is refused through the MCP because it opens a login terminal on the host
 * machine (owner, 2026-09-20 07:41). A refusal that stopped there left the person hunting for the
 * Providers card; this command is the next step the refusal names, and a person typing it at the
 * host's own terminal is exactly who the boundary is for.
 *
 * It follows `POST /providers/connect` step for step, so the two doors cannot disagree about which
 * account they sign in or when they refuse:
 *
 * 1. hosted mode refuses BEFORE anything is resolved — the route refuses a named account there
 *    before reading the accounts file, and a login terminal on a server nobody is sitting at is
 *    not a terminal anybody can type into;
 * 2. the account resolves (the built-in login when none is named), and an unknown id is an error,
 *    never a silent fall-back to another login;
 * 3. an unsafe folder for this platform's shell refuses rather than running the bare command;
 * 4. an account already signed in opens nothing; a missing agent or an unverifiable sign-in says
 *    what to do; otherwise the terminal opens, and when it cannot, the exact command is printed.
 *
 * Exit 0 when a terminal opened or the account is already signed in; 1 for every refusal and every
 * outcome that leaves the person something to do by hand. No server is needed and none is started.
 */

export interface ProvidersCommandIo {
  log(line: string): void;
  error(line: string): void;
}

export interface ProvidersCommandDeps {
  /** Where the login terminal starts. */
  readonly cwd: string;
  /** `--bind-host`, when given: a non-loopback host is hosted mode, as for `serve`. */
  readonly bindHost?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly io?: ProvidersCommandIo;
  /** Test seams; production builds its own. */
  readonly providerAuth?: Pick<ProviderAuthService, 'status' | 'profileStatus' | 'loginCommand' | 'installHint' | 'forgetProfileStatus'>;
  readonly openTerminal?: (cwd: string, command: string) => Promise<boolean>;
}

export const PROVIDERS_USAGE = 'usage: xezar providers connect <claude|codex|opencode|pi> [--account <id>]';

const isProvider = (value: string | undefined): value is ProviderId =>
  value !== undefined && (PROVIDER_IDS as readonly string[]).includes(value);

export async function runProvidersCommand(
  args: readonly string[],
  account: string | undefined,
  deps: ProvidersCommandDeps,
): Promise<number> {
  const io = deps.io ?? { log: (line) => console.log(line), error: (line) => console.error(line) };
  const env = deps.env ?? process.env;
  const [verb, provider, ...rest] = args;
  if (verb !== 'connect') {
    io.error(`unknown providers command: ${verb ?? '(none)'}`);
    io.error(PROVIDERS_USAGE);
    return 1;
  }
  if (!isProvider(provider)) {
    io.error(provider === undefined ? 'providers connect: name the provider to connect.' : `providers connect: unknown provider: ${provider}`);
    io.error(PROVIDERS_USAGE);
    return 1;
  }
  if (rest.length > 0) {
    io.error(`providers connect: unexpected argument: ${rest[0]}`);
    io.error(PROVIDERS_USAGE);
    return 1;
  }
  // 1. Off the host machine: refuse before the accounts file is read or anything is probed.
  if (!resolveCapabilities(env, deps.bindHost).localHandoff) {
    io.error(
      'providers connect: refused — this xezar runs in hosted mode (XEZ_REMOTE=1 or a non-loopback --bind-host), so it does not open a login terminal here. ' +
        'Sign the agent in on the machine where it runs tasks, with its own login command.',
    );
    return 1;
  }
  // 2. Which account.
  let profile: ResolvedAgentProfile;
  if (account === undefined || account === DEFAULT_AGENT_ACCOUNT_ID) {
    profile = defaultAgentProfile(provider, env);
  } else {
    let stored;
    try {
      stored = (await loadAgentAccounts()).accounts.find((row) => row.id === account && row.provider === provider);
    } catch {
      stored = undefined;
    }
    if (!stored) {
      io.error(`providers connect: unknown ${provider} account: ${account}`);
      return 1;
    }
    profile = resolveStoredProfile(stored);
  }
  const auth = deps.providerAuth ?? new ProviderAuthService();
  // 3. A folder this shell cannot carry safely is a refusal, never the bare command.
  const command = auth.loginCommand(provider, profile.isDefault ? null : profile.path);
  if (command === null) {
    io.error(`providers connect: this account's folder cannot be used in a terminal command: ${profile.configDir}`);
    return 1;
  }
  // 4. Is it signed in NOW — the account branch evicts first, as the route does.
  if (!profile.isDefault) auth.forgetProfileStatus(provider, profile.id);
  const row = profile.isDefault
    ? (await auth.status({ refresh: true })).providers.find((candidate) => candidate.provider === provider)
    : await auth.profileStatus(provider, { id: profile.id, configDir: profile.path });
  if (!row) {
    io.error('providers connect: the sign-in could not be verified. Try again.');
    return 1;
  }
  if (row.status === 'connected') {
    io.log(`${provider} is already signed in${profile.isDefault ? '' : ` (account ${profile.id})`}. Nothing to do.`);
    return 0;
  }
  if (row.status === 'not-installed') {
    io.error(`providers connect: ${row.hint ?? auth.installHint(provider)}`);
    return 1;
  }
  if (row.status === 'unknown') {
    io.error(`providers connect: ${row.hint ?? 'the sign-in could not be verified.'} To sign in anyway, run: ${command}`);
    return 1;
  }
  let opened = false;
  try {
    opened = await (deps.openTerminal ?? openInTerminal)(deps.cwd, command);
  } catch {
    // Best-effort, like the route: the exact command below is the fallback.
  }
  if (!opened) {
    io.error(`providers connect: no terminal window could be opened. Run this command yourself: ${command}`);
    return 1;
  }
  io.log(`A login terminal opened for ${provider}. Finish signing in there: ${command}`);
  return 0;
}
