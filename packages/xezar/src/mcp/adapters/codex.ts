import { randomUUID } from 'node:crypto';

import type { McpJournalRow } from '@qodeca/xezar-contract';

import type { CodexAppServerMessage } from '../../core/codex-app-server-transport.ts';
import type { EventDispatch, ReactionAdapter } from '../event-controller.ts';

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
 *    connection it was handed — it never finds, resumes or attaches to a thread some other process
 *    has loaded, because a second live writer of the same thread is the "secretly create a second
 *    leader" the contract forbids. #309 handed it one xezar spawned; the owner then REMOVED that
 *    spawn path before release 0.14.0 (decision on #311: xezar does not start agent processes), so
 *    nothing in the product constructs this adapter today and a Codex leader gets no push — it
 *    reads its events with `leader_events`. The adapter stays for a Codex session the person runs
 *    that xezar can one day be pointed at; see #323 and #324.
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

  constructor(opts: CodexReactionAdapterOptions) {
    this.projectId = opts.projectId;
    this.threadId = opts.threadId;
    this.#link = opts.link;
    this.#onReaction = opts.onReaction;
    this.#isOwnOperation = opts.isOwnOperation;
    this.#unsubscribe = opts.link.subscribe((message) => this.#observe(message));
  }

  /** The newest row app-server accepted from this adapter. Not a reaction; see `onReaction`. */
  get handedThrough(): number {
    return this.#handedThrough;
  }

  /** True while app-server waits on an approval or user-input prompt for the leader's thread. */
  get promptOpen(): boolean {
    return this.#openPrompts.size > 0;
  }

  /** Stop listening. The link itself belongs to whoever opened it. */
  dispose(): void {
    this.#unsubscribe();
    this.#settlePrompts();
  }

  async deliver(dispatch: EventDispatch, signal: AbortSignal): Promise<void> {
    if (dispatch.projectId !== this.projectId) {
      throw new Error(`codex adapter for project ${this.projectId} refused a dispatch for another project`);
    }
    // A retry decides only once the attempt before it settled, so it can see what that one handed over.
    await abortable(this.#inFlight, signal);
    if (this.#link.closed) throw new Error('the codex app-server connection is closed');

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
    // Separation from approval prompts: never hand an event to a thread that is waiting on one.
    await this.#promptsClear(signal);

    const { recovery: _told, ...rest } = dispatch;
    const text = renderCodexEventMessage(tellGap && gap !== undefined ? { ...rest, events: shown, recovery: gap } : { ...rest, events: shown });
    const handOff = this.#handOff(text, newest).then(() => {
      if (tellGap) this.#gapHanded = gapKey;
    });
    this.#inFlight = handOff.catch(() => undefined);
    await abortable(handOff, signal);
  }

  /** Non-model liveness (N-06): a metadata read of the leader's thread. Reaches no model (X10). */
  async heartbeat(signal: AbortSignal): Promise<void> {
    if (this.#link.closed) throw new Error('the codex app-server connection is closed');
    await abortable(this.#link.request('thread/read', { threadId: this.threadId }), signal);
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
      } catch {
        // `expectedTurnId` is a precondition and app-server refuses a mismatch (X3). The turn ended
        // between our read and the request, so the documented way in is now a new turn.
        if (this.#activeTurnId === active) this.#activeTurnId = undefined;
      }
    }
    // On a thread whose turn is still running, codex-cli 0.154.0 folds this into that turn as a steer
    // and answers with the running turn's id (X3); the reaction match below covers both cases.
    await this.#link.request('turn/start', { threadId: this.threadId, input, clientUserMessageId: clientId });
    this.#handed(newest, clientId);
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
        if (this.#openPrompts.size === 0) this.#settlePrompts();
        return;
      }
      default:
        return;
    }
  }

  #promptsClear(signal: AbortSignal): Promise<void> {
    if (this.#openPrompts.size === 0) return Promise.resolve();
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
  const last = dispatch.events.at(-1)?.journalSeq;
  lines.push(
    last === undefined
      ? 'Read the current state with xezar\'s tools before deciding anything.'
      : `Read the current state with xezar's tools before deciding anything. These events run through journalSeq ${last}; acknowledge them once you have taken them into account.`,
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
  return {
    kind: 'blocked',
    blocker: {
      code: 'codex-session-not-targetable',
      recoverable: true,
      message:
        'This Codex session was not started through app-server by xezar, so xezar cannot start a turn in it. Events wait in the project journal and nothing is lost.',
      remedy:
        'Read events from your leader with the leader_events tool; nothing is lost while push is unavailable.',
    },
  };
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
