import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TASK_VERDICT_MAX_BYTES,
  isApprovingTaskVerdict,
} from '@qodeca/xezar-contract';

import { RunStore, type RunRecord } from './store.ts';
import { ingestTaskVerdict, markTaskVerdictAnnounced, taskVerdictPacketPath } from './task-verdicts.ts';

/**
 * #460 — a reviewer's report reaches the task record, and nothing that is not one does.
 *
 * T-1 … T-5 of the accepted spec live here, against the REAL `RunStore` and real files. The named
 * break each one exists to catch is quoted on the describe block it guards.
 */

let dataDir: string;
let store: RunStore;

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'xez-verdict-'));
  store = RunStore.open(dataDir);
});

afterEach(() => {
  // Same reason as `mcp/event-catalog.test.ts`: an unflushed store keeps a 300 ms debounced save
  // scheduled, it fires long after this file is done, and the ENOENT it logs into the directory
  // deleted on the next line reaches vitest as a console message with no worker left to take it.
  store.flush();
  rmSync(dataDir, { recursive: true, force: true });
});

function startedRun(stepIds: string[] = ['review']): RunRecord {
  const run = store.createRun({
    title: 'review the login fix',
    workflow: 'code-review',
    task: 'review the login fix',
    steps: stepIds.map((id) => ({ id, name: id, kind: 'agent' as const })),
  });
  store.updateRun(run.id, { status: 'running' });
  return run;
}

/** Write a packet exactly where a reviewing task writes one. */
function writePacket(runId: string, packet: unknown): string {
  const file = taskVerdictPacketPath(dataDir, runId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof packet === 'string' ? packet : JSON.stringify(packet), 'utf8');
  return file;
}

// Deliberately `Record<string, unknown>`: half these cases build packets the schema must REFUSE, and a
// typed override would refuse them here instead — at compile time, where nothing is being tested.
function packetFor(runId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'report-1',
    taskId: runId,
    stepId: 'review',
    role: 'code-review',
    verdict: 'APPROVE',
    reviewedHeadSha: SHA_A,
    summary: 'no blocking findings',
    recordedAt: '2026-09-16T00:00:00.000Z',
    labels: { requestedAdd: [], requestedRemove: [], observed: [], state: 'verified' },
    ...over,
  };
}

function verdictsOf(runId: string) {
  return store.getRun(runId)?.verdicts ?? [];
}

function issuesOf(runId: string) {
  return store.getRun(runId)?.verdictIssues ?? [];
}

// ---- T-1 ---------------------------------------------------------------------------------------

describe('T-1 — every role keeps its own words (break: omit packet persistence, or collapse every successful verdict to APPROVE)', () => {
  const cases = [
    { role: 'code-review', verdict: 'APPROVE', approving: true },
    { role: 'code-review', verdict: 'REQUEST CHANGES', approving: false },
    { role: 'qa', verdict: 'PASS', approving: true },
    { role: 'qa', verdict: 'FAIL', approving: false },
    { role: 'design-review', verdict: 'PASS WITH FOLLOW-UPS', approving: true },
    { role: 'design-review', verdict: 'FAIL', approving: false },
  ] as const;

  it.each(cases)('records $role $verdict verbatim, with its role and reviewed sha', ({ role, verdict, approving }) => {
    const run = startedRun();
    writePacket(run.id, packetFor(run.id, { role, verdict }));

    const result = ingestTaskVerdict(store, dataDir, run.id, 'review');

    expect(result?.outcome).toBe('recorded');
    const [recorded] = verdictsOf(run.id);
    // Verbatim: not normalized, not mapped onto a shared pass/fail, not abbreviated.
    expect(recorded?.verdict).toBe(verdict);
    expect(recorded?.role).toBe(role);
    expect(recorded?.reviewedHeadSha).toBe(SHA_A);
    expect(recorded?.source).toBe('task-reported');
    expect(recorded && isApprovingTaskVerdict(recorded)).toBe(approving);
  });

  it('refuses a verdict word that belongs to another role', () => {
    const run = startedRun();
    // `APPROVE` is the code reviewer's word; QA has no such outcome.
    writePacket(run.id, packetFor(run.id, { role: 'qa', verdict: 'APPROVE' }));

    expect(ingestTaskVerdict(store, dataDir, run.id, 'review')?.outcome).toBe('refused');
    expect(verdictsOf(run.id)).toEqual([]);
  });

  it('refuses PASS WITH FOLLOW-UPS from a role that does not have it', () => {
    const run = startedRun();
    writePacket(run.id, packetFor(run.id, { role: 'qa', verdict: 'PASS WITH FOLLOW-UPS' }));

    expect(ingestTaskVerdict(store, dataDir, run.id, 'review')?.outcome).toBe('refused');
    expect(verdictsOf(run.id)).toEqual([]);
  });
});

// ---- T-2 ---------------------------------------------------------------------------------------

describe('T-2 — nothing unproven becomes an approval (break: accept unvalidated JSON, infer success from done, or coerce unavailable labels to verified [])', () => {
  it('a run with no packet records nothing at all', () => {
    const run = startedRun();

    expect(ingestTaskVerdict(store, dataDir, run.id, 'review')).toBeUndefined();
    expect(verdictsOf(run.id)).toEqual([]);
    expect(issuesOf(run.id)).toEqual([]);
  });

  it('a run that finished done without a packet carries no verdict', () => {
    const run = startedRun();
    ingestTaskVerdict(store, dataDir, run.id, 'review');
    store.updateRun(run.id, { status: 'done', finishedAt: new Date().toISOString() });

    expect(store.getRun(run.id)?.status).toBe('done');
    expect(verdictsOf(run.id)).toEqual([]);
  });

  it.each([
    ['an empty file', ''],
    ['text that is not JSON', 'APPROVE'],
    ['JSON that is not an object', '"APPROVE"'],
  ])('refuses %s and records why', (_what, content) => {
    const run = startedRun();
    writePacket(run.id, content);

    expect(ingestTaskVerdict(store, dataDir, run.id, 'review')?.outcome).toBe('refused');
    expect(verdictsOf(run.id)).toEqual([]);
    expect(issuesOf(run.id)).toHaveLength(1);
  });

  it('refuses a packet that reports on another task', () => {
    const run = startedRun();
    const other = startedRun();
    writePacket(run.id, packetFor(other.id));

    expect(ingestTaskVerdict(store, dataDir, run.id, 'review')?.outcome).toBe('refused');
    expect(verdictsOf(run.id)).toEqual([]);
    expect(verdictsOf(other.id)).toEqual([]);
  });

  it('refuses a packet left by an earlier step when a later step settles', () => {
    const run = startedRun(['review', 'handoff']);
    writePacket(run.id, packetFor(run.id, { stepId: 'review' }));

    expect(ingestTaskVerdict(store, dataDir, run.id, 'handoff')?.outcome).toBe('refused');
    expect(verdictsOf(run.id)).toEqual([]);
  });

  it('refuses a symlink rather than following it out of the data directory', () => {
    const run = startedRun();
    const elsewhere = join(dataDir, 'planted.json');
    writeFileSync(elsewhere, JSON.stringify(packetFor(run.id)), 'utf8');
    const file = taskVerdictPacketPath(dataDir, run.id);
    mkdirSync(dirname(file), { recursive: true });
    symlinkSync(elsewhere, file);

    expect(ingestTaskVerdict(store, dataDir, run.id, 'review')?.outcome).toBe('refused');
    expect(verdictsOf(run.id)).toEqual([]);
    expect(issuesOf(run.id)[0]?.reason).toContain('regular file');
  });

  it('refuses a packet over the byte bound without parsing it', () => {
    const run = startedRun();
    const padded = packetFor(run.id);
    padded.summary = 'x'.repeat(TASK_VERDICT_MAX_BYTES + 1_000);
    writePacket(run.id, padded);

    expect(ingestTaskVerdict(store, dataDir, run.id, 'review')?.outcome).toBe('refused');
    expect(verdictsOf(run.id)).toEqual([]);
    expect(issuesOf(run.id)[0]?.reason).toContain('larger than');
  });

  it('keeps partial label evidence partial', () => {
    const run = startedRun();
    writePacket(
      run.id,
      packetFor(run.id, {
        labels: { requestedAdd: ['qa-approved'], requestedRemove: ['needs-qa'], observed: ['needs-qa'], state: 'partial' },
      }),
    );

    ingestTaskVerdict(store, dataDir, run.id, 'review');

    expect(verdictsOf(run.id)[0]?.labels.state).toBe('partial');
    expect(verdictsOf(run.id)[0]?.labels.observed).toEqual(['needs-qa']);
  });

  it('refuses unavailable label evidence dressed up as a verified empty list', () => {
    const run = startedRun();
    writePacket(
      run.id,
      packetFor(run.id, {
        labels: { requestedAdd: [], requestedRemove: [], observed: [], state: 'unavailable' },
      }),
    );

    expect(ingestTaskVerdict(store, dataDir, run.id, 'review')?.outcome).toBe('refused');
    expect(verdictsOf(run.id)).toEqual([]);
  });

  it('keeps unavailable label evidence distinguishable from a verified empty list', () => {
    const run = startedRun();
    writePacket(
      run.id,
      packetFor(run.id, {
        labels: { requestedAdd: ['qa-approved'], requestedRemove: [], state: 'unavailable' },
      }),
    );

    ingestTaskVerdict(store, dataDir, run.id, 'review');

    const [recorded] = verdictsOf(run.id);
    expect(recorded?.labels.state).toBe('unavailable');
    // The whole distinction: absent, not `[]`.
    expect(recorded?.labels.observed).toBeUndefined();
  });

  it('refuses an abbreviated reviewed sha', () => {
    const run = startedRun();
    writePacket(run.id, packetFor(run.id, { reviewedHeadSha: SHA_A.slice(0, 7) }));

    expect(ingestTaskVerdict(store, dataDir, run.id, 'review')?.outcome).toBe('refused');
    expect(verdictsOf(run.id)).toEqual([]);
  });

  it('parses a record written before verdicts existed and leaves it without one', () => {
    const legacy = join(dataDir, 'runs.json');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify([
        {
          id: 'old-run',
          title: 'an older task',
          workflow: 'quick-task',
          task: 'an older task',
          status: 'done',
          createdAt: '2026-01-01T00:00:00.000Z',
          tokensUsed: 0,
          archived: false,
          steps: [],
        },
      ]),
      'utf8',
    );
    const reopened = RunStore.open(dataDir);

    expect(reopened.getRun('old-run')?.status).toBe('done');
    expect(reopened.getRun('old-run')?.verdicts).toBeUndefined();
  });
});

// ---- T-3 ---------------------------------------------------------------------------------------

describe('T-3 — one report stays one report (break: clear pending before append, or generate a fresh report id during recovery)', () => {
  it('re-reporting the same id with the same content changes nothing', () => {
    const run = startedRun();
    writePacket(run.id, packetFor(run.id));
    ingestTaskVerdict(store, dataDir, run.id, 'review');
    const first = verdictsOf(run.id)[0];

    writePacket(run.id, packetFor(run.id));
    const second = ingestTaskVerdict(store, dataDir, run.id, 'review');

    expect(second?.outcome).toBe('unchanged');
    expect(verdictsOf(run.id)).toHaveLength(1);
    expect(verdictsOf(run.id)[0]).toEqual(first);
  });

  it('refuses a different report wearing an already-recorded id', () => {
    const run = startedRun();
    writePacket(run.id, packetFor(run.id));
    ingestTaskVerdict(store, dataDir, run.id, 'review');

    writePacket(run.id, packetFor(run.id, { verdict: 'REQUEST CHANGES' }));
    const second = ingestTaskVerdict(store, dataDir, run.id, 'review');

    expect(second?.outcome).toBe('refused');
    expect(verdictsOf(run.id)).toHaveLength(1);
    expect(verdictsOf(run.id)[0]?.verdict).toBe('APPROVE');
    expect(issuesOf(run.id)[0]?.reason).toContain('report id');
  });

  it('writes the record as pending, before anything announces it', () => {
    const run = startedRun();
    writePacket(run.id, packetFor(run.id));

    ingestTaskVerdict(store, dataDir, run.id, 'review');

    expect(verdictsOf(run.id)[0]?.publication).toBe('pending');
  });

  it('a pending report survives a restart and is still pending, under the same id', () => {
    const run = startedRun();
    writePacket(run.id, packetFor(run.id));
    ingestTaskVerdict(store, dataDir, run.id, 'review');
    store.flush();

    const reopened = RunStore.open(dataDir);
    const recovered = reopened.getRun(run.id)?.verdicts ?? [];

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.id).toBe('report-1');
    expect(recovered[0]?.publication).toBe('pending');
  });

  it('marking announced is idempotent and only ever moves pending forward', () => {
    const run = startedRun();
    writePacket(run.id, packetFor(run.id));
    ingestTaskVerdict(store, dataDir, run.id, 'review');

    markTaskVerdictAnnounced(store, run.id, 'report-1');
    const announced = verdictsOf(run.id)[0];
    markTaskVerdictAnnounced(store, run.id, 'report-1');

    expect(announced?.publication).toBe('announced');
    expect(verdictsOf(run.id)).toHaveLength(1);
    expect(verdictsOf(run.id)[0]).toEqual(announced);
  });
});

// ---- T-4 ---------------------------------------------------------------------------------------

describe('T-4 — a newer report supersedes its own role only (break: read the packet only from the worktree, or stamp the current head over the reviewed sha)', () => {
  it('a second role is added beside the first, not over it', () => {
    const run = startedRun(['review', 'qa']);
    writePacket(run.id, packetFor(run.id));
    ingestTaskVerdict(store, dataDir, run.id, 'review');

    writePacket(
      run.id,
      packetFor(run.id, { id: 'report-2', stepId: 'qa', role: 'qa', verdict: 'PASS' }),
    );
    ingestTaskVerdict(store, dataDir, run.id, 'qa');

    expect(verdictsOf(run.id).map((verdict) => verdict.role).sort()).toEqual(['code-review', 'qa']);
  });

  it('a newer report for the same role replaces that role and leaves the others alone', () => {
    const run = startedRun(['review', 'qa']);
    writePacket(run.id, packetFor(run.id, { id: 'qa-1', stepId: 'qa', role: 'qa', verdict: 'FAIL' }));
    ingestTaskVerdict(store, dataDir, run.id, 'qa');
    writePacket(run.id, packetFor(run.id, { id: 'cr-1' }));
    ingestTaskVerdict(store, dataDir, run.id, 'review');

    writePacket(
      run.id,
      packetFor(run.id, { id: 'qa-2', stepId: 'qa', role: 'qa', verdict: 'PASS', reviewedHeadSha: SHA_B }),
    );
    ingestTaskVerdict(store, dataDir, run.id, 'qa');

    const byRole = new Map(verdictsOf(run.id).map((verdict) => [verdict.role, verdict]));
    expect(byRole.size).toBe(2);
    expect(byRole.get('qa')?.id).toBe('qa-2');
    expect(byRole.get('qa')?.verdict).toBe('PASS');
    expect(byRole.get('code-review')?.id).toBe('cr-1');
    expect(byRole.get('code-review')?.verdict).toBe('APPROVE');
  });

  it('an older report keeps its own reviewed sha — nothing restamps it', () => {
    const run = startedRun(['review', 'qa']);
    writePacket(run.id, packetFor(run.id, { reviewedHeadSha: SHA_A }));
    ingestTaskVerdict(store, dataDir, run.id, 'review');

    writePacket(
      run.id,
      packetFor(run.id, { id: 'qa-1', stepId: 'qa', role: 'qa', verdict: 'PASS', reviewedHeadSha: SHA_B }),
    );
    ingestTaskVerdict(store, dataDir, run.id, 'qa');

    const byRole = new Map(verdictsOf(run.id).map((verdict) => [verdict.role, verdict]));
    expect(byRole.get('code-review')?.reviewedHeadSha).toBe(SHA_A);
    expect(byRole.get('qa')?.reviewedHeadSha).toBe(SHA_B);
  });

  it('the packet is read from the data directory, so a reclaimed worktree still leaves it readable', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'xez-verdict-wt-'));
    const run = startedRun();
    store.updateRun(run.id, { worktreePath: worktree });
    writePacket(run.id, packetFor(run.id));
    ingestTaskVerdict(store, dataDir, run.id, 'review');

    // Retention reclaims the directory (#483). The record is untouched by that.
    rmSync(worktree, { recursive: true, force: true });
    store.updateRun(run.id, { worktreeReclaimedAt: new Date().toISOString() });
    store.flush();
    const reopened = RunStore.open(dataDir);

    expect(taskVerdictPacketPath(dataDir, run.id).startsWith(dataDir)).toBe(true);
    expect(reopened.getRun(run.id)?.verdicts?.[0]?.verdict).toBe('APPROVE');
  });
});

// ---- T-5 ---------------------------------------------------------------------------------------

describe('T-5 — evidence bounds hold (break: skip the redaction guard, or discard the verdict on a label error)', () => {
  const savedToken = process.env.GITHUB_TOKEN;
  afterEach(() => {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  });

  it('scrubs a secret the reviewer echoed into its summary', () => {
    process.env.GITHUB_TOKEN = 'ghp_averysecrettokenvalue000000000000';
    const run = startedRun();
    writePacket(
      run.id,
      packetFor(run.id, { summary: 'the run failed with ghp_averysecrettokenvalue000000000000 in the log' }),
    );

    ingestTaskVerdict(store, dataDir, run.id, 'review');

    const summary = verdictsOf(run.id)[0]?.summary ?? '';
    expect(summary).not.toContain('ghp_averysecrettokenvalue000000000000');
    expect(summary).toContain('[REDACTED]');
  });

  it('keeps a posted FAIL when the label write did not work', () => {
    const run = startedRun();
    writePacket(
      run.id,
      packetFor(run.id, {
        role: 'qa',
        verdict: 'FAIL',
        labels: { requestedAdd: [], requestedRemove: ['merge-queue'], state: 'unavailable' },
      }),
    );

    ingestTaskVerdict(store, dataDir, run.id, 'review');

    const [recorded] = verdictsOf(run.id);
    expect(recorded?.verdict).toBe('FAIL');
    expect(recorded?.labels.state).toBe('unavailable');
    expect(recorded && isApprovingTaskVerdict(recorded)).toBe(false);
  });

  it('never upgrades partial label evidence to verified on a later read', () => {
    const run = startedRun();
    writePacket(
      run.id,
      packetFor(run.id, {
        labels: { requestedAdd: ['design-approved'], requestedRemove: [], observed: [], state: 'partial' },
      }),
    );
    ingestTaskVerdict(store, dataDir, run.id, 'review');
    store.flush();

    const reopened = RunStore.open(dataDir);

    expect(reopened.getRun(run.id)?.verdicts?.[0]?.labels.state).toBe('partial');
  });

  it('leaves the handoff journal itself untouched', () => {
    const run = startedRun();
    const handoff = join(dataDir, 'runs', `${run.id}.handoff.md`);
    mkdirSync(dirname(handoff), { recursive: true });
    const before = '# Handoff — review the login fix\n\n## Progress log\n\n## Resume notes\n';
    writeFileSync(handoff, before, 'utf8');
    writePacket(run.id, packetFor(run.id));

    ingestTaskVerdict(store, dataDir, run.id, 'review');

    expect(readFileSync(handoff, 'utf8')).toBe(before);
  });

  it('a packet that cannot be read at all is refused, not guessed at', () => {
    const run = startedRun();
    const file = writePacket(run.id, packetFor(run.id));
    chmodSync(file, 0o000);

    const result = ingestTaskVerdict(store, dataDir, run.id, 'review');

    // A root-run environment can still read a 000 file; the assertion that matters either way is
    // that nothing was invented — an unreadable packet is never an approval.
    if (result?.outcome === 'refused') expect(verdictsOf(run.id)).toEqual([]);
    else expect(verdictsOf(run.id)[0]?.source).toBe('task-reported');
    // The packet is consumed whatever happened, so a later step cannot be handed it again.
    expect(existsSync(file)).toBe(false);
  });
});

// ---- T-6 (review of PR 2, findings 3 and 4) ------------------------------------------------------

describe('T-6 — the record is durable before the packet is gone (break: drop the flush after the verdict write, consume the packet before the record is written, or read any lstat failure as "no packet")', () => {
  /** The index exactly as it is ON DISK — not the store's memory, which is what the debounce hides. */
  function onDiskRun(runId: string): Record<string, unknown> | undefined {
    const path = join(dataDir, 'runs.json');
    if (!existsSync(path)) return undefined;
    const rows = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>;
    return rows.find((entry) => entry.id === runId);
  }

  it('has the verdict on disk the moment ingestion returns, not 300 ms later', () => {
    const run = startedRun();
    writePacket(run.id, packetFor(run.id));

    expect(ingestTaskVerdict(store, dataDir, run.id, 'review')?.outcome).toBe('recorded');

    // No timer advanced, no flush by the test: the ordering claim in BACKWARD_COMPATIBILITY.md §2
    // is that the record is durable BEFORE anything announces it, and the announcer's journal
    // append is immediate. A debounced-only write would leave this empty.
    const verdicts = onDiskRun(run.id)?.verdicts as Array<Record<string, unknown>> | undefined;
    expect(verdicts?.[0]).toMatchObject({ id: 'report-1', publication: 'pending' });
  });

  it('keeps the packet when the record write fails, so nothing is lost with nothing recorded', () => {
    const run = startedRun();
    const file = writePacket(run.id, packetFor(run.id));
    const realUpdate = store.updateRun.bind(store);
    store.updateRun = (() => {
      throw new Error('the index could not be written');
    }) as unknown as RunStore['updateRun'];

    try {
      // Never throws at the caller — a reviewer report is evidence about a task, not the task.
      expect(ingestTaskVerdict(store, dataDir, run.id, 'review')).toBeUndefined();
    } finally {
      store.updateRun = realUpdate;
    }

    // Consuming before the write would have removed this and left no record either — the packet,
    // the verdict and the recoverability all lost in one gap.
    expect(existsSync(file)).toBe(true);
    expect(verdictsOf(run.id)).toEqual([]);
  });

  it('records a refusal durably too, before the bad packet is removed', () => {
    const run = startedRun();
    const file = writePacket(run.id, 'not json at all');

    expect(ingestTaskVerdict(store, dataDir, run.id, 'review')?.outcome).toBe('refused');

    expect(existsSync(file)).toBe(false);
    expect(onDiskRun(run.id)?.verdictIssues).toHaveLength(1);
  });

  it('refuses when the packet cannot even be looked up, rather than reading it as "nothing reported"', () => {
    const run = startedRun();
    const file = taskVerdictPacketPath(dataDir, run.id);
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o000);
    let result;
    try {
      result = ingestTaskVerdict(store, dataDir, run.id, 'review');
    } finally {
      chmodSync(dir, 0o700);
    }

    // Root can traverse a 000 directory, so the lookup simply succeeds there and finds nothing;
    // the assertion that holds either way is that a failure to LOOK is never a silent absence.
    if (result === undefined) {
      expect(process.getuid?.()).toBe(0);
    } else {
      expect(result.outcome).toBe('refused');
      expect(issuesOf(run.id)[0]?.reason).toContain('could not be looked up');
    }
    expect(verdictsOf(run.id)).toEqual([]);
  });
});
