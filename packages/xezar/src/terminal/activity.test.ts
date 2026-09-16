/**
 * AC-08, the layout half — the live region and the activity lines at 80 and at 40 columns,
 * checked against `designs/cli-terminal/tty.txt` and `tty-narrow.txt`.
 *
 * Named breaks: `narrow-overflow` (a region line wider than the terminal, which wraps and then
 * makes every later redraw eat a line of scrollback) and the design's own rule that no printed
 * line may pass the width ruler.
 */

import { describe, expect, it } from 'vitest';

import {
  formatNarrowSummary,
  formatRegion,
  formatStackedEntry,
  formatSummary,
  formatWideEntry,
  MAX_TABLE_ROWS,
  MESSAGE_COLUMN,
  passesLevel,
  sortTaskRows,
  tableLayout,
  type ActivityEntry,
  type TaskRow,
} from './activity.ts';
import { UTF8_GLYPHS } from './format.ts';
import { displayWidth } from './sanitize.ts';

const G = UTF8_GLYPHS;
const NOW = 1_000_000_000;

function row(over: Partial<TaskRow> & Pick<TaskRow, 'id' | 'state'>): TaskRow {
  return {
    startedAtMs: NOW - 2_000,
    title: 'Fix login redirect after sign-out',
    step: 'implement',
    agent: 'Claude Code',
    ...over,
  };
}

function region(rows: readonly TaskRow[], columns: number, failed = 0): string[] {
  return formatRegion(rows, {
    columns,
    glyphs: G,
    failedSinceStart: failed,
    nowMs: NOW,
    url: 'http://localhost:4322',
    projectId: 'beta',
  });
}

describe('the table at 80 columns', () => {
  const rows = [
    row({ id: 'a12bc345', state: 'running' }),
    row({ id: 'b98de765', state: 'queued', step: undefined, agent: 'Codex', title: 'Bump vitest to 3.2' }),
  ];

  it('draws a rule line, a header, one line per task and a summary', () => {
    const lines = region(rows, 80);
    expect(lines[0]).toMatch(/^ {2}─ active tasks ─+$/);
    expect(lines[1]).toBe('  Task      State         Step        Agent           Time  Title');
    expect(lines).toHaveLength(2 + rows.length + 1);
    expect(lines[lines.length - 1]).toBe('  2 active — 1 running · 1 queued');
  });

  it('lays the columns out exactly as the design capture does', () => {
    const lines = region(rows, 80);
    expect(lines[2]).toBe(
      '  a12bc345  running       implement   Claude Code     0:02  Fix login redirect…',
    );
    expect(lines[3]).toBe(
      '  b98de765  queued        —           Codex           0:02  Bump vitest to 3.2',
    );
  });

  it('never prints a line past the width ruler', () => {
    for (const line of region(rows, 80)) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });
});

describe('the table under pressure', () => {
  it('shows at most ten rows and one overflow line', () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      row({ id: `id${String(i).padStart(6, '0')}`, state: 'queued', startedAtMs: NOW - i * 1000 }),
    );
    const lines = region(many, 80);
    const body = lines.slice(2, -1);
    expect(body).toHaveLength(MAX_TABLE_ROWS + 1);
    expect(body[body.length - 1]).toContain('+3 more queued');
    expect(lines[lines.length - 1]).toBe('  13 active — 13 queued');
  });

  it('orders by who is waiting, then oldest first inside a state', () => {
    const sorted = sortTaskRows([
      row({ id: 'r1', state: 'running', startedAtMs: NOW - 1000 }),
      row({ id: 'q1', state: 'queued', startedAtMs: NOW - 9000 }),
      row({ id: 'y1', state: 'needs you', startedAtMs: NOW - 500 }),
      row({ id: 'r2', state: 'running', startedAtMs: NOW - 8000 }),
      row({ id: 'p1', state: 'needs permission', startedAtMs: NOW - 10 }),
      row({ id: 'v1', state: 'needs review', startedAtMs: NOW - 100 }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['p1', 'y1', 'v1', 'r2', 'r1', 'q1']);
  });

  it('cuts a long title inside the Title column, never past it', () => {
    const lines = region([row({ id: 'a1', state: 'running', title: 'x'.repeat(200) })], 80);
    expect(displayWidth(lines[2] ?? '')).toBeLessThanOrEqual(80);
    expect(lines[2]).toMatch(/…$/);
  });

  it('cleans an injected title before it reaches a cell', () => {
    const lines = region([row({ id: 'a1', state: 'running', title: 'Fix \u001b[2Jlogin' })], 80);
    expect(lines[2]).toContain('Fix login');
    expect(lines[2]).not.toContain('\u001b');
  });
});

describe('the empty state', () => {
  it('says so at 80 columns, and names where to start one', () => {
    const lines = region([], 80);
    expect(lines[1]).toBe('  No active tasks — start one at http://localhost:4322/p/beta/new');
    expect(lines).toHaveLength(2);
  });

  it('says so at 40 columns, without the URL', () => {
    expect(region([], 40)).toEqual(['  No active tasks']);
  });
});

describe('the narrow live region', () => {
  const rows = [
    row({ id: 'e5b7c3d9', state: 'running' }),
    row({ id: 'd0e2f6a1', state: 'running' }),
  ];

  it('is exactly one line, matching the narrow grammar', () => {
    const lines = region(rows, 40, 1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('  2 active — 2 running — 1 failed');
  });

  it('leaves out “since start” — that is the wide form only', () => {
    expect(formatSummary(rows, 1, G)).toContain('failed since start');
    expect(formatNarrowSummary(rows, 1, 40, G)).not.toContain('since start');
  });

  it('never wraps, whatever it has to drop', () => {
    const crowded = [
      row({ id: 'p', state: 'needs permission' }),
      row({ id: 'y', state: 'needs you' }),
      row({ id: 'v', state: 'needs review' }),
      row({ id: 'r', state: 'running' }),
      row({ id: 's', state: 'scheduled' }),
      row({ id: 'q', state: 'queued' }),
    ];
    for (const columns of [20, 30, 40, 50, 59]) {
      const line = formatNarrowSummary(crowded, 4, columns, G);
      expect(displayWidth(line), `columns=${columns}`).toBeLessThanOrEqual(columns);
    }
  });

  it('never drops the active count or the two counts that mean a person is needed', () => {
    const crowded = [
      row({ id: 'p', state: 'needs permission' }),
      row({ id: 'y', state: 'needs you' }),
      row({ id: 'q1', state: 'queued' }),
      row({ id: 'q2', state: 'queued' }),
    ];
    const line = formatNarrowSummary(crowded, 0, 45, G);
    expect(line).toContain('4 active');
    expect(line).toContain('1 needs permission');
    expect(line).toContain('1 needs you');
  });
});

describe('the summary line', () => {
  it('leaves out every zero part except the active count', () => {
    expect(formatSummary([], 0, G)).toBe('0 active');
    expect(formatSummary([row({ id: 'a', state: 'running' })], 0, G)).toBe('1 active — 1 running');
  });

  it('matches the design capture with several states and a failure', () => {
    const rows = [
      row({ id: 'a', state: 'needs review' }),
      row({ id: 'b', state: 'running' }),
      row({ id: 'c', state: 'monitoring' }),
      row({ id: 'd', state: 'queued' }),
    ];
    expect(formatSummary(rows, 1, G)).toBe(
      '4 active — 1 needs review · 1 running · 1 monitoring · 1 queued — 1 failed since start',
    );
  });
});

describe('column dropping, in the order the design names', () => {
  it('drops Agent first, then Step, and never lets Title fall under 12', () => {
    expect(tableLayout(80)).toMatchObject({ step: 10, agent: 11, title: 20 });
    expect(tableLayout(70)?.agent).toBeUndefined();
    expect(tableLayout(70)?.step).toBe(10);
    expect(tableLayout(60)?.agent).toBeUndefined();
    const narrow = tableLayout(50);
    expect(narrow?.step).toBeUndefined();
    expect(narrow?.title).toBeGreaterThanOrEqual(12);
  });

  it('answers “no table” once even Task, State and Time leave no room for a title', () => {
    expect(tableLayout(40)).toBeNull();
    expect(tableLayout(30)).toBeNull();
  });

  it('keeps every row inside the width at every width it still draws a table', () => {
    const rows = [row({ id: 'a12bc345', state: 'needs review', title: 'x'.repeat(120) })];
    for (let columns = 36; columns <= 200; columns++) {
      for (const line of region(rows, columns)) {
        expect(displayWidth(line), `columns=${columns}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns);
      }
    }
  });
});

describe('an activity line, wide', () => {
  const at = new Date(2026, 8, 15, 10, 12, 8);
  const base: ActivityEntry = {
    at,
    level: 'error',
    subject: 'a12bc345',
    message: 'check unit-tests failed — exit 1 · 2m 23s',
    event: 'gate.failed',
  };

  it('matches the design capture', () => {
    const [line] = formatWideEntry(base, { columns: 80, glyphs: G, time: '10:12:08' });
    expect(line).toBe('  10:12:08  error  a12bc345  check unit-tests failed — exit 1 · 2m 23s');
  });

  it('puts the message in a fixed column, so the eye runs down one column', () => {
    const [line] = formatWideEntry(base, { columns: 80, glyphs: G, time: '10:12:08' });
    expect(line?.indexOf('check')).toBe(MESSAGE_COLUMN);
  });

  it('indents a continuation to the message column and never cuts a URL', () => {
    const url = 'http://localhost:4322/p/beta/tasks/b98de765-and-a-very-long-tail-that-passes-80';
    const lines = formatWideEntry({ ...base, continuation: [url] }, { columns: 80, glyphs: G, time: '10:12:08' });
    expect(lines[1]).toBe(' '.repeat(MESSAGE_COLUMN) + url);
  });

  it('cuts a message that would pass the width', () => {
    const lines = formatWideEntry({ ...base, message: 'y'.repeat(200) }, { columns: 80, glyphs: G, time: '10:12:08' });
    expect(displayWidth(lines[0] ?? '')).toBeLessThanOrEqual(80);
  });
});

describe('an activity line, stacked under 60 columns', () => {
  const entry: ActivityEntry = {
    at: new Date(),
    level: 'warn',
    subject: 'b98de765',
    message: 'needs you — “Pin vitest to 3.2.4 or allow 3.2.x?”',
    continuation: ['http://localhost:4322/p/beta/tasks/b98de765'],
    event: 'question.asked',
  };

  it('puts time, level and subject on one line and the message under it', () => {
    const lines = formatStackedEntry(entry, { columns: 40, glyphs: G, time: '10:14:30' });
    expect(lines[0]).toBe('  10:14:30 warn  b98de765');
    expect(lines[1]).toMatch(/^ {4}needs you/);
  });

  it('wraps a URL rather than cutting it, however narrow the terminal', () => {
    const lines = formatStackedEntry(entry, { columns: 40, glyphs: G, time: '10:14:30' });
    const joined = lines.slice(1).join('').replace(/\s+/g, '');
    expect(joined).toContain('http://localhost:4322/p/beta/tasks/b98de765');
  });
});

describe('the level filter', () => {
  it('passes a level at or above the threshold and nothing below it', () => {
    expect(passesLevel('error', 'warn')).toBe(true);
    expect(passesLevel('warn', 'warn')).toBe(true);
    expect(passesLevel('info', 'warn')).toBe(false);
    expect(passesLevel('debug', 'info')).toBe(false);
    expect(passesLevel('debug', 'debug')).toBe(true);
  });
});

it('sanitizes the step cell before measuring and truncating it', () => {
  const lines = formatRegion([row({ id: 'a', state: 'running', step: 'deploy\u001b[2J\nforged' })], {
    columns: 80, glyphs: G, failedSinceStart: 0, nowMs: 0,
  });
  expect(lines.join('\n')).not.toContain('\u001b');
  expect(lines).toHaveLength(4);
});
