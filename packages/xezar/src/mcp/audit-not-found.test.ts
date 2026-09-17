import { describe, expect, it } from 'vitest';
import { notFoundRefusalOf } from './audit-not-found.ts';
import type { McpToolResult } from './ipc.ts';
import { OWNERSHIP_MESSAGES } from './resource-ownership.ts';
import { NO_TASK } from './tools/handoff-git.ts';

/**
 * #573 — which MCP answers are an unambiguous "not found" refusal. The end-to-end proof, one case per
 * action through the real bridge and tools, is `audit-four-doors.test.ts`; this file pins the other
 * half of the rule (spec § 3.2): every near miss stays UNrecognised, so an error that may have come
 * after an effect is still never recorded as `refused`.
 */

const text = (value: string, extra: Partial<McpToolResult> = {}): McpToolResult => ({ content: [{ type: 'text', text: value }], ...extra });
const structured = (content: Record<string, unknown>, isError = true): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(content) }],
  structuredContent: content,
  ...(isError ? { isError: true } : {}),
});

describe('recognised: the tool looked its target up before any effect, and it is not in this project', () => {
  it.each([
    ['execution_control', 'cancel', structured({ action: 'cancel', accepted: false, status: 'failed', reason: 'not found', origin: 'mcp' })],
    ['organise_work', 'pin', text(`pin: ${OWNERSHIP_MESSAGES.not_found}`, { isError: true })],
    ['organise_work', 'start_inbox_item', text('start_inbox_item was refused (404): not found', { isError: true })],
    ['task_create', 'start_from_inbox', structured({ accepted: false, operationId: 'op-1', error: 'not found' })],
    ['handoff_git', 'push', text(JSON.stringify({ action: 'push', status: 'failed', refusedBy: 'policy', error: NO_TASK }))],
  ] as const)('%s %s', (tool, action, result) => {
    expect(notFoundRefusalOf(tool, action, result)).toBe('not_found');
  });
});

describe('not recognised: anything that is not that exact refusal keeps the door’s existing rule', () => {
  it.each([
    // execution_control: another failure, a conflict, and the same words on a non-error answer.
    ['execution_control', 'cancel', structured({ accepted: false, status: 'failed', reason: 'not a message id' })],
    ['execution_control', 'cancel', structured({ accepted: false, status: 'conflict', reason: 'not found' })],
    ['execution_control', 'cancel', structured({ accepted: false, status: 'failed', reason: 'not found' }, false)],
    ['execution_control', 'cancel', text('not found', { isError: true })],
    // organise_work: the message for another action, a longer sentence, another status, structured content.
    ['organise_work', 'pin', text(`unpin: ${OWNERSHIP_MESSAGES.not_found}`, { isError: true })],
    ['organise_work', 'pin', text(`pin: ${OWNERSHIP_MESSAGES.not_found} after the pin was applied`, { isError: true })],
    ['organise_work', 'pin', text('pin was refused (500): not found', { isError: true })],
    ['organise_work', 'pin', text(`pin: ${OWNERSHIP_MESSAGES.not_found}`)],
    ['organise_work', 'pin', { ...text(`pin: ${OWNERSHIP_MESSAGES.not_found}`, { isError: true }), structuredContent: { refused: true } }],
    ['organise_work', undefined, text(`undefined: ${OWNERSHIP_MESSAGES.not_found}`, { isError: true })],
    ['organise_work', 'pin', { content: [], isError: true }],
    // task_create: a conflict carries a status; another error; a non-error answer.
    ['task_create', 'start_from_inbox', structured({ accepted: false, operationId: 'op-1', status: 'conflict', error: 'not found' })],
    ['task_create', 'start_from_inbox', structured({ accepted: false, operationId: 'op-1', error: 'workflow not found in files' })],
    ['task_create', 'start_from_inbox', structured({ accepted: false, operationId: 'op-1', error: 'not found' }, false)],
    // handoff_git: a service refusal, another policy refusal, an MCP error, text that is not JSON.
    ['handoff_git', 'push', text(JSON.stringify({ action: 'push', status: 'failed', refusedBy: 'service', httpStatus: 404, error: NO_TASK }))],
    ['handoff_git', 'push', text(JSON.stringify({ action: 'push', status: 'failed', refusedBy: 'policy', error: 'no worktree' }))],
    ['handoff_git', 'push', text(JSON.stringify({ action: 'push', status: 'failed', refusedBy: 'policy', error: NO_TASK }), { isError: true })],
    ['handoff_git', 'push', text('No such task in this project.')],
    ['handoff_git', 'push', text('null')],
    ['handoff_git', 'push', { content: [] }],
    // A tool that relays its route's status is the door's `http_404` case, not this one.
    ['project_config', 'delete_workflow', structured({ action: 'delete_workflow', status: 404, error: 'not found' })],
  ] as const)('%s %s %#', (tool, action, result) => {
    expect(notFoundRefusalOf(tool, action, result as McpToolResult)).toBeUndefined();
  });
});
