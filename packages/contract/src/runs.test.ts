import { describe, expect, it } from 'vitest';
import { runRecordSchema } from './runs.ts';
import { runnerSchema } from './health.ts';

/**
 * The contract package's first own suite (#61).
 *
 * Everything here asserts behaviour the TYPE system cannot express — what a schema does with a
 * payload that is not the shape it was written against. The package is Node-free by construction
 * (`types: []` in its tsconfig), so these tests are too: no `node:*` import, no filesystem, no
 * fixture loader. A plain object literal IS the wire.
 */

/**
 * A `runs.json` record as an OLDER xezar wrote it: before `pinned`/`pinnedAt` (#935), before the
 * numeric `diffStat` (#389), and before the directional token counters split `tokensUsed` into
 * `inputTokens`/`outputTokens`. Every one of those arrived optional precisely so this object
 * keeps parsing — `src/runs/store.ts` `safeParse`s the WHOLE array, so one record that fails
 * takes every other run in the file with it (BACKWARD_COMPATIBILITY.md §3).
 */
const legacyRecord: unknown = {
  id: 'r-2024',
  title: 'an old task',
  workflow: 'quick-task',
  task: 'do the thing',
  status: 'done',
  createdAt: '2026-01-01T00:00:00.000Z',
  tokensUsed: 1234,
  archived: false,
  steps: [
    {
      id: 'implement',
      name: 'Implement',
      kind: 'agent',
      status: 'done',
      iterations: 1,
      tokensUsed: 1234,
    },
  ],
};

describe('runRecordSchema', () => {
  it('parses a record written before pinned, diffStat and the directional token counters', () => {
    const parsed = runRecordSchema.parse(legacyRecord);

    expect(parsed.id).toBe('r-2024');
    expect(parsed.archived).toBe(false);
    // Absent, not defaulted: "this run predates the field" must stay distinguishable from a
    // value the store never wrote. `pinned: false` here would make every old run look unpinned
    // BY DECISION rather than by omission, and the store deliberately never writes `false`.
    expect('pinned' in parsed).toBe(false);
    expect(parsed.diffStat).toBeUndefined();
    expect(parsed.inputTokens).toBeUndefined();
    expect(parsed.outputTokens).toBeUndefined();
    expect(parsed.steps[0]?.inputTokens).toBeUndefined();
  });

  it('drops an unknown extra key — the record is a CLOSED object', () => {
    const parsed = runRecordSchema.parse({ ...(legacyRecord as object), somethingNewer: 42 });

    // The counterpart of the open bags (`uiStateSchema`, `runEventSchema`): a run record is a
    // route's answer, re-derived on every read, so a key the schema does not name is noise a
    // consumer must not start depending on. See `events.test.ts` for the other half.
    expect('somethingNewer' in parsed).toBe(false);
    expect(JSON.parse(JSON.stringify(parsed))).not.toHaveProperty('somethingNewer');
  });

  it('reports a missing required field at its own issue path', () => {
    const { archived: _archived, ...withoutArchived } = legacyRecord as Record<string, unknown>;
    const result = runRecordSchema.safeParse(withoutArchived);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['archived']]);
  });

  it('reports a bad nested step field at its indexed path', () => {
    const result = runRecordSchema.safeParse({
      ...(legacyRecord as object),
      steps: [{ ...((legacyRecord as { steps: unknown[] }).steps[0] as object), kind: 'wizard' }],
    });

    expect(result.success).toBe(false);
    // The index is part of the path — a consumer rendering "which step is broken" reads it.
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['steps', 0, 'kind']]);
  });

  it('refuses the legacy runner id on the wire', () => {
    // `claude-cli` is the legacy spelling of `claude`, and a stored `runs.json` record may still
    // carry it. The fold lives at the STORAGE boundary — `storedRunnerSchema` in
    // `packages/xezar/src/runs/store.ts` parses the legacy id and collapses it to `claude`
    // one-way, so that "no consumer, wire type or contract schema ever sees a fourth runner".
    //
    // This pins the second half of that promise, the half this package owns: the wire enum has
    // exactly three selectable ids plus `pi`, and widening it here would make the store's fold
    // pointless and let a client ASK for the legacy spelling.
    expect(runnerSchema.safeParse('claude-cli').success).toBe(false);
    expect(runnerSchema.safeParse('claude').success).toBe(true);

    expect(runRecordSchema.safeParse({ ...(legacyRecord as object), runner: 'claude-cli' }).success)
      .toBe(false);
    const folded = runRecordSchema.parse({ ...(legacyRecord as object), runner: 'claude' });
    expect(folded.runner).toBe('claude');
  });
});
