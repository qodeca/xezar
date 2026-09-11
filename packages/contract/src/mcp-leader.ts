import { z } from 'zod';

/**
 * #309 — the project's push-delivery path to its leader (`GET/POST /api/v1/mcp/leader`).
 *
 * Push delivery is ON BY DEFAULT: every MCP session that owns a project gets an event controller
 * (#107) the moment it opens. What it cannot do on its own is reach a model — generic MCP
 * notifications start no turn in any of the three clients (D-05 § 4), so an event reaches a leader
 * only through a session xezar itself started (Claude Code, Codex) or was pointed at (OpenCode).
 * This route is how that leader session is started, attached, resumed or stopped. It never runs a
 * tool, and it refuses to start a leader while another MCP client owns the project, so it cannot
 * make the cockpit a second leader (spec `mcp-api-reference-spec.md` § 13).
 */

/** The three clients with a reaction adapter (#108–#110). */
export const mcpLeaderClientSchema = z.enum(['claude-code', 'codex', 'opencode']);
export type McpLeaderClient = z.infer<typeof mcpLeaderClientSchema>;

/**
 * What the route does. `start` opens a NEW leader session (Claude Code: `claude -p` in stream-json
 * mode; Codex: an app-server thread), `resume` reopens the last Claude Code conversation, `attach`
 * names an OpenCode session the user already runs (`opencode serve`), and `stop` ends the leader
 * xezar started — never a task, and never the MCP session's hold on the project.
 */
export const mcpLeaderActionInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start'), client: z.enum(['claude-code', 'codex']) }),
  z.strictObject({ action: z.literal('resume'), client: z.literal('claude-code') }),
  z.strictObject({
    action: z.literal('attach'),
    client: z.literal('opencode'),
    baseUrl: z.url({ protocol: /^https?$/ }).max(500),
    sessionId: z.string().trim().min(1).max(200),
  }),
  z.strictObject({ action: z.literal('stop') }),
]);
export type McpLeaderActionInput = z.infer<typeof mcpLeaderActionInputSchema>;

/** The leader session xezar started or attached, if any. `stopped`: it ended and can be resumed. */
export const mcpLeaderSessionSchema = z.object({
  client: mcpLeaderClientSchema,
  state: z.enum(['running', 'stopped']),
});
export type McpLeaderSession = z.infer<typeof mcpLeaderSessionSchema>;

/**
 * The event controller of the MCP session that owns the project, when one is open. The three
 * cursors are D-05 § 6.6's and stay apart: delivered is not reacted.
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
