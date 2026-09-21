import { z } from 'zod';
import { agentAccountProblemSchema, agentAccountsGlobalImportSchema } from './agent-profiles.ts';
import { capabilitiesSchema, runnerSchema } from './health.ts';
import { onboardingStatusSchema } from './onboarding.ts';
import { providerConnectionStateSchema, providerIdSchema } from './workspace.ts';

/**
 * The MCP discovery result (#90, F-03, U-M06): what a project-bound leader may learn about the
 * project it is bound to — its identity, its effective capabilities and limits, and which actions
 * it can take, each unavailable one with a reason a person can act on.
 *
 * A FILTERED projection, never a pass-through. It is derived from the same facts `GET /health`
 * and `GET /config` report, but `healthResponseSchema` also carries `projects` (every registered
 * project) and `bootProject` (another project's id), and N-01 forbids revealing another project's
 * name or existence. So this is its own schema rather than a widened or re-exported health shape,
 * and every object in it is STRICT: a key the builder did not mean to send fails the parse
 * instead of riding along to the model.
 *
 * Deliberately absent, per F-12/F-15 and the D-03 classification: account identity (email, login,
 * organisation, plan, profile id), the git remote URL (it can embed a credential), install paths,
 * raw CLI output, and every other project's limits or activity.
 */

/** The closed set of action areas discovery reports on. */
export const mcpDiscoveryActionIdSchema = z.enum([
  'create_task',
  'parallel_variants',
  'worktree_choice',
  'model_selection',
  'github',
  'automations',
  'inbox',
  'open_in_app',
  'agent_config_write',
  'workspace_limits',
]);
export type McpDiscoveryActionId = z.infer<typeof mcpDiscoveryActionIdSchema>;

/**
 * U-M06: a usable project function, an unavailable dependency, or a read-only shared constraint.
 * Only `available` may omit the reason — an action that cannot be taken always says why.
 */
export const mcpDiscoveryActionSchema = z.discriminatedUnion('status', [
  z.strictObject({ id: mcpDiscoveryActionIdSchema, label: z.string(), status: z.literal('available') }),
  z.strictObject({
    id: mcpDiscoveryActionIdSchema,
    label: z.string(),
    status: z.literal('unavailable'),
    reason: z.string().min(1),
  }),
  z.strictObject({
    id: mcpDiscoveryActionIdSchema,
    label: z.string(),
    status: z.literal('read-only'),
    reason: z.string().min(1),
  }),
]);
export type McpDiscoveryAction = z.infer<typeof mcpDiscoveryActionSchema>;

/** One coding agent: installed on this host, enabled, signed in — never WHO it is signed in as. */
export const mcpDiscoveryAgentSchema = z.strictObject({
  runner: runnerSchema,
  installed: z.boolean(),
  version: z.string().optional(),
  enabled: z.boolean(),
  signIn: providerConnectionStateSchema,
  usable: z.boolean(),
  reason: z.string().optional(),
});
export type McpDiscoveryAgent = z.infer<typeof mcpDiscoveryAgentSchema>;

export const mcpDiscoveryToolCheckSchema = z.strictObject({
  name: z.enum(['gh', 'git']),
  available: z.boolean(),
  reason: z.string().optional(),
});
export type McpDiscoveryToolCheck = z.infer<typeof mcpDiscoveryToolCheckSchema>;

/**
 * Effective limits. Workspace values are shared with every project and read-only here (D-03
 * `safe-effective-read`); `project` is this project's own override, `null` when it inherits.
 * Other projects' overrides and occupancy are never included.
 */
export const mcpDiscoveryLimitsSchema = z.strictObject({
  maxParallel: z.strictObject({ effective: z.number(), project: z.number().nullable(), workspace: z.number() }),
  memoryLimitMb: z.strictObject({
    effective: z.number().nullable(),
    project: z.number().nullable(),
    workspace: z.number().nullable(),
  }),
  maxMonitoringSessions: z.number(),
  /** `null` means a parked session stays parked. */
  monitoringWakeIntervalMinutes: z.number().nullable(),
  autoResumeOnUsageLimit: z.boolean(),
  /** `null` means an idle session is never closed. */
  idleTimeoutMinutes: z.number().nullable(),
  /** This project's count of finished worktrees kept on disk; 0 keeps all. */
  worktreeRetention: z.number(),
});
export type McpDiscoveryLimits = z.infer<typeof mcpDiscoveryLimitsSchema>;

/**
 * `discover_project.onboarding`: the cockpit's own setup state (`onboardingStatusSchema`, the same
 * shape `GET /onboarding` serves) plus one MCP-only key (#819 PR 5, item 1d).
 *
 * `globalImport` is whether this project took the agent accounts of the person's machine-wide setup
 * and how many it still could — the SAME value the Agent accounts listing serves
 * (`agentAccountsGlobalImportSchema`, read by one helper, `globalImportSummary`). A state and a
 * COUNT, never a name, id, label, provider handle or path. PRESENT only in single-project mode on
 * the host; absent in the global layout (nothing to import into) and in hosted mode. Absent is
 * never "unknown". It is added here rather than to `onboardingStatusSchema` so that
 * `GET /onboarding` does not change, and it is never on `/api/v1/health`.
 */
export const mcpDiscoveryOnboardingSchema = onboardingStatusSchema.extend({
  globalImport: agentAccountsGlobalImportSchema.optional(),
});
export type McpDiscoveryOnboarding = z.infer<typeof mcpDiscoveryOnboardingSchema>;

/**
 * `discover_project.cockpit` (#819 item 8): where the PERSON opens this project's cockpit, so a
 * leader can hand them a link instead of a page name to hunt for. The leader itself never opens it
 * (#439): it works through the MCP tools only.
 *
 * Every URL is the running server's REAL listen origin — read from its listening socket after the
 * bind, never from a requested port. The whole block is ABSENT when that is unknown (before the
 * listen, or in hosted mode, where the public address behind a reverse proxy is not this process's
 * to know): a confidently wrong URL is worse than none. Served through the MCP only, and never on
 * `GET /api/v1/health` (owner, 2026-09-21), whose answer any web page can read.
 */
export const mcpDiscoveryCockpitSchema = z.strictObject({
  /** This project's own page: `<origin>/p/<projectId>/`. */
  url: z.string(),
  pages: z.strictObject({
    /** Where a person turns an agent tool on or off and signs it in. */
    providers: z.string(),
    /** Where a person manages the agent accounts. */
    accounts: z.string(),
    /** Where a person attaches or checks the leader connection. */
    mcpConnection: z.string(),
  }),
});
export type McpDiscoveryCockpit = z.infer<typeof mcpDiscoveryCockpitSchema>;

export const mcpDiscoverySchema = z.strictObject({
  project: z.strictObject({
    id: z.string(),
    name: z.string(),
    /** The bound project's own root; trimmed to its basename in hosted mode, like `/health`. */
    root: z.string(),
  }),
  xezarVersion: z.string(),
  repository: z.strictObject({ git: z.boolean(), branch: z.string().optional() }),
  settings: z.strictObject({
    defaultRunner: runnerSchema,
    baseBranch: z.string().nullable(),
    modelsLocked: z.boolean(),
  }),
  capabilities: capabilitiesSchema.pick({ localHandoff: true, followups: true, automations: true }).strict(),
  agents: z.array(mcpDiscoveryAgentSchema),
  tools: z.array(mcpDiscoveryToolCheckSchema),
  limits: mcpDiscoveryLimitsSchema,
  actions: z.array(mcpDiscoveryActionSchema),
  /**
   * This project's setup state (#464 P2) — the same derivation the cockpit's Settings → Project
   * setup section reads, so a leader and a person cannot be told different things about whether a
   * check ever happened.
   *
   * It is a READ. Nothing here authorises a run: `state: "changed"` with `lastOffered` absent is a
   * pending offer, and dispatching a check is a separate, deliberate `task_create` naming
   * `launch.workflowId`.
   */
  onboarding: mcpDiscoveryOnboardingSchema,
  /** Where the person opens this cockpit — ABSENT when the real address is unknown (additive, #819). */
  cockpit: mcpDiscoveryCockpitSchema.optional(),
});
export type McpDiscovery = z.infer<typeof mcpDiscoverySchema>;

/**
 * `project_config` `get_account` (#819 PR 5, items 2 and 3) — which agent account THIS project's
 * tasks run under, every account the machine has, and every stored choice that names no account.
 *
 * STRICT at every level, and that is the redaction guarantee rather than tidiness: an account row
 * has no `configDir`, `path` or identity field, so a builder that forwards one fails the parse
 * instead of handing a leader a folder on the person's machine. A label that looks like an identity
 * (it contains `@`) is withheld by the builder, not here: the schema cannot tell a label from an
 * address, and withheld means ABSENT, which `label` being optional allows.
 */

/** One account, as the leader addresses it: `handle` is what `select_account` takes. */
export const mcpAccountRowSchema = z.strictObject({
  provider: providerIdSchema,
  /** The account's id. `default` is the login the agent finds on this machine by itself. */
  handle: z.string(),
  /** Its display label; ABSENT when there is none or it looks like an identity. */
  label: z.string().optional(),
  /** True on the login the agent finds by itself (never stored, never removable), false otherwise. */
  builtIn: z.boolean(),
});
export type McpAccountRow = z.infer<typeof mcpAccountRowSchema>;

/** One entry of `profiles`: every account per provider, the built-in login first. */
export const mcpAccountProfileSchema = mcpAccountRowSchema.extend({
  /** True on exactly one row per provider — the account a task in this project runs under. */
  selected: z.boolean(),
});
export type McpAccountProfile = z.infer<typeof mcpAccountProfileSchema>;

/**
 * A stored choice that names no account — the listing's own `agentAccountProblemSchema` entry,
 * with the stored `handle` kept as written so the reader can recognise its own case, plus the one
 * line that says what to do about it. Advisory: tasks still run, on the built-in login.
 */
export const mcpAccountProblemSchema = agentAccountProblemSchema.extend({ fix: z.string().min(1) }).strict();
export type McpAccountProblem = z.infer<typeof mcpAccountProblemSchema>;

export const mcpAccountsSchema = z.discriminatedUnion('available', [
  z.strictObject({ available: z.literal(false), reason: z.string().min(1) }),
  z.strictObject({
    available: z.literal(true),
    /** One row per provider: the account a task here runs under. Unchanged since 0.16.0 except for
     *  the additive `builtIn`; a dangling stored choice reads as `default`, the login a run uses. */
    accounts: z.array(mcpAccountRowSchema),
    /** Every account per provider, `selected: true` on the one `accounts` names (additive, #819). */
    profiles: z.array(mcpAccountProfileSchema),
    /** Stored choices that name no account: the machine-wide default and THIS project's selection
     *  only — another project's choices are not this project's facts. `[]` when there are none. */
    problems: z.array(mcpAccountProblemSchema),
    /** As on the listing: present only in single-project mode on the host. */
    globalImport: agentAccountsGlobalImportSchema.optional(),
  }),
]);
export type McpAccounts = z.infer<typeof mcpAccountsSchema>;
