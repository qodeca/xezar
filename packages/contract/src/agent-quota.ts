import { z } from 'zod';

/**
 * The consumer answer shape for agent plan quota (#867 S1).
 *
 * It is shared by `GET /api/v1/workspace/agent-quota` and the `project_config` actions
 * `read_quota` / `check_quota`. These objects deliberately remain non-strict: consumers must
 * ignore unknown keys, unknown `notReported` names, and unknown non-empty `source`, `loginKind` or
 * `statusReason` values so a later release can add facts without breaking an older reader. A
 * reader that meets an unknown `source` or `statusReason` still acts only on `status`, and
 * `unknown` never means budget; a `loginKind` other than `subscription` is never a subscription. Producers validate with `agentQuotaProducerResponseSchema`; the
 * committed fixture in `__fixtures__/agent-quota.expected.json` pins its known keys and canonical
 * order byte-for-byte. A Claude account is never `status: "ok"` when any reported window
 * (`shortWindow`, `weeklyWindow`, or `modelWindows[]`) has `usedPercent` greater than or equal to
 * 100. Codex status follows its explicit availability signals, not percentages alone (#867 FR-5).
 */

export const agentQuotaRunnerSchema = z.enum(['claude', 'codex']);
export type AgentQuotaRunner = z.infer<typeof agentQuotaRunnerSchema>;

export const agentQuotaStatusSchema = z.enum(['ok', 'out', 'unknown']);
export type AgentQuotaStatus = z.infer<typeof agentQuotaStatusSchema>;

export const agentQuotaSourceSchema = z.enum(['live', 'failedRun', 'check', 'check-text', 'none']);
export type AgentQuotaSource = z.infer<typeof agentQuotaSourceSchema>;

export const agentQuotaCheckReasonSchema = z.enum([
  'check-failed',
  'format-changed',
  'version-too-old',
  'not-installed',
  'api-key',
]);
export type AgentQuotaCheckReason = z.infer<typeof agentQuotaCheckReasonSchema>;

/**
 * What kind of login a row is (#867 AC-36, D38), read from the login's own credentials as the
 * tool reports them — never from plan facts such as `planType` or a window. `unknown` is a
 * first-class answer ("could not tell") and is never read as `subscription`.
 */
export const agentQuotaLoginKindSchema = z.enum(['subscription', 'api-key', 'unknown']);
export type AgentQuotaLoginKind = z.infer<typeof agentQuotaLoginKindSchema>;

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

const agentQuotaConsumerAccountDetailShape = {
  loginKind: z.string().min(1),
  observedAt: isoTimestampSchema,
  ageSeconds: z.number().int().nonnegative(),
  source: z.string().min(1),
  shortWindow: agentQuotaWindowSchema.nullable(),
  weeklyWindow: agentQuotaWindowSchema.nullable(),
  modelWindows: z.array(agentQuotaModelWindowSchema).nullable(),
  credits: agentQuotaCreditsSchema.nullable(),
  planType: z.string().min(1).nullable(),
  notReported: z
    .array(z.string().min(1))
    .refine((fields) => new Set(fields).size === fields.length, { message: 'must not contain duplicates' }),
  stale: z.boolean().optional(),
  refreshing: z.boolean().optional(),
  nextCheckAt: isoTimestampSchema.nullable().optional(),
  toolVersion: z.string().min(1).nullable().optional(),
  minimumVersion: z.string().min(1).optional(),
  statusReason: z.string().min(1).nullable().optional(),
  warnings: z.array(z.string().min(1)).optional(),
  unavailableReason: z.string().min(1).nullable().optional(),
} as const;

const agentQuotaProducerAccountDetailShape = {
  loginKind: agentQuotaLoginKindSchema,
  observedAt: isoTimestampSchema,
  ageSeconds: z.number().int().nonnegative(),
  source: agentQuotaSourceSchema,
  shortWindow: agentQuotaWindowSchema.strict().nullable(),
  weeklyWindow: agentQuotaWindowSchema.strict().nullable(),
  modelWindows: z.array(agentQuotaModelWindowSchema.strict()).nullable(),
  credits: agentQuotaCreditsSchema.strict().nullable(),
  planType: z.string().min(1).nullable(),
  notReported: z
    .array(agentQuotaNotReportedFieldSchema)
    .refine((fields) => new Set(fields).size === fields.length, { message: 'must not contain duplicates' }),
  stale: z.boolean().optional(),
  refreshing: z.boolean().optional(),
  nextCheckAt: isoTimestampSchema.nullable().optional(),
  toolVersion: z.string().min(1).nullable().optional(),
  minimumVersion: z.string().min(1).optional(),
  statusReason: agentQuotaCheckReasonSchema.nullable().optional(),
  warnings: z.array(z.string().min(1)).optional(),
  unavailableReason: z.string().min(1).nullable().optional(),
} as const;

type KnownQuotaFacts = {
  shortWindow: unknown | null;
  weeklyWindow: unknown | null;
  modelWindows: unknown | null;
  credits: unknown | null;
  planType: unknown | null;
  notReported: string[];
};

function refineKnownNotReportedFields(account: KnownQuotaFacts, ctx: z.RefinementCtx): void {
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
}

/** Tolerant reader schema: additive account keys and `notReported` names remain compatible. */
export const agentQuotaAccountSchema = z
  .discriminatedUnion('status', [
    z.object({
      runner: agentQuotaRunnerSchema,
      accountId: z.string().min(1).max(64),
      status: z.literal('ok'),
      resetsAt: z.never().optional(),
      ...agentQuotaConsumerAccountDetailShape,
    }),
    z.object({
      runner: agentQuotaRunnerSchema,
      accountId: z.string().min(1).max(64),
      status: z.literal('unknown'),
      resetsAt: z.never().optional(),
      ...agentQuotaConsumerAccountDetailShape,
    }),
    z.object({
      runner: agentQuotaRunnerSchema,
      accountId: z.string().min(1).max(64),
      status: z.literal('out'),
      resetsAt: utcTimestampSchema,
      ...agentQuotaConsumerAccountDetailShape,
    }),
  ])
  .superRefine(refineKnownNotReportedFields);
export type AgentQuotaAccount = z.infer<typeof agentQuotaAccountSchema>;

/** Strict writer/fixture schema: producers may emit only the currently frozen keys and names. */
export const agentQuotaProducerAccountSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      runner: agentQuotaRunnerSchema,
      accountId: z.string().min(1).max(64),
      status: z.literal('ok'),
      resetsAt: z.never().optional(),
      ...agentQuotaProducerAccountDetailShape,
    }),
    z.strictObject({
      runner: agentQuotaRunnerSchema,
      accountId: z.string().min(1).max(64),
      status: z.literal('unknown'),
      resetsAt: z.never().optional(),
      ...agentQuotaProducerAccountDetailShape,
    }),
    z.strictObject({
      runner: agentQuotaRunnerSchema,
      accountId: z.string().min(1).max(64),
      status: z.literal('out'),
      resetsAt: utcTimestampSchema,
      ...agentQuotaProducerAccountDetailShape,
    }),
  ])
  .superRefine(refineKnownNotReportedFields);
export type AgentQuotaProducerAccount = z.infer<typeof agentQuotaProducerAccountSchema>;

type QuotaResponseForStatusRefinement = {
  accounts: Array<{
    runner: AgentQuotaRunner;
    status: AgentQuotaStatus;
    shortWindow: AgentQuotaWindow | null;
    weeklyWindow: AgentQuotaWindow | null;
    modelWindows: AgentQuotaModelWindow[] | null;
  }>;
};

function refineOkAccountWindows(response: QuotaResponseForStatusRefinement, ctx: z.RefinementCtx): void {
  response.accounts.forEach((account, accountIndex) => {
    if (account.runner !== 'claude' || account.status !== 'ok') return;

    const windows = [account.shortWindow, account.weeklyWindow, ...(account.modelWindows ?? [])];
    if (windows.some((window) => window !== null && window.usedPercent >= 100)) {
      ctx.addIssue({
        code: 'custom',
        path: ['accounts', accountIndex, 'status'],
        message: 'Claude must not be ok when any reported window has usedPercent greater than or equal to 100',
      });
    }
  });
}

/** Exported reader schema. Unknown object keys are stripped and unknown fact names are accepted. */
export const agentQuotaResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: z.literal('agent-quota'),
    generatedAt: isoTimestampSchema,
    accounts: z.array(agentQuotaAccountSchema),
  })
  .superRefine(refineOkAccountWindows);
export type AgentQuotaResponse = z.infer<typeof agentQuotaResponseSchema>;

/** Strict schema for producer output and the committed fixture. */
export const agentQuotaProducerResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    scope: z.literal('agent-quota'),
    generatedAt: isoTimestampSchema,
    accounts: z.array(agentQuotaProducerAccountSchema),
  })
  .superRefine(refineOkAccountWindows);
export type AgentQuotaProducerResponse = z.infer<typeof agentQuotaProducerResponseSchema>;

const projectConfigQuotaSelectorShape = {
  provider: agentQuotaRunnerSchema.optional(),
  accountId: z.string().min(1).max(64).optional(),
} as const;

const quotaWaitQuerySchema = z
  .union([z.string(), z.array(z.string()).transform((values) => values[0] as string)])
  .optional();

/** Query accepted by the workspace quota read route. `wait=true` is the documented waiting form. */
export const agentQuotaQuerySchema = z.strictObject({
  ...projectConfigQuotaSelectorShape,
  wait: quotaWaitQuerySchema,
});
export type AgentQuotaQuery = z.infer<typeof agentQuotaQuerySchema>;

/** Body accepted by the explicit workspace quota refresh route. */
export const agentQuotaRefreshInputSchema = z.strictObject(projectConfigQuotaSelectorShape);
export type AgentQuotaRefreshInput = z.infer<typeof agentQuotaRefreshInputSchema>;

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
