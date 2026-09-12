import { z } from 'zod';

/**
 * #309 — the project's push-delivery path to its leader (`GET/POST /api/v1/mcp/leader`).
 *
 * Push delivery is ON BY DEFAULT: every MCP session that owns a project gets an event controller
 * (#107) the moment it opens. What it cannot do on its own is reach a model — generic MCP
 * notifications start no turn in any of the four clients (D-05 § 4; #330 run A for pi). An event
 * therefore reaches a leader only through a session the person runs and tells xezar where to find:
 * today an OpenCode `serve` session. xezar NEVER starts an agent process for a leader (owner
 * decision on #311): the person runs their own leader, in their own terminal, with their own tool,
 * and it connects to xezar over MCP. A Claude Code, Codex or pi session in a terminal has no
 * address to attach to, so it gets no push; it reads its events with the `leader_events` tool.
 */

/**
 * What the route does. `attach` names a leader session the person already runs; `stop` detaches it —
 * never a task, never the client's process, and never the MCP session's hold on the project. There
 * is no `start` or `resume`: xezar spawns no leader.
 *
 * One client carries an address today. `opencode` names an `opencode serve` session by URL and
 * session id. `pi` names no address at all, on purpose: pi speaks RPC over its own stdin and stdout
 * only (pi 0.85.1, `docs/rpc.md`), so there is nothing for xezar to dial, and the action exists so
 * that asking answers with pi's own recoverable reason (`pi-not-addressable`, #330 WP2) instead of a
 * schema error. It is refused with that reason until a pi-side component can hand xezar a link.
 */
const mcpLeaderAttachInputSchema = z.discriminatedUnion('client', [
  z.strictObject({
    action: z.literal('attach'),
    client: z.literal('opencode'),
    baseUrl: z.url({ protocol: /^https?$/ }).max(500),
    sessionId: z.string().trim().min(1).max(200),
  }),
  z.strictObject({ action: z.literal('attach'), client: z.literal('pi') }),
]);

export const mcpLeaderActionInputSchema = z.union([
  mcpLeaderAttachInputSchema,
  z.strictObject({ action: z.literal('stop') }),
]);
export type McpLeaderActionInput = z.infer<typeof mcpLeaderActionInputSchema>;

/** The leader session attached to the project, if any. */
export const mcpLeaderSessionSchema = z.object({
  client: z.enum(['opencode', 'pi']),
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

export const mcpLeaderStatusSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.string() }),
  z.object({
    available: z.literal(true),
    leader: mcpLeaderSessionSchema.nullable(),
    delivery: mcpLeaderDeliverySchema.nullable(),
    blocker: mcpLeaderBlockerSchema.nullable(),
  }),
]);
export type McpLeaderStatus = z.infer<typeof mcpLeaderStatusSchema>;
