import '../../scripts/test-local-state.mjs'
import { defineConfig } from 'vitest/config'

// The service + CLI suite: Node ESM, no DOM, no bundler. `test/` is deliberately NOT included
// — those are the node:test suites (`npm run test:unit`, `npm run test:package`), which pack
// and install the real tarball and must not run inside the fast unit gate.
export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Pins XEZ_HOME to a per-worker sandbox so no case can write the developer's
    // real ~/.xezar — see the file for the failure it prevents.
    setupFiles: ['./vitest.setup.ts'],
  },
})
