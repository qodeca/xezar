import { z } from 'zod';

import { mcpJournalRowSchema, type McpJournalCategory } from './mcp-journal.ts';

/**
 * The significant-event catalog E-01–E-06 (#104) — the wire half: which `kind` a journal row may
 * carry and which catalog `category` each kind belongs to. The emitter that derives the rows lives
 * in `packages/xezar/src/mcp/event-catalog.ts`; the journal they land in is `mcp-journal.ts`.
 *
 * The catalog itself is AGREED and closed (requirements § 6, restated by D-05 § 1): this file adds,
 * removes and reinterprets no category. `kind` is D-05 § 6.3's finer machine label under a
 * category, open for additive growth, so a consumer that meets an unknown kind still has the
 * category to route on.
 *
 * The exclusion is equally binding and is why this list is short: presentation-only changes, log
 * lines and token counters never become a row (requirements § 6; D-05 § 6.3 names `item.*`,
 * `tool-call`, `tool-result`, `text`, `token-usage` and `cost`).
 */

/** The agreed catalog, verbatim from the requirements contract § 6. */
export const MCP_EVENT_CATALOG = {
  'E-01': 'Task completion, failure, cancellation or blocking.',
  'E-02': 'A question requiring attention and a human answer to a question.',
  'E-03': 'Quality-gate result or a completed result ready for assessment.',
  'E-04': 'Human change to goal, acceptance criteria, instruction, plan or task state.',
  'E-05': 'Configuration/workflow change affecting execution.',
  'E-06': 'Executor availability change affecting execution.',
} as const satisfies Record<McpJournalCategory, string>;

/** Every kind this server emits, and the category it belongs to. One table, so the two can never
 *  disagree. */
export const MCP_EVENT_KIND_CATEGORY = {
  // E-01 — derived from a run STATUS transition (D-05 § 5.1: a terminal status is not an event type).
  'task.done': 'E-01',
  'task.failed': 'E-01',
  'task.cancelled': 'E-01',
  /** The run parked at `waiting` with no structured question: it cannot go on without input. */
  'task.blocked': 'E-01',
  // E-02
  /** The agent raised a structured question (`ask.requested`) and parked at `waiting`. */
  'question.asked': 'E-02',
  /** A human replied to a run that was waiting on one. */
  'question.answered': 'E-02',
  // E-03 — F-11: the optional `review` status is a result ready for assessment, and is kept a
  // DIFFERENT kind from a mandatory quality gate so neither can be mistaken for the other.
  'gate.passed': 'E-03',
  'gate.failed': 'E-03',
  'result.ready': 'E-03',
  // E-04 — only ever with `origin: 'human'`.
  'goal.changed': 'E-04',
  'instruction.added': 'E-04',
  'instruction.queued': 'E-04',
  'instruction.edited': 'E-04',
  'instruction.removed': 'E-04',
  // E-05
  'config.changed': 'E-05',
  'workflow.saved': 'E-05',
  'workflow.deleted': 'E-05',
  'agent-config.changed': 'E-05',
  // E-06
  'executor.available': 'E-06',
  'executor.unavailable': 'E-06',
} as const satisfies Record<string, McpJournalCategory>;

export type McpEventKind = keyof typeof MCP_EVENT_KIND_CATEGORY;

export const mcpEventKindSchema = z.enum(
  Object.keys(MCP_EVENT_KIND_CATEGORY) as [McpEventKind, ...McpEventKind[]],
);

/** What a catalog row is about. `version` is D-06's token for a run, `null` where none exists. */
export const MCP_EVENT_SUBJECT_TYPES = ['run', 'config', 'workflow', 'agent-config', 'executor'] as const;
export const mcpEventSubjectTypeSchema = z.enum(MCP_EVENT_SUBJECT_TYPES);
export type McpEventSubjectType = z.infer<typeof mcpEventSubjectTypeSchema>;

/**
 * A journal row this catalog wrote: an ordinary journal row whose `kind` is a catalog kind, whose
 * `category` is that kind's category, and whose E-04 row names a human — a leader's own change is
 * never an E-04 row, because the catalog entry is "human change".
 */
export const mcpCatalogEventSchema = mcpJournalRowSchema.superRefine((row, ctx) => {
  const kind = mcpEventKindSchema.safeParse(row.kind);
  if (!kind.success) {
    ctx.addIssue({ code: 'custom', path: ['kind'], message: `not a catalog kind: ${row.kind}` });
    return;
  }
  if (MCP_EVENT_KIND_CATEGORY[kind.data] !== row.category) {
    ctx.addIssue({ code: 'custom', path: ['category'], message: `${row.kind} belongs to ${MCP_EVENT_KIND_CATEGORY[kind.data]}` });
  }
  if (!mcpEventSubjectTypeSchema.safeParse(row.subject.type).success) {
    ctx.addIssue({ code: 'custom', path: ['subject', 'type'], message: `not a catalog subject: ${row.subject.type}` });
  }
  if (row.category === 'E-04' && row.origin !== 'human') {
    ctx.addIssue({ code: 'custom', path: ['origin'], message: 'an E-04 row is a human change' });
  }
});
export type McpCatalogEvent = z.infer<typeof mcpCatalogEventSchema>;
