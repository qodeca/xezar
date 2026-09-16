/**
 * The copy deck's numbers and the plain output's line format
 * (`designs/cli-terminal/README.md` § 9, § 10.3).
 *
 * The rule under most of these: a duration is NEVER rounded up. `2m` for 119 999 ms is a
 * report that the check took longer than it did, and a summary that rounds in its own favour
 * is a summary nobody can use as evidence.
 */

import { describe, expect, it } from 'vitest';

import {
  ASCII_GLYPHS,
  formatClock,
  formatCost,
  formatDuration,
  formatIsoTime,
  formatLocalTime,
  formatTokens,
  glyphsFor,
  localeIsUtf8,
  padEndTo,
  padStartTo,
  UTF8_GLYPHS,
} from './format.ts';
import { logfmt, logfmtValue } from './logfmt.ts';

describe('formatDuration', () => {
  it('matches the shapes the copy deck names', () => {
    expect(formatDuration(41_022)).toBe('41s');
    expect(formatDuration(143_118)).toBe('2m 23s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
  });

  it('never rounds up', () => {
    expect(formatDuration(119_999)).toBe('1m 59s');
    expect(formatDuration(59_999)).toBe('59s');
    expect(formatDuration(3_599_999)).toBe('59m 59s');
  });

  it('answers 0s for a clock that went backwards rather than something impossible', () => {
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
  });
});

describe('formatClock — the table Time column', () => {
  it('is m:ss under an hour and h:mm:ss above it', () => {
    expect(formatClock(2_000)).toBe('0:02');
    expect(formatClock(934_000)).toBe('15:34');
    expect(formatClock(3_738_000)).toBe('1:02:18');
  });

  it('pads the seconds so the colon stays in one place down the column', () => {
    expect(formatClock(61_000)).toBe('1:01');
    expect(formatClock(69_000)).toBe('1:09');
  });
});

describe('formatTokens and formatCost', () => {
  it('shortens a count the way the copy deck shows it', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(18_412)).toBe('18.4k');
    expect(formatTokens(96_233)).toBe('96.2k');
    expect(formatTokens(1_240_000)).toBe('1.2M');
  });

  it('truncates a cost rather than rounding it up', () => {
    expect(formatCost(0.3149)).toBe('$0.31');
    expect(formatCost(0.319)).toBe('$0.31');
    expect(formatCost(0)).toBe('$0.00');
  });
});

describe('times', () => {
  it('prints local wall time in exactly eight columns', () => {
    const at = new Date(2026, 8, 15, 9, 4, 1);
    expect(formatLocalTime(at)).toBe('09:04:01');
    expect(formatLocalTime(at)).toHaveLength(8);
  });

  it('prints UTC ISO-8601 with milliseconds for plain output', () => {
    expect(formatIsoTime(new Date(Date.UTC(2026, 8, 15, 8, 6, 12, 104)))).toBe(
      '2026-09-15T08:06:12.104Z',
    );
  });
});

describe('padding', () => {
  it('never widens a field past a value that already fills it', () => {
    expect(padEndTo('abcdefgh', 8)).toBe('abcdefgh');
    expect(padStartTo('1:02:18', 7)).toBe('1:02:18');
    expect(padEndTo('ab', 5)).toBe('ab   ');
    expect(padStartTo('0:02', 7)).toBe('   0:02');
  });
});

describe('glyphs', () => {
  it('uses the UTF-8 set for a UTF-8 locale and for an unset one', () => {
    expect(localeIsUtf8({ LANG: 'en_US.UTF-8' })).toBe(true);
    expect(localeIsUtf8({})).toBe(true);
    expect(glyphsFor({ LANG: 'en_US.UTF-8' })).toBe(UTF8_GLYPHS);
  });

  it('falls back to ASCII for an explicitly non-UTF-8 locale', () => {
    expect(localeIsUtf8({ LC_ALL: 'C' })).toBe(false);
    expect(glyphsFor({ LC_ALL: 'POSIX' })).toBe(ASCII_GLYPHS);
  });

  it('resolves LC_ALL over LC_CTYPE over LANG', () => {
    expect(localeIsUtf8({ LC_ALL: 'C', LC_CTYPE: 'en_US.UTF-8', LANG: 'en_US.UTF-8' })).toBe(false);
    expect(localeIsUtf8({ LC_CTYPE: 'C', LANG: 'en_US.UTF-8' })).toBe(false);
  });
});

describe('logfmt', () => {
  it('leaves a plain value unquoted', () => {
    expect(logfmtValue('task.done')).toBe('task.done');
    expect(logfmtValue(41)).toBe('41');
    expect(logfmtValue(true)).toBe('true');
  });

  it('quotes a value with a space, a quote, an equals or nothing at all', () => {
    expect(logfmtValue('no open session')).toBe('"no open session"');
    expect(logfmtValue('a=b')).toBe('"a=b"');
    expect(logfmtValue('')).toBe('""');
  });

  it('escapes backslashes BEFORE quotes, so the value round-trips', () => {
    const encoded = logfmtValue('say "hi" \\ there');
    expect(encoded).toBe('"say \\"hi\\" \\\\ there"');
    expect(JSON.parse(encoded)).toBe('say "hi" \\ there');
  });

  it('drops an absent field instead of printing an empty one', () => {
    expect(
      logfmt([
        ['level', 'info'],
        ['exit', undefined],
        ['run', 'a12bc345'],
      ]),
    ).toBe('level=info run=a12bc345');
  });

  it('keeps the field ORDER it was given', () => {
    expect(
      logfmt([
        ['level', 'error'],
        ['project', 'beta'],
        ['event', 'gate.failed'],
      ]),
    ).toBe('level=error project=beta event=gate.failed');
  });

  it('builds a line that matches the design capture', () => {
    const line = `${formatIsoTime(new Date(Date.UTC(2026, 8, 15, 8, 12, 8, 771)))} ${logfmt([
      ['level', 'error'],
      ['project', 'beta'],
      ['event', 'gate.failed'],
      ['run', 'a12bc345'],
      ['step', 'unit-tests'],
      ['exit', 1],
      ['duration_ms', 143118],
    ])}`;
    expect(line).toBe(
      '2026-09-15T08:12:08.771Z level=error project=beta event=gate.failed run=a12bc345 step=unit-tests exit=1 duration_ms=143118',
    );
  });
});
