import { describe, expect, it } from 'vitest';
import { hasLine } from './text-lines.ts';

describe('hasLine', () => {
  it('finds a line in an LF file', () => {
    expect(hasLine('a\n*\nb\n', '*')).toBe(true);
  });

  it('finds a line in a CRLF file (#963)', () => {
    expect(hasLine('a\r\n*\r\n', '*')).toBe(true);
  });

  it('ignores surrounding spaces and a missing final newline', () => {
    expect(hasLine('a\n  *  ', '*')).toBe(true);
  });

  it('does not match part of a line', () => {
    expect(hasLine('*.log\n!*\n', '*')).toBe(false);
  });

  it('says no for empty content', () => {
    expect(hasLine('', '*')).toBe(false);
  });
});
