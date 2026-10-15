/**
 * How a step's MCP tool allow-list reaches a pi step (#1015).
 *
 * A workflow names MCP tools the way Claude Code does: `mcp__<server>__<tool>`. pi-mcp-adapter
 * (2.33) shows every MCP tool through ONE proxy tool, `mcp`, unless a server asks for direct tools,
 * and pi's `--tools` allow-list drops every tool it does not name – so a pi step that listed
 * `mcp__chrome-devtools__navigate_page` got no browser at all. The run's MCP overlay therefore
 * asks the adapter for exactly the listed tools as direct tools, with the `mcp` prefix, and
 * `--tools` names them the way the adapter registers them. The `mcp` proxy stays out of the list,
 * so a step never reaches a tool or a server it did not name.
 */

/** One `mcp__<server>__<tool>` entry, or null for anything else (a built-in, a whole server). */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const split = rest.indexOf('__');
  if (split <= 0) return null;
  const tool = rest.slice(split + 2);
  return tool ? { server: rest.slice(0, split), tool } : null;
}

/**
 * The adapter's server prefix: a character outside `[A-Za-z0-9_-]` becomes `_<hex>_`
 * (`sanitizeServerPrefix` in pi-mcp-adapter's `types.ts`).
 */
function sanitizeServer(server: string): string {
  return Array.from(server, (char) => (/^[A-Za-z0-9_-]$/.test(char) ? char : `_${char.codePointAt(0)!.toString(16)}_`)).join('');
}

/**
 * The name pi-mcp-adapter registers a direct tool under with `toolPrefix: "mcp"`:
 * `mcp__<server>_<tool>`, dots in the tool name turned into underscores (`formatToolName`).
 */
export function piMcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeServer(server)}_${tool.replace(/\./g, '_')}`;
}

/** The step's MCP tools grouped by server, in the order the step listed them. */
export function piDirectTools(allowedTools: readonly string[]): Map<string, string[]> {
  const byServer = new Map<string, string[]>();
  for (const name of allowedTools) {
    const parsed = parseMcpToolName(name);
    if (!parsed) continue;
    const tools = byServer.get(parsed.server) ?? [];
    if (!tools.includes(parsed.tool)) tools.push(parsed.tool);
    byServer.set(parsed.server, tools);
  }
  return byServer;
}
