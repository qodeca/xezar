// @ts-check
import base from './stryker.config.mjs'

// The read-only lock mutation run – `npm run test:mutation:lock`. It runs nightly as its own job in
// `.github/workflows/mutation.yml`, beside the MCP shards and never per PR, and by hand
// (docs/testing/coverage-gaps.md § 10.13).
//
// It mutates the two files that decide what a read-only step may run: `core/read-only-lock.ts`
// (the shared shell-command decision every backend uses) and `core/qwen-tool-policy.ts` (Qwen Code's
// tool lists and hook decision). A surviving mutant there is a refusal no test would miss, which is
// the class of weakness coverage cannot show.
//
// Its own file, not a widened `mutate` in `stryker.config.mjs`: that file is the nightly gate's
// scope and floor, and `mutation/shards.mjs` and `mutation/aggregate.mjs` read both from it, so
// adding files there would change the gate's shards, weights and score. Everything else – the
// runner, `ignoreStatic`, the concurrency cap, the timeouts, the sandbox rules – is the gate's, by
// spreading it. The report and the sandbox get their own folders, so this run and the MCP run can
// share a checkout.
//
// `break` is this scope's floor, and this file is its only home: Stryker fails the nightly job below
// it, and `mutation/aggregate.mjs` reads it from here to fail the night's verdict the same way. It
// is one number for both files, like the MCP gate's. Measured on 2026-10-19 at `5a31cf0` (an
// 18-core laptop, concurrency 4): 71.64 % over 1 079 tested mutants (`read-only-lock.ts` 73.00 %,
// `qwen-tool-policy.ts` 66.52 %), so 71 clears it by 0.64 points: a floor, never a target. The
// rewrite of `read-only-lock.ts`'s Git handling changes the file this score measures; re-measure
// when it lands.
// Run from the repository root: every path below is relative to it.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  vitest: { configFile: 'packages/xezar/vitest.mutation.lock.config.ts' },
  mutate: ['packages/xezar/src/core/read-only-lock.ts', 'packages/xezar/src/core/qwen-tool-policy.ts'],
  thresholds: { ...base.thresholds, break: 71 },
  htmlReporter: { fileName: '.local/mutation/lock/index.html' },
  jsonReporter: { fileName: '.local/mutation/lock/report.json' },
  tempDirName: '.local/stryker-tmp-lock',
}
