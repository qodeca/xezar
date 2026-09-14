import { z } from 'zod';

/**
 * The client-facing half of MCP that the bridge speaks: JSON-RPC 2.0, newline-framed
 * on stdio. Hand-rolled on purpose — D-09 (qodeca/xezar#206) measured the official
 * SDK at 94 installed packages and rejected it for version one, and the server
 * runtime dependency budget in CODE_REVIEW.md is exhaustive. The surface is small:
 * `initialize`, `ping`, `tools/list`, `tools/call`; everything else is -32601.
 */

/**
 * Newest first. D-01 § 1.6: the bridge must support at least these two, because the
 * three required clients disagree today — Claude Code and OpenCode offer
 * `2025-11-25`, Codex offers `2025-06-18` (D-01 E1–E3).
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18'] as const;

/**
 * D-01 § 1.6: echo the client's requested revision when it is supported; otherwise
 * answer with the newest the bridge supports and let the client decide.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  return SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === requested) ?? SUPPORTED_PROTOCOL_VERSIONS[0];
}

/**
 * Tools only. The list is fixed for the life of the process, so `listChanged` is
 * false. Resources, prompts and logging are not advertised (D-05 depends on
 * `tools` alone).
 */
export const SERVER_CAPABILITIES = { tools: { listChanged: false } } as const;

/**
 * The one protocol revision Claude Code 2.1.270 refuses to deliver a channel over: a connection
 * that negotiated the "modern" revision gets no unsolicited notification path (the wake decision
 * record § 2.3 step 2). `SUPPORTED_PROTOCOL_VERSIONS` must never offer it while xezar advertises the
 * channel capability, or a Claude Code leader would be attachable and silently unreachable.
 * `protocol.test.ts` pins that this string is not among the versions xezar negotiates.
 */
export const CHANNEL_INCOMPATIBLE_PROTOCOL_VERSION = '2026-07-28';

/**
 * Claude Code Channels (#374, epic #73). Declaring `experimental["claude/channel"] = {}` in the
 * `initialize` result registers xezar as a channel source, so a `notifications/claude/channel`
 * message xezar sends becomes a model turn in a Claude Code session the person started with
 * `--dangerously-load-development-channels server:xezar` (the wake decision record § 2.1). It is
 * added ONLY for a `claude-code` client — every other client keeps the exact capabilities it has
 * today — through `serverCapabilitiesFor`.
 *
 * `claude/channel/permission` is DELIBERATELY NOT declared here or anywhere: declaring it would
 * route Claude Code's own tool-approval prompts to xezar and let a message answer them, and xezar
 * must never approve anything (the record § 5.1; #73 "never impersonate approval"). A unit test
 * pins its absence.
 */
export const CLAUDE_CHANNEL_CAPABILITY = { experimental: { 'claude/channel': {} } } as const;

/** Which client this bridge is serving, learned from `initialize`'s `clientInfo.name`. */
export function serverCapabilitiesFor(
  clientName: string | undefined,
): typeof SERVER_CAPABILITIES | (typeof SERVER_CAPABILITIES & typeof CLAUDE_CHANNEL_CAPABILITY) {
  return clientName === 'claude-code' ? { ...SERVER_CAPABILITIES, ...CLAUDE_CHANNEL_CAPABILITY } : SERVER_CAPABILITIES;
}

export const JSONRPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/** MCP forbids a `null` id on requests; an id is a string or an integer. */
const requestIdSchema = z.union([z.string().max(256), z.number().int()]);
export type RequestId = z.infer<typeof requestIdSchema>;

/** Anything the client may send: a request, a notification, or a response to us. */
export const incomingMessageSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: requestIdSchema.optional(),
  method: z.string().min(1).max(256).optional(),
  params: z.unknown().optional(),
});

export const initializeParamsSchema = z.object({
  protocolVersion: z.string().max(64),
  /**
   * The client's own name (`{name, title?, version?}` in MCP). Read only to decide whether to
   * advertise the Claude Code channel capability; Claude Code 2.1.270 sends `name: "claude-code"`
   * (the wake decision record § 5.1). Loose and optional: an older or unusual client that omits it
   * simply gets the base capabilities.
   */
  clientInfo: z.object({ name: z.string().max(200) }).loose().optional(),
});
