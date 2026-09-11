import { z } from 'zod';

/**
 * #284 — the MCP API reference the cockpit browses (`GET /api/v1/mcp/reference`), spec
 * `docs/features/mcp-api-reference/mcp-api-reference-spec.md` § 11.
 *
 * READ-ONLY BY DESIGN. Nothing in this shape can run a tool, and nothing may be added that
 * prepares one: executing a tool from the cockpit would make it a second leader on the project
 * and forge the server-derived audit origin (spec § 13).
 */

/** The four hints MCP defines. A hint the tool omits is ABSENT, never defaulted here. */
export const mcpToolAnnotationsSchema = z.strictObject({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type McpToolAnnotations = z.infer<typeof mcpToolAnnotationsSchema>;

/**
 * One tool exactly as `tools/list` sends it — `toolListing()` in `packages/xezar/src/mcp/tool.ts`,
 * key for key. Strict, so a key the wire gains that this contract does not describe fails loudly
 * instead of being silently stripped from the page.
 *
 * `inputSchema` is JSON Schema and stays an opaque JSON object: describing JSON Schema in zod would
 * be a second definition that can drift (spec § 11).
 */
export const mcpToolListingSchema = z.strictObject({
  name: z.string(),
  title: z.string().optional(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: mcpToolAnnotationsSchema.optional(),
});
export type McpToolListing = z.infer<typeof mcpToolListingSchema>;

/** An action the tool's schema accepts only to answer with a refusal that names its boundary. */
export const mcpRefusedActionSchema = z.object({
  tool: z.string(),
  action: z.string(),
  boundary: z.string(),
  reason: z.string(),
});
export type McpRefusedAction = z.infer<typeof mcpRefusedActionSchema>;

/** A listed argument that is never accepted: shown as a refusal, never as an optional input. */
export const mcpRefusedArgumentSchema = z.object({
  tool: z.string(),
  argument: z.string(),
  reason: z.string(),
});
export type McpRefusedArgument = z.infer<typeof mcpRefusedArgumentSchema>;

/** Something the server deliberately does not expose, and the requirements that forbid it. */
export const mcpNotExposedSchema = z.object({
  what: z.string(),
  detail: z.string(),
  forbiddenBy: z.array(z.string()),
});
export type McpNotExposed = z.infer<typeof mcpNotExposedSchema>;

export const mcpApiReferenceAvailableSchema = z.object({
  available: z.literal(true),
  xezarVersion: z.string(),
  /** Newest first — the revisions the bridge negotiates. */
  protocolVersions: z.array(z.string()),
  capabilities: z.object({ tools: z.object({ listChanged: z.boolean() }) }),
  /** Exactly `tools/list`: `[HEALTH_TOOL, ...tools.map(toolListing)]`, in that order. */
  tools: z.array(mcpToolListingSchema),
  refusedActions: z.array(mcpRefusedActionSchema),
  refusedArguments: z.array(mcpRefusedArgumentSchema),
  notExposed: z.array(mcpNotExposedSchema),
});

/**
 * The route's answer. `available: false` carries one plain reason and is still a 200: the MCP
 * module failing to load must never break the cockpit (N-07).
 */
export const mcpApiReferenceSchema = z.discriminatedUnion('available', [
  mcpApiReferenceAvailableSchema,
  z.object({ available: z.literal(false), reason: z.string() }),
]);
export type McpApiReference = z.infer<typeof mcpApiReferenceSchema>;
