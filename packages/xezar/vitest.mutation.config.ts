import '../../scripts/test-local-state.mjs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The test set the MCP mutation run (`npm run test:mutation:mcp`, stryker.config.mjs) kills
// mutants with: the MCP suites alone, the same files `npm run test:coverage:mcp` measures.
// A mutant another suite happens to kill was never aimed at by an MCP test (SDLC.md § The MCP
// test floor). Its own file, not vitest.config.ts with a filter, because Stryker hands vitest a
// config and no path filters; and `mergeConfig` would CONCATENATE `include` with the server's
// `src/**/*.test.ts` instead of narrowing it. `root` is pinned because Stryker runs vitest from
// the repository root, where the relative globs below would match nothing.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'server-mcp-mutation',
    environment: 'node',
    include: [
      'src/mcp/**/*.test.ts',
      'src/server/mcp-*.test.ts',
      'src/server/stale-write-routes*.test.ts',
    ],
    setupFiles: ['./vitest.setup.ts'],
    // ONE test is left out, by name, and only here. It reads `opencode.ts` as TEXT and asserts
    // the text never says `process.` – and Stryker instruments every mutated file with code that
    // does, so on the sandbox copy it fails before a single mutant runs (measured: the dry run
    // refuses to start). A test that reads text cannot kill a mutant, which changes behaviour and
    // leaves the text alone, so nothing is lost; it still runs in `npm test` on the real source.
    testNamePattern:
      /^(?!.*AGENTS\.md — no XDG_CONFIG_HOME, no environment, no file writes reads and writes no environment variable)/,
  },
})
