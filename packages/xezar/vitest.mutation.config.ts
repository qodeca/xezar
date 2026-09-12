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
    // One CLASS of test is left out, and only here: the `AGENTS.md — …` guards that read an
    // adapter's own source as TEXT and assert the text never says `process.`. Stryker instruments
    // every mutated file with a header that does say it, so on the sandbox copy such a guard fails
    // before a single mutant runs (measured: the dry run refuses to start). A test that reads text
    // cannot kill a mutant, which changes behaviour and leaves the text alone, so nothing is lost;
    // they still run in `npm test` against the real source.
    //
    // The pattern matches the class, not one spelling, because pinning one exact name is how this
    // broke: the first guard (opencode.ts) was excluded by its full name, #358 added a second one
    // (pi.ts) whose describe reads "no environment, no file writes, no process" instead of "no
    // XDG_CONFIG_HOME, …", the exclusion missed it and the release gate died at the dry run (#375).
    // Both share the stable shape below, so a third such guard is covered on the day it is written.
    // `src/mutation-name-filter.test.ts` fails if a guard of this class escapes the pattern.
    testNamePattern:
      /^(?!.*AGENTS\.md — .*reads and writes no environment variable)/,
  },
})
