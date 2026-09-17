import { describe, expect, it } from 'vitest';
import { conflictRefusalOf, failedAnswerOf, handoffGitRefusalOf } from './audit-answer-refusals.ts';
import type { McpToolResult } from './ipc.ts';

/**
 * #577 — which ordinary MCP answers say that nothing was applied. The end-to-end proof, one case per
 * action through the real bridge and tools, is `audit-four-doors.test.ts`; this file pins the other
 * half of the rule (spec § 3.2): a failure that may have followed an effect is never `refused`, and
 * an answer about a task that DID start is never turned into one either.
 */

const text = (value: unknown, extra: Partial<McpToolResult> = {}): McpToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  ...extra,
});
const structured = (content: Record<string, unknown>, extra: Partial<McpToolResult> = {}): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(content) }],
  structuredContent: content,
  ...extra,
});

describe('a conflict answer is a refusal before any effect', () => {
  it.each([
    ['execution_control state conflict', structured({ action: 'cancel', accepted: false, status: 'conflict', reason: 'it is done' }), 'conflict'],
    ['execution_control stale version', structured({ accepted: false, status: 'conflict', error: 'stale_version' }), 'conflict'],
    ['organise_work text answer', text({ status: 'conflict', action: 'start_inbox_item', reason: 'the Inbox is off' }), 'conflict'],
    ['task_create inbox 409', structured({ accepted: false, operationId: 'op-1', status: 'conflict', error: 'the Inbox is off' }), 'conflict'],
    ['handoff_git moved head', text({ action: 'merge', status: 'conflict', code: 'stale-head', error: 'the head moved' }), 'stale_head'],
  ] as const)('%s', (_name, result, reason) => {
    expect(conflictRefusalOf(result)).toBe(reason);
  });

  it.each([
    ['an MCP error answer', structured({ status: 'conflict' }, { isError: true })],
    ['another status', structured({ status: 'done' })],
    ['a conflict nested in a result, which the answer-refusal table owns', structured({ result: { status: 'conflict' } })],
    ['text that is not JSON', text('conflict')],
    ['text that is a JSON array', text([{ status: 'conflict' }])],
    ['no content at all', { content: [] } as McpToolResult],
  ] as const)('not recognised: %s', (_name, result) => {
    expect(conflictRefusalOf(result)).toBeUndefined();
  });
});

describe('a handoff_git failure that refused before its effect', () => {
  it.each([
    ['policy', text({ action: 'commit', status: 'failed', refusedBy: 'policy', error: 'no changes to commit' }), 'policy'],
    ['quality', text({ action: 'merge', status: 'failed', refusedBy: 'quality', blocker: true }), 'quality_blocker'],
    ['forge', text({ action: 'merge', status: 'failed', refusedBy: 'forge', blocker: true }), 'forge_blocker'],
    ['a route 4xx', text({ action: 'push', status: 'failed', refusedBy: 'service', httpStatus: 409, error: 'busy' }), 'http_409'],
    ['an unavailable merge state', text({ action: 'ready', status: 'failed', refusedBy: 'service', error: 'gh is not installed' }), 'forge_unavailable'],
  ] as const)('%s', (_name, result, reason) => {
    expect(handoffGitRefusalOf('handoff_git', result)).toBe(reason);
    expect(failedAnswerOf('handoff_git', result)).toBe(true);
  });

  it.each([
    ['a 5xx from the service, which may have followed the effect', text({ action: 'push', status: 'failed', refusedBy: 'service', httpStatus: 502, error: 'boom' })],
    ['a refusal with no refusedBy', text({ action: 'push', status: 'failed', error: 'boom' })],
    ['an unknown refusedBy', text({ action: 'push', status: 'failed', refusedBy: 'weather', error: 'boom' })],
    ['an MCP error answer', text({ action: 'push', status: 'failed', refusedBy: 'policy' }, { isError: true })],
    ['a done answer', text({ action: 'push', status: 'done' })],
    ['another tool with the same shape', text({ action: 'push', status: 'failed', refusedBy: 'policy' })],
  ] as const)('not a recognised refusal: %s', (name, result) => {
    expect(handoffGitRefusalOf(name.startsWith('another tool') ? 'task_create' : 'handoff_git', result)).toBeUndefined();
  });

  it('only handoff_git treats a failed answer as "never applied"', () => {
    // A task_create run that started and then failed IS applied (§ 3.2): applied never promises success.
    const started = structured({ accepted: true, operationId: 'op-1', status: 'failed', subject: { type: 'run', id: 'run-1' } });
    expect(failedAnswerOf('task_create', started)).toBe(false);
    expect(failedAnswerOf('handoff_git', text({ status: 'failed', refusedBy: 'service', httpStatus: 502 }))).toBe(true);
  });
});
