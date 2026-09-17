import type { McpToolResult } from './ipc.ts';

/**
 * MCP answers that say "nothing was done" without being an MCP error — for the audit trail (#577,
 * the #575 QA note; spec `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 3.2).
 *
 * D-05 makes a business conflict an ordinary answer rather than `isError`, and `handoff_git` answers
 * every outcome as ordinary text. Before #577 the door therefore wrote `applied` for three answers in
 * which nothing was applied:
 *
 *   - A `conflict` answer — `execution_control`'s `conflict()` (an action the task's state does not
 *     allow, including a cancel that found the task no longer active), `organise_work`'s and
 *     `task_create`'s conflict (a route's 409, such as an Inbox action while the Inbox is off),
 *     and `handoff_git`'s moved head. Each is decided before any effect, and each says nothing
 *     changed: `refused`, with `stale_head` for a moved head and `conflict` otherwise.
 *   - A `handoff_git` `status: failed` answer whose `refusedBy` names a check that runs before the
 *     tool reaches its effect route — `policy` (the cockpit's own preconditions), `quality` and
 *     `forge` (the merge verdict read first), a `service` refusal that carries the route's 4xx (the
 *     routes validate and refuse before an effect) and a `service` refusal with no status, which is
 *     only the unavailable merge-state read that precedes `ready` and `merge`: `refused`.
 *   - Any other `handoff_git` `status: failed` answer — a 5xx, a service failure without that
 *     shape: it may have come after the effect started, so it is NOT `refused` either.
 *     `failedAnswerOf` says so, and the door writes no record and its one warning, exactly as for an
 *     MCP error. Only `handoff_git`: `task_create` answers `failed` for a run it DID start that then
 *     failed, which is `applied` (§ 3.2 — applied never promises the task succeeded).
 *
 * Every shape is matched on its structured fields, never on free text.
 */

/** The JSON object an answer carries: its structured content, or its text when that is a JSON object. */
function answerOf(result: McpToolResult): Record<string, unknown> | undefined {
  if (result.structuredContent) return result.structuredContent;
  const block = result.content[0];
  if (block?.type !== 'text') return undefined;
  try {
    const parsed: unknown = JSON.parse(block.text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A `status: conflict` answer: refused before any effect. */
export function conflictRefusalOf(result: McpToolResult): 'conflict' | 'stale_head' | undefined {
  if (result.isError) return undefined;
  const answer = answerOf(result);
  if (answer?.status !== 'conflict') return undefined;
  return answer.code === 'stale-head' ? 'stale_head' : 'conflict';
}

/** Which `handoff_git` refusals precede every effect, by `refusedBy`, and the reason each records. */
const HANDOFF_REFUSED_BY: Readonly<Record<string, string>> = {
  policy: 'policy',
  quality: 'quality_blocker',
  forge: 'forge_blocker',
};

/** A `handoff_git` `status: failed` answer that refused before any effect, as its reason. */
export function handoffGitRefusalOf(toolName: string, result: McpToolResult): string | undefined {
  if (toolName !== 'handoff_git' || result.isError) return undefined;
  const answer = answerOf(result);
  if (answer?.status !== 'failed' || typeof answer.refusedBy !== 'string') return undefined;
  if (answer.refusedBy !== 'service') return HANDOFF_REFUSED_BY[answer.refusedBy];
  const status = answer.httpStatus;
  if (status === undefined) return 'forge_unavailable';
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500 ? `http_${status}` : undefined;
}

/** A non-error `handoff_git` answer that says it failed. Never `applied`; recorded only when a refusal above recognised it. */
export function failedAnswerOf(toolName: string, result: McpToolResult): boolean {
  return toolName === 'handoff_git' && !result.isError && answerOf(result)?.status === 'failed';
}
