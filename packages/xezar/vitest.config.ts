import '../../scripts/test-local-state.mjs'
import { defineConfig } from 'vitest/config'

// The service + CLI suite: Node ESM, no DOM, no bundler. `test/` is deliberately NOT included
// — those are the node:test suites (`npm run test:unit`, `npm run test:package`), which pack
// and install the real tarball and must not run inside the fast unit gate.
export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Vitest's 5 000 ms default is a unit-test clock, and this is not a unit suite: its cases
    // spawn a real agent CLI, open loopback sockets and run `git worktree add`. The default was
    // the single largest source of meaningless red gates — of 1 012 sealed gate attempts between
    // 2026-09-10 and 2026-09-18, `npm test` failed on 16.6 % while every other gate failed on
    // 0.1–3.2 %, and 217 of the 225 timeouts in those logs fired at exactly 5 000 ms, on tests
    // that pass in isolation. The cause is contention, not slow code: the root config caps
    // workers precisely because this machine deliberately runs several gate runs at once.
    //
    // 15 000 ms rather than a rounder number because the suite already chose it: every case here
    // that KNEW it would be slow names its own budget, and `src/core/claude-cli-runner.test.ts`
    // picks `15_000` five times over. Those explicit budgets (15 s, 60 s, 120 s) are unaffected —
    // a per-test argument still wins. What this governs is the case nobody predicted would be
    // slow, which is exactly the population that was flaking. A hung test still fails well inside
    // one gate, and a passing run pays nothing: a timeout only bounds a test that is already
    // failing.
    testTimeout: 15_000,
    // `expect.poll` has its own, shorter default of ONE second, and it had already been
    // hand-patched to 3 000 ms at four call sites whose comments name this exact flake. One
    // budget for the suite replaces those one-off patches. It sits BELOW `testTimeout` on
    // purpose: a poll that runs out then reports "Matcher did not succeed in time" against its
    // own predicate, instead of being swallowed by the enclosing test timeout, which says
    // nothing about which condition never came true.
    expect: { poll: { timeout: 10_000 } },
    // Pins XEZ_HOME to a per-worker sandbox so no case can write the developer's
    // real ~/.xezar, and scrubs the ambient ANTHROPIC_MODEL — see the file for both.
    setupFiles: ['./vitest.setup.ts'],
  },
})
