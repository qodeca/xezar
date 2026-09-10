import { MAX_REF } from './task-refs.ts';

/**
 * In-band task-reference markers (spec 2026-07-18-task-ref-markers): the main
 * agent thread declares its subject PR/issue — and optionally a title — the
 * same way it declares completion with `XEZ:DONE`. Parsed from the accumulated
 * turn text only (the agent's own words, never tool output), so a task that
 * merely *reads* the marker contract cannot poison its record. Marker values
 * outrank the fuzzy discovery layers; precedence lives in the spec's table.
 */

export interface TaskMarkers {
  pr?: number;
  issue?: number;
  title?: string;
}

// Line-anchored so prose that mentions a marker never parses; the instruction
// fragment's own `XEZ:PR=<number>` placeholder is non-numeric and inert.
const PR_MARKER_RE = /^XEZ:PR=(\d+)\s*$/gm;
const ISSUE_MARKER_RE = /^XEZ:ISSUE=(\d+)\s*$/gm;
const TITLE_MARKER_RE = /^XEZ:TITLE=(.+)$/gm;

// Report-tier reference lines (spec 2026-07-21-report-ref-discovery): the
// human-friendly chaining lines pipeline skills end their reports with —
// `PR: #12 (link: https://…/pull/12)` — plus the legacy env-style markers
// older skill versions printed. Same trust boundary as XEZ:* (parsed from the
// agent's own turn text only), one notch below in precedence: an explicit
// XEZ:PR / XEZ:ISSUE in the same turn wins. The skill docs' own placeholders
// (`PR: #<PR number> (link: …)`) are non-numeric and inert.
const REPORT_PR_RE = /^PR: #(\d+) \(link: \S+\)\s*$/gm;
const REPORT_ISSUE_RE = /^Issue: #(\d+) \(link: \S+\)\s*$/gm;
const LEGACY_PR_NUMBER_RE = /^PR_NUMBER=(\d+)\s*$/gm;
const LEGACY_PR_URL_RE = /^PR_URL=\S*\/pull\/(\d+)\s*$/gm;
const LEGACY_ISSUE_NUMBER_RE = /^ISSUE_NUMBER=(\d+)\s*$/gm;

/**
 * Fenced-code awareness (#124). Line-anchoring alone treats a marker an agent
 * DEMONSTRATES inside a ``` block as a real emission, which binds the task to a
 * PR that was only ever an example. Every neighbouring shape — an inline
 * `` `XEZ:PR=442` ``, a quote, a list bullet, a blockquote — already reads as
 * prose; the fence was the one that slipped through, and it is the shape an
 * agent produces most often when it documents the marker vocabulary. The
 * instructions have always said "never inside a code fence"; this makes the
 * parser enforce the rule instead of trusting the emitter.
 *
 * CommonMark's fence rules, kept to what actually occurs in agent text: three
 * or more backticks or tildes, up to three leading spaces, an optional info
 * string (```js), closed by the same character at least as long with nothing
 * after it. A backtick fence's info string may not contain a backtick, so a
 * one-line ```inline``` span never opens a block. An UNCLOSED fence runs to the
 * end of the text — CommonMark's own rule, and what the cockpit's markdown
 * renderer already shows the user for a half-streamed block, so the record
 * agrees with the transcript.
 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Per-line "is this inside a fenced block", the fence lines themselves included. */
function fencedLineFlags(lines: string[]): boolean[] {
  const inside = new Array<boolean>(lines.length).fill(false);
  let open: { char: string; len: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    // CRLF: a trailing `\r` is not matched by `.` and would hide the fence.
    const match = FENCE_RE.exec((lines[i] ?? '').replace(/\r$/, ''));
    const run = match?.[1] ?? '';
    const info = (match?.[2] ?? '').trim();
    if (open) {
      inside[i] = true;
      if (match && run[0] === open.char && run.length >= open.len && info === '') open = undefined;
      continue;
    }
    if (!match) continue;
    if (run[0] === '`' && info.includes('`')) continue;
    open = { char: run[0] as string, len: run.length };
    inside[i] = true;
  }
  return inside;
}

/** Blank out fenced lines so no tier's line-anchored regex can see them. Line
 *  count is preserved, and a blanked line matches no marker shape. */
function maskFencedLines(text: string): string {
  if (!text.includes('```') && !text.includes('~~~')) return text;
  const lines = text.split('\n');
  const fenced = fencedLineFlags(lines);
  if (!fenced.some(Boolean)) return text;
  return lines.map((line, i) => (fenced[i] ? '' : line)).join('\n');
}

function lastNumber(text: string, re: RegExp): number | undefined {
  let value: number | undefined;
  for (const match of text.matchAll(re)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0 && n < MAX_REF) value = n;
  }
  return value;
}

/** The turn's declared references. The last occurrence of each marker wins —
 *  an agent that corrects itself mid-turn is believed, not averaged. Within a
 *  turn, an explicit XEZ:* declaration outranks a report-tier line, which
 *  outranks the legacy env-style markers. */
export function parseTaskMarkers(text: string): TaskMarkers {
  const markers: TaskMarkers = {};
  const source = maskFencedLines(text ?? '');
  const pr =
    lastNumber(source, PR_MARKER_RE) ??
    lastNumber(source, REPORT_PR_RE) ??
    lastNumber(source, LEGACY_PR_NUMBER_RE) ??
    lastNumber(source, LEGACY_PR_URL_RE);
  if (pr !== undefined) markers.pr = pr;
  const issue =
    lastNumber(source, ISSUE_MARKER_RE) ??
    lastNumber(source, REPORT_ISSUE_RE) ??
    lastNumber(source, LEGACY_ISSUE_NUMBER_RE);
  if (issue !== undefined) markers.issue = issue;
  let title: string | undefined;
  for (const match of source.matchAll(TITLE_MARKER_RE)) {
    const t = match[1]?.trim();
    if (t) title = t;
  }
  if (title !== undefined) markers.title = title;
  return markers;
}

const MARKER_LINE = /^XEZ:(?:PR=\d+|ISSUE=\d+|TITLE=.+)\s*$/;

/**
 * Remove complete marker lines from display text — the `stripDoneMarker`
 * precedent. Only `XEZ:*` control lines are stripped: the report-tier
 * reference lines (`PR: #12 (link: …)`) are human-readable by design and
 * stay visible. Best-effort by design: a marker split across streamed v1 chunks
 * may transiently render; parsing always runs on the whole turn text, so the
 * record is never affected. Mirrored for v2 display in the cockpit's
 * `thread-state.ts`.
 *
 * A marker line inside a fenced code block is left in place (#124): it is not
 * an emission, so removing it would gut the agent's own example and leave an
 * empty fence behind.
 */
export function stripTaskMarkers(text: string): string {
  if (!text.includes('XEZ:')) return text;
  const lines = text.split('\n');
  const fenced = fencedLineFlags(lines);
  return lines.filter((line, i) => fenced[i] || !MARKER_LINE.test(line)).join('\n');
}
