import { describe, expect, it } from 'vitest';

import {
  TASK_VERDICT_FINDINGS_MAX,
  TASK_VERDICT_FINDINGS_MAX_BYTES,
  TASK_VERDICT_FINDING_BODY_MAX,
  TASK_VERDICT_FINDING_FILE_MAX,
  TASK_VERDICT_FINDING_ID_MAX,
  TASK_VERDICT_FINDING_SEVERITY,
  TASK_VERDICT_FINDING_TITLE_MAX,
  TASK_VERDICT_SEVERITY_ORDER,
  taskVerdictPacketSchema,
  taskVerdictSchema,
  type TaskVerdictFinding,
} from './task-verdict.ts';

/**
 * #673 — the findings shape, at the schema itself.
 *
 * The ingestion half (what reaches the run record, what is refused into `verdictIssues`, what the
 * redactor scrubs) lives in `packages/xezar/src/runs/task-verdicts.test.ts`. What is pinned HERE is
 * the contract's own answer to one packet, for both unions — because a rule enforced on the
 * reported packet and not on the recorded one holds only until the first consumer builds a record
 * some other way.
 */

const SHA = 'a'.repeat(40);

function packet(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'report-1',
    taskId: 'task-1',
    stepId: 'review',
    role: 'code-review',
    verdict: 'REQUEST CHANGES',
    reviewedHeadSha: SHA,
    summary: 'two blockers',
    recordedAt: '2026-09-20T00:00:00.000Z',
    labels: { requestedAdd: [], requestedRemove: [], observed: [], state: 'verified' },
    ...over,
  };
}

/** The same packet as the RECORD holds it — the second union, with the engine's own stamps. */
function recorded(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...packet(over),
    source: 'task-reported',
    ingestedAt: '2026-09-20T00:00:01.000Z',
    publication: 'pending',
  };
}

function finding(over: Partial<TaskVerdictFinding> = {}): Record<string, unknown> {
  return { id: 'f1', severity: 'major', title: 'the cap is gone', ...over };
}

/** Both unions answer the same question about findings, so every rule is asserted against both. */
const unions = [
  { name: 'the reported packet', schema: taskVerdictPacketSchema, build: packet },
  { name: 'the recorded verdict', schema: taskVerdictSchema, build: recorded },
] as const;

describe('#673 — a findings list is bounded, paired and unique (break: drop R1, R2 or R3)', () => {
  it.each(unions)('$name accepts a complete list with its counter', ({ schema, build }) => {
    const parsed = schema.safeParse(build({ findings: [finding()], findingsOmitted: 0 }));

    expect(parsed.success).toBe(true);
  });

  it.each(unions)('$name accepts a packet with no findings at all', ({ schema, build }) => {
    const parsed = schema.safeParse(build());

    expect(parsed.success).toBe(true);
    // Absent, not defaulted to `[]`: "reported none in this form" is not "there were none".
    expect(parsed.success && 'findings' in parsed.data).toBe(false);
  });

  // R1, in both of its directions.
  it.each(unions)('$name refuses a findings list with no omitted count', ({ schema, build }) => {
    const parsed = schema.safeParse(build({ findings: [finding()] }));

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toContain('findingsOmitted');
  });

  it.each(unions)('$name refuses an omitted count with no findings list', ({ schema, build }) => {
    const parsed = schema.safeParse(build({ findingsOmitted: 3 }));

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toContain('findings');
  });

  it.each(unions)('$name accepts an empty list with a zero counter — AC-10', ({ schema, build }) => {
    const parsed = schema.safeParse(build({ verdict: 'APPROVE', findings: [], findingsOmitted: 0 }));

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.findings).toEqual([]);
  });

  it.each(unions)('$name refuses one finding over the count bound — AC-05', ({ schema, build }) => {
    const many = Array.from({ length: TASK_VERDICT_FINDINGS_MAX + 1 }, (_unused, index) =>
      finding({ id: `f${index}` }),
    );

    const parsed = schema.safeParse(build({ findings: many, findingsOmitted: 0 }));

    expect(parsed.success).toBe(false);
    // Refused whole. Keeping the first 20 would be the silent drop the counter exists to prevent.
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toContain('findings');
  });

  // R2. The count bound and the byte bound bite at different times, on purpose.
  it.each(unions)('$name refuses a findings array over the byte bound — AC-04', ({ schema, build }) => {
    // Twenty MAXIMAL findings — every field at its own character bound. Each one is legal on its
    // own and the count is legal, which is the point: the two bounds bite at different times.
    const fat = Array.from({ length: TASK_VERDICT_FINDINGS_MAX }, (_unused, index) =>
      finding({
        id: `f${index}`.padEnd(TASK_VERDICT_FINDING_ID_MAX, 'i'),
        file: 'x'.repeat(TASK_VERDICT_FINDING_FILE_MAX),
        title: 'x'.repeat(TASK_VERDICT_FINDING_TITLE_MAX),
        body: 'x'.repeat(TASK_VERDICT_FINDING_BODY_MAX),
        fingerprint: 'x'.repeat(TASK_VERDICT_FINDING_ID_MAX),
      }),
    );
    expect(JSON.stringify(fat).length).toBeGreaterThan(TASK_VERDICT_FINDINGS_MAX_BYTES);

    const parsed = schema.safeParse(build({ findings: fat, findingsOmitted: 0 }));

    expect(parsed.success).toBe(false);
    const message = parsed.error?.issues.find((issue) => issue.path.join('.') === 'findings')?.message ?? '';
    expect(message).toContain(String(TASK_VERDICT_FINDINGS_MAX_BYTES));
    // The packet is untrusted text: a refusal names the field and never quotes a value.
    expect(message).not.toContain('x'.repeat(20));
  });

  it.each(unions)('$name counts the byte bound in BYTES, not characters', ({ schema, build }) => {
    // Every character here is four UTF-8 bytes, so a list well under 16 384 CHARACTERS is over
    // 16 384 bytes. A character-counted bound would accept this.
    const emoji = '🙂'.repeat(TASK_VERDICT_FINDING_BODY_MAX);
    const fat = Array.from({ length: 15 }, (_unused, index) => finding({ id: `f${index}`, body: emoji }));
    expect(JSON.stringify(fat).length).toBeLessThan(TASK_VERDICT_FINDINGS_MAX_BYTES);

    expect(schema.safeParse(build({ findings: fat, findingsOmitted: 0 })).success).toBe(false);
  });

  // R3.
  it.each(unions)('$name refuses two findings wearing one id', ({ schema, build }) => {
    const parsed = schema.safeParse(
      build({ findings: [finding({ id: 'f1' }), finding({ id: 'f1', title: 'another' })], findingsOmitted: 0 }),
    );

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain('two findings carry one finding id');
  });
});

describe('#673 — one finding is a pointer, and an absent field is never a value', () => {
  it('refuses a line number with no file — AC-09', () => {
    const parsed = taskVerdictPacketSchema.safeParse(
      packet({ findings: [finding({ line: 412 })], findingsOmitted: 0 }),
    );

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toContain('findings.0.line');
  });

  it('accepts a file with a line, and a file without one', () => {
    const parsed = taskVerdictPacketSchema.safeParse(
      packet({
        findings: [
          finding({ id: 'f1', file: 'packages/xezar/src/runs/store.ts', line: 412 }),
          finding({ id: 'f2', file: 'packages/xezar/src/runs/store.ts' }),
        ],
        findingsOmitted: 0,
      }),
    );

    expect(parsed.success).toBe(true);
  });

  it('refuses a key the producer invented, rather than stripping it', () => {
    // `.strictObject`, not the package default: a silently stripped key is exactly how a kit-only
    // `findings` vanished before this issue, and a producer must learn that its key went nowhere.
    const parsed = taskVerdictPacketSchema.safeParse(
      packet({ findings: [{ ...finding(), disposition: 'filed as #1' }], findingsOmitted: 0 }),
    );

    expect(parsed.success).toBe(false);
  });

  it('refuses an empty title, an empty id and a zero line', () => {
    for (const bad of [finding({ title: '' }), finding({ id: '' }), finding({ file: 'a.ts', line: 0 })]) {
      expect(taskVerdictPacketSchema.safeParse(packet({ findings: [bad], findingsOmitted: 0 })).success).toBe(
        false,
      );
    }
  });

  it('keeps a truncated report readable as truncated', () => {
    const parsed = taskVerdictPacketSchema.safeParse(
      packet({ findings: [finding()], findingsOmitted: 7 }),
    );

    expect(parsed.success && parsed.data.findingsOmitted).toBe(7);
  });
});

/**
 * RP-1.5 — a GUARD, and it passes either way.
 *
 * Moving `severity` to one shared enum outside the arms would leave every assertion below green,
 * because the three role vocabularies are identical TODAY. It is here to pin the behaviour this PR
 * did NOT change (the words themselves, and their order), not to catch the shape regression; the
 * per-role shape is what makes a future role-specific word additive rather than breaking, and no
 * test can prove that until such a word exists. Said plainly rather than left to be discovered.
 */
describe('#673 — the severity vocabulary (guard: passes with or without the per-role shape)', () => {
  it('gives every role the same four words today', () => {
    for (const role of ['code-review', 'design-review', 'qa'] as const) {
      expect(TASK_VERDICT_FINDING_SEVERITY[role]).toEqual(['blocker', 'major', 'minor', 'nit']);
    }
  });

  it('orders them most-serious first, so no consumer re-invents the order', () => {
    expect(TASK_VERDICT_SEVERITY_ORDER).toEqual(['blocker', 'major', 'minor', 'nit']);
  });

  it('refuses a severity word that is not one of them', () => {
    const parsed = taskVerdictPacketSchema.safeParse(
      packet({ findings: [finding({ severity: 'critical' as TaskVerdictFinding['severity'] })], findingsOmitted: 0 }),
    );

    expect(parsed.success).toBe(false);
  });

  it('accepts each role carrying its own words', () => {
    const roles = [
      { role: 'code-review', verdict: 'REQUEST CHANGES' },
      { role: 'design-review', verdict: 'PASS WITH FOLLOW-UPS' },
      { role: 'qa', verdict: 'FAIL' },
    ] as const;

    for (const { role, verdict } of roles) {
      for (const severity of TASK_VERDICT_FINDING_SEVERITY[role]) {
        const parsed = taskVerdictPacketSchema.safeParse(
          packet({ role, verdict, findings: [finding({ severity })], findingsOmitted: 0 }),
        );
        expect(parsed.success).toBe(true);
      }
    }
  });
});
