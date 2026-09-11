import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import {
  MCP_JOURNAL_PAGE_ROWS,
  mcpJournalCursorSchema,
  mcpJournalProjectIdSchema,
  operationIdSchema,
  type McpJournalCursorTooOld,
  type McpJournalRow,
  type RunStatus,
} from '@qodeca/xezar-contract';

import type { RunStore } from '../runs/store.ts';
import { atomicTmpPath } from '../workspace/config.ts';
import type { EventJournal } from './event-journal.ts';
import { runVersion } from './stale-write.ts';

/**
 * Reconnect for the MCP project leader (#105): on reconnection the leader receives its OUTSTANDING
 * significant events plus the CURRENT AUTHORITATIVE STATE; duplicates and out-of-order delivery
 * cause no repeated effect; a gap is stated, never skipped. Built over #103's journal
 * (`event-journal.ts`) and #101's operation receipts (`operation-receipts.ts`). Every rule below was
 * decided by D-05 (`docs/features/mcp-server/mcp-d05-async-event-contract-decision.md`) and every
 * number by D-09 (`mcp-d09-limits-retention-packaging-decision.md`); nothing here picks its own.
 *
 * THE NUMBERS, as given (none is new, none is a knob, no `XEZ_*` variable):
 *  - retention: 10 000 rows per project, and a row younger than 14 days is never evicted (D-05 N1,
 *    D-09 B-19) — enforced by the journal; a cursor behind it gets the explicit `cursor_too_old`;
 *  - replay page: 100 rows (D-05 N2, D-09 B-02/B-20) and 40 000 bytes (B-01), whichever first;
 *  - the current-state snapshot: at most 100 tasks, the same B-02 page bound;
 *  - coalescing window: none (D-05 N3) — every new row is its own delivery;
 *  - the delivered cursor is persisted per delivery, not batched across deliveries (D-05 N4).
 *
 * THE FIVE GUARANTEES, and where each lives:
 *
 *  1. A disconnect never stops, cancels or loses a started task (F-21, N-05 — mandatory). Client
 *     occupancy is separate from executor lifetime BY CONSTRUCTION: nothing in this module holds
 *     the run manager, and `LeaderFeed.disconnect` only drops the journal subscription. The journal
 *     keeps recording while no client is connected, because its writer lives with the project, not
 *     with a leader connection; a reconnect then reads what was written meanwhile.
 *  2. Outstanding events plus current state (F-21). `reconnect` replays strictly after the leader's
 *     acknowledged cursor, in `journalSeq` order, THEN reads the current state — D-05 § 6.5's order,
 *     the same one `GET /api/v1/runs/:id/events` uses (replay, dedupe with `>`, then snapshot), and
 *     the same shape as the cockpit's `reconcile()` in `packages/web/src/api/global-events.tsx`:
 *     after a reconnect the local picture is a guess, so the authoritative state is re-read.
 *  3. At-least-once delivery, no repeated effect (D-05 § 6.6, N-10). The server may deliver a row
 *     again — after a lost acknowledgement or a restart. The consumer's `LeaderInbox` drops a row
 *     it has already delivered (identity is the `eventId`, D-05 § 6.1) and releases rows only in
 *     `journalSeq` order, so a duplicate or a reordered row is never a second decision point. A
 *     reaction that MUTATES carries `reactionOperationId`, so a second delivery that does reach
 *     the leader (a restart lost the inbox) is answered from the #101 receipt — replayed, no second
 *     effect. There is no second deduplication store here; the receipts are that store.
 *  4. Explicit gaps (A-21). A cursor whose rows retention has evicted, or one from a journal that
 *     was recreated, gets the journal's own `cursor_too_old` answer — oldest retained seq, a resume
 *     cursor and the current-state recovery — with the state snapshot beside it. Nothing is
 *     replayed partially, because a partial replay reads as "nothing happened in between".
 *  5. No polling, no heartbeat (F-20, N-06). `LeaderFeed` wakes the leader only from the journal's
 *     own append signal. It starts no timer and no interval; with no significant event, it never
 *     wakes anyone. A leader that is told `hasMore` reads the next page because it was told to —
 *     that is bounded recovery, not a status poll.
 *
 * COMPLETION AFTER A HUMAN CANCELLATION OR CHANGE — the documented resolution (the case the
 * compatibility report names). Order is the journal's, never arrival order: `LeaderInbox` holds a
 * row that arrives ahead of a missing one, so a late completion is released in its own place.
 * Authority is the CURRENT state, never the event: every row carries `subject.version` (D-05
 * § 6.3), and a row whose version is no longer the subject's current version is delivered with
 * `standing: 'superseded'`. It is history the leader may read, not a fact to act on. The human's
 * action stands: a leader mutation built on the superseded row carries the stale version and is
 * refused by #100's stale-write check (`stale-write.ts`), with nothing applied. The engine itself
 * keeps cancellation final — a step that finishes after cancellation is recorded `cancelled`
 * (`workflows/run.ts`, the `state.cancelled` branch after a step ends; read from source) — and
 * nothing here resurrects, re-completes or resumes a task because of a late event.
 *
 * WHAT THIS IS NOT. It emits no significant event: deriving E-01–E-06 from status transitions and
 * human actions is #104. It is not a tool (no entry in `tools/index.ts`), opens no socket and adds
 * no channel: the transport is D-01's, and the cockpit keeps its one SSE stream and one WebSocket.
 * It adds no run queue and no process controller: `RunManager`, `RunStore` and the semaphore keep
 * task lifecycle.
 *
 * Retention: D-05's table marks `ackedSeq` as the cursor that drives retention. D-09 adopted
 * retention as B-19's count-and-age bound, which the journal enforces whatever has been acked; a
 * leader that is offline longer than that gets `cursor_too_old`, never a silent skip. The ack is
 * persisted here so a leader resumes where it stopped across reconnects and restarts.
 */

/** The leader's cursors, beside the journal in `<dataDir>/mcp/` (inside `.local/`, blanket-ignored). */
export const LEADER_CURSORS_FILE = 'leader-cursors.json';

/** D-09 B-02: the current-state snapshot is bounded like every other MCP list. */
export const RECONNECT_STATE_MAX_TASKS = MCP_JOURNAL_PAGE_ROWS;

// ---- persisted acknowledgement (D-05 § 6.6) ----------------------------------------------------

const cursorsFileSchema = z.looseObject({
  v: z.literal(1),
  projectId: mcpJournalProjectIdSchema,
  /** The journal epoch `deliveredSeq` and `reactedSeq` count in. */
  epoch: z.string().min(1).max(64),
  deliveredSeq: z.number().int().nonnegative(),
  reactedSeq: z.number().int().nonnegative(),
  /** The acknowledged position: a cursor the journal minted, its seq, and the epoch it counts in. */
  acked: z.object({
    epoch: z.string().min(1).max(64),
    seq: z.number().int().nonnegative(),
    cursor: mcpJournalCursorSchema,
  }),
});
type CursorsFile = z.infer<typeof cursorsFileSchema>;

/** The three positions D-05 § 6.6 keeps apart. `reactedSeq` behind `deliveredSeq` is normal. */
export interface LeaderPosition {
  deliveredSeq: number;
  ackedSeq: number;
  reactedSeq: number;
}

export type AckResult =
  | { status: 'acked'; ackedSeq: number }
  /** At or below the current ack, or for rows retention already evicted: success, no rewind. */
  | { status: 'no-op'; ackedSeq: number };

export interface LeaderCursorsOptions {
  dataDir: string;
  /** From the trusted binding, never a tool argument. */
  projectId: string;
  journal: EventJournal;
  warn?: (message: string) => void;
}

/**
 * The leader's delivered / acked / reacted positions for one project, persisted (tmp+rename,
 * `0600`). Written, never required: a missing file is a leader that has never connected, and it
 * starts at the journal head. A corrupt one does the same with ONE warning, set aside as `.corrupt`,
 * and the reconnect answer says `fresh: true` so a start from "now" is stated rather than implied.
 * An unwritable directory keeps the positions in memory with one warning; nothing throws.
 */
export class LeaderCursors {
  readonly path: string;
  #state: CursorsFile;
  #fresh = false;
  #warned = false;
  readonly #journal: EventJournal;
  readonly #warn: (message: string) => void;

  private constructor(opts: LeaderCursorsOptions) {
    this.path = join(opts.dataDir, 'mcp', LEADER_CURSORS_FILE);
    this.#journal = opts.journal;
    this.#warn = opts.warn ?? ((message) => console.warn(message));
    this.#state = this.#load(mcpJournalProjectIdSchema.parse(opts.projectId));
  }

  static open(opts: LeaderCursorsOptions): LeaderCursors {
    if (opts.journal.projectId !== opts.projectId) {
      throw new Error('leader cursors and the event journal must belong to the same project');
    }
    return new LeaderCursors(opts);
  }

  /** True when no stored position existed, so the leader started at the journal head. */
  get fresh(): boolean {
    return this.#fresh;
  }

  /** The cursor a reconnect replays after — a cursor the journal minted, never one built here. */
  get ackedCursor(): string {
    return this.#state.acked.cursor;
  }

  /** Positions in the CURRENT journal. A position from a recreated journal counts as 0 here. */
  position(): LeaderPosition {
    const same = this.#state.epoch === this.#journal.epoch;
    return {
      deliveredSeq: same ? this.#state.deliveredSeq : 0,
      ackedSeq: this.#state.acked.epoch === this.#journal.epoch ? this.#state.acked.seq : 0,
      reactedSeq: same ? this.#state.reactedSeq : 0,
    };
  }

  /** Non-model: the transport handed rows through `seq` to the client (D-05 § 6.6). Monotonic. */
  markDelivered(seq: number): void {
    this.#rebase();
    if (seq <= this.#state.deliveredSeq) return;
    this.#state = { ...this.#state, deliveredSeq: seq };
    this.#save();
  }

  /** Non-model: a model turn carrying rows through `seq` was actually started (D-05 § 6.6). */
  markReacted(seq: number): void {
    this.#rebase();
    if (seq <= this.#state.reactedSeq) return;
    this.#state = { ...this.#state, reactedSeq: seq };
    this.#save();
  }

  /**
   * The leader has durably taken every row up to `cursor` into account — the `nextCursor` of a
   * page, or the `resumeCursor` of a gap. Monotonic and idempotent: a cursor at or below the
   * current ack is a successful no-op, never a rewind and never an error (D-05 § 6.6). Replaying
   * from an earlier position is a different request — `reconnect` with an explicit cursor — and it
   * never moves the ack. A malformed or foreign cursor throws `McpJournalCursorError`.
   */
  ack(cursor: string): AckResult {
    // The journal is the one reader of its own cursor format; a one-row read resolves the position.
    const probe = this.#journal.read({ cursor, limit: 1 });
    const current = this.position().ackedSeq;
    if (probe.status === 'cursor_too_old') return { status: 'no-op', ackedSeq: current };
    const seq = probe.events[0] === undefined ? probe.latestSeq : probe.events[0].journalSeq - 1;
    const epoch = this.#journal.epoch;
    if (this.#state.acked.epoch === epoch && seq <= this.#state.acked.seq) {
      return { status: 'no-op', ackedSeq: current };
    }
    this.#rebase();
    // An acknowledged row was, necessarily, delivered.
    this.#state = {
      ...this.#state,
      deliveredSeq: Math.max(this.#state.deliveredSeq, seq),
      acked: { epoch, seq, cursor },
    };
    this.#save();
    return { status: 'acked', ackedSeq: seq };
  }

  /** A recreated journal restarts its numbers at 1; counts from the old one mean nothing in it. */
  #rebase(): void {
    if (this.#state.epoch === this.#journal.epoch) return;
    this.#state = { ...this.#state, epoch: this.#journal.epoch, deliveredSeq: 0, reactedSeq: 0 };
  }

  #load(projectId: string): CursorsFile {
    const atHead = (): CursorsFile => {
      this.#fresh = true;
      const seq = this.#journal.latestSeq;
      const epoch = this.#journal.epoch;
      return { v: 1, projectId, epoch, deliveredSeq: seq, reactedSeq: seq, acked: { epoch, seq, cursor: this.#journal.headCursor() } };
    };
    if (!existsSync(this.path)) {
      const state = atHead();
      this.#state = state;
      this.#save();
      return state;
    }
    let parsed: CursorsFile | undefined;
    try {
      const result = cursorsFileSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
      if (result.success && result.data.projectId === projectId) parsed = result.data;
    } catch {
      parsed = undefined;
    }
    if (parsed) return parsed;
    this.#warn(
      `[xez] MCP leader cursors for project ${projectId} are unreadable — the leader restarts at the journal head; the old file is kept as ${this.path}.corrupt`,
    );
    try { renameSync(this.path, `${this.path}.corrupt`); } catch { /* the save below overwrites it instead */ }
    const state = atHead();
    this.#state = state;
    this.#save();
    return state;
  }

  #save(): void {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 });
      const tmp = atomicTmpPath(this.path);
      writeFileSync(tmp, `${JSON.stringify(this.#state)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.path);
      try { chmodSync(this.path, 0o600); } catch { /* best-effort on filesystems without modes */ }
    } catch (err) {
      if (this.#warned) return;
      this.#warned = true;
      const message = err instanceof Error ? err.message : String(err);
      this.#warn(`[xez] MCP leader cursors cannot be written (${message}) — positions are kept in memory only`);
    }
  }
}

// ---- current authoritative state ---------------------------------------------------------------

/** One task as it is NOW. `status: null` means it no longer exists (deleted or pruned). */
export interface TaskState {
  id: string;
  status: RunStatus | null;
  /** The #100 version token a mutation of this task must carry, or `null` when it is gone. */
  version: string | null;
}

export interface CurrentState {
  /** The journal head when the state was read: rows up to here are reflected in it. */
  latestSeq: number;
  /** The tasks named by the delivered rows, then every task still in flight, newest first. */
  tasks: TaskState[];
  /** False when the B-02 bound cut the list — the task read tool pages the rest. */
  complete: boolean;
}

/** Reads the current state of the project. Synchronous: the stores it wraps are, and so the state
 *  and the journal head it reports are read in one stretch that no append can interleave with. */
export type StateReader = (subjects: readonly McpJournalRow['subject'][]) => CurrentState;

const IN_FLIGHT: ReadonlySet<RunStatus> = new Set(['queued', 'running', 'waiting', 'review']);

/**
 * The default state reader over the project's own `RunStore` — the store the cockpit reads (N-02).
 * A projection only — id, status and version — so no title, prompt, transcript or account detail
 * reaches a model (F-15, N-01); the task read tool (#91) is where a leader reads more.
 */
export function runStateReader(store: RunStore, journal: Pick<EventJournal, 'latestSeq'>): StateReader {
  return (subjects) => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const add = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    };
    for (const subject of subjects) if (subject.type === 'run') add(subject.id);
    for (const run of store.listRuns()) if (IN_FLIGHT.has(run.status)) add(run.id);
    const tasks = ids.slice(0, RECONNECT_STATE_MAX_TASKS).map((id): TaskState => {
      const run = store.getRun(id);
      return run ? { id, status: run.status, version: runVersion(store, id) ?? null } : { id, status: null, version: null };
    });
    return { latestSeq: journal.latestSeq, tasks, complete: ids.length <= RECONNECT_STATE_MAX_TASKS };
  };
}

// ---- the reconnect answer ----------------------------------------------------------------------

/**
 * How a delivered row stands against the current state:
 *  - `current` — its subject is still at the version the row names;
 *  - `superseded` — the subject changed since (or is gone): history to read, not a fact to act on;
 *  - `unjudged` — the snapshot does not cover this subject (not a task, or the row has no version).
 */
export type RowStanding = 'current' | 'superseded' | 'unjudged';

export interface DeliveredRow {
  row: McpJournalRow;
  standing: RowStanding;
}

export type ReconnectAnswer =
  | {
      status: 'ok';
      /** Outstanding rows, strictly after the cursor, in `journalSeq` order. */
      events: DeliveredRow[];
      /** Acknowledge this once the page is taken into account; read after it for more. */
      nextCursor: string;
      /** More rows are already retained past `nextCursor` — read again, do not wait for an event. */
      hasMore: boolean;
      state: CurrentState;
      position: LeaderPosition;
      /** No stored position existed: the leader starts from the journal head. Stated, not implied. */
      fresh: boolean;
      /** An event's identity across journal recreations is (journalEpoch, eventId). Not a cursor. */
      journalEpoch: string;
    }
  | {
      status: 'cursor_too_old';
      /** The journal's own gap answer: oldest retained seq, resume cursor, required recovery. */
      gap: McpJournalCursorTooOld;
      state: CurrentState;
      position: LeaderPosition;
      fresh: boolean;
      journalEpoch: string;
    };

export interface ReconnectOptions {
  journal: EventJournal;
  cursors: LeaderCursors;
  readState: StateReader;
  /** Replay from here instead of the acknowledged position — a rewind request. Never moves the ack. */
  cursor?: string;
  /** Rows per page, at most B-02's 100. */
  limit?: number;
}

/**
 * Everything a reconnecting leader needs in one answer: the outstanding rows after its
 * acknowledged position (or after `cursor`), then the current state — or, when the rows it needs
 * are gone, the explicit gap plus the current state. A malformed or foreign cursor throws
 * `McpJournalCursorError`: it is never read as "start from zero" (D-05 § 6.5).
 */
export function reconnect(opts: ReconnectOptions): ReconnectAnswer {
  const from = opts.cursor ?? opts.cursors.ackedCursor;
  const result = opts.journal.read({ cursor: from, ...(opts.limit === undefined ? {} : { limit: opts.limit }) });
  const common = {
    position: opts.cursors.position(),
    fresh: opts.cursors.fresh,
    journalEpoch: opts.journal.epoch,
  };
  if (result.status === 'cursor_too_old') {
    return { status: 'cursor_too_old', gap: result, state: opts.readState([]), ...common };
  }
  // D-05 § 6.5: replay first, THEN the snapshot, so the state is never older than the rows.
  const state = opts.readState(result.events.map((row) => row.subject));
  return {
    status: 'ok',
    events: judge(result.events, state),
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
    state,
    ...common,
  };
}

/** Stand each row against the current state — see the module comment's completion-after-cancel rule. */
export function judge(rows: readonly McpJournalRow[], state: CurrentState): DeliveredRow[] {
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  return rows.map((row) => {
    const task = row.subject.type === 'run' ? tasks.get(row.subject.id) : undefined;
    if (!task || row.subject.version === null) return { row, standing: 'unjudged' };
    return { row, standing: task.version === row.subject.version ? 'current' : 'superseded' };
  });
}

// ---- the live feed: event-driven, never polled -------------------------------------------------

export interface LeaderDelivery {
  events: DeliveredRow[];
  nextCursor: string;
  hasMore: boolean;
  state: CurrentState;
  journalEpoch: string;
}

export interface LeaderFeedOptions {
  journal: EventJournal;
  cursors: LeaderCursors;
  readState: StateReader;
  /**
   * Starts a decision point — the adapter's hook (Phase 6). Called ONLY because a significant row
   * was appended; never on a timer. Its return value is ignored, and a throw never undoes delivery.
   */
  wake: (delivery: LeaderDelivery) => void;
  /**
   * The F-13 echo guard (D-05 § 6.3): true for an operation this leader has outstanding. A row
   * whose `origin` is `leader` AND whose `causedBy` is one of those is delivered — the cursor moves
   * past it — but it does not wake the leader. A row is never dropped merely for naming a known run.
   */
  isOwnOperation?: (operationId: string) => boolean;
}

/**
 * The connection-scoped half: one live subscription to the journal while a leader is connected.
 * No timer, no interval, no heartbeat — liveness of the CLIENT is the transport's ping (D-09 B-17),
 * never a model turn and never this class. `disconnect` touches nothing but the subscription.
 */
export class LeaderFeed {
  #unsubscribe: (() => void) | undefined;
  /** Delivered-through position for the live half: a cursor the journal minted. */
  #deliveredCursor: string | undefined;
  readonly #opts: LeaderFeedOptions;

  constructor(opts: LeaderFeedOptions) {
    this.#opts = opts;
  }

  get connected(): boolean {
    return this.#unsubscribe !== undefined;
  }

  /**
   * Connect (or reconnect): subscribe to live appends, then answer with the outstanding rows and
   * the current state. The subscription goes first, so no row appended during the answer can fall
   * between the replay and the live half; the live half reads strictly after the answer's cursor,
   * so no row can arrive twice either. The answer goes back to the caller — the leader asked for
   * it — and does not itself wake anyone.
   */
  connect(cursor?: string): ReconnectAnswer {
    this.disconnect();
    this.#unsubscribe = this.#opts.journal.subscribe(() => this.#onAppend());
    const answer = reconnect({ ...this.#opts, ...(cursor === undefined ? {} : { cursor }) });
    if (answer.status !== 'ok') {
      // The gap is in the answer; live delivery continues from where the journal resumes.
      this.#deliveredCursor = answer.gap.resumeCursor;
      return answer;
    }
    this.#deliveredCursor = answer.nextCursor;
    const last = answer.events.at(-1)?.row.journalSeq;
    if (last === undefined) return answer;
    this.#opts.cursors.markDelivered(last);
    return { ...answer, position: this.#opts.cursors.position() };
  }

  /** Client occupancy ends here and ONLY here. No task is touched: executor lifetime is not ours. */
  disconnect(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#deliveredCursor = undefined;
  }

  #onAppend(): void {
    if (this.#deliveredCursor === undefined) return;
    const result = this.#opts.journal.read({ cursor: this.#deliveredCursor });
    // Unreachable while connected — this listener runs right after an append, which evicts from the
    // head only — but a gap is stated through the next reconnect rather than skipped here.
    if (result.status !== 'ok' || result.events.length === 0) return;
    this.#deliveredCursor = result.nextCursor;
    this.#opts.cursors.markDelivered(result.events.at(-1)!.journalSeq);
    const isOwn = this.#opts.isOwnOperation ?? (() => false);
    const wakeRows = result.events.filter(
      (row) => !(row.origin === 'leader' && row.causedBy !== null && isOwn(row.causedBy)),
    );
    if (wakeRows.length === 0) return;
    const state = this.#opts.readState(wakeRows.map((row) => row.subject));
    try {
      this.#opts.wake({
        events: judge(wakeRows, state),
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
        state,
        journalEpoch: this.#opts.journal.epoch,
      });
    } catch {
      // The adapter's failure to start a turn is `reactedSeq` lagging, a reportable state — never
      // a reason to undo a durable delivery or to retry on a timer.
    }
  }
}

// ---- the consumer's side: dedupe, order, gaps --------------------------------------------------

export interface InboxAccept {
  /** Rows released now, in `journalSeq` order, each exactly once. Empty = no decision point. */
  deliver: McpJournalRow[];
  /** Rows dropped because they were already delivered or already held. */
  duplicates: number;
  /** The first missing range while later rows are held; `null` when nothing is missing. */
  missing: { fromSeq: number; toSeq: number } | null;
}

/**
 * The consumer's half of at-least-once delivery (D-05 § 6.6: "the leader deduplicates on
 * `eventId`"). Deduplication is on the `eventId` alone, and within one project a gapless
 * `journalSeq` is that identity's order: a row at or below the delivered position is a duplicate,
 * a row ahead of a missing one is held until the gap fills, and the gap is reported. Start it at
 * the acknowledged position; after a restart it may therefore release a row again — the reaction's
 * `reactionOperationId` is what keeps that second look from becoming a second effect.
 */
export class LeaderInbox {
  readonly projectId: string;
  #deliveredSeq: number;
  readonly #held = new Map<number, McpJournalRow>();

  constructor(opts: { projectId: string; afterSeq: number }) {
    this.projectId = mcpJournalProjectIdSchema.parse(opts.projectId);
    this.#deliveredSeq = opts.afterSeq;
  }

  get deliveredSeq(): number {
    return this.#deliveredSeq;
  }

  accept(rows: readonly McpJournalRow[]): InboxAccept {
    let duplicates = 0;
    for (const row of rows) {
      // Another project's row is not this leader's business (N-01); it is not even a duplicate.
      if (row.projectId !== this.projectId || row.eventId !== `${this.projectId}:${row.journalSeq}`) continue;
      if (row.journalSeq <= this.#deliveredSeq || this.#held.has(row.journalSeq)) {
        duplicates++;
        continue;
      }
      this.#held.set(row.journalSeq, row);
    }
    const deliver: McpJournalRow[] = [];
    for (let next = this.#held.get(this.#deliveredSeq + 1); next; next = this.#held.get(this.#deliveredSeq + 1)) {
      this.#held.delete(next.journalSeq);
      this.#deliveredSeq = next.journalSeq;
      deliver.push(next);
    }
    let missing: InboxAccept['missing'] = null;
    if (this.#held.size > 0) {
      const firstHeld = Math.min(...this.#held.keys());
      missing = { fromSeq: this.#deliveredSeq + 1, toSeq: firstHeld - 1 };
    }
    return { deliver, duplicates, missing };
  }
}

/** A label that tells apart two different reactions to one event. */
const reactionLabelSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

/**
 * The operation id of the leader's reaction to one event (N-10, D-06 § 5.2). Deterministic, so a
 * second delivery of the same row produces the same id and #101's receipt store answers it as a
 * replay with no second effect. The journal epoch is part of it because `journalSeq` restarts at 1
 * in a recreated journal: without it a genuinely new event would replay an old event's result.
 * `label` separates different reactions to one event (`start-review`, `cancel`); deliberately new
 * identical work takes a new id, as N-10 requires, and never this one.
 */
export function reactionOperationId(journalEpoch: string, row: Pick<McpJournalRow, 'journalSeq'>, label: string): string {
  return operationIdSchema.parse(`react.${journalEpoch}.${row.journalSeq}.${reactionLabelSchema.parse(label)}`);
}
