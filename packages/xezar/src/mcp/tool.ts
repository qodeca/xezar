import { z } from 'zod';
import type { McpToolResult } from './ipc.ts';

export type { McpToolResult } from './ipc.ts';

/**
 * What a tool runs with. Tools execute INSIDE the running xezar service, never in
 * the bridge: the bridge only lists them and forwards `tools/call` over the
 * project's socket (D-01 § 3.5–3.6 — the bridge is a transport adapter, not
 * another business engine). So `project` is the project that socket belongs to,
 * and no argument a client sends can change it (D-01 § 1.5, F-01).
 *
 * Deliberately small. The session binding (#87) and the shared business-service
 * adapter (#89) widen it; widening an interface is additive for every tool.
 */
export interface McpToolContext {
  readonly project: { readonly id: string; readonly name: string; readonly root: string };
  readonly xezarVersion: string;
  /**
   * The calling connection's session key (#450), minted by the service per connection and never read
   * from a frame, so a tool can act for THIS session only (`leader_events` attach, stop, status). It
   * never appears in a result (N-01). Absent in a composition that has no connection (a unit test).
   */
  readonly sessionKey?: string;
}

/**
 * The shared tail of every "not connected" answer (#439, #450): where a leader looks next, through the
 * tools, and that it reports the blocker rather than switching to the cockpit.
 */
export const NOT_CONNECTED_NEXT =
  'Call `health` to see whether xezar is running for this project, and leader_events with action status for your event delivery. Report this blocker to the person; a leader does not switch to the cockpit.';

/**
 * One MCP tool. `inputSchema` is the only definition of its arguments: the JSON
 * Schema clients see is derived from it, and the service validates every call
 * against it before `call` runs. Results follow D-05: the text block is
 * authoritative and `structuredContent` may only add to it.
 */
export interface McpTool<S extends z.ZodObject = z.ZodObject> {
  /** `snake_case`, unique across the registry — `tools/index.test.ts` enforces both. */
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: S;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  call(args: z.output<S>, ctx: McpToolContext): Promise<McpToolResult>;
}

/** Keeps a tool's argument type inferred from its own schema. */
export function defineTool<S extends z.ZodObject>(tool: McpTool<S>): McpTool {
  return tool as unknown as McpTool;
}

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function textResult(text: string, structuredContent?: Record<string, unknown>): McpToolResult {
  return { content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}) };
}

export function errorResult(text: string, structuredContent?: Record<string, unknown>): McpToolResult {
  return { ...textResult(text, structuredContent), isError: true };
}

/** The tool as `tools/list` sends it. */
export function toolListing(tool: McpTool): Record<string, unknown> {
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(tool.inputSchema, { io: 'input' });
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}
