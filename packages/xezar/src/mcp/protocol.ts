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
});
