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
 * starts events as turns in it. A Claude Code session reads its events with the `leader_events` tool
 * — it has no address to attach to — and so does a pi with no xezar leader extension loaded.
 */

/**
 * What the route does. `attach` names a leader session the person already runs; `stop` detaches it —
 * never a task, never the client's process, and never the MCP session's hold on the project. There
 * is no `start` or `resume`: xezar spawns no leader.
 *
 * Three clients can be attached, and they carry their address differently. `opencode` names an
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
]);

export const mcpLeaderActionInputSchema = z.union([
  mcpLeaderAttachInputSchema,
  z.strictObject({ action: z.literal('stop') }),
]);
export type McpLeaderActionInput = z.infer<typeof mcpLeaderActionInputSchema>;

/** The leader session attached to the project, if any. */
export const mcpLeaderSessionSchema = z.object({
  client: z.enum(['opencode', 'pi', 'codex']),
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
 * attach needs. The cockpit's Attach leader action is derived from this. A client identified another
 * way is a new enum member, which is additive.
 */
export const mcpLeaderOwnerSchema = z.object({
  client: z.enum(['codex']).nullable(),
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
