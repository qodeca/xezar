import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentRunner,
  AgentToolCallRecord,
  ContentBlock,
} from './agent-runner.ts';
import type { AgentSession, SessionOptions } from './agent-runner.ts';
import { prependSystemPrompt, trackChildExit } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { AUTO_END_DELAY_MS, DEFAULT_RUN_TIMEOUT_MS } from './claude-cli-runner.ts';
import { parseModelIdentity } from './model-identity.ts';
import { V1TextCoalescer } from './v1-text-coalescer.ts';
import {
  createOpencodeUiState,
  mapOpencodeEvent,
  opencodeSessionStarted,
  opencodeTurnStarted,
  type OpencodeUiMapperState,
  type OpencodeUiMapping,
} from './opencode-ui-mapper.ts';

export interface OpencodeRunnerOptions {
  /** Override the binary name/path; defaults to `opencode` on PATH. */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
}

const SERVER_START_TIMEOUT_MS = 30_000;

/** Grace between the teardown SIGTERM and the SIGKILL that follows it. */
export const KILL_GRACE_MS = 4_000;

/**
 * `AgentRunner` over `opencode serve` — a headless HTTP server (the same one
 * the opencode TUI talks to) with an SSE event stream. One server per session,
 * bound to the run's `cwd` (worktree), gives OpenCode the same multi-turn shape
 * as the Claude runner: each `sendMessage` posts another prompt to the same
 * session (history is kept server-side), `session/abort` cancels, and reusing
 * the session id resumes for "Continue".
 *
 * Auth = the host's opencode config/logins. The agent runs autonomously
 * (auto-approved permissions); OpenCode has no per-tool allowlist, so
 * `spec.allowedTools` is ignored. `spec.model` is `provider/model`.
 */
export class OpencodeServerRunner implements AgentRunner {
  readonly backend = 'opencode' as const;

  private readonly bin: string;
  private readonly timeoutMs: number;
  private lastSession: OpencodeSession | null = null;

  constructor(opts: OpencodeRunnerOptions = {}) {
    this.bin = opts.bin ?? process.env.XEZ_OPENCODE_BIN ?? 'opencode';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> {
    this.lastSession?.interrupt();
  }

  startSession(
    spec: AgentRunSpec,
    onEvent?: (event: AgentEvent) => void,
    opts: SessionOptions = {},
  ): AgentSession {
    const session = new OpencodeSession(this.bin, this.timeoutMs, spec, onEvent, opts);
    this.lastSession = session;
    return session;
  }
}

/** One live `opencode serve` process driving a single session. */
class OpencodeSession implements AgentSession {
  readonly result: Promise<AgentRunResult>;

  private readonly child!: ChildProcessWithoutNullStreams;
  /** "Has the server actually terminated?" — never `child.killed`, which only
   *  reports delivery and would disarm the escalation (#844/#858). */
  private readonly hasExited: () => boolean;
  private serverOpen = true;
  private baseUrl: string | undefined;
  private sessionId: string | undefined;
  private ready!: Promise<void>;
  private resolveExit!: () => void;
  private exited!: Promise<void>;
  private readonly sse = new AbortController();
  private readonly toolCalls: AgentToolCallRecord[] = [];
  private readonly textChunks: string[] = [];
  /** Per text-part cursor so only newly-appended text is buffered (deltas). */
  private readonly textSeen = new Map<string, number>();
  /** Streamed part deltas buffered per part — v1 `text` is emitted once per
   *  finished part (claude parity: one event per complete block), never per
   *  delta, so the persisted transcript and the headless CLI get whole
   *  paragraphs. Streaming display rides protocol v2's `item.delta`. */
  private readonly textCoalescer = new V1TextCoalescer((text) => {
    this.textChunks.push(text);
    this.emit({ type: 'text', text });
  });
  private readonly toolsSeen = new Set<string>();
  /** messageID → role. Parts carry no role; only assistant parts are surfaced
   *  (the user's own message also streams as parts over the same SSE feed). */
  private readonly msgRole = new Map<string, string>();
  private tokensUsed = 0;
  private lastCost = 0;
  private turnInFlight = false;
  /** Is the SSE feed connected right now? The asynchronous prompt submission
   *  is only used while it is — `session.idle` on that feed is the only thing
   *  that ends such a turn, so submitting without a feed would be a turn with
   *  no ordinary way to finish. */
  private feedLive = false;
  /** Resolves once the SSE feed is gone. No `session.idle` can arrive after
   *  that, so a turn waiting for one has to stop waiting (#168). */
  private feedEnded!: Promise<void>;
  private resolveFeedEnded!: () => void;
  /** Resolver for the in-flight turn's `session.idle`; armed only while a
   *  prompt that was submitted asynchronously is running. */
  private turnIdle: (() => void) | undefined;
  /** Protocol v2 emission — additive alongside v1 (`onEvent` keeps flowing
   *  byte-identical); the channel is `opts.onUiEvent` (RunManager wiring
   *  lands in R2 step 2.1). v2 has always taken its `turn.completed` from the
   *  wire `session.idle`; since #168 v1's `turn-end` comes from the same event
   *  whenever the prompt was submitted asynchronously, and is still
   *  synthesized from the HTTP response on the blocking fallback. */
  private uiState: OpencodeUiMapperState = createOpencodeUiState();
  private autoEndTimer: NodeJS.Timeout | undefined;
  private spawnFailed: Error | null = null;
  private timedOut = false;
  /** One teardown per session — see `terminate()`. */
  private signalled = false;

  constructor(
    private readonly bin: string,
    timeoutMs: number,
    private readonly spec: AgentRunSpec,
    private readonly onEvent: ((event: AgentEvent) => void) | undefined,
    private readonly opts: SessionOptions,
  ) {
    // Random high port; the actual bound URL is read back from stdout.
    const port = 40000 + Math.floor(Math.random() * 20000);
    try {
      this.child = nodeSpawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: spec.cwd,
        env: buildChildEnv({ backend: 'opencode', extraEnv: spec.env }),
      });
    } catch (err) {
      throw wrapSpawnError(err, bin);
    }
    this.hasExited = trackChildExit(this.child);

    this.child.on('error', (err: NodeJS.ErrnoException) => {
      this.spawnFailed = wrapSpawnError(err, bin);
    });

    this.exited = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    this.feedEnded = new Promise<void>((resolve) => {
      this.resolveFeedEnded = resolve;
    });
    this.child.once('exit', () => this.resolveExit());
    this.child.once('close', () => this.resolveExit());

    const stderrChunks: string[] = [];
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

    // The server prints its URL on stdout once listening.
    const urlReady = this.waitForServerUrl(port);

    const limitMs = spec.timeoutMs ?? timeoutMs;
    let deadline: NodeJS.Timeout | undefined;
    if (limitMs > 0) {
      deadline = setTimeout(() => {
        this.timedOut = true;
        this.interrupt();
      }, limitMs);
      deadline.unref?.();
    }

    this.ready = (async () => {
      this.baseUrl = await urlReady;
      await this.bootstrap();
    })();

    this.result = (async (): Promise<AgentRunResult> => {
      try {
        await this.ready;
        // Live for the whole session; the SSE loop runs until end()/interrupt.
        await this.exited;
      } catch (err) {
        if (!this.timedOut) {
          const message = err instanceof Error ? err.message : String(err);
          this.emit({ type: 'error', message: `opencode: ${message}` });
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        if (this.autoEndTimer) clearTimeout(this.autoEndTimer);
        this.sse.abort();
        this.serverOpen = false;
        this.terminate();
      }

      await this.exited;
      if (this.spawnFailed) throw this.spawnFailed;

      // Timeout/interrupt can cut the SSE feed mid-part — recover buffered prose.
      this.textCoalescer.flush();
      // Chunks are whole blocks now (one per finished part), so newline-join
      // like the other runners, not the old delta concatenation.
      const text = this.textChunks.join('\n').trim();
      const base: AgentRunResult = {
        text,
        toolCalls: this.toolCalls,
        tokensUsed: this.tokensUsed,
        sessionId: this.sessionId ?? spec.sessionId,
      };
      if (this.timedOut) {
        const mins = Math.round((limitMs / 60_000) * 10) / 10;
        this.emit({ type: 'error', message: `opencode timed out after ${mins}m and was killed` });
      }
      this.emit({ type: 'done' });
      return base;
    })();
  }

  get open(): boolean {
    return this.serverOpen;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  sendMessage(content: ContentBlock[]): boolean {
    if (!this.serverOpen) return false;
    if (this.autoEndTimer) {
      clearTimeout(this.autoEndTimer);
      this.autoEndTimer = undefined;
    }
    const text = textOf(content);
    if (!text) return true;
    void this.ready
      .then(() => this.prompt(text))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.emit({ type: 'note', message: `opencode: prompt failed: ${message}` });
      });
    return true;
  }

  end(): void {
    if (!this.serverOpen) return;
    this.serverOpen = false;
    this.sse.abort();
    this.terminate();
  }

  interrupt(): void {
    this.serverOpen = false;
    if (this.baseUrl && this.sessionId) {
      void this.http('POST', `/session/${this.sessionId}/abort`, undefined).catch(() => undefined);
    }
    this.sse.abort();
    this.terminate();
  }

  /**
   * The one place either signal is sent: SIGTERM now, SIGKILL once the grace
   * window elapses.
   *
   * Both steps gate on `hasExited()`, never on `child.killed` — the latter
   * flips the moment SIGTERM is *delivered*, so the old nested
   * `exitCode == null && !killed` guard disarmed the escalation for exactly the
   * server it was written for: one that installs its own SIGTERM handler stayed
   * alive with `killed = true` and `exitCode === null`, outliving the whole
   * window (#858, the same defect #844 fixed for the other two backends). Every
   * caller here is followed by `await this.exited`, so a server that survived
   * SIGTERM did not just leak — it hung the session's result forever.
   *
   * One teardown per session: all three call sites can run for the same session
   * (`interrupt()` on the deadline, then the result promise's `finally`), and
   * once SIGTERM is out with SIGKILL armed there is nothing a second pass adds.
   * The old `!child.killed` test deduplicated this as a side effect of being
   * wrong; `signalled` keeps that property on purpose.
   */
  private terminate(): void {
    if (this.signalled || this.hasExited()) return;
    this.signalled = true;
    this.child.kill('SIGTERM');
    setTimeout(() => {
      if (this.hasExited()) return;
      this.child.kill('SIGKILL');
    }, KILL_GRACE_MS).unref?.();
  }

  // ---- server lifecycle ---------------------------------------------------

  private waitForServerUrl(fallbackPort: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        cleanup();
        // Nothing parsed — try the port we asked for.
        resolve(`http://127.0.0.1:${fallbackPort}`);
      }, SERVER_START_TIMEOUT_MS);
      timer.unref?.();
      const onData = (chunk: string) => {
        buffer += chunk;
        const m = /https?:\/\/[\d.]+:\d+/.exec(buffer);
        if (m) {
          cleanup();
          resolve(m[0]);
        }
      };
      const onExit = () => {
        cleanup();
        reject(new Error('opencode serve exited before it started listening'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.child.stdout.off('data', onData);
        this.child.off('exit', onExit);
      };
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', onData);
      this.child.once('exit', onExit);
    });
  }

  private async bootstrap(): Promise<void> {
    const created = await this.http('POST', '/session', { title: 'xezar task' });
    this.sessionId = stringField(created, 'id');
    if (!this.sessionId) throw new Error('opencode did not return a session id');
    this.emit({ type: 'session', sessionId: this.sessionId });
    const sessionId = this.sessionId;
    this.emitUi((state) => opencodeSessionStarted(sessionId, state));

    // The SSE subscription must be LIVE before the first prompt posts —
    // events the server emits while the POST is in flight would otherwise be
    // lost (a race this await closes; the bundled mock made it visible).
    await this.consumeEvents();

    const first = prependSystemPrompt(this.spec.systemPrompt, this.spec.userPrompt);
    await this.prompt(first);
  }

  private async prompt(text: string): Promise<void> {
    if (!this.sessionId) return;
    this.turnInFlight = true;
    // Turn boundary — the prompt POST is the turn start (§7.1); the end comes
    // from the SSE `session.idle` (see `submitPrompt`), and only falls back to
    // an HTTP response on a server that has no asynchronous submission route.
    this.emitUi(opencodeTurnStarted);
    const body: Record<string, unknown> = { parts: [{ type: 'text', text }] };
    // `spec.model` arrives already normalised to canonical `provider/model`
    // (the run wiring's fail-loud gate). Split it with the shared parser — the
    // one every runner uses — into opencode's `{ providerID, modelID }`.
    const id = parseModelIdentity(this.spec.model);
    if (id) body.model = { providerID: id.provider, modelID: id.model };
    try {
      if (await this.submitPrompt(body)) {
        // Accepted, and nothing is holding a socket open for the length of the
        // turn — so the turn may now run as long as it needs to (#168). It has
        // exactly three ways out and no fourth: the feed's `session.idle`, the
        // feed itself ending, and the server exiting. `end()`, `interrupt()`
        // and the run's wall-clock deadline all abort the feed, so every one of
        // them arrives through the second.
        await Promise.race([this.armTurnIdle(), this.feedEnded, this.exited]);
      } else {
        // No async route on this server (or it refused the submission): the
        // blocking endpoint, exactly as it shipped before — its response is
        // the turn end, and its status/body is the error when it fails.
        const res = await this.http('POST', `/session/${this.sessionId}/message`, body);
        this.absorbUsage(res);
      }
    } finally {
      this.turnIdle = undefined;
      this.turnInFlight = false;
      // A part that never saw `time.end` (abort, server quirk) still surfaces
      // its prose before the turn boundary (run.ts reads markers there).
      this.textCoalescer.flush();
      this.emit({ type: 'turn-end' });
      if (this.opts.autoEndAfterFirstTurn && this.serverOpen && !this.autoEndTimer) {
        this.autoEndTimer = setTimeout(() => this.end(), AUTO_END_DELAY_MS);
        this.autoEndTimer.unref?.();
      }
    }
  }

  /**
   * Hand the prompt to the server WITHOUT waiting for the turn it starts.
   *
   * `POST /session/:id/message` answers only once the whole turn is over, and
   * Node's built-in fetch abandons a request whose response headers have not
   * arrived within 300s. So on that endpoint every turn longer than five
   * minutes died as `fetch failed` while it was still working — run
   * `09623ace` made 21 tool calls, the last of them 1.1s before the wall
   * (#168). `POST /session/:id/prompt_async` takes the same body and answers
   * `204 No Content` as soon as the prompt is accepted (measured against
   * opencode 1.18.30: 204 in ~10ms, the turn then streaming over the SSE feed
   * and ending with `session.idle`), so nothing waits on a socket any more.
   *
   * Returns false when this server has no such route. An opencode too old to
   * have it does NOT answer 404 — it serves its own web UI, `200` with an HTML
   * body — so only an explicit `204` counts as accepted, and everything else
   * falls back to the blocking endpoint that shipped before. That fallback is
   * also what reports a genuine refusal: a 404 for an unknown session id or a
   * 500 from a server with no provider reads identically on either route, and
   * letting the blocking POST produce it keeps one error message, not two.
   */
  private async submitPrompt(body: Record<string, unknown>): Promise<boolean> {
    if (!this.feedLive) return false;
    const res = await this.request('POST', `/session/${this.sessionId}/prompt_async`, body);
    if (res.status === 204) return true;
    await res.text().catch(() => undefined); // drain, then fall back
    return false;
  }

  /** Arm the waiter for this turn's `session.idle`. Called with no `await`
   *  between the accepted submission and here, so no frame can be processed in
   *  between and no idle can slip past the arming. */
  private armTurnIdle(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.turnIdle = resolve;
    });
  }

  // ---- SSE stream ---------------------------------------------------------

  /** Resolves once the SSE stream is CONNECTED (headers in) — the frames are
   *  then drained in the background. Callers await the connection so no
   *  event emitted after this resolves can be missed. */
  private async consumeEvents(): Promise<void> {
    if (!this.baseUrl) {
      this.resolveFeedEnded();
      return;
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/event`, {
        headers: { accept: 'text/event-stream' },
        signal: this.sse.signal,
      });
    } catch {
      // Aborted or server gone. Without a feed there is no `session.idle`, so
      // every prompt takes the blocking endpoint, whose response carries the
      // results — the behaviour that shipped before #168.
      this.resolveFeedEnded();
      return;
    }
    if (!res.body) {
      this.resolveFeedEnded();
      return;
    }
    this.feedLive = true;
    void this.readEvents(res.body.getReader());
  }

  private async readEvents(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          this.handleFrame(frame);
        }
      }
    } catch {
      // aborted — normal on end()/interrupt
    } finally {
      // The feed is the turn-end signal for an asynchronously submitted
      // prompt; once it is gone, a turn still waiting for `session.idle` must
      // be released rather than wait for something that can never arrive.
      this.feedLive = false;
      this.resolveFeedEnded();
    }
  }

  private handleFrame(frame: string): void {
    const dataLines = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) return;
    let evt: OpencodeEvent;
    try {
      evt = JSON.parse(dataLines.join('\n')) as OpencodeEvent;
    } catch {
      return;
    }
    this.emitUi((state) => mapOpencodeEvent(evt, state));
    this.handleEvent(evt);
  }

  private handleEvent(evt: OpencodeEvent): void {
    const type = evt.type ?? '';
    const props = evt.properties ?? {};
    if (type === 'message.updated' || type === 'message.created' || type === 'message.completed') {
      const info = (props.info as Record<string, unknown>) ?? props;
      const mid = stringField(info, 'id');
      const role = stringField(info, 'role');
      if (mid && role) this.msgRole.set(mid, role);
      this.absorbUsage(info);
    } else if (type === 'message.part.updated' || type === 'message.part.created') {
      this.handlePart((props.part as Record<string, unknown>) ?? props);
    } else if (type === 'session.idle') {
      // THE turn-end signal (§4.1), and the only one an asynchronously
      // submitted prompt has. A foreign `sessionID` is a subtask's child
      // session going quiet, never this turn — the same test the v2 mapper
      // makes in `mapIdle`, including treating an absent id as this session's.
      const sid = stringField(props, 'sessionID');
      if (sid === undefined || sid === this.sessionId) this.turnIdle?.();
    }
  }

  private handlePart(part: Record<string, unknown>): void {
    // Only surface parts of assistant messages — the user's own message streams
    // over the same feed. Role is known early (the message.updated event
    // precedes its parts); an unknown role means "not assistant yet" → skip.
    const messageID = stringField(part, 'messageID');
    if (messageID && this.msgRole.get(messageID) !== 'assistant') return;
    const kind = stringField(part, 'type');
    const id = stringField(part, 'id') ?? messageID ?? '';
    if (kind === 'text') {
      const full = stringField(part, 'text') ?? '';
      const seen = this.textSeen.get(id) ?? 0;
      if (full.length > seen) {
        this.textSeen.set(id, full.length);
        this.textCoalescer.append(id, full.slice(seen));
      }
      // `time.end` marks the part finished (same signal the v2 mapper uses) —
      // emit the whole block once, preferring the snapshot's full text.
      const time = part.time as Record<string, unknown> | undefined;
      if (time && typeof time === 'object' && typeof time.end === 'number') {
        this.textCoalescer.complete(id, full);
      }
    } else if (kind === 'tool') {
      const state = (part.state as Record<string, unknown> | undefined) ?? {};
      const status = stringField(state, 'status');
      const name = stringField(part, 'tool') ?? stringField(part, 'name') ?? 'tool';
      const callId = id || `${name}-${this.toolsSeen.size}`;
      if (!this.toolsSeen.has(callId)) {
        this.toolsSeen.add(callId);
        this.toolCalls.push({ id: callId, name, input: state.input ?? state });
        this.emit({ type: 'tool-call', id: callId, tool: name, input: state.input ?? state });
      }
      if (status === 'completed' || status === 'error') {
        this.emit({
          type: 'tool-result',
          toolCallId: callId,
          result: safeStringify(state.output ?? state.result ?? state),
          isError: status === 'error',
        });
      }
    }
  }

  /** Pull cumulative tokens/cost out of an assistant message info object. */
  private absorbUsage(info: Record<string, unknown> | undefined): void {
    if (!info) return;
    const tokens = info.tokens as Record<string, unknown> | undefined;
    if (tokens) {
      const input = numField(tokens, 'input');
      const output = numField(tokens, 'output');
      const reasoning = numField(tokens, 'reasoning');
      const total = input + output + reasoning;
      if (total > this.tokensUsed) {
        this.tokensUsed = total;
        this.emit({ type: 'token-usage', tokensUsed: this.tokensUsed });
      }
    }
    const cost = numField(info, 'cost');
    if (cost > this.lastCost) {
      this.emit({ type: 'cost', usd: cost - this.lastCost });
      this.lastCost = cost;
    }
  }

  // ---- http ---------------------------------------------------------------

  /**
   * The one request/response fetch this session makes — `http()` for callers
   * that want the parsed body, `submitPrompt()` for the one caller that has to
   * read a STATUS instead (a `204` accept is indistinguishable from an older
   * server's catch-all once the body is parsed). The SSE subscription in
   * `consumeEvents` is deliberately its own long-lived fetch.
   *
   * Only the transport rejection is wrapped — every successful response, and
   * every non-2xx one, takes exactly the path it always did (#153). The wrap
   * sits HERE rather than in `http()` so that `submitPrompt()`, which reads a
   * status off this same call, cannot be the one caller left with Node's
   * opaque two-word `fetch failed`.
   */
  private async request(method: string, path: string, body: unknown): Promise<Response> {
    if (!this.baseUrl) throw new Error('opencode server not ready');
    const startedAt = Date.now();
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(describeFetchFailure(err, method, path, Date.now() - startedAt));
    }
  }

  private async http(
    method: string,
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const res = await this.request(method, path, body);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → ${res.status} ${detail.slice(0, 200)}`);
    }
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }

  /** The mapper never throws, but a defect in it must still never disturb
   *  the v1 stream — hence the belt-and-braces try. */
  private emitUi(map: (state: OpencodeUiMapperState) => OpencodeUiMapping): void {
    try {
      const mapped = map(this.uiState);
      this.uiState = mapped.state;
      if (this.opts.onUiEvent) {
        for (const event of mapped.events) this.opts.onUiEvent(event);
      }
    } catch {
      // v2 mapping is best-effort; v1 consumers stay unaffected.
    }
  }
}

// ---- helpers --------------------------------------------------------------

interface OpencodeEvent {
  type?: string;
  properties?: Record<string, unknown>;
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

/** Read a property off a value nobody vouched for. A rejection reason may define
 *  `name`, `code`, `message` or `cause` as a getter that throws, and the error
 *  formatter below must never be the thing that fails. */
function safeField(value: unknown, key: string): unknown {
  if (value === undefined || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Read a string property off a value nobody vouched for — `stringField` for
 *  the error path, where a throwing getter is a possibility. */
function safeStringField(value: unknown, key: string): string | undefined {
  const v = safeField(value, key);
  return typeof v === 'string' ? v : undefined;
}

/** `String(value)` is not total: a null-prototype object has no `toString`, so
 *  it throws "Cannot convert object to primitive value". */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    /* not stringable — try JSON below */
  }
  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string') return json;
  } catch {
    /* not serializable either */
  }
  return '[unprintable]';
}

function numField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === 'number' ? v : 0;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    // NOT typed `string`: JSON.stringify returns undefined for a value it
    // considers unrepresentable — an object whose `toJSON()` returns undefined,
    // a function, a symbol — and a caller that trusts the annotation crashes.
    const json = JSON.stringify(value);
    if (typeof json === 'string') return json;
  } catch {
    /* circular or otherwise unserializable */
  }
  return safeString(value);
}

/** How deep `cause` is followed before the walk gives up — a cheap guard
 *  against both a long chain and one that points back at itself. */
const MAX_CAUSE_DEPTH = 4;

const UNDICI_TIMEOUT_HINT =
  "Node's built-in fetch gives up on a request that stays silent for 300s; a slow local model can take longer than that to answer.";

/** Names/codes undici uses for its own 300s default. Matched on the rendered
 *  cause text, so a nested one still counts. */
const UNDICI_TIMEOUT_MARKERS = /UND_ERR_(?:HEADERS|BODY)_TIMEOUT|(?:Headers|Body)TimeoutError/i;

/**
 * Node's built-in fetch rejects EVERY transport failure as the same opaque
 * `TypeError: fetch failed`. The reason lives in `.cause` — an undici
 * `HeadersTimeoutError`, a reset socket, a refused connection — and the runner
 * used to drop it, so a user had nothing to diagnose with (#153). One line,
 * with the cause and the elapsed seconds that make undici's 300s default
 * recognisable on sight.
 */
export function describeFetchFailure(
  err: unknown,
  method: string,
  path: string,
  elapsedMs: number,
): string {
  const ownMessage = err instanceof Error ? safeStringField(err, 'message') : undefined;
  const head = ownMessage || safeString(err);
  const cause = describeCause(safeField(err, 'cause'));
  let message = `${head} after ${formatSeconds(elapsedMs)} (${method} ${path})`;
  if (cause) message += ` — ${cause}`;
  if (cause && UNDICI_TIMEOUT_MARKERS.test(cause)) message += `. ${UNDICI_TIMEOUT_HINT}`;
  return message;
}

/**
 * Render an error `cause` without assuming anything about its shape: it may be
 * absent, a string, a plain object, a primitive, or an Error whose own `cause`
 * carries the real reason. Always one line, never throws.
 */
function describeCause(value: unknown, depth = 0): string | undefined {
  if (value === undefined || value === null || depth >= MAX_CAUSE_DEPTH) return undefined;
  if (typeof value === 'string') return oneLine(value) || undefined;
  if (typeof value !== 'object') return oneLine(String(value)) || undefined;

  const name = safeStringField(value, 'name');
  const code = safeStringField(value, 'code');
  const message = oneLine(safeStringField(value, 'message') ?? '');
  const label = name && code ? `${name} (${code})` : (name ?? (code ? `(${code})` : undefined));
  const own = [label, message && message !== label ? message : undefined].filter(Boolean).join(': ');
  const nested = describeCause(safeField(value, 'cause'), depth + 1);
  if (!own) return nested ?? (oneLine(safeStringify(value)).slice(0, 200) || undefined);
  return nested ? `${own} — caused by ${nested}` : own;
}

/** Seconds, so a 300s wall is obvious; one decimal below 10s so a fast failure
 *  does not read as "after 0s". */
function formatSeconds(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  return `${seconds >= 10 ? Math.round(seconds) : Math.round(seconds * 10) / 10}s`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function wrapSpawnError(err: unknown, bin: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new Error(
      `\`${bin}\` not found on PATH — install OpenCode (https://opencode.ai) and run \`opencode\` once to configure a provider`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
