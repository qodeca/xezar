import '../../scripts/test-local-state.mjs'
import { defineConfig, mergeConfig } from 'vitest/config'

import { vitestMaxWorkers } from '../../scripts/test-concurrency.mjs'

import viteConfig from './vite.config'

// Reuse the build config verbatim (root, React plugin, `@` → packages/web/src) and only add the
// test layer, so a component under test resolves its imports exactly like the shipped bundle.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      name: 'web',
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      // The shared worker cap (scripts/test-concurrency.mjs), so `npm test -w` on this package alone is
      // capped like the root run; it steps aside when the command line names `--maxWorkers`.
      maxWorkers: vitestMaxWorkers(),
    },
  }),
)
