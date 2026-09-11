import { z } from 'zod';
import { capabilitiesSchema, runnerSchema } from './health.ts';
import { providerConnectionStateSchema } from './workspace.ts';

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
});
export type McpDiscovery = z.infer<typeof mcpDiscoverySchema>;
