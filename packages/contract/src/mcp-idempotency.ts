import { z } from 'zod';

/**
 * Durable operation identity for MCP mutations (issue #101, decision D-06 —
 * `docs/features/mcp-server/mcp-d06-versioning-idempotency-audit-decision.md`).
 *
 * Every mutating MCP tool takes a client-generated `operationId`. The server keys a receipt on
 * `<projectId>/<operationId>` — the project half comes from the trusted connection binding, never
 * from a tool argument — and verifies the stored `action` and payload digest on every retry. The
 * JSON-RPC request id is deliberately NOT this identity: it correlates one request with one
 * response and does not survive a reconnect (D-06 § 5.1).
 *
 * These are wire shapes only. How a receipt is stored lives in the service
 * (`packages/xezar/src/mcp/operation-receipts.ts`); nothing here is persisted as-is.
 */

/**
 * The operation id a client supplies (D-06 § 5.2). Opaque: a UUIDv4 is the expected shape, but the
 * server neither requires nor parses one. 8–128 characters from a closed alphabet — the bounds are
 * shape bounds only (a technical proposal in D-06 § 1.1), and the alphabet keeps `/` out so the
 * stored `<projectId>/<operationId>` key splits unambiguously.
 */
export const operationIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
export type OperationId = z.infer<typeof operationIdSchema>;

/**
 * A stored, settled outcome (D-06 § 9.2). `in-progress` is deliberately absent: it is derived from
 * liveness at lookup time and is never written down.
 *
 * - `ok` — the effect happened and the result is recorded.
 * - `rejected` — refused before any effect (validation, `stale_version`, permission).
 * - `not-applied` — reconciliation ESTABLISHED that the effect did not happen.
 * - `unverified` — the effect may have happened; nothing has established which. Never retried.
 */
export const operationOutcomeSchema = z.enum(['ok', 'rejected', 'not-applied', 'unverified']);
export type OperationOutcome = z.infer<typeof operationOutcomeSchema>;

/** What a settled `ok` operation produced — a reference, never content (D-06 § 7.1, § 10.3). */
export const operationResultRefSchema = z.object({
  kind: z.string().min(1).max(64),
  id: z.string().min(1).max(256),
});
export type OperationResultRef = z.infer<typeof operationResultRefSchema>;

/**
 * A short machine-readable reason or error code. Never a raw error body: output from `gh` or `git`
 * can carry a token or a path (D-06 § 9.3, § 10.3), so the alphabet admits no `/`, `=` or quote
 * and the length is capped.
 */
export const operationReasonSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_ -]+$/);
export type OperationReason = z.infer<typeof operationReasonSchema>;

/**
 * The read a reconciler performs to answer "did this effect happen?" (D-06 § 9.3). Recorded in the
 * `intent` line BEFORE the effect, because after a crash nothing else can rebuild it.
 */
export const reconcilePredicateSchema = z.discriminatedUnion('kind', [
  /** The run id predicted from the operation key before the effect (D-06 § 12.1). */
  z.object({ kind: z.literal('run-by-key'), predictedRunId: z.uuid() }),
  /** A forge list/search read, e.g. `gh pr list --head <branch>`. */
  z.object({
    kind: z.literal('forge-search'),
    repository: z.string().min(1),
    headBranch: z.string().min(1),
  }),
  /** The expected ref and the sha it should point at after the effect. */
  z.object({ kind: z.literal('git-state'), ref: z.string().min(1), sha: z.string().min(1) }),
  /** The action has no external effect to look for. */
  z.object({ kind: z.literal('none') }),
]);
export type ReconcilePredicate = z.infer<typeof reconcilePredicateSchema>;
export type ReconcileKind = ReconcilePredicate['kind'];

/** Guidance a client gets with every `unverified` answer (D-06 § 9.3 rule 5). */
export const UNVERIFIED_GUIDANCE = 'read current state; a new operationId is a new action' as const;

/** A settled operation — a first attempt that finished, or a retry replaying the stored outcome. */
export const operationSettledResultSchema = z.object({
  status: z.enum(['ok', 'rejected', 'not-applied']),
  operationId: operationIdSchema,
  action: z.string().min(1),
  /** `true` when this answer came from a stored receipt and no effect ran for this call. */
  replayed: z.boolean(),
  /** Present on `ok` only. */
  resultRef: operationResultRefSchema.optional(),
  /** Present on `rejected` and `not-applied` only. */
  errorCode: operationReasonSchema.optional(),
});
export type OperationSettledResult = z.infer<typeof operationSettledResultSchema>;

/**
 * A duplicate that arrived while the first attempt is still live in this process (D-06 § 6). Not
 * uncertain: the server knows the operation is running and will settle it.
 */
export const operationInProgressResultSchema = z.object({
  status: z.literal('in-progress'),
  operationId: operationIdSchema,
  action: z.string().min(1),
  startedAt: z.string(),
});
export type OperationInProgressResult = z.infer<typeof operationInProgressResultSchema>;

/**
 * The effect may have happened and nothing has established which (D-06 § 9.3). No effect ran for
 * this call, and none will run for any retry of the same `operationId`.
 */
export const operationUnverifiedResultSchema = z.object({
  status: z.literal('unverified'),
  operationId: operationIdSchema,
  action: z.string().min(1),
  startedAt: z.string(),
  reconcile: z.object({
    kind: z.enum(['run-by-key', 'forge-search', 'git-state', 'none']),
    attemptedAt: z.string().optional(),
    reason: operationReasonSchema,
  }),
  guidance: z.literal(UNVERIFIED_GUIDANCE),
});
export type OperationUnverifiedResult = z.infer<typeof operationUnverifiedResultSchema>;

/**
 * The same `operationId` arrived with a different action or payload (D-06 § 6). No effect ran, and
 * the stored operation's result is deliberately NOT returned — handing back another intention's
 * result would be wrong and a small information leak. `mismatch` says which half disagreed.
 */
export const operationKeyConflictSchema = z.object({
  error: z.literal('operation_key_conflict'),
  operationId: operationIdSchema,
  storedAction: z.string().min(1),
  storedAt: z.string(),
  mismatch: z.enum(['action', 'payload']),
});
export type OperationKeyConflict = z.infer<typeof operationKeyConflictSchema>;

/**
 * The receipt journal cannot be written (read-only repository, full disk), so the operation cannot
 * be made idempotent and is refused BEFORE its effect (D-06 § 7.5).
 */
export const operationReceiptUnavailableSchema = z.object({
  error: z.literal('operation_receipt_unavailable'),
  operationId: operationIdSchema,
  reason: z.literal('journal_unwritable'),
});
export type OperationReceiptUnavailable = z.infer<typeof operationReceiptUnavailableSchema>;

/** Every answer the operation-receipt layer gives a mutating MCP tool. */
export const operationAnswerSchema = z.union([
  operationSettledResultSchema,
  operationInProgressResultSchema,
  operationUnverifiedResultSchema,
  operationKeyConflictSchema,
  operationReceiptUnavailableSchema,
]);
export type OperationAnswer = z.infer<typeof operationAnswerSchema>;
