import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Break: the MCP ready line told people to run `xez mcp`, a shim npm does not always create,
// while every doc says `xezar mcp` (#1010). Both places that print it are in `index.ts`.
describe('the MCP ready line (#1010)', () => {
  const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

  it('names `xezar mcp` in both places it is printed, and never `xez mcp`', () => {
    expect(source.match(/ready \$\{glyphs\.dash\} run xezar mcp in /g)).toHaveLength(2);
    expect(source).not.toMatch(/run xez mcp/);
  });
});
