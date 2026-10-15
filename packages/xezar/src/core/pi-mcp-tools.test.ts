import { describe, expect, it } from 'vitest';
import { parseMcpToolName, piDirectTools, piMcpToolName } from './pi-mcp-tools.ts';

// Break: a pi step that lists `mcp__chrome-devtools__navigate_page` gets no browser, because pi's
// `--tools` named a tool pi-mcp-adapter never registers (#1015).
describe('pi MCP tool names (#1015)', () => {
  it('reads mcp__<server>__<tool> and nothing else', () => {
    expect(parseMcpToolName('mcp__chrome-devtools__navigate_page')).toEqual({ server: 'chrome-devtools', tool: 'navigate_page' });
    expect(parseMcpToolName('mcp__srv__ns__tool')).toEqual({ server: 'srv', tool: 'ns__tool' });
    for (const name of ['Read', 'mcp', 'mcp__chrome-devtools', 'mcp__chrome-devtools__', 'mcp____tool']) {
      expect(parseMcpToolName(name)).toBeNull();
    }
  });

  it("names a tool the way pi-mcp-adapter 2.33 registers it with toolPrefix \"mcp\"", () => {
    // Verified live against pi 0.87.1 + pi-mcp-adapter 2.33.0: pi listed exactly these names.
    expect(piMcpToolName('chrome-devtools', 'list_pages')).toBe('mcp__chrome-devtools_list_pages');
    // The adapter turns dots in a tool name into underscores, and escapes a server character
    // outside [A-Za-z0-9_-] as _<hex>_ (`formatToolName`, `sanitizeServerPrefix`).
    expect(piMcpToolName('docs', 'search.v2')).toBe('mcp__docs_search_v2');
    expect(piMcpToolName('my.server', 'go')).toBe('mcp__my_2e_server_go');
  });

  it('groups the listed tools by server, once each, in the listed order', () => {
    const grouped = piDirectTools([
      'Read',
      'mcp__chrome-devtools__navigate_page',
      'mcp__docs__search',
      'mcp__chrome-devtools__take_screenshot',
      'mcp__chrome-devtools__navigate_page',
      'mcp__whole-server',
    ]);
    expect([...grouped]).toEqual([
      ['chrome-devtools', ['navigate_page', 'take_screenshot']],
      ['docs', ['search']],
    ]);
    expect(piDirectTools([]).size).toBe(0);
  });
});
