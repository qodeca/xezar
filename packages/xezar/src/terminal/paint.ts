/**
 * Colour, applied LAST and to nothing else (#467, PR 3;
 * `designs/cli-terminal/README.md` § 9.2 "Colour").
 *
 * Two rules decide everything in this file.
 *
 * **Colour is never the only cue.** Every level has its word (`warn`, `error`), every table row
 * its state word (`needs you`, `failed`), every summary its counts in words. `NO_COLOR=1` and
 * `--color never` lose nothing but colour — which is also why painting happens here, at the very
 * end, on lines that are already laid out: nothing downstream measures a painted string, so an
 * escape code can never push a live-region line past the terminal's width and wrap it.
 *
 * **Dim is used for exactly four things**: the time, the column headers, the rule line and the
 * `—` placeholder. Nothing else is ever dim — `info`, `debug`, `queued` and `cancelled` print at
 * full contrast in the default foreground. A tester checks that by grepping a coloured capture
 * for `ESC[2m` and finding it only in front of those four (§ 9.2, "The one contrast rule").
 *
 * Only the terminal's 16 standard colours are used, so a person's own light or dark theme picks
 * the shade. Never a background, never 256-colour or true-colour, never bright white or black.
 *
 * `picocolors` reads `FORCE_COLOR`, `NO_COLOR` and `--color` out of `process.argv` on its own
 * when you import its default export. That would quietly outrank the precedence PR 2 fixed, so
 * the renderer builds its own instance with `createColors(enabled)` and passes the answer this
 * repository resolved.
 */

import { createColors } from 'picocolors';

import { MAX_TABLE_ROWS, TASK_STATES, type ActivityLevel, type TaskState } from './activity.ts';

type Colors = ReturnType<typeof createColors>;

/** A painter. The disabled one is the identity function everywhere — not a second code path. */
export interface Painter {
  enabled: boolean;
  level(text: string, level: ActivityLevel): string;
  state(text: string, state: TaskState): string;
  dim(text: string): string;
  url(text: string): string;
  bold(text: string): string;
  danger(text: string): string;
  success(text: string): string;
}

function levelColor(colors: Colors, level: ActivityLevel): (s: string) => string {
  switch (level) {
    case 'error':
      return colors.red;
    case 'warn':
      return colors.yellow;
    // `info` and `debug` print in the default foreground — NOT dim. See the contrast rule.
    default:
      return (s: string) => s;
  }
}

function stateColor(colors: Colors, state: TaskState): (s: string) => string {
  switch (state) {
    case 'needs permission':
    case 'needs you':
    case 'scheduled':
      return colors.yellow;
    case 'needs review':
      return colors.magenta;
    case 'running':
    case 'monitoring':
      // Cyan, not the cockpit's violet: the cockpit tells `running` from `needs review` by a
      // pulse, and a terminal has no motion (§ 14). Cyan keeps a second cue beyond the word.
      return colors.cyan;
    default:
      return (s: string) => s;
  }
}

export function createPainter(enabled: boolean): Painter {
  const colors = createColors(enabled);
  return {
    enabled,
    level: (text, level) => levelColor(colors, level)(text),
    state: (text, state) => stateColor(colors, state)(text),
    dim: (text) => colors.dim(text),
    url: (text) => colors.cyan(text),
    bold: (text) => colors.bold(text),
    danger: (text) => colors.red(text),
    success: (text) => colors.green(text),
  };
}

/** What kind of line is being painted — each has its own, exact rule. */
export type LineKind = 'entry-wide' | 'entry-stacked' | 'continuation' | 'rule' | 'header' | 'row' | 'summary';

/** Where the time and level cells sit in a wide entry line (`activity.ts` `MESSAGE_COLUMN`). */
const WIDE_TIME = [2, 10] as const;
const WIDE_LEVEL = [12, 17] as const;
/** The stacked form packs the same two with single spaces: `  HH:MM:SS level subject`. */
const STACKED_TIME = [2, 10] as const;
const STACKED_LEVEL = [11, 16] as const;

const URL_RE = /https?:\/\/\S+/g;
const STATE_COUNT_RE = new RegExp(`(\\d+) (${TASK_STATES.join('|')})\\b`, 'g');
const FAILED_COUNT_RE = /(\d+) failed(?: since start)?$/;

function slice(line: string, from: number, to: number, paint: (s: string) => string): string {
  if (line.length < to) return line;
  return line.slice(0, from) + paint(line.slice(from, to)) + line.slice(to);
}

/**
 * Paint one finished line.
 *
 * `line` is plain and already cut to the terminal's width; the answer is the same line with
 * escape codes inserted. Nothing may measure the answer — that is the whole contract.
 */
export function paintLine(
  line: string,
  kind: LineKind,
  painter: Painter,
  context: {
    level?: ActivityLevel;
    stateCell?: readonly [number, number];
    /**
     * Cells that may hold the `—` placeholder (Step, Agent). Named by index rather than found
     * by a regular expression on purpose: a task title holding a dash would otherwise be
     * painted dim and break the one contrast rule in a way only a careful grep would find.
     */
    placeholderCells?: ReadonlyArray<readonly [number, number]>;
  } = {},
): string {
  if (!painter.enabled) return line;
  switch (kind) {
    case 'entry-wide': {
      let out = slice(line, WIDE_LEVEL[0], WIDE_LEVEL[1], (s) =>
        painter.level(s, context.level ?? 'info'),
      );
      out = slice(out, WIDE_TIME[0], WIDE_TIME[1], painter.dim);
      return out;
    }
    case 'entry-stacked': {
      let out = slice(line, STACKED_LEVEL[0], STACKED_LEVEL[1], (s) =>
        painter.level(s, context.level ?? 'info'),
      );
      out = slice(out, STACKED_TIME[0], STACKED_TIME[1], painter.dim);
      return out;
    }
    case 'continuation':
      return line.replace(URL_RE, (url) => painter.url(url));
    case 'rule':
    case 'header':
      return painter.dim(line);
    case 'row': {
      let out = line;
      // Right to left, so an earlier cell's inserted escape codes cannot shift a later index.
      const cells = [...(context.placeholderCells ?? [])].sort((a, b) => b[0] - a[0]);
      for (const [from, to] of cells) {
        if (out.length < to) continue;
        const text = out.slice(from, to).trim();
        if (text === '—' || text === '-') out = slice(out, from, to, painter.dim);
      }
      const cell = context.stateCell;
      if (cell && out.length >= cell[1]) {
        // The cell may hold a CUT state: `needs permission` is 16 characters and the State
        // column is 12, so the row shows `needs permi…` while the summary line — which is never
        // cut — carries the whole word. Matching on the prefix keeps the colour right either
        // way rather than silently leaving the longest state unpainted.
        const text = out.slice(cell[0], cell[1]).trimEnd().replace(/…$/, '');
        const state = text === '' ? undefined : TASK_STATES.find((s) => s.startsWith(text));
        if (state) out = slice(out, cell[0], cell[1], (s) => painter.state(s, state));
      }
      return out;
    }
    case 'summary': {
      let out = line.replace(FAILED_COUNT_RE, (whole) => painter.danger(whole));
      out = out.replace(STATE_COUNT_RE, (whole, count: string, state: string) => {
        const known = TASK_STATES.find((s) => s === state);
        return known ? `${count} ${painter.state(state, known)}` : whole;
      });
      return out;
    }
  }
}

/** Kept beside the table constants so a layout change cannot silently orphan the painter. */
export const PAINTER_TABLE_ROWS = MAX_TABLE_ROWS;
