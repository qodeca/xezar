#!/usr/bin/env node
// `node --test` with the repository's test parallelism cap, for the node:test suites
// (`npm run test:unit`, `npm run test:package` in packages/xezar). Usage is exactly node's own:
//
//   node ../../scripts/node-test.mjs --import <preload> --test <patterns…>
//
// It runs the same node binary with `--test-concurrency=<cap>` in front of every argument it was
// given, and exits with that run's status. node:test's default concurrency is
// `availableParallelism() - 1`, the same uncapped fan-out the vitest cap exists to stop; the value
// and the reasoning live in `test-concurrency.mjs`.
//
// An explicit `--test-concurrency` among the arguments wins: then nothing is added, and node reads
// the caller's value.
import { spawnSync } from 'node:child_process';

import { TEST_MAX_WORKERS } from './test-concurrency.mjs';

const args = process.argv.slice(2);
const explicit = args.some((arg) => arg === '--test-concurrency' || arg.startsWith('--test-concurrency='));
const run = spawnSync(
  process.execPath,
  explicit ? args : [`--test-concurrency=${TEST_MAX_WORKERS}`, ...args],
  { stdio: 'inherit' },
);

if (run.error) {
  console.error(`node-test: could not start ${process.execPath}: ${run.error.message}`);
  process.exit(1);
}
// A run ended by a signal has no status; report it as a failure, never as a pass.
process.exit(run.status ?? 1);
