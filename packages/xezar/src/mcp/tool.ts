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
  /**
   * #819 item 6: an answer that stands whatever else the call carries, read from the RAW arguments
   * before the schema's verdict. `project_config` uses it for its refusals, so a refused action
   * with an unknown key answers the refusal instead of an argument error. It must dispatch nothing
   * and be pure: the service uses it only in place of an argument error, and a call whose arguments
   * validate still reaches `call` through the door, which gives the same answer and records it.
   * Absent on every other tool.
   */
  preflight?(rawArgs: unknown, ctx: McpToolContext): McpToolResult | undefined;
  /**
   * #819 item 6: which keys the action named in the RAW arguments takes, for the hint an unknown-key
   * error ends with. Read from the tool's own argument table, never a second list. A tool without
   * it is described by its schema's own shape keys; `undefined` means "no action I can name" and
   * adds no hint.
   */
  acceptedKeys?(rawArgs: unknown): AcceptedKeys | undefined;
}

/** The keys one action (or one tool) takes, for the unknown-key hint (#819 item 6). */
export interface AcceptedKeys {
  /** `Accepted for <subject>` — an action name, or the tool's own name. */
  readonly subject: string;
  readonly required: readonly string[];
  readonly optional: readonly string[];
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

/**
 * The keys a tool takes, from its schema's own shape (#819 item 6): a key the schema accepts
 * `undefined` for is optional, every other one required. Declaration order, so the hint reads like
 * the published input schema.
 */
export function schemaKeys(tool: McpTool): AcceptedKeys {
  const required: string[] = [];
  const optional: string[] = [];
  for (const [key, schema] of Object.entries(tool.inputSchema.shape)) {
    ((schema as z.ZodType).safeParse(undefined).success ? optional : required).push(key);
  }
  return { subject: tool.name, required, optional };
}

/** `Accepted for set_provider_enabled: action, provider (required); refresh (optional).` */
export function acceptedKeysSentence({ subject, required, optional }: AcceptedKeys): string {
  const parts = [
    ...(required.length > 0 ? [`${required.join(', ')} (required)`] : []),
    ...(optional.length > 0 ? [`${optional.join(', ')} (optional)`] : []),
  ];
  return `Accepted for ${subject}: ${parts.length > 0 ? parts.join('; ') : 'no arguments'}.`;
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
