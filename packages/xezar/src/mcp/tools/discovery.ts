import { basename } from 'node:path';
import { z } from 'zod';
import {
  mcpDiscoverySchema,
  type HealthResponse,
  type McpDiscovery,
  type McpDiscoveryAction,
  type McpDiscoveryAgent,
  type McpDiscoveryLimits,
  type McpDiscoveryToolCheck,
  onboardingStatusSchema,
  type OnboardingStatus,
  type ProviderStatusResponse,
  type Runner,
} from '@qodeca/xezar-contract';
import { loadConfig } from '../../config.ts';
import { agentModelsLocked } from '../../core/agent-model-policy.ts';
import { ProviderAuthService } from '../../core/provider-auth.ts';
import { applyProviderEnablement } from '../../core/provider-availability.ts';
import { detectEnvironment } from '../../core/backend-detect.ts';
import { resolveCapabilities } from '../../server/capabilities.ts';
import { resolveForge } from '../../server/forge/index.ts';
import { getRepoInfo } from '../../server/git.ts';
import { loadWorkspaceConfig } from '../../workspace/config.ts';
import { projectDataDir } from '../../project-data-paths.ts';
import { discoverIssueFiling } from '../../onboarding/issue-filing.ts';
import { observedIdentity, onboardingStatus } from '../../onboarding/status.ts';
import { readOnboardingThroughService, type ServiceDispatch } from '../service-adapter.ts';
import { defineTool, textResult, type McpToolContext } from '../tool.ts';

/**
 * `discover_project` (#90, F-03, U-M06): which project this session is bound to, what it can do
 * and within which limits, and — for everything it cannot do — why.
 *
 * Two halves on purpose. `collectDiscoveryFacts` gathers what `GET /health` and `GET /config`
 * report, through the same helpers those routes call, for the BOUND project only: it never reads
 * the project list at all. `buildDiscovery` is the filter — pure, and the part the isolation
 * guarantees rest on. It accepts the health shape (a full `HealthResponse` included, `projects`
 * and `bootProject` and all), copies out only what `mcpDiscoverySchema` names, and writes every
 * reason itself instead of forwarding a CLI's text: raw `gh` or agent output can name an account
 * or an organisation (F-12, F-15). The strict schema parse at the end turns any key that slips in
 * later into a tool failure instead of a leak.
 */

export interface DiscoveryFacts {
  project: McpToolContext['project'];
  xezarVersion: string;
  /** Structurally a subset of `HealthResponse`, so a whole health payload is accepted — and filtered. */
  health: Pick<HealthResponse, 'repo' | 'checks' | 'forge' | 'capabilities' | 'defaultRunner'>;
  config: { baseBranch: string | null; modelsLocked: boolean };
  providers: ProviderStatusResponse;
  limits: McpDiscoveryLimits;
  /** This project's setup state (#464 P2) — see `collectOnboarding` for where it comes from. */
  onboarding: OnboardingStatus;
}

/** `discover_project` reads the onboarding block through the service when it has one — see
 *  `collectOnboarding`. Same shape `project_config` declares for the same reason. */
export type DiscoveryContext = McpToolContext & { readonly service?: ServiceDispatch };

const RUNNERS: readonly Runner[] = ['claude', 'codex', 'opencode', 'pi'];
const LABEL: Record<Runner, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', pi: 'pi' };
const PROVIDERS_SETTINGS = 'Settings → Agents → Providers';
const HOSTED_REASON =
  'This xezar runs in hosted mode (XEZ_REMOTE=1 or a non-loopback bind), so actions on the host machine are refused.';

export function buildDiscovery(facts: DiscoveryFacts): McpDiscovery {
  const { health, config } = facts;
  const caps = health.capabilities;
  const agents = RUNNERS.map((runner) => agentEntry(runner, facts));
  const git = health.repo !== null;
  const githubReason = githubUnavailableReason(facts);

  const actions: McpDiscoveryAction[] = [
    action('create_task', 'Start a task', createTaskReason(agents)),
    action(
      'parallel_variants',
      'Run a task as parallel variants',
      git ? null : 'Parallel variants need a git repository — each variant runs in its own worktree.',
    ),
    action(
      'worktree_choice',
      'Choose worktree or in-place for a task',
      git ? null : 'This project is not a git repository, so tasks run in place, one at a time.',
    ),
    config.modelsLocked
      ? readOnly(
          'model_selection',
          'Choose a task model',
          "Models are locked: each coding agent uses the model from its own native settings. Only a person can change that (XEZ_AGENT_MODELS_LOCKED or modelsLocked in xezar's config).",
        )
      : action('model_selection', 'Choose a task model', null),
    action('github', 'GitHub issues, pull requests and draft PRs', githubReason),
    action(
      'automations',
      'GitHub automations',
      !caps.automations
        ? 'GitHub automations are off on this xezar. A person can start it with XEZ_AUTOMATIONS=1 to turn them on.'
        : githubReason && `GitHub automations need GitHub: ${githubReason}`,
    ),
    action(
      'inbox',
      'Follow-up inbox',
      caps.followups
        ? null
        : 'The follow-up inbox is off for this workspace. A person can turn it on in the cockpit settings (or with XEZ_FOLLOWUPS=1).',
    ),
    action('open_in_app', 'Open the project or a task in a desktop app', caps.localHandoff ? null : HOSTED_REASON),
    action(
      'agent_config_write',
      "Edit the coding agents' config files",
      caps.localHandoff ? null : `${HOSTED_REASON} Agent config files can define hooks and commands, so they are never written remotely.`,
    ),
    readOnly(
      'workspace_limits',
      'Change workspace-wide limits',
      "Workspace limits are shared with every project. The leader can read them; only a person can change them in the cockpit's global settings.",
    ),
  ];

  return mcpDiscoverySchema.parse({
    project: {
      id: facts.project.id,
      name: facts.project.name,
      // The rule `/health` already follows (#431): a hosted cockpit reports a basename only.
      root: caps.localHandoff ? facts.project.root : basename(facts.project.root),
    },
    xezarVersion: facts.xezarVersion,
    repository: git ? { git: true, branch: health.repo!.branch } : { git: false },
    settings: { defaultRunner: health.defaultRunner, baseBranch: config.baseBranch, modelsLocked: config.modelsLocked },
    capabilities: { localHandoff: caps.localHandoff, followups: caps.followups, automations: caps.automations },
    agents,
    tools: (['gh', 'git'] as const).map((name) => toolCheck(name, facts)),
    limits: facts.limits,
    actions,
    onboarding: facts.onboarding,
  });
}

function action(id: McpDiscoveryAction['id'], label: string, reason: string | null): McpDiscoveryAction {
  return reason ? { id, label, status: 'unavailable', reason } : { id, label, status: 'available' };
}

function readOnly(id: McpDiscoveryAction['id'], label: string, reason: string): McpDiscoveryAction {
  return { id, label, status: 'read-only', reason };
}

function agentEntry(runner: Runner, facts: DiscoveryFacts): McpDiscoveryAgent {
  const check = facts.health.checks.find((c) => c.name === runner);
  const row = facts.providers.providers.find((p) => p.provider === runner);
  const signIn = row?.status ?? 'unknown';
  const installed = check ? check.available : signIn !== 'not-installed';
  const enabled = row?.enabled !== false;
  // The cockpit's own rule (`usableRunners`): enabled AND signed in.
  const usable = enabled && signIn === 'connected';
  const version = installed ? versionLine(check?.version) : undefined;
  return {
    runner,
    installed,
    ...(version ? { version } : {}),
    enabled,
    signIn,
    usable,
    ...(usable ? {} : { reason: agentReason(runner, enabled, installed ? signIn : 'not-installed') }),
  };
}

function agentReason(runner: Runner, enabled: boolean, signIn: McpDiscoveryAgent['signIn']): string {
  const label = LABEL[runner];
  if (!enabled) return `${label} is disabled in ${PROVIDERS_SETTINGS}.`;
  switch (signIn) {
    case 'not-installed':
      return `${label} is not installed on this machine.`;
    case 'disconnected':
      return `${label} is installed but not signed in. A person can sign in from ${PROVIDERS_SETTINGS}.`;
    default:
      return `${label}'s sign-in could not be verified yet. Call this tool again shortly.`;
  }
}

/** A version is one short line of a CLI's `--version`; anything longer is not a version. */
function versionLine(version: string | undefined): string | undefined {
  const line = version?.split('\n')[0]?.trim();
  return line ? line.slice(0, 80) : undefined;
}

function createTaskReason(agents: readonly McpDiscoveryAgent[]): string | null {
  if (agents.some((a) => a.usable)) return null;
  return `No coding agent is ready to run a task. ${agents.map((a) => a.reason).join(' ')}`;
}

function toolCheck(name: 'gh' | 'git', facts: DiscoveryFacts): McpDiscoveryToolCheck {
  const available = facts.health.checks.find((c) => c.name === name)?.available === true;
  if (available) return { name, available };
  return {
    name,
    available,
    reason:
      name === 'gh'
        ? 'The GitHub CLI (gh) is not installed or not signed in. GitHub features need it; a person can run `gh auth login`.'
        : 'git is not installed on this machine.',
  };
}

/**
 * Why the GitHub area is closed, or null when it is open. `gh`'s own error text is CLASSIFIED,
 * never forwarded: it can quote the repository owner, an organisation or an account.
 */
function githubUnavailableReason(facts: DiscoveryFacts): string | null {
  const { repo, forge } = facts.health;
  if (!repo) return 'This project is not a git repository, so it has no GitHub remote.';
  if (!forge) return "This repository has no GitHub remote; xezar's GitHub features need a github.com remote.";
  if (forge.available === true) return null;
  if (forge.available === undefined) {
    return 'GitHub availability has not been checked yet. Call this tool again in a few seconds.';
  }
  const raw = forge.reason ?? '';
  if (/ENOENT|gh CLI not found/i.test(raw)) {
    return 'The GitHub CLI (gh) is not installed on this machine. A person can install it and run `gh auth login`.';
  }
  if (/auth login|not logged|authenticat|credential|\b401\b/i.test(raw)) {
    return 'The GitHub CLI (gh) is not signed in. A person can run `gh auth login`.';
  }
  return 'The GitHub CLI (gh) could not open this repository on GitHub. Check `gh auth status`, access to the repository and the network.';
}

// ---- gathering: the same facts `/health` and `/config` read, for the bound project only ------

let providerAuth: ProviderAuthService | undefined;

/**
 * `--bind-host` of THIS process. The MCP socket lives inside `xezar serve`, and a non-loopback
 * bind is half of what makes the cockpit hosted; `McpToolContext` does not carry it yet (#89
 * widens that context), and reporting `localHandoff: true` on a hosted box would promise actions
 * the routes refuse.
 */
export function bindHostFromArgv(argv: readonly string[] = process.argv): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--bind-host') return argv[i + 1];
    if (arg.startsWith('--bind-host=')) return arg.slice('--bind-host='.length);
  }
  return undefined;
}

/**
 * This project's setup state, read the same way the cockpit reads it (#464 P2, `AC-17`).
 *
 * When the tool has the service's in-process entry — which it does in every running xezar — this
 * IS the cockpit's own `GET /onboarding`, byte for byte, so the leader and the person can never be
 * told different things about whether a check happened. N-02 also asks for exactly that: the MCP
 * reaches project state through the routes, not around them.
 *
 * Without a service (a tool called directly, as `discovery.test.ts` does) it falls back to the
 * shared derivation with no running-task id, because the run store lives behind the service. The
 * fallback is narrower, never wrong: `checkingRunId: null` says "not known to be running", and the
 * leader's own `organise_work` is where a running task is listed anyway.
 */
export async function collectOnboarding(
  ctx: DiscoveryContext,
  checks: Awaited<ReturnType<typeof detectEnvironment>>,
  localHandoff: boolean,
): Promise<OnboardingStatus> {
  const observed = observedIdentity(ctx.xezarVersion);
  if (ctx.service) {
    const answer = await readOnboardingThroughService(ctx.service, ctx.project.id);
    const parsed = onboardingStatusSchema.safeParse(answer);
    // The route is the preferred source, never a required one: discovery must keep answering.
    if (parsed.success) return parsed.data;
  }
  return onboardingStatus(projectDataDir(ctx.project.root), {
    observed,
    checks,
    localHandoff,
    checkingRunId: null,
    issueFiling: await discoverIssueFiling(ctx.project.root, checks),
  });
}

export async function collectDiscoveryFacts(
  ctx: DiscoveryContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscoveryFacts> {
  const root = ctx.project.root;
  const [checks, repo, config, workspace] = await Promise.all([
    detectEnvironment(),
    getRepoInfo(root),
    loadConfig(root),
    loadWorkspaceConfig(),
  ]);
  const forge = resolveForge(repo);
  // Awaited, unlike `/health`: a tool call can afford the one `gh` probe, and a settled answer
  // beats "not checked yet". The driver caches it for 60 s either way.
  const availability = forge ? await forge.detect().catch(() => ({ available: false })) : null;
  providerAuth ??= new ProviderAuthService();
  const providers = applyProviderEnablement(await providerAuth.status(), workspace.disabledProviders);
  const own = workspace.projects.find((p) => p.id === ctx.project.id);
  const resources = workspace.resources;
  const projectMaxParallel = own?.maxParallel ?? null;
  const projectMemoryLimitMb = typeof config.memoryLimitMb === 'number' && config.memoryLimitMb > 0 ? config.memoryLimitMb : null;
  const capabilities = resolveCapabilities(env, bindHostFromArgv(), workspace.followups);
  return {
    project: ctx.project,
    xezarVersion: ctx.xezarVersion,
    health: {
      repo,
      checks,
      defaultRunner: config.defaultRunner,
      forge: forge ? { kind: forge.kind, ...availability } : null,
      capabilities,
    },
    onboarding: await collectOnboarding(ctx, checks, capabilities.localHandoff),
    config: { baseBranch: config.baseBranch ?? null, modelsLocked: agentModelsLocked(root, env) },
    providers,
    limits: {
      maxParallel: {
        effective: projectMaxParallel ?? resources.maxParallel,
        project: projectMaxParallel,
        workspace: resources.maxParallel,
      },
      memoryLimitMb: {
        effective: projectMemoryLimitMb ?? resources.memoryLimitMb,
        project: projectMemoryLimitMb,
        workspace: resources.memoryLimitMb,
      },
      maxMonitoringSessions: resources.maxMonitoringSessions,
      monitoringWakeIntervalMinutes: resources.monitoringWakeIntervalMinutes,
      autoResumeOnUsageLimit: resources.autoResumeOnUsageLimit,
      idleTimeoutMinutes: resources.idleTimeoutMinutes,
      worktreeRetention: config.worktreeRetention,
    },
  };
}

/** The authoritative text block (D-05): a one-line orientation, then the whole result. */
export function discoveryText(discovery: McpDiscovery): string {
  const closed = discovery.actions.filter((a) => a.status !== 'available');
  const lines = [
    `Bound to xezar project "${discovery.project.name}" (id ${discovery.project.id}).`,
    ...closed.map((a) => `${a.status === 'read-only' ? 'Read-only' : 'Unavailable'}: ${a.label} — ${a.reason}`),
    onboardingLine(discovery.onboarding),
    issueFilingLine(discovery.onboarding.issueFiling),
    '',
    JSON.stringify(discovery, null, 2),
  ];
  return lines.join('\n');
}

/**
 * The setup state as one sentence (#464 P2).
 *
 * It states a fact and stops. There is deliberately no "you should re-check": an offer is not a
 * run, and a leader deciding to spend a task on one is a decision, not a prompt this answer makes
 * for it.
 */
function onboardingLine(onboarding: OnboardingStatus): string {
  switch (onboarding.state) {
    case 'checking':
      return `Setup: a check is running (task ${onboarding.checkingRunId ?? 'unknown'}).`;
    case 'set-up':
      return `Setup: a check finished against xezar ${onboarding.lastChecked?.engineVersion} and setup templates ${onboarding.lastChecked?.kitDigest}.`;
    case 'changed':
      return `Setup: the last finished check covered xezar ${onboarding.lastChecked?.engineVersion} and setup templates ${onboarding.lastChecked?.kitDigest}; xezar ${onboarding.observed.engineVersion} and templates ${onboarding.observed.kitDigest} are running now.${onboarding.offerPending ? ' The offer for this pair has not been made yet.' : ''}`;
    case 'unknown':
      return 'Setup: this project\'s setup history could not be read, so nothing is known about what was checked.';
    default:
      return 'Setup: no finished check has been recorded for this project.';
  }
}

/** Whether issue filing works here (#468), as a fact — like the setup line, it asks for nothing. */
function issueFilingLine(issueFiling: OnboardingStatus['issueFiling']): string {
  if (issueFiling.status === 'available' || !issueFiling.reason) {
    return `Issue filing: available (skill ${issueFiling.skill}).`;
  }
  return `Issue filing: ${issueFiling.reason.charAt(0).toLowerCase()}${issueFiling.reason.slice(1)}`;
}

export const discoverProjectTool = defineTool({
  name: 'discover_project',
  title: 'Discover the bound project',
  description:
    'Read which xezar project this session is bound to, its effective capabilities and limits, and which actions are available. Every action that is unavailable or read-only says why. The answer also carries the project setup block: which identity is running, which was offered, which a finished check actually covered, whether setup can run here at all, the launch definition to name when dispatching one, and whether issue filing works here (the skill to select, or why not). Reading it changes nothing and authorises nothing. Call it at the start of a session and again after a person changes settings. It takes no arguments: the project comes from the connection, never from a parameter. A project leader works through these tools only, never the cockpit UI and never the HTTP API. Whether this session is attached as leader is not part of this answer: call leader_events with action status.',
  inputSchema: z.strictObject({}),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async call(_args, ctx: DiscoveryContext) {
    const discovery = buildDiscovery(await collectDiscoveryFacts(ctx));
    return textResult(discoveryText(discovery), discovery);
  },
});
