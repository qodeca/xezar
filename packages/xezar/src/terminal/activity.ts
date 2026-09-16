/**
 * What the terminal shows, as data (#467, PR 3; `designs/cli-terminal/README.md` §§ 6.2–6.4).
 *
 * One `ActivityEntry` is one thing that happened. One `TaskRow` is one active task. Both are
 * plain values: this module lays them out into strings, and knows nothing about a stream, a
 * cursor, a colour or a clock. The renderer owns those.
 *
 * Splitting it this way is what makes the width rules testable without a terminal — and the
 * width rules are where a live region goes wrong. A region line that is one column too wide
 * wraps, the redraw's cursor-up count is then short by a line, and every redraw after it eats
 * a line of the person's scrollback.
 */

import { cutToWidth, displayWidth, sanitizeText } from './sanitize.ts';
import { formatClock, padEndTo, padStartTo, type Glyphs } from './format.ts';

import type { LogLevel } from '../cli-settings.ts';
import type { LogfmtValue } from './logfmt.ts';

export type ActivityLevel = LogLevel;

/**
 * The states a row can be in, in the order the table sorts them: whoever is waiting for a
 * person comes first. The words are the cockpit's own (`packages/web/src/lib/attention.ts`),
 * lower case, so one vocabulary covers both surfaces.
 */
export const TASK_STATES = [
  'needs permission',
  'needs you',
  'needs review',
  'running',
  'monitoring',
  'scheduled',
  'queued',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** Sort key: the array index. `monitoring` sits with `running`, as the cockpit's Working bucket. */
const STATE_ORDER = new Map<TaskState, number>(TASK_STATES.map((s, i) => [s, i]));

export interface ActivityEntry {
  at: Date;
  level: ActivityLevel;
  /** A task's first 8 id characters, or a source word (`http`, `mcp`, `xezar`, `registry`). */
  subject: string;
  /** The human message. Already sanitized by whoever built it. */
  message: string;
  /** Extra lines belonging to the SAME entry — a task URL, a server's own message. */
  continuation?: readonly string[];
  /** The plain-output `event=` name. */
  event: string;
  /** The plain-output fields, in the order they are printed. */
  fields?: ReadonlyArray<readonly [string, LogfmtValue]>;
  /** Set on the entries folding must never touch, whatever the level says. */
  neverFold?: boolean;
}

export interface TaskRow {
  /** The full run id. The table prints the first 8, matching the branch `xez/<id8>`. */
  id: string;
  state: TaskState;
  /** The current step's name. Absent for a queued task. */
  step?: string;
  /** The agent's product name. */
  agent?: string;
  /** When this task started, as a millisecond timestamp. Drives the Time column. */
  startedAtMs: number;
  title: string;
}

/** Rank is `LOG_LEVELS` order; a message prints when its rank is at or above the threshold. */
const LEVEL_RANK: Record<ActivityLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function passesLevel(level: ActivityLevel, threshold: ActivityLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[threshold];
}

/** The live table shows at most this many rows; the rest become one overflow line (§ 6.3). */
export const MAX_TABLE_ROWS = 10;

/** Sort rows the way the design orders them: by state, then oldest first inside a state. */
export function sortTaskRows(rows: readonly TaskRow[]): TaskRow[] {
  return [...rows].sort((a, b) => {
    const byState = (STATE_ORDER.get(a.state) ?? 99) - (STATE_ORDER.get(b.state) ?? 99);
    if (byState !== 0) return byState;
    return a.startedAtMs - b.startedAtMs;
  });
}

// ---- the activity line -------------------------------------------------------

/** `  HH:MM:SS  level  subject  ` — the fixed part every wide line starts with. */
const TIME_WIDTH = 8;
const LEVEL_WIDTH = 5;
const SUBJECT_WIDTH = 8;
/** 2 indent + time + 2 + level + 2 + subject + 2 */
export const MESSAGE_COLUMN = 2 + TIME_WIDTH + 2 + LEVEL_WIDTH + 2 + SUBJECT_WIDTH + 2;

/** Below this width an entry becomes a two-part block instead of one line (§ 12.1). */
export const STACKED_COLUMNS = 60;

export interface LineOptions {
  columns: number;
  glyphs: Glyphs;
  /** Local `HH:MM:SS` for this entry. */
  time: string;
}

/**
 * Lay one entry out as the human form, wide (≥ 60 columns): time, level and subject on the
 * left, message in one column, continuations indented under the message.
 *
 * A message longer than its column is cut with `…` rather than wrapped onto a third and fourth
 * line: an entry that can grow without bound is an entry that can push the live region off the
 * screen, and the whole message is in the cockpit one click away.
 *
 * A URL continuation is the ONE thing never cut (§ 6.2): a cut URL is not a URL.
 */
export function formatWideEntry(entry: ActivityEntry, options: LineOptions): string[] {
  const width = Math.max(options.columns, MESSAGE_COLUMN + 10);
  const room = width - MESSAGE_COLUMN;
  const head =
    '  ' +
    padEndTo(options.time, TIME_WIDTH) +
    '  ' +
    padEndTo(entry.level, LEVEL_WIDTH) +
    '  ' +
    padEndTo(cutToWidth(entry.subject, SUBJECT_WIDTH, options.glyphs.ellipsis), SUBJECT_WIDTH) +
    '  ';
  const lines = [head + cutToWidth(entry.message, room, options.glyphs.ellipsis)];
  const indent = ' '.repeat(MESSAGE_COLUMN);
  for (const extra of entry.continuation ?? []) {
    lines.push(indent + (isUrl(extra) ? extra : cutToWidth(extra, room, options.glyphs.ellipsis)));
  }
  return lines;
}

/**
 * Lay one entry out stacked, for a terminal under 60 columns: time, level and subject on line
 * one, the message indented 4 under it, at most 3 lines with the last one cut.
 *
 * Wrapping here rather than cutting is deliberate and is the opposite of the wide form: at 40
 * columns a cut message says almost nothing, and these lines are ordinary scrollback that the
 * terminal owns — only the live region has to fit exactly.
 */
export function formatStackedEntry(entry: ActivityEntry, options: LineOptions): string[] {
  const width = Math.max(options.columns, 20);
  const head = `  ${padEndTo(options.time, TIME_WIDTH)} ${padEndTo(entry.level, LEVEL_WIDTH)} ${entry.subject}`;
  const lines = [cutToWidth(head, width, options.glyphs.ellipsis)];
  const room = Math.max(width - 4, 8);
  lines.push(...wrapTo(entry.message, room, 3, options.glyphs.ellipsis).map((l) => `    ${l}`));
  for (const extra of entry.continuation ?? []) {
    // A URL is never cut; it wraps as many lines as it needs and most terminals still link it.
    const parts = isUrl(extra)
      ? hardWrap(extra, room)
      : wrapTo(extra, room, 3, options.glyphs.ellipsis);
    lines.push(...parts.map((l) => `    ${l}`));
  }
  return lines;
}

function isUrl(text: string): boolean {
  return /^https?:\/\//.test(text);
}

/** Wrap on spaces to at most `maxLines`, cutting the last line with `…` if more remains. */
export function wrapTo(text: string, width: number, maxLines: number, ellipsis: string): string[] {
  const words = text.split(' ').filter((w) => w !== '');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (displayWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current !== '') lines.push(current);
    // A single word wider than the line is hard-wrapped rather than left to the terminal.
    if (displayWidth(word) > width) {
      const pieces = hardWrap(word, width);
      lines.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? '';
    } else {
      current = word;
    }
    if (lines.length >= maxLines) break;
  }
  if (current !== '' && lines.length < maxLines) lines.push(current);
  if (lines.length === 0) return [''];
  if (lines.length > maxLines) lines.length = maxLines;
  // Anything left over is announced by cutting the last line we kept.
  const consumed = lines.join(' ');
  if (displayWidth(consumed) < displayWidth(text)) {
    const last = lines[lines.length - 1] ?? '';
    lines[lines.length - 1] = cutToWidth(`${last} ${ellipsis}`, width, ellipsis);
  }
  return lines;
}

function hardWrap(text: string, width: number): string[] {
  const out: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const char of text) {
    const w = displayWidth(char);
    if (currentWidth + w > width && current !== '') {
      out.push(current);
      current = '';
      currentWidth = 0;
    }
    current += char;
    currentWidth += w;
  }
  if (current !== '') out.push(current);
  return out.length > 0 ? out : [''];
}

// ---- the live region ---------------------------------------------------------

export interface RegionOptions {
  columns: number;
  glyphs: Glyphs;
  /** The cockpit URL, for the empty state and the overflow line. */
  url?: string;
  /** The boot project's id, for the same two lines. */
  projectId?: string;
  /** Tasks that ended `failed` since this process started (§ 6.3 — task outcomes only). */
  failedSinceStart: number;
  /** Now, as a millisecond timestamp, for the Time column. */
  nowMs: number;
}

interface TableLayout {
  task: number;
  state: number;
  step?: number;
  agent?: number;
  time: number;
  title: number;
}

/** Work out which columns fit, dropping Agent first, then Step (§ 12.2). Null = no table. */
export function tableLayout(columns: number): TableLayout | null {
  const TASK = 8;
  const STATE = 12;
  const STEP = 10;
  const AGENT = 11;
  const TIME = 7;
  const MIN_TITLE = 12;
  const base = 2 + TASK + 2 + STATE + 2 + TIME + 2;
  const withBoth = base + STEP + 2 + AGENT + 2;
  if (columns - withBoth >= MIN_TITLE) {
    return { task: TASK, state: STATE, step: STEP, agent: AGENT, time: TIME, title: columns - withBoth };
  }
  const withStep = base + STEP + 2;
  if (columns - withStep >= MIN_TITLE) {
    return { task: TASK, state: STATE, step: STEP, time: TIME, title: columns - withStep };
  }
  if (columns - base >= MIN_TITLE) {
    return { task: TASK, state: STATE, time: TIME, title: columns - base };
  }
  return null;
}

/**
 * The summary line: `4 active — 1 needs review · 2 running · 1 queued — 1 failed since start`.
 * Zero parts are left out; `<n> active` never is.
 */
export function formatSummary(
  rows: readonly TaskRow[],
  failedSinceStart: number,
  glyphs: Glyphs,
  options: { sinceStart?: boolean } = {},
): string {
  const counts = new Map<TaskState, number>();
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  const parts: string[] = [];
  for (const state of TASK_STATES) {
    const n = counts.get(state) ?? 0;
    if (n > 0) parts.push(`${n} ${state}`);
  }
  const head = `${rows.length} active`;
  const middle = parts.length > 0 ? ` ${glyphs.dash} ${parts.join(` ${glyphs.dot} `)}` : '';
  const sinceStart = options.sinceStart !== false;
  const tail =
    failedSinceStart > 0
      ? ` ${glyphs.dash} ${failedSinceStart} failed${sinceStart ? ' since start' : ''}`
      : '';
  return head + middle + tail;
}

/**
 * The narrow (< 60 columns) live region: one line, never wrapped.
 *
 * Parts that do not fit are dropped from the RIGHT and replaced with `…`. Two are never
 * dropped — `<n> active` and the needs-permission and needs-you counts — because they are the
 * whole reason the line is on screen (§ 6.3).
 */
export function formatNarrowSummary(
  rows: readonly TaskRow[],
  failedSinceStart: number,
  columns: number,
  glyphs: Glyphs,
): string {
  const full = formatSummary(rows, failedSinceStart, glyphs, { sinceStart: false });
  const room = Math.max(columns - 2, 10);
  if (displayWidth(full) <= room) return `  ${full}`;

  // Rebuild keeping only the parts that must never be dropped, then add back from the left
  // while they fit. `<n> active` is always first and always present.
  const counts = new Map<TaskState, number>();
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  const required: string[] = [];
  for (const state of ['needs permission', 'needs you'] as const) {
    const n = counts.get(state) ?? 0;
    if (n > 0) required.push(`${n} ${state}`);
  }
  const optional: string[] = [];
  for (const state of TASK_STATES) {
    if (state === 'needs permission' || state === 'needs you') continue;
    const n = counts.get(state) ?? 0;
    if (n > 0) optional.push(`${n} ${state}`);
  }

  const head = `${rows.length} active`;
  const render = (parts: readonly string[], withFailed: boolean): string =>
    head +
    (parts.length > 0 ? ` ${glyphs.dash} ${parts.join(` ${glyphs.dot} `)}` : '') +
    (withFailed && failedSinceStart > 0 ? ` ${glyphs.dash} ${failedSinceStart} failed` : '');

  let best = render(required, false);
  for (let take = optional.length; take >= 0; take--) {
    const candidate = render([...required, ...optional.slice(0, take)], true);
    if (displayWidth(candidate) <= room) return `  ${candidate}`;
    const withoutFailed = render([...required, ...optional.slice(0, take)], false);
    if (displayWidth(withoutFailed) <= room) return `  ${withoutFailed}`;
  }
  // Even the required parts do not fit: cut, keeping the ellipsis inside the width so the
  // line still never wraps. A wrapped region line is debris on the next redraw.
  best = cutToWidth(best, room, glyphs.ellipsis);
  return `  ${best}`;
}

/**
 * The whole live region, as the lines it occupies. Every line is already cut to `columns`,
 * so the caller can count them and move the cursor back over exactly that many.
 */
export function formatRegion(rows: readonly TaskRow[], options: RegionOptions): string[] {
  const { glyphs, columns } = options;
  const layout = tableLayout(columns);
  if (layout === null) {
    // Narrow: one line. An empty list still says so — silence is not an empty state.
    if (rows.length === 0) return [`  No active tasks`];
    return [formatNarrowSummary(rows, options.failedSinceStart, columns, glyphs)];
  }

  const title = ` active tasks `;
  const ruleWidth = Math.max(columns - 2 - 2 - title.length, 3);
  const lines: string[] = [
    cutToWidth(`  ${glyphs.rule}${title}${glyphs.rule.repeat(ruleWidth)}`, columns, glyphs.ellipsis),
  ];

  if (rows.length === 0) {
    const where =
      options.url && options.projectId
        ? ` ${glyphs.dash} start one at ${options.url}/p/${options.projectId}/new`
        : '';
    lines.push(cutToWidth(`  No active tasks${where}`, columns, glyphs.ellipsis));
    return lines;
  }

  const sorted = sortTaskRows(rows);
  const shown = sorted.slice(0, MAX_TABLE_ROWS);
  const hidden = sorted.length - shown.length;

  lines.push(headerRow(layout, glyphs));
  for (const row of shown) lines.push(taskRowLine(row, layout, options));

  if (hidden > 0) {
    const where =
      options.url && options.projectId ? ` ${glyphs.dash} see ${options.url}/p/${options.projectId}/tasks` : '';
    const kind = sorted[sorted.length - 1]?.state ?? 'queued';
    lines.push(cutToWidth(`  +${hidden} more ${kind}${where}`, columns, glyphs.ellipsis));
  }

  lines.push(
    cutToWidth(`  ${formatSummary(sorted, options.failedSinceStart, glyphs)}`, columns, glyphs.ellipsis),
  );
  return lines;
}

function headerRow(layout: TableLayout, glyphs: Glyphs): string {
  const cells = ['  ' + padEndTo('Task', layout.task), padEndTo('State', layout.state)];
  if (layout.step !== undefined) cells.push(padEndTo('Step', layout.step));
  if (layout.agent !== undefined) cells.push(padEndTo('Agent', layout.agent));
  cells.push(padStartTo('Time', layout.time));
  cells.push('Title');
  void glyphs;
  return cells.join('  ');
}

function taskRowLine(row: TaskRow, layout: TableLayout, options: RegionOptions): string {
  const { glyphs } = options;
  const cells = [
    '  ' + padEndTo(row.id.slice(0, layout.task), layout.task),
    padEndTo(cutToWidth(row.state, layout.state, glyphs.ellipsis), layout.state),
  ];
  if (layout.step !== undefined) {
    const step = row.step ? cutToWidth(sanitizeText(row.step), layout.step, glyphs.ellipsis) : glyphs.missing;
    cells.push(padEndTo(step, layout.step));
  }
  if (layout.agent !== undefined) {
    const agent = row.agent ? cutToWidth(row.agent, layout.agent, glyphs.ellipsis) : glyphs.missing;
    cells.push(padEndTo(agent, layout.agent));
  }
  cells.push(padStartTo(formatClock(options.nowMs - row.startedAtMs), layout.time));
  cells.push(cutToWidth(sanitizeText(row.title), layout.title, glyphs.ellipsis));
  return cells.join('  ');
}
