import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MCP_JOURNAL_PAGE_BYTES,
  MCP_JOURNAL_PAGE_ROWS,
  MCP_JOURNAL_RETAINED_ROWS,
  mcpJournalReadResultSchema,
  type McpJournalAppendInput,
  type McpJournalReadResult,
  type McpJournalRow,
} from '@qodeca/xezar-contract';

import { EventJournal, McpJournalCursorError, type EventJournalOptions } from './event-journal.ts';

const DAY = 24 * 60 * 60 * 1_000;
const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const PACKAGE_DIR = fileURLToPath(new URL('../..', import.meta.url));
const MODULE_URL = pathToFileURL(fileURLToPath(new URL('./event-journal.ts', import.meta.url))).href;

let dataDir: string;
const open: EventJournal[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'xez-journal-'));
});

afterEach(() => {
  for (const journal of open.splice(0)) journal.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function openJournal(opts: Partial<EventJournalOptions> = {}): EventJournal {
  const journal = EventJournal.open({ dataDir, projectId: 'alpha', secretValues: [], warn: () => {}, ...opts });
  open.push(journal);
  return journal;
}

function restart(journal: EventJournal, opts: Partial<EventJournalOptions> = {}): EventJournal {
  journal.close();
  return openJournal(opts);
}

function event(n: number, over: Partial<McpJournalAppendInput> = {}): McpJournalAppendInput {
  return {
    category: 'E-01',
    kind: 'task.terminal',
    subject: { type: 'run', id: `run-${n}`, version: `rev1:run:run-${n}:${n}:0123456789ab` },
    origin: 'human',
    causedBy: null,
    summary: `task ${n} finished`,
    ...over,
  };
}

function page(result: McpJournalReadResult) {
  if (result.status !== 'ok') throw new Error(`expected a page, got ${result.status}`);
  return result;
}

const rowsFile = () => join(dataDir, 'mcp', 'event-journal.ndjson');
const indexFile = () => join(dataDir, 'mcp', 'event-journal.json');

/** A journal on disk as a previous process left it — `count` rows all written at `ts`. */
function writeFixture(count: number, ts: number, epoch = 'fixture-epoch'): void {
  mkdirSync(join(dataDir, 'mcp'), { recursive: true });
  writeFileSync(indexFile(), JSON.stringify({ v: 1, projectId: 'alpha', epoch, createdAt: new Date(ts).toISOString() }));
  const lines: string[] = [];
  for (let seq = 1; seq <= count; seq++) {
    lines.push(JSON.stringify({
      eventId: `alpha:${seq}`,
      journalSeq: seq,
      ts: new Date(ts).toISOString(),
      projectId: 'alpha',
      ...event(seq),
    }));
  }
  writeFileSync(rowsFile(), `${lines.join('\n')}\n`);
}

describe('the per-project event journal (#103)', () => {
  it('appends, survives a real process restart, and replays in order from a cursor', () => {
    // Two separate node processes: the writer exits before the reader starts, so nothing but the
    // files on disk can carry the rows across.
    const writer = `
      const { EventJournal } = await import(${JSON.stringify(MODULE_URL)});
      const j = EventJournal.open({ dataDir: process.env.JOURNAL_DIR, projectId: 'alpha', secretValues: [] });
      const origins = ['human', 'leader', 'system', 'leader', 'human'];
      let cursorAfterTwo;
      for (let n = 1; n <= 5; n++) {
        const origin = origins[n - 1];
        j.append({
          category: n % 2 ? 'E-01' : 'E-04', kind: 'task.terminal',
          subject: { type: 'run', id: 'run-' + n, version: 'rev1:run:run-' + n + ':' + n + ':0123456789ab' },
          origin, causedBy: origin === 'leader' ? 'op-' + n + '-0000000' : null, summary: 'event ' + n,
        });
        if (n === 2) cursorAfterTwo = j.headCursor();
      }
      process.stdout.write(JSON.stringify({ cursorAfterTwo, epoch: j.epoch }));
    `;
    const reader = `
      const { EventJournal } = await import(${JSON.stringify(MODULE_URL)});
      const j = EventJournal.open({ dataDir: process.env.JOURNAL_DIR, projectId: 'alpha', secretValues: [] });
      process.stdout.write(JSON.stringify({ result: j.read({ cursor: process.env.JOURNAL_CURSOR }), epoch: j.epoch }));
    `;
    const run = (script: string, env: Record<string, string>) =>
      execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: PACKAGE_DIR,
        env: { ...process.env, ...env },
        encoding: 'utf8',
      });

    const written = JSON.parse(run(writer, { JOURNAL_DIR: dataDir })) as { cursorAfterTwo: string; epoch: string };
    const read = JSON.parse(run(reader, { JOURNAL_DIR: dataDir, JOURNAL_CURSOR: written.cursorAfterTwo })) as { result: unknown; epoch: string };

    expect(read.epoch).toBe(written.epoch);
    const result = page(mcpJournalReadResultSchema.parse(read.result));
    expect(result.events.map((row) => row.journalSeq)).toEqual([3, 4, 5]);
    expect(result.events.map((row) => row.eventId)).toEqual(['alpha:3', 'alpha:4', 'alpha:5']);
    expect(result.events.map((row) => [row.origin, row.causedBy])).toEqual([
      ['system', null],
      ['leader', 'op-4-0000000'],
      ['human', null],
    ]);
    expect(result.hasMore).toBe(false);
    expect(result.latestSeq).toBe(5);
  });

  it('numbers rows per project, gapless, and keeps numbering after an in-process restart', () => {
    let journal = openJournal();
    journal.append(event(1));
    journal.append(event(2));
    const cursor = journal.headCursor();
    journal = restart(journal);
    const third = journal.append(event(3));

    expect(third?.journalSeq).toBe(3);
    expect(third?.eventId).toBe('alpha:3');
    expect(page(journal.read({ cursor })).events.map((row) => row.journalSeq)).toEqual([3]);
    expect(page(journal.read()).events.map((row) => row.journalSeq)).toEqual([1, 2, 3]);
  });

  it('stores origin, causedBy, subject version and source on every row, and replays them unchanged', () => {
    const journal = openJournal();
    journal.append(event(1, { origin: 'leader', causedBy: 'op-000000001', source: { runId: 'run-1', runSeq: 331 } }));
    journal.append(event(2, { origin: 'system', causedBy: 'op-000000001', subject: { type: 'executor', id: 'codex', version: null } }));
    journal.append(event(3));

    const stored = readFileSync(rowsFile(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const row of stored) {
      expect(row).toHaveProperty('origin');
      expect(row).toHaveProperty('causedBy'); // present even when null — never a missing key
      expect(row).toHaveProperty('subject.version');
    }
    const replayed = page(restart(journal).read()).events;
    expect(replayed.map((row) => [row.origin, row.causedBy, row.subject.version, row.source ?? null])).toEqual([
      ['leader', 'op-000000001', 'rev1:run:run-1:1:0123456789ab', { runId: 'run-1', runSeq: 331 }],
      ['system', 'op-000000001', null, null],
      ['human', null, 'rev1:run:run-3:3:0123456789ab', null],
    ]);
  });

  it('refuses a leader row that does not name its operation (the echo guard needs it)', () => {
    const journal = openJournal();
    expect(() => journal.append(event(1, { origin: 'leader', causedBy: null }))).toThrow(/operation/);
    expect(journal.latestSeq).toBe(0);
  });

  it('scrubs secrets from a summary before it reaches the file (F-15)', () => {
    const journal = openJournal({ secretValues: ['hunter2-hunter2-hunter2'] });
    const token = `ghp_${'a'.repeat(36)}`;
    journal.append(event(1, { summary: `used hunter2-hunter2-hunter2 and ${token}` }));

    const file = readFileSync(rowsFile(), 'utf8');
    expect(file).not.toContain('hunter2-hunter2-hunter2');
    expect(file).not.toContain(token);
    expect(page(journal.read()).events[0]?.summary).toBe('used [REDACTED] and [REDACTED]');
  });

  it('ends a page at 100 rows, or at 40 000 bytes of rows, whichever comes first', () => {
    const journal = openJournal();
    for (let n = 1; n <= 150; n++) journal.append(event(n));
    const first = page(journal.read());
    expect(first.events).toHaveLength(MCP_JOURNAL_PAGE_ROWS);
    expect(first.hasMore).toBe(true);
    const second = page(journal.read({ cursor: first.nextCursor }));
    expect(second.events.map((row) => row.journalSeq)).toEqual(Array.from({ length: 50 }, (_, i) => 101 + i));
    expect(second.hasMore).toBe(false);
    expect(page(journal.read({ cursor: second.nextCursor })).events).toEqual([]);
    expect(page(journal.read({ limit: 3 })).events).toHaveLength(3);

    const wide = restart(journal);
    for (let n = 151; n <= 300; n++) wide.append(event(n, { summary: 'x'.repeat(500) }));
    const budgeted = page(wide.read({ cursor: second.nextCursor }));
    const bytes = budgeted.events.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
    expect(budgeted.events.length).toBeLessThan(MCP_JOURNAL_PAGE_ROWS);
    expect(bytes).toBeLessThanOrEqual(MCP_JOURNAL_PAGE_BYTES);
    expect(budgeted.hasMore).toBe(true);
  });

  describe('retention and the explicit gap (D-05 § 6.5, D-09 B-19)', () => {
    it('answers a cursor older than retention with cursor_too_old and a pointer to current state', () => {
      writeFixture(MCP_JOURNAL_RETAINED_ROWS, T0 - 20 * DAY);
      let now = T0;
      let journal = openJournal({ now: () => now });
      const afterOne = page(journal.read({ limit: 1 })).nextCursor;
      const afterTwo = page(journal.read({ limit: 2 })).nextCursor;
      expect(journal.oldestSeq).toBe(1);

      // Two new rows push two twenty-day-old rows out of the retained 10 000.
      journal.append(event(10_001));
      journal.append(event(10_002));
      expect(journal.oldestSeq).toBe(3);

      const gap = journal.read({ cursor: afterOne });
      expect(gap).toEqual({
        status: 'cursor_too_old',
        oldestSeq: 3,
        latestSeq: 10_002,
        resumeCursor: expect.any(String),
        recovery: { required: 'current-state', message: expect.stringMatching(/current state/) },
      });
      expect(mcpJournalReadResultSchema.parse(gap).status).toBe('cursor_too_old');
      // The cursor that still needs only retained rows keeps working: nothing it needs is gone.
      expect(page(journal.read({ cursor: afterTwo })).events[0]?.journalSeq).toBe(3);
      // Recovery continues from the oldest retained row, with no silent skip.
      if (gap.status !== 'cursor_too_old') throw new Error('unreachable');
      expect(page(journal.read({ cursor: gap.resumeCursor })).events[0]?.journalSeq).toBe(3);

      now += DAY;
      journal = restart(journal, { now: () => now });
      expect(journal.read({ cursor: afterOne }).status).toBe('cursor_too_old');
      expect(journal.oldestSeq).toBe(3);
    });

    it('never evicts a row younger than 14 days, however many there are', () => {
      writeFixture(MCP_JOURNAL_RETAINED_ROWS, T0 - 13 * DAY);
      const journal = openJournal({ now: () => T0 });
      const fromStart = page(journal.read({ limit: 1 })).nextCursor;
      journal.append(event(10_001));
      journal.append(event(10_002));

      expect(journal.oldestSeq).toBe(1);
      expect(page(journal.read({ cursor: fromStart })).events[0]?.journalSeq).toBe(2);
    });

    it('rewrites the file once evicted rows reach the retained count, keeping surviving lines verbatim', () => {
      writeFixture(2 * MCP_JOURNAL_RETAINED_ROWS, T0 - 30 * DAY);
      const before = readFileSync(rowsFile(), 'utf8').trim().split('\n');
      const journal = openJournal({ now: () => T0 });

      const after = readFileSync(rowsFile(), 'utf8').trim().split('\n');
      expect(after).toHaveLength(MCP_JOURNAL_RETAINED_ROWS);
      expect(after).toEqual(before.slice(MCP_JOURNAL_RETAINED_ROWS));
      expect(journal.oldestSeq).toBe(MCP_JOURNAL_RETAINED_ROWS + 1);
      expect(journal.append(event(1))?.journalSeq).toBe(2 * MCP_JOURNAL_RETAINED_ROWS + 1);
    });
  });

  describe('cursors', () => {
    it('rejects a project-B cursor presented to project A, without naming either project', () => {
      const a = openJournal({ projectId: 'alpha' });
      a.append(event(1));
      const bDir = mkdtempSync(join(tmpdir(), 'xez-journal-b-'));
      try {
        const b = EventJournal.open({ dataDir: bDir, projectId: 'bravo', secretValues: [], warn: () => {} });
        open.push(b);
        b.append(event(1));
        const foreign = page(b.read({ limit: 1 })).nextCursor;

        let caught: unknown;
        try { a.read({ cursor: foreign }); } catch (err) { caught = err; }
        expect(caught).toBeInstanceOf(McpJournalCursorError);
        const rejection = (caught as McpJournalCursorError).rejection;
        expect(rejection.error).toBe('cursor_project_mismatch');
        expect(rejection.message).not.toMatch(/alpha|bravo/);
      } finally {
        rmSync(bDir, { recursive: true, force: true });
      }
    });

    it.each([
      ['garbage', 'not a cursor at all'],
      ['empty JSON', Buffer.from('{}').toString('base64url')],
      ['oversized', 'A'.repeat(4_096)],
      ['past the head', 'FUTURE'],
    ])('rejects a malformed cursor (%s) instead of replaying from zero', (_name, raw) => {
      const journal = openJournal();
      journal.append(event(1));
      const cursor = raw === 'FUTURE'
        ? Buffer.from(JSON.stringify({ v: 1, p: 'alpha', e: journal.epoch, s: 99 })).toString('base64url')
        : raw;
      expect(() => journal.read({ cursor })).toThrow(McpJournalCursorError);
      try { journal.read({ cursor }); } catch (err) {
        expect((err as McpJournalCursorError).rejection.error).toBe('invalid_cursor');
      }
    });

    it('answers a cursor from a recreated journal (a new epoch) with the explicit gap', () => {
      let journal = openJournal();
      journal.append(event(1));
      const cursor = journal.headCursor();
      journal.close();
      rmSync(join(dataDir, 'mcp'), { recursive: true, force: true }); // the user deleted runtime state
      journal = openJournal();
      journal.append(event(1));

      expect(journal.read({ cursor }).status).toBe('cursor_too_old');
    });
  });

  describe('degradation — written, never required', () => {
    it.each<[string, () => void]>([
      ['an unparseable row', () => writeFileSync(rowsFile(), `${readFileSync(rowsFile(), 'utf8')}{not json\n${readFileSync(rowsFile(), 'utf8').split('\n')[0]}\n`)],
      ['a gap in the sequence', () => {
        const lines = readFileSync(rowsFile(), 'utf8').trim().split('\n');
        writeFileSync(rowsFile(), `${[lines[0], lines[2]].join('\n')}\n`);
      }],
      ['an unreadable index', () => writeFileSync(indexFile(), '{"v":')],
      ['a missing index beside real rows', () => rmSync(indexFile())],
      ['a row naming another project', () => writeFileSync(rowsFile(), readFileSync(rowsFile(), 'utf8').replaceAll('alpha', 'bravo'))],
    ])('starts fresh with ONE warning on %s, and does not throw', (_name, damage) => {
      const first = openJournal();
      for (let n = 1; n <= 3; n++) first.append(event(n));
      const oldCursor = first.headCursor();
      first.close();
      damage();

      const warn = vi.fn();
      const journal = openJournal({ warn });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/corrupt/);
      expect(journal.latestSeq).toBe(0);
      expect(existsSync(`${rowsFile()}.corrupt`)).toBe(true);
      expect(journal.read({ cursor: oldCursor }).status).toBe('cursor_too_old');
      expect(journal.append(event(1))?.journalSeq).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('drops a torn final line silently — that append never returned a number', () => {
      const first = openJournal();
      first.append(event(1));
      first.append(event(2));
      first.close();
      writeFileSync(rowsFile(), `${readFileSync(rowsFile(), 'utf8')}{"eventId":"alpha:3","journ`);

      const warn = vi.fn();
      const journal = openJournal({ warn });
      expect(warn).not.toHaveBeenCalled();
      expect(journal.latestSeq).toBe(2);
      expect(journal.append(event(3))?.journalSeq).toBe(3);
      expect(page(restart(journal).read()).events.map((row: McpJournalRow) => row.journalSeq)).toEqual([1, 2, 3]);
    });

    it('keeps working without a writable directory: rows are not journaled, one warning, no throw', () => {
      const blocked = join(dataDir, 'not-a-directory');
      writeFileSync(blocked, 'a file where the data directory should be');
      const warn = vi.fn();
      const journal = openJournal({ dataDir: blocked, warn });

      expect(journal.append(event(1))).toBeUndefined();
      expect(journal.append(event(2))).toBeUndefined();
      expect(journal.latestSeq).toBe(0); // no number spent on a row that is not durable
      expect(warn).toHaveBeenCalledTimes(1);
      expect(page(journal.read()).events).toEqual([]);
    });

    it('starts fresh, silently, when the state was simply deleted', () => {
      const warn = vi.fn();
      const journal = openJournal({ warn });
      expect(journal.latestSeq).toBe(0);
      expect(page(journal.read())).toMatchObject({ events: [], oldestSeq: null, latestSeq: 0, hasMore: false });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('allows one live writer per journal file', () => {
    const journal = openJournal();
    expect(() => EventJournal.open({ dataDir, projectId: 'alpha' })).toThrow(/already open/);
    journal.close();
    expect(() => openJournal()).not.toThrow();
  });

  it('tells a subscriber about each durable row as it lands', () => {
    const journal = openJournal();
    const seen: number[] = [];
    const stop = journal.subscribe((row) => seen.push(row.journalSeq));
    journal.append(event(1));
    stop();
    journal.append(event(2));
    expect(seen).toEqual([1]);
  });

  it('keeps its file apart from the per-run transcripts', () => {
    const journal = openJournal();
    journal.append(event(1));
    expect(rowsFile()).toBe(join(dataDir, 'mcp', 'event-journal.ndjson'));
    expect(existsSync(join(dataDir, 'runs'))).toBe(false);
  });
});
