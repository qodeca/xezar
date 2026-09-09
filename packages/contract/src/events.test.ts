import { describe, expect, it } from 'vitest';
import { runEventSchema } from './events.ts';
import { uiStateSchema } from './workspace.ts';

/**
 * The open half of the contract (#61).
 *
 * Two shapes here are `z.looseObject` — zod v4's spelling of `.passthrough()` — and both are open
 * as a DURABILITY promise, not an oversight: the NDJSON event vocabulary is append-only
 * (BACKWARD_COMPATIBILITY.md §7) and `ui-state.json` is a user-owned bag an older server must not
 * strip. A closed schema in either place silently deletes a newer xezar's data on read-back, and
 * the type system cannot tell the two apart.
 */

describe('runEventSchema', () => {
  it('round-trips an unknown key through parse and serialize', () => {
    const frame: unknown = {
      seq: 7,
      ts: '2026-01-01T00:00:00.000Z',
      stepId: 'implement',
      type: 'tool-use-from-a-newer-xezar',
      // Not named by the schema — an NDJSON recording written by a newer version.
      payloadFromTheFuture: { nested: ['a', 1, true] },
    };

    const parsed = runEventSchema.parse(frame);

    expect(parsed).toHaveProperty('payloadFromTheFuture');
    // Serialize too: replaying a recording means writing the frame back out. A key that survives
    // the parse but not the round trip is still a lost frame.
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(frame);
  });

  it('still enforces the required envelope around the open payload', () => {
    const result = runEventSchema.safeParse({ ts: '2026-01-01T00:00:00.000Z', type: 'text' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['seq']]);
  });
});

describe('uiStateSchema', () => {
  it('keeps a preference key it does not name', () => {
    const stored: unknown = {
      runsView: 'table',
      lastWorktree: false,
      // A pref a NEWER cockpit writes. This server has never heard of it and must hand it back
      // untouched, or the newer cockpit loses the setting every time an older one reads the file.
      somePrefFromANewerCockpit: 'keep me',
    };

    const parsed = uiStateSchema.parse(stored);

    expect(JSON.parse(JSON.stringify(parsed))).toEqual(stored);
  });
});
