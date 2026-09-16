/**
 * The one door every untrusted string walks through before it reaches a terminal
 * (#467, PR 3; `designs/cli-terminal/README.md` § 10.5).
 *
 * Task titles, questions, agent error text, server messages, branch names and paths are all
 * written by somebody else — an agent, a forge, a person pasting a prompt. A terminal executes
 * what it is sent: an `ESC [ 2 J` clears the screen, an `ESC ] 8 ; ;` turns the next words into
 * a link to anywhere, an `ESC ] 52` writes the clipboard, a bare newline forges a second log
 * row, and `U+202E` reverses a line so `failed` reads as `done`. None of that may survive.
 *
 * The rules are applied in ONE order, and the order matters:
 *
 *  1. escape sequences (CSI, OSC, DCS, APC, PM, SOS) — removed whole, terminator included;
 *  2. the remaining C0/C1 controls and DEL — removed;
 *  3. CR, LF, TAB, U+2028, U+2029 — replaced with a space, runs of spaces collapsed, so one
 *     value is one line and can never forge a second entry;
 *  4. bidirectional overrides and isolates — removed, so text cannot reorder a line;
 *  5. known secret shapes — redacted with the SAME redaction run evidence uses;
 *  6. cut to a display width with `…`, counting wide characters as 2 and combining marks as 0.
 *
 * Step 2 must come after step 1: strip the controls first and `ESC [ 2 J` degrades into the
 * visible text `[2J` instead of disappearing. Step 5 must come before step 6, because cutting a
 * secret in half does not stop it being half a secret in a scrollback buffer.
 *
 * This module is PURE and has no terminal knowledge: it takes text, it answers text. It is used
 * at every level and in every output mode — `debug` is not permission to print a credential.
 */

import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';

/** The ellipsis a cut value ends with. One character, so the budget arithmetic is honest. */
export const ELLIPSIS = '…';
/** The ASCII stand-in when the terminal is not UTF-8 (`README.md` § 10.4). */
export const ELLIPSIS_ASCII = '...';

/**
 * Escape sequences, longest-introducer first.
 *
 * - `CSI`  — `ESC [` … a final byte in `@`–`~`; also the 8-bit `\u009b` form.
 * - `OSC`  — `ESC ]` … terminated by BEL or ST (`ESC \`). OSC 8 (hyperlinks) and OSC 52
 *   (clipboard) are the two that matter most and are both covered by this one rule.
 * - `DCS`/`SOS`/`PM`/`APC` — `ESC P` / `ESC X` / `ESC ^` / `ESC _` … ST.
 * - a lone `ESC` plus one intermediate/final byte (`ESC ( B`, `ESC c`) — the two- and
 *   three-byte sequences that carry no terminator.
 *
 * An UNTERMINATED introducer (`"a\u001b]8;;http://evil"` with no BEL) must still die: the
 * alternation ends each string form with `$` so the tail is eaten to the end rather than left
 * printable. That case is exactly what an attacker writes, because a terminator is easy to spot.
 */
const ESCAPE_SEQUENCES = new RegExp(
  [
    // STRING sequences — OSC, DCS, SOS, PM, APC — in both their 7-bit (`ESC ]`) and 8-bit
    // (a single C1 byte) forms. They run until BEL, until ST, or until the end of the string.
    // First in the alternation, so `ESC ]` is never claimed by the catch-all rule below.
    '(?:\\u001b[\\]PX^_]|[\\u009d\\u0090\\u0098\\u009e\\u009f])[\\s\\S]*?(?:\\u0007|\\u001b\\\\|\\u009c|$)',
    // CSI, 7-bit and 8-bit. It ends at a FINAL BYTE, not at a terminator — which is why it
    // cannot share the rule above: `` treated as a string introducer would swallow
    // everything after a stray colour code to the end of the line.
    '(?:\\u001b\\[|\\u009b)[0-?]*[ -/]*(?:[@-~]|$)',
    // Anything else an ESC introduces: the two- and three-byte sequences (`ESC ( B`, `ESC c`).
    '\\u001b[@-Z\\\\-_]?[ -/]*[0-~]?',
  ].join('|'),
  'g',
);

/** C0 (minus the ones step 3 turns into a space), C1 and DEL. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/** Anything that means "start a new line" or "jump a column". */
const LINE_BREAKS = /[\r\n\t\u2028\u2029\u000b\u000c]/g;
/** LRE, RLE, PDF, LRO, RLO and the four isolates — a line must not reorder itself. */
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;

/**
 * Display width of one code point: 0 for a combining mark or a zero-width joiner, 2 for the
 * East Asian wide and fullwidth ranges and for emoji, 1 otherwise.
 *
 * This is a BOUNDED approximation, not a Unicode database. It exists so a table cell of 20
 * columns holds 20 columns of glyphs rather than 20 code points — which is the difference
 * between a live region that redraws cleanly and one that leaves debris on every wide title.
 */
export function charWidth(codePoint: number): number {
  if (codePoint === 0x200d) return 0;
  // Combining marks, variation selectors and the zero-width space family.
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    codePoint === 0x200b ||
    codePoint === 0xfeff
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Total display width of a string, by the same approximation. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0) ?? 0);
  return width;
}

/**
 * Cut `text` to `max` display columns, ending in `ellipsis` when anything was removed.
 *
 * The ellipsis is part of the budget, never extra: a cell of 20 columns answers at most 20
 * columns. A `max` under the ellipsis's own width answers the ellipsis alone rather than
 * something wider than the cell, because a cell that overflows is what wraps the live region
 * and leaves debris behind on the next redraw.
 */
export function cutToWidth(text: string, max: number, ellipsis = ELLIPSIS): string {
  if (max <= 0) return '';
  if (displayWidth(text) <= max) return text;
  const tail = displayWidth(ellipsis);
  if (max <= tail) return ellipsis;
  let out = '';
  let width = 0;
  for (const char of text) {
    const w = charWidth(char.codePointAt(0) ?? 0);
    if (width + w > max - tail) break;
    out += char;
    width += w;
  }
  // `Fix login redirect …` is a cut in the middle of a space; the design writes
  // `Fix login redirect…`. Trimming here also keeps the cell narrower, never wider.
  return out.replace(/\s+$/, '') + ellipsis;
}

/**
 * Cut a PATH in the middle, keeping the last segment (`README.md` § tty-narrow scene 1):
 * `~/Projects/clients/…/beta`. A path's meaning is at both ends, so a left-to-right cut
 * throws away the only part a person recognises.
 */
export function cutPath(path: string, max: number, ellipsis = ELLIPSIS): string {
  if (max <= 0) return '';
  if (displayWidth(path) <= max) return path;
  const slash = path.lastIndexOf('/');
  const last = slash >= 0 ? path.slice(slash) : '';
  const lastWidth = displayWidth(last);
  const tail = displayWidth(ellipsis);
  // No room for "head + … + /last": fall back to an ordinary right-hand cut.
  if (last === '' || lastWidth + tail >= max) return cutToWidth(path, max, ellipsis);
  const headBudget = max - lastWidth - tail;
  let head = '';
  let width = 0;
  for (const char of path.slice(0, slash)) {
    const w = charWidth(char.codePointAt(0) ?? 0);
    if (width + w > headBudget) break;
    head += char;
    width += w;
  }
  return `${head}${ellipsis}${last}`;
}

export interface SanitizeOptions {
  /** Cut to this many display columns. Absent = no cut (the caller bounds it later). */
  maxWidth?: number;
  /** The concrete secret values to redact. Defaults to the host environment's. */
  secretValues?: readonly string[];
  /** `…` on a UTF-8 terminal, `...` otherwise. */
  ellipsis?: string;
}

/** Cached once: `collectSecretValues` walks the whole environment, and this runs per line. */
let hostSecrets: readonly string[] | null = null;
function defaultSecretValues(): readonly string[] {
  hostSecrets ??= collectSecretValues();
  return hostSecrets;
}

/** Test seam: drop the cached host secrets so a case can pin its own environment. */
export function resetSecretCache(): void {
  hostSecrets = null;
}

/**
 * Clean one untrusted value for a terminal. See the module comment for the rule order.
 *
 * Always answers a single line with no escape byte in it. A value that cleans away to nothing
 * answers the empty string; callers that need a placeholder use `—` themselves, because
 * "the agent wrote nothing" and "xezar has no value" are different facts.
 */
export function sanitizeText(value: unknown, options: SanitizeOptions = {}): string {
  if (value === undefined || value === null) return '';
  const raw = typeof value === 'string' ? value : String(value);
  let text = raw.replace(ESCAPE_SEQUENCES, '');
  text = text.replace(LINE_BREAKS, ' ');
  text = text.replace(CONTROL_CHARS, '');
  text = text.replace(BIDI_CONTROLS, '');
  text = text.replace(/ {2,}/g, ' ').trim();
  text = redactSecrets(text, options.secretValues ?? defaultSecretValues());
  if (options.maxWidth !== undefined) {
    text = cutToWidth(text, options.maxWidth, options.ellipsis ?? ELLIPSIS);
  }
  return text;
}
