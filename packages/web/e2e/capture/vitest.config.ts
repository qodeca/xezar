import '../../../../scripts/test-local-state.mjs'
import { defineConfig } from 'vitest/config'

/**
 * The docs capture harness (#448 PR-1b) — NOT a test suite and NOT part of any gate.
 *
 * It lives beside the browser suite because it drives the app through the same provider seam
 * (`../agent-browser.ts`), but it matches `*.capture.ts` only, so `npm run test:e2e`
 * (`**\/*.e2e.ts`) never collects it and the gate's file count does not grow.
 * `src/e2e-capture-include.test.ts` fails if either half of that stops being true.
 *
 * Run it with `npm run capture:screenshots -w @qodeca/xezar-web` after `npm run build`.
 *
 * Same one-worker rule as the browser suite, for the same reason (#162): the harness owns one
 * browser session and one fixture server, and `VITEST_MAX_WORKERS` would outrank
 * `fileParallelism: false` if it were left in the environment.
 */
delete process.env.VITEST_MAX_WORKERS

export default defineConfig({
  test: {
    name: 'capture',
    root: import.meta.dirname,
    environment: 'node',
    include: ['**/*.capture.ts'],
    fileParallelism: false,
    // Seeding runs through the dry-run mock and ~40 browser captures take minutes, not seconds.
    testTimeout: 900_000,
    hookTimeout: 300_000,
  },
})
