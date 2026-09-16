/**
 * AC-11 — untrusted text cannot inject terminal commands, forge a log row or leak a secret.
 *
 * Named breaks these prove red: `terminal-injection` (drop any one rule of § 10.5 and a
 * sequence survives) and `secret-in-debug` (drop the redaction step and a token prints).
 *
 * Every case is one rule of `designs/cli-terminal/README.md` § 10.5, in the order the design
 * lists them, plus the composed example from `error-cases.txt` G2.
 */

import { describe, expect, it } from 'vitest';

import {
  charWidth,
  cutPath,
  cutToWidth,
  displayWidth,
  resetSecretCache,
  sanitizeText,
} from './sanitize.ts';

const ESC = '\u001b';

/** Nothing this module answers may ever carry an escape byte. */
function hasEscape(text: string): boolean {
  return /[\u001b\u009b\u009d\u0007]/.test(text);
}

describe('sanitizeText — rule 1, escape sequences', () => {
  it('removes a CSI clear-screen whole, leaving no visible remnant', () => {
    const out = sanitizeText(`Fix ${ESC}[2Jlogin`);
    expect(out).toBe('Fix login');
    expect(hasEscape(out)).toBe(false);
  });

  it('removes an OSC 8 hyperlink, so a title cannot link anywhere', () => {
    const out = sanitizeText(`Fix ${ESC}]8;;https://evil.example\u0007login${ESC}]8;;\u0007`);
    expect(out).toBe('Fix login');
    expect(out).not.toContain('evil.example');
  });

  it('removes an OSC 52 clipboard write', () => {
    const out = sanitizeText(`a${ESC}]52;c;ZXZpbA==\u0007b`);
    expect(out).toBe('ab');
  });

  it('eats an UNTERMINATED OSC to the end of the string', () => {
    // The shape an attacker actually writes: no terminator, so a rule that needs one
    // leaves the whole payload printable.
    const out = sanitizeText(`safe${ESC}]8;;https://evil.example/steal`);
    expect(out).toBe('safe');
  });

  it('removes DCS, APC, PM and SOS sequences', () => {
    for (const introducer of ['P', '_', '^', 'X']) {
      const out = sanitizeText(`a${ESC}${introducer}payload${ESC}\\b`);
      expect(out, introducer).toBe('ab');
    }
  });

  it('removes the 8-bit CSI form as well as the 7-bit one', () => {
    expect(sanitizeText('a\u009b31mb')).toBe('ab');
  });

  it('removes a two-byte ESC sequence that carries no terminator', () => {
    expect(sanitizeText(`a${ESC}(Bb`)).toBe('ab');
  });
});

describe('sanitizeText — rule 2, control characters', () => {
  it('removes the remaining C0 controls, C1 and DEL', () => {
    const out = sanitizeText('a\u0000b\u0001c\u007fd\u0085e');
    expect(out).toBe('abcde');
  });

  it('strips the controls AFTER the escapes, so ESC [ 2 J never degrades into “[2J”', () => {
    // Order matters: removing ESC first as a bare control leaves the text `[2J` on screen.
    expect(sanitizeText(`x${ESC}[2Jy`)).toBe('xy');
  });
});

describe('sanitizeText — rule 3, one value is one line', () => {
  it('turns a newline into a space so a title cannot forge a second log row', () => {
    const out = sanitizeText('Fix login\n10:00:00  info  fake line');
    expect(out).toBe('Fix login 10:00:00 info fake line');
    expect(out).not.toContain('\n');
  });

  it('turns CR, TAB, U+2028 and U+2029 into spaces and collapses runs', () => {
    expect(sanitizeText('a\r\n\tb\u2028\u2029c')).toBe('a b c');
  });
});

describe('sanitizeText — rule 4, bidirectional controls', () => {
  it('removes overrides and isolates so a line cannot reorder itself', () => {
    const out = sanitizeText('done\u202efailed\u202c');
    expect(out).toBe('donefailed');
    expect(/[\u202a-\u202e\u2066-\u2069]/.test(out)).toBe(false);
  });
});

describe('sanitizeText — rule 5, secrets', () => {
  it('redacts a known secret VALUE taken from the environment', () => {
    resetSecretCache();
    const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
    const out = sanitizeText(`token is ${secret}`, { secretValues: [secret] });
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts a token SHAPE even when no value was collected', () => {
    resetSecretCache();
    const out = sanitizeText('pushed with ghp_0123456789abcdefghijklmnopqrstuvwx', {
      secretValues: [],
    });
    expect(out).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwx');
  });

  it('redacts BEFORE cutting, so half a secret never survives the width limit', () => {
    resetSecretCache();
    const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
    const out = sanitizeText(`x ${secret}`, { secretValues: [secret], maxWidth: 20 });
    expect(out).not.toContain('sk-ant-abcdef');
  });
});

describe('displayWidth and cutToWidth — rule 6', () => {
  it('counts a wide character as two columns and a combining mark as zero', () => {
    expect(charWidth('漢'.codePointAt(0) ?? 0)).toBe(2);
    expect(charWidth('́'.codePointAt(0) ?? 0)).toBe(0);
    expect(displayWidth('漢字')).toBe(4);
    expect(displayWidth('é')).toBe(1);
  });

  it('keeps a cut cell inside its budget, ellipsis included', () => {
    const out = cutToWidth('abcdefghij', 5);
    expect(displayWidth(out)).toBeLessThanOrEqual(5);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never answers wider than the budget for wide characters', () => {
    // The live-region hazard: a cell that overflows wraps, and the next redraw's cursor-up
    // count is then short by a line.
    for (let max = 1; max <= 10; max++) {
      expect(displayWidth(cutToWidth('漢字漢字漢字', max)), `max=${max}`).toBeLessThanOrEqual(max);
    }
  });

  it('leaves a value that already fits untouched', () => {
    expect(cutToWidth('abc', 10)).toBe('abc');
  });
});

describe('cutPath', () => {
  it('cuts in the middle and keeps the last folder', () => {
    const out = cutPath('~/Projects/clients/acme-holdings/beta', 25);
    expect(out.endsWith('/beta')).toBe(true);
    expect(out).toContain('…');
    expect(displayWidth(out)).toBeLessThanOrEqual(25);
  });

  it('falls back to a right-hand cut when the last folder alone does not fit', () => {
    const out = cutPath('/a/averyverylongfinalsegmentname', 8);
    expect(displayWidth(out)).toBeLessThanOrEqual(8);
  });
});

describe('the composed case from error-cases.txt G2', () => {
  it('prints one line, with no escape byte and no forged row', () => {
    const title = `Fix ${ESC}[2J${ESC}]8;;https://evil\u0007login\n10:00:00  info  fake line`;
    const out = sanitizeText(title);
    expect(out).toBe('Fix login 10:00:00 info fake line');
    expect(hasEscape(out)).toBe(false);
    expect(out.split('\n')).toHaveLength(1);
  });

  it('prints a U+202E title without the override', () => {
    expect(sanitizeText('Fix\u202elogin')).toBe('Fixlogin');
  });
});
