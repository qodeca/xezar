import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditRecordSchema, type AuditRecord } from '@qodeca/xezar-contract';
import {
  AUDIT_TRAIL_FILE_0_15_0,
  auditEntrySchema as auditEntrySchema0150,
  readAudit0150,
  type AuditEntry as AuditEntry0150,
} from '../../test/fixtures/audit-0.15.0/reader-0.15.0.ts';
import {
  AuditTrail,
  LEGACY_AUDIT_DEPRECATION,
  auditTrailPath,
  legacyAuditTrailPath,
  resetLegacyAuditNoticeForTests,
} from './audit-trail.ts';

/**
 * #306 part 1 — the two never-trimmed compatibility proofs (spec
 * `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 8, § 11 "Old-reader contract").
 *
 *   OLD READERS: the released 0.15.0 reader, frozen under `test/fixtures/audit-0.15.0/`, is run over
 *   every kind of record this code writes. It must not throw; what it keeps and what it quarantines
 *   is the measured compatibility result recorded in BACKWARD_COMPATIBILITY.md.
 *
 *   UPGRADE / DOWNGRADE: a data folder as 0.15.0 wrote it (`data-dir/mcp-audit.ndjson`, produced by
 *   the 0.15.0 writer, whose source is blob-identical to `v0.15.0`) → this version reads it through
 *   the legacy alias and writes `audit.ndjson` → back to the 0.15.0 reader, which must still find
 *   every one of its own entries, byte for byte, and survive the new file beside it.
 *
 * The packaged, two-installed-versions variant of this test is later #306 work (spec § 13 PR 4); this
 * one runs in the fast unit gate against the real reader code and a real 0.15.0-written folder.
 */

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/audit-0.15.0/', import.meta.url));
const PROJECT = 'upgrade-fixture';

let root: string;
let clock = Date.parse('2026-09-17T09:00:00.000Z');
const now = () => new Date((clock += 1000));
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xez-audit-upgrade-'));
  resetLegacyAuditNoticeForTests();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A copy of the folder 0.15.0 left behind. */
const upgradeFolder = (): string => {
  const dir = join(root, 'project', '.local', 'xezar');
  cpSync(join(FIXTURES, 'data-dir'), dir, { recursive: true });
  return dir;
};

/** Every record shape the candidate writes, through its real writer, one per door and outcome. */
async function writeEveryRecordKind(dir: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const trail = new AuditTrail({ projectId: PROJECT, dataDir: dir }, { now, warn: () => undefined });
  const written = [
    await trail.channel('mcp').record(
      {
        action: 'organiseWork.pin',
        resource: { kind: 'run', id: 'run-1' },
        payload: { pinned: true },
        operationId: 'op-upgrade-0001',
        ownerGeneration: '1789080413148-0b6f1c2e-9d4a-4c3b-8e7f-5a6b7c8d9e0f',
        expectedVersion: 'rev1:run:run-1:12:0123456789ab',
      },
      { outcome: 'applied' },
    ),
    await trail.channel('mcp').record({ action: 'projectConfig.setWorkspaceConfig', operationId: 'op-upgrade-0002' }, { outcome: 'refused', reason: 'workspace_settings' }),
    await trail.channel('ui').record({ action: 'run.update', resource: { kind: 'run', id: 'run-1' } }, { outcome: 'applied' }),
    await trail.channel('ui').record({ action: 'run.update', actor: { proxyUser: { value: 'ada', trust: 'asserted-by-proxy' } } }, { outcome: 'refused', reason: 'http_409' }),
    await trail.channel('automation').record({ action: 'automation.launch', actor: { receiptId: 'rcpt-0001' } }, { outcome: 'applied' }),
    await trail.channel('cli').record({ action: 'cli.projects.remove', actor: { command: 'projects.remove' } }, { outcome: 'refused', reason: 'unknown_project' }),
    // #306 part 2 shapes: inventory action ids, `fieldNames`, a proxy user on an applied change, an
    // automation refusal with its automation resource, and a command-line record with its project.
    await trail.channel('mcp').record(
      { action: 'run.pin', resource: { kind: 'run', id: 'run-1' }, payload: { pinned: true }, fieldNames: ['pinned'], operationId: 'op-upgrade-0003' },
      { outcome: 'applied' },
    ),
    await trail.channel('ui').record(
      { action: 'workspace.config.set', actor: { proxyUser: { value: 'ada', trust: 'asserted-by-proxy' } }, payload: { theme: 'dark' }, fieldNames: ['theme'] },
      { outcome: 'applied' },
    ),
    await trail.channel('automation').record(
      { action: 'automation.launch', actor: { receiptId: 'rcpt-0002' }, payload: { automationId: 'auto-1', revision: 3, event: 'issue:7' } },
      { outcome: 'refused', reason: 'unknown_workflow', resource: { kind: 'automation', id: 'auto-1' } },
    ),
    await trail.channel('cli').record({ action: 'cli.serve', actor: { command: 'serve' }, resource: { kind: 'project', id: PROJECT } }, { outcome: 'applied' }),
    // #306 part 4 shapes: the outcomes #577 added, and the configuration writes whose `fieldNames`
    // and digest the redaction seam derives (a key name and a hash, never a value).
    await trail.channel('mcp').record(
      { action: 'run.continue', resource: { kind: 'run', id: 'run-1' }, operationId: 'op-upgrade-0004' },
      { outcome: 'refused', reason: 'conflict' },
    ),
    await trail.channel('mcp').record({ action: 'pr.merge', resource: { kind: 'pr', id: '575' } }, { outcome: 'refused', reason: 'stale_head' }),
    await trail.channel('mcp').record({ action: 'run.git.commit', resource: { kind: 'run', id: 'run-1' } }, { outcome: 'refused', reason: 'quality_blocker' }),
    await trail.channel('mcp').record(
      { action: 'project.config.set', payload: { action: 'set_config', config: { baseBranch: 'main' } }, operationId: 'op-upgrade-0005' },
      { outcome: 'applied' },
    ),
    await trail.channel('cli').record(
      { action: 'cli.projects.tag', actor: { command: 'projects.tag' }, resource: { kind: 'project', id: PROJECT }, payload: { tags: ['release'] } },
      { outcome: 'applied' },
    ),
  ];
  expect(written.every((record) => record !== null)).toBe(true);
  const lines = readFileSync(auditTrailPath(dir), 'utf8').trim().split('\n');
  // A real marker needs a 10 MB rotation (`audit-rotation.test.ts` writes one and pins this same
  // shape); here it is the contract's own, so the 0.15.0 reader still meets every record kind.
  const marker: AuditRecord = { v: 2, seq: lines.length + 1, ts: '2026-09-17T09:10:00.000Z', projectId: PROJECT, kind: 'rotated', previousLastSeq: lines.length };
  expect(auditRecordSchema.safeParse(marker).success).toBe(true);
  return [...lines, JSON.stringify(marker)];
}

describe('the frozen 0.15.0 reader is the released one', () => {
  it('carries the v0.15.0 schema file byte for byte (git blob a602ebc6)', () => {
    const frozen = readFileSync(join(FIXTURES, 'reader-0.15.0.ts'), 'utf8');
    const start = frozen.indexOf('// ---- v0.15.0:packages/contract/src/mcp-audit.ts ----\n');
    const end = frozen.indexOf('// ---- end of v0.15.0:packages/contract/src/mcp-audit.ts ----');
    expect(start).toBeGreaterThan(0);
    const schema = Buffer.from(frozen.slice(start + '// ---- v0.15.0:packages/contract/src/mcp-audit.ts ----\n'.length, end), 'utf8');
    const blob = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${schema.length}\0`), schema])).digest('hex');
    expect(blob).toBe('a602ebc60a258a4859b31c2f22c853a02663227a');
  });

  it('reads the 0.15.0-written fixture completely, which is what makes it a fair judge below', () => {
    const raw = readFileSync(join(FIXTURES, 'data-dir', AUDIT_TRAIL_FILE_0_15_0), 'utf8');
    expect(readAudit0150(raw, PROJECT)).toMatchObject({ quarantined: 0, entries: { length: 5 } });
  });
});

describe('P1-A5: the 0.15.0 reader over every record this version writes', () => {
  it('never throws, keeps none of them, and quarantines each one — the measured break', async () => {
    const lines = await writeEveryRecordKind(join(root, 'fresh'));
    expect(lines).toHaveLength(16);
    const perLine = lines.map((line) => {
      const result = readAudit0150(`${line}\n`, PROJECT);
      return { kind: (JSON.parse(line) as { kind: string; origin?: string }).origin ?? 'rotated', ...result };
    });
    expect(perLine.map(({ kind, entries, quarantined }) => [kind, entries.length, quarantined])).toEqual([
      ['mcp', 0, 1],
      ['mcp', 0, 1],
      ['ui', 0, 1],
      ['ui', 0, 1],
      ['automation', 0, 1],
      ['cli', 0, 1],
      ['mcp', 0, 1],
      ['ui', 0, 1],
      ['automation', 0, 1],
      ['cli', 0, 1],
      ['mcp', 0, 1],
      ['mcp', 0, 1],
      ['mcp', 0, 1],
      ['mcp', 0, 1],
      ['cli', 0, 1],
      ['rotated', 0, 1],
    ]);
    // Not by accident of JSON: each is a well-formed object the 0.15.0 schema itself refuses.
    for (const line of lines) expect(auditEntrySchema0150.safeParse(JSON.parse(line)).success).toBe(false);
  });

  it('keeps every v1 entry and skips every v2 record in a file that holds both', async () => {
    const v1 = readFileSync(join(FIXTURES, 'data-dir', AUDIT_TRAIL_FILE_0_15_0), 'utf8').trim().split('\n');
    const v2 = await writeEveryRecordKind(join(root, 'fresh'));
    const mixed = v1.flatMap((line, i) => [line, v2[i] ?? '']).concat(v2.slice(v1.length)).join('\n');
    expect(() => readAudit0150(mixed, PROJECT)).not.toThrow();
    const read = readAudit0150(mixed, PROJECT);
    expect(read.entries.map((e) => e.action)).toEqual(v1.map((line) => (JSON.parse(line) as AuditEntry0150).action));
    expect(read.quarantined).toBe(v2.length);
  });
});

describe('P1-A6: 0.15.0 → this version → 0.15.0', () => {
  it('upgrades without touching the old file, and downgrades with no crash and no lost entry', async () => {
    const dir = upgradeFolder();
    const legacyPath = legacyAuditTrailPath(dir);
    expect(legacyPath).toBe(join(dir, AUDIT_TRAIL_FILE_0_15_0));
    const legacyBytes = readFileSync(legacyPath);
    const before0150 = readAudit0150(legacyBytes.toString('utf8'), PROJECT);
    expect(before0150).toMatchObject({ quarantined: 0, entries: { length: 5 } });

    // UPGRADE. The new version reads the old history through the alias, once, and says so once.
    const warn = vi.fn();
    const upgraded = new AuditTrail({ projectId: PROJECT, dataDir: dir }, { now, warn });
    const legacyRead = upgraded.read();
    expect(legacyRead.source).toBe('legacy');
    expect(legacyRead.entries).toEqual(before0150.entries);
    expect(warn.mock.calls).toEqual([[LEGACY_AUDIT_DEPRECATION]]);

    // It starts a new v2 history beside it; from now on the new file is the one it reads.
    await writeEveryRecordKind(dir);
    expect(readdirSync(dir).sort()).toEqual(['audit.ndjson', 'mcp-audit.ndjson']);
    const currentRead = upgraded.read();
    expect(currentRead.source).toBe('current');
    expect(currentRead.entries.map((e) => (e as { seq: number }).seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(sha(readFileSync(legacyPath))).toBe(sha(legacyBytes));

    // DOWNGRADE. 0.15.0 reads its own file name: every entry it wrote is still there, unchanged.
    const after0150 = readAudit0150(readFileSync(legacyPath, 'utf8'), PROJECT);
    expect(after0150).toEqual(before0150);
    // And the file it has never heard of does not crash it, even if someone points it there.
    expect(() => readAudit0150(readFileSync(auditTrailPath(dir), 'utf8'), PROJECT)).not.toThrow();

    // 0.15.0 keeps appending to its own file after the downgrade, exactly as it did before.
    const v1Line: AuditEntry0150 = { v: 1, ts: '2026-09-18T08:00:00.000Z', projectId: PROJECT, action: 'taskCreate.start', outcome: 'ok', origin: 'mcp' };
    expect(auditEntrySchema0150.safeParse(v1Line).success).toBe(true);
    appendFileSync(legacyPath, `${JSON.stringify(v1Line)}\n`);
    expect(readAudit0150(readFileSync(legacyPath, 'utf8'), PROJECT).entries).toHaveLength(6);

    // UPGRADE AGAIN. The new file still wins: the histories are never merged or duplicated.
    resetLegacyAuditNoticeForTests();
    const again = new AuditTrail({ projectId: PROJECT, dataDir: dir }, { now, warn });
    const reread = again.read();
    expect(reread.source).toBe('current');
    // Only the fifteen v2 records: none of the six 0.15.0 entries is merged in.
    expect(reread.entries).toHaveLength(15);
    expect(existsSync(legacyPath)).toBe(true);
  });
});
