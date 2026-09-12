// @ts-check
import base from './stryker.config.mjs'

// ONE SHARD of the MCP mutation gate — `npm run test:mutation:mcp:shard -- --mutate <files>`,
// driven by `.github/workflows/mutation.yml`. Everything about the run is `stryker.config.mjs`;
// this file changes exactly one thing and says why.
//
// `thresholds.break` is null HERE, and 80 there. A shard measures a SLICE, and a slice's score
// is not the gate's score: per file the spread is wide (docs/testing/coverage-gaps.md § 10.8
// point 1 — `adapters/` sits at 64 % against `tool.ts` at 100), so any per-shard floor would
// either fail an honest run or pass a broken one depending on which files the split happened to
// group. The floor is applied ONCE, by `scripts/mutation-aggregate.mjs`, to the status counts
// summed over every shard — the same arithmetic Stryker itself does — and that script reads the
// 80 out of `stryker.config.mjs` rather than repeating it. Nothing is lowered; the decision
// simply moves to the only place that can see the whole scope.
//
// `mutate` is deliberately NOT narrowed here. The file list arrives on the command line, from
// `scripts/mutation-shards.mjs`. A shard launched without `--mutate` therefore inherits the base
// scope and mutates everything, which is slow and correct — the safe direction. A shard that
// mutates nothing is caught by the aggregate, which fails on a shard that tested no mutants.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  thresholds: { ...base.thresholds, break: null },
}
