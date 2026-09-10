import { z } from 'zod';

/**
 * The MCP / cockpit audit record (#102) — decision D-06 § 10, requirement N-04.
 *
 * One line of `<project>/.local/xezar/mcp-audit.ndjson` is one `AuditEntry`. The shape is the
 * § 10.2 field list and nothing else, and every field is an enum member, a digest or a
 * charset-bounded identifier: there is **no free-text field at all**, so no prompt, message, diff,
 * command output, path, email address, token or connection value has anywhere to land (§ 10.3,
 * F-15, F-12). That is the construction D-06 chose over relying on the best-effort run-event
 * scrubber; the service's writer adds a value check on top, it does not replace this.
 *
 * MUST vs SHOULD, as D-06 § 10.2 splits them and as this schema preserves them — N-04 itself only
 * says history *should* identify these things, so nothing here upgrades a SHOULD:
 *   - MUST: `projectId` (from the trusted connection binding, never a parameter) and `origin`
 *     (server-derived from the door the request came through, never client-supplied — § 10.4).
 *   - MUST NOT: any secret, free text, absolute path or other project's identifier (§ 10.3).
 *   - SHOULD: every other field. They are required on the wire only where the writer can always
 *     supply them (`ts`, `action`, `outcome`); the rest are optional and absent when unknown.
 * Audit RETENTION and the audit IDENTITY MODEL stay OPEN (N-04, D-06 § 10.5, D-09 U-2); nothing
 * in this file implies either.
 *
 * An entry is a record of a decision, never an input to one (§ 10.4 rule 3): no field here grants
 * anything, and no reader may consult an entry in place of a permission check.
 */

/** Where an operation came from — written by the server, never read from the request (§ 10.4). */
export const auditOriginSchema = z.enum(['ui', 'mcp', 'automation', 'cli']);
export type AuditOrigin = z.infer<typeof auditOriginSchema>;

/** D-06 § 9.2's outcome vocabulary. `in-progress` is derived at lookup time and never stored. */
export const auditOutcomeSchema = z.enum(['ok', 'rejected', 'not-applied', 'unverified']);
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;

/** A dotted action id such as `runs.create` or `runs.archive`. */
export const AUDIT_ACTION_RE = /^[a-z][A-Za-z0-9-]*(\.[a-z][A-Za-z0-9-]*)+$/;
/** A resource kind (`run`, `group`, `config`, `workflow`, `automation`, `worktree`, …). */
export const AUDIT_RESOURCE_KIND_RE = /^[a-z][a-z0-9-]*$/;
/**
 * A resource id inside the bound project. The charset of D-06's `operationId` (§ 5.2): no `/`, no
 * whitespace and no `@`, so a filesystem path, a sentence or an email address cannot be one.
 */
export const AUDIT_ID_RE = /^[A-Za-z0-9_.:-]+$/;
/** A short machine error code (`stale_version`, `operation_key_conflict`, …) — never a message. */
export const AUDIT_ERROR_CODE_RE = /^[a-z][a-z0-9_]*$/;
/** D-06 § 4.2's version token, `rev1:<kind>:<id>:<seq>:<digest12>`. Any other shape is not kept. */
export const AUDIT_VERSION_TOKEN_RE = /^rev1:[a-z][a-z0-9-]*:[A-Za-z0-9_.-]{1,128}:(?:\d+|-):[0-9a-f]{12}$/;

/** `{ kind, id }` of the resource acted on — never a path, never content (§ 10.2). */
export const auditResourceSchema = z.object({
  kind: z.string().min(1).max(32).regex(AUDIT_RESOURCE_KIND_RE),
  id: z.string().min(1).max(128).regex(AUDIT_ID_RE),
});
export type AuditResource = z.infer<typeof auditResourceSchema>;

export const auditEntrySchema = z.object({
  /** Record format tag. A future incompatible shape is `v: 2`. */
  v: z.literal(1),
  /** SHOULD — ISO 8601 time the operation settled. */
  ts: z.iso.datetime(),
  /** MUST — the project the connection or cockpit scope is bound to. */
  projectId: z.string().min(1).max(128).regex(AUDIT_ID_RE),
  /** SHOULD — the action id. */
  action: z.string().min(3).max(64).regex(AUDIT_ACTION_RE),
  /** SHOULD — the resource acted on, when there is one. */
  resource: auditResourceSchema.optional(),
  /** SHOULD — the D-06 outcome. */
  outcome: auditOutcomeSchema,
  /** MUST be server-derived. */
  origin: auditOriginSchema,
  /** SHOULD — D-02's session fencing generation; absent for non-MCP origins. Its semantics are D-02's. */
  ownerGeneration: z.number().int().nonnegative().optional(),
  /** SHOULD — `<projectId>/<operationId>` (D-06 § 5.2); absent for non-MCP origins. */
  operationKey: z.string().min(1).max(257).regex(/^[A-Za-z0-9_.:-]+\/[A-Za-z0-9_.:-]{8,128}$/).optional(),
  /** SHOULD — the `expectedVersion` the caller sent, kept only when it has the `rev1` shape. */
  versionToken: z.string().max(200).regex(AUDIT_VERSION_TOKEN_RE).optional(),
  /** SHOULD — SHA-256 (lowercase hex) of the canonical parsed payload (D-06 § 5.4). */
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** SHOULD — present when the outcome is not `ok`. */
  errorCode: z.string().min(1).max(64).regex(AUDIT_ERROR_CODE_RE).optional(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
