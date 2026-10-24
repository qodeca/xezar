import { describe, expect, it } from 'vitest';
import { asRecord, isRecord } from './records.ts';

describe('isRecord / asRecord', () => {
  it('accepts a plain object and hands back the same object', () => {
    const value = { a: 1 };
    expect(isRecord(value)).toBe(true);
    expect(asRecord(value)).toBe(value);
  });

  it.each([null, undefined, 0, '', 'text', true, [], [1]])('rejects %j', (value) => {
    expect(isRecord(value)).toBe(false);
    expect(asRecord(value)).toBeUndefined();
  });
});
