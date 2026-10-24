import '../../scripts/test-local-state.mjs'
import { defineConfig } from 'vitest/config'

import { vitestMaxWorkers } from '../../scripts/test-concurrency.mjs'

// Node environment on purpose: nothing in the api-client may need a DOM to be tested, and a
// jsdom here would hide an accidental browser-only dependency in a package that the Node
// service imports too.
export default defineConfig({
  test: {
    name: 'api-client',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The shared worker cap (scripts/test-concurrency.mjs), so `npm test -w` on this package alone is
    // capped like the root run; it steps aside when the command line names `--maxWorkers`.
    maxWorkers: vitestMaxWorkers(),
  },
})
