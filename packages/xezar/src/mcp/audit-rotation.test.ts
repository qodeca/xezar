import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditRecordSchema, type AuditActionRecord, type AuditRecord } from '@qodeca/xezar-contract';
import {
  AUDIT_ROTATE_BYTES,
  AuditTrail,
  LEGACY_AUDIT_TRAIL_FILE,
  auditLockPath,
  auditTrailPath,
  legacyAuditTrailPath,
  rotatedAuditTrailPath,
} from './audit-trail.ts';

/**
 * #306 part 3 — one lock, one sequence, `0600` modes and the 10 MB / five-file rotation. Spec
 * `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 7, § 11 and § 13 "PR 3".
 *
 * The cross-process cases run REAL child processes (`audit-rotation.worker.testkit.ts`): two
 * writers in one vitest worker are serialized by the in-process queue and prove nothing about two
 * xezar processes. A file barrier holds both children at the `beforeLock` point until both have
 * arrived, so the race is decided by the code under test and not by the scheduler.
 *
 * `named break:` cases each fail against a deliberate defect; the red runs are kept in the
 * implementing task's evidence.
 *
 * The file limit is the real 10,000,000 bytes, never a smaller test knob: the fixtures write one
 * near-full live file of valid records.
 */

const worker = fileURLToPath(new URL('./audit-rotation.worker.testkit.ts', import.meta.url));
const tsxLoader = import.meta.resolve('tsx');
const PROJECT = 'alpha';
const WARNING = /^xezar: audit trail write failed \(([A-Za-z0-9_]+)\); the action continued without an audit record\.$/;

let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xez-audit-rotation-'));
  dataDir = join(root, PROJECT, '.local', 'xezar');
  mkdirSync(dataDir, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** One valid v2 action line, as a door would have written it. */
const actionLine = (seq: number, id: string): string =>
  JSON.stringify({
    v: 2,
    seq,
    ts: '2026-09-17T10:00:00.000Z',
    projectId: PROJECT,
    kind: 'action',
    origin: 'cli',
    actor: { type: 'cli', command: 'run' },
    action: 'cli.run',
    resource: { kind: 'run', id },
    outcome: { status: 'applied' },
  } satisfies AuditActionRecord);

/** Write `seqs` as a file of valid records. Returns the file's bytes. */
function writeRecords(path: string, seqs: readonly number[], mode = 0o600): string {
  const text = seqs.map((seq) => `${actionLine(seq, `seed-${seq}`)}\n`).join('');
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return text;
}

/**
 * A live file of valid records exactly `FILL_GAP` bytes under the limit, so the next record of any
 * door crosses it. A leading blank line (readers skip it) makes the size exact. Starts at
 * `firstSeq`; returns the last sequence written.
 */
const FILL_GAP = 16;
function fillLive(firstSeq: number, mode = 0o600): number {
  const lines: string[] = [];
  let size = 0;
  let seq = firstSeq;
  for (;;) {
    const line = `${actionLine(seq, `fill-${seq}`)}\n`;
    if (size + line.length > AUDIT_ROTATE_BYTES - FILL_GAP - 1) break;
    lines.push(line);
    size += line.length;
    seq += 1;
  }
  writeFileSync(auditTrailPath(dataDir), `${' '.repeat(AUDIT_ROTATE_BYTES - FILL_GAP - size - 1)}\n${lines.join('')}`, { mode });
  chmodSync(auditTrailPath(dataDir), mode);
  expect(statSync(auditTrailPath(dataDir)).size).toBe(AUDIT_ROTATE_BYTES - FILL_GAP);
  return seq - 1;
}

/** Every parsed record of one file, in file order. */
const recordsOf = (path: string): AuditRecord[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => auditRecordSchema.parse(JSON.parse(line)));

/** The retention set, oldest first, as it exists on disk. */
const retainedPaths = (): string[] =>
  [4, 3, 2, 1].map((generation) => rotatedAuditTrailPath(dataDir, generation)).concat(auditTrailPath(dataDir)).filter(existsSync);

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const modeOf = (path: string): number => statSync(path).mode & 0o777;

interface WorkerResult {
  code: number | null;
  out: { record: AuditActionRecord | null; warnings: string[] } | undefined;
  stderr: string;
}

/** Start one writer process. The agent-session variables never reach it. */
function startWriter(spec: { resourceId: string; barrier?: string; crashAfterRename?: boolean }): Promise<WorkerResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, VITEST: '' };
  delete env.XEZ_HANDOFF_FILE;
  delete env.XEZ_TODOS_FILE;
  delete env.XEZ_TASK_ID;
  const child = spawn(process.execPath, ['--import', tsxLoader, worker, JSON.stringify({ dataDir, projectId: PROJECT, ...spec })], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return once(child, 'exit').then(([code]) => ({
    code: code as number | null,
    out: stdout.trim() ? (JSON.parse(stdout.trim()) as WorkerResult['out']) : undefined,
    stderr,
  }));
}

/** Release two writers together: both must be waiting at the barrier before either may take the lock. */
async function raceTwoWriters(): Promise<[WorkerResult, WorkerResult]> {
  const barrier = join(root, 'barrier');
  mkdirSync(barrier);
  const writers = [startWriter({ resourceId: 'race-a', barrier }), startWriter({ resourceId: 'race-b', barrier })] as const;
  const deadline = Date.now() + 60_000;
  while (!(existsSync(join(barrier, 'ready-race-a')) && existsSync(join(barrier, 'ready-race-b')))) {
    if (Date.now() > deadline) throw new Error('writers never reached the barrier');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  writeFileSync(join(barrier, 'go'), '');
  return Promise.all(writers);
}

/** Every record of the retention set, oldest first, with the retained files that hold them. */
const everyRecord = (): AuditRecord[] => retainedPaths().flatMap(recordsOf);

describe('AC-P3-01: two processes cross the limit at the same moment', () => {
  it('named break `B-ROTATE-OUTSIDE-LOCK`: both action ids kept once, ordered unique sequences, one marker, five files', async () => {
    // A full retention set, so the rotation must drop `.4` to stay at five files.
    const seeded = [4, 3, 2, 1].map((generation, i) => writeRecords(rotatedAuditTrailPath(dataDir, generation), [i * 2 + 1, i * 2 + 2]));
    const lastFilled = fillLive(9);
    const oldLive = sha(auditTrailPath(dataDir));

    const results = await raceTwoWriters();
    for (const result of results) {
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.out?.warnings).toEqual([]);
      expect(result.out?.record).not.toBeNull();
    }

    // Five retained files, no sixth, and no lock left behind.
    expect(readdirSync(dataDir).sort()).toEqual(['audit.ndjson', 'audit.ndjson.1', 'audit.ndjson.2', 'audit.ndjson.3', 'audit.ndjson.4']);
    // Exactly one generation moved: the old live file is `.1`, and the old `.4` is gone.
    expect(sha(rotatedAuditTrailPath(dataDir, 1))).toBe(oldLive);
    expect(readFileSync(rotatedAuditTrailPath(dataDir, 4), 'utf8')).toBe(seeded[1]);

    const all = everyRecord();
    const markers = all.filter((record) => record.kind === 'rotated');
    expect(markers).toEqual([expect.objectContaining({ seq: lastFilled + 1, previousLastSeq: lastFilled })]);
    // The new live file starts with the marker, and both racing actions follow it.
    const live = recordsOf(auditTrailPath(dataDir));
    expect(live.map((record) => record.kind)).toEqual(['rotated', 'action', 'action']);
    const raced = all.filter((record) => record.kind === 'action' && record.resource?.id.startsWith('race-'));
    expect(raced.map((record) => (record as AuditActionRecord).resource?.id).sort()).toEqual(['race-a', 'race-b']);
    // Unique, strictly increasing, consecutive across the whole retained set.
    const seqs = all.map((record) => record.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs.slice(-3)).toEqual([lastFilled + 1, lastFilled + 2, lastFilled + 3]);
    // What each process was told is exactly what is on disk.
    expect(results.map((result) => result.out?.record?.seq).sort()).toEqual([lastFilled + 2, lastFilled + 3]);
    for (const path of retainedPaths()) expect(modeOf(path)).toBe(0o600);
  }, 90_000);

  it('named break `B-WRITER-SEQ`: two processes appending below the limit never share a sequence', async () => {
    writeRecords(auditTrailPath(dataDir), [1, 2, 3]);
    const results = await raceTwoWriters();
    for (const result of results) expect(result.code).toBe(0);
    const live = recordsOf(auditTrailPath(dataDir));
    expect(live.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(live.slice(3).map((record) => (record as AuditActionRecord).resource?.id).sort()).toEqual(['race-a', 'race-b']);
    expect(readdirSync(dataDir)).toEqual(['audit.ndjson']);
  }, 90_000);
});

describe('AC-P3-02: after a rotation', () => {
  it('named break `B-MODE-NO-REPAIR`: the live file starts with one marker, five files remain, every one 0600', async () => {
    // Every existing file starts group/world-readable: rotation must repair them, not only create new ones.
    const seeded = [4, 3, 2, 1].map((generation, i) =>
      writeRecords(rotatedAuditTrailPath(dataDir, generation), [i * 2 + 1, i * 2 + 2], 0o644),
    );
    const lastFilled = fillLive(9, 0o644);
    const oldLive = sha(auditTrailPath(dataDir));
    // The legacy file is not part of the set and is never touched.
    const legacy = legacyAuditTrailPath(dataDir);
    writeFileSync(legacy, '{"v":1}\n', { mode: 0o644 });
    chmodSync(legacy, 0o644);
    const legacyHash = sha(legacy);

    const warn = vi.fn();
    const trail = new AuditTrail({ projectId: PROJECT, dataDir }, { warn });
    const record = await trail.channel('ui').record({ action: 'run.pin', resource: { kind: 'run', id: 'after-rotation' } }, { outcome: 'applied' });

    expect(warn).not.toHaveBeenCalled();
    expect(record?.seq).toBe(lastFilled + 2);
    expect(readdirSync(dataDir).sort()).toEqual([
      'audit.ndjson',
      'audit.ndjson.1',
      'audit.ndjson.2',
      'audit.ndjson.3',
      'audit.ndjson.4',
      LEGACY_AUDIT_TRAIL_FILE,
    ]);
    const liveLines = readFileSync(auditTrailPath(dataDir), 'utf8').trimEnd().split('\n');
    expect(liveLines).toHaveLength(2);
    expect(JSON.parse(liveLines[0]!)).toEqual({
      v: 2,
      seq: lastFilled + 1,
      ts: expect.stringMatching(/Z$/),
      projectId: PROJECT,
      kind: 'rotated',
      previousLastSeq: lastFilled,
    });
    expect(JSON.parse(liveLines[1]!)).toMatchObject({ seq: lastFilled + 2, kind: 'action', resource: { id: 'after-rotation' } });
    // Generations shifted by exactly one; the oldest was dropped.
    expect(sha(rotatedAuditTrailPath(dataDir, 1))).toBe(oldLive);
    expect(readFileSync(rotatedAuditTrailPath(dataDir, 2), 'utf8')).toBe(seeded[3]);
    expect(readFileSync(rotatedAuditTrailPath(dataDir, 3), 'utf8')).toBe(seeded[2]);
    expect(readFileSync(rotatedAuditTrailPath(dataDir, 4), 'utf8')).toBe(seeded[1]);
    for (const path of retainedPaths()) expect(modeOf(path)).toBe(0o600);
    // The live file is under the limit it rotated for, and the legacy file is exactly as it was.
    expect(statSync(auditTrailPath(dataDir)).size).toBeLessThan(AUDIT_ROTATE_BYTES);
    expect(sha(legacy)).toBe(legacyHash);
    expect(modeOf(legacy)).toBe(0o644);
    expect(existsSync(auditLockPath(dataDir))).toBe(false);

    // A reader sees the whole retained history, oldest first, and skips the marker.
    const read = trail.read();
    expect(read.source).toBe('current');
    const seqs = read.entries.map((entry) => (entry as AuditActionRecord).seq);
    expect(seqs[0]).toBe(3);
    expect(seqs.at(-1)).toBe(lastFilled + 2);
    expect(seqs).not.toContain(lastFilled + 1);
    expect(read.quarantined).toBe(0);
  }, 60_000);

  it('named break `B-MODE-NO-REPAIR`: an ordinary append repairs an existing live file to 0600 first', async () => {
    writeRecords(auditTrailPath(dataDir), [1], 0o644);
    writeRecords(rotatedAuditTrailPath(dataDir, 1), [0 + 1], 0o640);
    const record = await new AuditTrail({ projectId: PROJECT, dataDir }).channel('cli').record(
      { action: 'cli.init', actor: { command: 'init' } },
      { outcome: 'applied' },
    );
    expect(record?.seq).toBe(2);
    expect(modeOf(auditTrailPath(dataDir))).toBe(0o600);
    expect(modeOf(rotatedAuditTrailPath(dataDir, 1))).toBe(0o600);
  });

  it('rotates a torn last line away untouched at the boundary, so the next record starts a clean line', async () => {
    const lastFilled = fillLive(1);
    writeFileSync(auditTrailPath(dataDir), `${readFileSync(auditTrailPath(dataDir), 'utf8')}{"torn":`);
    const torn = sha(auditTrailPath(dataDir));
    const record = await new AuditTrail({ projectId: PROJECT, dataDir }).channel('cli').record(
      { action: 'cli.init', actor: { command: 'init' } },
      { outcome: 'applied' },
    );
    // The torn line is not a record, so the last allocated sequence is still the last valid one.
    expect(record?.seq).toBe(lastFilled + 2);
    expect(sha(rotatedAuditTrailPath(dataDir, 1))).toBe(torn);
    expect(recordsOf(auditTrailPath(dataDir))).toEqual([
      expect.objectContaining({ kind: 'rotated', seq: lastFilled + 1, previousLastSeq: lastFilled }),
      expect.objectContaining({ kind: 'action', seq: lastFilled + 2 }),
    ]);
  }, 60_000);
});

describe('AC-P3-04: a rotation that crashed between its rename and its marker', () => {
  it('named break `B-CRASH-NO-MARKER`: the next lock holder writes the marker from the maximum retained sequence, and no invented action', async () => {
    const lastFilled = fillLive(1);
    const crashed = await startWriter({ resourceId: 'lost-in-crash', crashAfterRename: true });
    expect(crashed.code).toBe(86);
    // The crash state, produced by a real process dying under the lock.
    expect(existsSync(auditTrailPath(dataDir))).toBe(false);
    expect(existsSync(rotatedAuditTrailPath(dataDir, 1))).toBe(true);
    expect(existsSync(auditLockPath(dataDir))).toBe(true);

    const started = Date.now();
    const warn = vi.fn();
    const record = await new AuditTrail({ projectId: PROJECT, dataDir }, { warn }).channel('mcp').record(
      { action: 'run.cancel', resource: { kind: 'run', id: 'after-crash' } },
      { outcome: 'applied' },
    );
    // The dead owner's lock is taken over at once, not after the 2 s bound.
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(warn).not.toHaveBeenCalled();
    expect(record?.seq).toBe(lastFilled + 2);
    const live = recordsOf(auditTrailPath(dataDir));
    expect(live).toEqual([
      expect.objectContaining({ kind: 'rotated', seq: lastFilled + 1, previousLastSeq: lastFilled }),
      expect.objectContaining({ kind: 'action', seq: lastFilled + 2, resource: { kind: 'run', id: 'after-crash' } }),
    ]);
    expect(everyRecord().some((r) => r.kind === 'action' && r.resource?.id === 'lost-in-crash')).toBe(false);
    for (const path of retainedPaths()) expect(modeOf(path)).toBe(0o600);
    expect(existsSync(auditLockPath(dataDir))).toBe(false);
  }, 60_000);

  it('repairs an empty live file the crash left behind the same way, and the maximum of the rotations wins', async () => {
    writeRecords(rotatedAuditTrailPath(dataDir, 2), [1, 2]);
    writeRecords(rotatedAuditTrailPath(dataDir, 1), [3, 7]);
    writeFileSync(auditTrailPath(dataDir), '', { mode: 0o600 });
    const record = await new AuditTrail({ projectId: PROJECT, dataDir }).channel('cli').record(
      { action: 'cli.init', actor: { command: 'init' } },
      { outcome: 'applied' },
    );
    expect(record?.seq).toBe(9);
    expect(recordsOf(auditTrailPath(dataDir))).toEqual([
      expect.objectContaining({ kind: 'rotated', seq: 8, previousLastSeq: 7 }),
      expect.objectContaining({ kind: 'action', seq: 9 }),
    ]);
  });

  it('starts at 1 with no marker when there is no history at all', async () => {
    const record = await new AuditTrail({ projectId: PROJECT, dataDir }).channel('cli').record(
      { action: 'cli.init', actor: { command: 'init' } },
      { outcome: 'applied' },
    );
    expect(record?.seq).toBe(1);
    expect(recordsOf(auditTrailPath(dataDir)).map((r) => r.kind)).toEqual(['action']);
    expect(modeOf(auditTrailPath(dataDir))).toBe(0o600);
  });

  it('continues from the rotations when the live file holds no valid record', async () => {
    writeRecords(rotatedAuditTrailPath(dataDir, 1), [4, 5]);
    writeFileSync(auditTrailPath(dataDir), '{"not":"a record"}\n', { mode: 0o600 });
    const record = await new AuditTrail({ projectId: PROJECT, dataDir }).channel('cli').record(
      { action: 'cli.init', actor: { command: 'init' } },
      { outcome: 'applied' },
    );
    expect(record?.seq).toBe(6);
    // Not a crash (the live file is not empty), so no marker: the junk line stays, the action follows it.
    const lines = readFileSync(auditTrailPath(dataDir), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({ kind: 'action', seq: 6 });
  });
});

describe('AC-P3-03: a failed audit write never changes the action, and warns once', () => {
  /** A user action with a visible effect, run through the channel exactly as a door runs it. */
  async function sentinelAction(trail: AuditTrail): Promise<{ result: string; effect: string[] }> {
    const effect: string[] = [];
    const result = await trail.channel('ui').run({ action: 'run.pin', resource: { kind: 'run', id: 'sentinel' } }, () => {
      effect.push('applied');
      return 'the user result';
    });
    return { result, effect };
  }

  it('named break `B-FAIL-CLOSED`: an unwritable folder', async () => {
    chmodSync(dataDir, 0o500);
    try {
      const warn = vi.fn();
      const trail = new AuditTrail({ projectId: PROJECT, dataDir }, { warn });
      await expect(sentinelAction(trail)).resolves.toEqual({ result: 'the user result', effect: ['applied'] });
      await expect(sentinelAction(trail)).resolves.toEqual({ result: 'the user result', effect: ['applied'] });
      expect(warn).toHaveBeenCalledTimes(1);
      const [line] = warn.mock.calls[0] as [string];
      expect(line).toMatch(WARNING);
      expect(line).not.toContain(dataDir);
    } finally {
      chmodSync(dataDir, 0o700);
    }
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it('a lock held by a live process: the record is dropped after the 2 s bound, never written unlocked', async () => {
    writeRecords(auditTrailPath(dataDir), [1]);
    const before = sha(auditTrailPath(dataDir));
    // Held by this very process, freshly stamped: alive and not stale, so nobody may take it over.
    writeFileSync(auditLockPath(dataDir), `${process.pid}\n${Date.now()}\n`, { mode: 0o600 });
    const warn = vi.fn();
    const trail = new AuditTrail({ projectId: PROJECT, dataDir }, { warn });
    const started = Date.now();
    await expect(sentinelAction(trail)).resolves.toEqual({ result: 'the user result', effect: ['applied'] });
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(2_000);
    expect(waited).toBeLessThan(4_500);
    expect(warn.mock.calls).toEqual([[expect.stringMatching(WARNING)]]);
    expect(String(warn.mock.calls[0]?.[0])).toContain('(lock_timeout)');
    expect(sha(auditTrailPath(dataDir))).toBe(before);
    // Somebody else's lock is not ours to remove.
    expect(existsSync(auditLockPath(dataDir))).toBe(true);
  }, 15_000);

  it('a data folder that does not exist: dropped with the one warning, and nothing created', async () => {
    const missing = join(root, 'never-created', '.local', 'xezar');
    const warn = vi.fn();
    const trail = new AuditTrail({ projectId: PROJECT, dataDir: missing }, { warn });
    await expect(sentinelAction(trail)).resolves.toEqual({ result: 'the user result', effect: ['applied'] });
    expect(warn.mock.calls).toEqual([['xezar: audit trail write failed (ENOENT); the action continued without an audit record.']]);
    expect(existsSync(missing)).toBe(false);
  });

  it('keeps one warning per trail, so two projects in one process each say it once', async () => {
    chmodSync(dataDir, 0o500);
    const otherDir = join(root, 'bravo', '.local', 'xezar');
    mkdirSync(otherDir, { recursive: true });
    chmodSync(otherDir, 0o500);
    try {
      const warn = vi.fn();
      const alpha = new AuditTrail({ projectId: PROJECT, dataDir }, { warn });
      const bravo = new AuditTrail({ projectId: 'bravo', dataDir: otherDir }, { warn });
      for (const trail of [alpha, bravo, alpha, bravo]) await sentinelAction(trail);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      chmodSync(dataDir, 0o700);
      chmodSync(otherDir, 0o700);
    }
  });

  it('serializes writers inside one process without waiting on its own file lock, however the folder is spelled', async () => {
    const trail = new AuditTrail({ projectId: PROJECT, dataDir });
    // The same folder reached through a `..` detour: one queue, because the queue keys the absolute path.
    const detour = join(dataDir, '..', 'xezar');
    const channels = [trail.channel('ui'), new AuditTrail({ projectId: PROJECT, dataDir: detour }).channel('mcp')];
    const started = Date.now();
    const records = await Promise.all(
      Array.from({ length: 20 }, (_, i) => channels[i % 2]!.record({ action: 'run.pin', resource: { kind: 'run', id: `r-${i}` } }, { outcome: 'applied' })),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(records.map((record) => record?.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(recordsOf(auditTrailPath(dataDir)).map((record) => (record as AuditActionRecord).resource?.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `r-${i}`),
    );
  });
});
