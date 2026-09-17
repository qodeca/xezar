import { describe, expect, it } from 'vitest';
import { auditActionRecordSchema, auditRecordSchema, type AuditActionRecord, type AuditRecord } from './audit.ts';
import { auditEntrySchema } from './mcp-audit.ts';

/**
 * #306 — the v2 audit record contract (spec `docs/features/mcp-server/audit-trail-origins-2026-09-17.md`
 * § 3.1). What the TYPE cannot say: which records the schema refuses. Node-free, like the rest of
 * this package — a plain object literal is the line on disk.
 */

const base = { v: 2, seq: 1, ts: '2026-09-17T09:00:00.000Z', projectId: 'alpha' } as const;

/** One valid action per door, as each door's writer will stamp it. */
const V2_ACTION_FIXTURES: AuditActionRecord[] = [
  {
    ...base,
    kind: 'action',
    origin: 'mcp',
    actor: { type: 'mcp' },
    action: 'taskCreate.start',
    resource: { kind: 'run', id: 'run-1' },
    outcome: { status: 'applied' },
    ownerGeneration: 1789080413148,
    operationKey: 'alpha/op-0001-abcd',
    versionToken: 'rev1:run:run-1:12:0123456789ab',
    payloadDigest: 'a'.repeat(64),
  },
  {
    ...base,
    seq: 2,
    kind: 'action',
    origin: 'ui',
    actor: { type: 'ui', proxyUser: { value: 'ada', trust: 'asserted-by-proxy' } },
    action: 'project.config.set',
    outcome: { status: 'refused', reason: 'http_409' },
    fieldNames: ['maxParallel', 'reviewGate'],
  },
  {
    ...base,
    seq: 3,
    kind: 'action',
    origin: 'automation',
    actor: { type: 'automation', receiptId: 'rcpt-0001' },
    action: 'automation.launch',
    resource: { kind: 'run', id: 'run-2' },
    outcome: { status: 'applied' },
  },
  {
    ...base,
    seq: 4,
    kind: 'action',
    origin: 'cli',
    actor: { type: 'cli', command: 'projects.remove' },
    action: 'cli.projects.remove',
    outcome: { status: 'refused', reason: 'unknown_project' },
  },
];

const V2_ROTATED_FIXTURE: AuditRecord = { ...base, seq: 5, kind: 'rotated', previousLastSeq: 4 };

const mcpAction = V2_ACTION_FIXTURES[0]!;
const accepts = (value: unknown) => auditRecordSchema.safeParse(value).success;

describe('the v2 audit record (#306)', () => {
  it('accepts one action per door, a refusal, and a rotation marker', () => {
    for (const record of [...V2_ACTION_FIXTURES, V2_ROTATED_FIXTURE]) {
      expect(auditRecordSchema.safeParse(record).error?.issues ?? []).toEqual([]);
    }
  });

  // B-CONTRACT-ORIGIN: without the actor/origin refinement this record turns valid.
  it('refuses an actor that does not match the origin', () => {
    expect(accepts({ ...mcpAction, origin: 'ui', actor: { type: 'mcp' }, ownerGeneration: undefined, operationKey: undefined })).toBe(false);
    expect(accepts({ ...V2_ACTION_FIXTURES[2], actor: { type: 'cli', command: 'run' } })).toBe(false);
  });

  // B-CONTRACT-JOIN: without the MCP-only refinement these turn valid.
  it('keeps ownerGeneration and operationKey to the MCP origin', () => {
    expect(accepts({ ...V2_ACTION_FIXTURES[1], ownerGeneration: 1 })).toBe(false);
    expect(accepts({ ...V2_ACTION_FIXTURES[3], operationKey: 'alpha/op-0001-abcd' })).toBe(false);
  });

  it('refuses a timestamp that is not UTC', () => {
    expect(accepts({ ...mcpAction, ts: '2026-09-17T11:00:00.000+02:00' })).toBe(false);
    expect(accepts({ ...mcpAction, ts: '2026-09-17T09:00:00' })).toBe(false);
  });

  it('bounds the sequence: a positive safe integer on actions, zero allowed only as a previous value', () => {
    for (const seq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) expect(accepts({ ...mcpAction, seq })).toBe(false);
    expect(accepts({ ...mcpAction, seq: Number.MAX_SAFE_INTEGER })).toBe(true);
    expect(accepts({ ...V2_ROTATED_FIXTURE, previousLastSeq: 0 })).toBe(true);
    expect(accepts({ ...V2_ROTATED_FIXTURE, previousLastSeq: -1 })).toBe(false);
  });

  it('refuses unknown keys at every level, so nothing unlisted can be persisted', () => {
    expect(accepts({ ...mcpAction, errorCode: 'stale_version' })).toBe(false);
    expect(accepts({ ...mcpAction, prompt: 'free text' })).toBe(false);
    expect(accepts({ ...mcpAction, actor: { type: 'mcp', sessionKey: 'abc' } })).toBe(false);
    expect(accepts({ ...mcpAction, outcome: { status: 'applied', reason: 'fine' } })).toBe(false);
    expect(accepts({ ...mcpAction, resource: { kind: 'run', id: 'run-1', path: '/tmp' } })).toBe(false);
  });

  it('allows only applied or refused-with-a-machine-reason as the outcome', () => {
    for (const outcome of ['ok', { status: 'unverified' }, { status: 'refused' }, { status: 'refused', reason: 'Not Found: /tmp/x' }]) {
      expect(accepts({ ...mcpAction, outcome })).toBe(false);
    }
    expect(accepts({ ...mcpAction, outcome: { status: 'refused', reason: 'x'.repeat(65) } })).toBe(false);
  });

  it('refuses a proxy user carrying control characters, and one not labelled as asserted', () => {
    const ui = V2_ACTION_FIXTURES[1]!;
    expect(accepts({ ...ui, actor: { type: 'ui', proxyUser: { value: 'ada\u001b[31m', trust: 'asserted-by-proxy' } } })).toBe(false);
    expect(accepts({ ...ui, actor: { type: 'ui', proxyUser: { value: 'ada', trust: 'verified' } } })).toBe(false);
    expect(accepts({ ...ui, actor: { type: 'ui' } })).toBe(true);
  });

  it('refuses a command id outside the canonical set', () => {
    expect(accepts({ ...V2_ACTION_FIXTURES[3], actor: { type: 'cli', command: 'rm' } })).toBe(false);
  });

  it('is not the v1 shape: a v1 entry is refused, and the v1 schema refuses every v2 record', () => {
    const v1 = { v: 1, ts: base.ts, projectId: 'alpha', action: 'runs.pin', outcome: 'ok', origin: 'mcp' };
    expect(auditEntrySchema.safeParse(v1).success).toBe(true);
    expect(auditActionRecordSchema.safeParse(v1).success).toBe(false);
    for (const record of [...V2_ACTION_FIXTURES, V2_ROTATED_FIXTURE]) expect(auditEntrySchema.safeParse(record).success).toBe(false);
  });
});
