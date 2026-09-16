/**
 * logfmt, the plain output's line format (#467, PR 3;
 * `designs/cli-terminal/non-tty.txt`, `README.md` § 10.3).
 *
 * `<time> level=<l> project=<id> event=<name> key=value …`. A value holding a space, a `"`, an
 * `=` or nothing at all is double-quoted, and `"` and `\` inside it are escaped with `\`.
 *
 * Why this and not JSON: a person reading `2> activity.log` with `less` and `grep` is the first
 * reader, and one `grep event=task.failed` has to work. `--output json` can be added later
 * without a break, because `--output` already takes a value (`open-questions.md` Q-10).
 *
 * Pure: no clock, no stream, no colour. The values arriving here are already sanitized — this
 * module quotes and escapes, it does not clean.
 */

/** A value that survives into a line. `undefined` and `null` fields are dropped, not printed. */
export type LogfmtValue = string | number | boolean | undefined | null;

/** Anything that needs quoting: a space, a quote, an equals, a backslash, or emptiness. */
const NEEDS_QUOTES = /[\s"=\\]/;

/**
 * One value, quoted and escaped if it has to be.
 *
 * Order matters: backslashes are escaped BEFORE quotes, or the backslash added in front of a
 * quote would itself be escaped a second time and the line would no longer round-trip.
 */
export function logfmtValue(value: string | number | boolean): string {
  const text = String(value);
  if (text !== '' && !NEEDS_QUOTES.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build one logfmt line from ordered fields.
 *
 * The array — rather than an object — is deliberate: field ORDER is part of the format a person
 * greps and a tool splits, and an object literal's key order is a promise the language makes
 * about insertion but that a spread or a `JSON.parse` round-trip quietly breaks.
 */
export function logfmt(fields: ReadonlyArray<readonly [string, LogfmtValue]>): string {
  const parts: string[] = [];
  for (const [key, value] of fields) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${logfmtValue(value)}`);
  }
  return parts.join(' ');
}
