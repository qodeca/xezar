import '../../scripts/test-local-state.mjs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

import { SERVER_TEST_BUDGETS } from './vitest.budgets.ts'

// The test set the read-only lock mutation run (`npm run test:mutation:lock`,
// stryker.lock.config.mjs) kills mutants with: the suites aimed at the lock and the Qwen Code tool
// policy, in process. Its own file for the reasons `vitest.mutation.config.ts` gives: Stryker hands
// vitest a config and no path filters, and `root` is pinned because Stryker runs from the
// repository root.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'server-lock-mutation',
    environment: 'node',
    include: [
      'src/core/read-only-lock.test.ts',
      'src/core/qwen-tool-policy.test.ts',
      'src/core/qwen-hook-command.test.ts',
      'src/core/codex-read-only-hook.test.ts',
    ],
    // The server suite's test, hook and poll budgets – see vitest.budgets.ts for why.
    ...SERVER_TEST_BUDGETS,
    setupFiles: ['./vitest.setup.ts'],
  },
})
