import { createHash } from 'node:crypto';

/**
 * The one canonical JSON form of D-06 § 5.4, shared by the three digests built on it: the
 * operation-receipt payload digest (`operation-receipts.ts`), the audit payload digest
 * (`audit-redaction.ts`) and the version token's projection digest (`stale-write.ts`).
 *
 * - object keys sorted by UTF-16 code unit at every level, keys whose value is `undefined` dropped;
 * - arrays kept in order, an `undefined` item written as `null`;
 * - no whitespace;
 * - a byte blob (`Uint8Array`, so also a `Buffer`) replaced by `{ bytes, sha256 }`, so the digest
 *   covers the BYTES, never a path;
 * - a `Date` written as its ISO string, any other value with `toJSON` as what `toJSON` returns;
 * - a non-finite number, a `bigint`, a function, a symbol, or an object that is neither plain nor
 *   handled above (a `Map`, a class instance) is REFUSED with a `TypeError`, never silently coerced.
 *
 * Serialized by hand rather than by rebuilding an object for `JSON.stringify`: an engine iterates
 * integer-like keys (`"10"`, `"9"`) numerically whatever order they were inserted in, which is not
 * code-unit order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonical JSON: non-finite number');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`canonical JSON: unsupported ${typeof value}`);
  }
  if (value instanceof Uint8Array) {
    return canonicalJson({ bytes: value.byteLength, sha256: createHash('sha256').update(value).digest('hex') });
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const withJson = value as { toJSON?: unknown };
  if (typeof withJson.toJSON === 'function') return canonicalJson((withJson.toJSON as () => unknown).call(value));
  if (!isPlainRecord(value)) throw new TypeError('canonical JSON: unsupported object type');
  const parts: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
  }
  return `{${parts.join(',')}}`;
}

/** SHA-256, lowercase hex, of `canonicalJson(value)`. */
export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** An object made by a literal, `Object.create(null)` or a JSON parse — not an array or a class instance. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
