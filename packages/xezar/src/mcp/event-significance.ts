import type { McpJournalRow } from '@qodeca/xezar-contract';

/**
 * Whether a retained journal row should wake an attached leader.
 *
 * Delivery omits exactly one kind: an explicitly routine successful workflow check. Failures,
 * legacy gate rows without routing metadata, unknown future kinds and every non-gate row remain
 * significant. Raw journal reads deliberately do not use this predicate.
 */
export function isLeaderSignificant(row: McpJournalRow): boolean {
  return !(row.kind === 'gate.passed' && row.gate?.resultScope === 'routine');
}

/** Shared leader-facing explanation for dispatch metadata; absent when nothing was omitted. */
export function omittedRoutineLine(count: number | undefined): string | undefined {
  return count === undefined
    ? undefined
    : `omittedRoutineCount: ${count} routine successful check${count === 1 ? '' : 's'} covered by this cursor.`;
}
