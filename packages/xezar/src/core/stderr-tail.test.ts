import { describe, expect, it } from 'vitest';

import { STDERR_TAIL_CHARS, StderrTail } from './stderr-tail.ts';

describe('StderrTail', () => {
  it('reads exactly what joining the chunks read, within the bound', () => {
    const tail = new StderrTail();
    const chunks = ['warn: one\n', 'warn: two\nfatal: ', 'three\n'];
    for (const chunk of chunks) tail.push(chunk);
    expect(tail.text()).toBe(chunks.join(''));
  });

  it('keeps only the newest characters, so the last lines survive a long session', () => {
    const tail = new StderrTail();
    for (let i = 0; i < 2_000; i++) tail.push(`${'noise '.repeat(20)}${i}\n`);
    tail.push('error: the last line\n');
    expect(tail.text().length).toBe(STDERR_TAIL_CHARS);
    expect(tail.text().trim().split('\n').slice(-2)).toEqual([`${'noise '.repeat(20)}1999`, 'error: the last line']);
  });

  it('bounds a single oversized chunk too', () => {
    const tail = new StderrTail(8);
    tail.push('0123456789abcdef');
    expect(tail.text()).toBe('89abcdef');
  });
});
