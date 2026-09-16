import { describe, expect, it } from 'vitest';
import { logfmt } from './logfmt.ts';
import { entry } from './renderer.ts';

describe('logfmt quoting guards', () => {
  it('quotes spaces, quotes, backslashes and empty values; omits absent values', () => {
    expect(logfmt([['empty', ''], ['words', 'two words'], ['quote', '"'], ['slash', '\\'], ['no', null], ['missing', undefined], ['count', 0]]))
      .toBe('empty="" words="two words" quote="\\"" slash="\\\\" count=0');
  });
  it('keeps an untrusted field on one line through the entry boundary', () => {
    const e = entry({ level: 'info', subject: 'task', message: 'started', event: 'task.started', fields: [['step', 'ok\nforged\u001b[2J']] });
    expect(logfmt(e.fields ?? [])).toBe('step="ok forged"');
  });
});
