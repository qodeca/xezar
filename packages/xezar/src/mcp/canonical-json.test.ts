import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { payloadDigest as auditPayloadDigest } from './audit-redaction.ts';
import { canonicalDigest, canonicalJson } from './canonical-json.ts';
import { payloadDigest as receiptPayloadDigest } from './operation-receipts.ts';
import { versionToken } from './stale-write.ts';

/**
 * The one D-06 § 5.4 canonical form. Three digests are built on it – the operation-receipt
 * payload digest, the audit payload digest and the version token – and before it was shared they
 * disagreed: the audit copy rebuilt an object for `JSON.stringify`, so integer-like keys came out
 * in numeric order instead of code-unit order.
 */

describe('canonicalJson', () => {
  it('sorts keys by UTF-16 code unit at every level, including integer-like keys', () => {
    // RED against: rebuilding an object and handing it to JSON.stringify (the engine puts
    // integer-like keys first, in numeric order), or sorting with a numeric comparator.
    expect(canonicalJson({ b: 1, a: { 9: 'x', 10: 'y' } })).toBe('{"a":{"10":"y","9":"x"},"b":1}');
    expect(canonicalJson({ 10: 'y', 9: 'x', a: { 2: 1, 10: 2 }, B: 0, _: 0 })).toBe(
      '{"10":"y","9":"x","B":0,"_":0,"a":{"10":2,"2":1}}',
    );
    // Insertion order never matters.
    expect(canonicalJson({ z: 1, 2: 1, a: 1, 1: 1 })).toBe(canonicalJson({ a: 1, 1: 1, z: 1, 2: 1 }));
  });

  it('keeps array order and writes undefined array items as null, dropping undefined keys', () => {
    expect(canonicalJson([3, undefined, { z: undefined, y: null }])).toBe('[3,null,{"y":null}]');
    expect(canonicalJson({ b: 1, a: { d: [1, undefined], c: undefined } })).toBe('{"a":{"d":[1,null]},"b":1}');
  });

  it('replaces byte blobs by their length and hash, and writes a Date as its ISO string', () => {
    const sha = createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex');
    expect(canonicalJson({ image: new Uint8Array([1, 2, 3]) })).toBe(`{"image":{"bytes":3,"sha256":"${sha}"}}`);
    expect(canonicalJson({ image: Buffer.from([1, 2, 3]) })).toBe(canonicalJson({ image: new Uint8Array([1, 2, 3]) }));
    expect(canonicalJson({ when: new Date(0) })).toBe('{"when":"1970-01-01T00:00:00.000Z"}');
  });

  it('refuses values JSON cannot carry instead of coercing them', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalJson({ a: 1n })).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
    expect(() => canonicalJson({ a: new Map() })).toThrow(TypeError);
  });

  it('pins the digest of a fixed payload, so a change to the form cannot pass silently', () => {
    // Stored operation receipts compare this digest against a retry's: it must not move.
    const payload = { workflow: 'default', task: 'fix it', tags: ['b', 'a'], options: { maxParallel: 2, dryRun: false } };
    expect(canonicalJson(payload)).toBe(
      '{"options":{"dryRun":false,"maxParallel":2},"tags":["b","a"],"task":"fix it","workflow":"default"}',
    );
    expect(canonicalDigest(payload)).toBe(
      createHash('sha256').update('{"options":{"dryRun":false,"maxParallel":2},"tags":["b","a"],"task":"fix it","workflow":"default"}').digest('hex'),
    );
  });
});

describe('the three digests share one canonical form', () => {
  const payloads: unknown[] = [
    { b: 1, a: 2 },
    { 9: 'x', 10: 'y', nested: { 2: true, 10: false } },
    { list: [1, undefined, { z: null }], blob: new Uint8Array([7]) },
  ];

  it.each(payloads.map((payload) => [payload]))('agree on %j', (payload) => {
    const digest = canonicalDigest(payload);
    expect(receiptPayloadDigest(payload)).toBe(digest);
    expect(auditPayloadDigest(payload)).toBe(digest);
    expect(versionToken({ ref: { kind: 'automation', id: 'a1' }, projection: payload }).endsWith(`:${digest.slice(0, 12)}`)).toBe(true);
  });
});
