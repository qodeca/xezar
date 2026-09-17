import { OWNERSHIP_MESSAGES } from './resource-ownership.ts';
import { NO_TASK } from './tools/handoff-git.ts';
import type { McpToolResult } from './ipc.ts';

/**
 * An MCP "not found" refusal, recognised for the audit trail (#573, spec
 * `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 3.2 and § 4, `mcp` row).
 *
 * The cockpit door records a route's 404 as `refused` (`http_404`) because a route answers 404
 * before any effect. The same refusal reaching MCP arrives in each tool's own words, and before
 * #573 the door could not tell it from a failure that may have come after an effect — so it wrote
 * nothing (`execution_control`, `organise_work`, `task_create`) or, where the answer is not an MCP
 * error, wrote `applied` (`handoff_git`). Both are wrong for an operation whose target was looked up
 * first and does not exist in this project: nothing happened, and the trail says so as
 * `refused` / `not_found`.
 *
 * WHAT COUNTS, and why each is unambiguous. Every shape is matched WHOLE, from the tool's fixed
 * wording, never as a substring of free text, and only where the lookup precedes every effect:
 *   - `execution_control`: the error answer `{ accepted: false, status: 'failed', reason: 'not found' }`.
 *     The tool reads the task through the project-scoped route first (`control` in
 *     `tools/execution-control.ts`); `not found` is that route's 404 body.
 *   - `organise_work`: `<action>: not found in this project` — the ownership refusal
 *     (`resource-ownership.ts`), which runs before any dispatch — or `<action> was refused (404): …`,
 *     a route's own 404, which refuses before its effect.
 *   - `task_create`: the error answer `{ accepted: false, operationId, error: 'not found' }` — the
 *     inbox route's 404 for an entry that does not exist.
 *   - `handoff_git`: `{ action, status: 'failed', refusedBy: 'policy', error: 'No such task in this
 *     project.' }` — the task lookup that precedes commit, push and pull-request creation.
 * Anything else — another error, another refusal, a partial answer — is NOT recognised here and
 * keeps the door's existing rule (spec § 3.2): an error that may have followed an effect is never
 * recorded as `refused`. `project_config` and `local_handoff` already relay the route's status and
 * are recorded as `http_404` by the door, exactly like the cockpit.
 */
export const NOT_FOUND_REASON = 'not_found';

/** The 404 body text the project-scoped routes answer with. */
const ROUTE_NOT_FOUND = 'not found';

export function notFoundRefusalOf(toolName: string, action: unknown, result: McpToolResult): typeof NOT_FOUND_REASON | undefined {
  const content = result.structuredContent;
  const block = result.content[0];
  const text = block?.type === 'text' ? block.text : undefined;
  switch (toolName) {
    case 'execution_control':
      return result.isError === true &&
        content?.accepted === false &&
        content.status === 'failed' &&
        content.reason === ROUTE_NOT_FOUND
        ? NOT_FOUND_REASON
        : undefined;
    case 'organise_work':
      return result.isError === true &&
        content === undefined &&
        typeof action === 'string' &&
        text !== undefined &&
        (text === `${action}: ${OWNERSHIP_MESSAGES.not_found}` || text.startsWith(`${action} was refused (404): `))
        ? NOT_FOUND_REASON
        : undefined;
    case 'task_create':
      return result.isError === true && content?.accepted === false && content.error === ROUTE_NOT_FOUND && content.status === undefined
        ? NOT_FOUND_REASON
        : undefined;
    case 'handoff_git': {
      if (result.isError === true || text === undefined) return undefined;
      let answer: unknown;
      try {
        answer = JSON.parse(text);
      } catch {
        return undefined;
      }
      const fields = answer as Record<string, unknown> | null;
      return fields !== null &&
        typeof fields === 'object' &&
        fields.status === 'failed' &&
        fields.refusedBy === 'policy' &&
        fields.error === NO_TASK
        ? NOT_FOUND_REASON
        : undefined;
    }
    default:
      return undefined;
  }
}
