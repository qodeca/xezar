import { dirname } from 'node:path';

import type { McpJournalRow, McpLeaderActionInput, McpLeaderBlocker, McpLeaderSession, McpLeaderStatus } from '@qodeca/xezar-contract';

import type { ProjectOwnership } from '../workspace/project-owner.ts';
import { ClaudeCodeReactionAdapter } from './adapters/claude-code.ts';
import { CodexAppServerProcessLink, CodexReactionAdapter, openCodexLeaderThread } from './adapters/codex.ts';
import { OpenCodeReactionAdapter } from './adapters/opencode.ts';
import type { EchoGuard } from './echo-guard.ts';
import { EventController, type CursorAdvance, type EventDispatch, type ReactionAdapter } from './event-controller.ts';
import type { EventJournal } from './event-journal.ts';
import type { LeaderActResult, ProjectLeaderPort } from './project-leaders.ts';

/**
 * Push delivery, connected (#309, Phase 6 of #73). Until this module, `EventController` (#107) and
 * the three reaction adapters (#108–#110) were complete, tested — and constructed by nothing
 * outside their own tests, so no event ever reached a client. This is the one place the running
 * service builds them, composed once per project by `startMcpService`.
 *
 * WHAT IS ON BY DEFAULT. Every MCP session that becomes the project's owner (`session/open`,
 * D-02.2) gets an event controller at once, with this object as its adapter; the controller ends
 * when that session's connection closes (D-02.4). No flag, no setting: an owner session always has
 * a dispatcher following the journal for it.
 *
 * WHAT IT CANNOT DO ON ITS OWN, AND WHY. A dispatch must reach a MODEL, and generic MCP
 * notifications start no turn in Claude Code, Codex or OpenCode (D-05 § 4; each adapter's evidence
 * record). The adapters therefore speak only to a session xezar itself started (`claude -p` in
 * stream-json mode, a Codex app-server thread) or was pointed at (an OpenCode `serve` session). A
 * Claude Code or Codex session the user opened in a terminal cannot be woken — every rung that would
 * reach it is refused or unproven — so for that session the controller keeps the rows in the
 * journal, reports `disconnected`, retries at its heartbeat, and `status().blocker` says what would
 * unblock it. Nothing is lost: the rows stay in the journal and the next session resumes after the
 * leader's last acknowledgement. xezar never starts a leader by itself: a hidden second leader is
 * exactly what the requirements forbid (§ 12), and it would spend model credit nobody asked for.
 * A leader starts through `act()` (`POST /api/v1/mcp/leader`), which is a person's decision.
 *
 * THE ECHO GUARD HOLDS HERE, FOR EVERY CLIENT. The door records each mutation's operation id as the
 * leader's own before it runs (`EchoGuard.issue`, #106), including the ids it mints for tools that
 * carry no `operationId`. A `leader` row caused by one of them is dropped before any adapter sees it.
 * The Claude Code adapter's own guard only knows the `operationId` arguments it read in its model's
 * tool calls, so it alone would miss a door-minted id — which is why the rule is applied here, once,
 * and the adapters' own guards stay as a second line. Only the echo rule: the guard's `duplicate`
 * rule must NOT be applied, because redelivery after a reconnect is at-least-once by contract.
 *
 * ## Every state this relies on, and who fires each exit
 *
 * Controller states (`EventControllerState`), as wired here:
 *
 * | State | Exit | Who fires it (on by default) |
 * | --- | --- | --- |
 * | inert | — | never entered: this object is always the adapter |
 * | idle | → dispatching | a journal append, or the 30 s heartbeat tick |
 * | dispatching | → idle / → recovering | `deliver` resolving / rejecting or timing out (one heartbeat) |
 * | recovering | → idle / → disconnected | the bounded round itself (5 attempts) |
 * | disconnected | → dispatching | the heartbeat tick, every 30 s; or `wake()`, which `act()` fires the moment a leader starts or attaches |
 * | any | → ended | the session's connection closing (`sessionClosed`), another session taking the project (`sessionOpened`), the lease lapsing (found at the next tick), or the service closing |
 *
 * `disconnected` with no reachable leader is the one state that waits on something outside xezar,
 * and it does not wait on a human alone: the heartbeat retries it for as long as the session owns
 * the project, at no model cost (N-06). It is the recoverable blocker the requirements ask for.
 *
 * Leader states: none → running (`act` start/resume/attach); running → stopped (the leader process
 * exits — the Claude Code adapter's own `stopped`, a closed app-server link); stopped → running
 * (`act` resume/start); any → none (`act` stop, or the service closing). A stopped leader resumes by
 * an explicit act, as requirement A-16 ("restarted-awaiting-resume") asks.
 *
 * What reaches a terminal state BECAUSE of this module: controllers and leader processes xezar
 * itself started. No run, lease, queue slot or worktree.
 */

/** xezar's base role for a leader it starts. The per-project customisation is not built yet. */
export const LEADER_ROLE_INSTRUCTION = [
  'You are the project leader for this xezar project.',
  'You plan and coordinate the work through the xezar MCP tools: start tasks, read their results, answer their questions and hand finished work off.',
  'You do not edit files yourself; tasks do the work in their own worktrees.',
].join('\n');

const NO_LEADER: McpLeaderBlocker = {
  code: 'no-leader-session',
  message:
    'No leader session xezar can reach is attached to this project, so events are kept in the journal, not delivered. xezar cannot wake a Claude Code or Codex session you opened yourself: MCP notifications start no turn, and typing into your terminal is refused.',
  fix: 'Start the leader from xezar (Claude Code or Codex), or attach the OpenCode session you run with `opencode serve`.',
};

/** #309 O-3: a journal that records nothing has nothing to deliver, so a leader would never hear a thing. */
const JOURNAL_UNWRITABLE: McpLeaderBlocker = {
  code: 'journal-unwritable',
  message:
    'xezar cannot write this project’s event journal, so no event is recorded and none can be delivered. The cockpit log names the file and the error.',
  fix: 'Make the project’s .local/xezar/mcp folder writable, then restart xezar.',
};

export interface LeaderDeliveryOptions {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly journal: EventJournal;
  readonly ownership: Pick<ProjectOwnership, 'projectId' | 'sessionToken' | 'state'>;
  /** The door's echo guard. Absent (it could not be built): no row is dropped as an echo. */
  readonly guard: Pick<EchoGuard, 'isOwn'> | undefined;
  /** How this installation starts `xez mcp` (D-01 § 1.7) — the leader session's MCP server. */
  readonly bridge: { readonly command: string; readonly args: readonly string[] };
  readonly warn: (message: string) => void;
  /** Test seams. Production resolves `claude` and `codex` exactly as the runners do. */
  readonly claudeBin?: string;
  readonly codexBin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly heartbeatMs?: number;
}

type Leader =
  | { readonly client: 'claude-code'; readonly adapter: ClaudeCodeReactionAdapter }
  | { readonly client: 'codex'; readonly adapter: CodexReactionAdapter; readonly link: CodexAppServerProcessLink }
  | { readonly client: 'opencode'; readonly adapter: OpenCodeReactionAdapter };

export class LeaderDelivery implements ReactionAdapter, ProjectLeaderPort {
  readonly projectId: string;
  readonly #opts: LeaderDeliveryOptions;
  /** Keyed by the transport's session key. At most one is live: the project has one owner. */
  readonly #controllers = new Map<string, EventController>();
  #leader: Leader | undefined;
  /** One `act` at a time: two concurrent starts must not spawn two leaders. */
  #acting: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(opts: LeaderDeliveryOptions) {
    this.projectId = opts.projectId;
    this.#opts = opts;
  }

  // ---- the transport's side: one controller per owner session ------------------------------

  /** `session/open` made `sessionKey` the owner. Never throws into the transport (N-07). */
  sessionOpened(sessionKey: string): void {
    if (this.#closed || this.#controllers.has(sessionKey)) return;
    // Only one session owns the project, so any other controller serves a session that lost it —
    // one whose lease lapsed while its connection stayed open. End it now rather than at its next
    // tick: the journal allows one dispatcher, and it must be the owner's.
    for (const [key, controller] of this.#controllers) {
      controller.close();
      this.#controllers.delete(key);
    }
    const started = EventController.start({
      journal: this.#opts.journal,
      ownership: this.#opts.ownership,
      sessionKey,
      adapter: this,
      warn: this.#opts.warn,
      ...(this.#opts.heartbeatMs === undefined ? {} : { heartbeatMs: this.#opts.heartbeatMs }),
    });
    if (started.outcome === 'started') this.#controllers.set(sessionKey, started.controller);
    else if (started.outcome === 'refused') this.#opts.warn(`[xez] MCP event delivery not started for project ${this.projectId}: ${started.error.message}`);
  }

  /** The session's connection closed (D-02.4): its controller ends. The journal keeps every row. */
  sessionClosed(sessionKey: string): void {
    this.#controllers.get(sessionKey)?.close();
    this.#controllers.delete(sessionKey);
  }

  // ---- the controller's side: `ReactionAdapter` ----------------------------------------------

  async deliver(dispatch: EventDispatch, signal: AbortSignal): Promise<void> {
    const leader = this.#leader;
    if (leader === undefined) throw new Error(NO_LEADER.message);
    const events = dispatch.events.filter((row) => !this.#isEcho(row));
    // Only the leader's own echoes: nothing to tell it, so this is delivered as nothing — no turn.
    if (events.length === 0 && dispatch.recovery === undefined) return;
    const adapter: ReactionAdapter = leader.adapter;
    await adapter.deliver({ ...dispatch, events }, signal);
  }

  async heartbeat(signal: AbortSignal): Promise<void> {
    const leader = this.#leader;
    if (leader === undefined) throw new Error(NO_LEADER.message);
    const adapter: ReactionAdapter = leader.adapter;
    await adapter.heartbeat?.(signal);
  }

  // ---- the cockpit's side: `ProjectLeaderPort` -----------------------------------------------

  status(): McpLeaderStatus {
    const controller = this.#liveController();
    return {
      available: true,
      leader: this.#leaderSession(),
      delivery: controller ? controller.status() : null,
      blocker: this.#blocker(),
    };
  }

  act(input: McpLeaderActionInput): Promise<LeaderActResult> {
    const next = this.#acting.then(() => this.#act(input));
    this.#acting = next.catch(() => undefined);
    return next;
  }

  /** The service is stopping: every controller ends and the leader xezar started is stopped. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#controllers.values()) controller.close();
    this.#controllers.clear();
    this.#stopLeader();
  }

  // ---- internals ----------------------------------------------------------------------------

  async #act(input: McpLeaderActionInput): Promise<LeaderActResult> {
    if (this.#closed) return { ok: false, error: 'the MCP service for this project is stopping' };
    if (input.action === 'stop') {
      this.#stopLeader();
      return { ok: true, status: this.status() };
    }
    // Starting a leader that can never receive an event would answer 200 with a blocker-free status
    // for a path that delivers nothing (#309 O-3). Refuse, and say why.
    if (!this.#opts.journal.writable) return { ok: false, error: JOURNAL_UNWRITABLE.message };
    const current = this.#leaderSession();
    if (current?.state === 'running') {
      return { ok: false, error: `a ${current.client} leader session is already running for this project; stop it first` };
    }
    // A Claude Code or Codex leader xezar starts connects its own `xez mcp` bridge, which would be
    // refused project-occupied while another client holds the project. Say so now, in plain words,
    // instead of starting a session that can never own it. OpenCode is different: the session the
    // user attaches IS normally the client that owns the project.
    if (input.action !== 'attach' && this.#opts.ownership.state() === 'owned') {
      return {
        ok: false,
        error: 'another MCP client owns this project right now; close it before starting a leader from xezar, so the project keeps one leader',
      };
    }
    try {
      switch (input.action) {
        case 'start':
          return input.client === 'claude-code' ? this.#startClaude('start') : await this.#startCodex();
        case 'resume':
          return this.#startClaude('resume');
        case 'attach':
          return this.#attachOpenCode(input.baseUrl, input.sessionId);
      }
    } catch (err) {
      // The text is a spawn or protocol failure (a missing binary, say), never a secret: the
      // adapters keep stderr and account details out of everything they report.
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  #startClaude(how: 'start' | 'resume'): LeaderActResult {
    const opts = this.#opts;
    let adapter = this.#leader?.client === 'claude-code' ? this.#leader.adapter : undefined;
    if (adapter === undefined) {
      this.#stopLeader();
      adapter = new ClaudeCodeReactionAdapter({
        projectId: this.projectId,
        stateDir: dirname(opts.journal.rowsPath),
        epoch: opts.journal.epoch,
        cwd: opts.projectRoot,
        roleInstruction: LEADER_ROLE_INSTRUCTION,
        bridge: opts.bridge,
        warn: opts.warn,
        ...(opts.claudeBin === undefined ? {} : { bin: opts.claudeBin }),
        ...(opts.env === undefined ? {} : { env: opts.env }),
      });
      adapter.bindController({ recordReaction: (seq) => this.#recordReaction(seq), wake: () => this.#wake() });
    }
    const started = how === 'start' ? adapter.start() : adapter.resume();
    if (started.outcome === 'refused') {
      const why = {
        running: 'a Claude Code leader session is already running for this project',
        occupied: 'another Claude Code leader session is running for this project in this xezar',
        'no-session': how === 'resume' ? 'there is no earlier Claude Code leader conversation to resume' : 'Claude Code could not be started',
        closed: 'this leader was stopped; start a new one',
      }[started.reason];
      return { ok: false, error: why };
    }
    this.#leader = { client: 'claude-code', adapter };
    this.#wake();
    return { ok: true, status: this.status() };
  }

  async #startCodex(): Promise<LeaderActResult> {
    const opts = this.#opts;
    this.#stopLeader();
    const link = await CodexAppServerProcessLink.open({ cwd: opts.projectRoot, ...(opts.codexBin === undefined ? {} : { bin: opts.codexBin }) });
    let threadId: string;
    try {
      threadId = await openCodexLeaderThread(link, { cwd: opts.projectRoot, roleInstruction: LEADER_ROLE_INSTRUCTION });
    } catch (err) {
      link.close();
      throw err;
    }
    const adapter = new CodexReactionAdapter({
      link,
      threadId,
      projectId: this.projectId,
      onReaction: (seq) => this.#recordReaction(seq),
      ...this.#ownOperation(),
    });
    this.#leader = { client: 'codex', adapter, link };
    // The app-server exiting is the leader stopping; the next tick then reports `disconnected`.
    void link.exited.then(() => this.#wake());
    this.#wake();
    return { ok: true, status: this.status() };
  }

  #attachOpenCode(baseUrl: string, sessionId: string): LeaderActResult {
    this.#stopLeader();
    const adapter = new OpenCodeReactionAdapter({
      target: { baseUrl, sessionId },
      projectRoot: this.#opts.projectRoot,
      roleInstruction: LEADER_ROLE_INSTRUCTION,
      onReaction: (seq) => this.#recordReaction(seq),
      ...this.#ownOperation(),
    });
    this.#leader = { client: 'opencode', adapter };
    this.#wake();
    return { ok: true, status: this.status() };
  }

  #stopLeader(): void {
    const leader = this.#leader;
    this.#leader = undefined;
    if (leader === undefined) return;
    switch (leader.client) {
      case 'claude-code':
        leader.adapter.close();
        return;
      case 'codex':
        leader.adapter.dispose();
        leader.link.close();
        return;
      case 'opencode':
        leader.adapter.close();
        return;
    }
  }

  #ownOperation(): { isOwnOperation?: (operationId: string) => boolean } {
    const guard = this.#opts.guard;
    return guard === undefined ? {} : { isOwnOperation: (operationId) => guard.isOwn(operationId) };
  }

  #isEcho(row: McpJournalRow): boolean {
    return row.origin === 'leader' && row.causedBy !== null && this.#opts.guard?.isOwn(row.causedBy) === true;
  }

  #liveController(): EventController | undefined {
    for (const controller of this.#controllers.values()) if (controller.state !== 'ended') return controller;
    return undefined;
  }

  #recordReaction(seq: number): CursorAdvance {
    return this.#liveController()?.recordReaction(seq) ?? { status: 'inactive', seq: 0 };
  }

  /** A leader came (back): deliver now instead of at the next heartbeat. */
  #wake(): void {
    this.#liveController()?.wake();
  }

  #leaderSession(): McpLeaderSession | null {
    const leader = this.#leader;
    if (leader === undefined) return null;
    switch (leader.client) {
      case 'claude-code':
        return { client: leader.client, state: leader.adapter.status().state === 'running' ? 'running' : 'stopped' };
      case 'codex':
        return { client: leader.client, state: leader.link.closed ? 'stopped' : 'running' };
      case 'opencode':
        return { client: leader.client, state: 'running' };
    }
  }

  #blocker(): McpLeaderBlocker | null {
    // Before anything about the leader: with no journal, even a running leader hears nothing.
    if (!this.#opts.journal.writable) return JOURNAL_UNWRITABLE;
    const leader = this.#leader;
    if (leader === undefined) return NO_LEADER;
    switch (leader.client) {
      case 'claude-code': {
        const blocker = leader.adapter.status().blocker;
        return blocker ? { code: blocker.code, message: blocker.message, fix: blocker.fix } : null;
      }
      case 'codex':
        return leader.link.closed
          ? {
              code: 'codex-session-ended',
              message: 'The Codex leader session xezar started has ended. Events are kept in the journal until a leader is back.',
              fix: 'Start the Codex leader from xezar again; outstanding events are delivered from the last acknowledgement.',
            }
          : null;
      case 'opencode': {
        const blocker = leader.adapter.status().blocker;
        return blocker
          ? { code: blocker.code, message: blocker.message, fix: 'Check that `opencode serve` is running in this project and the session id is right, then attach it again.' }
          : null;
      }
    }
  }
}
