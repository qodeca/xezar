import { describe, expect, it } from 'vitest';
import type { McpJournalRow } from '@qodeca/xezar-contract';

import { isLeaderSignificant } from './event-significance.ts';
import { channelMeta, renderChannelContent } from './adapters/claude-code.ts';
import { renderCodexEventMessage } from './adapters/codex.ts';
import { renderDispatch as renderOpenCodeDispatch } from './adapters/opencode.ts';
import { renderPiDispatch } from './adapters/pi.ts';
import type { EventDispatch } from './event-controller.ts';

const row = (over: Partial<McpJournalRow>): McpJournalRow => ({
  eventId: 'alpha:1',
  journalSeq: 1,
  ts: '2026-09-16T00:00:00.000Z',
  projectId: 'alpha',
  category: 'E-03',
  kind: 'gate.passed',
  subject: { type: 'run', id: 'run-1', version: null },
  origin: 'system',
  causedBy: null,
  summary: 'gate settled',
  ...over,
});

describe('T-18 — one conservative delivery-significance rule', () => {
  it('omits only an explicitly routine pass; legacy gates, failures, stale history and stall/resume stay significant', () => {
    // RED against: treating absent gate metadata as routine, filtering failures, or keying on standing.
    expect(isLeaderSignificant(row({ gate: { stepId: 'setup', resultScope: 'routine' } }))).toBe(false);
    expect(isLeaderSignificant(row({}))).toBe(true);
    expect(isLeaderSignificant(row({ kind: 'gate.failed', gate: { stepId: 'setup', resultScope: 'routine' } }))).toBe(true);
    expect(isLeaderSignificant(row({ kind: 'gate.passed', gate: { stepId: 'gates', resultScope: 'stage' } }))).toBe(true);
    expect(isLeaderSignificant(row({ category: 'E-01', kind: 'task.stalled', gate: undefined }))).toBe(true);
    expect(isLeaderSignificant(row({ category: 'E-01', kind: 'task.resumed', gate: undefined }))).toBe(true);
  });

  it('hands the same visible IDs and omission count to every adapter format', () => {
    const visible = row({ eventId: 'alpha:9', journalSeq: 9, kind: 'gate.failed', gate: { stepId: 'setup', resultScope: 'routine' } });
    const dispatch: EventDispatch = {
      projectId: 'alpha',
      events: [visible],
      nextCursor: 'cursor-through-9',
      omittedRoutineCount: 8,
    };
    const rendered = [
      renderChannelContent(dispatch, dispatch.events, 'lead'),
      renderCodexEventMessage(dispatch),
      renderOpenCodeDispatch(dispatch, dispatch.events),
      renderPiDispatch(dispatch, dispatch.events, 'lead', '<marker>'),
    ];
    for (const text of rendered) {
      expect(text).toContain('alpha:9');
      expect(text).toContain('omittedRoutineCount: 8');
      expect(text).not.toContain('alpha:8');
    }
    expect(channelMeta(dispatch, dispatch.events)).toMatchObject({
      next_cursor: 'cursor-through-9',
      omitted_routine_count: '8',
    });
  });
});
