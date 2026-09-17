import { z } from 'zod';
import {
  AUDIT_ACTION_RE,
  AUDIT_ERROR_CODE_RE,
  AUDIT_ID_RE,
  AUDIT_OPERATION_KEY_RE,
  AUDIT_RESOURCE_KIND_RE,
  AUDIT_VERSION_TOKEN_RE,
  auditOriginSchema,
} from './audit.ts';

/**
 * The LEGACY audit record, version 1 (#102) — read-only since #306.
 *
 * xezar 0.13.0 to 0.15.0 wrote one `AuditEntry` per line of `<project>/.local/xezar/mcp-audit.ndjson`.
 * The current record is version 2 in `./audit.ts`, written to `audit.ndjson`. This shape survives
 * for one job: reading a legacy file that an older xezar left behind, which the service does only
 * when `audit.ndjson` does not exist yet, and never by writing, renaming or trimming it (spec
 * `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 8). The alias is removed no earlier
 * than 0.18.0 and only through its tracking issue.
 *
 * Do not change this schema: a legacy file is exactly what 0.15.0 wrote, and a narrower or wider
 * shape here would misread it. The released reader is frozen separately, under
 * `packages/xezar/test/fixtures/audit-0.15.0/`, so the compatibility tests do not depend on this file.
 *
 * The field rules of v1 as D-06 § 10.2 split them: `projectId` and `origin` MUST be server-derived;
 * no secret, free text, absolute path or other project's identifier may appear; every other field
 * is SHOULD. Only `mcp` was ever written in production.
 */

/** D-06 § 9.2's v1 outcome vocabulary. v2 replaced it with `applied` / `refused`. */
export const auditOutcomeSchema = z.enum(['ok', 'rejected', 'not-applied', 'unverified']);
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;

/** v1's `{ kind, id }` — not strict, exactly as 0.15.0 parsed it (unknown keys are stripped, not refused). */
export const legacyAuditResourceSchema = z.object({
  kind: z.string().min(1).max(32).regex(AUDIT_RESOURCE_KIND_RE),
  id: z.string().min(1).max(128).regex(AUDIT_ID_RE),
});

export const auditEntrySchema = z.object({
  /** Record format tag. The incompatible successor is `v: 2` (`./audit.ts`). */
  v: z.literal(1),
  /** SHOULD — ISO 8601 time the operation settled. */
  ts: z.iso.datetime(),
  /** MUST — the project the connection or cockpit scope is bound to. */
  projectId: z.string().min(1).max(128).regex(AUDIT_ID_RE),
  /** SHOULD — the action id. */
  action: z.string().min(3).max(64).regex(AUDIT_ACTION_RE),
  /** SHOULD — the resource acted on, when there is one. */
  resource: legacyAuditResourceSchema.optional(),
  /** SHOULD — the D-06 outcome. */
  outcome: auditOutcomeSchema,
  /** MUST be server-derived. Only `mcp` was ever written. */
  origin: auditOriginSchema,
  /**
   * SHOULD — the wall-clock ms prefix of the D-02.3 fencing token (`<ms>-<UUIDv4>`) the mutation
   * arrived under; absent for non-MCP origins. Never the whole token: that passes the fence.
   */
  ownerGeneration: z.number().int().nonnegative().optional(),
  /** SHOULD — `<projectId>/<operationId>` (D-06 § 5.2); absent for non-MCP origins. */
  operationKey: z.string().min(1).max(257).regex(AUDIT_OPERATION_KEY_RE).optional(),
  /** SHOULD — the `expectedVersion` the caller sent, kept only when it has the `rev1` shape. */
  versionToken: z.string().max(200).regex(AUDIT_VERSION_TOKEN_RE).optional(),
  /** SHOULD — SHA-256 (lowercase hex) of the canonical parsed payload (D-06 § 5.4). */
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** SHOULD — present when the outcome is not `ok`. */
  errorCode: z.string().min(1).max(64).regex(AUDIT_ERROR_CODE_RE).optional(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
