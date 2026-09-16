/**
 * D-AC-1 and the design's ONE CONTRAST RULE (`designs/cli-terminal/README.md` § 9.2).
 *
 * Named break: `colour-only-state`. The check the design itself proposes is here, mechanically:
 * grep a coloured line for the dim code and find it only in front of the time, the column
 * headers, the rule line and the `—` placeholder. `info`, `debug`, `queued` and `cancelled`
 * print at full contrast in the default foreground.
 */

import { describe, expect, it } from 'vitest';

import { createPainter, paintLine } from './paint.ts';

const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const CYAN = '\u001b[36m';
const MAGENTA = '\u001b[35m';

const on = createPainter(true);
const off = createPainter(false);

/** Strip every escape sequence, so a painted line can be compared with its plain twin. */
function plain(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

const ERROR_LINE = '  10:12:08  error  a12bc345  check unit-tests failed — exit 1 · 2m 23s';
const INFO_LINE = '  10:07:02  info   b98de765  started — implement · Codex';

describe('a disabled painter', () => {
  it('is the identity function, not a second code path', () => {
    for (const kind of ['entry-wide', 'rule', 'header', 'row', 'summary', 'continuation'] as const) {
      expect(paintLine(ERROR_LINE, kind, off)).toBe(ERROR_LINE);
    }
  });
});

describe('D-AC-1 — colour adds nothing a word does not already say', () => {
  it('leaves the text byte-identical once the escapes are removed', () => {
    expect(plain(paintLine(ERROR_LINE, 'entry-wide', on, { level: 'error' }))).toBe(ERROR_LINE);
    expect(plain(paintLine(INFO_LINE, 'entry-wide', on, { level: 'info' }))).toBe(INFO_LINE);
  });
});

describe('the one contrast rule', () => {
  it('dims the time, and nothing else on an activity line', () => {
    const painted = paintLine(ERROR_LINE, 'entry-wide', on, { level: 'error' });
    expect(painted.split(DIM)).toHaveLength(2);
    expect(painted).toContain(`${DIM}10:12:08`);
  });

  it('prints info and debug at full contrast, never dim', () => {
    for (const level of ['info', 'debug'] as const) {
      const painted = paintLine(INFO_LINE, 'entry-wide', on, { level });
      // One dim, and it is the time. The level word carries no colour code at all.
      expect(painted.split(DIM)).toHaveLength(2);
      expect(painted).not.toContain(`${DIM}${level}`);
    }
  });

  it('dims the rule line and the column header, whole', () => {
    expect(paintLine('  ─ active tasks ────', 'rule', on).startsWith(DIM)).toBe(true);
    expect(paintLine('  Task      State', 'header', on).startsWith(DIM)).toBe(true);
  });

  it('dims a — placeholder only in the cells that can hold one', () => {
    const line = '  a12bc345  queued        —           Codex           0:02  A — dashy title';
    const painted = paintLine(line, 'row', on, {
      stateCell: [12, 24],
      placeholderCells: [
        [26, 36],
        [38, 49],
      ],
    });
    // Exactly one dim: the Step cell. The em dash inside the TITLE is left alone — a title is
    // untrusted text, and dimming a word inside it is the contrast rule broken by accident.
    expect(painted.split(DIM)).toHaveLength(2);
    expect(plain(painted)).toBe(line);
  });
});

describe('level colours', () => {
  it('paints error red and warn yellow', () => {
    expect(paintLine(ERROR_LINE, 'entry-wide', on, { level: 'error' })).toContain(`${RED}error`);
    const warnLine = '  10:14:30  warn   b98de765  needs you — “Pin vitest?”';
    expect(paintLine(warnLine, 'entry-wide', on, { level: 'warn' })).toContain(`${YELLOW}warn `);
  });
});

describe('state colours', () => {
  const stateCell = [12, 24] as const;
  function rowFor(state: string): string {
    return `  a12bc345  ${state.padEnd(12)}  implement   Claude Code     0:02  A task`;
  }

  it('paints the states the design colour table names', () => {
    expect(paintLine(rowFor('needs you'), 'row', on, { stateCell })).toContain(`${YELLOW}needs you`);
    // `needs permission` is 16 characters and the State column is 12, so the cell holds the
    // cut form. It still paints, and the summary line carries the whole word.
    expect(paintLine(rowFor('needs permi…'), 'row', on, { stateCell })).toContain(`${YELLOW}needs permi…`);
    expect(paintLine(rowFor('scheduled'), 'row', on, { stateCell })).toContain(`${YELLOW}scheduled`);
    expect(paintLine(rowFor('needs review'), 'row', on, { stateCell })).toContain(`${MAGENTA}needs review`);
    expect(paintLine(rowFor('running'), 'row', on, { stateCell })).toContain(`${CYAN}running`);
    expect(paintLine(rowFor('monitoring'), 'row', on, { stateCell })).toContain(`${CYAN}monitoring`);
  });

  it('leaves queued and cancelled in the default foreground, and never dims them', () => {
    const painted = paintLine(rowFor('queued'), 'row', on, { stateCell });
    expect(painted).not.toContain(DIM);
    expect(plain(painted)).toBe(rowFor('queued'));
  });
});

describe('the summary line', () => {
  it('paints the failed count red and each state count in its own colour', () => {
    const line = '  4 active — 1 needs review · 2 running · 1 queued — 1 failed since start';
    const painted = paintLine(line, 'summary', on);
    expect(painted).toContain(`${RED}1 failed since start`);
    expect(painted).toContain(`${MAGENTA}needs review`);
    expect(painted).toContain(`${CYAN}running`);
    expect(painted).not.toContain(DIM);
    expect(plain(painted)).toBe(line);
  });
});

describe('URLs', () => {
  it('paints a continuation URL cyan and leaves the rest alone', () => {
    const line = '                             http://localhost:4322/p/beta/tasks/b98de765';
    const painted = paintLine(line, 'continuation', on);
    expect(painted).toContain(`${CYAN}http://localhost:4322/p/beta/tasks/b98de765`);
    expect(plain(painted)).toBe(line);
  });

  it('leaves a continuation that is not a URL untouched', () => {
    const line = '                             “no open session”';
    expect(paintLine(line, 'continuation', on)).toBe(line);
  });
});
