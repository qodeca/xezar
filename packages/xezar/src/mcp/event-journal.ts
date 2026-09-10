import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import {
  MCP_JOURNAL_CURSOR_MAX_BYTES,
  MCP_JOURNAL_MIN_RETENTION_DAYS,
  MCP_JOURNAL_PAGE_BYTES,
  MCP_JOURNAL_PAGE_ROWS,
  MCP_JOURNAL_RETAINED_ROWS,
  mcpJournalAppendInputSchema,
  mcpJournalProjectIdSchema,
  mcpJournalRowSchema,
  type McpJournalAppendInput,
  type McpJournalCursorRejection,
  type McpJournalReadInput,
  type McpJournalReadResult,
  type McpJournalRow,
} from '@qodeca/xezar-contract';

import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';

/**
 * The per-project MCP event journal (#103): an append-only record of the significant events
 * (E-01–E-06) a project leader may see, with a replay cursor. Decided by D-05 § 6 and bounded by
 * D-09 § 3 — see `packages/contract/src/mcp-journal.ts` for every shape and number.
 *
 * WHAT THIS IS NOT. `RunStore` already keeps one NDJSON transcript per run, and
 * `GET /api/v1/runs/:id/events` replays one run from it with a cursor, deduping on the run's `seq`.
 * That `seq` is per RUN and may skip numbers (`emitEphemeral` allocates frames that never reach
 * disk). The workspace streams replay nothing at all. This journal is a separate file with its own
 * order: `journalSeq` is per PROJECT and gapless — only a durably appended row gets a number — so a
 * reader holding 1..N knows nothing between them is missing. Do not "fix" it into consistency with
 * the run `seq` next door; the difference is the point (D-05 § 6.1).
 *
 * Files, both under `<dataDir>/mcp/` (so inside `.local/`, covered by its blanket ignore rule):
 *  - `event-journal.json`   — `{ v, projectId, epoch, createdAt }`, zod-validated, written by
 *    atomic tmp+rename, and only when a journal is created or recreated.
 *  - `event-journal.ndjson` — one row per line, appended. Rewritten (tmp+rename) only to drop rows
 *    retention has already evicted; surviving lines are copied byte-for-byte, numbers unchanged.
 *
 * Zero config: written, never required. Missing files start a fresh journal; a corrupt one starts
 * fresh with ONE warning and the bad file kept beside it as `.corrupt`; an unwritable directory
 * drops rows (with one warning) and never throws into the caller. A fresh journal gets a new
 * `epoch`, so every cursor from the old one is answered `cursor_too_old` — never mis-resolved
 * against numbers that restarted at 1.
 *
 * One writer per project: this process holds at most one open journal per file (enforced below),
 * and the project's writer claim (#185) keeps a second xezar process off the same data directory.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;
const MIN_RETENTION_MS = MCP_JOURNAL_MIN_RETENTION_DAYS * DAY_MS;

const indexSchema = z.looseObject({
  v: z.literal(1),
  projectId: mcpJournalProjectIdSchema,
  epoch: z.string().min(1).max(64),
  createdAt: z.string(),
});

const cursorSchema = z.object({
  v: z.literal(1),
  p: z.string(),
  e: z.string(),
  s: z.number().int().nonnegative(),
});

/** A cursor refused outright — the caller maps `rejection` onto its own error answer (D-01/D-02). */
export class McpJournalCursorError extends Error {
  readonly rejection: McpJournalCursorRejection;

  constructor(error: McpJournalCursorRejection['error'], message: string) {
    super(message);
    this.name = 'McpJournalCursorError';
    this.rejection = { error, message };
  }
}

export interface EventJournalOptions {
  /** The project's data directory (`projectDataDir(root)`). */
  dataDir: string;
  /** The project's registry slug, from the trusted binding — never from a tool argument. */
  projectId: string;
  /** Test seam for retention ages; production uses the wall clock. */
  now?: () => number;
  /** Values scrubbed from every summary (F-15). Defaults to this host's secret-named env values. */
  secretValues?: readonly string[];
  /** Where the one-per-problem warning goes. */
  warn?: (message: string) => void;
}

const openFiles = new Set<string>();

export class EventJournal {
  readonly projectId: string;
  readonly indexPath: string;
  readonly rowsPath: string;
  #epoch = '';
  /** Retained rows, oldest first, consecutive `journalSeq`. */
  #rows: McpJournalRow[] = [];
  /** The stored line of each retained row, kept verbatim so a compaction never re-serializes. */
  #lines: string[] = [];
  #latestSeq = 0;
  /** Evicted lines still physically at the head of the file. */
  #evictedOnDisk = 0;
  #fileBytes = 0;
  #writeWarned = false;
  #closed = false;
  readonly #listeners = new Set<(row: McpJournalRow) => void>();
  readonly #now: () => number;
  readonly #secretValues: readonly string[];
  readonly #warn: (message: string) => void;

  private constructor(opts: EventJournalOptions) {
    this.projectId = mcpJournalProjectIdSchema.parse(opts.projectId);
    const dir = join(opts.dataDir, 'mcp');
    this.indexPath = join(dir, 'event-journal.json');
    this.rowsPath = join(dir, 'event-journal.ndjson');
    this.#now = opts.now ?? Date.now;
    this.#secretValues = opts.secretValues ?? collectSecretValues();
    this.#warn = opts.warn ?? ((message) => console.warn(message));
  }

  /**
   * Load (or create) a project's journal. Never throws on state — only on a caller bug (an invalid
   * project id, or a second live instance for the same file, which would break gapless numbering).
   */
  static open(opts: EventJournalOptions): EventJournal {
    const journal = new EventJournal(opts);
    if (openFiles.has(journal.rowsPath)) {
      throw new Error(`an event journal is already open for ${journal.rowsPath} — keep one per project`);
    }
    openFiles.add(journal.rowsPath);
    journal.#load();
    return journal;
  }

  get epoch(): string {
    return this.#epoch;
  }

  get latestSeq(): number {
    return this.#latestSeq;
  }

  get oldestSeq(): number | null {
    return this.#rows[0]?.journalSeq ?? null;
  }

  /** The cursor at the current head — D-05 § 6.8's "journal position at acceptance". */
  headCursor(): string {
    return this.#cursorAt(this.#latestSeq);
  }

  /** Release this file so a later `open` (a restart, in a test) may take it. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    openFiles.delete(this.rowsPath);
  }

  /** Live rows as they are appended — the replay reader's buffer (#105). Returns the unsubscribe. */
  subscribe(listener: (row: McpJournalRow) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Append one significant event. Returns the stored row, or `undefined` when it could not be made
   * durable — in which case no number was spent, so the sequence stays gapless (D-05 § 6.1).
   * Throws only on invalid input, which is an emitter bug.
   */
  append(input: McpJournalAppendInput): McpJournalRow | undefined {
    if (this.#closed) throw new Error('event journal is closed');
    const parsed = mcpJournalAppendInputSchema.parse(input);
    const journalSeq = this.#latestSeq + 1;
    const row = mcpJournalRowSchema.parse({
      eventId: `${this.projectId}:${journalSeq}`,
      journalSeq,
      ts: new Date(this.#now()).toISOString(),
      projectId: this.projectId,
      category: parsed.category,
      kind: parsed.kind,
      subject: parsed.subject,
      origin: parsed.origin,
      causedBy: parsed.causedBy,
      // F-15: a summary is prose an emitter composed, so it is scrubbed like transcript text is.
      summary: redactSecrets(parsed.summary, this.#secretValues),
      ...(parsed.source === undefined ? {} : { source: parsed.source }),
    });
    const line = JSON.stringify(row);
    try {
      appendFileSync(this.rowsPath, `${line}\n`, 'utf8');
    } catch (err) {
      // A partial write must not survive as a torn line in the middle of the file.
      try { truncateSync(this.rowsPath, this.#fileBytes); } catch { /* the load path drops a torn tail */ }
      this.#warnWrite(err);
      return undefined;
    }
    this.#fileBytes += Buffer.byteLength(line, 'utf8') + 1;
    this.#latestSeq = journalSeq;
    const frozen = freezeRow(row);
    this.#rows.push(frozen);
    this.#lines.push(line);
    this.#applyRetention();
    for (const listener of this.#listeners) {
      try { listener(frozen); } catch { /* a reader's bug never undoes a durable append */ }
    }
    return frozen;
  }

  /**
   * Replay strictly after `cursor` (or from the oldest retained row without one), in `journalSeq`
   * order, at most B-02 rows and B-01 bytes. A cursor whose rows are gone gets `cursor_too_old`
   * and no rows; a malformed or foreign cursor throws `McpJournalCursorError`.
   */
  read(input: McpJournalReadInput = {}): McpJournalReadResult {
    const limit = Math.min(input.limit ?? MCP_JOURNAL_PAGE_ROWS, MCP_JOURNAL_PAGE_ROWS);
    const oldest = this.oldestSeq;
    const firstRetained = oldest ?? this.#latestSeq + 1;
    let after = firstRetained - 1;
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor);
      // Foreign BEFORE stale: another project's cursor is refused, never told what this one holds.
      if (cursor.p !== this.projectId) {
        throw new McpJournalCursorError('cursor_project_mismatch', 'this cursor belongs to another project');
      }
      if (cursor.e !== this.#epoch || cursor.s < firstRetained - 1) return this.#tooOld(firstRetained);
      if (cursor.s > this.#latestSeq) {
        throw new McpJournalCursorError('invalid_cursor', 'this cursor points past the end of the journal');
      }
      after = cursor.s;
    }

    const events: McpJournalRow[] = [];
    let bytes = 0;
    for (let i = oldest === null ? this.#rows.length : after + 1 - oldest; i < this.#rows.length; i++) {
      if (events.length >= limit) break;
      const size = Buffer.byteLength(JSON.stringify(this.#rows[i]), 'utf8');
      if (events.length > 0 && bytes + size > MCP_JOURNAL_PAGE_BYTES) break;
      events.push(this.#rows[i]!);
      bytes += size;
    }
    const last = events.at(-1)?.journalSeq ?? after;
    return {
      status: 'ok',
      events,
      nextCursor: this.#cursorAt(last),
      hasMore: last < this.#latestSeq,
      oldestSeq: oldest,
      latestSeq: this.#latestSeq,
    };
  }

  #tooOld(firstRetained: number): McpJournalReadResult {
    return {
      status: 'cursor_too_old',
      oldestSeq: this.oldestSeq,
      latestSeq: this.#latestSeq,
      resumeCursor: this.#cursorAt(firstRetained - 1),
      recovery: {
        required: 'current-state',
        message:
          'Events after this cursor are no longer retained. Read the current state first, then continue from resumeCursor.',
      },
    };
  }

  #cursorAt(seq: number): string {
    return Buffer.from(JSON.stringify({ v: 1, p: this.projectId, e: this.#epoch, s: seq }), 'utf8').toString('base64url');
  }

  /** B-19: evict from the head only while more than the retained count remain AND the head row is
   *  at least the minimum age. The retained set therefore stays one contiguous run of numbers. */
  #applyRetention(): void {
    const cutoff = this.#now() - MIN_RETENTION_MS;
    let drop = 0;
    while (this.#rows.length - drop > MCP_JOURNAL_RETAINED_ROWS && Date.parse(this.#rows[drop]!.ts) <= cutoff) drop++;
    if (drop === 0) return;
    this.#rows.splice(0, drop);
    this.#lines.splice(0, drop);
    this.#evictedOnDisk += drop;
    // The file may hold at most B-19's count again in evicted lines before it is rewritten — so it
    // never exceeds twice the retained size, and a steady stream does not rewrite it per append.
    if (this.#evictedOnDisk >= MCP_JOURNAL_RETAINED_ROWS) this.#compact();
  }

  #compact(): void {
    const tmp = `${this.rowsPath}.tmp`;
    const body = this.#lines.length === 0 ? '' : `${this.#lines.join('\n')}\n`;
    try {
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, this.rowsPath);
      this.#fileBytes = Buffer.byteLength(body, 'utf8');
      this.#evictedOnDisk = 0;
    } catch (err) {
      // Eviction is already in effect in memory, and a reload re-derives it; only disk space waits.
      this.#warnWrite(err);
    }
  }

  #load(): void {
    const outcome = this.#readFiles();
    if (outcome.kind === 'fresh') {
      if (outcome.warning !== undefined) this.#warn(outcome.warning);
      this.#startFresh();
      return;
    }
    this.#epoch = outcome.epoch;
    this.#rows = outcome.rows.map(freezeRow);
    this.#lines = outcome.lines;
    this.#latestSeq = outcome.rows.at(-1)?.journalSeq ?? 0;
    this.#fileBytes = outcome.fileBytes;
    this.#applyRetention();
    if (this.#evictedOnDisk > 0) this.#compact();
  }

  #readFiles():
    | { kind: 'fresh'; warning?: string }
    | { kind: 'loaded'; epoch: string; rows: McpJournalRow[]; lines: string[]; fileBytes: number } {
    const hasIndex = existsSync(this.indexPath);
    const hasRows = existsSync(this.rowsPath);
    if (!hasIndex && !hasRows) return { kind: 'fresh' };
    const corrupt = (reason: string) => {
      this.#setAside();
      return {
        kind: 'fresh' as const,
        warning: `[xez] MCP event journal for project ${this.projectId} is corrupt (${reason}) — starting a fresh journal; the old rows are kept as ${this.rowsPath}.corrupt`,
      };
    };
    // Deleting the rows file alone is deleting history: a new epoch, not an error.
    if (!hasRows) return { kind: 'fresh' };
    try {
      const raw = readFileSync(this.rowsPath);
      if (!hasIndex) return raw.length === 0 ? { kind: 'fresh' } : corrupt('index file missing');

      let index: z.infer<typeof indexSchema>;
      try {
        const parsed = indexSchema.safeParse(JSON.parse(readFileSync(this.indexPath, 'utf8')));
        if (!parsed.success) return corrupt('index file invalid');
        index = parsed.data;
      } catch {
        return corrupt('index file unreadable');
      }
      if (index.projectId !== this.projectId) return corrupt('index names another project');

      // A torn final line is an append that never returned, so no caller ever held its number.
      let body = raw;
      const lastNewline = raw.lastIndexOf(0x0a);
      if (lastNewline !== raw.length - 1) {
        body = raw.subarray(0, lastNewline + 1);
        try { truncateSync(this.rowsPath, body.length); } catch { /* read-only: appends fail anyway */ }
      }

      const rows: McpJournalRow[] = [];
      const lines: string[] = [];
      for (const line of body.toString('utf8').split('\n')) {
        if (line.trim() === '') continue;
        let value: unknown;
        try { value = JSON.parse(line); } catch { return corrupt(`unparseable row after seq ${rows.at(-1)?.journalSeq ?? 0}`); }
        const parsed = mcpJournalRowSchema.safeParse(value);
        if (!parsed.success) return corrupt(`invalid row after seq ${rows.at(-1)?.journalSeq ?? 0}`);
        const row = parsed.data;
        const expected = rows.length === 0 ? row.journalSeq : rows.at(-1)!.journalSeq + 1;
        if (row.journalSeq !== expected) return corrupt(`sequence breaks at seq ${expected}`);
        if (row.projectId !== this.projectId || row.eventId !== `${this.projectId}:${row.journalSeq}`) {
          return corrupt(`row ${row.journalSeq} names another project`);
        }
        rows.push(row);
        lines.push(line);
      }
      return { kind: 'loaded', epoch: index.epoch, rows, lines, fileBytes: body.length };
    } catch (err) {
      return corrupt(err instanceof Error ? err.message : String(err));
    }
  }

  #setAside(): void {
    try {
      if (existsSync(this.rowsPath)) renameSync(this.rowsPath, `${this.rowsPath}.corrupt`);
    } catch { /* the fresh journal overwrites it instead */ }
  }

  #startFresh(): void {
    this.#epoch = randomUUID();
    this.#rows = [];
    this.#lines = [];
    this.#latestSeq = 0;
    this.#fileBytes = 0;
    this.#evictedOnDisk = 0;
    const tmp = `${this.indexPath}.tmp`;
    try {
      mkdirSync(join(this.rowsPath, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(this.rowsPath, '', 'utf8');
      writeFileSync(
        tmp,
        `${JSON.stringify({ v: 1, projectId: this.projectId, epoch: this.#epoch, createdAt: new Date(this.#now()).toISOString() })}\n`,
        'utf8',
      );
      renameSync(tmp, this.indexPath);
    } catch (err) {
      this.#warnWrite(err);
    }
  }

  #warnWrite(err: unknown): void {
    if (this.#writeWarned) return;
    this.#writeWarned = true;
    const message = err instanceof Error ? err.message : String(err);
    this.#warn(`[xez] MCP event journal for project ${this.projectId} cannot be written (${message}) — events are not being journaled`);
  }
}

function decodeCursor(cursor: string): z.infer<typeof cursorSchema> {
  const invalid = () => new McpJournalCursorError('invalid_cursor', 'invalid journal cursor');
  if (cursor.length === 0 || cursor.length > MCP_JOURNAL_CURSOR_MAX_BYTES) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const parsed = cursorSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

function freezeRow(row: McpJournalRow): McpJournalRow {
  Object.freeze(row.subject);
  if (row.source) Object.freeze(row.source);
  return Object.freeze(row);
}
