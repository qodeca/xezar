import { z } from 'zod';

/**
 * #309 — the project's push-delivery path to its leader (`GET/POST /api/v1/mcp/leader`).
 *
 * Push delivery is ON BY DEFAULT: every MCP session that owns a project gets an event controller
 * (#107) the moment it opens. What it cannot do on its own is reach a model — generic MCP
 * notifications start no turn in any of the four clients (D-05 § 4; #330 run A for pi). An event
 * therefore reaches a leader only through a session the person runs and tells xezar where to find:
 * an OpenCode `serve` session, or a pi running xezar's leader extension. xezar NEVER starts an agent
 * process for a leader (owner decision on #311): the person runs their own leader, in their own
 * terminal, with their own tool, and it connects to xezar over MCP. A Codex session running on Codex's
 * shared local app-server can be attached too (#374): xezar finds that already-running session and
 * starts events as turns in it. Claude Code can be pushed to (#374) through Claude Code Channels,
 * which the person opts into per launch with `--dangerously-load-development-channels server:xezar`.
 * A Claude Code launched without that flag, a Codex session off the shared app-server and a pi with
 * no xezar leader extension loaded read their events with the `leader_events` tool instead.
 */

/**
 * What the route does. `attach` names a leader session the person already runs; `stop` detaches it —
 * never a task, never the client's process, and never the MCP session's hold on the project. There
 * is no `start` or `resume`: xezar spawns no leader.
 *
 * Four clients can be attached, and they carry their address differently. `opencode` names an
 * `opencode serve` session by URL and session id. `pi` names NOTHING here, on purpose, and that is
 * not the same as having no address: pi speaks RPC over its own stdin and stdout only (pi 0.85.1,
 * `docs/rpc.md`), so there is nothing for xezar to dial from outside — the address instead comes
 * from inside the person's own pi, where xezar's leader extension opens a socket and announces it in
 * the project's data directory (#330 WP2). The person pastes nothing, so this variant takes nothing.
 * With no extension running there is no descriptor, and the action answers with pi's own recoverable
 * reason (`pi-not-addressable`) rather than a schema error. `codex` (#374) names nothing either: the
 * owning Codex session announces its own thread id on its tool calls, and xezar finds the shared
 * app-server in its own Codex home. It never takes a socket path, port, home or thread id from here;
 * a refusal answers Codex's recoverable reason and keeps a leader that is already working.
 * `claude-code` (#374) also takes no address: the target is the owner MCP session itself, and xezar
 * wakes it by writing a `notifications/claude/channel` message down that session's own bridge
 * stdout. It answers a recoverable reason (`claude-code-not-owner`, `claude-code-bridge-too-old`)
 * when the owner session is not a channel-capable Claude Code bridge.
 */
const mcpLeaderAttachInputSchema = z.discriminatedUnion('client', [
  z.strictObject({
    action: z.literal('attach'),
    client: z.literal('opencode'),
    baseUrl: z.url({ protocol: /^https?$/ }).max(500),
    sessionId: z.string().trim().min(1).max(200),
  }),
  z.strictObject({ action: z.literal('attach'), client: z.literal('pi') }),
  z.strictObject({ action: z.literal('attach'), client: z.literal('codex') }),
  // Claude Code (#374, epic #73). It carries NO address on purpose, like pi: the target is the
  // owner MCP session itself — the `xez mcp` bridge the person's Claude Code spawned — and xezar
  // reaches it by writing a `notifications/claude/channel` message down that bridge's own stdout,
  // which Claude Code Channels turns into a model turn. The person opts in per launch with
  // `claude --dangerously-load-development-channels server:xezar`; with no such owner session the
  // action answers a recoverable reason rather than a schema error. Adding a required field here is
  // breaking.
  z.strictObject({ action: z.literal('attach'), client: z.literal('claude-code') }),
]);

export const mcpLeaderActionInputSchema = z.union([
  mcpLeaderAttachInputSchema,
  z.strictObject({ action: z.literal('stop') }),
]);
export type McpLeaderActionInput = z.infer<typeof mcpLeaderActionInputSchema>;

/** Which leader client: one enum for the attached session below and for the MCP door (#450). */
export const mcpLeaderClientSchema = z.enum(['opencode', 'pi', 'codex', 'claude-code']);
export type McpLeaderClient = z.infer<typeof mcpLeaderClientSchema>;

/** The leader session attached to the project, if any. */
export const mcpLeaderSessionSchema = z.object({
  client: mcpLeaderClientSchema,
  state: z.literal('attached'),
});
export type McpLeaderSession = z.infer<typeof mcpLeaderSessionSchema>;

/**
 * The event controller of the MCP session that owns the project, when one is open. The three
 * cursors are D-05 § 6.6's, stay apart, and each reports only what HAPPENED — never where pushing
 * happened to start (QA on #311):
 * - `deliveredSeq`: the newest row really handed to the attached leader, in this journal. A row
 *   the leader caused itself (its own echo) is never handed to it and never counted, so this can stay
 *   below `latestSeq` with nothing wrong — and it says nothing about those rows;
 * - `ackedSeq`: the newest row the leader acknowledged with an explicit tool call — the same record
 *   `leader_events` keeps, so the two never disagree; 0 until it acknowledges;
 * - `reactedSeq`: the newest row a model turn was really seen to carry; 0 until one is.
 */
export const mcpLeaderDeliverySchema = z.object({
  state: z.enum(['inert', 'idle', 'dispatching', 'recovering', 'disconnected', 'ended']),
  deliveredSeq: z.number().int().nonnegative(),
  ackedSeq: z.number().int().nonnegative(),
  reactedSeq: z.number().int().nonnegative(),
  latestSeq: z.number().int().nonnegative(),
});
export type McpLeaderDelivery = z.infer<typeof mcpLeaderDeliverySchema>;

/** Why events are kept rather than delivered right now. Always recoverable: nothing is lost. */
export const mcpLeaderBlockerSchema = z.object({
  code: z.string(),
  message: z.string(),
  fix: z.string(),
});
export type McpLeaderBlocker = z.infer<typeof mcpLeaderBlockerSchema>;

/**
 * The MCP session that owns the project, when one does (#374, round 4). `client` is which client it
 * is, when xezar has IDENTIFIED it, and `null` otherwise — xezar does not guess a client from a name
 * or a process. A Codex session identifies itself through the thread id Codex stamps on its tool
 * calls, so it reads `codex` once it has called a xezar tool; that announcement is also what a Codex
 * attach needs. A Claude Code session identifies itself through the client name its channel-capable
 * bridge announces at `session/open` (exactly `claude-code`), so it reads `claude-code` as soon as
 * it owns the project. The cockpit's Attach leader action is derived from this. A client identified
 * another way is a new enum member, which is additive.
 */
export const mcpLeaderOwnerSchema = z.object({
  client: z.enum(['codex', 'claude-code']).nullable(),
});
export type McpLeaderOwner = z.infer<typeof mcpLeaderOwnerSchema>;

export const mcpLeaderStatusSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.string() }),
  z.object({
    available: z.literal(true),
    /** `null` when no MCP session owns the project (then `delivery` is `null` too). */
    owner: mcpLeaderOwnerSchema.nullable(),
    leader: mcpLeaderSessionSchema.nullable(),
    delivery: mcpLeaderDeliverySchema.nullable(),
    blocker: mcpLeaderBlockerSchema.nullable(),
  }),
]);
export type McpLeaderStatus = z.infer<typeof mcpLeaderStatusSchema>;

/**
 * #450 — the MCP door to the same delivery path: `leader_events` actions `attach`, `stop` and
 * `status`, for the CALLING MCP session only. The client is derived from that session (its bridge's
 * client name, or the Codex thread its tool calls carry), never taken from an argument, and a
 * leader never replaces or detaches a leader of another client. The route above is unchanged.
 */

/** Why xezar cannot push to this session's client. Additive: a new code is a new member. */
export const mcpPushUnavailableCodeSchema = z.enum([
  /** No event delivery for the project (the journal did not open), or the journal cannot be written. */
  'delivery-unavailable',
  /** `capabilities.localHandoff` is false: a leader is attached only from the machine that owns the checkout. */
  'hosted-mode',
  /** The session names no client xezar maps to a leader client. */
  'client-unknown',
  /** OpenCode: reached by an `opencode serve` address a person gives, never taken from an MCP session. */
  'client-needs-address',
  /** A Claude Code bridge that did not announce `leader/push`. */
  'bridge-too-old',
  /** A Claude Code bridge whose `initialize` handshake did not register `claude/channel`. */
  'channel-not-advertised',
]);
export type McpPushUnavailableCode = z.infer<typeof mcpPushUnavailableCodeSchema>;

export const mcpPushUnavailableSchema = z.object({ code: mcpPushUnavailableCodeSchema, message: z.string() });
export type McpPushUnavailable = z.infer<typeof mcpPushUnavailableSchema>;

/** Whether xezar can push to one session's client. */
export const mcpPushCapabilitySchema = z.discriminatedUnion('canPush', [
  z.object({ canPush: z.literal(true) }),
  z.object({ canPush: z.literal(false), pushUnavailable: mcpPushUnavailableSchema }),
]);
export type McpPushCapability = z.infer<typeof mcpPushCapabilitySchema>;

/** `leader_events` `status`: the route's status fields, plus what is true for THIS session. */
export const mcpLeaderSelfStatusSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.string() }),
  z.object({
    available: z.literal(true),
    owner: mcpLeaderOwnerSchema.nullable(),
    leader: mcpLeaderSessionSchema.nullable(),
    delivery: mcpLeaderDeliverySchema.nullable(),
    blocker: mcpLeaderBlockerSchema.nullable(),
    canPush: z.boolean(),
    pushUnavailable: mcpPushUnavailableSchema.nullable(),
    self: z.object({
      /** Derived from the session, never from an argument; `null` when xezar cannot tell. */
      client: mcpLeaderClientSchema.nullable(),
      /** This session is the project's live owner. */
      isOwner: z.boolean(),
      /** The attached leader is this session's own. */
      attached: z.boolean(),
    }),
  }),
]);
export type McpLeaderSelfStatus = z.infer<typeof mcpLeaderSelfStatusSchema>;

export const mcpLeaderDoorRefusalCodeSchema = z.enum([
  'delivery-unavailable',
  'hosted-mode',
  'not-owner',
  'client-unknown',
  'client-needs-address',
  'leader-attached-elsewhere',
  'leader-not-this-session',
  'attach-refused',
]);
export type McpLeaderDoorRefusalCode = z.infer<typeof mcpLeaderDoorRefusalCodeSchema>;

/** `leader_events` `attach` / `stop`. A refusal changes nothing and names its own fix. */
export const mcpLeaderDoorResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    action: z.enum(['attach', 'stop']),
    outcome: z.enum(['attached', 'already-attached', 'stopped', 'already-stopped']),
    status: mcpLeaderSelfStatusSchema,
  }),
  z.object({
    ok: z.literal(false),
    action: z.enum(['attach', 'stop']),
    code: mcpLeaderDoorRefusalCodeSchema,
    message: z.string(),
    fix: z.string(),
    /** `attach-refused` only: the client's own recoverable reason (`claude-code-not-owner`, a Codex reason, pi's …). */
    blocker: mcpLeaderBlockerSchema.nullable(),
    status: mcpLeaderSelfStatusSchema,
  }),
]);
export type McpLeaderDoorResult = z.infer<typeof mcpLeaderDoorResultSchema>;

/**
 * A frame's `data` on the `mcp-leader` WebSocket topic (`/api/v1/ws`, #374 round 5): the answer
 * `GET /api/v1/mcp/leader` gives for each project, keyed by registry project id — every project whose
 * MCP service is running, and one that stopped while the topic was held (as `available: false`). It
 * mirrors that route's shape, so it inherits that route's contract. The cockpit validates each frame
 * with this schema and ignores one that does not parse.
 */
export const mcpLeaderTopicSchema = z.object({
  projects: z.record(z.string(), mcpLeaderStatusSchema),
});
export type McpLeaderTopic = z.infer<typeof mcpLeaderTopicSchema>;
