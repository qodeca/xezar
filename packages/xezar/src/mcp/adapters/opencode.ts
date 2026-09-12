import { resolve } from 'node:path';

import { MCP_JOURNAL_PAGE_ROWS, MCP_JOURNAL_RETAINED_ROWS, type McpJournalRow } from '@qodeca/xezar-contract';

import type { EventDispatch, ReactionAdapter } from '../event-controller.ts';

/**
 * The OpenCode reaction adapter (#110, Phase 6 of #67): the client-specific half the non-model
 * event controller (#107, `event-controller.ts`) hands significant events to. It is a CONTROL
 * adapter, not an `AgentRunner`: it adds no backend, spawns no process, owns no session and writes
 * no file. It speaks to an `opencode serve` instance the user already runs (and may be attached to
 * with `opencode attach <url>`), for ONE named session.
 *
 * WHERE THE EVENTS COME FROM. The controller subscribes to the bound project's xezar journal
 * (`EventJournal.subscribe`, #103) and calls `deliver`. That is the explicit subscription to the
 * xezar feed. OpenCode's own `/event` stream, which this adapter also reads, OBSERVES OPENCODE —
 * session status, permission prompts, the turn that follows a submission — and is never a source of
 * xezar events: no OpenCode frame, whatever its type, ever causes a submission here. The same holds
 * for OpenCode plugins, whose `event` hook receives OpenCode's own stream; the D-01 bridge socket
 * exposes `health` and `tools/call` only, so a plugin has no xezar feed to subscribe to.
 *
 * THE DELIVERY HIERARCHY (requirements § 12), in order and not reorderable — see
 * `OPENCODE_DELIVERY_ROUTES` and `docs/features/mcp-server/mcp-adapter-evidence-opencode.md`:
 *  1. Native mechanism — NOT ADOPTED. MCP notifications reach OpenCode (it re-lists tools on
 *     `list_changed` and emits `mcp.tools.changed`), but none started a model turn, at a busy or an
 *     idle session (D-05 § 4; spike report T07).
 *  2. The official programmatic session interface — ADOPTED: `POST /session/:id/prompt_async`.
 *  3. Terminal text input — REFUSED. OpenCode's server has `/tui/append-prompt` and
 *     `/tui/submit-prompt`, which type into the TUI's prompt box; nothing here calls any `/tui/`
 *     route, and no keystroke is ever simulated.
 *
 * WHAT A SUBMISSION IS. One `prompt_async` per dispatch, whose text says it comes from xezar, is not
 * a user instruction and is not an approval, and whose text part carries `metadata.xezar` naming the
 * exact rows it carries. Delivery (the controller's `deliveredSeq`) is the `204`. Reaction (its
 * `reactedSeq`, reported through `onReaction`) is OpenCode creating the assistant message whose
 * `parentID` is that submission — the turn itself, observed, never inferred from the `204`.
 *
 * SAFETY RULES, each one measured against OpenCode 1.18.30 (evidence record § "Findings"):
 *  - Role instruction on EVERY message. `agent` and `system` apply to the one message they are sent
 *    with: a follow-up without them reached the model with neither, and a restarted server (resume)
 *    behaves the same. Both are re-sent each time. `system` is xezar's text, never read from a
 *    project file the leader can edit (§ 12). Prompt text is still not enforcement.
 *  - Never into an active turn, a pending permission prompt or a pending question. A submission
 *    while the session is busy is queued behind the running turn; one made while a permission
 *    prompt was pending never got a turn of its own — it was folded into the NEXT unrelated prompt.
 *    So the adapter waits, on OpenCode's `/event` stream (not a timer), until the session is idle
 *    and nothing is pending for it, bounded by the controller's attempt signal.
 *  - Never reuse a `messageID`. Re-sending one appended the new text INTO the earlier, already
 *    answered user message and started no turn — a silent history rewrite. OpenCode assigns ids.
 *  - Never two turns for one row. Rows already submitted are skipped: from memory within this
 *    adapter's life, and from the session's own recent history (the `metadata.xezar` marker) on the
 *    first delivery and after any attempt whose answer was lost — so a restart, or a lost `204`,
 *    does not ask the model twice.
 *  - Never a second leader. It targets the one session it was given and refuses to create one. A
 *    missing target, a session that does not exist, one bound to another directory, or a server
 *    with no `prompt_async` route is a RECOVERABLE blocker (`OpenCodeDeliveryBlocked`): the
 *    controller keeps the rows, stays `disconnected`, and retries at its heartbeat.
 *
 * AGENTS.md: OpenCode's home is pinned through `OPENCODE_CONFIG_DIR`, never the machine-wide XDG
 * config variable. This module reads no environment variable and sets none, and imports neither
 * `node:fs` nor `node:child_process` — the test file asserts all three.
 */

/** The § 12 hierarchy for OpenCode, as decided by the runtime evidence. Order is the hierarchy. */
export const OPENCODE_DELIVERY_ROUTES = [
  {
    tier: 1,
    route: 'native-mcp-notification',
    status: 'not-adopted',
    reason: 'delivered but never started a model turn, at a busy or an idle session (D-05 § 4, spike T07)',
  },
  { tier: 2, route: 'prompt_async', status: 'adopted', reason: 'started a model turn carrying the event (evidence record R-01)' },
  {
    tier: 3,
    route: 'terminal-input',
    status: 'refused',
    reason: 'tier 2 works; typing into the TUI prompt (/tui/*) cannot be separated from the user typing',
  },
] as const;

export type OpenCodeBlockerCode = 'no-target' | 'server-unreachable' | 'session-not-found' | 'wrong-project' | 'no-async-route';

/** Why no event can reach OpenCode right now. Always recoverable: nothing is lost while it holds. */
export interface OpenCodeBlocker {
  readonly code: OpenCodeBlockerCode;
  readonly recoverable: true;
  readonly message: string;
}

export class OpenCodeDeliveryBlocked extends Error {
  readonly blocker: OpenCodeBlocker;

  constructor(code: OpenCodeBlockerCode, message: string) {
    super(message);
    this.name = 'OpenCodeDeliveryBlocked';
    this.blocker = { code, recoverable: true, message };
  }
}

/** The one OpenCode session the leader runs in, on the server that hosts it. */
export interface OpenCodeTarget {
  /** `http://127.0.0.1:<port>` of `opencode serve` (the URL `opencode attach` takes). */
  baseUrl: string;
  /** The existing session (`ses_…`). Never created here. */
  sessionId: string;
}

export interface OpenCodeAdapterOptions {
  /** Absent: no OpenCode session is known yet — every delivery is the `no-target` blocker. */
  target?: OpenCodeTarget;
  /** The bound project's root, from the trusted binding. The session must live in it. */
  projectRoot: string;
  /** xezar's role instruction, sent as `system` with every message (§ 12: the leader cannot edit it). */
  roleInstruction: string;
  /** An OpenCode agent the user configured for the leader; re-sent with every message when set. */
  agent?: string;
  /** The reaction half of F-20: called once a turn carrying rows up to `journalSeq` started. */
  onReaction?: (journalSeq: number) => void;
  /** The F-13 echo guard (D-05 § 6.3): true for an operation this leader has outstanding. */
  isOwnOperation?: (operationId: string) => boolean;
  /** Test seam. Production uses the global `fetch`. */
  fetch?: typeof fetch;
}

/** One frame of OpenCode's `/event` stream, as far as this adapter reads it. */
interface OpenCodeFrame {
  type: string;
  properties?: Record<string, unknown>;
}

/** How a submission marks itself, so a later look at the history can recognise it. */
interface XezarMarker {
  source: 'xezar';
  projectId: string;
  /** `<eventId>@<ts>` per row: `journalSeq` restarts in a recreated journal, the pair does not. */
  rows: string[];
  toSeq: number | null;
}

/**
 * The tools a submission's turn may use: only the `xezar` MCP server's (#309 F-1). Without it the
 * turn ran with whatever the user's OpenCode config allows — `bash` and `edit` included — so an event
 * could make the model run a command in the checkout that nobody typed. Measured on OpenCode 1.18.30
 * against a scripted model: with this map the model is offered `xezar_*` only, and a forced `bash`
 * call is refused ("Model tried to call unavailable tool 'bash'"). KEY ORDER MATTERS: the last
 * matching rule wins, so `"*"` must come first — reversed, nothing is offered at all. A wildcard,
 * not a list of names, so a built-in tool added later is refused too.
 *
 * On the record, because it is not per-message: OpenCode stores the map on the SESSION (as its
 * `permission` rules) and keeps it for later messages, a server restart included, and no route
 * examined removes it. The session attached as the leader therefore stays xezar-tools-only, the
 * user's own messages in it included; other sessions are untouched. `true` also pre-approves the
 * xezar tools where the user's config said `ask` — the same stance as the Claude Code leader's
 * `--allowedTools mcp__xezar`. Never send `"*": true`: it would override every `ask` the user set.
 */
export const OPENCODE_LEADER_TOOLS: Readonly<Record<string, boolean>> = Object.freeze({ '*': false, 'xezar_*': true });

/** Frames kept for a waiter that registers after its frame arrived. */
const FRAME_BUFFER = 256;

export class OpenCodeReactionAdapter implements ReactionAdapter {
  readonly #opts: OpenCodeAdapterOptions;
  readonly #fetch: typeof fetch;
  readonly #closed = new AbortController();
  /** Rows already handed to the model through this session, insertion-ordered, bounded by B-19. */
  readonly #submitted = new Map<string, true>();
  /** Submissions whose turn has not been seen yet: marker key → highest `journalSeq` they carry. */
  readonly #pending = new Map<string, number>();
  /** User message id → the `journalSeq` its turn reports. */
  readonly #awaitingTurn = new Map<string, number>();
  #historyRead = false;
  /** The last attempt may have reached OpenCode without us seeing the answer. */
  #uncertain = false;
  #blocker: OpenCodeBlocker | undefined;
  #directory: string | undefined;
  #feed: Promise<void> | undefined;
  #feedAbort: AbortController | undefined;
  #frameSeq = 0;
  readonly #frames: { seq: number; frame: OpenCodeFrame }[] = [];
  readonly #waiters = new Set<() => void>();

  constructor(opts: OpenCodeAdapterOptions) {
    this.#opts = opts;
    this.#fetch = opts.fetch ?? fetch;
    if (!opts.target) {
      this.#blocker = new OpenCodeDeliveryBlocked(
        'no-target',
        'No OpenCode session is known for this project. Run `opencode serve` in the project, open the leader session there (or `opencode attach <url>`), and give xezar its URL and session id.',
      ).blocker;
    }
  }

  /** The route in use, or the recoverable blocker that holds delivery — for the cockpit and the record. */
  status(): { route: 'prompt_async' | 'blocked'; blocker?: OpenCodeBlocker; submittedRows: number; turnsAwaited: number } {
    return {
      route: this.#blocker ? 'blocked' : 'prompt_async',
      ...(this.#blocker ? { blocker: this.#blocker } : {}),
      submittedRows: this.#submitted.size,
      turnsAwaited: this.#pending.size + this.#awaitingTurn.size,
    };
  }

  async deliver(dispatch: EventDispatch, signal: AbortSignal): Promise<void> {
    const target = this.#requireTarget();
    let rows = this.#fresh(dispatch.events);
    if (rows.length === 0 && dispatch.recovery === undefined) return;

    await this.#openFeed(signal);
    await this.#checkSession(target, signal);
    if (!this.#historyRead || this.#uncertain) {
      await this.#readHistory(target, signal);
      rows = this.#fresh(dispatch.events);
      if (rows.length === 0 && dispatch.recovery === undefined) return;
    }
    await this.#waitUntilSafe(target, signal);

    const marker: XezarMarker = {
      source: 'xezar',
      projectId: dispatch.projectId,
      rows: rows.map(rowKey),
      toSeq: rows.at(-1)?.journalSeq ?? null,
    };
    const body = {
      ...(this.#opts.agent === undefined ? {} : { agent: this.#opts.agent }),
      system: this.#opts.roleInstruction,
      // Only the xezar tools, on every submission (#309 F-1); `"*"` first — see OPENCODE_LEADER_TOOLS.
      tools: OPENCODE_LEADER_TOOLS,
      parts: [{ type: 'text', text: renderDispatch(dispatch, rows), metadata: { xezar: marker } }],
    };
    // Both set BEFORE the request. OpenCode may emit the submission's frames before its `204`
    // arrives, so the turn watcher must already know the marker; and a lost answer makes the next
    // attempt read the history first instead of submitting the same rows a second time.
    const key = markerKey(marker);
    if (marker.toSeq !== null) this.#pending.set(key, marker.toSeq);
    this.#uncertain = true;
    const res = await this.#call(target, 'POST', `/session/${encodeURIComponent(target.sessionId)}/prompt_async`, signal, body);
    this.#uncertain = false;
    await res.body?.cancel().catch(() => {});
    if (res.status === 204) {
      for (const row of marker.rows) this.#remember(row);
      return;
    }
    this.#pending.delete(key);
    if (res.status === 404) throw this.#block('session-not-found', `OpenCode has no session ${target.sessionId} any more. Open the leader session again and give xezar its id.`);
    if (res.status === 200) {
      // An OpenCode too old for this route serves its web UI there instead of a 404.
      throw this.#block('no-async-route', 'This OpenCode server has no prompt_async route. Update OpenCode; xezar never types into the terminal instead.');
    }
    throw new Error(`OpenCode refused the event submission (HTTP ${res.status})`);
  }

  /** Non-model liveness: the session still exists on a reachable server. Starts no turn. */
  async heartbeat(signal: AbortSignal): Promise<void> {
    const target = this.#requireTarget();
    await this.#checkSession(target, signal);
  }

  /** Stop reading OpenCode's stream. Changes nothing in OpenCode. */
  close(): void {
    this.#closed.abort();
    this.#feedAbort?.abort();
    for (const wake of this.#waiters) wake();
  }

  #requireTarget(): OpenCodeTarget {
    const target = this.#opts.target;
    if (!target || this.#blocker?.code === 'no-target') throw new OpenCodeDeliveryBlocked('no-target', this.#blocker!.message);
    return target;
  }

  #block(code: OpenCodeBlockerCode, message: string): OpenCodeDeliveryBlocked {
    const error = new OpenCodeDeliveryBlocked(code, message);
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
    if (this.#submitted.size > MCP_JOURNAL_RETAINED_ROWS) this.#submitted.delete(this.#submitted.keys().next().value!);
  }

  /** Targeting (§ 12): the named session exists and belongs to the bound project. */
  async #checkSession(target: OpenCodeTarget, signal: AbortSignal): Promise<void> {
    const res = await this.#call(target, 'GET', `/session/${encodeURIComponent(target.sessionId)}`, signal);
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      throw this.#block('session-not-found', `OpenCode has no session ${target.sessionId}. Open the leader session again and give xezar its id.`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`OpenCode answered HTTP ${res.status} for the leader session`);
    }
    const session = (await res.json().catch(() => undefined)) as { directory?: unknown } | undefined;
    const directory = typeof session?.directory === 'string' ? session.directory : undefined;
    if (directory === undefined || samePath(directory, this.#opts.projectRoot) === false) {
      throw this.#block(
        'wrong-project',
        `OpenCode session ${target.sessionId} belongs to another directory, not this project. Give xezar a session opened in this project.`,
      );
    }
    this.#directory = directory;
    if (this.#blocker && this.#blocker.code !== 'no-target') this.#blocker = undefined;
  }

  /**
   * Learn which rows this session has already been given, from its own recent history — bounded to
   * one B-02 page of messages. Also reports a turn that already happened for a submission whose
   * answer we lost, so the reaction is not lost with it.
   */
  async #readHistory(target: OpenCodeTarget, signal: AbortSignal): Promise<void> {
    const res = await this.#call(target, 'GET', `/session/${encodeURIComponent(target.sessionId)}/message?limit=${MCP_JOURNAL_PAGE_ROWS}`, signal);
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`OpenCode answered HTTP ${res.status} for the session history`);
    }
    const messages = (await res.json().catch(() => [])) as unknown;
    if (!Array.isArray(messages)) throw new Error('OpenCode returned an unreadable session history');
    const ours = new Map<string, number | null>();
    const parents = new Set<string>();
    for (const message of messages as { info?: { id?: unknown; role?: unknown; parentID?: unknown }; parts?: unknown }[]) {
      const info = message.info;
      if (info?.role === 'assistant' && typeof info.parentID === 'string') parents.add(info.parentID);
      if (info?.role !== 'user' || typeof info.id !== 'string' || !Array.isArray(message.parts)) continue;
      for (const part of message.parts as { metadata?: { xezar?: unknown } }[]) {
        const marker = asMarker(part?.metadata?.xezar);
        if (!marker) continue;
        for (const key of marker.rows) this.#remember(key);
        ours.set(info.id, marker.toSeq);
      }
    }
    for (const [messageId, toSeq] of ours) {
      if (toSeq !== null && parents.has(messageId)) this.#reacted(toSeq);
    }
    this.#historyRead = true;
  }

  /** Wait until the session is idle with no permission prompt or question pending for it. */
  async #waitUntilSafe(target: OpenCodeTarget, signal: AbortSignal): Promise<void> {
    for (;;) {
      // A dropped stream is reopened before waiting on it, so a wait never degrades into a re-check loop.
      await this.#openFeed(signal);
      const mark = this.#frameSeq;
      if (await this.#safeNow(target, signal)) return;
      await this.#nextFrame(mark, (frame) => SETTLING_FRAMES.has(frame.type) && frameSession(frame) === target.sessionId, signal);
    }
  }

  async #safeNow(target: OpenCodeTarget, signal: AbortSignal): Promise<boolean> {
    const [status, permissions, questions] = await Promise.all([
      this.#json(target, '/session/status', signal),
      this.#json(target, '/permission', signal),
      this.#json(target, '/question', signal),
    ]);
    const own = (status as Record<string, { type?: unknown }> | undefined)?.[target.sessionId];
    if (own !== undefined && own.type !== 'idle') return false;
    const pendingFor = (list: unknown) => Array.isArray(list) && list.some((req: { sessionID?: unknown }) => req?.sessionID === target.sessionId);
    return !pendingFor(permissions) && !pendingFor(questions);
  }

  async #json(target: OpenCodeTarget, path: string, signal: AbortSignal): Promise<unknown> {
    const res = await this.#call(target, 'GET', path, signal);
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`OpenCode answered HTTP ${res.status} for ${path}`);
    }
    return res.json();
  }

  async #call(target: OpenCodeTarget, method: 'GET' | 'POST', path: string, signal: AbortSignal, body?: unknown): Promise<Response> {
    const url = new URL(path, target.baseUrl);
    if (this.#directory !== undefined) url.searchParams.set('directory', this.#directory);
    try {
      return await this.#fetch(url, {
        method,
        signal: AbortSignal.any([signal, this.#closed.signal]),
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
    } catch (err) {
      if (signal.aborted || this.#closed.signal.aborted) throw err;
      throw this.#block('server-unreachable', `The OpenCode server at ${target.baseUrl} is not reachable. Start \`opencode serve\` again; xezar retries on its own.`);
    }
  }

  /**
   * Open OpenCode's `/event` stream once and keep it; resolves when it is LIVE (headers in), so no
   * frame emitted after a check can be missed. The stream belongs to the adapter, not to one
   * delivery attempt: only `close` (or the server) ends it. `signal` bounds the wait to open it.
   */
  async #openFeed(signal: AbortSignal): Promise<void> {
    if (this.#feed) return this.#feed;
    const target = this.#requireTarget();
    const abort = new AbortController();
    this.#feedAbort = abort;
    const opened = (async () => {
      const res = await this.#call(target, 'GET', '/event', abort.signal);
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`OpenCode answered HTTP ${res.status} for its event stream`);
      }
      void this.#readFeed(res.body.getReader(), abort);
    })();
    this.#feed = opened;
    const gaveUp = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    gaveUp.catch(() => {});
    try {
      await Promise.race([opened, gaveUp]);
    } catch (err) {
      if (this.#feed === opened) {
        this.#feed = undefined;
        abort.abort();
      }
      throw err;
    }
  }

  async #readFeed(reader: ReadableStreamDefaultReader<Uint8Array>, abort: AbortController): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data) this.#onFrame(data);
        }
      }
    } catch {
      /* aborted or dropped: the next delivery opens a fresh stream */
    } finally {
      if (this.#feedAbort === abort) {
        this.#feed = undefined;
        this.#feedAbort = undefined;
      }
      for (const wake of this.#waiters) wake();
    }
  }

  #onFrame(data: string): void {
    let frame: OpenCodeFrame;
    try {
      frame = JSON.parse(data) as OpenCodeFrame;
    } catch {
      return;
    }
    if (typeof frame?.type !== 'string') return;
    this.#observeTurn(frame);
    this.#frames.push({ seq: ++this.#frameSeq, frame });
    if (this.#frames.length > FRAME_BUFFER) this.#frames.shift();
    for (const wake of this.#waiters) wake();
  }

  /** The reaction half: our submission's user message, then the assistant message answering it. */
  #observeTurn(frame: OpenCodeFrame): void {
    const target = this.#opts.target;
    if (!target) return;
    const props = frame.properties ?? {};
    if (frame.type === 'message.part.updated') {
      const part = props.part as { sessionID?: unknown; messageID?: unknown; metadata?: { xezar?: unknown } } | undefined;
      const marker = asMarker(part?.metadata?.xezar);
      if (!marker || part?.sessionID !== target.sessionId || typeof part.messageID !== 'string') return;
      const toSeq = this.#pending.get(markerKey(marker));
      if (toSeq === undefined) return;
      this.#pending.delete(markerKey(marker));
      this.#awaitingTurn.set(part.messageID, toSeq);
      return;
    }
    if (frame.type === 'message.updated') {
      const info = props.info as { sessionID?: unknown; role?: unknown; parentID?: unknown } | undefined;
      if (info?.sessionID !== target.sessionId || info.role !== 'assistant' || typeof info.parentID !== 'string') return;
      const toSeq = this.#awaitingTurn.get(info.parentID);
      if (toSeq === undefined) return;
      this.#awaitingTurn.delete(info.parentID);
      this.#reacted(toSeq);
    }
  }

  #reacted(journalSeq: number): void {
    try {
      this.#opts.onReaction?.(journalSeq);
    } catch {
      /* a reporting failure is `reactedSeq` lagging — never a reason to submit again */
    }
  }

  /** Resolve on the first frame after `mark` that matches, on a dropped stream, or reject on abort. */
  #nextFrame(mark: number, match: (frame: OpenCodeFrame) => boolean, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (signal.aborted || this.#closed.signal.aborted) {
          done();
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        if (this.#feed === undefined || this.#frames.some((f) => f.seq > mark && match(f.frame))) {
          done();
          resolve();
        }
      };
      const done = (): void => {
        this.#waiters.delete(check);
        signal.removeEventListener('abort', check);
      };
      this.#waiters.add(check);
      signal.addEventListener('abort', check, { once: true });
      check();
    });
  }
}

/** OpenCode frames after which the session may have become safe to submit to. */
const SETTLING_FRAMES: ReadonlySet<string> = new Set([
  'session.idle',
  'session.status',
  'permission.replied',
  'question.replied',
  'question.rejected',
]);

function frameSession(frame: OpenCodeFrame): unknown {
  return frame.properties?.sessionID;
}

function rowKey(row: Pick<McpJournalRow, 'eventId' | 'ts'>): string {
  return `${row.eventId}@${row.ts}`;
}

function markerKey(marker: XezarMarker): string {
  return marker.rows.join('|') || `recovery@${marker.toSeq ?? ''}`;
}

function asMarker(value: unknown): XezarMarker | undefined {
  const marker = value as Partial<XezarMarker> | undefined;
  if (marker?.source !== 'xezar' || !Array.isArray(marker.rows) || !marker.rows.every((r) => typeof r === 'string')) return undefined;
  const toSeq = typeof marker.toSeq === 'number' ? marker.toSeq : null;
  return { source: 'xezar', projectId: String(marker.projectId ?? ''), rows: marker.rows, toSeq };
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/**
 * The text the model sees. It names xezar as the source and says what it is not, before any row —
 * an event must never read as the user's instruction or approval (§ 12). Rows are the journal's
 * own summaries (already scrubbed of secrets by the journal, F-15), never a payload.
 */
export function renderDispatch(dispatch: EventDispatch, rows: readonly McpJournalRow[]): string {
  const lines = [
    '[xezar event notification]',
    `Source: xezar, project ${dispatch.projectId}. Sent automatically by xezar. It is not a message from the user, not an instruction and not an approval.`,
  ];
  if (rows.length > 0) {
    lines.push(`Significant events (${rows.length}, oldest first):`);
    for (const row of rows) {
      lines.push(`- ${row.eventId} ${row.category} ${row.kind} ${row.subject.type} ${row.subject.id} (origin ${row.origin}): ${row.summary}`);
    }
  }
  if (dispatch.recovery) {
    lines.push(
      `Gap: ${dispatch.recovery.message} (oldest retained ${dispatch.recovery.oldestSeq ?? 'none'}, latest ${dispatch.recovery.latestSeq}).`,
    );
  }
  lines.push('Read the current state with the xezar tools before acting, and acknowledge the events you have taken into account.');
  return lines.join('\n');
}
