/**
 * The terminal's own number and time formatting (#467, PR 3;
 * `designs/cli-terminal/README.md` § 9 "Copy deck").
 *
 * The cockpit's `shortAge` gives one floored unit ("2m"), which is right for "how long ago" and
 * wrong for "how long it took": `2m` and `2m 59s` are a different answer to "did that check
 * hang". The design asks for two units and no rounding up, so a duration is never reported as
 * longer than it was — the same honesty rule the run summaries follow.
 *
 * Everything here is pure, locale-independent arithmetic. The one exception is `formatClock`,
 * which reads the machine's own clock for a local wall time, because a person watching their own
 * terminal wants their own time; plain output uses UTC ISO-8601 instead (§ 10.3).
 */

/** `—`, the placeholder for a value xezar does not have. Never printed for "the value is zero". */
export const MISSING = '—';
/** The ASCII stand-in when the terminal is not UTF-8. */
export const MISSING_ASCII = '-';

/**
 * A duration as a person reads it: `41s`, `2m 23s`, `1h 02m`.
 *
 * Two units at most, and NEVER rounded up — 119 999 ms is `1m 59s`, not `2m`. A negative or
 * non-finite input answers `0s` rather than something impossible: a clock that went backwards
 * between two timestamps is a fact about the machine, not about the task.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/**
 * The live table's Time column: `m:ss`, and `h:mm:ss` once a task passes an hour.
 * Right-aligned by the caller, so the colon stays in one place down the column.
 */
export function formatClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
  return `${minutes}:${seconds}`;
}

/** `8200` → `8.2k`; `96233` → `96.2k`; `1240000` → `1.2M`; under 1000, the number itself. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0';
  if (tokens < 1000) return String(Math.floor(tokens));
  if (tokens < 1_000_000) return `${(Math.floor(tokens / 100) / 10).toFixed(1)}k`;
  return `${(Math.floor(tokens / 100_000) / 10).toFixed(1)}M`;
}

/** `0.3149` → `$0.31`. Truncated, not rounded: a reported cost never grows in the printing. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '$0.00';
  return `$${(Math.floor(usd * 100) / 100).toFixed(2)}`;
}

/** Local wall time, 24-hour, `HH:MM:SS` — exactly 8 columns whatever the hour. */
export function formatLocalTime(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** Local `HH:MM` — the form a "resumes at" line uses. */
export function formatLocalClockTime(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** UTC ISO-8601 with milliseconds — the one timestamp form plain output uses. */
export function formatIsoTime(at: Date): string {
  return at.toISOString();
}

/**
 * Right-align `text` in `width` columns, never widening the field.
 * A value that does not fit is returned as it is: the caller cut it already, and silently
 * truncating here would hide a bug rather than a value.
 */
export function padStartTo(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

/** Left-align `text` in `width` columns. Same no-widening rule. */
export function padEndTo(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * Does this terminal speak UTF-8? (`README.md` § 10.4)
 *
 * Read from `LC_ALL`, `LC_CTYPE` then `LANG`, in the order POSIX resolves them. An unset locale
 * answers **true**: every terminal this decade is UTF-8, and a `?` where a `·` belongs is a much
 * more common complaint than a mojibake one. Only an explicitly non-UTF-8 locale switches to
 * the ASCII forms.
 */
export function localeIsUtf8(env: NodeJS.ProcessEnv = process.env): boolean {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  if (!locale) return true;
  return /utf-?8/i.test(locale);
}

/** The glyph set, chosen once per process from the locale. */
export interface Glyphs {
  ellipsis: string;
  missing: string;
  /** Between two clauses. */
  dash: string;
  /** Between two facts. */
  dot: string;
  /** The live region's rule line. */
  rule: string;
  quoteOpen: string;
  quoteClose: string;
}

export const UTF8_GLYPHS: Glyphs = {
  ellipsis: '…',
  missing: '—',
  dash: '—',
  dot: '·',
  rule: '─',
  quoteOpen: '“',
  quoteClose: '”',
};

export const ASCII_GLYPHS: Glyphs = {
  ellipsis: '...',
  missing: '-',
  dash: '-',
  dot: '|',
  rule: '-',
  quoteOpen: '"',
  quoteClose: '"',
};

export function glyphsFor(env: NodeJS.ProcessEnv = process.env): Glyphs {
  return localeIsUtf8(env) ? UTF8_GLYPHS : ASCII_GLYPHS;
}
