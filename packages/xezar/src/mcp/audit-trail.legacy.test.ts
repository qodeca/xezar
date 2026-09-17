import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditActionRecord, AuditEntry } from '@qodeca/xezar-contract';
import {
  AUDIT_TRAIL_FILE,
  AuditTrail,
  LEGACY_AUDIT_DEPRECATION,
  LEGACY_AUDIT_TRAIL_FILE,
  auditTrailPath,
  legacyAuditTrailPath,
  resetLegacyAuditNoticeForTests,
} from './audit-trail.ts';

/**
 * #306 part 1 — the file rename, the read-only legacy alias and the per-file sequence (spec
 * `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 8, § 3.2 and § 13 "PR 1").
 *
 * The legacy bytes come from a trail that the 0.15.0 writer produced (`test/fixtures/audit-0.15.0`),
 * never from a JSON line typed by hand.
 */

const LEGACY_FIXTURE = fileURLToPath(new URL('../../test/fixtures/audit-0.15.0/data-dir/mcp-audit.ndjson', import.meta.url));
const FIXTURE_PROJECT = 'upgrade-fixture';

let root: string;
let clock = Date.parse('2026-09-17T09:00:00.000Z');
const now = () => new Date((clock += 1000));
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const fileState = (path: string) => {
  const st = statSync(path);
  return { sha: sha(path), size: st.size, mode: st.mode & 0o777, mtimeMs: st.mtimeMs };
};

const dataDirWithLegacy = (): string => {
  const dir = join(root, 'project', '.local', 'xezar');
  mkdirSync(dir, { recursive: true });
  copyFileSync(LEGACY_FIXTURE, legacyAuditTrailPath(dir));
  return dir;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xez-audit-legacy-'));
  resetLegacyAuditNoticeForTests();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the file names (#306)', () => {
  it('writes audit.ndjson and keeps mcp-audit.ndjson only as the legacy name', () => {
    expect([AUDIT_TRAIL_FILE, LEGACY_AUDIT_TRAIL_FILE]).toEqual(['audit.ndjson', 'mcp-audit.ndjson']);
  });
});

describe('P1-A2: only the legacy file exists', () => {
  it('returns its v1 rows read-only, leaves its bytes alone, and says so once per process', () => {
    const dir = dataDirWithLegacy();
    const before = fileState(legacyAuditTrailPath(dir));
    const warn = vi.fn();
    const trail = new AuditTrail({ projectId: FIXTURE_PROJECT, dataDir: dir }, { now, warn });

    const first = trail.read();
    expect(first.source).toBe('legacy');
    expect(first.quarantined).toBe(0);
    expect((first.entries as AuditEntry[]).map((e) => [e.v, e.action, e.outcome])).toEqual([
      [1, 'organiseWork.pin', 'ok'],
      [1, 'executionControl.cancel', 'rejected'],
      [1, 'handoffGit.push', 'unverified'],
      [1, 'taskCreate.start', 'unverified'],
      [1, 'organiseWork.listQueue', 'ok'],
    ]);
    // Read again, and from a second trail over the same project: still exactly one line per process.
    trail.read();
    new AuditTrail({ projectId: FIXTURE_PROJECT, dataDir: dir }, { now, warn }).read();
    expect(warn.mock.calls).toEqual([[LEGACY_AUDIT_DEPRECATION]]);

    expect(fileState(legacyAuditTrailPath(dir))).toEqual(before);
    expect(existsSync(auditTrailPath(dir))).toBe(false);
  });

  it('does not hand a legacy row naming another project to this one', () => {
    const dir = dataDirWithLegacy();
    const read = new AuditTrail({ projectId: 'someone-else', dataDir: dir }, { now, warn: () => undefined }).read();
    expect(read).toEqual({ source: 'legacy', entries: [], quarantined: 0 });
  });
});

describe('P1-A3: both names exist', () => {
  it('returns only audit.ndjson rows, never merges the histories, and changes neither file by reading', async () => {
    const dir = dataDirWithLegacy();
    const warn = vi.fn();
    const trail = new AuditTrail({ projectId: FIXTURE_PROJECT, dataDir: dir }, { now, warn });
    await trail.channel('mcp').record({ action: 'organiseWork.pin', resource: { kind: 'run', id: 'run-new' } }, { outcome: 'applied' });
    const legacyBefore = fileState(legacyAuditTrailPath(dir));
    const currentBefore = fileState(auditTrailPath(dir));

    const read = trail.read();
    expect(read.source).toBe('current');
    expect((read.entries as AuditActionRecord[]).map((e) => [e.v, e.seq, e.resource?.id])).toEqual([[2, 1, 'run-new']]);
    // The new file wins silently: no deprecation line, because the legacy file was not read.
    expect(warn).not.toHaveBeenCalled();

    expect(fileState(legacyAuditTrailPath(dir))).toEqual(legacyBefore);
    expect(fileState(auditTrailPath(dir))).toEqual(currentBefore);
  });

  it('keeps the new file authoritative even when it is empty', () => {
    const dir = dataDirWithLegacy();
    writeFileSync(auditTrailPath(dir), '');
    const trail = new AuditTrail({ projectId: FIXTURE_PROJECT, dataDir: dir }, { now, warn: () => undefined });
    expect(trail.read()).toEqual({ source: 'current', entries: [], quarantined: 0 });
  });
});

describe('neither name exists', () => {
  it('reads as an empty current trail, silently', () => {
    const warn = vi.fn();
    const trail = new AuditTrail({ projectId: 'alpha', dataDir: join(root, 'nowhere') }, { now, warn });
    expect(trail.read()).toEqual({ source: 'current', entries: [], quarantined: 0 });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('P1-A4: writing never touches the legacy file', () => {
  it('creates audit.ndjson owner-only beside it, and the legacy bytes, mode and time stay as 0.15.0 left them', async () => {
    const dir = dataDirWithLegacy();
    const before = fileState(legacyAuditTrailPath(dir));
    const trail = new AuditTrail({ projectId: FIXTURE_PROJECT, dataDir: dir }, { now, warn: () => undefined });
    trail.read();
    const mcp = trail.channel('mcp');
    for (let i = 0; i < 3; i += 1) await mcp.record({ action: 'organiseWork.pin', operationId: `op-legacy-000${i}` }, { outcome: 'applied' });

    expect(fileState(legacyAuditTrailPath(dir))).toEqual(before);
    expect(statSync(auditTrailPath(dir)).mode & 0o777).toBe(0o600);
    const lines = readFileSync(auditTrailPath(dir), 'utf8').trim().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as { v: number; seq: number }).seq)).toEqual([1, 2, 3]);
  });
});

describe('the sequence (spec § 3.2)', () => {
  const channelIn = (dir: string, warn = vi.fn()) =>
    new AuditTrail({ projectId: 'alpha', dataDir: dir }, { now, warn }).channel('mcp');
  const seqs = (dir: string) =>
    new AuditTrail({ projectId: 'alpha', dataDir: dir }, { now }).read().entries.map((e) => (e as AuditActionRecord).seq);

  it('grows by one per record, across separate trails over the same file, with no cache', async () => {
    const dir = join(root, 'alpha');
    mkdirSync(dir);
    await channelIn(dir).record({ action: 'runs.pin' }, { outcome: 'applied' });
    await channelIn(dir).record({ action: 'runs.pin' }, { outcome: 'refused', reason: 'stale_version' });
    const one = channelIn(dir);
    await one.record({ action: 'runs.pin' }, { outcome: 'applied' });
    // Another writer appends between two writes of `one`: `one` must not reuse a value it remembered.
    await channelIn(dir).record({ action: 'runs.pin' }, { outcome: 'applied' });
    await one.record({ action: 'runs.pin' }, { outcome: 'applied' });
    expect(seqs(dir)).toEqual([1, 2, 3, 4, 5]);
  });

  it('continues from the last valid record past a torn tail, and never glues a record onto it', async () => {
    const dir = join(root, 'alpha');
    mkdirSync(dir);
    await channelIn(dir).record({ action: 'runs.pin' }, { outcome: 'applied' });
    await channelIn(dir).record({ action: 'runs.pin' }, { outcome: 'applied' });
    // A crash mid-append: half a line and no newline.
    appendFileSync(auditTrailPath(dir), '{"v":2,"seq":3,"kind":"act');
    const written = await channelIn(dir).record({ action: 'runs.pin' }, { outcome: 'applied' });
    expect(written?.seq).toBe(3);
    const read = new AuditTrail({ projectId: 'alpha', dataDir: dir }, { now }).read();
    expect(read.quarantined).toBe(1);
    expect(read.entries.map((e) => (e as AuditActionRecord).seq)).toEqual([1, 2, 3]);
  });

  it('allocates nothing for a failed write: the next record takes the next value after the last persisted one', async () => {
    const dir = join(root, 'alpha');
    mkdirSync(dir);
    const warn = vi.fn();
    const mcp = channelIn(dir, warn);
    await mcp.record({ action: 'runs.pin' }, { outcome: 'applied' });
    expect(await mcp.record({ action: 'not an action id' }, { outcome: 'applied' })).toBeNull();
    expect(mcp.skip('tool_error')).toBeNull();
    expect((await mcp.record({ action: 'runs.pin' }, { outcome: 'applied' }))?.seq).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('ignores lines that are not v2 records when it looks for the last value', async () => {
    const dir = join(root, 'alpha');
    mkdirSync(dir);
    writeFileSync(auditTrailPath(dir), `${readFileSync(LEGACY_FIXTURE, 'utf8')}{"v":2,"seq":99}\n`);
    expect((await channelIn(dir).record({ action: 'runs.pin' }, { outcome: 'applied' }))?.seq).toBe(1);
  });

  it('finds the last value in a trail longer than one tail read, including a line split across two reads', async () => {
    const dir = join(root, 'alpha');
    mkdirSync(dir);
    const mcp = channelIn(dir);
    // Large payload-free records: 400 of them is well past the 64 KiB tail window.
    for (let i = 0; i < 400; i += 1) {
      await mcp.record(
        { action: 'runs.pin', resource: { kind: 'run', id: `run-${'x'.repeat(100)}-${i}` }, operationId: `op-long-${String(i).padStart(4, '0')}` },
        { outcome: 'applied' },
      );
    }
    expect(statSync(auditTrailPath(dir)).size).toBeGreaterThan(64 * 1024);
    // Bury the last valid record under more than a tail window of garbage lines.
    appendFileSync(auditTrailPath(dir), `${'{"torn":'.padEnd(200, 'z')}\n`.repeat(400));
    expect((await mcp.record({ action: 'runs.pin' }, { outcome: 'applied' }))?.seq).toBe(401);
  });
});
