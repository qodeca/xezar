import { z } from 'zod';

/**
 * The frozen answer shape for agent plan quota (#867 S1).
 *
 * It is shared by `GET /api/v1/workspace/agent-quota` and the `project_config` actions
 * `read_quota` / `check_quota`. These objects deliberately remain non-strict: consumers must
 * ignore unknown keys so a later release can add facts without breaking an older reader. The
 * committed fixture in `__fixtures__/agent-quota.expected.json` pins the known keys and their
 * canonical order byte-for-byte.
 */

export const agentQuotaRunnerSchema = z.enum(['claude', 'codex']);
export type AgentQuotaRunner = z.infer<typeof agentQuotaRunnerSchema>;

export const agentQuotaStatusSchema = z.enum(['ok', 'out', 'unknown']);
export type AgentQuotaStatus = z.infer<typeof agentQuotaStatusSchema>;

export const agentQuotaSourceSchema = z.enum(['live', 'failedRun', 'check']);
export type AgentQuotaSource = z.infer<typeof agentQuotaSourceSchema>;

const isoTimestampSchema = z.string().datetime({ offset: true });
const utcTimestampSchema = isoTimestampSchema.regex(/Z$/, 'must be an ISO 8601 UTC timestamp');
const usedPercentSchema = z.number().min(0).max(100);

export const agentQuotaWindowSchema = z.object({
  usedPercent: usedPercentSchema,
  resetsAt: utcTimestampSchema,
  windowMinutes: z.number().int().positive(),
});
export type AgentQuotaWindow = z.infer<typeof agentQuotaWindowSchema>;

export const agentQuotaModelWindowSchema = z.object({
  model: z.string().min(1),
  usedPercent: usedPercentSchema,
  resetsAt: utcTimestampSchema,
  windowMinutes: z.number().int().positive(),
});
export type AgentQuotaModelWindow = z.infer<typeof agentQuotaModelWindowSchema>;

/** Codex's `credits` object. Claude rows use `null` and name `credits` in `notReported`. */
export const agentQuotaCreditsSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
  balance: z.string(),
});
export type AgentQuotaCredits = z.infer<typeof agentQuotaCreditsSchema>;

export const agentQuotaNotReportedFieldSchema = z.enum([
  'shortWindow',
  'weeklyWindow',
  'modelWindows',
  'credits',
  'planType',
]);
export type AgentQuotaNotReportedField = z.infer<typeof agentQuotaNotReportedFieldSchema>;

const agentQuotaAccountDetailShape = {
  checkedAt: isoTimestampSchema,
  ageSeconds: z.number().int().nonnegative(),
  source: agentQuotaSourceSchema,
  shortWindow: agentQuotaWindowSchema.nullable(),
  weeklyWindow: agentQuotaWindowSchema.nullable(),
  modelWindows: z.array(agentQuotaModelWindowSchema).nullable(),
  credits: agentQuotaCreditsSchema.nullable(),
  planType: z.string().min(1).nullable(),
  notReported: z
    .array(agentQuotaNotReportedFieldSchema)
    .refine((fields) => new Set(fields).size === fields.length, { message: 'must not contain duplicates' }),
} as const;

export const agentQuotaAccountSchema = z
  .discriminatedUnion('status', [
    z.object({
      runner: agentQuotaRunnerSchema,
      accountId: z.string().min(1).max(64),
      status: z.literal('ok'),
      resetsAt: z.never().optional(),
      ...agentQuotaAccountDetailShape,
    }),
    z.object({
      runner: agentQuotaRunnerSchema,
      accountId: z.string().min(1).max(64),
      status: z.literal('unknown'),
      resetsAt: z.never().optional(),
      ...agentQuotaAccountDetailShape,
    }),
    z.object({
      runner: agentQuotaRunnerSchema,
      accountId: z.string().min(1).max(64),
      status: z.literal('out'),
      resetsAt: utcTimestampSchema,
      ...agentQuotaAccountDetailShape,
    }),
  ])
  .superRefine((account, ctx) => {
    for (const field of agentQuotaNotReportedFieldSchema.options) {
      const listed = account.notReported.includes(field);
      const missing = account[field] === null;
      if (missing !== listed) {
        ctx.addIssue({
          code: 'custom',
          path: ['notReported'],
          message: `${field} must be listed exactly when its value is null`,
        });
      }
    }
  });
export type AgentQuotaAccount = z.infer<typeof agentQuotaAccountSchema>;

export const agentQuotaResponseSchema = z.object({
  generatedAt: isoTimestampSchema,
  accounts: z.array(agentQuotaAccountSchema),
});
export type AgentQuotaResponse = z.infer<typeof agentQuotaResponseSchema>;

const projectConfigQuotaSelectorShape = {
  provider: agentQuotaRunnerSchema.optional(),
  accountId: z.string().min(1).max(64).optional(),
} as const;

/** Request slices to be composed into `project_config` when the runtime actions land (#867 S1). */
export const projectConfigReadQuotaInputSchema = z.strictObject({
  action: z.literal('read_quota'),
  ...projectConfigQuotaSelectorShape,
});
export type ProjectConfigReadQuotaInput = z.infer<typeof projectConfigReadQuotaInputSchema>;

export const projectConfigCheckQuotaInputSchema = z.strictObject({
  action: z.literal('check_quota'),
  ...projectConfigQuotaSelectorShape,
});
export type ProjectConfigCheckQuotaInput = z.infer<typeof projectConfigCheckQuotaInputSchema>;

export const projectConfigQuotaInputSchema = z.discriminatedUnion('action', [
  projectConfigReadQuotaInputSchema,
  projectConfigCheckQuotaInputSchema,
]);
export type ProjectConfigQuotaInput = z.infer<typeof projectConfigQuotaInputSchema>;

/** The MCP envelope carries the same answer as HTTP in `result`, without a second quota shape. */
export const projectConfigReadQuotaResponseSchema = z.object({
  action: z.literal('read_quota'),
  origin: z.literal('mcp'),
  result: agentQuotaResponseSchema,
});
export type ProjectConfigReadQuotaResponse = z.infer<typeof projectConfigReadQuotaResponseSchema>;

export const projectConfigCheckQuotaResponseSchema = z.object({
  action: z.literal('check_quota'),
  origin: z.literal('mcp'),
  result: agentQuotaResponseSchema,
});
export type ProjectConfigCheckQuotaResponse = z.infer<typeof projectConfigCheckQuotaResponseSchema>;

export const projectConfigQuotaResponseSchema = z.discriminatedUnion('action', [
  projectConfigReadQuotaResponseSchema,
  projectConfigCheckQuotaResponseSchema,
]);
export type ProjectConfigQuotaResponse = z.infer<typeof projectConfigQuotaResponseSchema>;
