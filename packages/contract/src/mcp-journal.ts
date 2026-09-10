import { z } from 'zod';

import { RUN_HISTORY_PAGE_ITEMS } from './events.ts';

/**
 * The per-project MCP event journal (#103) — the wire half. The writer, the retention and the
 * cursor arithmetic live in `packages/xezar/src/mcp/event-journal.ts`.
 *
 * Every shape here was decided elsewhere, and each comment names where:
 *  - D-05 (`docs/features/mcp-server/mcp-d05-async-event-contract-decision.md`) § 6.1–6.3 fixes
 *    the row envelope, the per-project gapless `journalSeq`, and `eventId = "<projectId>:<seq>"`;
 *    § 6.5 fixes the opaque cursor, replay strictly after it, the rejected malformed cursor and the
 *    explicit `cursor_too_old` answer.
 *  - D-09 (`mcp-d09-limits-retention-packaging-decision.md`) § 3 fixes every number: B-01 (page
 *    bytes), B-02/B-20 (page rows), B-04 (cursor bytes), B-19 (retention).
 *
 * This is NOT the per-run transcript: `runEventSchema` (`events.ts`) is one run's NDJSON, ordered by
 * a per-run `seq` that is allowed gaps. A journal row is ordered by the PROJECT's `journalSeq`,
 * which never has one, and it carries a summary — never a payload (D-05 § 6.3).
 */

/** B-19: the newest rows a project keeps, whatever their age. */
export const MCP_JOURNAL_RETAINED_ROWS = 10_000;

/** B-19: a row younger than this is never evicted, however many rows there are. */
export const MCP_JOURNAL_MIN_RETENTION_DAYS = 14;

/** B-02 / B-20: rows per replay page — the transcript page size, reused, not a second one. */
export const MCP_JOURNAL_PAGE_ROWS = RUN_HISTORY_PAGE_ITEMS;

/** B-01: serialized UTF-8 bytes of the rows on one page. Whichever of this and the row count is
 *  reached first ends the page; a page always carries at least one row when one is outstanding. */
export const MCP_JOURNAL_PAGE_BYTES = 40_000;

/** B-04: the size ceiling of every MCP cursor, the same as the transcript history cursor. */
export const MCP_JOURNAL_CURSOR_MAX_BYTES = 2_048;

/**
 * Shape bound on `summary`, not a behavioural limit: it keeps the largest possible row far inside
 * one B-01 page, so a single row can never need B-03's chunking. D-05 measured the whole envelope
 * at 399 bytes; a summary is one line of prose, never a transcript, diff or file content.
 */
export const MCP_JOURNAL_SUMMARY_MAX_CHARS = 500;

/** The agreed significant-event catalog (requirements § 6). Closed: D-05 § 6.3. */
export const mcpJournalCategorySchema = z.enum(['E-01', 'E-02', 'E-03', 'E-04', 'E-05', 'E-06']);
export type McpJournalCategory = z.infer<typeof mcpJournalCategorySchema>;

/**
 * Who caused the row (D-05 § 6.3). Server-derived, never taken from a tool argument. Together with
 * `causedBy` this is the F-13 echo-loop guard: an adapter drops a row whose `origin` is `leader` AND
 * whose `causedBy` is its own outstanding operation — never merely because it recognises the run.
 */
export const mcpJournalOriginSchema = z.enum(['human', 'leader', 'system']);
export type McpJournalOrigin = z.infer<typeof mcpJournalOriginSchema>;

/** A leader operation id, as D-06 § 5.2 shapes every `operationId`. Opaque; never parsed. */
export const mcpJournalOperationIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/);

/** The registry slug (`PROJECT_ID_RE` in `packages/xezar/src/workspace/config.ts`). */
export const mcpJournalProjectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/**
 * The affected resource. `version` is the D-06 token of the resource as it was when the row was
 * written, carried through replay unchanged (D-05 § 6.3). It is always PRESENT: `null` is the
 * explicit "this subject has no version" (an executor, say), never a missing key.
 */
export const mcpJournalSubjectSchema = z.object({
  type: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  id: z.string().min(1).max(256),
  version: z.string().min(1).max(512).nullable(),
});
export type McpJournalSubject = z.infer<typeof mcpJournalSubjectSchema>;

/** Provenance back to one run transcript line. Never identity, never order (D-05 § 6.1). */
export const mcpJournalSourceSchema = z.object({
  runId: z.string().min(1).max(128),
  runSeq: z.number().int().nonnegative(),
});

/** `kind` is the finer machine label under a category; open for additive growth (D-05 § 6.3). */
export const mcpJournalKindSchema = z.string().max(64).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

const originFields = {
  category: mcpJournalCategorySchema,
  kind: mcpJournalKindSchema,
  subject: mcpJournalSubjectSchema,
  origin: mcpJournalOriginSchema,
  causedBy: mcpJournalOperationIdSchema.nullable(),
  summary: z.string().min(1).max(MCP_JOURNAL_SUMMARY_MAX_CHARS),
  source: mcpJournalSourceSchema.optional(),
};

/** A `leader` row without its operation id would defeat the echo guard it exists for. */
function leaderNamesItsOperation(value: { origin: McpJournalOrigin; causedBy: string | null }): boolean {
  return value.origin !== 'leader' || value.causedBy !== null;
}
const LEADER_NEEDS_OPERATION = { message: 'a leader row must name the operation that caused it', path: ['causedBy'] };

/**
 * What an emitter hands the journal. The journal assigns `journalSeq`, `ts`, `projectId` and
 * `eventId` itself — a caller cannot choose its own position or its own project.
 */
export const mcpJournalAppendInputSchema = z.object(originFields).refine(leaderNamesItsOperation, LEADER_NEEDS_OPERATION);
export type McpJournalAppendInput = z.input<typeof mcpJournalAppendInputSchema>;

/** One journal row, exactly as it is stored and exactly as it is replayed (D-05 § 6.3). */
export const mcpJournalRowSchema = z
  .object({
    eventId: z.string().min(1),
    journalSeq: z.number().int().positive(),
    ts: z.string(),
    projectId: mcpJournalProjectIdSchema,
    ...originFields,
  })
  .refine(leaderNamesItsOperation, LEADER_NEEDS_OPERATION);
export type McpJournalRow = z.infer<typeof mcpJournalRowSchema>;

/** Opaque to the client. It encodes project, epoch and position; a client never builds one. */
export const mcpJournalCursorSchema = z.string().min(1).max(MCP_JOURNAL_CURSOR_MAX_BYTES);
export type McpJournalCursor = z.infer<typeof mcpJournalCursorSchema>;

/** A replay read: everything strictly after `cursor`, or from the oldest retained row without one. */
export const mcpJournalReadInputSchema = z.object({
  cursor: mcpJournalCursorSchema.optional(),
  limit: z.number().int().min(1).max(MCP_JOURNAL_PAGE_ROWS).optional(),
});
export type McpJournalReadInput = z.infer<typeof mcpJournalReadInputSchema>;

export const mcpJournalPageSchema = z.object({
  status: z.literal('ok'),
  events: z.array(mcpJournalRowSchema),
  /** Read after this next; equals the request's position when nothing was outstanding. */
  nextCursor: mcpJournalCursorSchema,
  /** More rows are already retained past `nextCursor` — read again, do not wait for an event. */
  hasMore: z.boolean(),
  /** `null` while the journal is empty. */
  oldestSeq: z.number().int().positive().nullable(),
  latestSeq: z.number().int().nonnegative(),
});
export type McpJournalPage = z.infer<typeof mcpJournalPageSchema>;

/**
 * The explicit gap (D-05 § 6.5, adopted by D-09 B-19). Rows the cursor still needed are gone —
 * evicted by retention, or the journal was recreated — so NOTHING is replayed: a partial replay
 * would read as "nothing happened" in between. The caller reads current state first, then continues
 * from `resumeCursor`, which sits just before the oldest row still retained.
 */
export const mcpJournalCursorTooOldSchema = z.object({
  status: z.literal('cursor_too_old'),
  oldestSeq: z.number().int().positive().nullable(),
  latestSeq: z.number().int().nonnegative(),
  resumeCursor: mcpJournalCursorSchema,
  recovery: z.object({
    required: z.literal('current-state'),
    message: z.string(),
  }),
});
export type McpJournalCursorTooOld = z.infer<typeof mcpJournalCursorTooOldSchema>;

export const mcpJournalReadResultSchema = z.discriminatedUnion('status', [
  mcpJournalPageSchema,
  mcpJournalCursorTooOldSchema,
]);
export type McpJournalReadResult = z.infer<typeof mcpJournalReadResultSchema>;

/**
 * A cursor the journal refuses outright. Never "start from zero" — that would replay the whole
 * retention window into a model turn (D-05 § 6.5). `cursor_project_mismatch` names neither project:
 * the bound session already knows its own, and the other one is not its business (N-01).
 */
export const mcpJournalCursorRejectionSchema = z.object({
  error: z.enum(['invalid_cursor', 'cursor_project_mismatch']),
  message: z.string(),
});
export type McpJournalCursorRejection = z.infer<typeof mcpJournalCursorRejectionSchema>;
