import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_ROTATE_BYTES, AuditTrail, auditLockPath, auditTrailPath, rotatedAuditTrailPath } from './audit-trail.ts';

/**
 * #306 part 3, AC-P3-03 — the two filesystem failures a test cannot provoke honestly with modes
 * alone: `chmod` refused on a file this user owns, and `rename` refused in the middle of a rotation.
 * Spec `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 7.2 step 8 and § 11 (`Failure
 * unit`, named break `B-FAIL-CLOSED`).
 *
 * `node:fs` is wrapped, not replaced: every call goes to the real module unless the case arms a
 * failure for one function and one path. The unwritable folder and the held lock need no wrapper
 * and live in `audit-rotation.test.ts`.
 */

const failures = vi.hoisted(() => ({ chmod: undefined as string | undefined, rename: undefined as string | undefined }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const refuse = (syscall: string, path: string): never => {
    throw Object.assign(new Error(`${syscall} refused`), { code: 'EPERM', syscall, path });
  };
  return {
    ...real,
    chmodSync: (path: fs.PathLike, mode: fs.Mode) =>
      failures.chmod !== undefined && String(path) === failures.chmod ? refuse('chmod', String(path)) : real.chmodSync(path, mode),
    renameSync: (from: fs.PathLike, to: fs.PathLike) =>
      failures.rename !== undefined && String(from) === failures.rename ? refuse('rename', String(from)) : real.renameSync(from, to),
  };
});

const PROJECT = 'alpha';
const WARNING = 'xezar: audit trail write failed (EPERM); the action continued without an audit record.';

let root: string;
let dataDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'xez-audit-fail-'));
  dataDir = join(root, PROJECT, '.local', 'xezar');
  fs.mkdirSync(dataDir, { recursive: true });
  failures.chmod = undefined;
  failures.rename = undefined;
});
afterEach(() => {
  failures.chmod = undefined;
  failures.rename = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

const line = (seq: number): string =>
  `${JSON.stringify({
    v: 2,
    seq,
    ts: '2026-09-17T10:00:00.000Z',
    projectId: PROJECT,
    kind: 'action',
    origin: 'cli',
    actor: { type: 'cli', command: 'run' },
    action: 'cli.run',
    resource: { kind: 'run', id: `fill-${seq}` },
    outcome: { status: 'applied' },
  })}\n`;

const sha = (path: string): string => createHash('sha256').update(fs.readFileSync(path)).digest('hex');

/** A user action with a visible effect, run through the channel exactly as a door runs it. */
async function sentinelAction(trail: AuditTrail): Promise<{ result: string; effect: string[] }> {
  const effect: string[] = [];
  const result = await trail.channel('mcp').run({ action: 'run.cancel', resource: { kind: 'run', id: 'sentinel' } }, () => {
    effect.push('applied');
    return 'the user result';
  });
  return { result, effect };
}

describe('AC-P3-03: chmod and rename failures', () => {
  it('named break `B-FAIL-CLOSED`: a live file that cannot be made 0600 gets nothing, and the action is unchanged', async () => {
    const live = auditTrailPath(dataDir);
    fs.writeFileSync(live, line(1), { mode: 0o644 });
    fs.chmodSync(live, 0o644);
    const before = sha(live);
    failures.chmod = live;

    const warn = vi.fn();
    const trail = new AuditTrail({ projectId: PROJECT, dataDir }, { warn });
    await expect(sentinelAction(trail)).resolves.toEqual({ result: 'the user result', effect: ['applied'] });
    await expect(sentinelAction(trail)).resolves.toEqual({ result: 'the user result', effect: ['applied'] });

    expect(warn.mock.calls).toEqual([[WARNING]]);
    expect(sha(live)).toBe(before);
    expect(fs.existsSync(auditLockPath(dataDir))).toBe(false);

    // Once the mode can be repaired, the next record lands with the next sequence: nothing was allocated.
    failures.chmod = undefined;
    const record = await trail.channel('mcp').record({ action: 'run.cancel' }, { outcome: 'applied' });
    expect(record?.seq).toBe(2);
    expect(fs.statSync(live).mode & 0o777).toBe(0o600);
  });

  it('named break `B-FAIL-CLOSED`: a rename refused mid-rotation leaves the live history in place, and the next writer rotates it', async () => {
    const live = auditTrailPath(dataDir);
    let text = '';
    let seq = 0;
    while (text.length + line(seq + 1).length <= AUDIT_ROTATE_BYTES - 16) text += line((seq += 1));
    // A leading blank line (readers skip it) brings the file to exactly 16 bytes under the limit.
    fs.writeFileSync(live, `${' '.repeat(AUDIT_ROTATE_BYTES - 16 - text.length - 1)}\n${text}`, { mode: 0o600 });
    const before = sha(live);
    failures.rename = live;

    const warn = vi.fn();
    const trail = new AuditTrail({ projectId: PROJECT, dataDir }, { warn });
    await expect(sentinelAction(trail)).resolves.toEqual({ result: 'the user result', effect: ['applied'] });

    expect(warn.mock.calls).toEqual([[WARNING]]);
    expect(sha(live)).toBe(before);
    expect(fs.existsSync(rotatedAuditTrailPath(dataDir, 1))).toBe(false);
    expect(fs.existsSync(auditLockPath(dataDir))).toBe(false);

    failures.rename = undefined;
    const record = await trail.channel('mcp').record({ action: 'run.cancel' }, { outcome: 'applied' });
    expect(record?.seq).toBe(seq + 2);
    expect(sha(rotatedAuditTrailPath(dataDir, 1))).toBe(before);
    const lines = fs.readFileSync(live, 'utf8').trimEnd().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as { kind: string; seq: number }).seq)).toEqual([seq + 1, seq + 2]);
    // Still the one warning for this trail.
    expect(warn).toHaveBeenCalledTimes(1);
  }, 30_000);
});
