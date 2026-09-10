import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditEntrySchema, type AuditEntry } from '@qodeca/xezar-contract';
import {
  AuditRejection,
  AuditTrail,
  auditTrailPath,
  canonicalJson,
  payloadDigest,
  settlementForStatus,
  type AuditedOperation,
} from './audit-trail.ts';

/**
 * #102 — the audit trail. The four acceptance cases are the first four `describe` blocks; the rest
 * pin the guarantees they lean on (server-derived origin, no free text, degrade-never-fail).
 */

const FIXED = new Date('2026-09-11T00:00:00.000Z');
const now = () => FIXED;

let root: string;
const dataDirOf = (project: string) => {
  const dir = join(root, project, '.local', 'xezar');
  mkdirSync(dir, { recursive: true });
  return dir;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xez-audit-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A pin, as both doors would describe it: same action, same resource, same parsed payload. */
const pinOp = (runId: string): AuditedOperation => ({
  action: 'runs.pin',
  resource: { kind: 'run', id: runId },
  payload: { pinned: true },
});

describe('A: a cockpit write and the equivalent MCP write differ only in origin', () => {
  it('stamps each door with its own origin and nothing else apart', async () => {
    const trail = new AuditTrail({ projectId: 'alpha', dataDir: dataDirOf('alpha') }, { now });
    const pinned = new Set<string>();
    const pin = (id: string) => () => {
      pinned.add(id);
      return { id, pinned: true };
    };

    await trail.channel('ui').run(pinOp('run-1'), pin('run-1'));
    await trail.channel('mcp').run(pinOp('run-1'), pin('run-1'));

    const { entries, quarantined } = trail.read();
    expect(quarantined).toBe(0);
    expect(entries).toHaveLength(2);
    const [ui, mcp] = entries as [AuditEntry, AuditEntry];
    expect(ui.origin).toBe('ui');
    expect(mcp.origin).toBe('mcp');
    const { origin: _u, ...uiRest } = ui;
    const { origin: _m, ...mcpRest } = mcp;
    expect(mcpRest).toEqual(uiRest);
    expect(ui).toMatchObject({
      v: 1,
      ts: FIXED.toISOString(),
      projectId: 'alpha',
      action: 'runs.pin',
      resource: { kind: 'run', id: 'run-1' },
      outcome: 'ok',
      payloadDigest: payloadDigest({ pinned: true }),
    });
  });

  it('adds the D-06 join fields for MCP only, leaving the shared fields identical', async () => {
    const trail = new AuditTrail({ projectId: 'alpha', dataDir: dataDirOf('alpha') }, { now });
    // A D-02.3 fencing token, `<wall-clock ms>-<UUIDv4>`, as the receipt journal is handed it.
    const mcpJoin = { operationId: 'op-0001-abcd', ownerGeneration: '1789080413148-0b6f1c2e-9d4a-4c3b-8e7f-5a6b7c8d9e0f' };
    // The cockpit has no operation id or owner generation; D-06 § 10.2 says both are absent for it.
    trail.channel('ui').record({ ...pinOp('run-1'), ...mcpJoin }, { outcome: 'ok' });
    trail.channel('mcp').record({ ...pinOp('run-1'), ...mcpJoin }, { outcome: 'ok' });

    const [ui, mcp] = trail.read().entries as [AuditEntry, AuditEntry];
    expect(ui.operationKey).toBeUndefined();
    expect(ui.ownerGeneration).toBeUndefined();
    expect(mcp.operationKey).toBe('alpha/op-0001-abcd');
    // Only the wall-clock prefix: the full token passes the owner fence, so it is authority.
    expect(mcp.ownerGeneration).toBe(1789080413148);
    expect(readFileSync(auditTrailPath(dataDirOf('alpha')), 'utf8')).not.toContain('0b6f1c2e');
    const shared = ({ origin: _o, operationKey: _k, ownerGeneration: _g, ...rest }: AuditEntry) => rest;
    expect(shared(mcp)).toEqual(shared(ui));
  });

  it('ignores an origin or project the operation itself claims (D-06 § 10.4 rule 1)', () => {
    const trail = new AuditTrail({ projectId: 'alpha', dataDir: dataDirOf('alpha') }, { now });
    const forged = { ...pinOp('run-1'), origin: 'ui', projectId: 'beta' } as AuditedOperation;
    trail.channel('mcp').record(forged, { outcome: 'ok' });
    const [entry] = trail.read().entries;
    expect(entry?.origin).toBe('mcp');
    expect(entry?.projectId).toBe('alpha');
  });
});

describe('B: a rejected operation records its rejection outcome', () => {
  it('records a refusal before the effect as rejected, with its code, and rethrows', async () => {
    const trail = new AuditTrail({ projectId: 'alpha', dataDir: dataDirOf('alpha') }, { now });
    const effect = vi.fn(() => {
      throw new AuditRejection('stale_version');
    });
    await expect(
      trail.channel('mcp').run({ ...pinOp('run-1'), expectedVersion: 'rev1:run:run-1:12:0123456789ab' }, effect),
    ).rejects.toBeInstanceOf(AuditRejection);

    const [entry] = trail.read().entries;
    expect(entry).toMatchObject({
      outcome: 'rejected',
      errorCode: 'stale_version',
      origin: 'mcp',
      versionToken: 'rev1:run:run-1:12:0123456789ab',
    });
  });

  it('maps a route status onto the D-06 outcomes: 4xx rejected, 5xx unverified', () => {
    const trail = new AuditTrail({ projectId: 'alpha', dataDir: dataDirOf('alpha') }, { now });
    const ui = trail.channel('ui');
    ui.recordStatus(pinOp('run-1'), 409);
    ui.recordStatus(pinOp('run-1'), 500);
    ui.recordStatus(pinOp('run-1'), 200);
    expect(trail.read().entries.map((e) => [e.outcome, e.errorCode])).toEqual([
      ['rejected', 'http_409'],
      ['unverified', 'http_500'],
      ['ok', undefined],
    ]);
    expect(settlementForStatus(404)).toEqual({ outcome: 'rejected', errorCode: 'http_404' });
  });

  it('records an effect that failed partway as unverified, never as rejected', async () => {
    const trail = new AuditTrail({ projectId: 'alpha', dataDir: dataDirOf('alpha') }, { now });
    await expect(
      trail.channel('ui').run(pinOp('run-1'), () => {
        throw new Error('disk full after the write began');
      }),
    ).rejects.toThrow('disk full');
    const [entry] = trail.read().entries;
    expect(entry).toMatchObject({ outcome: 'unverified', errorCode: 'effect_failed' });
  });

  it('never lets a recorded attribution stand in for a permission check (N-04, D-06 § 10.4)', async () => {
    const trail = new AuditTrail({ projectId: 'alpha', dataDir: dataDirOf('alpha') }, { now });
    const op: AuditedOperation = { action: 'agentConfig.put', resource: { kind: 'config', id: 'claude.settings' } };
    // A human did it from the cockpit, successfully.
    trail.channel('ui').record(op, { outcome: 'ok' });
    // The same action from MCP, where the caller's own gate refuses it (localHandoff false → 409).
    const effect = vi.fn();
    const localHandoff = false;
    await expect(
      trail.channel('mcp').run(op, () => {
        if (!localHandoff) throw new AuditRejection('local_handoff_required');
        effect();
      }),
    ).rejects.toBeInstanceOf(AuditRejection);
    expect(effect).not.toHaveBeenCalled();
    expect(trail.read().entries.map((e) => [e.origin, e.outcome])).toEqual([
      ['ui', 'ok'],
      ['mcp', 'rejected'],
    ]);
  });
});

describe('C: a credential in the connection configuration never enters the trail (F-15, A-12)', () => {
  it('finds no trace of the planted values anywhere in the trail file', async () => {
    const dataDir = dataDirOf('alpha');
    // D-04's connection file, with a credential-shaped token and an opaque UUID capability token.
    const patToken = `ghp_${'A1b2C3d4E5f6G7h8I9j0'.repeat(2)}`;
    const capability = randomUUID();
    const connection = {
      schemaVersion: 1,
      project: { id: 'alpha', root: join(root, 'alpha'), dataDir },
      service: { pid: 4242, startedAt: FIXED.toISOString() },
      endpoint: { socket: join(root, 'ipc', 'alpha.sock') },
      token: capability,
      credential: patToken,
    };
    const connectionFile = join(dataDir, 'mcp-connection.json');
    writeFileSync(connectionFile, JSON.stringify(connection));

    // The MCP door reads the connection it serves and tells the trail what its secrets are.
    const loaded = JSON.parse(readFileSync(connectionFile, 'utf8')) as typeof connection;
    const trail = new AuditTrail(
      { projectId: loaded.project.id, dataDir },
      { now, secretValues: () => [loaded.token, loaded.credential] },
    );
    const mcp = trail.channel('mcp');

    // An honest operation, with the whole connection object spread into it by a careless caller.
    await mcp.run({ ...pinOp('run-1'), ...loaded, operationId: 'op-honest-0001' } as AuditedOperation, () => 'ok');
    // A client that echoes the secrets back in every identifier it controls.
    for (const secret of [loaded.token, loaded.credential]) {
      mcp.record(
        {
          action: 'runs.get',
          resource: { kind: 'run', id: secret },
          payload: { id: secret, prompt: `please use ${secret}` },
          expectedVersion: `rev1:run:${secret}:3:0123456789ab`,
          operationId: secret,
          // A fencing token whose random half is the planted capability token.
          ownerGeneration: `1789080413148-${capability}`,
        },
        { outcome: 'rejected', errorCode: 'not_found' },
      );
    }
    // The cockpit door, handed the same object.
    trail.channel('ui').record({ ...pinOp('run-2'), ...loaded } as AuditedOperation, { outcome: 'ok' });

    const raw = readFileSync(auditTrailPath(dataDir), 'utf8');
    // Populated-input guarantee: an empty trail would "contain no secret" too.
    expect(raw.trim().split('\n')).toHaveLength(4);
    for (const needle of [capability, patToken, loaded.endpoint.socket, root, 'mcp-connection']) {
      expect(raw).not.toContain(needle);
    }
    // The trail and the connection file are the only files in the data dir.
    expect(readdirSync(dataDir).sort()).toEqual(['mcp-audit.ndjson', 'mcp-connection.json']);

    // The secret-bearing identifiers were dropped, not masked; the rest of the entry survives.
    const echoed = trail.read().entries.filter((e) => e.action === 'runs.get');
    expect(echoed).toHaveLength(2);
    for (const entry of echoed) {
      expect(entry.resource).toBeUndefined();
      expect(entry.operationKey).toBeUndefined();
      expect(entry.versionToken).toBeUndefined();
      expect(entry).toMatchObject({ outcome: 'rejected', errorCode: 'not_found', origin: 'mcp' });
      expect(entry.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('refuses free text, paths and email addresses in identifier fields by shape', () => {
    const trail = new AuditTrail({ projectId: 'alpha', dataDir: dataDirOf('alpha') }, { now });
    trail.channel('ui').record(
      { action: 'runs.patch', resource: { kind: 'run', id: '/Users/someone/secret repo' } },
      { outcome: 'rejected', errorCode: 'Invalid input: someone@example.com' },
    );
    trail.channel('ui').record({ action: 'runs.patch', resource: { kind: 'run', id: 'someone@example.com' } }, { outcome: 'ok' });
    const raw = readFileSync(auditTrailPath(dataDirOf('alpha')), 'utf8');
    expect(raw).not.toContain('someone');
    expect(raw).not.toContain('/Users');
    expect(trail.read().entries).toHaveLength(2);
  });
});

describe('D: an entry for project A is invisible to a reader scoped to project B (N-01)', () => {
  it('keeps each project to its own trail', () => {
    const a = new AuditTrail({ projectId: 'alpha', dataDir: dataDirOf('alpha') }, { now });
    const b = new AuditTrail({ projectId: 'beta', dataDir: dataDirOf('beta') }, { now });
    a.channel('mcp').record({ ...pinOp('run-a'), operationId: 'op-alpha-0001' }, { outcome: 'ok' });

    expect(a.read().entries).toHaveLength(1);
    expect(b.read()).toEqual({ entries: [], quarantined: 0 });
    expect(readFileSync(auditTrailPath(dataDirOf('alpha')), 'utf8')).not.toContain('beta');
  });

  it('does not hand B an entry naming A even when one lands in B’s file, nor count it', () => {
    const betaDir = dataDirOf('beta');
    const b = new AuditTrail({ projectId: 'beta', dataDir: betaDir }, { now });
    b.channel('ui').record(pinOp('run-b'), { outcome: 'ok' });
    const foreign: AuditEntry = {
      v: 1,
      ts: FIXED.toISOString(),
      projectId: 'alpha',
      action: 'runs.pin',
      resource: { kind: 'run', id: 'run-a' },
      outcome: 'ok',
      origin: 'mcp',
    };
    expect(auditEntrySchema.safeParse(foreign).success).toBe(true);
    appendFileSync(auditTrailPath(betaDir), `${JSON.stringify(foreign)}\n`);

    const read = b.read();
    expect(read.quarantined).toBe(0);
    expect(read.entries.map((e) => [e.projectId, e.resource?.id])).toEqual([['beta', 'run-b']]);
  });
});

describe('storage: written, never required', () => {
  it('reads a missing trail as empty', () => {
    const trail = new AuditTrail({ projectId: 'alpha', dataDir: join(root, 'nowhere') }, { now });
    expect(trail.read()).toEqual({ entries: [], quarantined: 0 });
  });

  it('quarantines a torn or foreign-shaped line and keeps the rest', () => {
    const dataDir = dataDirOf('alpha');
    const trail = new AuditTrail({ projectId: 'alpha', dataDir }, { now });
    trail.channel('ui').record(pinOp('run-1'), { outcome: 'ok' });
    appendFileSync(auditTrailPath(dataDir), '{"v":1,"ts":"2026-09-1\n{"v":1,"note":"free text here"}\n');
    trail.channel('mcp').record(pinOp('run-1'), { outcome: 'ok' });
    const read = trail.read();
    expect(read.quarantined).toBe(2);
    expect(read.entries.map((e) => e.origin)).toEqual(['ui', 'mcp']);
  });

  it('never fails the operation when the trail cannot be written, and warns once', async () => {
    const dataDir = dataDirOf('alpha');
    chmodSync(dataDir, 0o500);
    try {
      const warn = vi.fn();
      const trail = new AuditTrail({ projectId: 'alpha', dataDir }, { now, warn });
      await expect(trail.channel('mcp').run(pinOp('run-1'), () => 'done')).resolves.toBe('done');
      trail.channel('ui').record(pinOp('run-1'), { outcome: 'ok' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).not.toContain(dataDir);
    } finally {
      chmodSync(dataDir, 0o700);
    }
  });

  it('writes the trail owner-only', () => {
    const dataDir = dataDirOf('alpha');
    new AuditTrail({ projectId: 'alpha', dataDir }, { now }).channel('ui').record(pinOp('run-1'), { outcome: 'ok' });
    expect(statSync(auditTrailPath(dataDir)).mode & 0o777).toBe(0o600);
  });

  it('refuses the unresolved default alias and a malformed project id', () => {
    expect(() => new AuditTrail({ projectId: 'default', dataDir: root })).toThrow(/resolved project id/);
    expect(() => new AuditTrail({ projectId: '../beta', dataDir: root })).toThrow(/resolved project id/);
  });

  it('skips an operation whose action is not an action id rather than writing it', () => {
    const warn = vi.fn();
    const trail = new AuditTrail({ projectId: 'alpha', dataDir: dataDirOf('alpha') }, { now, warn });
    expect(trail.channel('ui').record({ action: 'please delete everything' }, { outcome: 'ok' })).toBeNull();
    expect(trail.read().entries).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('payload digest (D-06 § 5.4)', () => {
  it('is independent of key order and drops undefined keys', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, undefined], c: undefined } })).toBe('{"a":{"d":[1,null]},"b":1}');
    expect(payloadDigest({ b: 1, a: 2 })).toBe(payloadDigest({ a: 2, b: 1 }));
  });

  it('digests blob bytes, never where they came from', () => {
    const bytes = new TextEncoder().encode('image bytes');
    const canonical = JSON.parse(canonicalJson({ image: bytes })) as { image: { bytes: number; sha256: string } };
    expect(canonical.image.bytes).toBe(bytes.byteLength);
    expect(canonical.image.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadDigest({ image: Buffer.from('image bytes') })).toBe(payloadDigest({ image: bytes }));
  });

  it('omits the digest rather than failing on a payload it cannot canonicalise', () => {
    const trail = new AuditTrail({ projectId: 'alpha', dataDir: dataDirOf('alpha') }, { now });
    trail.channel('ui').record({ action: 'runs.pin', payload: { n: Number.NaN } }, { outcome: 'ok' });
    const [entry] = trail.read().entries;
    expect(entry?.payloadDigest).toBeUndefined();
    expect(entry?.outcome).toBe('ok');
  });
});
