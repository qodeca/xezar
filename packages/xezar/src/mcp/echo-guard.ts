import {
  MCP_JOURNAL_RETAINED_ROWS,
  mcpJournalOperationIdSchema,
  mcpJournalProjectIdSchema,
  mcpJournalRowSchema,
  type McpJournalRow,
} from '@qodeca/xezar-contract';

import type { EventJournal } from './event-journal.ts';
import { RECEIPT_MAX_KEPT } from './operation-receipts.ts';

/**
 * The leader-side echo guard (#106, F-13): what stands between the project's event journal and a
 * project-bound leader, so the leader sees human changes and new outcomes and never its own echoes.
 *
 * WHY IT EXISTS. A leader that reacts to every row would react to the row its OWN mutation
 * produced, mutate again, and read that echo too — a loop that costs a model turn per lap and never
 * ends. The compatibility report states the rule: do not react recursively to the leader's own
 * operation acknowledgements; keep causal origin so real new outcomes stay actionable while echoes,
 * duplicate delivery and presentation updates do not trigger loops.
 *
 * THE SOURCE. The same state source as the cockpit, after project filtering (requirements § 8):
 * the per-project journal (#103), fed from the shared services an MCP write goes through. Never the
 * workspace stream — `/api/v1/workspace/events` carries every project and the registry news, and an
 * unfiltered workspace stream reaching MCP is exactly what § 8 prohibits (D-05 § 6.4).
 *
 * THE RULES, in the order `admit` applies them. A row is delivered only when it survives all six:
 *   1. `invalid`         — it does not parse as a journal row (`mcpJournalRowSchema`).
 *   2. `foreign-project` — it names a project other than the one this session is bound to (N-01).
 *   3. `workspace-only`  — its `kind` is a workspace-only event name. `project-added`,
 *      `project-removed` and `checkout-progress` name OTHER projects; N-01 forbids a project-bound
 *      session ever receiving one, whatever category an emitter filed it under.
 *   4. `presentation`    — its `kind` is presentation, a log line or a counter: D-05 § 6.3's
 *      closed negative list plus the SSE stream's own `usage` and `ping`. The journal should never
 *      hold one (issue #104's catalog excludes them); this is the leader's own floor under that.
 *   5. `own-echo`        — `origin` is `leader` AND `causedBy` is an operation THIS guard issued.
 *      Exactly D-05 § 6.3's rule. Never "I recognise the run": a task the leader started still
 *      reports its completion (`origin: system`) and a human's edit to it (`origin: human`), and a
 *      `leader` row caused by an operation this guard never issued — another session's — is news.
 *   6. `duplicate`       — its `eventId` was already delivered. Delivery is at-least-once (D-05
 *      § 6.6), and a replay overlapping the live feed must not wake the leader twice.
 *
 * ORDERING IS THE WHOLE TRICK. The service writes the echo while the operation is still in flight:
 * `PATCH /runs/:id` updates the store synchronously inside the route, so the row can reach the
 * journal before the tool result reaches the leader. An operation id recorded on ACKNOWLEDGEMENT
 * would therefore miss its own echo. `issue` records the id first and only then dispatches, so no
 * interleaving can deliver an echo of an operation the guard does not yet know about.
 *
 * WHAT IT IS NOT. Not the journal (#103), not the catalog emitter (#104), not replay/reconnect
 * (#105) and not the event controller (#107): those produce, page and dispatch rows, and each of
 * them hands rows to `admit`. It grants nothing, persists nothing and opens no file.
 */

/** The workspace-only names N-01 keeps away from a project-bound session: each names other projects. */
export const WORKSPACE_ONLY_EVENT_NAMES = ['project-added', 'project-removed', 'checkout-progress'] as const;

/**
 * Presentation, log lines and counters (requirements § 6): D-05 § 6.3's decided-negative list, plus
 * the two stream signals the brief names as the traffic that must not become leader events.
 */
export const PRESENTATION_EVENT_KINDS = [
  'item.started',
  'item.completed',
  'tool-call',
  'tool-result',
  'text',
  'token-usage',
  'cost',
  'usage',
  'ping',
] as const;

export type EchoDropReason =
  | 'invalid'
  | 'foreign-project'
  | 'workspace-only'
  | 'presentation'
  | 'own-echo'
  | 'duplicate';

export type EchoVerdict = { deliver: true; row: McpJournalRow } | { deliver: false; reason: EchoDropReason };

const WORKSPACE_ONLY = new Set<string>(WORKSPACE_ONLY_EVENT_NAMES);
const PRESENTATION = new Set<string>(PRESENTATION_EVENT_KINDS);

/**
 * A remembered set that forgets its oldest entry past `max`. Both bounds below are REUSED, not
 * chosen: an operation can only echo while its receipt is kept (D-09 B-21), and a row can only be
 * redelivered while the journal retains it (B-19).
 */
class BoundedSet {
  readonly #items = new Set<string>();
  constructor(readonly max: number) {}

  has(value: string): boolean {
    return this.#items.has(value);
  }

  add(value: string): void {
    if (this.#items.has(value)) return;
    this.#items.add(value);
    if (this.#items.size > this.max) this.#items.delete(this.#items.values().next().value as string);
  }

  clear(): void {
    this.#items.clear();
  }
}

export interface EchoGuardOptions {
  /** The registry slug of the bound project, from the trusted binding — never from a tool argument. */
  projectId: string;
}

export class EchoGuard {
  readonly projectId: string;
  readonly #own = new BoundedSet(RECEIPT_MAX_KEPT);
  readonly #delivered = new BoundedSet(MCP_JOURNAL_RETAINED_ROWS);

  constructor(options: EchoGuardOptions) {
    // A resolved slug only: the `default` alias names no journal, and a guard on it would compare
    // every row against a project id no row can carry.
    this.projectId = mcpJournalProjectIdSchema.parse(options.projectId);
    if (this.projectId === 'default') throw new Error('an echo guard needs a resolved project id, not the boot alias');
  }

  /**
   * Record `operationId` as this leader's own, THEN run `dispatch`. The only way to issue an
   * operation through the guard, so the id is always known before its echo can exist.
   */
  async issue<T>(operationId: string, dispatch: () => T | Promise<T>): Promise<T> {
    this.#own.add(mcpJournalOperationIdSchema.parse(operationId));
    return dispatch();
  }

  /** Whether `operationId` is one this guard issued. */
  isOwn(operationId: string): boolean {
    return this.#own.has(operationId);
  }

  /** Decide one row. Pure apart from remembering what it delivered; never throws. */
  admit(candidate: unknown): EchoVerdict {
    const parsed = mcpJournalRowSchema.safeParse(candidate);
    if (!parsed.success) return { deliver: false, reason: 'invalid' };
    const row = parsed.data;
    if (row.projectId !== this.projectId) return { deliver: false, reason: 'foreign-project' };
    if (WORKSPACE_ONLY.has(row.kind)) return { deliver: false, reason: 'workspace-only' };
    if (PRESENTATION.has(row.kind)) return { deliver: false, reason: 'presentation' };
    if (row.origin === 'leader' && row.causedBy !== null && this.#own.has(row.causedBy)) {
      return { deliver: false, reason: 'own-echo' };
    }
    if (this.#delivered.has(row.eventId)) return { deliver: false, reason: 'duplicate' };
    this.#delivered.add(row.eventId);
    return { deliver: true, row };
  }

  /**
   * Forget which rows were delivered — for a journal that was recreated (`cursor_too_old` after a
   * new epoch restarts `journalSeq`, and therefore `eventId`, at 1). The operations this leader
   * issued are kept: an echo of one is still an echo after the journal changed.
   */
  forgetDelivered(): void {
    this.#delivered.clear();
  }
}

/**
 * Attach a guarded leader feed to the bound project's journal. `deliver` sees only admitted rows;
 * `onDrop`, when given, sees every refusal (for tests and diagnostics — never for the leader).
 * Returns the unsubscribe, which the caller must keep: a feed nobody detaches is a listener the
 * journal holds for ever.
 */
export function attachLeaderFeed(options: {
  journal: Pick<EventJournal, 'projectId' | 'subscribe'>;
  guard: EchoGuard;
  deliver: (row: McpJournalRow) => void;
  onDrop?: (reason: EchoDropReason, row: McpJournalRow) => void;
}): () => void {
  const { journal, guard, deliver, onDrop } = options;
  if (journal.projectId !== guard.projectId) {
    // Refused without naming either project: the session knows its own, the other is not its business.
    throw new Error("a leader feed attaches only to its own project's journal");
  }
  return journal.subscribe((row) => {
    const verdict = guard.admit(row);
    if (verdict.deliver) deliver(verdict.row);
    else onDrop?.(verdict.reason, row);
  });
}
