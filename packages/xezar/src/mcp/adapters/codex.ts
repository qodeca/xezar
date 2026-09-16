import { randomUUID } from 'node:crypto';

import type { McpJournalRow } from '@qodeca/xezar-contract';

import type { CodexAppServerMessage } from '../../core/codex-app-server-transport.ts';
import type { EventDispatch, ReactionAdapter } from '../event-controller.ts';
import { omittedRoutineLine } from '../event-significance.ts';

/**
 * The Codex reaction adapter (#109, Phase 6 of #67): the client-specific half the event controller
 * (#107) hands significant events to, for a leader running in Codex.
 *
 * WHICH RUNG OF THE DELIVERY HIERARCHY, AND WHY (requirements § 12, not reorderable). The evidence
 * is `docs/features/mcp-server/mcp-adapter-evidence-codex.md`; every claim below names its row.
 *
 * 1. **Native MCP notification — not used.** Executed against codex-cli 0.154.0: after the leader's
 *    tool call was accepted, `notifications/message`, `resources/updated`, `resources/list_changed`
 *    and `claude/channel` reached Codex and no turn started (evidence X1, and D-05 § 4 / the #85
 *    spike T06 before it). A rung the client does not demonstrably react to is not a rung.
 * 2. **The official programmatic session interface — used.** Codex's app-server: `turn/start`
 *    begins generation on an idle thread and `turn/steer` adds input to the thread's active turn,
 *    guarded by `expectedTurnId`. Executed: an event appended to the real journal went through the
 *    real controller and this adapter and the model's next request carried it, with no model request
 *    between the tool result and the event (X2). This adapter only speaks to an app-server
 *    connection it was handed. xezar starts no Codex process (decision on #311); since #374 the
 *    connection is `adapters/codex-link.ts`'s link to the person's OWN shared app-server, bound to the
 *    one thread the owning bridge announced and verified loaded there — never a thread it resumed
 *    from disk, which would be the "secretly create a second leader" the contract forbids. It holds
 *    that thread's subscription only while a hand-off is in flight (see `#held`).
 * 3. **Terminal text input — refused.** Nothing here can type into a terminal, and
 *    `codexTerminalDelivery()` answers with the recoverable blocker the contract requires, because
 *    none of its preconditions (project and session targeting, separation from approval prompts,
 *    the shell, user typing and active turns, duplicate prevention) has been proven for a Codex TUI.
 *
 * A CONTROL ADAPTER, NOT A RUNNER. It implements `ReactionAdapter` and adds no backend: nothing here
 * is an `AgentRunner`, and no Codex type leaves this file — the controller sees `deliver` and
 * `heartbeat`, and the rest of xezar sees `CodexReactionTarget`. `core/codex-app-server-runner.ts` is
 * the implementation anchor for speaking app-server (the same transport helpers are reused); it is
 * not evidence that this event flow works — the evidence file is.
 *
 * WHAT THE MODEL IS TOLD. Every message names xezar as its source and says in so many words that it
 * is neither a user instruction nor an approval; each row's summary is quoted as data so text inside
 * a summary cannot pose as the adapter's own framing. Nothing but journal rows — which are already
 * scrubbed of secrets and carry no account identity (F-15, F-12) — reaches the text.
 *
 * DELIVERY IS NOT REACTION (F-20, D-05 § 6.6). `deliver` resolves once the app-server ACCEPTED the
 * `turn/start` or `turn/steer` request: the client application has the rows. The reaction — a model
 * turn carrying them — is reported separately through `onReaction`, and only when app-server says
 * so: a `turn/started` for the turn this adapter started, or, after a steer, the steered input
 * showing up as a `userMessage` item in the active turn.
 *
 * DUPLICATES. The controller retries the SAME rows after a failed or timed-out attempt (at-least-once).
 * A retry whose earlier attempt did reach app-server must not start a second turn, so the adapter
 * remembers the newest row it has handed over and sends only rows past it, and a new attempt waits for
 * the previous hand-off to settle before deciding. Across a new session the controller redelivers
 * from the leader's last ack; the leader deduplicates on `eventId` (D-05 § 6.6).
 *
 * ROLE INSTRUCTION. Whoever opens the thread supplies it: in `developerInstructions` — additive session
 * guidance — never in `baseInstructions`, which was observed to REPLACE Codex's built-in instructions
 * (X5). xezar opens no thread any more, so it supplies none.
 *
 * NEVER POLLS. `heartbeat` is `thread/read` — metadata only, observed to reach no model (X10).
 */

/** What goes into a model's context about who sent it. One string, used by every message. */
export const CODEX_EVENT_SOURCE_NOTICE =
  'Sent by xezar\'s event adapter. This is not an instruction from the user and it is not an approval of anything.';

/** app-server JSON-RPC as this adapter uses it: a connection to a thread the leader already runs on. */
export interface CodexAppServerLink {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Every notification and server request app-server sends. Returns the unsubscribe. */
  subscribe(listener: (message: CodexAppServerMessage) => void): () => void;
  readonly closed: boolean;
}

/**
 * app-server ANSWERED the request with an error, so nothing was accepted. Every other failure — a
 * timeout, a dropped link — leaves acceptance unknown, and is remembered as a `CodexUnresolvedHandOff`.
 */
export class CodexRequestRefused extends Error {}

/** What `thread/resume` said about the leader's thread when xezar attached (decision record § 4). */
export interface CodexThreadState {
  /** An approval or user-input prompt was already open, so the first event must wait for it. */
  readonly waiting: boolean;
  /** The turn running at attach, when app-server reported one. */
  readonly activeTurnId?: string;
}

/** A hand-off whose request left and whose answer never came: it may or may not have been accepted. */
export interface CodexUnresolvedHandOff {
  readonly clientId: string;
  readonly seq: number;
}

/**
 * codex-cli 0.154.0's `ThreadStatus`: `notLoaded` | `idle` | `systemError` | `active` with an
 * `activeFlags` array whose every entry is a `ThreadActiveFlag` (`waitingOnApproval` |
 * `waitingOnUserInput`). Anything else — a missing or malformed payload, a type this version does not
 * name, an `active` without its flags, a flag entry it does not name — is `undefined`, never a guessed
 * "loaded and idle": reading uncertainty as "no approval" would start a turn straight through an open
 * prompt (round-4 review major 1, round-5 review major 1; decision record § 4, "refuse or defer
 * uncertain state").
 */
export function codexThreadStatus(status: unknown): { readonly loaded: boolean; readonly waiting: boolean } | undefined {
  if (typeof status !== 'object' || status === null) return undefined;
  const value = status as { type?: unknown; activeFlags?: unknown };
  switch (value.type) {
    case 'notLoaded':
      return { loaded: false, waiting: false };
    case 'idle':
    case 'systemError':
      return { loaded: true, waiting: false };
    case 'active': {
      if (!Array.isArray(value.activeFlags)) return undefined;
      const flags: unknown[] = value.activeFlags;
      // One unreadable entry makes the whole status unreadable: it may be the prompt xezar would miss.
      if (!flags.every((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput')) return undefined;
      return { loaded: true, waiting: flags.length > 0 };
    }
    default:
      return undefined;
  }
}

/** How many recent turns a reconciliation reads for an unresolved hand-off's client message id. */
const RECONCILE_TURNS = 5;

const NOT_LOADED = 'the announced Codex thread is absent, stale, ambiguous, or not loaded for this project';

/** codex-cli 0.154.0's `ThreadLoadedListResponse.data` is `string[]` — thread ids, not thread records. */
export function codexLoadedIds(value: Record<string, unknown>): string[] {
  const data = Array.isArray(value.data) ? value.data : [];
  return data.filter((id): id is string => typeof id === 'string');
}

/**
 * The thread's busy and prompt state from a `thread/resume` answer (decision record § 4). An `active`
 * thread's running turn is not in an `excludeTurns` answer, so it is read from the newest
 * `thread/turns/list` entry. A missing status is refused rather than read as idle — observation that
 * starts after an approval opened must not read as "no approval" — and so is `notLoaded`.
 */
export async function codexThreadState(link: CodexAppServerLink, threadId: string, resumed: Record<string, unknown>): Promise<CodexThreadState> {
  const raw = (resumed.thread as { status?: unknown } | undefined)?.status;
  const status = codexThreadStatus(raw);
  // Missing and unrecognised alike: an unknown state is refused, never read as idle.
  if (status === undefined) throw new Error('the Codex app-server did not report the thread’s state in a form xezar recognises');
  if (!status.loaded) throw new Error(NOT_LOADED);
  if ((raw as { type: string }).type !== 'active') return { waiting: status.waiting };
  const page = await link.request('thread/turns/list', { threadId, limit: 1 });
  const newest = (Array.isArray(page.data) ? page.data[0] : undefined) as { id?: unknown; status?: unknown } | undefined;
  return typeof newest?.id === 'string' && newest.status === 'inProgress' ? { waiting: status.waiting, activeTurnId: newest.id } : { waiting: status.waiting };
}

/** A recoverable blocker: why events are not being delivered, and what would unblock them. */
export interface CodexReactionBlocker {
  readonly code: 'codex-session-not-targetable' | 'codex-terminal-delivery-refused';
  readonly recoverable: true;
  readonly message: string;
  readonly remedy: string;
}

/** Where a project's leader events can go in Codex: an adapter, or a stated blocker. Never neither. */
export type CodexReactionTarget =
  | { readonly kind: 'app-server'; readonly adapter: CodexReactionAdapter }
  | { readonly kind: 'blocked'; readonly blocker: CodexReactionBlocker };

export interface CodexReactionAdapterOptions {
  /** The app-server connection the leader's thread lives on — one this xezar process owns. */
  link: CodexAppServerLink;
  /** The leader's thread on that connection, as `thread/start` or `thread/resume` answered it. */
  threadId: string;
  /** The bound project. A dispatch for any other project is refused, never delivered. */
  projectId: string;
  /** The reaction half of F-20 — wire it to `EventController.recordReaction`. */
  onReaction?: (journalSeq: number) => void;
  /**
   * The echo guard (D-05 § 6.3, F-13): true for an operation id the leader itself has outstanding.
   * A `leader` row caused by one is dropped; nothing is dropped merely because the run is familiar.
   * Absent: no row is ever dropped.
   */
  isOwnOperation?: (operationId: string) => boolean;
  /** The thread's state at attach, from `thread/resume`. Absent: nothing was open and no turn ran. */
  state?: CodexThreadState;
  /** A previous link's hand-off with unknown acceptance, reconciled before anything is resent. */
  unresolved?: CodexUnresolvedHandOff;
}

/** A hand-off app-server accepted, still waiting to be seen reaching the model. */
interface AwaitingReaction {
  readonly seq: number;
  /** The `clientUserMessageId` sent with it, echoed back as the `userMessage` item's `clientId`. */
  readonly clientId: string;
}

export class CodexReactionAdapter implements ReactionAdapter {
  readonly projectId: string;
  readonly threadId: string;
  readonly #link: CodexAppServerLink;
  readonly #onReaction: ((journalSeq: number) => void) | undefined;
  readonly #isOwnOperation: ((operationId: string) => boolean) | undefined;
  readonly #unsubscribe: () => void;

  /** The turn app-server says is running on our thread, whoever started it. */
  #activeTurnId: string | undefined;
  /** Our own items app-server reported before the request that sent them was answered. */
  readonly #seenClientIds = new Set<string>();
  /** Keeps this adapter's client ids apart from an earlier adapter's on the same resumed thread. */
  readonly #sessionTag = randomUUID().slice(0, 8);
  /** Server requests (approvals, user-input prompts) app-server is waiting on for our thread. */
  readonly #openPrompts = new Set<string>();
  readonly #promptsSettled = new Set<() => void>();
  /** Newest journalSeq handed to app-server in an accepted request (duplicate guard). */
  #handedThrough = 0;
  /** The gap (`oldestSeq:latestSeq`) already told to the leader, so a retry does not tell it twice. */
  #gapHanded: string | undefined;
  /** The previous hand-off, so a retry decides only after it settled. */
  #inFlight: Promise<void> = Promise.resolve();
  #awaiting: AwaitingReaction[] = [];
  #sequence = 0;
  /**
   * app-server's own `activeFlags` say a prompt is open. Seeded from `thread/resume` at attach, because
   * a prompt that opened BEFORE this adapter subscribed sent its server request to another client, and
   * observation starting after it must not read as "no approval" (decision record § 4).
   */
  #statusWaiting: boolean;
  /**
   * app-server sent a `thread/status/changed` this adapter cannot read. Until it sends one it can, or
   * the next hand-off reads the thread afresh (`#acquire`), that counts as a prompt being open: an
   * uncertain state is deferred, never guessed (round-4 review, major 1).
   */
  #statusUnknown = false;
  /** Why the leader's thread can no longer be reached on this link (unloaded or closed), if it cannot. */
  #gone: string | undefined;
  /** A hand-off whose acceptance is unknown. The next delivery reconciles it before sending anything. */
  #unresolved: CodexUnresolvedHandOff | undefined;
  /**
   * Whether this link holds the thread's subscription (`thread/resume` subscribes). Held ONLY while a
   * hand-off of ours is in flight or awaiting its reaction. Measured on codex-cli 0.154.0: a thread
   * whose TUI exited was unloaded about a minute later when nothing else was subscribed, and stayed
   * loaded indefinitely while a second link was — so a link that kept holding would keep starting
   * model turns in a session nobody watches. Released, app-server unloads the thread, and the next
   * delivery or heartbeat finds it gone and refuses (never resurrecting it).
   */
  #held = false;
  /** Deliveries currently between their first request and their last. */
  #busy = 0;
  /** Hand-off requests still waiting on their answer, including one whose delivery was abandoned. */
  #handing = 0;

  constructor(opts: CodexReactionAdapterOptions) {
    this.projectId = opts.projectId;
    this.threadId = opts.threadId;
    this.#link = opts.link;
    this.#onReaction = opts.onReaction;
    this.#isOwnOperation = opts.isOwnOperation;
    this.#statusWaiting = opts.state?.waiting ?? false;
    this.#activeTurnId = opts.state?.activeTurnId;
    this.#unresolved = opts.unresolved;
    this.#unsubscribe = opts.link.subscribe((message) => this.#observe(message));
  }

  /** The newest row app-server accepted from this adapter. Not a reaction; see `onReaction`. */
  get handedThrough(): number {
    return this.#handedThrough;
  }

  /** True while app-server waits on an approval or user-input prompt for the leader's thread. */
  get promptOpen(): boolean {
    return this.#openPrompts.size > 0 || this.#statusWaiting || this.#statusUnknown;
  }

  /** A hand-off whose acceptance is still unknown, for a re-attach to the same thread to reconcile. */
  get unresolved(): CodexUnresolvedHandOff | undefined {
    return this.#unresolved;
  }

  /** Stop listening, and let go of the thread if this adapter holds it. The link belongs to whoever opened it. */
  dispose(): void {
    this.#unsubscribe();
    this.#settlePrompts();
    this.#awaiting = [];
    this.#release();
  }

  /** `LeaderDelivery` owns only this observer; the shared app-server link is released separately. */
  close(): void {
    this.dispose();
  }

  /**
   * Codex's own recoverable reason once this link cannot deliver — the daemon went away (the link
   * closed) or the leader's thread was unloaded or closed (its TUI exited) — in the connection
   * screen's words, so the cockpit names the Codex remedy instead of the generic "not answering".
   */
  status(): { blocker?: { code: string; message: string; fix: string } } {
    if (this.#link.closed) return { blocker: codexBlocker('app-server') };
    if (this.#gone !== undefined) return { blocker: codexBlocker('thread') };
    if (this.#statusUnknown) return { blocker: STATE_UNKNOWN };
    return {};
  }

  async deliver(dispatch: EventDispatch, signal: AbortSignal): Promise<void> {
    if (dispatch.projectId !== this.projectId) {
      throw new Error(`codex adapter for project ${this.projectId} refused a dispatch for another project`);
    }
    // A retry decides only once the attempt before it settled, so it can see what that one handed over.
    await abortable(this.#inFlight, signal);
    this.#assertReachable();
    this.#busy += 1;
    try {
      await this.#reconcile(signal);

      const fresh = dispatch.events.filter((row) => row.journalSeq > this.#handedThrough);
      const newest = fresh.at(-1)?.journalSeq;
      const shown = fresh.filter((row) => !this.#isEcho(row));
      // A gap is told once: a retried dispatch carries the same recovery, and it was already handed over.
      const gap = dispatch.recovery;
      const gapKey = gap === undefined ? undefined : `${gap.oldestSeq}:${gap.latestSeq}`;
      const tellGap = gapKey !== undefined && gapKey !== this.#gapHanded;
      if (shown.length === 0 && !tellGap) {
        // Nothing the leader has not been handed already, or only its own echoes: no turn to start.
        if (newest !== undefined) this.#handedThrough = newest;
        return;
      }
      await this.#acquire(signal);
      // Separation from approval prompts: never hand an event to a thread that is waiting on one.
      await this.#promptsClear(signal);
      this.#assertReachable();

      const { recovery: _told, ...rest } = dispatch;
      const text = renderCodexEventMessage(tellGap && gap !== undefined ? { ...rest, events: shown, recovery: gap } : { ...rest, events: shown });
      const handOff = this.#handOff(text, newest).then(() => {
        if (tellGap) this.#gapHanded = gapKey;
      });
      this.#handing += 1;
      this.#inFlight = handOff.catch(() => undefined).finally(() => {
        this.#handing -= 1;
        this.#releaseIfIdle();
      });
      await abortable(handOff, signal);
    } finally {
      this.#busy -= 1;
      this.#releaseIfIdle();
    }
  }

  /**
   * Non-model liveness (N-06): is the leader's thread still loaded? A listing of loaded thread ids,
   * which reaches no model. Its TUI exiting is seen here: with nothing subscribed, app-server unloads
   * the thread, and from then on this answers the recoverable blocker instead of pushing into it.
   */
  async heartbeat(signal: AbortSignal): Promise<void> {
    this.#assertReachable();
    if (this.#held && this.#busy === 0) await this.#settleAwaiting(signal);
    const loaded = await abortable(this.#link.request('thread/loaded/list', {}), signal);
    if (!codexLoadedIds(loaded).includes(this.threadId)) this.#gone = NOT_LOADED;
    this.#assertReachable();
  }

  /**
   * Take the leader's thread for ONE hand-off. It must still be loaded — an unloaded thread is never
   * resurrected — and `thread/resume` (which subscribes this link) reports its state afresh, so an
   * approval that opened while xezar was not listening is seen before anything is sent.
   */
  async #acquire(signal: AbortSignal): Promise<void> {
    if (this.#held) return;
    const loaded = await abortable(this.#link.request('thread/loaded/list', {}), signal);
    if (!codexLoadedIds(loaded).includes(this.threadId)) {
      this.#gone = NOT_LOADED;
      throw new Error(NOT_LOADED);
    }
    const resumed = await abortable(this.#link.request('thread/resume', { threadId: this.threadId, excludeTurns: true }), signal);
    this.#held = true;
    const state = await abortable(codexThreadState(this.#link, this.threadId, resumed), signal);
    this.#statusWaiting = state.waiting;
    this.#statusUnknown = false;
    this.#activeTurnId = state.activeTurnId;
  }

  /** Let go of the subscription once nothing of ours is in flight or awaiting its reaction. */
  #releaseIfIdle(): void {
    if (this.#busy === 0 && this.#handing === 0 && this.#awaiting.length === 0) this.#release();
  }

  #release(): void {
    if (!this.#held) return;
    this.#held = false;
    // Unsubscribed, this link hears no further status, so an unknown one would be reported for ever.
    // Forgetting it is safe: the next hand-off reads the thread afresh (`#acquire`) before sending.
    this.#statusUnknown = false;
    if (!this.#link.closed) this.#link.request('thread/unsubscribe', { threadId: this.threadId }).catch(() => undefined);
  }

  /**
   * A reaction that never showed while subscribed (a steer whose turn ended first, a provider that
   * failed) must not keep the thread held. One heartbeat later its history is read once for the
   * awaited client ids — found ones count as reacted — and the subscription is let go either way.
   */
  async #settleAwaiting(signal: AbortSignal): Promise<void> {
    if (this.#awaiting.length > 0) {
      const page = await abortable(this.#link.request('thread/turns/list', { threadId: this.threadId, limit: RECONCILE_TURNS, itemsView: 'full' }), signal);
      const seen = clientIdsIn(page);
      const reached = this.#awaiting.filter((entry) => seen.has(entry.clientId)).at(-1);
      if (reached !== undefined) this.#reacted(reached.seq);
      this.#awaiting = [];
    }
    this.#release();
  }

  #assertReachable(): void {
    if (this.#link.closed) throw new Error('the codex app-server connection is closed');
    if (this.#gone !== undefined) throw new Error(this.#gone);
  }

  /**
   * A hand-off whose answer never came may still have reached the model, and a `clientUserMessageId`
   * is correlation, not proven idempotency (decision record § 4). So before anything is sent again,
   * the thread's recent turns are read for that id — a history read, which reaches no model. Found:
   * it WAS accepted, so it counts as handed over and reacted to, and nothing is resent. Absent: it was
   * not, and the rows go again. A read that fails keeps the doubt and fails this attempt, so an
   * uncertain state is deferred, never guessed.
   */
  async #reconcile(signal: AbortSignal): Promise<void> {
    const pending = this.#unresolved;
    if (pending === undefined) return;
    const page = await abortable(this.#link.request('thread/turns/list', { threadId: this.threadId, limit: RECONCILE_TURNS, itemsView: 'full' }), signal);
    this.#unresolved = undefined;
    if (!clientIdsIn(page).has(pending.clientId)) return;
    this.#handedThrough = Math.max(this.#handedThrough, pending.seq);
    this.#reacted(pending.seq);
  }

  async #handOff(text: string, newest: number | undefined): Promise<void> {
    const input = [{ type: 'text', text, text_elements: [] }];
    // Echoed back as the `userMessage` item's `clientId` (X6), which is how the reaction is matched.
    const clientId = `xezar-event:${this.projectId}:${this.#sessionTag}:${++this.#sequence}`;
    const active = this.#activeTurnId;
    if (active !== undefined) {
      try {
        await this.#link.request('turn/steer', { threadId: this.threadId, input, expectedTurnId: active, clientUserMessageId: clientId });
        this.#handed(newest, clientId);
        return;
      } catch (err) {
        // Only a refusal is known to have been turned away; anything else may have reached the turn.
        if (!(err instanceof CodexRequestRefused)) throw this.#unknownAcceptance(err, clientId, newest);
        // `expectedTurnId` is a precondition and app-server refuses a mismatch (X3). The turn ended
        // between our read and the request, so the documented way in is now a new turn.
        if (this.#activeTurnId === active) this.#activeTurnId = undefined;
      }
    }
    // On a thread whose turn is still running, codex-cli 0.154.0 folds this into that turn as a steer
    // and answers with the running turn's id (X3); the reaction match below covers both cases.
    try {
      await this.#link.request('turn/start', { threadId: this.threadId, input, clientUserMessageId: clientId });
    } catch (err) {
      throw err instanceof CodexRequestRefused ? err : this.#unknownAcceptance(err, clientId, newest);
    }
    this.#handed(newest, clientId);
  }

  /** Remember a hand-off that may have been accepted, so the retry reconciles instead of resending blind. */
  #unknownAcceptance(err: unknown, clientId: string, newest: number | undefined): unknown {
    if (newest !== undefined) this.#unresolved = { clientId, seq: newest };
    return err;
  }

  #handed(newest: number | undefined, clientId: string): void {
    if (newest !== undefined) this.#handedThrough = Math.max(this.#handedThrough, newest);
    if (this.#seenClientIds.delete(clientId)) {
      if (newest !== undefined) this.#reacted(newest);
      return;
    }
    if (newest !== undefined) this.#awaiting.push({ seq: newest, clientId });
  }

  #reacted(seq: number): void {
    this.#awaiting = this.#awaiting.filter((entry) => entry.seq > seq);
    this.#onReaction?.(seq);
    this.#releaseIfIdle();
  }

  #isEcho(row: McpJournalRow): boolean {
    return row.origin === 'leader' && row.causedBy !== null && this.#isOwnOperation?.(row.causedBy) === true;
  }

  #observe(message: CodexAppServerMessage): void {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    // app-server multiplexes every thread on one connection; only the leader's thread concerns us.
    if (threadId !== undefined && threadId !== this.threadId) return;
    if (message.id !== undefined && typeof message.method === 'string') {
      if (threadId === this.threadId) this.#openPrompts.add(String(message.id));
      return;
    }
    switch (message.method) {
      case 'turn/started': {
        this.#activeTurnId = turnIdOf(params) ?? this.#activeTurnId;
        return;
      }
      case 'turn/completed':
      case 'turn/failed': {
        if (turnIdOf(params) === this.#activeTurnId) this.#activeTurnId = undefined;
        return;
      }
      case 'item/started': {
        // Our input becoming a `userMessage` item is app-server starting model work on it: at once for
        // an idle thread, and at the turn's next model request for a steer (X3). That is the reaction.
        const item = (params.item ?? {}) as Record<string, unknown>;
        if (item.type !== 'userMessage' || typeof item.clientId !== 'string') return;
        const clientId = item.clientId;
        const entry = this.#awaiting.find((awaiting) => awaiting.clientId === clientId);
        if (entry !== undefined) this.#reacted(entry.seq);
        else if (clientId.startsWith(`xezar-event:${this.projectId}:${this.#sessionTag}:`)) this.#seenClientIds.add(clientId);
        return;
      }
      case 'serverRequest/resolved': {
        this.#openPrompts.delete(String(params.requestId));
        if (!this.promptOpen) this.#settlePrompts();
        return;
      }
      case 'thread/status/changed': {
        const status = codexThreadStatus(params.status);
        // A status it cannot read keeps whatever wait was open and holds new hand-offs too. Nothing is
        // settled here: releasing a seeded approval on a malformed payload is the fail-open the
        // round-4 review found.
        if (status === undefined) {
          this.#statusUnknown = true;
          return;
        }
        this.#statusUnknown = false;
        this.#statusWaiting = status.waiting;
        if (!status.loaded) this.#gone = 'the leader’s Codex thread is no longer loaded on its app-server';
        if (!this.promptOpen || this.#gone !== undefined) this.#settlePrompts();
        return;
      }
      case 'thread/closed': {
        // The leader's TUI left and app-server let the thread go. Never resumed again from here: an
        // unloaded thread is not resurrected to deliver pending events (decision record § 4).
        this.#gone = 'the leader’s Codex thread was closed on its app-server';
        this.#held = false;
        this.#settlePrompts();
        return;
      }
      default:
        return;
    }
  }

  #promptsClear(signal: AbortSignal): Promise<void> {
    if (!this.promptOpen) return Promise.resolve();
    return abortable(new Promise<void>((resolve) => this.#promptsSettled.add(resolve)), signal);
  }

  #settlePrompts(): void {
    for (const resolve of this.#promptsSettled) resolve();
    this.#promptsSettled.clear();
  }
}

/**
 * The text a Codex leader receives for one dispatch. Exported for tests and for the evidence record;
 * pure — the same dispatch always renders the same text.
 */
export function renderCodexEventMessage(dispatch: EventDispatch): string {
  const count = dispatch.events.length;
  const lines = [
    `[xezar event — project ${dispatch.projectId}, ${count} significant event${count === 1 ? '' : 's'}] ${CODEX_EVENT_SOURCE_NOTICE}`,
  ];
  if (dispatch.recovery !== undefined) lines.push(`Gap: ${dispatch.recovery.message}`);
  for (const row of dispatch.events) {
    const subject = `${row.subject.type} ${row.subject.id}${row.subject.version === null ? '' : ` @${row.subject.version}`}`;
    const cause = row.causedBy === null ? '' : `, caused by operation ${row.causedBy}`;
    lines.push(`- ${row.eventId} ${row.category} ${row.kind} on ${subject} (origin ${row.origin}${cause}): ${JSON.stringify(row.summary)}`);
  }
  const omitted = omittedRoutineLine(dispatch.omittedRoutineCount);
  if (omitted !== undefined) lines.push(omitted);
  const last = dispatch.events.at(-1)?.journalSeq;
  lines.push(
    last === undefined
      ? 'Read the current state with xezar\'s tools before deciding anything.'
      : `Read the current state with xezar's tools before deciding anything. These events run through journalSeq ${last}; acknowledge them once you have taken them into account. Acknowledge them with leader_events action ack and cursor ${dispatch.nextCursor}.`,
  );
  return lines.join('\n');
}

/**
 * Terminal text input is the last rung, and it stays refused: no runtime evidence proves project and
 * session targeting, separation from approval prompts, the shell, user typing and active turns, or
 * duplicate prevention for a Codex terminal. The answer is a blocker the cockpit can show, never an
 * attempt.
 */
export function codexTerminalDelivery(): { readonly kind: 'refused'; readonly blocker: CodexReactionBlocker } {
  return {
    kind: 'refused',
    blocker: {
      code: 'codex-terminal-delivery-refused',
      recoverable: true,
      message:
        'xezar does not type into a Codex terminal. Targeting, separation from approval prompts, the shell, your typing and an active turn, and duplicate prevention are not proven for it.',
      remedy: 'Run the leader in a Codex session xezar reaches through app-server, where events are delivered as turns.',
    },
  };
}

/**
 * Where a project's leader events go. `link` and `threadId` present: an app-server session this
 * process holds, so events are delivered through it. Absent — the leader is an interactive `codex`
 * session xezar did not start (known, at most, through the thread id Codex sends in a tool call's
 * `_meta`) — a recoverable blocker: that thread is live in another process, and neither attaching a
 * second writer to it nor typing into its terminal is a proven, supported path (evidence X9, blocker B1).
 */
export function codexReactionTarget(
  opts: Omit<CodexReactionAdapterOptions, 'link' | 'threadId'> & { link?: CodexAppServerLink; threadId?: string },
): CodexReactionTarget {
  if (opts.link !== undefined && opts.threadId !== undefined && !opts.link.closed) {
    return { kind: 'app-server', adapter: new CodexReactionAdapter({ ...opts, link: opts.link, threadId: opts.threadId }) };
  }
  return { kind: 'blocked', blocker: UNREACHABLE };
}

/** One text for "not reachable", before attach and after: the decision record's approved copy. */
const UNREACHABLE: CodexReactionBlocker = {
  code: 'codex-session-not-targetable',
  recoverable: true,
  message:
    'xezar cannot reach this running Codex session for project-event delivery. Your events are saved. Use leader_events in Codex to read them; retry connecting when this session is available on Codex’s local app-server.',
  remedy:
    'Use leader_events in Codex to read saved events, then retry connecting when this session is available on Codex’s local app-server.',
};

/**
 * WHICH refusal it was, as far as xezar can tell (design review NB-1 on #403). The message stays the
 * decision record's verbatim "cannot reach" copy for all of them; the `fix` names the cause and the
 * one thing to change, because "retry when it is available" does not tell a person that their
 * app-server is not running, that Codex runs under another home, or that the session is not loaded.
 *
 * - `not-announced`: no tool call from the owning Codex session yet, so xezar does not know which
 *   session it is (Codex stamps the thread id on its tool calls, and on nothing else).
 * - `app-server`: no usable shared app-server in the Codex home xezar looks in — no control socket,
 *   an unsafe one, or one that refused or dropped xezar's connection.
 * - `home`: an app-server answered, but for a different Codex home than the one `xezar serve` uses.
 * - `thread`: the announced session is not loaded (its TUI exited, it is only saved) or is ambiguous.
 * - `state`: the app-server reported the session's state in a shape this version does not recognise,
 *   so nothing was attached rather than guess whether a prompt is open.
 */
export type CodexUnreachableReason = 'not-announced' | 'app-server' | 'home' | 'thread' | 'state';

const UNTIL_THEN = ' Until then, use leader_events in Codex to read saved events.';

const CODEX_REASONS: Record<CodexUnreachableReason, { readonly code: string; readonly fix: string }> = {
  'not-announced': {
    code: 'codex-session-not-targetable',
    fix: `Your Codex session has not called a xezar tool yet, so xezar does not know which session it is. Let it call one once (for example leader_events), then attach it again.${UNTIL_THEN}`,
  },
  'app-server': {
    code: 'codex-app-server-unreachable',
    fix: `No shared Codex app-server answered in the Codex home xezar uses. Run Codex’s shared local app-server there (\`codex app-server --listen unix://\`), open your session in the Codex TUI, then attach again.${UNTIL_THEN}`,
  },
  home: {
    code: 'codex-home-mismatch',
    fix: `The Codex home xezar looks in cannot be read, or the app-server there runs under a different home, so this is not the Codex your session uses. Start \`xezar serve\` and Codex with the same CODEX_HOME, or with none set for either, then attach again.${UNTIL_THEN}`,
  },
  thread: {
    code: 'codex-thread-not-loaded',
    fix: `This Codex session is not loaded on the app-server: its TUI exited, it is only saved, or another session in this folder makes it ambiguous. Open the session in your Codex TUI again, let it call a xezar tool once, then attach again.${UNTIL_THEN}`,
  },
  state: {
    code: 'codex-thread-state-unknown',
    fix: `The app-server reported this session’s state in a form xezar does not recognise (codex-cli 0.154.0 is the version xezar was measured against), so it did not attach rather than risk interrupting an approval. Attach again once the session is idle; if it keeps happening, your codex-cli may be newer than xezar supports.${UNTIL_THEN}`,
  },
};

/** The status blocker for one reason: the verbatim "cannot reach" message and that reason's own fix. */
export function codexBlocker(reason: CodexUnreachableReason): { code: string; message: string; fix: string } {
  const { code, fix } = CODEX_REASONS[reason];
  return { code, message: UNREACHABLE.message, fix };
}

/** app-server reported a thread state xezar cannot read, so events wait (round-4 review, major 1). */
const STATE_UNKNOWN = {
  code: 'codex-thread-state-unknown',
  message:
    'xezar could not read the state of this Codex session, so it holds events rather than risk interrupting an approval or a question. Your events are saved. Use leader_events in Codex to read them.',
  fix: 'Nothing is needed once Codex reports the session’s state again: the events go then. Meanwhile, use leader_events in Codex to read saved events.',
};

/** Every client message id app-server recorded in a `thread/turns/list` page's `userMessage` items. */
function clientIdsIn(page: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const turn of Array.isArray(page.data) ? page.data : []) {
    const items = (turn as { items?: unknown } | null)?.items;
    for (const item of Array.isArray(items) ? items : []) {
      const value = item as { type?: unknown; clientId?: unknown } | null;
      if (value?.type === 'userMessage' && typeof value.clientId === 'string') ids.add(value.clientId);
    }
  }
  return ids;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function turnIdOf(obj: Record<string, unknown>): string | undefined {
  const turn = obj.turn as { id?: unknown } | undefined;
  if (typeof turn?.id === 'string') return turn.id;
  return typeof obj.turnId === 'string' ? obj.turnId : undefined;
}
