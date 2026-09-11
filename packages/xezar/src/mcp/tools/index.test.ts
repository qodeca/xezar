import { describe, expect, it } from 'vitest';
import { HEALTH_TOOL } from '../bridge.ts';
import { TOOL_NAME_RE, toolListing } from '../tool.ts';
import { tools } from './index.ts';

// Guards the append-only registry that nine tasks extend in parallel: a merge that
// keeps both sides of a conflict can still duplicate a name, and nothing else
// would notice until a client did.
describe('MCP tool registry', () => {
  it('has unique snake_case names that never shadow the built-in health tool', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(TOOL_NAME_RE);
    expect(names).not.toContain(HEALTH_TOOL.name);
  });

  it('describes every tool with an object JSON Schema a client can read', () => {
    for (const tool of tools) {
      expect(tool.description.trim(), tool.name).not.toBe('');
      expect(toolListing(tool).inputSchema, tool.name).toMatchObject({ type: 'object' });
    }
  });

  // #271: a key a tool does not declare must be an argument error, never silently stripped — a
  // stray `projectId` reads as scoping the call while the call acts on the bound project.
  it('declares every tool input strict, so an unknown argument is refused rather than dropped', () => {
    for (const tool of tools) {
      expect(toolListing(tool).inputSchema, tool.name).toMatchObject({ additionalProperties: false });
      expect(tool.inputSchema.safeParse({ projectId: 'another-project' }).success, tool.name).toBe(false);
    }
  });
});
