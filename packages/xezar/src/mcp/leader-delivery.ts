import type { McpJournalRow, McpLeaderActionInput, McpLeaderBlocker, McpLeaderSession, McpLeaderStatus } from '@qodeca/xezar-contract';

import { projectDataDir } from '../project-data-paths.ts';
import type { ProjectOwnership } from '../workspace/project-owner.ts';
import { OpenCodeReactionAdapter } from './adapters/opencode.ts';
import { connectPiLeaderLink, type PiLeaderDescriptor, type PiLeaderLink, readPiLeaderDescriptor } from './adapters/pi-link.ts';
import { type PiReactionAdapter, type PiReactionTarget, piReactionTarget } from './adapters/pi.ts';
import type { EchoGuard } from './echo-guard.ts';
import { EventController, type CursorAdvance, type DeliveryReceipt, type EventDispatch, type LeaderRecord, type ReactionAdapter } from './event-controller.ts';
import type { EventJournal } from './event-journal.ts';
import type { LeaderActResult, ProjectLeaderPort } from './project-leaders.ts';

/**
 * Push delivery, connected (#309, Phase 6 of #73). Until this module, `EventController` (#107) and
 * the reaction adapters (#108–#110) were complete, tested — and constructed by nothing outside their
 * own tests, so no event ever reached a client. This is the one place the running service builds
 * the controller, composed once per project by `startMcpService`.
 *
 * WHAT IS ON BY DEFAULT. Every MCP session that becomes the project's owner (`session/open`,
 * D-02.2) gets an event controller at once, with this object as its adapter; the controller ends
 * when that session's connection closes (D-02.4). No flag, no setting: an owner session always has
 * a dispatcher following the journal for it.
 *
 * WHO IT CAN REACH, AND WHY ONLY THEM. A dispatch must reach a MODEL, and generic MCP notifications
 * start no turn in Claude Code, Codex, OpenCode or pi (D-05 § 4; #330 run A for pi; each adapter's
 * evidence record). xezar NEVER starts an agent process for a leader (owner decision on #311): the
 * person runs their own leader and connects it to xezar over MCP. So an event reaches a model only
 * through a session the person runs AND tells xezar where to find — `attach`. Two clients can be
 * told today:
 *
 *  - **OpenCode** names an `opencode serve` session by URL and session id (#110).
 *  - **pi** names nothing, because it cannot: pi's RPC is stdio-only and spawn-only, so a pi the
 *    person started has no address. The address therefore comes from INSIDE it — xezar's pi leader
 *    extension opens a socket and announces it in the project's data directory, and `#piTarget()`
 *    dials that (#330 WP2, `adapters/pi-link.ts`). With no extension running there is no descriptor
 *    and the attach is refused with pi's own recoverable reason, which is exactly the behaviour that
 *    existed before the extension did.
 *
 * A Claude Code or Codex session in a terminal still has no address at all: for it the controller
 * keeps the rows in the journal, reports `disconnected`, retries at its heartbeat, and
 * `status().blocker` says so. Nothing is lost either way — such a leader reads its events with the
 * `leader_events` tool (#251), and the next session resumes after its last acknowledgement.
 *
 * THE ECHO GUARD HOLDS HERE, FOR EVERY CLIENT. The door records each mutation's operation id as the
 * leader's own before it runs (`EchoGuard.issue`, #106), including the ids it mints for tools that
 * carry no `operationId`. A `leader` row caused by one of them is dropped before the adapter sees it,
 * so a client's own guard — which knows only the ids it saw — cannot miss a door-minted one. Only the
 * echo rule: the guard's `duplicate` rule must NOT be applied, because redelivery after a reconnect
 * is at-least-once by contract.
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
 * | disconnected | → dispatching | the heartbeat tick, every 30 s; or `wake()`, which `attach` fires at once |
 * | any | → ended | the session's connection closing (`sessionClosed`), another session taking the project (`sessionOpened`), the lease lapsing (found at the next tick), or the service closing |
 *
 * `disconnected` with nothing attached is the one state that waits on something outside xezar, and
 * it does not wait on a human alone: the heartbeat retries it for as long as the session owns the
 * project, at no model cost (N-06). It is the recoverable blocker the requirements ask for.
 *
 * Leader states: none → attached (`act` attach); attached → none (`act` stop, or the service
 * closing). An attached OpenCode session that goes away is the adapter's own recoverable blocker,
 * reported by `status()`; the controller retries it at the heartbeat. A pi leader that goes away
 * takes its socket with it, which closes the link and reports the same way.
 *
 * What xezar OPENS to reach a leader is released on every one of those exits: `#detach` closes the
 * adapter and then its `dispose` (pi's socket today), and `close()` goes through `#detach`.
 *
 * What reaches a terminal state BECAUSE of this module: its controllers. No process, run, lease,
 * queue slot or worktree — it starts nothing and stops nothing but its own objects.
 */

/** xezar's base role, sent with every event to an attached leader. Per-project customisation is not built yet. */
export const LEADER_ROLE_INSTRUCTION = [
  'You are the project leader for this xezar project.',
  'You plan and coordinate the work through the xezar MCP tools: start tasks, read their results, answer their questions and hand finished work off.',
  'You do not edit files yourself; tasks do the work in their own worktrees.',
].join('\n');

const NO_LEADER: McpLeaderBlocker = {
  code: 'no-leader-session',
  message:
    'No leader session is attached to this project, so events are kept in the journal, not pushed. A Claude Code, Codex or pi session in a terminal has no address xezar can attach to, and MCP notifications start no turn — that leader reads its events with the leader_events tool.',
  fix: 'Keep using leader_events from your own leader, or attach the OpenCode session you run with `opencode serve`.',
};

/**
 * #331: a leader is attached, but no MCP session owns the project, so no controller follows the
 * journal and nothing is delivered. The ORDINARY first state: OpenCode connects its MCP servers
 * lazily, so "attach first, MCP session later" is what a first user sees.
 */
const NO_OWNER_SESSION: McpLeaderBlocker = {
  code: 'no-owner-session',
  message:
    'A leader is attached, but no MCP session owns this project yet, so nothing follows the event journal and nothing is delivered. OpenCode connects its xezar MCP server only when it first needs it. Events are kept in the journal meanwhile.',
  fix: 'Let the attached OpenCode session call a xezar tool once (for example leader_events), so its MCP connection opens; it then receives every event it has not acknowledged.',
};

/**
 * Events are waiting and the last attempt to hand them to THIS leader did not get through — a
 * refused request, a dropped connection, a server that accepts and never answers, or a leader busy
 * in a long turn. xezar cannot tell those apart (the adapter waits for the session to be free, and a
 * long turn looks exactly like silence), so the text names both and diagnoses neither (QA on #311,
 * round five). The fact behind it is recorded against the LEADER, so it survives a session change and
 * is never inherited by a leader that has just been attached.
 */
const DELIVERY_FAILING: McpLeaderBlocker = {
  code: 'delivery-failing',
  message:
    'Events are waiting, and the last attempt to hand them to the attached leader did not get through. It may be busy in a long turn, or it may have stopped answering — xezar cannot tell those apart, and keeps retrying while this MCP session owns the project. Nothing is lost: the events stay in the journal.',
  fix: 'If the leader is working, nothing is needed: the events go as soon as it is free. Otherwise check that `opencode serve` is running and answering (a paused process still accepts connections), or attach the session again.',
};

/** The same fact with nothing waiting: the leader did not answer xezar’s last liveness check. */
const LEADER_NOT_ANSWERING: McpLeaderBlocker = {
  code: 'leader-not-answering',
  message:
    'The attached leader did not answer xezar’s last liveness check — it may be busy, or gone. Nothing is waiting right now; the next event would be retried until it answers.',
  fix: 'If the leader is working, nothing is needed. Otherwise check that `opencode serve` is running and answering, or attach the session again.',
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
  /**
   * The leader's acknowledgement record (`LeaderCursors`, #251) — the ONE acknowledgement the
   * controller resumes by, filters by and reports (#332). Absent: the controller's own.
   */
  readonly leaderRecord?: LeaderRecord;
  readonly warn: (message: string) => void;
  /** Test seam. Production uses the controller's 30 s. */
  readonly heartbeatMs?: number;
  /**
   * Where this project's state lives, for the pi leader descriptor (`adapters/pi-link.ts`). Absent
   * it is DERIVED from `projectRoot`, which is what the service already does, so nothing upstream
   * has to pass it for pi attach to work. A store with a relocated `dataDir` may pass its own.
   */
  readonly dataDir?: string;
  /** Test seams for the pi link, so a case never touches a real socket. Production uses the module. */
  readonly piLeader?: {
    read?: (dataDir: string) => ReturnType<typeof readPiLeaderDescriptor>;
    connect?: (descriptor: PiLeaderDescriptor, opts: { warn?: (message: string) => void }) => PiLeaderLink;
  };
}

/**
 * One attached leader, with the FACTS observed against IT (QA on #311, round five). They live here,
 * with the leader, not on the owner session's controller: a failure seen against this leader survives
 * the session being replaced, and a leader just attached inherits no history from whatever the
 * session did before it existed. A new `attach` makes a new record, so nothing carries over.
 */
interface AttachedLeader {
  /** Which client it is, for `status().leader`. The adapter below is that client's. */
  readonly client: McpLeaderSession['client'];
  readonly adapter: LeaderAdapter;
  /** When the first attempt against this leader failed with none succeeding since; else null. */
  failingSince: number | null;
  /** The newest row settled against it: handed over, or dropped because the leader caused it. */
  settledThrough: number;
  /**
   * Release whatever xezar opened to REACH this leader — pi's socket today. Separate from the
   * adapter's own `close()`, which lets go of the session and deliberately owns no transport.
   */
  dispose?: () => void;
}

/**
 * What every leader adapter gives this module, whichever client it speaks to. Structural on purpose
 * — not a union of the adapter classes, which would make `deliver`'s return a union this module
 * cannot await once — so a fifth client is a new `#act` branch and nothing else here. `fix` is
 * optional because only pi's blockers carry their own remedy.
 */
interface LeaderAdapter extends ReactionAdapter {
  heartbeat(signal: AbortSignal): Promise<void>;
  close(): void;
  status(): { blocker?: { code: string; message: string; fix?: string } };
}

export class LeaderDelivery implements ReactionAdapter, ProjectLeaderPort {
  readonly projectId: string;
  readonly #opts: LeaderDeliveryOptions;
  /** Keyed by the transport's session key. At most one is live: the project has one owner. */
  readonly #controllers = new Map<string, EventController>();
  /** The attached OpenCode session and the facts observed against it. xezar never started it. */
  #leader: AttachedLeader | undefined;
  /** One `act` at a time: two concurrent attaches must not leave two adapters behind. */
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
      ...(this.#opts.leaderRecord === undefined ? {} : { leaderRecord: this.#opts.leaderRecord }),
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

  async deliver(dispatch: EventDispatch, signal: AbortSignal): Promise<DeliveryReceipt> {
    const leader = this.#leader;
    if (leader === undefined) throw new Error(NO_LEADER.message);
    const events = dispatch.events.filter((row) => !this.#isEcho(row));
    const last = dispatch.events.at(-1)?.journalSeq;
    // Only the leader's own echoes: nothing to tell it, so nothing is handed over — and the receipt
    // says so, so deliveredSeq never counts a row the leader was not sent (QA on #311). It is still
    // settled, so nothing is waiting for it.
    if (events.length === 0 && dispatch.recovery === undefined) {
      if (last !== undefined) leader.settledThrough = Math.max(leader.settledThrough, last);
      return { handedThrough: null };
    }
    await this.#observed(leader, signal, () => leader.adapter.deliver({ ...dispatch, events }, signal));
    if (last !== undefined) leader.settledThrough = Math.max(leader.settledThrough, last);
    return { handedThrough: events.at(-1)?.journalSeq ?? null };
  }

  async heartbeat(signal: AbortSignal): Promise<void> {
    const leader = this.#leader;
    if (leader === undefined) throw new Error(NO_LEADER.message);
    await this.#observed(leader, signal, () => leader.adapter.heartbeat(signal));
  }

  /**
   * Run one attempt against `leader` and record how it went, AGAINST THAT LEADER: the first failure
   * with none succeeding since, cleared by the next success. An attempt the caller abandons (its
   * signal aborts — a server that accepts and never answers) counts as a failure, and a late success
   * after that abort does not clear it.
   */
  async #observed<T>(leader: AttachedLeader, signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    let abandoned = signal.aborted;
    const onAbort = (): void => {
      abandoned = true;
      leader.failingSince ??= Date.now();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const value = await call();
      if (!abandoned) leader.failingSince = null;
      return value;
    } catch (err) {
      leader.failingSince ??= Date.now();
      throw err;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Is a row waiting for the attached leader? Its own settled position, and what the leader acknowledged. */
  #owed(leader: AttachedLeader): boolean {
    const owedAfter = this.#opts.leaderRecord?.owedAfter();
    const acknowledged = owedAfter?.sameEpoch === true ? owedAfter.seq : 0;
    return this.#opts.journal.latestSeq > Math.max(leader.settledThrough, acknowledged);
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

  /** The service is stopping: every controller ends and the attached session is let go. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#controllers.values()) controller.close();
    this.#controllers.clear();
    this.#detach();
  }

  // ---- internals ----------------------------------------------------------------------------

  async #act(input: McpLeaderActionInput): Promise<LeaderActResult> {
    if (this.#closed) return { ok: false, error: 'the MCP service for this project is stopping' };
    if (input.action === 'stop') {
      this.#detach();
      return { ok: true, status: this.status() };
    }
    // Attaching a leader that can never receive an event would answer 200 with a blocker-free status
    // for a path that delivers nothing (#309 O-3). Refuse, and say why.
    if (!this.#opts.journal.writable) return { ok: false, error: JOURNAL_UNWRITABLE.message };
    if (input.client === 'pi') {
      // pi's adapter (#330 WP2) is built the same way the OpenCode one is, and from the same kind of
      // thing: an address the person's own leader offers. pi's RPC is stdio-only, so that address
      // cannot be pi itself — it is the socket xezar's pi leader extension opens from INSIDE the
      // person's pi and announces in this project's data directory (`adapters/pi-link.ts`). No
      // extension running, no descriptor, no link: `piReactionTarget` answers with its own
      // recoverable reason and the events stay in the journal, exactly as before this existed. The
      // previous leader is kept either way — a refused attach must not detach one that is working.
      const { target, dispose } = this.#piTarget();
      if (target.kind === 'blocked') {
        dispose?.();
        return { ok: false, error: target.blocker.message };
      }
      this.#detach();
      this.#leader = {
        client: 'pi',
        adapter: target.adapter,
        failingSince: null,
        settledThrough: 0,
        ...(dispose ? { dispose } : {}),
      };
      this.#liveController()?.wake();
      return { ok: true, status: this.status() };
    }
    // Re-attaching replaces the previous target; xezar owns no process, so nothing else changes.
    this.#detach();
    // A new leader with no history: whatever happened before it was attached was not about it.
    this.#leader = {
      client: 'opencode',
      adapter: new OpenCodeReactionAdapter({
        target: { baseUrl: input.baseUrl, sessionId: input.sessionId },
        projectRoot: this.#opts.projectRoot,
        roleInstruction: LEADER_ROLE_INSTRUCTION,
        onReaction: (seq) => this.#recordReaction(seq),
        ...this.#ownOperation(),
      }),
      failingSince: null,
      settledThrough: 0,
    };
    // Deliver now, not at the next heartbeat.
    this.#liveController()?.wake();
    return { ok: true, status: this.status() };
  }

  /** Stop talking to the attached session. The OpenCode process and session are the person's. */
  #detach(): void {
    const leaving = this.#leader;
    this.#leader = undefined;
    leaving?.adapter.close();
    // The transport last, and never skipped when `close()` throws: a socket xezar opened and then
    // leaked would keep a pi process's peer alive with nothing reading it.
    try {
      leaving?.dispose?.();
    } catch (err) {
      this.#opts.warn(`[xez] the pi leader link did not close cleanly (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  /**
   * Build pi's target, and whatever has to be released with it. The ONE place a `PiRpcLink` is
   * produced in this process — the answer to "who constructs the adapter", which for one round of
   * review was nobody.
   *
   * Every failure is the blocker, never a throw: this is the `attach` path and the person reads the
   * reason. A descriptor that names a dead socket is the ordinary case (a pi that exited), so it is
   * reported as its own recoverable reason rather than as an error.
   */
  #piTarget(): { target: PiReactionTarget; dispose?: () => void } {
    const base = {
      projectId: this.projectId,
      roleInstruction: LEADER_ROLE_INSTRUCTION,
      onReaction: (seq: number) => this.#recordReaction(seq),
      ...this.#ownOperation(),
    };
    const dataDir = this.#opts.dataDir ?? projectDataDir(this.#opts.projectRoot);
    const read = this.#opts.piLeader?.read ?? readPiLeaderDescriptor;
    const found = read(dataDir);
    if (!found.ok) return { target: piReactionTarget({ ...base, unreachable: found.reason }) };
    const connect = this.#opts.piLeader?.connect ?? connectPiLeaderLink;
    let link: PiLeaderLink;
    try {
      link = connect(found.descriptor, { warn: this.#opts.warn });
    } catch (err) {
      return {
        target: piReactionTarget({
          ...base,
          unreachable: `its socket could not be reached: ${err instanceof Error ? err.message : String(err)}`,
        }),
      };
    }
    const target = piReactionTarget({ ...base, link });
    // A link that was already closed gives a blocked target; do not leak the socket behind it.
    if (target.kind === 'blocked') {
      link.close();
      return { target };
    }
    return { target, dispose: () => link.close() };
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

  #leaderSession(): McpLeaderSession | null {
    return this.#leader === undefined ? null : { client: this.#leader.client, state: 'attached' };
  }

  /**
   * The blocker is a rule over FACTS, in order: the journal can be written; a leader is attached; a
   * session owns the project; the adapter named no problem; no attempt has failed since the last
   * success. It reads no controller state, so a state added later cannot slip past it.
   */
  #blocker(): McpLeaderBlocker | null {
    // Before anything about the leader: with no journal, even an attached leader hears nothing.
    if (!this.#opts.journal.writable) return JOURNAL_UNWRITABLE;
    const leader = this.#leader;
    if (leader === undefined) return NO_LEADER;
    // Attached, but nobody owns the project: no controller, so nothing is delivered (#331).
    const controller = this.#liveController();
    if (controller === undefined) return NO_OWNER_SESSION;
    const blocker = leader.adapter.status().blocker;
    if (blocker) {
      // The adapter's own `fix` when it has one (pi's does); otherwise the OpenCode wording, which
      // is the only adapter whose blockers name no remedy of their own.
      const fix = blocker.fix ?? 'Check that `opencode serve` is running in this project and the session id is right, then attach it again.';
      return { code: blocker.code, message: blocker.message, fix };
    }
    // From FACTS observed against THIS leader, never from the controller's state machine (rounds four
    // and five): a failed attempt with no success since is a blocker in every state, it survives the
    // session being replaced, and a leader just attached has none. `state` is shown, and decides nothing.
    if (leader.failingSince !== null) return this.#owed(leader) ? DELIVERY_FAILING : LEADER_NOT_ANSWERING;
    return null;
  }
}
