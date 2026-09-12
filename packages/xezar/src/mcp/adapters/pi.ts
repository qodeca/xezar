import { MCP_JOURNAL_RETAINED_ROWS, type McpJournalRow } from '@qodeca/xezar-contract';

import type { EventDispatch, ReactionAdapter } from '../event-controller.ts';

/**
 * The pi reaction adapter (#330 WP2, Phase 6 of #67): the client-specific half the non-model event
 * controller (#107, `event-controller.ts`) hands significant events to, for a leader running in pi.
 * The runtime evidence is `docs/features/mcp-server/mcp-adapter-evidence-pi.md` (second half); every
 * behavioural claim below names the scenario that measured it against pi 0.85.1.
 *
 * A CONTROL ADAPTER, NOT A RUNNER. It implements `ReactionAdapter` and adds no backend: it starts no
 * process, owns no session, writes no file and reads no environment variable. `core/pi-runner.ts` is
 * the implementation anchor for speaking pi's RPC (same protocol, `docs/rpc.md`); it is not evidence
 * that this event flow works — the evidence record is. No pi type leaves this file: the controller
 * sees `deliver` and `heartbeat`, and the rest of xezar sees `PiReactionTarget`.
 *
 * THE DELIVERY HIERARCHY (requirements § 12), in order and not reorderable:
 *  1. Native mechanism — NOT ADOPTED. The bridge advertises tools only and sends no notification,
 *     and against a stub that did, `notifications/resources/updated` and `notifications/message`
 *     started no pi turn (#330 run A; D-05 § 4 for the other three). pi sends no `resources/subscribe`.
 *  2. The official programmatic session interface — ADOPTED: pi's RPC `prompt` when pi is idle, and
 *     `steer` when it is busy. Executed on this host (scenario `rpc-probe`): an idle `prompt` put the
 *     text into the conversation and the very next model request carried it; a plain `prompt` sent
 *     during a turn was REFUSED (`Agent is already processing. Specify streamingBehavior …`); the
 *     same text sent as `steer` was queued, delivered when the running turn's tool calls finished,
 *     and carried by the following model request. The running turn was not cut short.
 *  3. Terminal text input — REFUSED. Tier 2 works, and nothing here simulates a keystroke.
 *
 * WHOSE PI PROCESS. Only one whose RPC stdio the CALLER already owns, handed in as `PiRpcLink`. This
 * adapter never spawns pi, because xezar starts no agent process for a leader (owner decision on
 * #311). pi's RPC is stdio-only — it has no port, no socket and no attach mode (`pi --help`,
 * `docs/rpc.md` on 0.85.1) — so a pi the person runs in their own terminal has no address xezar can
 * reach, and `piReactionTarget()` answers with the recoverable `pi-not-addressable` blocker for it.
 * That is the same standing as a Claude Code or Codex session in a terminal (`leader-delivery.ts`):
 * the rows stay in the journal and the leader reads them with `leader_events`.
 *
 * SO NOTHING CONSTRUCTS THIS ADAPTER IN PRODUCTION YET, and that is deliberate rather than an
 * oversight — say it here so no reader has to infer it (QA on #358). `PiRpcLink` has no producer in
 * the repository: the one production caller of `piReactionTarget` passes no `link`, so the result is
 * always the blocker. Closing it needs a xezar-shipped pi EXTENSION that connects out and hands this
 * process a link — `ExtensionAPI.sendUserMessage` is documented "Always triggers a turn", extensions
 * are unsandboxed, and the already-required `pi-mcp-adapter` opens sockets today, so the route is
 * open; what is missing is the artifact. Evidence record blocker PI-2 and its § "What would produce
 * a link". Nothing xezar can send over MCP starts a pi turn, so the extension is the only route.
 *
 * DELIVERY IS NOT REACTION (F-20, D-05 § 6.6). `deliver` resolves once pi ANSWERED the `prompt` or
 * `steer` with `success: true`: the client application has the rows. The reaction is reported
 * separately through `onReaction`, and only when pi says so — the submission's own text appearing as
 * a `user` message in the conversation (`message_start`/`message_end`). Measured: pi emits that
 * message immediately before the model request that carries it, for an idle `prompt` and for a
 * steered message alike, and never for one that is still sitting in the steering queue. It is
 * therefore observed, never inferred from the `response`.
 *
 * SAFETY RULES, each measured against pi 0.85.1:
 *  - Role instruction on EVERY submission. pi keeps no system prompt in its session file, so a
 *    resumed session loses `--append-system-prompt` (evidence record, prompt persistence: FAIL). The
 *    adapter does not start pi and cannot pass that flag, so it carries xezar's own role text in the
 *    message it sends, every time. It is xezar's text, never read from a project file the leader can
 *    edit (§ 12). Prompt text is still not enforcement.
 *  - Never into a running turn as a plain `prompt`. pi refuses it outright, so the adapter sends
 *    `steer` when pi is busy AND falls back to `steer` when a `prompt` is refused anyway. That
 *    fallback covers only ONE direction of a stale `busy`, and an earlier version of this comment
 *    claimed it covered both (QA on #358). The other direction is worse: a `steer` into an IDLE pi
 *    is accepted and PARKED — zero model requests, and the text waits for the person's next turn —
 *    so a believed `busy` is confirmed against pi before steering, and a steer that parked is never
 *    reported as handed over. See `#submit`.
 *  - Never two turns for one row. Rows already submitted are skipped: from memory within this
 *    adapter's life, and from pi's own conversation (`get_messages`, the marker this adapter writes
 *    into its text) on the first delivery and after any attempt whose answer was lost — so a
 *    restart, or a lost response, does not ask the model twice.
 *  - Never a second leader. It speaks only to the link it was given, and creates nothing.
 *
 * AGENTS.md / #329: `PI_CODING_AGENT_DIR` relocates pi's home and its credentials. This module reads
 * no environment variable and sets none, and imports neither `node:fs` nor `node:child_process` —
 * the test file asserts all three.
 */

/** One line pi writes on its RPC stdout: a `response` to a command, or an event. */
export interface PiRpcMessage {
  readonly type?: unknown;
  readonly [key: string]: unknown;
}

/** pi's answer to one command (`docs/rpc.md`): `success` is acceptance, not the turn's outcome. */
export interface PiRpcResponse {
  readonly success: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: unknown;
}

/**
 * pi's RPC as this adapter uses it: a JSONL command in, pi's event stream out, over a process the
 * CALLER owns. Deliberately transport-free — the adapter never learns whether the stdio behind it is
 * a pipe, a socket or a test double, which is what keeps `node:child_process` out of this file.
 */
export interface PiRpcLink {
  /** Send one command and resolve with pi's `response` frame for it. Rejects if it cannot be sent. */
  request(command: Record<string, unknown>): Promise<PiRpcResponse>;
  /** Every line pi writes. Returns the unsubscribe. */
  subscribe(listener: (message: PiRpcMessage) => void): () => void;
  readonly closed: boolean;
}

export type PiBlockerCode = 'pi-not-addressable' | 'pi-session-closed' | 'pi-refused' | 'pi-steer-parked';

/** Why no event can reach pi right now. Always recoverable: nothing is lost while it holds. */
export interface PiBlocker {
  readonly code: PiBlockerCode;
  readonly recoverable: true;
  readonly message: string;
  readonly fix: string;
}

export class PiDeliveryBlocked extends Error {
  readonly blocker: PiBlocker;

  constructor(code: PiBlockerCode, message: string, fix: string) {
    super(message);
    this.name = 'PiDeliveryBlocked';
    this.blocker = { code, recoverable: true, message, fix };
  }
}

/** Where a project's leader events go in pi: a live RPC link, or a stated blocker. Never neither. */
export type PiReactionTarget =
  | { readonly kind: 'rpc'; readonly adapter: PiReactionAdapter }
  | { readonly kind: 'blocked'; readonly blocker: PiBlocker };

export interface PiReactionAdapterOptions {
  /** The pi RPC session this adapter speaks to. The caller owns it; this adapter never opens one. */
  link: PiRpcLink;
  /** The bound project. A dispatch for any other project is refused, never delivered. */
  projectId: string;
  /** xezar's role instruction, carried in every submission (§ 12: the leader cannot edit it). */
  roleInstruction: string;
  /** The reaction half of F-20: called once a model request really carried rows up to `journalSeq`. */
  onReaction?: (journalSeq: number) => void;
  /** The F-13 echo guard (D-05 § 6.3): true for an operation this leader has outstanding. */
  isOwnOperation?: (operationId: string) => boolean;
}

/** What `status()` says: the route in use, or the blocker holding delivery. For the cockpit. */
export interface PiAdapterStatus {
  readonly route: 'rpc-prompt' | 'blocked';
  readonly blocker?: PiBlocker;
  readonly submittedRows: number;
  readonly turnsAwaited: number;
}

/** pi's refusal of a plain `prompt` during a turn, as 0.85.1 words it. Matched loosely on purpose. */
const BUSY_REFUSAL = /already processing/i;

/** How many of this adapter's own markers are kept, so a long-lived link cannot grow without bound. */
const MARKER_MEMORY = MCP_JOURNAL_RETAINED_ROWS;

export class PiReactionAdapter implements ReactionAdapter {
  readonly projectId: string;
  readonly #opts: PiReactionAdapterOptions;
  readonly #unsubscribe: () => void;
  /** Rows already handed to the model through this session, insertion-ordered, bounded by B-19. */
  readonly #submitted = new Map<string, true>();
  /** Submissions pi accepted whose model request has not been seen yet: marker → highest journalSeq. */
  readonly #awaiting = new Map<string, number>();
  /** Markers seen in the conversation before the request that sent them was answered. */
  readonly #seenMarkers = new Set<string>();
  /** Keeps this adapter's markers apart from an earlier adapter's on the same resumed session. */
  readonly #tag: string;
  /** pi is inside a turn: set by `agent_start`, cleared by `agent_settled` (measured, `rpc-probe`). */
  #busy = false;
  /** The last attempt may have reached pi without us seeing the answer. */
  #uncertain = false;
  #conversationRead = false;
  #blocker: PiBlocker | undefined;
  #sequence = 0;
  #closed = false;

  constructor(opts: PiReactionAdapterOptions) {
    this.#opts = opts;
    this.projectId = opts.projectId;
    // Not `randomUUID`: a counter plus the wall clock is enough to separate two adapters on one
    // resumed pi session, and it keeps this file free of a `node:` import (the test asserts that).
    this.#tag = `${Date.now().toString(36)}${(++adapterOrdinal).toString(36)}`;
    this.#unsubscribe = opts.link.subscribe((message) => this.#observe(message));
  }

  status(): PiAdapterStatus {
    return {
      route: this.#blocker ? 'blocked' : 'rpc-prompt',
      ...(this.#blocker ? { blocker: this.#blocker } : {}),
      submittedRows: this.#submitted.size,
      turnsAwaited: this.#awaiting.size,
    };
  }

  async deliver(dispatch: EventDispatch, signal: AbortSignal): Promise<{ handedThrough: number | null }> {
    if (dispatch.projectId !== this.projectId) {
      throw new Error(`pi adapter for project ${this.projectId} refused a dispatch for another project`);
    }
    this.#requireLink();
    let rows = this.#fresh(dispatch.events);
    if (rows.length === 0 && dispatch.recovery === undefined) return { handedThrough: null };

    // What pi has already been told, from its own conversation — on the first delivery, and after an
    // attempt whose answer we lost, because that attempt may well have been accepted.
    if (!this.#conversationRead || this.#uncertain) {
      await this.#readConversation(signal);
      rows = this.#fresh(dispatch.events);
      if (rows.length === 0 && dispatch.recovery === undefined) return { handedThrough: null };
    }

    const marker = `${MARKER_PREFIX}${this.projectId}:${this.#tag}:${++this.#sequence}`;
    const toSeq = rows.at(-1)?.journalSeq ?? null;
    const message = renderPiDispatch(dispatch, rows, this.#opts.roleInstruction, marker);
    // Registered BEFORE the write: pi may emit the user message carrying the marker before the
    // command's own `response` reaches us, and a reaction seen then must not be dropped.
    if (toSeq !== null) this.#awaiting.set(marker, toSeq);
    this.#uncertain = true;
    try {
      await this.#submit(message, signal);
    } catch (err) {
      // Deliberately NOT cleared here: an attempt that threw may still have reached pi, so the next
      // one must read the conversation before it decides. Only an accepted submission is certain.
      this.#awaiting.delete(marker);
      throw err;
    }
    this.#uncertain = false;
    for (const row of rows) this.#remember(rowKey(row));
    // A marker pi had already put into the conversation before its `response` arrived is a reaction
    // nobody has reported yet; report it now rather than waiting for an event that has been and gone.
    if (this.#seenMarkers.delete(marker)) this.#reacted(marker);
    return { handedThrough: toSeq };
  }

  /** Non-model liveness (N-06): pi's own session metadata. Starts no turn and reaches no model. */
  async heartbeat(signal: AbortSignal): Promise<void> {
    this.#requireLink();
    const state = await this.#command({ type: 'get_state' }, signal);
    if (state.success !== true) throw this.#block('pi-refused', `pi refused xezar's liveness check: ${errorText(state)}`);
    // pi's own answer is more trustworthy than the events we inferred `busy` from, and this is the
    // one call that asks. A link that dropped an `agent_settled` would otherwise steer for ever.
    if (typeof state.data?.isStreaming === 'boolean') this.#busy = state.data.isStreaming;
  }

  /** Stop listening. The pi process and its session belong to whoever opened the link. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
  }

  // ---- internals -----------------------------------------------------------------------------

  /**
   * One submission, by the rung that pi accepts right now: `prompt` while idle, `steer` during a
   * turn. `#busy` is inferred from an event stream that can lag or lose a frame, so BOTH directions
   * of a wrong belief have to be safe. They were not (QA on #358, finding 2):
   *
   *  - Believed idle, really busy: pi refuses the plain `prompt` and the fallback steers. SAFE, and
   *    the refusal fallback stays because pi can start a turn of its own between check and write.
   *  - Believed busy, really idle: a `steer` is ACCEPTED and PARKED. Measured against real pi 0.85.1
   *    (`pi-idle-steer`): `success: true`, no `agent_start`, ZERO model requests, one `queue_update`,
   *    `pendingMessageCount` 0 -> 1 — and the text reaches the model only when the PERSON starts a
   *    turn of their own. `success` is acceptance, never hand-over, and reporting it as delivered is
   *    exactly the outcome A-19 exists to prevent: the leader does not react until a human pokes it.
   *
   * So a believed `busy` is CONFIRMED against pi before steering, and a steer is confirmed after the
   * fact as well, because pi can settle between the two. A parked row is reported as not handed over
   * (the controller retries it, down the `prompt` rung, after re-reading pi's conversation).
   */
  async #submit(message: string, signal: AbortSignal): Promise<void> {
    if (this.#busy) this.#busy = await this.#reallyBusy(signal);
    if (!this.#busy) {
      const answer = await this.#command({ type: 'prompt', message }, signal);
      if (answer.success === true) return;
      const text = errorText(answer);
      if (!BUSY_REFUSAL.test(text)) throw this.#block('pi-refused', `pi refused the event submission: ${text}`);
      this.#busy = true;
    }
    const steered = await this.#command({ type: 'steer', message }, signal);
    if (steered.success !== true) throw this.#block('pi-refused', `pi refused the steered event submission: ${errorText(steered)}`);
    await this.#requireSteerLanded(signal);
  }

  /**
   * Is a turn really running? Read from pi rather than from the event stream.
   *
   * An unreadable answer deliberately says NO, which sends the caller down the `prompt` rung: a
   * prompt into a busy pi is refused and recovers on the spot, while a steer into an idle pi parks
   * in silence. When the two failure modes are not symmetric, guess towards the recoverable one.
   */
  async #reallyBusy(signal: AbortSignal): Promise<boolean> {
    const state = await this.#command({ type: 'get_state' }, signal);
    if (state.success !== true) return false;
    const streaming = state.data?.isStreaming;
    return typeof streaming === 'boolean' ? streaming : false;
  }

  /**
   * A steer pi accepted is only handed over if a turn actually took it. pi delivers steering at the
   * end of the running turn, so "pi is idle now" alone does not mean it parked — the turn may simply
   * have finished WITH it. `pendingMessageCount` is the unambiguous half: still queued AND nothing
   * running means only the person can unpark it, which is not delivery.
   */
  async #requireSteerLanded(signal: AbortSignal): Promise<void> {
    const state = await this.#command({ type: 'get_state' }, signal);
    if (state.success !== true) return;
    const streaming = state.data?.isStreaming;
    const pending = state.data?.pendingMessageCount;
    if (typeof streaming !== 'boolean' || typeof pending !== 'number') return;
    if (streaming) return;
    this.#busy = false;
    if (pending > 0) throw this.#block('pi-steer-parked', PARKED_MESSAGE);
  }

  /**
   * Learn which rows this pi session has already been given, from its own conversation. Also reports
   * a reaction that happened for a submission whose answer we lost, so it is not lost with it.
   */
  async #readConversation(signal: AbortSignal): Promise<void> {
    const answer = await this.#command({ type: 'get_messages' }, signal);
    if (answer.success !== true) throw this.#block('pi-refused', `pi refused to list its conversation: ${errorText(answer)}`);
    const messages = Array.isArray(answer.data?.messages) ? (answer.data.messages as unknown[]) : [];
    for (const message of messages) {
      const text = userMessageText(message);
      if (text === undefined) continue;
      for (const key of rowKeysIn(text)) this.#remember(key);
      const marker = markerIn(text);
      if (marker !== undefined) this.#reacted(marker);
    }
    this.#conversationRead = true;
  }

  async #command(command: Record<string, unknown>, signal: AbortSignal): Promise<PiRpcResponse> {
    this.#requireLink();
    try {
      return await abortable(this.#opts.link.request(command), signal);
    } catch (err) {
      if (signal.aborted || this.#closed) throw err;
      if (this.#opts.link.closed) throw this.#block('pi-session-closed', CLOSED_MESSAGE);
      throw err;
    }
  }

  #requireLink(): void {
    if (this.#closed || this.#opts.link.closed) throw this.#block('pi-session-closed', CLOSED_MESSAGE);
    if (this.#blocker?.code === 'pi-session-closed') this.#blocker = undefined;
  }

  #block(code: PiBlockerCode, message: string, fix = BLOCKER_FIX): PiDeliveryBlocked {
    const error = new PiDeliveryBlocked(code, message, fix);
    this.#blocker = error.blocker;
    return error;
  }

  /** Rows not yet submitted, minus the leader's own echo (drop only `leader` + own `causedBy`). */
  #fresh(events: readonly McpJournalRow[]): McpJournalRow[] {
    const isOwn = this.#opts.isOwnOperation ?? (() => false);
    return events.filter(
      (row) => !this.#submitted.has(rowKey(row)) && !(row.origin === 'leader' && row.causedBy !== null && isOwn(row.causedBy)),
    );
  }

  #remember(key: string): void {
    this.#submitted.set(key, true);
    // A row older than retention can never be re-dispatched, so neither can its key matter.
    if (this.#submitted.size > MARKER_MEMORY) this.#submitted.delete(this.#submitted.keys().next().value!);
  }

  /**
   * pi's stream, as far as this adapter reads it. `agent_start` / `agent_settled` are the busy
   * boundary; a `user` message carrying one of our markers is the reaction — pi emits it immediately
   * before the model request that carries it, and never while the text is still queued (`rpc-probe`).
   */
  #observe(message: PiRpcMessage): void {
    const type = typeof message.type === 'string' ? message.type : undefined;
    if (type === 'agent_start') {
      this.#busy = true;
      return;
    }
    if (type === 'agent_settled') {
      this.#busy = false;
      return;
    }
    if (type !== 'message_start' && type !== 'message_end') return;
    const text = userMessageText(message.message);
    if (text === undefined) return;
    const marker = markerIn(text);
    if (marker === undefined) return;
    if (this.#awaiting.has(marker)) this.#reacted(marker);
    else if (marker.startsWith(`${MARKER_PREFIX}${this.projectId}:${this.#tag}:`)) this.#seenMarkers.add(marker);
  }

  #reacted(marker: string): void {
    const seq = this.#awaiting.get(marker);
    if (seq === undefined) return;
    this.#awaiting.delete(marker);
    try {
      this.#opts.onReaction?.(seq);
    } catch {
      /* a reporting failure is `reactedSeq` lagging — never a reason to submit again */
    }
  }
}

/** Separates two adapters' markers on one resumed pi session without reaching for `node:crypto`. */
let adapterOrdinal = 0;

const MARKER_PREFIX = 'xezar-event:';
const CLOSED_MESSAGE = 'The pi RPC session xezar was given is closed, so no event can be handed to it.';
const PARKED_MESSAGE =
  'pi accepted the steered event but settled before a turn took it, so it is parked in pi\'s queue rather than in front of the model. xezar has not treated it as delivered and will hand it over again.';
const BLOCKER_FIX = 'Read events from your leader with the leader_events tool; nothing is lost while push is unavailable.';
const PI_EXTENSION_FIX =
  'Start your pi leader with xezar\'s leader extension (`pi --extension <xezar>/scripts/pi-leader-extension.mjs`, or install it once in your pi settings), then attach again. Until then, read events with the leader_events tool — nothing is lost.';

/**
 * Where a project's leader events go in pi. A live `link`: delivered through it. Absent or closed: a
 * recoverable blocker the cockpit can show, naming WHY there is no link, because since `pi-link.ts`
 * exists that is an answerable question — the leader extension is not running, or the pi that wrote
 * the descriptor is gone — rather than the flat "pi has no address" it used to be. The rows stay in
 * the journal either way, and the leader reads them with `leader_events`.
 */
export function piReactionTarget(
  opts: Omit<PiReactionAdapterOptions, 'link'> & { link?: PiRpcLink; unreachable?: string },
): PiReactionTarget {
  if (opts.link !== undefined && !opts.link.closed) {
    return { kind: 'rpc', adapter: new PiReactionAdapter({ ...opts, link: opts.link }) };
  }
  const because = opts.unreachable === undefined ? '' : ` (${opts.unreachable})`;
  return {
    kind: 'blocked',
    blocker: {
      code: 'pi-not-addressable',
      recoverable: true,
      message: `xezar has no live link to a pi leader for this project${because}. pi speaks RPC over its own stdin and stdout only — it has no port, socket or attach mode — so a pi you run yourself can be reached only from inside it, by the xezar leader extension. Events stay in the project journal and nothing is lost.`,
      fix: PI_EXTENSION_FIX,
    },
  };
}

/**
 * The text a pi leader receives for one dispatch. Pure: the same inputs always render the same text.
 *
 * It names xezar as the source and says what it is not, before any row — an event must never read as
 * the user's instruction or approval (§ 12). The role instruction rides along because pi keeps no
 * system prompt in a resumed session. Each row's summary is quoted as data, so text inside a summary
 * cannot pose as the adapter's own framing; rows are the journal's own summaries, already scrubbed of
 * secrets (F-15), never a payload. The marker line is how a later look at pi's conversation
 * recognises this submission — `<eventId>@<ts>` per row, because `journalSeq` restarts in a recreated
 * journal and the pair does not.
 */
export function renderPiDispatch(
  dispatch: EventDispatch,
  rows: readonly McpJournalRow[],
  roleInstruction: string,
  marker: string,
): string {
  const lines = [
    '[xezar event notification]',
    `Source: xezar, project ${dispatch.projectId}. Sent automatically by xezar. It is not a message from the user, not an instruction and not an approval.`,
    `Your role: ${roleInstruction}`,
  ];
  if (rows.length > 0) {
    lines.push(`Significant events (${rows.length}, oldest first):`);
    for (const row of rows) {
      const subject = `${row.subject.type} ${row.subject.id}${row.subject.version === null ? '' : ` @${row.subject.version}`}`;
      lines.push(`- ${row.eventId} ${row.category} ${row.kind} on ${subject} (origin ${row.origin}): ${JSON.stringify(row.summary)}`);
    }
  }
  if (dispatch.recovery) {
    lines.push(
      `Gap: ${dispatch.recovery.message} (oldest retained ${dispatch.recovery.oldestSeq ?? 'none'}, latest ${dispatch.recovery.latestSeq}).`,
    );
  }
  lines.push('Read the current state with the xezar tools before acting, and acknowledge the events you have taken into account.');
  lines.push(`${marker} rows=${rows.map(rowKey).join(',')}`);
  return lines.join('\n');
}

function rowKey(row: Pick<McpJournalRow, 'eventId' | 'ts'>): string {
  return `${row.eventId}@${row.ts}`;
}

/** The marker this adapter writes into every submission, as found in text pi echoed back. */
function markerIn(text: string): string | undefined {
  return new RegExp(`${MARKER_PREFIX}[^\\s]+`).exec(text)?.[0];
}

/** The row keys a marked submission listed, so a restart learns what pi was already told. */
function rowKeysIn(text: string): string[] {
  const listed = /\brows=([^\s]*)/.exec(text)?.[1];
  return listed === undefined || listed === '' ? [] : listed.split(',').filter((key) => key !== '');
}

/** The text of a `user` message in pi's own shape, or undefined for anything else. */
function userMessageText(value: unknown): string | undefined {
  const message = value as { role?: unknown; content?: unknown } | undefined;
  if (message?.role !== 'user') return undefined;
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const parts = (message.content as { type?: unknown; text?: unknown }[])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function errorText(answer: PiRpcResponse): string {
  const error = answer.error as { message?: unknown } | string | undefined;
  if (typeof error === 'string') return error;
  if (typeof error?.message === 'string') return error.message;
  return 'pi gave no reason';
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
