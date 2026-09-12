/**
 * #264 — test-only: hand a tool call the `operationId` its action now requires.
 *
 * Since D-06 § 5.2 is implemented for every mutating tool, a test that drives one of them has to
 * carry an operation key it does not otherwise care about. Rather than sprinkle a literal through
 * two hundred call sites, a test's own helper passes its arguments through `withOperationId`, which
 * asks the TOOL'S OWN SCHEMA whether this action needs a key and mints a fresh one only then. That
 * matters twice over: a read action REFUSES a key, so a blanket injection would fail it, and a key
 * reused across two calls would deduplicate them — which is precisely the behaviour under test
 * elsewhere and must never happen by accident here.
 *
 * Test-only (`.testkit.ts`): it never ships in `dist`.
 */
import type { McpTool } from '../tool.ts';
import { tools } from './index.ts';

/** A key that is only ever used to ask a schema a question; nothing is executed under it. */
const PROBE = 'op-probe-0000';

/** A well-formed key for a case that is about the SHAPE of an argument list, not about idempotency.
 *  Never send it through the door twice: there it would be one operation, replayed. */
export const SAMPLE_OPERATION_ID = 'op-sample-0001';

let minted = 0;

/** A fresh key, unique within this module instance: two calls are never one operation by accident. */
export function nextOperationId(prefix = 'op-test'): string {
  minted += 1;
  return `${prefix}-${String(minted).padStart(6, '0')}`;
}

function toolOf(tool: McpTool | string): McpTool {
  if (typeof tool !== 'string') return tool;
  const found = tools.find((t) => t.name === tool);
  if (!found) throw new Error(`no such tool in the registry: ${tool}`);
  return found;
}

/** The schema's complaints about one set of arguments, as `path: message` lines. */
function issuesOf(tool: McpTool, args: Record<string, unknown>): string[] {
  const parsed = tool.inputSchema.safeParse(args);
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

/**
 * Does this action refuse a call that carries no `operationId`? Asked of the schema rather than of a
 * table, so it cannot drift from what the tool really enforces.
 */
export function requiresOperationId(tool: McpTool | string, action: unknown, extra: Record<string, unknown> = {}): boolean {
  const resolved = toolOf(tool);
  return issuesOf(resolved, probeOf(action, extra)).some((issue) => issue.startsWith('operationId:'));
}

/**
 * Does this action complain about a call that DOES carry one? A read of a mutating tool must, so
 * that no receipt is ever filed over a read.
 *
 * `extra` exists because one tool stops at the first problem: `handoff_git` reports its missing
 * arguments and only then looks for arguments the action does not take, so its reads have to be
 * probed with the arguments they DO need before the refusal is reachable.
 */
export function refusesOperationId(tool: McpTool | string, action: unknown, extra: Record<string, unknown> = {}): boolean {
  const resolved = toolOf(tool);
  const probe = probeOf(action, extra);
  const without = issuesOf(resolved, probe);
  const withKey = issuesOf(resolved, { ...probe, operationId: PROBE });
  return withKey.some((issue) => !without.includes(issue));
}

const probeOf = (action: unknown, extra: Record<string, unknown>): Record<string, unknown> =>
  action === undefined ? { ...extra } : { action, ...extra };

/**
 * The arguments as given, plus a fresh key when — and only when — this action needs one.
 *
 * A name the registry does not know is passed through untouched, so a call helper can route the
 * bridge's own `health` and the deliberately unknown tool names some cases send through here too.
 */
export function withOperationId(tool: McpTool | string, args: Record<string, unknown>): Record<string, unknown> {
  if (args.operationId !== undefined) return args;
  const known = typeof tool === 'string' ? tools.find((t) => t.name === tool) : tool;
  if (!known || !requiresOperationId(known, args.action)) return args;
  return { operationId: nextOperationId(), ...args };
}
