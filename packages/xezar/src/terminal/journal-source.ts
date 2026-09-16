/**
 * The bridge from the project's MCP event journal to the terminal (#467, PR 4).
 *
 * `activity-source.ts` derives most lines from the `RunStore`, the same bus the MCP event catalog
 * listens to. A few catalog kinds cannot be derived faithfully from the store alone, and PR 3 did
 * not print them at all:
 *
 * - `task.stalled` / `task.resumed` — the stall monitor's advisory pair (#460 § 2). The record's
 *   `progress.stall` shows only the CURRENT suspicion, so a silence that resumes while a deadline
 *   warning holds leaves the record unchanged. A second monitor just for the terminal would be a
 *   competing opinion about the same step.
 * - `verdict.posted` — a reviewer's report, announced once by its stable id (#460).
 * - `executor.*` and the writer-reported E-05 changes, which reach the catalog from outside the
 *   store.
 *
 * So these are printed from the journal row itself, with the row's own summary (already
 * summary-only and secret-redacted by the journal; sanitized again here, as every terminal field
 * is). Which kinds come from here is `CATALOG_KIND_SOURCE`, never a list in this file — a kind the
 * store bridge already prints is skipped, or it would print twice.
 *
 * The journal exists only while the project's MCP service is composed. Without it these lines are
 * absent, and so is everything that writes them: the stall monitor rides the same composition.
 */

import { CATALOG_KIND_SOURCE, type CatalogKindSource } from './event-names.ts';
import { entry } from './renderer.ts';

import type { McpJournalRow } from '@qodeca/xezar-contract';
import type { ActivityEntry } from './activity.ts';

export interface JournalActivityOptions {
  /** The cockpit URL, for the task link under a stall warning. */
  url?: () => string | undefined;
  projectId?: string;
}

/** Subject column for a row that is not about one task. */
const SUBJECT_FOR: Readonly<Record<string, string>> = {
  executor: 'provider',
  config: 'config',
  workflow: 'workflow',
  'agent-config': 'config',
};

/**
 * Turn one appended journal row into at most one terminal entry. Returns `undefined` for a kind
 * the store bridge owns, and for a kind this build does not know (the journal's `kind` is open
 * for additive growth; an unknown one is left to the cockpit rather than guessed at).
 */
export function journalRowEntry(row: McpJournalRow, options: JournalActivityOptions): ActivityEntry | undefined {
  if (!Object.hasOwn(CATALOG_KIND_SOURCE, row.kind)) return undefined;
  const kind = row.kind as keyof typeof CATALOG_KIND_SOURCE;
  const source: CatalogKindSource = CATALOG_KIND_SOURCE[kind];
  if (source.from !== 'journal') return undefined;
  const isRun = row.subject.type === 'run';
  const id8 = row.subject.id.slice(0, 8);
  const base = options.url?.();
  const link = isRun && kind === 'task.stalled' && base && options.projectId
    ? `${base}/p/${options.projectId}/tasks/${id8}`
    : undefined;
  return entry({
    at: new Date(row.ts),
    level: source.level,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    subject: isRun ? id8 : (SUBJECT_FOR[row.subject.type] ?? 'xezar'),
    message: row.summary,
    event: kind,
    ...(link ? { continuation: [link] } : {}),
    fields: [
      ...(isRun ? ([['run', id8]] as const) : ([[row.subject.type, row.subject.id]] as const)),
      ['origin', row.origin],
      ['seq', row.journalSeq],
      ['summary', row.summary],
    ],
  });
}

