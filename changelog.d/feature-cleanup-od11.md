## 🚀 CI/CD & Infrastructure

- 🚀 **The node:test suites and a single package's vitest run now share the test worker cap.**
  `npm run test:unit` and `npm run test:package` ran with node's default concurrency (one file
  per core but one) and `npm test -w <package>` ignored the root cap, so one gate run could still
  fan out to three uncapped pools. All of them now read `min(4, availableParallelism() - 1)` from
  `scripts/test-concurrency.mjs`. It is still a no-op on CI's small runners, and
  `--maxWorkers=N`, `VITEST_MAX_WORKERS` and an explicit `--test-concurrency` still win.
