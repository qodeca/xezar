import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import type { McpJournalRow, McpProjectOccupiedError, McpSessionExpiredError } from '@qodeca/xezar-contract';

import {
  OWNER_ACQUIRE_ATTEMPTS,
  OWNER_BACKOFF_CAP_MS,
  projectOccupiedError,
  sessionExpiredError,
  type ProjectOwnership,
} from '../workspace/project-owner.ts';
import { McpJournalCursorError, type EventJournal } from './event-journal.ts';

/**
 * The non-model event controller (#107): it follows ONE project's event journal (#103) on behalf
 * of the logical MCP session that owns the project (#99), and hands significant events to a
 * client-specific reaction adapter (#108–#110). It never starts a model turn of its own.
 *
 * WHAT IT CONSUMES, AND DOES NOT DECIDE. The event identity, order, replay and acknowledgement
 * model are D-05 (`docs/features/mcp-server/mcp-d05-async-event-contract-decision.md` § 6); the
 * numbers are D-09 (`mcp-d09-limits-retention-packaging-decision.md` § 3). Every constant below
 * names the one it reuses.
 *
 * - **Source.** The project journal only (`EventJournal`), never the workspace stream — requirements
 *   § 8 forbids an unfiltered workspace stream reaching MCP, and the journal already holds exactly
 *   E-01–E-06 for exactly one project. The journal is also the QUEUE: undelivered rows are the
 *   journal between this controller's position and its head, so the queue is durable, gapless and
 *   bounded by B-19 retention, and no event lives only in this object's memory.
 * - **Coalescing.** D-05 N3 decided *no coalescing window*: rows are never merged, delayed or
 *   dropped. What coalesces is DISPATCHES: at most one is in flight, and every row that arrived
 *   before it starts rides in it, up to one journal page (B-20, 100 rows; B-01, 40 000 bytes).
 *   So a burst of N rows appended in one tick reaches the adapter as `ceil(N / 100)` dispatches,
 *   each row intact and in `journalSeq` order, and rows that arrive while a dispatch is in flight
 *   go out together in the next one.
 * WHOSE FACTS ARE WHOSE. This controller serves one SESSION, and its cursors belong to the project's
 * journal. Whether the leader is reachable is a fact about the LEADER, so it is not kept here: the
 * adapter records it (`LeaderDelivery`), and it therefore survives a session change and is never
 * inherited by a leader that has just been attached (QA on #311, round five, both directions).
 *
 * - **Delivery is not reaction (F-20).** `deliver` hands rows to the client application and is
 *   non-model. Whether a model turn then starts is the adapter's own, client-specific decision, and
 *   it reports that separately through `recordReaction`. The three D-05 § 6.6 cursors are kept
 *   apart: `deliveredSeq` (this controller, on a resolved `deliver`), `ackedSeq` (the leader,
 *   through an explicit tool call — `ack`) and `reactedSeq` (the adapter, when a turn carrying the
 *   rows really started). `reactedSeq` lagging `deliveredSeq` is a normal state, not a fault.
 * - **Non-model traffic only (N-06).** The heartbeat, a transport retry and an acknowledgement
 *   never call anything that can start a turn: the heartbeat calls the adapter's optional
 *   `heartbeat`, a retry re-sends the SAME undelivered rows, and `ack` touches only a number.
 *   Rows already delivered in this session are never dispatched again.
 * - **At-least-once (D-05 § 6.6).** A new session resumes after the leader's last ACK, not after
 *   the last delivery: a row handed to a previous client that the leader never acknowledged is
 *   outstanding, and F-21 says reconnect delivers it. In production the leader acknowledges through
 *   the pull tool (`leader_events ack`), so that record is the ACK read here (`acknowledged`, #332):
 *   one source of truth, not two cursors that can disagree. The leader deduplicates on `eventId`. The
 *   echo guard (drop a `leader` row whose `causedBy` is the adapter's own operation) is the
 *   adapter's, per D-05 § 6.3: rows reach it whole.
 *
 * ONE LOGICAL OWNER. This controller and the MCP bridge are one client, not two (compatibility
 * report, "Recommended architecture"; F-18). So the controller never acquires: it is handed the
 * project's `ProjectOwnership` and the session key the transport acquired with, starts only while
 * that session is the live owner, and re-checks it before every dispatch and at every heartbeat.
 * It never calls `acquire` or `release` — the lease is the transport's, released on connection
 * close (D-02.4) — so it can neither create a second claim nor end the session it serves. A
 * second controller for the same project is refused: a competing session with project-occupied,
 * and a second controller for the SAME session too, because two dispatchers over one journal are
 * the "two independent streams delivering duplicates" risk of requirements § 12.
 *
 * INERT WITHOUT A CLIENT (N-07). With no adapter the controller subscribes to nothing, starts no
 * timer, reads no ownership and writes no file. The journal keeps accumulating rows exactly as it
 * does with no controller at all.
 *
 * ## Every state, and who fires each exit
 *
 * No exit below is a human action, and no state holds a queued row without an on-by-default path
 * to the adapter.
 *
 * | State | Exit | Who fires it | If nobody fires it |
 * | --- | --- | --- | --- |
 * | inert | — (terminal for this object) | — | correct: no client, nothing is owed; rows stay in the journal |
 * | idle | → dispatching | a journal append (subscription) or the heartbeat tick | the heartbeat tick (B-17, 30 s) re-reads the journal, so a missed wakeup costs at most one interval |
 * | idle | → disconnected | a failed heartbeat probe | stays idle — the correct resting state |
 * | dispatching | → idle | `deliver` resolving | the attempt is aborted after one heartbeat interval and counts as a transport drop |
 * | dispatching | → recovering | `deliver` rejecting, or the attempt timing out | — (the timeout above always fires) |
 * | recovering | → idle / → disconnected | the round itself: at most 5 attempts, full-jitter backoff ≤ 200 ms | — (bounded) |
 * | disconnected | → dispatching | the heartbeat tick (one new bounded round per interval) or the adapter's `wake` on reconnect | the heartbeat timer is on by default, so rows are retried every 30 s for as long as the session owns the project |
 * | any active state | → ended | `close` (the transport, on connection close), or losing ownership, found at the next dispatch or heartbeat | lease expiry (30 s, B-14) makes the owner check fail at the next heartbeat |
 * | ended | — (terminal) | — | rows stay in the journal and the persisted cursors; the next session's controller resumes after the last ack |
 *
 * What reaches a terminal state BECAUSE of this controller: nothing but this object. It holds no
 * run, queue slot, lease or worktree, and ending it touches none.
 *
 * ## Where its state lives
 *
 * `<dataDir>/mcp/event-controller.json`, beside the journal: `{ v, projectId, epoch, deliveredSeq,
 * ackedSeq, reactedSeq, floorSeq }`, written by atomic tmp+rename after every change (D-05 N4:
 * persisted per delivery, not batched). Written, never required. With a leader record (production)
 * the file keeps only real history — what was pushed and what reacted — and WHERE pushing starts
 * comes from the leader's record. Standalone, no file means a first session that starts at the
 * journal head (nothing was ever owed to a leader that did not exist; it reads current state, F-21),
 * and an unreadable file starts at the head WITH a stated gap. Either way no reported cursor is ever
 * set to a position nothing reached (QA on #311): a start is a floor, not a delivery. An unwritable
 * directory keeps the cursors in memory with one warning.
 */

/** Heartbeat and liveness period. B-17 / D-05 N6, reusing the hub's `HEARTBEAT_MS` (`server/ws.ts`). */
export const EVENT_CONTROLLER_HEARTBEAT_MS = 30_000;

/**
 * Delivery attempts per recovery round, and the cap on the doubling full-jitter backoff between them.
 * D-01, D-05 and D-09 fix no delivery-retry numbers (B-16 is the bridge's own "no retry" on a dead
 * socket, which this is not), so the bounded-recovery shape is the one D-02 measured and D-09 adopted
 * as B-15 for the same kind of local contention, rather than a new one.
 */
export const EVENT_DELIVERY_ATTEMPTS = OWNER_ACQUIRE_ATTEMPTS;
export const EVENT_DELIVERY_BACKOFF_CAP_MS = OWNER_BACKOFF_CAP_MS;
/** The doubling start `project-owner.ts` uses (25, 50, 100, 200 ms). */
const BACKOFF_BASE_MS = 25;

/** Stated to the adapter when rows this session was owed are gone (D-05 § 6.5, A-21). */
export interface EventRecovery {
  readonly required: 'current-state';
  readonly oldestSeq: number | null;
  readonly latestSeq: number;
  readonly message: string;
}

/** One dispatch: consecutive journal rows, oldest first, never merged, never rewritten. */
export interface EventDispatch {
  readonly projectId: string;
  readonly events: readonly McpJournalRow[];
  /** Present when a gap was detected: read current state before acting on `events`. */
  readonly recovery?: EventRecovery;
}

/**
 * The client-specific half (#108 Claude Code, #109 Codex, #110 OpenCode). Nothing here can start a
 * model turn on the controller's behalf: that is the adapter's decision, reported back through
 * `EventController.recordReaction`.
 */
export interface ReactionAdapter {
  /**
   * Hand `dispatch` to the client application — NON-MODEL. Resolve once the client's transport
   * accepted it; reject, or honour `signal`, when it did not. Resolving is delivery, not reaction.
   * Resolve with a `DeliveryReceipt` when not every row was really handed over (the leader's own
   * echoes are not); resolving with nothing means all of them were.
   */
  deliver(dispatch: EventDispatch, signal: AbortSignal): Promise<void | DeliveryReceipt>;
  /** Optional non-model liveness probe (N-06). A rejection marks the transport disconnected. */
  heartbeat?(signal: AbortSignal): Promise<void>;
}

/**
 * What an adapter says about a dispatch it settled: the newest row it REALLY handed to the client,
 * or `null` for none (every row was one the leader caused itself). `deliveredSeq` counts only
 * these, so it never claims a row reached the leader when it did not (QA on #311).
 */
export interface DeliveryReceipt {
  readonly handedThrough: number | null;
}

export type EventControllerState = 'inert' | 'idle' | 'dispatching' | 'recovering' | 'disconnected' | 'ended';

export interface EventControllerStatus {
  state: EventControllerState;
  deliveredSeq: number;
  ackedSeq: number;
  reactedSeq: number;
  latestSeq: number;
}

/** What `ack` and `recordReaction` answer. `ahead` changes nothing; neither ever rewinds. */
export interface CursorAdvance {
  status: 'advanced' | 'unchanged' | 'ahead' | 'inactive';
  seq: number;
}

/** The leader's acknowledgement record as the controller reads it. `LeaderCursors` implements it. */
export interface LeaderRecord {
  /**
   * Rows after `seq` are owed to the leader: its last acknowledgement, or — for a leader with no
   * acknowledgement yet — where its record began (#251: the journal head the first time xezar kept
   * one). `sameEpoch` false: the record counts in a journal that has since been recreated.
   */
  owedAfter(): { seq: number; sameEpoch: boolean };
  /** The last row the leader acknowledged with an explicit tool call; 0 when it never has. */
  acknowledged(): number;
}

export type EventControllerStart =
  | { outcome: 'started' | 'inert'; controller: EventController }
  | { outcome: 'refused'; error: McpProjectOccupiedError | McpSessionExpiredError };

export interface EventControllerOptions {
  /** The bound project's journal — the one `EventJournal.open` returned for it. */
  journal: Pick<EventJournal, 'projectId' | 'rowsPath' | 'epoch' | 'latestSeq' | 'oldestSeq' | 'headCursor' | 'read' | 'subscribe'>;
  /** The bound project's owner slot. Read, never acquired or released, by this controller. */
  ownership: Pick<ProjectOwnership, 'projectId' | 'sessionToken' | 'state'>;
  /** The key the transport acquired the lease with — the logical session this controller serves. */
  sessionKey: string;
  /** The client's reaction adapter. Absent: no client is configured, and the controller is inert. */
  adapter?: ReactionAdapter;
  /**
   * The leader's own record of what it has taken into account — in production the pull tool's
   * `LeaderCursors` (#251), the ONE acknowledgement (#332). When given, the controller keeps no rival
   * cursor: it pushes only rows after `owedAfter()`, read when a session starts AND before every
   * dispatch, and reports `acknowledged()` as `ackedSeq`. Absent: the controller's own cursor file
   * and `ack()` stand in (#107's standalone shape, and its tests).
   */
  leaderRecord?: LeaderRecord;
  /** Test seams. Production uses the defaults. */
  heartbeatMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
}

const savedSchema = z.object({
  v: z.literal(1),
  projectId: z.string(),
  epoch: z.string(),
  deliveredSeq: z.number().int().nonnegative(),
  ackedSeq: z.number().int().nonnegative(),
  reactedSeq: z.number().int().nonnegative(),
  /** Where pushing resumes. Absent in files written before #332's fix: the ack stood in for it. */
  floorSeq: z.number().int().nonnegative().optional(),
});
type Saved = z.infer<typeof savedSchema>;

/** Journal files that have a live controller in this process. One dispatcher per journal. */
const liveControllers = new Set<string>();

export class EventController {
  readonly projectId: string;
  readonly #journal: EventControllerOptions['journal'];
  readonly #ownership: EventControllerOptions['ownership'];
  readonly #sessionKey: string;
  readonly #adapter: ReactionAdapter | undefined;
  readonly #leaderRecord: LeaderRecord | undefined;
  readonly #statePath: string;
  readonly #heartbeatMs: number;
  readonly #random: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #warn: (message: string) => void;
  readonly #closed = new AbortController();

  #state: EventControllerState;
  /** Read strictly after this cursor next; `undefined` reads from the oldest retained row. */
  #position: string | undefined;
  /** The newest row really handed to the client, in this or an earlier session of this epoch. */
  #delivered = 0;
  /** An explicit acknowledgement through `ack()` — only when there is no leader record. */
  #acked = 0;
  /** The newest row a model turn was really seen to carry. */
  #reacted = 0;
  /**
   * Rows at or below this are not owed to this session, so they are never pushed. It is WHERE PUSHING
   * STARTS, not something that happened, so no status field ever reports it (#332, QA on #311).
   */
  #floor = 0;
  /** The newest row this session has handed to `deliver`, delivered or still in flight. */
  #handedOut = 0;
  #recovery: EventRecovery | undefined;
  #busy = false;
  /** A wakeup arrived while busy; whoever clears `#busy` re-schedules, so no row is stranded. */
  #again = false;
  #scheduled = false;
  #unsubscribe: (() => void) | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #warnedWrite = false;
  #warnedDelivery = false;
  #warnedFault = false;

  private constructor(opts: EventControllerOptions, state: 'inert' | 'idle') {
    this.projectId = opts.journal.projectId;
    this.#journal = opts.journal;
    this.#ownership = opts.ownership;
    this.#sessionKey = opts.sessionKey;
    this.#adapter = opts.adapter;
    this.#leaderRecord = opts.leaderRecord;
    this.#statePath = join(dirname(opts.journal.rowsPath), 'event-controller.json');
    this.#heartbeatMs = opts.heartbeatMs ?? EVENT_CONTROLLER_HEARTBEAT_MS;
    this.#random = opts.random ?? Math.random;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#warn = opts.warn ?? ((message) => console.warn(message));
    this.#state = state;
  }

  /**
   * Start the controller for the session `sessionKey`, which must already own the project through
   * the transport's own acquisition. Throws only on a caller bug (journal and owner slot of two
   * different projects); every runtime condition is an answer.
   */
  static start(opts: EventControllerOptions): EventControllerStart {
    if (opts.journal.projectId !== opts.ownership.projectId) {
      throw new Error('event controller: the journal and the owner slot belong to different projects');
    }
    if (opts.adapter === undefined) return { outcome: 'inert', controller: new EventController(opts, 'inert') };

    const projectId = opts.journal.projectId;
    if (liveControllers.has(opts.journal.rowsPath)) return { outcome: 'refused', error: projectOccupiedError(projectId) };
    if (opts.ownership.sessionToken(opts.sessionKey) === undefined) {
      const error = opts.ownership.state() === 'owned' ? projectOccupiedError(projectId) : sessionExpiredError(projectId);
      return { outcome: 'refused', error };
    }

    liveControllers.add(opts.journal.rowsPath);
    const controller = new EventController(opts, 'idle');
    controller.#resume();
    controller.#unsubscribe = opts.journal.subscribe(() => controller.#schedule());
    controller.#timer = setInterval(() => void controller.#tick().catch((err: unknown) => controller.#fault(err)), controller.#heartbeatMs);
    controller.#timer.unref?.();
    controller.#schedule();
    return { outcome: 'started', controller };
  }

  get state(): EventControllerState {
    return this.#state;
  }

  status(): EventControllerStatus {
    return {
      state: this.#state,
      deliveredSeq: this.#delivered,
      // Only an explicit acknowledgement, as its owner records it now (#332).
      ackedSeq: this.#ackedNow(),
      reactedSeq: this.#reacted,
      latestSeq: this.#journal.latestSeq,
    };
  }

  /**
   * The leader's acknowledgement (D-05 § 6.6): monotonic and idempotent. At or below the current
   * ack it is a successful no-op, never a rewind; past the journal head it changes nothing. It
   * calls no adapter, so it can never cost a model turn.
   */
  ack(journalSeq: number): CursorAdvance {
    if (!this.#active()) return { status: 'inactive', seq: this.#acked };
    assertSeq(journalSeq);
    if (journalSeq <= this.#acked) return { status: 'unchanged', seq: this.#acked };
    if (journalSeq > this.#journal.latestSeq) return { status: 'ahead', seq: this.#acked };
    this.#acked = journalSeq;
    this.#floor = Math.max(this.#floor, journalSeq);
    this.#persist();
    return { status: 'advanced', seq: this.#acked };
  }

  /**
   * The adapter's report that a model turn carrying rows up to `journalSeq` really started — the
   * reaction half of F-20, recorded apart from delivery. Monotonic; never past a row the adapter was
   * handed. A turn may start before `deliver` has resolved, so a row still in flight counts as handed.
   */
  recordReaction(journalSeq: number): CursorAdvance {
    if (!this.#active()) return { status: 'inactive', seq: this.#reacted };
    assertSeq(journalSeq);
    if (journalSeq <= this.#reacted) return { status: 'unchanged', seq: this.#reacted };
    if (journalSeq > Math.max(this.#delivered, this.#handedOut)) return { status: 'ahead', seq: this.#reacted };
    this.#reacted = journalSeq;
    this.#persist();
    return { status: 'advanced', seq: this.#reacted };
  }

  /** The adapter's transport came back: start a recovery round now instead of at the next tick. */
  wake(): void {
    if (this.#state === 'disconnected') this.#state = 'idle';
    this.#schedule();
  }

  /**
   * Confirmed end of the session's connection — fired by the transport where it releases the lease.
   * Ends this controller only: the lease, the journal and every run are untouched.
   */
  close(): void {
    this.#end();
  }

  #active(): boolean {
    return this.#state !== 'inert' && this.#state !== 'ended';
  }

  #end(): void {
    if (!this.#active()) return;
    this.#state = 'ended';
    this.#closed.abort();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    liveControllers.delete(this.#journal.rowsPath);
  }

  /** Ownership is xezar's to enforce, so it is re-read, never remembered. Losing it ends us. */
  #stillOwner(): boolean {
    if (!this.#active()) return false;
    if (this.#ownership.sessionToken(this.#sessionKey) !== undefined) return true;
    this.#end();
    return false;
  }

  #schedule(): void {
    if (this.#scheduled || !this.#active()) return;
    this.#scheduled = true;
    // A microtask, not a timer: rows appended in the same tick share a dispatch, and nothing waits.
    queueMicrotask(() => {
      this.#scheduled = false;
      void this.#drain().catch((err: unknown) => this.#fault(err));
    });
  }

  /** A bug inside a background step is logged once, never thrown into the cockpit (N-07). The next
   *  tick tries again, because every step re-reads the journal and the owner from scratch. */
  #fault(err: unknown): void {
    if (this.#warnedFault) return;
    this.#warnedFault = true;
    this.#warn(`[xez] MCP event controller for project ${this.projectId} hit an internal error: ${err instanceof Error ? err.message : String(err)}`);
  }

  #release(): void {
    this.#busy = false;
    if (this.#again) {
      this.#again = false;
      this.#schedule();
    }
  }

  async #drain(): Promise<void> {
    if (this.#busy) {
      this.#again = true;
      return;
    }
    // A disconnected transport waits for the tick or `wake`, so a burst cannot fire rounds back to back.
    if (this.#state !== 'idle') return;
    this.#busy = true;
    try {
      for (;;) {
        if (!this.#stillOwner()) return;
        // The leader may have acknowledged through the pull tool since the last dispatch (#332).
        this.#syncFloor();
        const next = this.#next();
        if (next === undefined) return;
        if (next.lastSeq !== undefined) this.#handedOut = Math.max(this.#handedOut, next.lastSeq);
        const delivered = await this.#deliverBounded(next.dispatch);
        if (!this.#active()) return;
        if (delivered === false) {
          this.#state = 'disconnected';
          if (!this.#warnedDelivery) {
            this.#warnedDelivery = true;
            this.#warn(
              `[xez] MCP event delivery for project ${this.projectId} failed ${EVENT_DELIVERY_ATTEMPTS} times — retrying every ${this.#heartbeatMs / 1000}s while the session owns the project`,
            );
          }
          return;
        }
        this.#warnedDelivery = false;
        this.#state = 'idle';
        this.#position = next.nextCursor;
        this.#recovery = undefined;
        if (next.lastSeq !== undefined) {
          // Only rows REALLY handed over count as delivered; a receipt says which (the leader's own
          // echoes are settled but never delivered). A redelivery never lowers the count.
          const handed = delivered.receipt === undefined ? next.lastSeq : delivered.receipt.handedThrough;
          if (handed !== null) this.#delivered = Math.max(this.#delivered, handed);
        }
        this.#persist();
      }
    } finally {
      this.#release();
    }
  }

  /** The next dispatch, read from the journal itself. `undefined` when nothing is outstanding. */
  #next(): { dispatch: EventDispatch; nextCursor: string; lastSeq?: number } | undefined {
    for (;;) {
      let page;
      try {
        page = this.#journal.read(this.#position === undefined ? {} : { cursor: this.#position });
      } catch (err) {
        if (!(err instanceof McpJournalCursorError)) throw err;
        // Our own cursor refused: state the gap and start again from the oldest retained row.
        this.#position = undefined;
        this.#recovery = this.#gap();
        continue;
      }
      if (page.status === 'cursor_too_old') {
        this.#position = page.resumeCursor;
        this.#recovery = this.#gap();
        continue;
      }
      // Rows at or below the floor are not owed (the leader acknowledged them, or they predate it).
      const events = page.events.filter((row) => row.journalSeq > this.#floor);
      if (events.length === 0 && page.events.length > 0) {
        this.#position = page.nextCursor;
        continue;
      }
      if (events.length === 0 && this.#recovery === undefined) return undefined;
      const dispatch: EventDispatch = {
        projectId: this.projectId,
        events,
        ...(this.#recovery === undefined ? {} : { recovery: this.#recovery }),
      };
      const lastSeq = events.at(-1)?.journalSeq;
      return { dispatch, nextCursor: page.nextCursor, ...(lastSeq === undefined ? {} : { lastSeq }) };
    }
  }

  /**
   * One bounded recovery round over the SAME rows. No attempt can start a turn on its own. Every
   * attempt's outcome is a fact about the LEADER, and the adapter records it (`LeaderDelivery`).
   */
  async #deliverBounded(dispatch: EventDispatch): Promise<{ receipt: DeliveryReceipt | undefined } | false> {
    const adapter = this.#adapter!;
    for (let attempt = 0; attempt < EVENT_DELIVERY_ATTEMPTS; attempt++) {
      if (!this.#active()) return false;
      this.#state = attempt === 0 ? 'dispatching' : 'recovering';
      const outcome = await this.#attempt((signal) => adapter.deliver(dispatch, signal));
      if (outcome.ok) return { receipt: outcome.value === undefined ? undefined : outcome.value };
      if (attempt < EVENT_DELIVERY_ATTEMPTS - 1) {
        await this.#sleep(this.#random() * Math.min(EVENT_DELIVERY_BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt));
      }
    }
    return false;
  }

  /**
   * One call into the adapter, bounded by one heartbeat interval: an attempt that has not settled in
   * a whole liveness period is a dead transport, and it must not hold the queue behind it.
   */
  async #attempt<T>(call: (signal: AbortSignal) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    const attempt = new AbortController();
    const abort = (): void => attempt.abort();
    this.#closed.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.#heartbeatMs);
    timer.unref?.();
    const gaveUp = new Promise<never>((_, reject) => {
      attempt.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const work = Promise.resolve().then(() => call(attempt.signal));
    // Whichever loses the race settles later with nobody listening; neither may surface as unhandled.
    work.catch(() => {});
    gaveUp.catch(() => {});
    try {
      return { ok: true, value: await Promise.race([work, gaveUp]) };
    } catch {
      return { ok: false };
    } finally {
      clearTimeout(timer);
      this.#closed.signal.removeEventListener('abort', abort);
    }
  }

  /** The heartbeat: owner check, a recovery round when disconnected, then a non-model liveness probe. */
  async #tick(): Promise<void> {
    if (!this.#stillOwner() || this.#busy) return;
    if (this.#state === 'disconnected') this.#state = 'idle';
    // Re-reading the journal here is also the backstop for a wakeup that never arrived.
    await this.#drain();
    const probe = this.#adapter?.heartbeat;
    if (probe === undefined || this.#state !== 'idle' || this.#busy) return;
    this.#busy = true;
    const alive = (await this.#attempt((signal) => probe.call(this.#adapter, signal))).ok;
    if (this.#active() && !alive) this.#state = 'disconnected';
    this.#release();
  }

  /**
   * Where a starting controller reads from, and what it reports. The two are kept apart, because
   * conflating them is how a first session once reported rows as delivered, acknowledged and
   * reacted to that never reached anyone (QA on #311, D-05 § 6.6):
   * - REPORTED cursors come only from things that happened: `deliveredSeq` and `reactedSeq` from
   *   this file's record of real pushes and turns in the SAME journal epoch (0 otherwise), and
   *   `ackedSeq` from an explicit acknowledgement.
   * - The FLOOR is where pushing resumes: with a leader record, after what the leader is owed
   *   (`owedAfter`); standalone (#107), after the file's last ack, or the head for a first session.
   */
  #resume(): void {
    const journal = this.#journal;
    const saved = this.#load();
    const own = typeof saved === 'object' && saved.epoch === journal.epoch ? saved : undefined;
    this.#delivered = own ? Math.min(own.deliveredSeq, journal.latestSeq) : 0;
    this.#reacted = own ? Math.min(own.reactedSeq, this.#delivered) : 0;
    this.#acked = own && this.#leaderRecord === undefined ? Math.min(own.ackedSeq, journal.latestSeq) : 0;
    const firstRetained = journal.oldestSeq ?? journal.latestSeq + 1;
    this.#position = undefined;
    let gap: boolean;
    if (this.#leaderRecord !== undefined) {
      // One acknowledgement (#332): owed is what the leader's own record says, never this file.
      const owed = this.#owedAfter();
      this.#floor = owed.sameEpoch ? owed.seq : 0;
      gap = !owed.sameEpoch || this.#floor < firstRetained - 1;
    } else if (saved === 'absent' || saved === 'unreadable') {
      // Standalone first session: nothing was owed to a leader that did not exist; it reads current state (F-21).
      this.#floor = journal.latestSeq;
      this.#position = journal.headCursor();
      gap = saved === 'unreadable';
    } else {
      this.#floor = own ? Math.max(own.ackedSeq, own.floorSeq ?? own.ackedSeq) : 0;
      gap = own === undefined || this.#floor > journal.latestSeq || this.#floor < firstRetained - 1;
    }
    if (gap) {
      // Rows this session was owed are gone (journal recreated, or evicted unacknowledged): say so, and
      // resume at the oldest row that still exists — or, for an unreadable file, at the head.
      if (this.#position === undefined) this.#floor = Math.min(Math.max(this.#floor, 0), firstRetained - 1);
      this.#recovery = this.#gap();
    }
    this.#persist();
  }

  /** The leader record's owed-after position, clamped to this journal; nothing readable owes everything. */
  #owedAfter(): { seq: number; sameEpoch: boolean } {
    try {
      const owed = this.#leaderRecord!.owedAfter();
      const seq = Number.isSafeInteger(owed.seq) && owed.seq > 0 ? Math.min(owed.seq, this.#journal.latestSeq) : 0;
      return { seq, sameEpoch: owed.sameEpoch };
    } catch {
      return { seq: 0, sameEpoch: true }; // an unreadable record owes everything retained: at-least-once, never a skipped row
    }
  }

  /** The explicit acknowledgement as its owner records it now; 0 when there is none. */
  #ackedNow(): number {
    if (this.#leaderRecord === undefined) return this.#acked;
    try {
      const seq = this.#leaderRecord.acknowledged();
      return Number.isSafeInteger(seq) && seq > 0 ? Math.min(seq, this.#journal.latestSeq) : 0;
    } catch {
      return 0;
    }
  }

  /** Raise the floor to what the leader's record says it is owed after. Monotonic; reports nothing. */
  #syncFloor(): void {
    if (this.#leaderRecord === undefined) return;
    const owed = this.#owedAfter();
    if (!owed.sameEpoch || owed.seq <= this.#floor) return;
    this.#floor = owed.seq;
    this.#persist();
  }

  #gap(): EventRecovery {
    return {
      required: 'current-state',
      oldestSeq: this.#journal.oldestSeq,
      latestSeq: this.#journal.latestSeq,
      message: 'Some events this session was owed are no longer retained. Read the current state before acting on these events.',
    };
  }

  #load(): Saved | 'absent' | 'unreadable' {
    let raw: string;
    try {
      raw = readFileSync(this.#statePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
      raw = '';
    }
    try {
      const parsed = savedSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.projectId === this.projectId) return parsed.data;
    } catch {
      /* reported below */
    }
    this.#warn(`[xez] MCP event controller state for project ${this.projectId} is unreadable — its cursors restart at 0${this.#leaderRecord ? '' : ', pushing from the journal head with a stated gap'}`);
    return 'unreadable';
  }

  #persist(): void {
    const body: Saved = {
      v: 1,
      projectId: this.projectId,
      epoch: this.#journal.epoch,
      deliveredSeq: this.#delivered,
      ackedSeq: this.#acked,
      reactedSeq: this.#reacted,
      floorSeq: this.#floor,
    };
    const tmp = `${this.#statePath}.tmp`;
    try {
      mkdirSync(dirname(this.#statePath), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, `${JSON.stringify(body)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.#statePath);
    } catch (err) {
      if (this.#warnedWrite) return;
      this.#warnedWrite = true;
      const message = err instanceof Error ? err.message : String(err);
      this.#warn(`[xez] MCP event controller state for project ${this.projectId} cannot be written (${message}) — cursors are kept in memory only`);
    }
  }
}

function assertSeq(seq: number): void {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new RangeError('a journal sequence number is a non-negative integer');
}
