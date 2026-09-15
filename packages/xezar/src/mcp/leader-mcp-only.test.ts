import { describe, expect, it } from 'vitest';
import { LEADER_ROLE_INSTRUCTION } from './leader-delivery.ts';
import type { McpToolContext } from './tool.ts';
import { executionControlTool } from './tools/execution-control.ts';
import { handoffGitTool } from './tools/handoff-git.ts';
import { leaderEventsTool } from './tools/leader-events.ts';
import { taskReadsTool } from './tools/task-reads.ts';
import { organiseWorkTool } from './tools/work-organisation.ts';

/**
 * #439 — the owner's operating rule (2026-09-15): a project leader works through the xezar MCP tools
 * only, never the cockpit UI or the HTTP API, and is attached so events are pushed; `leader_events`
 * is the fallback. These pins cover the strings a leader reads at runtime that no generated
 * reference already pins (tool descriptions are pinned byte-for-byte by `mcp-api-doc.test.ts`, the
 * initialize instructions by `bridge.test.ts`, the no-leader blocker by `leader-delivery.test.ts`).
 */

const ctx = { project: { id: 'leader', name: 'Leader', root: '/nonexistent' }, xezarVersion: '0.0.0-test' } as McpToolContext;
const textOf = (result: { content: ReadonlyArray<{ type: string; text?: string }> }): string =>
  result.content.map((part) => part.text ?? '').join('\n');

describe('an unconnected tool never sends a leader to the cockpit (#439)', () => {
  const unwired = [
    ['task_read', () => taskReadsTool.call({ view: 'list' } as never, ctx)],
    ['execution_control', () => executionControlTool.call({ action: 'cancel' } as never, ctx)],
    ['handoff_git', () => handoffGitTool.call({ action: 'repo' } as never, ctx)],
    ['organise_work', () => organiseWorkTool.call({ action: 'delete' } as never, ctx)],
    ['leader_events', () => leaderEventsTool.call({ action: 'read' } as never, ctx)],
  ] as const;

  for (const [name, call] of unwired) {
    it(`${name} tells the leader to report the blocker, not to switch surface`, async () => {
      // RED against: the old "Use the cockpit …" fallback in the not-connected answer.
      const result = await call();
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toMatch(/not connected/);
      expect(text).toContain('Report this');
      expect(text).toContain('to the person');
      expect(text).not.toMatch(/Use the cockpit/);
    });
  }
});

describe('the role text pushed with every event states the MCP-only rule (#439)', () => {
  it('names the tools as the only surface and `gh` as the source of GitHub facts', () => {
    expect(LEADER_ROLE_INSTRUCTION).toContain('Use only these tools: never the cockpit UI and never its HTTP API.');
    expect(LEADER_ROLE_INSTRUCTION).toContain('Read GitHub facts (labels, review verdicts, merge state) with `gh`');
  });
});
