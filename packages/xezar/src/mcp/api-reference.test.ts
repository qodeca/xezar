import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { REFUSED_ARGUMENTS, buildMcpApiReference } from './api-reference.ts';
import { defineTool, textResult, type McpTool } from './tool.ts';
import { REFUSED_ACTIONS } from './tools/project-config.ts';

/**
 * #352 — the branches of `buildMcpApiReference` that today's registry cannot reach.
 *
 * `mcp-reference-route.test.ts` holds the page against the LIVE registry, three ways. It can only
 * ever exercise the listings ten real tools happen to produce, so every fallback in
 * `api-reference.ts` — a listing with no `properties`, a guard on a tool with no action
 * discriminator, a refused argument whose tool or description is gone — stays untested there, and
 * "we found nothing" reads exactly like "there is nothing" (AGENTS.md § Changing a mechanism that
 * already works: *a fail-open helper needs a populated-input guarantee, or it lies*).
 *
 * So this file swaps the registry and, where it must, the listing a tool produces. The contract
 * keeps `inputSchema` an OPAQUE JSON object (`packages/contract/src/mcp-api-reference.ts`), so a
 * listing without `properties` is legal input rather than a fabricated one. Every case below
 * carries its populated-input control in the same test — an assertion that the page still reports
 * the tool that DOES declare the thing — so an empty answer can never pass for a correct one.
 */

const registry = vi.hoisted(() => ({
  /** Mutated in place: `api-reference.ts` reads this array on every call. */
  tools: [] as McpTool[],
  /** Tool name → the listing `toolListing()` answers with, in place of the derived one. */
  listings: new Map<string, Record<string, unknown>>(),
}));

vi.mock('./tools/index.ts', () => ({ tools: registry.tools }));

vi.mock('./tool.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tool.ts')>();
  return {
    ...actual,
    toolListing: (tool: McpTool) => registry.listings.get(tool.name) ?? actual.toolListing(tool),
  };
});

/** The one declared refused argument, read from the shipped constant rather than spelled out. */
const REFUSED = REFUSED_ARGUMENTS[0]!;
/** Any refusal-only action of the real tool; the point is that the page must not report it here. */
const REFUSAL_ONLY = Object.keys(REFUSED_ACTIONS)[0]!;

const stubTool = (name: string, inputSchema: z.ZodObject): McpTool =>
  defineTool({ name, description: `${name} — a stub registry entry`, inputSchema, call: async () => textResult('ok') });

/** Replace the whole registry, and any hand-written listings, for the next `build()`. */
function setRegistry(tools: McpTool[], listings: Record<string, Record<string, unknown>> = {}): void {
  registry.tools.splice(0, registry.tools.length, ...tools);
  registry.listings.clear();
  for (const [name, listing] of Object.entries(listings)) registry.listings.set(name, listing);
}

function build() {
  const reference = buildMcpApiReference('0.0.0-test');
  if (!reference.available) throw new Error('the reference is always available: it reads static code');
  return reference;
}

describe('buildMcpApiReference — the listings the live registry does not produce (#352)', () => {
  it('derives everyCall by probing a guard-carrying tool that has no action discriminator', () => {
    // Neither tool lists an `action`/`view`/`read` enum, so there is no per-action answer to give:
    // the page has to say whether the guard is needed at all, and it asks the schema, not the prose.
    setRegistry([
      stubTool('always_guarded', z.object({ expectedVersion: z.string() })),
      stubTool('never_guarded', z.object({ operationId: z.string().optional() })),
    ]);

    expect(build().guards).toEqual([
      { tool: 'always_guarded', argument: 'expectedVersion', everyCall: true, requiredBy: [] },
      { tool: 'never_guarded', argument: 'operationId', everyCall: false, requiredBy: [] },
    ]);
  });

  it('reads what a listing declares, not what the tool behind it enforces', () => {
    // This stub really does take a refusal-only action, a guard and the refused argument — but its
    // listing declares no `properties` at all. Everything on the page is derived from the listing,
    // so all three must come back empty rather than from the zod schema behind it, and rather than
    // throwing on the missing key.
    const enforced = z.object({
      action: z.enum(['get', REFUSAL_ONLY]),
      expectedVersion: z.string(),
      [REFUSED.argument]: z.string().optional().describe('Never accepted: the session is bound to one project.'),
    });
    setRegistry(
      [stubTool(REFUSED.tool, enforced), stubTool('declares_its_guard', z.object({ expectedVersion: z.string() }))],
      { [REFUSED.tool]: { name: REFUSED.tool, description: 'a listing with no properties', inputSchema: { type: 'object' } } },
    );

    const reference = build();
    expect(reference.tools.map((tool) => tool.name)).toEqual(['health', REFUSED.tool, 'declares_its_guard']);
    expect(reference.refusedActions).toEqual([]);
    expect(reference.refusedArguments).toEqual([]);
    // The control: the tool that DOES declare its guard is still reported, so the two empties above
    // are the listing answering "nothing", not the derivation quietly finding nothing for anyone.
    expect(reference.guards).toEqual([
      { tool: 'declares_its_guard', argument: 'expectedVersion', everyCall: true, requiredBy: [] },
    ]);
  });

  it('shows a refused argument only while the live listing still describes it', () => {
    const reason = 'Never accepted: the session is bound to one project.';

    // Populated input: the argument is listed with its own description, which IS the page's reason.
    setRegistry([stubTool(REFUSED.tool, z.object({ [REFUSED.argument]: z.string().optional().describe(reason) }))]);
    expect(build().refusedArguments).toEqual([{ tool: REFUSED.tool, argument: REFUSED.argument, reason }]);

    // Still listed, but its description — the page's only source of the reason — is gone. A row
    // with no reason is worse than no row: the page would print the refusal with nothing after it.
    setRegistry([stubTool(REFUSED.tool, z.object({ [REFUSED.argument]: z.string().optional() }))]);
    expect(build().refusedArguments).toEqual([]);

    // The tool itself left the registry. `mcp-reference-route.test.ts` is what catches that drift
    // on the real registry; here the page must merely not crash building the row for a tool the
    // listing does not contain at all.
    setRegistry([stubTool('some_other_tool', z.object({ [REFUSED.argument]: z.string().optional().describe(reason) }))]);
    expect(build().refusedArguments).toEqual([]);
  });
});
