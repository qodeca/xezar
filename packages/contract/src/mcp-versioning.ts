import { z } from 'zod';

/**
 * Stale-write rejection for MCP leader mutations (#100, N-03) — the wire half of the version check
 * decided by D-06 (`docs/features/mcp-server/mcp-d06-versioning-idempotency-audit-decision.md`
 * § 4). The computing half, and the compare-and-swap itself, live in
 * `packages/xezar/src/mcp/stale-write.ts`.
 *
 * Every read a mutation can be based on returns a `version`; every mutating tool echoes it back as
 * `expectedVersion`; the server compares it against the resource's CURRENT token before any effect.
 * The token is OPAQUE (§ 4.2): a client echoes it verbatim and never parses, orders or builds one.
 * That is why the schema below is a bounded string and not a pattern — an unparseable or unknown-tag
 * token is not a validation error, it is a stale token (§ 4.4 rule 5), and only the server may say so.
 *
 * U-M05 asks for two outcomes that must never be confused, so they are two shapes:
 *  - `staleVersionRejectionSchema` — refused BEFORE any effect, nothing applied, re-read and decide
 *    again;
 *  - `executionFailedSchema` — the check PASSED and the effect RAN and failed, so the state may
 *    have moved; re-read, and never repeat it blindly.
 * `status` carries D-05's wording for the tool-result status (`conflict`, `failed`, `done`), and the
 * rejection's payload keys are D-06 § 4.4's, verbatim.
 */

/** The format tag every token this server mints starts with (D-06 § 4.2). A future shape is `rev2`. */
export const MCP_VERSION_TOKEN_TAG = 'rev1';

/**
 * A version token, as a read hands it out and a mutation echoes it back. Opaque — see above.
 *
 * The 512-character ceiling is a shape bound only, like D-06's 8–128 on `operationId`: a real token
 * is `rev1:` + kind + id + seq + 12 hex characters, well under a tenth of it, and nothing depends on
 * the exact number. It keeps an arbitrary blob out of every comparison and every log line.
 */
export const mcpVersionTokenSchema = z.string().min(1).max(512);
export type McpVersionToken = z.infer<typeof mcpVersionTokenSchema>;

/**
 * The `expectedVersion` argument every mutating tool REQUIRES. Required rather than optional on
 * purpose (D-06 § 4.4 rule 4, the populated-input guarantee): "no token supplied" and "token
 * matches" must never reach the same branch, so a missing one is refused at the validation boundary.
 */
export const mcpExpectedVersionSchema = mcpVersionTokenSchema;
export type McpExpectedVersion = z.input<typeof mcpExpectedVersionSchema>;

/**
 * A resource kind: `run`, `group`, `config`, `workflow`, `automation`, `worktree`, … (D-06 § 4.2
 * leaves the list open). A lowercase slug, because it is one `:`-separated part of the token.
 */
export const mcpVersionedResourceKindSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9-]*$/);
export type McpVersionedResourceKind = z.infer<typeof mcpVersionedResourceKindSchema>;

/** Which resource a version belongs to — an id inside the bound project, never a path or content. */
export const mcpVersionedResourceRefSchema = z.object({
  kind: mcpVersionedResourceKindSchema,
  id: z.string().min(1),
});
export type McpVersionedResourceRef = z.infer<typeof mcpVersionedResourceRefSchema>;

/** What a rejection tells the leader to do next. N-03: read current state before deciding again. */
export const MCP_STALE_VERSION_GUIDANCE =
  'Not applied: this changed after you read it. Read the current state and decide again; a new decision is a new operation.';

/** What a failure after execution tells the leader. The effect ran, so repeating it is not safe. */
export const MCP_EXECUTION_FAILED_GUIDANCE =
  'Attempted and failed: the change ran and did not complete, so part of it may have applied. Read the current state before deciding again; do not repeat it blindly.';

/**
 * Outcome one — REJECTED, NOTHING APPLIED (D-06 § 4.4). The state is byte-identical to what it was
 * before the call.
 *
 * `currentVersion` is the token the resource has NOW, so the leader's next read is cheap; it never
 * comes with the changed content — the leader must issue a real read (§ 4.4 rule 2). It is absent
 * only when the resource no longer exists at all: a human deleted it after the leader read it, which
 * is a change like any other, and there is no current token to hand back.
 */
export const staleVersionRejectionSchema = z.object({
  status: z.literal('conflict'),
  applied: z.literal(false),
  error: z.literal('stale_version'),
  resource: mcpVersionedResourceRefSchema,
  currentVersion: mcpVersionTokenSchema.optional(),
  changedSince: z.literal(true),
  guidance: z.literal(MCP_STALE_VERSION_GUIDANCE),
});
export type StaleVersionRejection = z.infer<typeof staleVersionRejectionSchema>;

/**
 * Outcome two — FAILED AFTER EXECUTION. The version matched and the effect started, then failed.
 *
 * It carries no error text: an exception message can quote a command line, a path or a token, and
 * nothing secret may reach a tool response (F-15). The details stay in the cockpit's own log.
 */
export const executionFailedSchema = z.object({
  status: z.literal('failed'),
  executed: z.literal(true),
  error: z.literal('execution_failed'),
  resource: mcpVersionedResourceRefSchema,
  guidance: z.literal(MCP_EXECUTION_FAILED_GUIDANCE),
});
export type ExecutionFailed = z.infer<typeof executionFailedSchema>;

/**
 * The version-checked mutation that went through. `version` is the resource's token AFTER the
 * change, so a leader that wants to act again on what it just wrote can do so without another read.
 * It is absent only when the mutation itself removed the resource. A tool that answers with more
 * extends this shape.
 */
export const versionedMutationDoneSchema = z.object({
  status: z.literal('done'),
  resource: mcpVersionedResourceRefSchema,
  version: mcpVersionTokenSchema.optional(),
});
export type VersionedMutationDone = z.infer<typeof versionedMutationDoneSchema>;

/** Every way a version-checked mutation can end. `status` discriminates, and the three never merge. */
export const versionedMutationOutcomeSchema = z.discriminatedUnion('status', [
  versionedMutationDoneSchema,
  staleVersionRejectionSchema,
  executionFailedSchema,
]);
export type VersionedMutationOutcome = z.infer<typeof versionedMutationOutcomeSchema>;
