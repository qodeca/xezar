import { mcpJournalOperationIdSchema, mcpJournalProjectIdSchema, type McpJournalRow } from '@qodeca/xezar-contract';

import { RECEIPT_MAX_KEPT } from './operation-receipts.ts';

/**
 * The leader-side echo guard (#106, F-13): what keeps a project-bound leader from reacting to its
 * own echoes, so it sees human changes and new outcomes and never the rows its own mutations wrote.
 *
 * WHY IT EXISTS. A leader that reacts to every row would react to the row its OWN mutation
 * produced, mutate again, and read that echo too — a loop that costs a model turn per lap and never
 * ends. The compatibility report states the rule: do not react recursively to the leader's own
 * operation acknowledgements; keep causal origin so real new outcomes stay actionable while echoes,
 * duplicate delivery and presentation updates do not trigger loops.
 *
 * THE ONE RULE APPLIED AT DELIVERY (`isOwnEcho`, run by `LeaderDelivery.deliver` for every client):
 * a row is an echo when `origin` is `leader` AND `causedBy` is an operation THIS guard issued.
 * Exactly D-05 § 6.3's rule. Never "I recognise the run": a task the leader started still reports
 * its completion (`origin: system`) and a human's edit to it (`origin: human`), and a `leader` row
 * caused by an operation this guard never issued — another session's — is news.
 *
 * WHAT THE REST OF THE PIPE ALREADY GUARANTEES, so delivery does not re-check it:
 *  - foreign project (N-01): the source is the per-project journal (#103), which stamps its own
 *    `projectId` on every row it appends and refuses to load a row naming another project. Never
 *    the workspace stream — an unfiltered workspace stream reaching MCP is what requirements § 8
 *    prohibits (D-05 § 6.4).
 *  - workspace-only and presentation kinds: the journal's only emitter is the event catalog
 *    (#104), whose kinds are the closed `MCP_EVENT_KIND_CATEGORY` table. The two lists below are
 *    the kinds that table must never contain, and `echo-guard.test.ts` pins that.
 *  - duplicates: NOT dropped, on purpose. Delivery is at-least-once by contract (D-05 § 6.6); the
 *    controller resumes after the leader's acknowledgement and the leader deduplicates by `eventId`.
 *
 * ORDERING IS THE WHOLE TRICK. The service writes the echo while the operation is still in flight:
 * `PATCH /runs/:id` updates the store synchronously inside the route, so the row can reach the
 * journal before the tool result reaches the leader. An operation id recorded on ACKNOWLEDGEMENT
 * would therefore miss its own echo. `issue` records the id first and only then dispatches, so no
 * interleaving can deliver an echo of an operation the guard does not yet know about.
 *
 * WHAT IT IS NOT. Not the journal (#103), not the catalog emitter (#104), not replay/reconnect
 * (#105) and not the event controller (#107). It grants nothing, persists nothing and opens no file.
 */

/**
 * The workspace-only names N-01 keeps away from a project-bound session: each names other projects.
 * A negative list — the event catalog must never emit one (pinned by `echo-guard.test.ts`).
 */
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

/**
 * A remembered set that forgets its oldest entry past `max`. The bound below is REUSED, not
 * chosen: an operation can only echo while its receipt is kept (D-09 B-21).
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

  delete(value: string): void {
    this.#items.delete(value);
  }
}

export interface EchoGuardOptions {
  /** The registry slug of the bound project, from the trusted binding — never from a tool argument. */
  projectId: string;
}

export class EchoGuard {
  readonly projectId: string;
  readonly #own = new BoundedSet(RECEIPT_MAX_KEPT);

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
    const result = await dispatch();
    if (operationNotApplied(result)) this.#own.delete(operationId);
    return result;
  }

  /** Whether `operationId` is one this guard issued. */
  isOwn(operationId: string): boolean {
    return this.#own.has(operationId);
  }
}

/**
 * Whether `row` is an echo of an operation `guard` issued: `origin` is `leader` AND `causedBy` is
 * one of the guard's own operations. The one rule `LeaderDelivery` applies before handing rows to
 * any leader client. No guard (it could not be built): nothing is an echo.
 */
export function isOwnEcho(row: Pick<McpJournalRow, 'origin' | 'causedBy'>, guard: Pick<EchoGuard, 'isOwn'> | undefined): boolean {
  return row.origin === 'leader' && row.causedBy !== null && guard?.isOwn(row.causedBy) === true;
}

/** Only an explicit no-effect result permits forgetting pre-dispatch ownership. */
export function operationNotApplied(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false;
  if ('applied' in result && result.applied === false) return true;
  if (!('content' in result) || !Array.isArray(result.content)) return false;
  const block = result.content[0];
  if (block?.type !== 'text') return false;
  try {
    const body: unknown = JSON.parse(block.text);
    return body !== null && typeof body === 'object' && 'applied' in body && body.applied === false;
  } catch {
    return false;
  }
}
