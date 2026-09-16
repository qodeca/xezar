/**
 * What the terminal output actually IS, once the transport has had its say (#467, PR 3;
 * `designs/cli-terminal/README.md` § 8 "auto output" and § 10.3).
 *
 * `cli-settings.ts` (PR 2) resolves the user's WISH — `auto`, `lines` or `rich`, plus a colour
 * policy. This module turns that wish into one of three concrete render modes, using facts the
 * settings module deliberately does not know: whether stderr is a terminal, how wide it is,
 * whether `CI` is set and whether `TERM` says `dumb`.
 *
 * The three modes:
 *
 * - `rich`  — human lines plus the live table. Only ever on a capable TTY at 60 columns or more.
 * - `lines` — the same human lines, no table. Honoured ANYWHERE, including a file, because that
 *   is the screen-reader answer (§ 11) and a person who asked for readable lines in a log gets
 *   them.
 * - `plain` — logfmt, UTC timestamps, never a colour byte, never a cursor move.
 *
 * `auto` never produces `rich` off a terminal, and an explicit `rich` off a terminal falls back
 * to `plain` with ONE notice. That notice matters: the silent version of this is a person
 * wondering for an hour why `--output rich` did nothing.
 *
 * The vocabulary of `--output` is PR 2's and is not widened here. The design's fourth word,
 * `plain`, is what `auto` resolves to off a terminal; it is not a value a person types yet.
 */

import type { ColorMode, OutputMode } from '../cli-settings.ts';

/** The concrete thing the renderer does. Never `auto` — that is a wish, not a mode. */
export type RenderMode = 'rich' | 'lines' | 'plain';

/** Below this many columns there is no table, only the one-line summary (§ 12.1). */
export const NARROW_COLUMNS = 60;
/** What a TTY that will not say how wide it is gets treated as (§ 12.1). */
export const ASSUMED_COLUMNS = 80;

export interface TerminalFacts {
  /** Is the stream the activity goes to a terminal? */
  isTty: boolean;
  /** `process.stderr.columns`, or undefined when the stream will not say. */
  columns?: number;
  /** `process.env.TERM`. */
  term?: string;
  /** `process.env.CI` — set and non-empty means a build machine. */
  ci?: string;
}

/** Read the facts off a real stream and environment. Kept apart so tests need no TTY. */
export function readTerminalFacts(
  stream: { isTTY?: boolean; columns?: number },
  env: NodeJS.ProcessEnv = process.env,
): TerminalFacts {
  return {
    isTty: stream.isTTY === true,
    ...(typeof stream.columns === 'number' ? { columns: stream.columns } : {}),
    ...(env.TERM !== undefined ? { term: env.TERM } : {}),
    ...(env.CI !== undefined ? { ci: env.CI } : {}),
  };
}

/** A terminal that can move a cursor and paint a colour. `TERM=dumb` explicitly cannot. */
export function isCapableTty(facts: TerminalFacts): boolean {
  if (!facts.isTty) return false;
  return (facts.term ?? '').toLowerCase() !== 'dumb';
}

/** The width to lay out for: the stream's own answer, or 80 on a TTY that will not say. */
export function resolveColumns(facts: TerminalFacts): number {
  if (typeof facts.columns === 'number' && facts.columns > 0) return facts.columns;
  return ASSUMED_COLUMNS;
}

export interface ResolvedRender {
  mode: RenderMode;
  columns: number;
  /** True when the table is drawn; false in `lines` (a one-line summary on a TTY) and `plain`. */
  table: boolean;
  colorEnabled: boolean;
  /**
   * Present exactly when an explicit `rich` could not be honoured: the ONE `output.fallback`
   * line, with the reason a person can act on. Never set for `auto`, which asked for nothing.
   */
  fallback?: { asked: OutputMode; using: RenderMode; reason: string };
}

/**
 * Resolve the wish against the transport.
 *
 * `output` is `ResolvedCliSettings.output` (already a flag/stored/env decision); `color` is
 * `ResolvedCliSettings.color`. `colorEnabled` from the settings module is deliberately NOT
 * reused: it was computed from the transport alone and knows nothing about `plain`, where a
 * colour byte is a defect even with `--color always`.
 */
export function resolveRender(
  output: OutputMode,
  color: ColorMode,
  facts: TerminalFacts,
): ResolvedRender {
  const capable = isCapableTty(facts);
  const columns = resolveColumns(facts);
  const ci = (facts.ci ?? '') !== '';

  let mode: RenderMode;
  let fallback: ResolvedRender['fallback'];

  if (output === 'lines') {
    // Honoured anywhere — including a file. This is the screen-reader answer.
    mode = 'lines';
  } else if (output === 'rich') {
    if (!capable || ci) {
      mode = 'plain';
      fallback = {
        asked: 'rich',
        using: 'plain',
        reason: ci ? 'CI is set' : facts.isTty ? 'TERM is dumb' : 'stderr is not a terminal',
      };
    } else if (columns < NARROW_COLUMNS) {
      // Not a fallback: an explicit `rich` on a narrow terminal is still human lines, and the
      // live region is a one-line summary rather than a table. Nothing was refused.
      mode = 'lines';
    } else {
      mode = 'rich';
    }
  } else {
    // `auto`: a build machine gets machine output, whatever its TERM claims.
    if (!capable || ci) mode = 'plain';
    else if (columns < NARROW_COLUMNS) mode = 'lines';
    else mode = 'rich';
  }

  const colorEnabled =
    mode !== 'plain' && capable && !ci && color !== 'never';

  return {
    mode,
    columns,
    table: mode === 'rich',
    colorEnabled,
    ...(fallback ? { fallback } : {}),
  };
}

/**
 * Re-resolve after a resize, keeping the ORIGINAL wish.
 *
 * Crossing 60 columns switches between the table and the one-line summary and back, which is
 * the only thing a resize may change: a terminal that was capable at 80 columns is still
 * capable at 40, and re-deciding `plain` on a resize would throw away a person's whole session
 * format because they dragged a window.
 */
export function resolveOnResize(
  previous: ResolvedRender,
  output: OutputMode,
  color: ColorMode,
  facts: TerminalFacts,
): ResolvedRender {
  // A plain session stays plain, fallback notice and all: it was printed once, at start, and
  // re-resolving here is what would print it a second time.
  if (previous.mode === 'plain') return previous;
  return resolveRender(output, color, facts);
}
