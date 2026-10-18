// @ts-check
import base from './stryker.config.mjs'

// The read-only lock mutation run – `npm run test:mutation:lock`, run by hand, never per PR and
// not part of the nightly MCP gate (docs/testing/coverage-gaps.md § 10.13).
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
// No `break`: this run records a score, it does not gate. Adopting a floor is a decision, not a
// tightening (the same argument § 10.8 makes for a per-file floor).
// Run from the repository root: every path below is relative to it.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  vitest: { configFile: 'packages/xezar/vitest.mutation.lock.config.ts' },
  mutate: ['packages/xezar/src/core/read-only-lock.ts', 'packages/xezar/src/core/qwen-tool-policy.ts'],
  thresholds: { ...base.thresholds, break: null },
  htmlReporter: { fileName: '.local/mutation/lock/index.html' },
  jsonReporter: { fileName: '.local/mutation/lock/report.json' },
  tempDirName: '.local/stryker-tmp-lock',
}
