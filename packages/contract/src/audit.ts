import { z } from 'zod';

/**
 * The audit record, version 2 (#306) — spec `docs/features/mcp-server/audit-trail-origins-2026-09-17.md`
 * § 3, decision D-06 § 10.
 *
 * One line of `<project>/.local/xezar/audit.ndjson` is one `AuditRecord`. Version 1 lived in
 * `mcp-audit.ndjson` and is kept only as a READ-ONLY legacy shape (`./mcp-audit.ts`); nothing writes
 * it any more.
 *
 * What changed from v1, and why it is a break rather than an addition (spec § 3.1):
 *   - `outcome` is no longer a string. It is `{ status: 'applied' }` or `{ status: 'refused', reason }`.
 *     v1's `unverified` has no v2 value: an operation whose effect may have started is not recorded
 *     at all, and the writer warns instead (spec § 3.2). `errorCode` became `outcome.reason`.
 *   - every record carries `seq`, a positive integer that grows by one per record in the file set,
 *     and `kind` (`action`, or the `rotated` marker a rotation writes first).
 *   - every action carries `actor`, a small server-derived description of the door, whose `type`
 *     must equal `origin`.
 *   - `ts` must be UTC (`…Z`).
 *   - objects are strict: an unknown key is refused before anything is persisted.
 * The released 0.15.0 reader therefore skips every v2 line as quarantined; it does not crash.
 *
 * Still true from v1: there is no free-text field, the origin and actor are the server's and never a
 * caller's, `ownerGeneration` and `operationKey` exist only for `mcp`, and an entry grants nothing —
 * no reader may consult one in place of a permission check (D-06 § 10.4 rule 3).
 *
 * Wired since #306 part 2: all four doors — `mcp` (`packages/xezar/src/mcp/index.ts`), `ui`
 * (`packages/xezar/src/server/audit-ui.ts`), `automation` (`packages/xezar/src/automations/audit.ts`)
 * and `cli` (`packages/xezar/src/cli-audit.ts`). Which actions `ui` and `mcp` record comes from one
 * shared inventory (`packages/xezar/src/mcp/audit-inventory.ts`).
 */

/** Where an operation came from: the server door that handled it, never a field the caller sends. */
export const auditOriginSchema = z.enum(['ui', 'mcp', 'automation', 'cli']);
export type AuditOrigin = z.infer<typeof auditOriginSchema>;

/** A dotted action id such as `taskCreate.start` or `run.archive`. */
export const AUDIT_ACTION_RE = /^[a-z][A-Za-z0-9-]*(\.[a-z][A-Za-z0-9-]*)+$/;
/** A resource kind (`run`, `group`, `config`, `workflow`, `automation`, `worktree`, …). */
export const AUDIT_RESOURCE_KIND_RE = /^[a-z][a-z0-9-]*$/;
/**
 * An identifier inside the bound project. The charset of D-06's `operationId` (§ 5.2): no `/`, no
 * whitespace and no `@`, so a filesystem path, a sentence or an email address cannot be one.
 */
export const AUDIT_ID_RE = /^[A-Za-z0-9_.:-]+$/;
/** A short machine code (`stale_version`, `workspace_settings`, …) — never a message. */
export const AUDIT_ERROR_CODE_RE = /^[a-z][a-z0-9_]*$/;
/** D-06 § 4.2's version token, `rev1:<kind>:<id>:<seq>:<digest12>`. Any other shape is not kept. */
export const AUDIT_VERSION_TOKEN_RE = /^rev1:[a-z][a-z0-9-]*:[A-Za-z0-9_.-]{1,128}:(?:\d+|-):[0-9a-f]{12}$/;
/** `<projectId>/<operationId>` (D-06 § 5.2). */
export const AUDIT_OPERATION_KEY_RE = /^[A-Za-z0-9_.:-]+\/[A-Za-z0-9_.:-]{8,128}$/;

export const auditIdSchema = z.string().min(1).max(128).regex(AUDIT_ID_RE);
export const auditReasonSchema = z.string().min(1).max(64).regex(AUDIT_ERROR_CODE_RE);
export const auditTimestampSchema = z.iso
  .datetime()
  .refine((value) => value.endsWith('Z'), 'audit timestamps must be UTC');

/** `{ kind, id }` of the resource acted on — never a path, never content. */
export const auditResourceSchema = z
  .object({
    kind: z.string().min(1).max(32).regex(AUDIT_RESOURCE_KIND_RE),
    id: auditIdSchema,
  })
  .strict();
export type AuditResource = z.infer<typeof auditResourceSchema>;

/** `applied`: the effect took place. `refused`: the door rejected it before any effect. */
export const auditOutcomeV2Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied') }).strict(),
  z.object({ status: z.literal('refused'), reason: auditReasonSchema }).strict(),
]);
export type AuditOutcomeV2 = z.infer<typeof auditOutcomeV2Schema>;

/** The reverse-proxy user a hosted cockpit may assert. Labelled as asserted, never as verified. */
export const auditProxyUserSchema = z
  .object({
    value: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), 'control characters are forbidden'),
    trust: z.literal('asserted-by-proxy'),
  })
  .strict();
export type AuditProxyUser = z.infer<typeof auditProxyUserSchema>;

/** The command-line subcommands, as their canonical ids (spec § 5). `rm` is recorded as `projects.remove`. */
export const auditCliCommandSchema = z.enum([
  'serve',
  'run',
  'init',
  'projects.list',
  'projects.add',
  'projects.remove',
  'projects.tag',
  'projects.port',
  'mcp',
  'server-install',
  'server-deploy',
  'server-uninstall',
]);

/** Who acted, as far as the door can say — derived by the server, one shape per door. */
export const auditActorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ui'), proxyUser: auditProxyUserSchema.optional() }).strict(),
  z.object({ type: z.literal('mcp') }).strict(),
  z.object({ type: z.literal('automation'), receiptId: auditIdSchema }).strict(),
  z.object({ type: z.literal('cli'), command: auditCliCommandSchema }).strict(),
]);
export type AuditActor = z.infer<typeof auditActorSchema>;

const auditBaseV2Schema = z.object({
  v: z.literal(2),
  /** Grows by one per record in the file set; a gap may follow a quarantined line, a repeat never. */
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** UTC ISO 8601 time the operation settled. */
  ts: auditTimestampSchema,
  /** The project the door's trusted scope is bound to — never a parameter. */
  projectId: auditIdSchema,
});

export const auditActionRecordSchema = auditBaseV2Schema
  .extend({
    kind: z.literal('action'),
    origin: auditOriginSchema,
    actor: auditActorSchema,
    action: z.string().min(3).max(64).regex(AUDIT_ACTION_RE),
    resource: auditResourceSchema.optional(),
    outcome: auditOutcomeV2Schema,
    /** MCP only — the wall-clock ms prefix of the D-02.3 fencing token. Never the whole token. */
    ownerGeneration: z.number().int().nonnegative().optional(),
    /** MCP only — `<projectId>/<operationId>` (D-06 § 5.2). */
    operationKey: z.string().min(1).max(257).regex(AUDIT_OPERATION_KEY_RE).optional(),
    /** The `expectedVersion` the caller sent, kept only when it has the `rev1` shape. */
    versionToken: z.string().max(200).regex(AUDIT_VERSION_TOKEN_RE).optional(),
    /** Sorted distinct top-level key names of a configuration write — names, never values. */
    fieldNames: z.array(z.string().min(1).max(64)).max(64).optional(),
    /** SHA-256 (lowercase hex) of the canonical parsed payload (D-06 § 5.4). */
    payloadDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.actor.type !== record.origin) ctx.addIssue({ code: 'custom', message: 'actor must match origin' });
    if (record.origin !== 'mcp' && (record.ownerGeneration !== undefined || record.operationKey !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'MCP join fields are MCP-only' });
    }
  });
export type AuditActionRecord = z.infer<typeof auditActionRecordSchema>;

/**
 * The first line of a live file a rotation created (#306 part 3). `previousLastSeq` is the last
 * sequence allocated before the rotation; the action that follows it takes the next one.
 */
export const auditRotatedRecordSchema = auditBaseV2Schema
  .extend({
    kind: z.literal('rotated'),
    previousLastSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type AuditRotatedRecord = z.infer<typeof auditRotatedRecordSchema>;

export const auditRecordSchema = z.discriminatedUnion('kind', [auditActionRecordSchema, auditRotatedRecordSchema]);
export type AuditRecord = z.infer<typeof auditRecordSchema>;
