// The one place every test runner in this repository reads its parallelism cap from: the root
// vitest config, each package's vitest config, and the node:test launcher (`node-test.mjs`) behind
// `npm run test:unit` and `npm run test:package`.
//
// Why a cap at all: vitest's default is `availableParallelism() - 1` workers and node:test's
// default `--test-concurrency` is the same number. That is right for a laptop running ONE suite and
// catastrophic for a machine running several gate runs at once: ten concurrent gates on an 18-core
// box meant ~180 worker processes, and the symptom was starvation — unrelated suites timing out
// (909s on a single file), a different 17 files failing every run. The gate also runs `npm test`,
// `npm run test:unit` and `npm run test:package` side by side in separate lanes, so one gate run
// alone used to fan out to three uncapped pools.
//
// The cap is `min(4, availableParallelism() - 1)`, which is deliberately a **no-op on CI**: a
// 2-core GitHub runner already resolves to 1 and a 4-core one to 3, so this only bites on a machine
// with more than 5 cores — exactly the machine that can run many gates at once. Four was reasoned,
// not measured: at the default `maxParallel` of 2 concurrent runs it keeps the fan-out at ~8 of 18
// cores, and even at the ten-run worst case it is 2.2x oversubscription instead of 10x.
//
// It is a guarantee, not a tuning knob (AGENTS.md § Validation): raising or deleting it re-creates
// the starvation, and because it is a no-op on CI a green CI run is not evidence that it works.
import { availableParallelism } from 'node:os';

export const TEST_MAX_WORKERS = Math.max(1, Math.min(4, availableParallelism() - 1));

// vitest's `--maxWorkers` / `--max-workers`, in either the `=N` or the separate-argument form.
const MAX_WORKERS_FLAG = /^--max-?workers(?:=|$)/i;

/**
 * The `maxWorkers` a vitest config should declare, or `undefined` when the command line already
 * names one.
 *
 * A package config is loaded two ways: as the root config (`npm test -w <pkg>`, where a command-line
 * `--maxWorkers` overrides the config as usual) and as one of the root config's `projects`. In the
 * second case vitest does NOT pass `--maxWorkers` down to the project (it is missing from the CLI
 * options it forwards), and a project's own `maxWorkers` outranks the root's when the pool is
 * sized, so a hard-coded value here would silently defeat the documented
 * `npm test -- --maxWorkers=N` override. Stepping aside when the flag is present leaves vitest to
 * use the command-line value from the root. `VITEST_MAX_WORKERS` needs no such care: vitest applies
 * it at the very end of every config's resolution, projects included, so it outranks this value
 * either way.
 */
export function vitestMaxWorkers(argv = process.argv) {
  return argv.some((arg) => MAX_WORKERS_FLAG.test(arg)) ? undefined : TEST_MAX_WORKERS;
}
