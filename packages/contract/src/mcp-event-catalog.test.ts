import { describe, expect, it } from 'vitest';
import { MCP_EVENT_KIND_CATEGORY, mcpCatalogEventSchema } from './mcp-event-catalog.ts';

/**
 * `mcpCatalogEventSchema` is the ORACLE the emitter's own suite checks its rows against
 * (`packages/xezar/src/mcp/event-catalog.test.ts` asserts `safeParse(row).success` for every
 * catalog scenario). That assertion only means something if the schema can say no: a refinement
 * that accepted everything would keep it green while the emitter wrote an E-04 row for a leader's
 * own edit. So this suite pins each of the four refusals, one wrong field at a time, beside the one
 * row that must pass (#333).
 */

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  eventId: 'alpha:7',
  journalSeq: 7,
  ts: '2026-09-11T18:00:00.000Z',
  projectId: 'alpha',
  category: 'E-01',
  kind: 'task.done',
  subject: { type: 'run', id: 'run-1', version: 'v-1' },
  origin: 'system',
  causedBy: null,
  summary: 'The task finished.',
  ...overrides,
});

const issuesOf = (value: unknown): Array<{ path: string; message: string }> => {
  const parsed = mcpCatalogEventSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
};

describe('mcpCatalogEventSchema — the catalog oracle refuses what the catalog forbids', () => {
  it('accepts a row whose kind, category, subject and origin all agree with the catalog', () => {
    expect(issuesOf(row())).toEqual([]);
  });

  it('refuses a kind that is a valid journal kind but not a catalog kind', () => {
    expect(issuesOf(row({ kind: 'item.started' }))).toEqual([{ path: 'kind', message: 'not a catalog kind: item.started' }]);
  });

  it('refuses a row filed under a category its kind does not belong to', () => {
    expect(MCP_EVENT_KIND_CATEGORY['gate.failed']).toBe('E-03');
    expect(issuesOf(row({ kind: 'gate.failed', category: 'E-01' }))).toEqual([
      { path: 'category', message: 'gate.failed belongs to E-03' },
    ]);
  });

  it('refuses a subject type outside the catalog subjects', () => {
    expect(issuesOf(row({ subject: { type: 'widget', id: 'w-1', version: null } }))).toEqual([
      { path: 'subject.type', message: 'not a catalog subject: widget' },
    ]);
  });

  it('refuses an E-04 row that a leader or the system caused — E-04 is a HUMAN change', () => {
    const e04 = { category: 'E-04', kind: 'goal.changed' };
    expect(issuesOf(row({ ...e04, origin: 'human' }))).toEqual([]);
    expect(issuesOf(row({ ...e04, origin: 'system' }))).toEqual([{ path: 'origin', message: 'an E-04 row is a human change' }]);
    expect(issuesOf(row({ ...e04, origin: 'leader', causedBy: 'op-leader-0001' }))).toEqual([
      { path: 'origin', message: 'an E-04 row is a human change' },
    ]);
  });
});
