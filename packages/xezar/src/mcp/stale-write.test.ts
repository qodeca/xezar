import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MCP_STALE_VERSION_GUIDANCE,
  executionFailedSchema,
  staleVersionRejectionSchema,
  versionedMutationDoneSchema,
  versionedMutationOutcomeSchema,
} from '@qodeca/xezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import {
  canonicalJson,
  guardedMutation,
  guardedRunMutation,
  runVersion,
  versionToken,
} from './stale-write.ts';

/**
 * #100 — a leader mutation based on state a human has since changed is REJECTED (N-03, S-04, A-13).
 *
 * Every case drives the real `RunStore`, and the "human" makes the same store call the cockpit's
 * route makes (`setArchived` for `PATCH …/archive`, `setPinned` for `…/pin`), because N-02 is the
 * point: one set of business rules, whoever calls it.
 */

let dataDir: string;
let store: RunStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'xez-stale-write-'));
  store = RunStore.open(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function createRun(title = 'fix the login bug'): RunRecord {
  return store.createRun({
    title,
    workflow: 'quick-task',
    task: title,
    steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }],
  });
}

/** The run exactly as the store holds it, detached from the live object the store keeps mutating. */
function snapshot(runId: string): RunRecord {
  return structuredClone(store.getRun(runId)!);
}

function eventsFile(runId: string): string {
  try {
    return readFileSync(join(dataDir, 'runs', `${runId}.ndjson`), 'utf8');
  } catch {
    return '';
  }
}

/** The on-disk index right now — `flush` skips the 300 ms debounce. */
function runsJson(): unknown {
  store.flush();
  return JSON.parse(readFileSync(join(dataDir, 'runs.json'), 'utf8'));
}

describe('acceptance 1 — a human changed the run after the leader read it', () => {
  it('rejects the stale mutation, leaves the human state untouched and tells the leader to re-read', () => {
    const run = createRun();
    const leaderRead = runVersion(store, run.id); // the leader reads the task
    store.setArchived(run.id, true); // …a human archives it in the cockpit

    const afterHuman = snapshot(run.id);
    const indexAfterHuman = runsJson();
    const eventsAfterHuman = eventsFile(run.id);
    const apply = vi.fn(() => store.setPinned(run.id, true));

    const result = guardedRunMutation(store, run.id, leaderRead, apply);

    expect(apply).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'conflict',
      applied: false,
      error: 'stale_version',
      resource: { kind: 'run', id: run.id },
      currentVersion: runVersion(store, run.id),
      changedSince: true,
      guidance: MCP_STALE_VERSION_GUIDANCE,
    });
    expect(result.status === 'conflict' && result.guidance).toMatch(/Read the current state and decide again/);
    // The human's state is unchanged — in memory, in runs.json and in the event journal.
    expect(snapshot(run.id)).toEqual(afterHuman);
    expect(runsJson()).toEqual(indexAfterHuman);
    expect(eventsFile(run.id)).toBe(eventsAfterHuman);
  });

  it('hands back the CURRENT token, so the leader can decide again after a fresh read', () => {
    const run = createRun();
    const stale = runVersion(store, run.id);
    store.updateRun(run.id, { title: 'renamed by a human', titleOrigin: 'user' });

    const rejected = guardedRunMutation(store, run.id, stale, () => store.setPinned(run.id, true));
    expect(rejected.status).toBe('conflict');
    const fresh = runVersion(store, run.id);
    expect(rejected.status === 'conflict' && rejected.currentVersion).toBe(fresh);
    expect(fresh).not.toBe(stale);

    // A new decision on the fresh read goes through.
    const retried = guardedRunMutation(store, run.id, fresh, () => store.setPinned(run.id, true));
    expect(retried.status).toBe('done');
    expect(store.getRun(run.id)?.pinned).toBe(true);
    expect(store.getRun(run.id)?.title).toBe('renamed by a human');
  });

  it('rejects when a human only appended to the run history — the seq half catches A→B→A', () => {
    const run = createRun();
    const stale = runVersion(store, run.id);
    // Nothing in the decision projection moves, but the run's history does: a human sent a message.
    store.appendEvent(run.id, { type: 'user-message', text: 'actually, stop after the tests' });

    const apply = vi.fn(() => store.setPinned(run.id, true));
    const result = guardedRunMutation(store, run.id, stale, apply);
    expect(result.status).toBe('conflict');
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects when a human deleted the run — with no current token to hand back', () => {
    const run = createRun();
    const stale = runVersion(store, run.id);
    store.deleteRun(run.id);

    const apply = vi.fn(() => store.setPinned(run.id, true));
    const result = guardedRunMutation(store, run.id, stale, apply);
    expect(apply).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'conflict',
      applied: false,
      error: 'stale_version',
      resource: { kind: 'run', id: run.id },
      changedSince: true,
      guidance: MCP_STALE_VERSION_GUIDANCE,
    });
    expect('currentVersion' in result).toBe(false);
    expect(store.getRun(run.id)).toBeUndefined();
  });
});

describe('acceptance 2 — concurrent calls', () => {
  it('lets exactly one of several concurrent leader mutations on the same read win', async () => {
    const run = createRun();
    const token = runVersion(store, run.id);
    const titles = ['one', 'two', 'three', 'four', 'five'];

    const results = await Promise.all(
      titles.map(async (title) => {
        await Promise.resolve(); // each call arrives on its own turn, as separate tool calls do
        return guardedRunMutation(store, run.id, token, () => store.updateRun(run.id, { title, titleOrigin: 'user' }));
      }),
    );

    const winners = results.filter((r) => r.status === 'done');
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.status === 'conflict')).toHaveLength(titles.length - 1);
    const winner = winners[0]!;
    expect(winner.status === 'done' && winner.value?.title).toBe(store.getRun(run.id)?.title);
  });
});

describe('acceptance 3 — a matching version still succeeds', () => {
  it('applies the mutation and returns the token AFTER it', () => {
    const run = createRun();
    const token = runVersion(store, run.id);

    const result = guardedRunMutation(store, run.id, token, () => store.setPinned(run.id, true));

    expect(result.status).toBe('done');
    expect(store.getRun(run.id)?.pinned).toBe(true);
    const after = runVersion(store, run.id);
    expect(after).not.toBe(token);
    expect(result.status === 'done' && result.version).toBe(after);
    // …and that token is good for the next decision without another read.
    const next = guardedRunMutation(store, run.id, after, () => store.setPinned(run.id, false));
    expect(next.status).toBe('done');
    expect(store.getRun(run.id)?.pinned).toBeUndefined();
  });

  it('is not invalidated by telemetry or presentation — a running agent does not make every write stale', () => {
    const run = createRun();
    const token = runVersion(store, run.id);
    store.updateRun(run.id, { tokensUsed: 4096, costUsd: 0.37, peakRssBytes: 1 << 30, peakProcCount: 12 });
    store.setRead(run.id);

    expect(runVersion(store, run.id)).toBe(token);
    expect(guardedRunMutation(store, run.id, token, () => store.setPinned(run.id, true)).status).toBe('done');
  });
});

describe('the populated-input guarantee — what must never read as a match', () => {
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['unparseable', 'not a token at all'],
  ])('rejects an %s expectedVersion rather than applying', (_label, expectedVersion) => {
    const run = createRun();
    const apply = vi.fn(() => store.setPinned(run.id, true));
    const result = guardedRunMutation(store, run.id, expectedVersion, apply);
    expect(result.status).toBe('conflict');
    expect(apply).not.toHaveBeenCalled();
    expect(store.getRun(run.id)?.pinned).toBeUndefined();
  });

  it('rejects an unknown format tag even when the rest of the token is current', () => {
    const run = createRun();
    const current = runVersion(store, run.id)!;
    const result = guardedRunMutation(store, run.id, current.replace(/^rev1:/, 'rev2:'), () => store.setPinned(run.id, true));
    expect(result.status).toBe('conflict');
  });

  it("rejects another run's current token", () => {
    const run = createRun('one');
    const other = createRun('two');
    const result = guardedRunMutation(store, run.id, runVersion(store, other.id), () => store.setPinned(run.id, true));
    expect(result.status).toBe('conflict');
    expect(store.getRun(run.id)?.pinned).toBeUndefined();
  });
});

describe('U-M05 — "rejected, nothing applied" and "failed after execution" are two shapes', () => {
  it('reports a thrown effect as failed-after-execution, without the error text', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const run = createRun();
      const token = runVersion(store, run.id);
      const result = guardedRunMutation(store, run.id, token, () => {
        store.updateRun(run.id, { title: 'half-done' });
        throw new Error('gh: token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected');
      });

      expect(result).toEqual(executionFailedSchema.parse(result));
      expect(result.status).toBe('failed');
      expect(JSON.stringify(result)).not.toContain('ghp_');
      // It really ran — which is exactly why it must not read as "nothing applied".
      expect(store.getRun(run.id)?.title).toBe('half-done');
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses an async effect: its write would land outside the critical section', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const current = { ref: { kind: 'automation', id: 'a1' }, projection: { enabled: true } };
      // @ts-expect-error — an async `apply` is a compile error; this proves the run-time guard too.
      const result = guardedMutation({
        resource: current.ref,
        expectedVersion: versionToken(current),
        read: () => current,
        apply: async () => {
          throw new Error('late');
        },
      });
      expect(result.status).toBe('failed');
      await Promise.resolve(); // the swallowed rejection does not surface as an unhandled one
    } finally {
      warn.mockRestore();
    }
  });

  it('matches the contract exactly, for every outcome', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const run = createRun();
      const stale = guardedRunMutation(store, run.id, 'rev1:run:x:0:000000000000', () => undefined);
      const done = guardedRunMutation(store, run.id, runVersion(store, run.id), () => undefined);
      const failed = guardedRunMutation(store, run.id, runVersion(store, run.id), () => {
        throw new Error('boom');
      });

      expect(staleVersionRejectionSchema.parse(stale)).toEqual(stale);
      expect(failed).toEqual(executionFailedSchema.parse(failed));
      const { value: _value, ...wire } = done as Extract<typeof done, { status: 'done' }>;
      expect(versionedMutationDoneSchema.parse(wire)).toEqual(wire);
      for (const outcome of [stale, failed, wire]) {
        expect(versionedMutationOutcomeSchema.safeParse(outcome).success).toBe(true);
      }
      // The two unhappy shapes cannot be mistaken for one another.
      expect(executionFailedSchema.safeParse(stale).success).toBe(false);
      expect(staleVersionRejectionSchema.safeParse(failed).success).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the token', () => {
  it('has the D-06 shape rev1:<kind>:<id>:<seq>:<digest12>', () => {
    const run = createRun();
    expect(runVersion(store, run.id)).toBe(`rev1:run:${run.id}:0:${runVersion(store, run.id)!.slice(-12)}`);
    store.appendEvent(run.id, { type: 'user-message', text: 'hello' });
    expect(runVersion(store, run.id)).toMatch(new RegExp(`^rev1:run:${run.id}:1:[0-9a-f]{12}$`));
  });

  it('uses - for a resource with no event stream', () => {
    expect(versionToken({ ref: { kind: 'automation', id: 'a1' }, projection: { enabled: true } })).toMatch(
      /^rev1:automation:a1:-:[0-9a-f]{12}$/,
    );
  });

  it('is undefined for a run that does not exist', () => {
    expect(runVersion(store, 'no-such-run')).toBeUndefined();
  });

  it('does not depend on key order, and drops undefined keys', () => {
    const ref = { kind: 'config', id: 'project' };
    expect(versionToken({ ref, projection: { a: 1, b: { c: 2, d: [1, 2] } } })).toBe(
      versionToken({ ref, projection: { b: { d: [1, 2], c: 2 }, a: 1, e: undefined } }),
    );
    expect(versionToken({ ref, projection: { d: [1, 2] } })).not.toBe(versionToken({ ref, projection: { d: [2, 1] } }));
  });
});

describe('canonicalJson', () => {
  it('sorts keys by code unit at every level, including integer-like keys', () => {
    expect(canonicalJson({ b: 1, a: { 9: 'x', 10: 'y' } })).toBe('{"a":{"10":"y","9":"x"},"b":1}');
  });

  it('keeps array order and writes undefined array items as null, like JSON.stringify', () => {
    expect(canonicalJson([3, undefined, { z: undefined, y: null }])).toBe('[3,null,{"y":null}]');
  });
});
