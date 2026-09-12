// @ts-check
import { availableParallelism } from 'node:os'

// The MCP mutation run – `npm run test:mutation:mcp`, never a per-PR one (#333,
// docs/testing/coverage-gaps.md § 10.3; the per-PR form is the named break SDLC.md requires).
// It was the `release` / `release-prep` workflows' first check step until 2026-09-12; that step
// was removed because a release-only gate gets its first real exercise at the most expensive
// moment (#375) and its repair lives in somebody else's PR. **Right now it runs nowhere
// automatically** – it is a manual command, and #377 owns giving it a schedule. The scope and
// the floor below are unchanged.
// Run from the repository root: every path below is relative to it.
//
// Two guarantees this file carries, and what each is for:
//
// - Stryker is a devDependency of @qodeca/xezar and this file sits outside the package's
//   `files` allowlist, so neither reaches the published tarball.
//   `src/release/publishing-surface.test.ts` fails if either stops being true.
// - One mutant cannot stall the gate. A mutant that makes a test wait forever (the #333
//   sample met one in `ipc.ts`, which held its run for a 600 s cap) is killed after
//   `timeoutMS + timeoutFactor × its tests' normal time` and counted as a Timeout – detected,
//   as Stryker counts it – and the run moves on. The dry run is capped the same way.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'packages/xezar/vitest.mutation.config.ts' },
  mutate: ['packages/xezar/src/mcp/**/*.ts', '!**/*.test.ts', '!**/*.testkit.ts'],
  coverageAnalysis: 'perTest',
  // A STATIC mutant sits in code that runs once, when its module loads – constant tables,
  // module-level regexes and schema declarations – so no single test covers it and Stryker must
  // run all 932 MCP tests for each one. With them in, Stryker estimated ~60 hours on this scope
  // (measured 2026-09-11); without them a run fits a release. They are reported as Ignored,
  // never as killed, and what they would have measured is pinned where the value is USED, the
  // same argument coverage-gaps.md § 10.5 makes for zod declarations.
  ignoreStatic: true,
  // The same guarantee as the root vitest.config.ts worker cap: a machine running several
  // gate runs at once starves at `cores - 1` per run.
  concurrency: Math.max(1, Math.min(4, availableParallelism() - 1)),
  timeoutMS: 10_000,
  timeoutFactor: 1.5,
  dryRunTimeoutMinutes: 10,
  // `break` fails the run below this mutation score. The full run measured 81.39 % on 2026-09-12
  // (11 292 mutants, 3 h 40 min – coverage-gaps.md § 10.8), so this floor clears by 1.39 points and
  // is deliberately thin. It is a floor, never a target, and it is one number for the whole scope:
  // per file the spread is still wide, which § 10.8 lists and #338 closes.
  thresholds: { high: 90, low: 80, break: 80 },
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: '.local/mutation/mcp/index.html' },
  jsonReporter: { fileName: '.local/mutation/mcp/report.json' },
  tempDirName: '.local/stryker-tmp',
  cleanTempDir: 'always',
  // The sandbox is a copy of the repository. Only runtime state is left out: the MCP suites read
  // docs/ (the A-05 inventory) and test/helpers/ (the fake `gh`), so a narrower copy fails the dry run.
  ignorePatterns: ['/.local'],
  // Stryker's copy drops the executable bit. Without it `XEZ_DRY_RUN=1` cannot spawn the
  // bundled mock agent, a run the MCP suites start fails with EACCES, and the dry run refuses
  // to begin (measured: `composition.test.ts`). These are the tracked 100755 files the suites run.
  buildCommand:
    'chmod +x packages/xezar/scripts/mock-claude.mjs packages/xezar/scripts/mock-pi-rpc.mjs ' +
    'packages/xezar/src/core/__fixtures__/claude/stub-ignores-eof-exits-143.mjs ' +
    'packages/xezar/src/core/__fixtures__/codex/mock-codex-app-server.mjs ' +
    'packages/xezar/src/core/__fixtures__/opencode/mock-opencode-serve.mjs',
}
