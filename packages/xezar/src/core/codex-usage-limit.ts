/**
 * Codex plan-limit facts read from the app-server's STRUCTURED answer (#565, #867 AC-9/AC-17).
 *
 * Every shape here is read against the Codex 0.156.0 app-server protocol schema
 * (`codex app-server generate-json-schema`):
 *
 *  - `turn/completed` carries `turn: Turn`, whose `error: TurnError | null` is "only populated when
 *    the Turn's status is failed". `TurnError.codexErrorInfo` is `CodexErrorInfo | null`; its
 *    string variants include `usageLimitExceeded` and `rateLimitExceeded`, listed separately and
 *    with no description. Neither variant carries a reset time — only `TurnError.message` and the
 *    account's rate-limit snapshot do. The schema does not say that `rateLimitExceeded` is a plan
 *    limit rather than a short HTTP rate limit, so it counts as one only when the snapshot's own
 *    `rateLimitReachedType` says a limit was reached.
 *  - `account/rateLimits/updated` carries one `RateLimitSnapshot`, a "sparse rolling rate-limit
 *    update": a `null` does not clear a previously observed value. Its `limitId` names the metered
 *    bucket (`codex` for the account's ordinary bucket) and `normalModelSlug` names the "normal
 *    model whose display name and reasoning options describe this quota alias".
 */
import { parseUsageLimit } from './usage-limit.ts';

/** The ordinary bucket's `limit_id` in every Codex answer observed so far. */
export const CODEX_DEFAULT_LIMIT_ID = 'codex';

/** The `CodexErrorInfo` variants that can mean the account is out of plan quota, not that the work failed. */
export type CodexLimitErrorInfo = 'usageLimitExceeded' | 'rateLimitExceeded';

export interface CodexTurnLimit {
  kind: CodexLimitErrorInfo;
  /** When the limit lifts, or `null` when neither the message nor the snapshot says. */
  resetAt: Date | null;
  /** The error text the run fails with: names the limit and its reset before Codex's own words. */
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when a snapshot describes ONE model's bucket rather than the account's ordinary bucket:
 * it names a bucket other than `codex` and the model that bucket is for. A snapshot without a
 * `limitId` keeps its historical meaning — the ordinary bucket.
 */
export function isCodexModelBucket(snapshot: unknown): snapshot is Record<string, unknown> & { limitId: string; normalModelSlug: string } {
  return isRecord(snapshot)
    && typeof snapshot.limitId === 'string' && snapshot.limitId.length > 0 && snapshot.limitId !== CODEX_DEFAULT_LIMIT_ID
    && typeof snapshot.normalModelSlug === 'string' && snapshot.normalModelSlug.length > 0;
}

/** Fold one sparse `account/rateLimits/updated` snapshot into the last one: `null` never clears. */
export function mergeCodexSnapshot(previous: Record<string, unknown> | undefined, incoming: unknown): Record<string, unknown> | undefined {
  if (!isRecord(incoming)) return previous;
  const merged = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * The reset a snapshot gives for an exhausted account: the latest future reset among the windows
 * that reached the limit (at 100 %). Anything else is `null`: a window that did not reach the limit
 * does not get to date it, even when `rateLimitReachedType` says some limit was reached.
 */
function snapshotReset(snapshot: unknown, now: number): Date | null {
  if (!isRecord(snapshot)) return null;
  const exhausted = [snapshot.primary, snapshot.secondary]
    .filter(isRecord)
    .filter((window) => typeof window.resetsAt === 'number' && window.resetsAt <= 10_000_000_000 && window.resetsAt * 1_000 > now)
    .filter((window) => typeof window.usedPercent === 'number' && window.usedPercent >= 100);
  const latest = exhausted.reduce<number | null>((max, window) => Math.max(max ?? 0, (window.resetsAt as number) * 1_000), null);
  return latest === null ? null : new Date(latest);
}

/** True when the session's merged snapshot says Codex itself reached a limit (`rateLimitReachedType`). */
function snapshotReachedLimit(snapshot: unknown): boolean {
  return isRecord(snapshot) && typeof snapshot.rateLimitReachedType === 'string' && snapshot.rateLimitReachedType.length > 0;
}

/**
 * Classify a finished Codex turn by its structured `codexErrorInfo`. Returns `null` for every turn
 * that did not fail on a plan limit — a completed turn, a failed turn with another error, or a
 * failed turn with no error object — so those keep exactly the handling they had.
 *
 * `usageLimitExceeded` is a plan limit. `rateLimitExceeded` is one only when the session's last
 * ordinary-bucket snapshot carries a non-null `rateLimitReachedType`; without it the turn is an
 * ordinary failed turn, so a short rate limit never holds a working login out.
 *
 * The reset comes from Codex's own message first (`…try again at Sep 20th, 2026 4:02 PM`, the one
 * statement about THIS failure), then from the snapshot window that reached the limit.
 */
export function codexTurnLimit(turn: unknown, lastSnapshot: unknown, now = Date.now()): CodexTurnLimit | null {
  if (!isRecord(turn) || turn.status !== 'failed' || !isRecord(turn.error)) return null;
  const kind = turn.error.codexErrorInfo;
  if (kind !== 'usageLimitExceeded' && kind !== 'rateLimitExceeded') return null;
  if (kind === 'rateLimitExceeded' && !snapshotReachedLimit(lastSnapshot)) return null;
  const codexMessage = typeof turn.error.message === 'string' ? turn.error.message.trim() : '';
  const resetAt = parseUsageLimit(codexMessage, now)?.resetAt ?? snapshotReset(lastSnapshot, now);
  const label = kind === 'usageLimitExceeded' ? 'usage limit' : 'rate limit';
  // The head is what `parseUsageLimit` reads back from the run's error (auto-resume and the
  // failed-run fallback): an exact UTC instant, so no locale or clock guess stands between them.
  const head = resetAt
    ? `Codex ${label} reached (${kind}) — resets at ${resetAt.toISOString()}.`
    : `Codex ${label} reached (${kind}); Codex did not report when it lifts.`;
  return { kind, resetAt, message: codexMessage ? `${head} ${codexMessage}` : head };
}
