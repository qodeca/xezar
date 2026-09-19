import type {
  McpJournalRow,
  McpLeaderActionInput,
  McpLeaderBlocker,
  McpLeaderClient,
  McpLeaderDoorRefusalCode,
  McpLeaderDoorResult,
  McpLeaderOwner,
  McpLeaderSelfStatus,
  McpLeaderSession,
  McpLeaderStatus,
  McpPushCapability,
  McpPushUnavailableCode,
} from '@qodeca/xezar-contract';

import { projectDataDir } from '../project-data-paths.ts';
import type { ProjectOwnership } from '../workspace/project-owner.ts';
import { ClaudeCodeChannelAdapter } from './adapters/claude-code.ts';
import { OpenCodeDeliveryBlocked, OpenCodeReactionAdapter } from './adapters/opencode.ts';
import { CodexAttachError, codexControlHome, connectCodexLeader, type CodexLeaderAnnouncement, type ConnectedCodexLeader } from './adapters/codex-link.ts';
import { codexBlocker, type CodexReactionAdapter, type CodexReactionTarget, codexReactionTarget, type CodexUnreachableReason } from './adapters/codex.ts';
import { connectPiLeaderLink, type PiLeaderDescriptor, type PiLeaderLink, readPiLeaderDescriptor } from './adapters/pi-link.ts';
import { type PiReactionAdapter, type PiReactionTarget, piReactionTarget } from './adapters/pi.ts';
import type { EchoGuard } from './echo-guard.ts';
import {
  EVENT_CONTROLLER_HEARTBEAT_MS,
  EventController,
  type CursorAdvance,
  type DeliveryReceipt,
  type EventDispatch,
  type LeaderRecord,
  type ReactionAdapter,
} from './event-controller.ts';
import type { EventJournal } from './event-journal.ts';
import type { LeaderActResult, ProjectLeaderPort } from './project-leaders.ts';
import type { McpSessionTransport } from './service.ts';

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
 * through a session the person runs AND tells xezar where to find — `attach`. Four clients can be
 * told today:
 *
 *  - **OpenCode** names an `opencode serve` session by URL and session id (#110).
 *  - **pi** names nothing, because it cannot: pi's RPC is stdio-only and spawn-only, so a pi the
 *    person started has no address. The address therefore comes from INSIDE it — xezar's pi leader
 *    extension opens a socket and announces it in the project's data directory, and `#piTarget()`
 *    dials that (#330 WP2, `adapters/pi-link.ts`). With no extension running there is no descriptor
 *    and the attach is refused with pi's own recoverable reason, which is exactly the behaviour that
 *    existed before the extension did.
 *  - **Codex** (#374) names nothing either: the owning Codex session announces its thread id on its
 *    tool calls, and xezar finds the shared app-server in its OWN Codex home (`adapters/codex-link.ts`,
 *    the discovery rule). A refusal is remembered against the owner session with WHICH refusal it
 *    was, so the status names the cause and its fix (design review NB-1).
 *  - **Claude Code** (#374) names nothing either: the target is the owner MCP session itself. xezar
 *    reaches it by writing a channel push down that session's own bridge (`leader/push`), which the
 *    bridge turns into a `notifications/claude/channel` message Claude Code Channels reacts to. The
 *    person opts in per launch with `--dangerously-load-development-channels server:xezar`; attach is
 *    refused (`claude-code-not-owner`, `claude-code-bridge-too-old`) when the owner session is not a
 *    channel-capable Claude Code bridge.
 *
 * A Claude Code session started without that flag, a Codex session off the shared app-server, and a
 * pi with no leader extension still have no address at all: for them the controller keeps the rows
 * in the journal, reports `disconnected`, retries at its heartbeat, and `status().blocker` says so.
 * Nothing is lost either way — such a leader reads its events with the `leader_events` tool (#251),
 * and the next session resumes after its last acknowledgement.
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

/**
 * xezar's base role, sent with every event to an attached leader. Per-project customisation is not
 * built yet. #466 P3: it suits any project — software, an advertising agency, scientific research —
 * so Git, GitHub and automated checks are named only as capabilities a project may or may not have.
 */
export const LEADER_ROLE_INSTRUCTION = [
  'You are the project leader for this xezar project.',
  'You plan and coordinate the work through the xezar MCP tools: start tasks, read their results, answer their questions and hand finished work off.',
  'Use only these tools: never the cockpit UI and never its HTTP API.',
  'Work in this order: find out what the project offers (`discover_project`), plan the tasks, follow them, answer their questions, check each result against what was asked, then hand it off.',
  'After a restart or a lost context, read the current task state before acting on an older event.',
  'Stay inside the goal and authority you were given; take a decision that is not yours to the person.',
  'When the project lacks a capability, such as version control, a code host or an automated check, deliver the result locally and say which evidence is unavailable; never invent a check.',
  'When the project uses GitHub and `gh` is available, get GitHub facts (labels, review verdicts, merge state) from `gh`, which the MCP does not carry.',
  'You do not edit files yourself; tasks do the work, each in an isolated working copy (a Git worktree) or in the project folder, as the task was started.',
].join('\n');

/**
 * The remedy for every OpenCode blocker. OpenCode's adapter is the one that names no `fix` of its
 * own, so this sentence answers both a refused attach (#651) and a blocker raised later on the
 * delivery path — one wording, so the two cannot drift apart.
 */
const OPENCODE_BLOCKER_FIX = 'Check that `opencode serve` is running in this project and the session id is right, then attach it again.';

/**
 * How long the attach-time check may take before the address counts as unreachable (#651). A bound
 * is load-bearing: `POST /api/v1/mcp/leader` awaits this, so an address that accepts a connection and
 * then never answers — a paused `opencode serve` is exactly that — would otherwise hang the person's
 * Attach leader click with no answer at all.
 */
const OPENCODE_ATTACH_CHECK_MS = 10_000;

/**
 * The attach-time targeting check (#651): reuses the adapter's OWN `checkTarget`, which is the same
 * `#checkSession` the delivery path runs, so attach and delivery can never disagree about whether a
 * session is usable. `undefined` means the session exists and is this project's.
 *
 * Every outcome is a recoverable blocker the person reads, never a throw: an unreachable or silent
 * server answers `server-unreachable` rather than an AbortError, because failing closed is the point
 * — a target xezar could not check is not a target it attaches.
 */
async function checkOpenCodeAttach(adapter: OpenCodeReactionAdapter): Promise<McpLeaderBlocker | undefined> {
  try {
    await adapter.checkTarget(AbortSignal.timeout(OPENCODE_ATTACH_CHECK_MS));
    return undefined;
  } catch (err) {
    if (err instanceof OpenCodeDeliveryBlocked) return { code: err.blocker.code, message: err.blocker.message, fix: OPENCODE_BLOCKER_FIX };
    return {
      code: 'server-unreachable',
      message: `xezar could not check that OpenCode session before attaching it: the server did not answer (${err instanceof Error ? err.message : String(err)}). Nothing was attached.`,
      fix: OPENCODE_BLOCKER_FIX,
    };
  }
}

/**
 * Nothing attached. The first thing a person reads before attaching, so it says which clients only
 * READ their events and which can be ATTACHED, and gives Codex's own path — start, discovery, retry
 * (round-4 review, major 2; it used to tell a Codex user their session had no address).
 */
const NO_LEADER: McpLeaderBlocker = {
  code: 'no-leader-session',
  message:
    'No leader session is attached to this project, so events are kept in the journal, not pushed. Attached is how a leader normally receives them; reading with leader_events is the fallback. MCP notifications start no turn on their own. A pi without xezar’s leader extension reads its events with the leader_events tool, and so does any leader until it is attached. A Claude Code session started with --dangerously-load-development-channels server:xezar, a Codex session running on Codex’s shared local app-server, an OpenCode session you run with `opencode serve`, or a pi running xezar’s leader extension can be attached, so events start a turn in it.',
  fix: 'Attach your leader from the leader itself: call leader_events with action attach and a new operationId; xezar takes the client from the session, so you never name it. Until it is attached, keep using leader_events from it. For Claude Code: start it in this project with --dangerously-load-development-channels server:xezar, let it call a xezar tool once, then attach it. For Codex: run it on Codex’s shared local app-server (`codex app-server --listen unix://`, in the Codex home xezar uses), let the session call a xezar tool once (for example leader_events) so xezar can find it, then attach it; if that is refused, fix what the refusal names and retry. For OpenCode, a person attaches the session you run with `opencode serve` in Settings → MCP connection. For pi, attach it while it runs xezar’s leader extension.',
};

/**
 * Attach refused because the MCP session that owns the project is not a Claude Code session, so
 * there is no Claude Code leader to push a channel event to (decision record § 5.6). Verbatim.
 */
const CLAUDE_CODE_NOT_OWNER: McpLeaderBlocker = {
  code: 'claude-code-not-owner',
  message:
    'The MCP session that owns this project is not a Claude Code session, so there is no Claude Code leader to push events to. Events are kept in the journal.',
  fix: 'Start Claude Code in this project with --dangerously-load-development-channels server:xezar, let it call a xezar tool once, then attach it again.',
};

/**
 * Attach refused because the owner session's bridge predates `leader/push`, so it cannot deliver a
 * channel event — pushing into it would choke a bridge that treats the frame as garbage. Verbatim
 * (decision record § 5.6).
 */
const CLAUDE_CODE_BRIDGE_TOO_OLD: McpLeaderBlocker = {
  code: 'claude-code-bridge-too-old',
  message:
    'This Claude Code session is connected through an older xezar MCP bridge that cannot push events. Events are kept in the journal.',
  fix: 'Restart Claude Code so it starts the current xezar bridge (npx -y @qodeca/xezar mcp), then attach it again.',
};

/**
 * #450: the owner session is a channel-capable Claude Code bridge, but its `initialize` handshake did
 * not register `claude/channel` (xezar answered that it could not push when the session connected).
 * Claude Code fixes capabilities at `initialize`, so a pushed event would never reach the model.
 */
const CLAUDE_CODE_CHANNEL_NOT_ADVERTISED: McpLeaderBlocker = {
  code: 'claude-code-channel-not-advertised',
  message:
    'This Claude Code session connected while xezar could not push to it, so its xezar MCP server did not register the channel and a pushed event would never reach the model. Events are kept in the journal.',
  fix: 'Reconnect the xezar MCP server in Claude Code (/mcp, then reconnect xezar) or restart Claude Code while the cockpit runs, then attach it again (from Claude Code: leader_events with action attach). Until then, read events with leader_events.',
};

/**
 * #450 — which leader client an MCP session is, from what the SESSION showed, never from an argument.
 * Exact matches only (#374: never a looser match). A Codex announcement wins: it is how a Codex session
 * identifies itself on its tool calls. The names are the ones each client's evidence record measured:
 * `claude-code` (Claude Code 2.1.270), `codex-mcp-client` (codex-cli), `pi-mcp-xezar` (pi-mcp-adapter
 * 2.32.1, not re-measured) and `opencode`.
 */
export function leaderClientOf(evidence: { readonly clientName?: string | undefined; readonly codexAnnounced: boolean }): McpLeaderClient | null {
  if (evidence.codexAnnounced) return 'codex';
  switch (evidence.clientName) {
    case 'claude-code':
      return 'claude-code';
    case 'codex-mcp-client':
      return 'codex';
    case 'pi-mcp-xezar':
      return 'pi';
    case 'opencode':
      return 'opencode';
    default:
      return null;
  }
}

/** The door's refusals (#450): what went wrong, and what the leader does next. `attach-refused` carries the client's own. */
const DOOR_REFUSALS: Record<Exclude<McpLeaderDoorRefusalCode, 'attach-refused' | 'leader-attached-elsewhere' | 'leader-not-this-session'>, { readonly message: string; readonly fix: string }> = {
  'delivery-unavailable': {
    message: 'xezar has no event delivery for this project (its event journal did not open or cannot be written), so no leader can be attached.',
    fix: 'The cockpit log names the reason. Report it to the person; read events with leader_events if it answers.',
  },
  'hosted-mode': {
    message: 'This xezar runs in hosted mode, and a leader is attached only from the machine that owns the checkout.',
    fix: 'Run the leader on the xezar host against a cockpit bound to 127.0.0.1, or read events with leader_events.',
  },
  'not-owner': {
    message: 'This session no longer owns the project, so it cannot attach or detach its leader.',
    fix: 'Call any xezar tool once so this session reconnects, then call leader_events with action status.',
  },
  'client-unknown': {
    message: 'xezar cannot tell which leader client this session is, so there is nothing it could push to.',
    fix: 'Attach from a Claude Code, Codex or pi leader. Until then, read events with leader_events.',
  },
  'client-needs-address': {
    message: 'An OpenCode leader is reached at the address of the opencode serve session, which xezar does not take from an MCP session.',
    fix: 'A person attaches this session in Settings → MCP connection. Until then, read events with leader_events.',
  },
};

/** `pushUnavailable.message` per code (#450). */
const PUSH_UNAVAILABLE: Record<McpPushUnavailableCode, string> = {
  'delivery-unavailable': DOOR_REFUSALS['delivery-unavailable'].message,
  'hosted-mode': DOOR_REFUSALS['hosted-mode'].message,
  'client-unknown': 'xezar cannot tell which leader client this session is.',
  'client-needs-address': 'An OpenCode leader is attached by a person, with its opencode serve address.',
  'bridge-too-old': CLAUDE_CODE_BRIDGE_TOO_OLD.message,
  'channel-not-advertised': CLAUDE_CODE_CHANNEL_NOT_ADVERTISED.message,
};

const cannotPush = (code: McpPushUnavailableCode): McpPushCapability => ({ canPush: false, pushUnavailable: { code, message: PUSH_UNAVAILABLE[code] } });

/**
 * Every blocker about an ATTACHED leader is written in that leader's client's own words.
 *
 * It used to be written in OpenCode's, for all of them, so a pi user who hit one was told to check
 * an `opencode serve` they are not running (QA on #358, finding 3) — at the exact moment they needed
 * the right thing to check. The two clients are reached in completely different ways: OpenCode's
 * leader is an HTTP server the person runs, pi's is a Unix socket xezar's leader extension opens
 * from INSIDE the person's own pi, so "check the server" has no shared spelling.
 *
 * Four can be attached (`mcpLeaderAttachInputSchema` in the contract): OpenCode, pi, Codex and — since
 * #374 — Claude Code, over its channel. `NO_LEADER` above names every client itself. Typed
 * `Record<McpLeaderSession['client'], …>` on purpose: a fifth attachable client is then a compile
 * error here, rather than a message that quietly names the wrong client again.
 */
const CLIENT_WORDS: Record<
  McpLeaderSession['client'],
  { readonly name: string; readonly lazyMcp: string; readonly check: string; readonly checkShort: string; readonly reattach: string }
> = {
  opencode: {
    name: 'OpenCode',
    lazyMcp: ' OpenCode connects its xezar MCP server only when it first needs it.',
    check: 'check that `opencode serve` is running and answering (a paused process still accepts connections)',
    checkShort: 'check that `opencode serve` is running and answering',
    reattach: 'attach the session again',
  },
  pi: {
    // Nothing is claimed about WHEN pi opens its MCP connection, because nothing here measured it;
    // the fix below works whenever it does.
    name: 'pi',
    lazyMcp: '',
    check: 'check that the pi you attached is still running with xezar’s leader extension loaded (a paused process still holds its socket open)',
    checkShort: 'check that the pi you attached is still running with xezar’s leader extension loaded',
    reattach: 'attach it again',
  },
  codex: {
    name: 'Codex',
    lazyMcp: '',
    check: 'check that this Codex session is still available on Codex’s local app-server',
    checkShort: 'check that this Codex session is still available on Codex’s local app-server',
    reattach: 'retry connecting when this session is available',
  },
  'claude-code': {
    // Reached through the owner session's own bridge, so "check the leader" is "check Claude Code is
    // still running with the channel loaded" — there is no separate server the person runs.
    name: 'Claude Code',
    lazyMcp: '',
    check: 'check that Claude Code is still running, and was started with `--dangerously-load-development-channels server:xezar`',
    checkShort: 'check that Claude Code is still running with the xezar channel loaded',
    reattach: 'attach it again',
  },
};

/**
 * #331: a leader is attached, but no MCP session owns the project, so no controller follows the
 * journal and nothing is delivered. The ORDINARY first state: OpenCode connects its MCP servers
 * lazily, so "attach first, MCP session later" is what a first user sees.
 */
const noOwnerSession = (client: McpLeaderSession['client']): McpLeaderBlocker => {
  const words = CLIENT_WORDS[client];
  return {
    code: 'no-owner-session',
    message: `A ${words.name} leader is attached, but no MCP session owns this project yet, so nothing follows the event journal and nothing is delivered.${words.lazyMcp} Events are kept in the journal meanwhile.`,
    fix: `Let the attached ${words.name} session call a xezar tool once (for example leader_events), so its MCP connection opens; it then receives every event it has not acknowledged.`,
  };
};

/**
 * Events are waiting and the last attempt to hand them to THIS leader did not get through — a
 * refused request, a dropped connection, a server that accepts and never answers, or a leader busy
 * in a long turn. xezar cannot tell those apart (the adapter waits for the session to be free, and a
 * long turn looks exactly like silence), so the text names both and diagnoses neither (QA on #311,
 * round five). The fact behind it is recorded against the LEADER, so it survives a session change and
 * is never inherited by a leader that has just been attached.
 */
const deliveryFailing = (client: McpLeaderSession['client']): McpLeaderBlocker => {
  const words = CLIENT_WORDS[client];
  return {
    code: 'delivery-failing',
    message: `Events are waiting, and the last attempt to hand them to the attached ${words.name} leader did not get through. It may be busy in a long turn, or it may have stopped answering — xezar cannot tell those apart, and keeps retrying while this MCP session owns the project. Nothing is lost: the events stay in the journal.`,
    fix: `If the leader is working, nothing is needed: the events go as soon as it is free. Otherwise ${words.check}, or ${words.reattach}.`,
  };
};

/** The same fact with nothing waiting: the leader did not answer xezar’s last liveness check. */
const leaderNotAnswering = (client: McpLeaderSession['client']): McpLeaderBlocker => {
  const words = CLIENT_WORDS[client];
  return {
    code: 'leader-not-answering',
    message: `The attached ${words.name} leader did not answer xezar’s last liveness check — it may be busy, or gone. Nothing is waiting right now; the next event would be retried until it answers.`,
    fix: `If the leader is working, nothing is needed. Otherwise ${words.checkShort}, or ${words.reattach}.`,
  };
};

/** #309 O-3: a journal that records nothing has nothing to deliver, so a leader would never hear a thing. */
const JOURNAL_UNWRITABLE: McpLeaderBlocker = {
  code: 'journal-unwritable',
  message:
    'xezar cannot write this project’s event journal, so no event is recorded and none can be delivered. The cockpit log names the file and the error.',
  fix: 'Make the project’s .local/xezar/mcp folder writable, then restart xezar.',
};

/** The answer while the service is stopping — the route's and the door's. */
const STOPPING = 'the MCP service for this project is stopping';

/** What `#act` answers: the route's result, and on a refusal the blocker object the door hands on (#450). */
type ActOutcome = { ok: true; status: McpLeaderStatus } | { ok: false; error: string; blocker?: McpLeaderBlocker };

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
  /**
   * The Codex attach path. `home` is where the service looks for the shared app-server — its own
   * `CODEX_HOME`, else `~/.codex` (`codexControlHome`); `connect` is the test seam for the dial.
   */
  readonly codexLeader?: {
    connect?: (announcement: CodexLeaderAnnouncement, projectRoot: string, codexHome: string) => Promise<ConnectedCodexLeader>;
    home?: () => string;
  };
  /** Local socket delivery is forbidden when the server is hosted. */
  readonly localHandoff?: () => boolean;
  /**
   * `status()` may answer differently now (#374, round 5 on #403): the cockpit's `mcp-leader` topic
   * re-derives it. Called after the change, never throws into the caller.
   */
  readonly onStatusChange?: () => void;
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
  /** Codex only: the adapter itself, so a re-attach to the same thread inherits an unresolved hand-off. */
  readonly codex?: CodexReactionAdapter;
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
  /**
   * The owner session's transport, when one is open (#374). It is how a Claude Code channel push
   * reaches the bridge, and it carries what that bridge announced — its client name and whether it
   * understands `leader/push`. Keyed alongside the session key so a stale close cannot clear a newer
   * owner's transport.
   */
  #ownerTransport: McpSessionTransport | undefined;
  #ownerSessionKey: string | undefined;
  /** The attached leader session and the facts observed against it. xezar never started it. */
  #leader: AttachedLeader | undefined;
  /** One `act` at a time: two concurrent attaches must not leave two adapters behind. */
  #acting: Promise<unknown> = Promise.resolve();
  readonly #codexAnnouncements = new Map<string, CodexLeaderAnnouncement>();
  /**
   * The last refused Codex attach, and the owner session it was refused for. The status names it,
   * with its own fix, while nothing is attached and that session still owns the project (NB-1). A
   * successful attach, a stop or a different owner clears it; an announcement clears the refusal it
   * answers ("has not called a tool yet").
   */
  #refusal: { readonly sessionKey: string; readonly reason: CodexUnreachableReason; readonly blocker: McpLeaderBlocker } | undefined;
  #closed = false;

  constructor(opts: LeaderDeliveryOptions) {
    this.projectId = opts.projectId;
    this.#opts = opts;
  }

  // ---- the transport's side: one controller per owner session ------------------------------

  /** `session/open` made `sessionKey` the owner. Never throws into the transport (N-07). */
  sessionOpened(sessionKey: string, transport?: McpSessionTransport): void {
    if (this.#closed || this.#controllers.has(sessionKey)) return;
    // Only one session owns the project, so any other controller serves a session that lost it —
    // one whose lease lapsed while its connection stayed open. End it now rather than at its next
    // tick: the journal allows one dispatcher, and it must be the owner's.
    for (const [key, controller] of this.#controllers) {
      controller.close();
      this.#controllers.delete(key);
    }
    // #374: this session's transport is now the one a Claude Code channel push travels down.
    this.#ownerTransport = transport;
    this.#ownerSessionKey = sessionKey;
    if (this.#leader?.client === 'claude-code' && transport) {
      const blocker = this.#channelEligibility(transport);
      if (blocker) this.#opts.warn(`[xez] ${blocker.code}: ${blocker.message} fix: ${blocker.fix}`);
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
    this.#changed();
  }

  /** The session's connection closed (D-02.4): its controller ends. The journal keeps every row. */
  sessionClosed(sessionKey: string): void {
    this.#codexAnnouncements.delete(sessionKey);
    this.#controllers.get(sessionKey)?.close();
    this.#controllers.delete(sessionKey);
    // #374: only clear the transport if THIS session owned it — a stale close must not drop a newer
    // owner's channel connection.
    if (this.#ownerSessionKey === sessionKey) {
      this.#ownerTransport = undefined;
      this.#ownerSessionKey = undefined;
    }
    this.#changed();
  }

  /** Metadata arrives from the owner bridge, never from the HTTP attach request. */
  codexAnnounced(sessionKey: string, announcement: CodexLeaderAnnouncement): void {
    if (this.#opts.ownership.sessionToken(sessionKey) === undefined) return;
    this.#codexAnnouncements.set(sessionKey, announcement);
    if (this.#refusal?.reason === 'not-announced' && this.#refusal.sessionKey === sessionKey) this.#refusal = undefined;
    this.#changed();
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
      return { handedThrough: null, dispatchDelivered: false };
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
      // The cursors, the adapter's blocker and `failingSince` may all have moved.
      this.#changed();
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
      owner: this.#owner(),
      leader: this.#leaderSession(),
      delivery: controller ? controller.status() : null,
      blocker: this.#blocker(),
    };
  }

  act(input: McpLeaderActionInput): Promise<LeaderActResult> {
    // The route answers today's strings, byte for byte (#450): the blocker object stays internal.
    return this.#queued(() => this.#act(input)).then((result) => (result.ok ? result : { ok: false, error: result.error }));
  }

  // ---- the MCP door: `leader_events` attach, stop and status, for the CALLING session (#450) ----

  /**
   * Can xezar push to this session's client? Answered in `session/open` so the bridge registers the
   * Claude Code channel only when a push could ever arrive, and in `status`. First match wins. Codex and
   * pi answer `true` here: their attach still checks the app-server or the extension's descriptor.
   */
  pushCapability(sessionKey: string, transport: McpSessionTransport | undefined): McpPushCapability {
    if (this.#closed || !this.#opts.journal.writable) return cannotPush('delivery-unavailable');
    if (this.#opts.localHandoff?.() === false) return cannotPush('hosted-mode');
    const client = this.#clientOf(sessionKey, transport);
    if (client === null) return cannotPush('client-unknown');
    if (client === 'opencode') return cannotPush('client-needs-address');
    if (client === 'claude-code' && transport?.leaderPush !== true) return cannotPush('bridge-too-old');
    if (client === 'claude-code' && transport?.channelAdvertised === false) return cannotPush('channel-not-advertised');
    return { canPush: true };
  }

  /** The route's status, plus what is true for this session. Never refused; unavailable only while stopping. */
  sessionStatus(sessionKey: string): McpLeaderSelfStatus {
    if (this.#closed) return { available: false, reason: STOPPING };
    const transport = this.#transportOf(sessionKey);
    const client = this.#clientOf(sessionKey, transport);
    const capability = this.pushCapability(sessionKey, transport);
    const controller = this.#liveController();
    return {
      available: true,
      owner: this.#owner(),
      leader: this.#leaderSession(),
      delivery: controller ? controller.status() : null,
      blocker: this.#blocker(),
      canPush: capability.canPush,
      pushUnavailable: capability.canPush ? null : capability.pushUnavailable,
      self: { client, isOwner: sessionKey === this.#liveKey(), attached: this.#attachedHere(sessionKey, client) },
    };
  }

  /** Attach this session's own client. Never names a client from outside, never replaces another client's leader. */
  attachSession(sessionKey: string): Promise<McpLeaderDoorResult> {
    return this.#queued(() => this.#attachSession(sessionKey));
  }

  /** Detach this session's own leader, and only that. */
  stopSession(sessionKey: string): Promise<McpLeaderDoorResult> {
    return this.#queued(() => this.#stopSession(sessionKey));
  }

  async #attachSession(sessionKey: string): Promise<McpLeaderDoorResult> {
    const fence = this.#doorFence(sessionKey);
    if ('code' in fence) return this.#refuse('attach', sessionKey, fence.code);
    const { client } = fence;
    const leader = this.#leader;
    // A leader a person or another session attached is never replaced by a model.
    if (leader !== undefined && leader.client !== client) return this.#refuse('attach', sessionKey, 'leader-attached-elsewhere');
    // Claude Code's adapter already follows the live owner's transport: re-attaching would only reset
    // the push-unconfirmed age and hide a real blocker. Codex and pi re-run the attach, which replaces
    // the link and, for Codex, reconciles an unresolved hand-off.
    if (leader?.client === 'claude-code') return { ok: true, action: 'attach', outcome: 'already-attached', status: this.sessionStatus(sessionKey) };
    const acted = await this.#act({ action: 'attach', client } as McpLeaderActionInput);
    if (!acted.ok) {
      const blocker = acted.blocker ?? { code: 'attach-refused', message: acted.error, fix: 'Read events with leader_events until the refusal is resolved.' };
      return { ok: false, action: 'attach', code: 'attach-refused', message: blocker.message, fix: blocker.fix, blocker, status: this.sessionStatus(sessionKey) };
    }
    return { ok: true, action: 'attach', outcome: 'attached', status: this.sessionStatus(sessionKey) };
  }

  async #stopSession(sessionKey: string): Promise<McpLeaderDoorResult> {
    const fence = this.#doorFence(sessionKey);
    if ('code' in fence) return this.#refuse('stop', sessionKey, fence.code);
    const leader = this.#leader;
    if (leader === undefined) return { ok: true, action: 'stop', outcome: 'already-stopped', status: this.sessionStatus(sessionKey) };
    if (!this.#attachedHere(sessionKey, fence.client)) return this.#refuse('stop', sessionKey, 'leader-not-this-session');
    await this.#act({ action: 'stop' });
    return { ok: true, action: 'stop', outcome: 'stopped', status: this.sessionStatus(sessionKey) };
  }

  /** The checks attach and stop share, in order. The session's client when every one passes. */
  #doorFence(sessionKey: string): { code: keyof typeof DOOR_REFUSALS } | { client: Exclude<McpLeaderClient, 'opencode'> } {
    if (this.#closed || !this.#opts.journal.writable) return { code: 'delivery-unavailable' };
    // The same boundary as the route's 409 (`server.ts`). Absent `localHandoff` is a test composition: local.
    if (this.#opts.localHandoff?.() === false) return { code: 'hosted-mode' };
    if (sessionKey !== this.#liveKey()) return { code: 'not-owner' };
    const client = this.#clientOf(sessionKey, this.#transportOf(sessionKey));
    if (client === null) return { code: 'client-unknown' };
    if (client === 'opencode') return { code: 'client-needs-address' };
    return { client };
  }

  #refuse(action: 'attach' | 'stop', sessionKey: string, code: Exclude<McpLeaderDoorRefusalCode, 'attach-refused'>): McpLeaderDoorResult {
    const name = this.#leader === undefined ? 'another' : CLIENT_WORDS[this.#leader.client].name;
    const an = /^[AEIOU]/.test(name) ? 'An' : 'A';
    const texts =
      code === 'leader-attached-elsewhere'
        ? {
            message: `${an} ${name} leader is already attached to this project, and xezar does not replace it from another session. Nothing was attached.`,
            fix: 'Report it to the person: that leader can call leader_events with action stop, or the person attaches this session in Settings → MCP connection. Until then, read events with leader_events.',
          }
        : code === 'leader-not-this-session'
          ? {
              message: `The attached leader is ${an.toLowerCase()} ${name} session, not this one, so nothing was detached.`,
              fix: 'Only that leader, or a person in Settings → MCP connection, changes it.',
            }
          : DOOR_REFUSALS[code];
    return { ok: false, action, code, message: texts.message, fix: texts.fix, blocker: null, status: this.sessionStatus(sessionKey) };
  }

  #transportOf(sessionKey: string): McpSessionTransport | undefined {
    return sessionKey === this.#ownerSessionKey ? this.#ownerTransport : undefined;
  }

  #clientOf(sessionKey: string, transport: McpSessionTransport | undefined): McpLeaderClient | null {
    return leaderClientOf({ clientName: transport?.clientName, codexAnnounced: this.#codexAnnouncements.has(sessionKey) });
  }

  /** The attached leader is this session's own: its client, this session owns the project, and for Codex its thread. */
  #attachedHere(sessionKey: string, client: McpLeaderClient | null): boolean {
    const leader = this.#leader;
    if (leader === undefined || client === null || leader.client !== client || sessionKey !== this.#liveKey()) return false;
    return client !== 'codex' || leader.codex?.threadId === this.#codexAnnouncements.get(sessionKey)?.threadId;
  }

  /** One act at a time, and every outcome may change the status: an attach, a stop, and a refusal the status then names. */
  #queued<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#acting.then(work).finally(() => this.#changed());
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
    this.#changed();
  }

  // ---- internals ----------------------------------------------------------------------------

  async #act(input: McpLeaderActionInput): Promise<ActOutcome> {
    if (this.#closed) return { ok: false, error: STOPPING };
    if (input.action === 'stop') {
      this.#detach();
      this.#refusal = undefined;
      return { ok: true, status: this.status() };
    }
    // Attaching a leader that can never receive an event would answer 200 with a blocker-free status
    // for a path that delivers nothing (#309 O-3). Refuse, and say why.
    if (!this.#opts.journal.writable) return { ok: false, error: JOURNAL_UNWRITABLE.message, blocker: JOURNAL_UNWRITABLE };
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
        return { ok: false, error: target.blocker.message, blocker: { code: target.blocker.code, message: target.blocker.message, fix: target.blocker.fix } };
      }
      this.#detach();
      this.#refusal = undefined;
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
    if (input.client === 'codex') {
      const found = await this.#codexTarget();
      if (found.target.kind === 'blocked') {
        if (found.reason === undefined) {
          const { code, message, remedy } = found.target.blocker;
          return { ok: false, error: message, blocker: { code, message, fix: remedy } };
        }
        // The answer is the decision record's verbatim copy followed by THIS refusal's fix, so a
        // re-attach refused while an attached leader shows another blocker still says why. The status
        // names it too while nothing is attached — for the owner session it was refused for, and only
        // when there is one: a refusal made with no owner would match "no owner" for ever.
        const blocker = codexBlocker(found.reason);
        const key = this.#liveKey();
        if (key !== undefined) this.#refusal = { sessionKey: key, reason: found.reason, blocker };
        return { ok: false, error: `${blocker.message} ${blocker.fix}`, blocker };
      }
      this.#detach();
      this.#refusal = undefined;
      this.#leader = { client: 'codex', adapter: found.target.adapter, codex: found.target.adapter, failingSince: null, settledThrough: 0, ...(found.dispose ? { dispose: found.dispose } : {}) };
      this.#liveController()?.wake();
      return { ok: true, status: this.status() };
    }
    if (input.client === 'claude-code') {
      // #374: the target is the owner MCP session itself, reached by writing a channel push down its
      // own bridge. Validate the owner NOW, at attach (record § 5.4): a session that is not Claude
      // Code, or one whose bridge is too old to push, is refused with its own recoverable reason —
      // and a refused attach keeps the previous leader, like pi's. With no owner session yet, attach
      // anyway and let `noOwnerSession` report it, exactly as OpenCode and pi do.
      const transport = this.#ownerTransport;
      if (transport !== undefined) {
        const blocker = this.#channelEligibility(transport);
        if (blocker) return { ok: false, error: `${blocker.message} fix: ${blocker.fix}`, blocker };
      }
      this.#detach();
      this.#refusal = undefined;
      this.#leader = {
        client: 'claude-code',
        adapter: new ClaudeCodeChannelAdapter({
          projectId: this.projectId,
          roleInstruction: LEADER_ROLE_INSTRUCTION,
          push: (content, meta, signal) => this.#pushChannel(content, meta, signal),
          alive: () => this.#ownerTransport !== undefined,
          // reactedSeq stays 0 for Claude Code (no observable reaction), so the only cursor the
          // push-unconfirmed blocker compares against is the leader's own acknowledgement.
          acknowledged: () => this.#opts.leaderRecord?.acknowledged() ?? 0,
          heartbeatMs: this.#opts.heartbeatMs ?? EVENT_CONTROLLER_HEARTBEAT_MS,
        }),
        failingSince: null,
        settledThrough: 0,
      };
      this.#liveController()?.wake();
      return { ok: true, status: this.status() };
    }
    // #651: the session is checked HERE, before anything is recorded. It used to be checked only on
    // the DELIVERY path, and `#blocker()` answers `no-owner-session` before it reads the adapter, so
    // a session belonging to another project — or one that does not exist at all — was accepted as
    // "attached" with no error and its refusal surfaced only once an MCP session owned the project.
    // The guide has always promised the check happens now (`docs/guide/13-mcp-leader.md`).
    // FAIL CLOSED: a server that cannot be reached is refused too, because attaching to something
    // xezar cannot check is the bug, not a lenience. Like pi's and Claude Code's, a refused attach
    // changes nothing — the previous leader, if any, is still attached and still working.
    const adapter = new OpenCodeReactionAdapter({
      target: { baseUrl: input.baseUrl, sessionId: input.sessionId },
      projectRoot: this.#opts.projectRoot,
      roleInstruction: LEADER_ROLE_INSTRUCTION,
      onReaction: (seq) => this.#recordReaction(seq),
      ...this.#ownOperation(),
    });
    const refused = await checkOpenCodeAttach(adapter);
    if (refused) {
      adapter.close();
      return { ok: false, error: `${refused.message} ${refused.fix}`, blocker: refused };
    }
    // Re-attaching replaces the previous target; xezar owns no process, so nothing else changes.
    this.#detach();
    this.#refusal = undefined;
    // A new leader with no history: whatever happened before it was attached was not about it.
    this.#leader = {
      client: 'opencode',
      adapter,
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

  /**
   * Build Codex's target. A refusal carries WHICH one it was (`reason`, NB-1): no announcement yet, or
   * the connector's own typed reason; anything else it throws is the app-server misbehaving. Hosted
   * mode carries none — its route refuses before this runs, and there is nothing local to fix.
   */
  async #codexTarget(): Promise<{ target: CodexReactionTarget; dispose?: () => void; reason?: CodexUnreachableReason }> {
    const base = { projectId: this.projectId, onReaction: (seq: number) => this.#recordReaction(seq), ...this.#ownOperation() };
    if (this.#opts.localHandoff?.() === false) return { target: codexReactionTarget(base) };
    // The LIVE owner's announcement — the same session `owner` and a refusal are read against, never
    // a controller that already ended.
    const sessionKey = this.#liveKey();
    const announcement = sessionKey === undefined ? undefined : this.#codexAnnouncements.get(sessionKey);
    if (announcement === undefined) return { target: codexReactionTarget(base), reason: 'not-announced' };
    // The discovery rule lives beside `connectCodexLeader`: the SERVICE's Codex home, confirmed by the
    // app-server's own `initialize.codexHome`, never a path from the bridge or the cockpit.
    const home = (this.#opts.codexLeader?.home ?? codexControlHome)();
    let connected: ConnectedCodexLeader;
    try {
      connected = await (this.#opts.codexLeader?.connect ?? connectCodexLeader)(announcement, this.#opts.projectRoot, home);
    } catch (err) {
      // The person reads the approved "cannot reach" copy; the log keeps WHY, so a hang-up, a missing
      // socket and an unloaded thread are told apart. Never the path: connect's errors carry none,
      // and the home is scrubbed in case a future one does.
      const reason = (err instanceof Error ? err.message : String(err)).split(home).join('<codex home>');
      this.#opts.warn(`[xez] Codex leader not attached for project ${this.projectId}: ${reason}`);
      return { target: codexReactionTarget(base), reason: err instanceof CodexAttachError ? err.reason : 'app-server' };
    }
    // A re-attach to the SAME thread inherits a hand-off whose acceptance is still unknown, so the new
    // link reconciles it before resending (decision record § 4) instead of resending blind.
    const previous = this.#leader?.codex;
    const unresolved = previous?.threadId === connected.threadId ? previous.unresolved : undefined;
    const target = codexReactionTarget({ ...base, link: connected.link, threadId: connected.threadId, state: connected.state, ...(unresolved ? { unresolved } : {}) });
    if (target.kind === 'blocked') { connected.link.close(); return { target }; }
    return { target, dispose: () => connected.link.close() };
  }

  /**
   * Push a channel message down the CURRENT owner session's bridge (#374), honouring the attempt's
   * abort so a controller that gave up does not wait on a late confirmation. No owner session means
   * nothing to push to: the reject is a delivery failure the controller retries, and `noOwnerSession`
   * / the blocker rules explain it.
   */
  #pushChannel(content: string, meta: Record<string, string>, signal: AbortSignal): Promise<void> {
    const transport = this.#ownerTransport;
    if (transport === undefined) {
      return Promise.reject(new Error('no Claude Code MCP session owns this project, so there is nothing to push a channel event to'));
    }
    const blocker = this.#channelEligibility(transport);
    if (blocker) return Promise.reject(new Error(`${blocker.message} fix: ${blocker.fix}`));
    return abortable(transport.push(content, meta), signal);
  }

  #channelEligibility(transport: McpSessionTransport): McpLeaderBlocker | null {
    // Pre-Channels bridges announce neither field. Unknown identity needs the update remedy.
    if (transport.clientName === undefined) return CLAUDE_CODE_BRIDGE_TOO_OLD;
    if (transport.clientName !== 'claude-code') return CLAUDE_CODE_NOT_OWNER;
    if (transport.leaderPush !== true) return CLAUDE_CODE_BRIDGE_TOO_OLD;
    // #450: the handshake did not register the channel, so a push would never reach the model.
    if (transport.channelAdvertised === false) return CLAUDE_CODE_CHANNEL_NOT_ADVERTISED;
    return null;
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

  /** The session key of the live owner controller, when a session owns the project. */
  #liveKey(): string | undefined {
    for (const [key, controller] of this.#controllers) if (controller.state !== 'ended') return key;
    return undefined;
  }

  /**
   * Who owns the project, as far as xezar has IDENTIFIED it. A Codex session identifies itself by the
   * thread id its tool calls carry; a Claude Code session by the `clientName` its channel-capable
   * bridge announced at `session/open` (#374, exactly `claude-code`, never a looser match). Every
   * other owner reads `client: null`, never a guess. A client identified another way is one more
   * branch here and one more enum member in the contract.
   */
  #owner(): McpLeaderOwner | null {
    const key = this.#liveKey();
    if (key === undefined) return null;
    if (this.#codexAnnouncements.has(key)) return { client: 'codex' };
    if (this.#ownerSessionKey === key && this.#ownerTransport?.clientName === 'claude-code') return { client: 'claude-code' };
    return { client: null };
  }

  #recordReaction(seq: number): CursorAdvance {
    const advance = this.#liveController()?.recordReaction(seq) ?? { status: 'inactive', seq: 0 };
    this.#changed();
    return advance;
  }

  /** Tell the cockpit topic the status may have changed. Its failure is never the delivery path's. */
  #changed(): void {
    try {
      this.#opts.onStatusChange?.();
    } catch (err) {
      this.#opts.warn(`[xez] the leader status listener failed for project ${this.projectId} (${err instanceof Error ? err.message : String(err)})`);
    }
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
    // Nothing attached: a refused attach for THIS owner says which refusal it was and its fix (NB-1).
    if (leader === undefined) return this.#refusal !== undefined && this.#refusal.sessionKey === this.#liveKey() ? this.#refusal.blocker : NO_LEADER;
    // Attached, but nobody owns the project: no controller, so nothing is delivered (#331).
    const controller = this.#liveController();
    if (controller === undefined) return noOwnerSession(leader.client);
    if (leader.client === 'claude-code' && this.#ownerTransport) {
      const eligibility = this.#channelEligibility(this.#ownerTransport);
      if (eligibility) return eligibility;
    }
    const blocker = leader.adapter.status().blocker;
    if (blocker) {
      // The adapter's own `fix` when it has one (pi's does; `PiReactionAdapter.#block` always sets
      // one, and `piReactionTarget`'s own blocker carries `PI_EXTENSION_FIX`), otherwise the
      // OpenCode wording, which is the only adapter whose blockers name no remedy of their own.
      const fix = blocker.fix ?? OPENCODE_BLOCKER_FIX;
      return { code: blocker.code, message: blocker.message, fix };
    }
    // From FACTS observed against THIS leader, never from the controller's state machine (rounds four
    // and five): a failed attempt with no success since is a blocker in every state, it survives the
    // session being replaced, and a leader just attached has none. `state` is shown, and decides nothing.
    if (leader.failingSince !== null) return this.#owed(leader) ? deliveryFailing(leader.client) : leaderNotAnswering(leader.client);
    return null;
  }
}

/** Reject as soon as `signal` aborts, without waiting for `work`; a late settle then goes nowhere. */
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
