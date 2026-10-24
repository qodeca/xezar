import './scripts/test-local-state.mjs'
import { defineConfig } from 'vitest/config'

import { TEST_MAX_WORKERS } from './scripts/test-concurrency.mjs'

// Four packages, one `npm test`. Each owns its own vitest config — this file only names
// them, so `npm test -w <pkg>` and the whole-repo run execute the identical setup:
//   - packages/xezar     Node ESM (NodeNext + rewriteRelativeImportExtensions, so relative
//                        imports name the real `.ts` file and tsc rewrites the extension on emit)
//   - packages/contract   the zod schemas every wire shape is defined by
//   - packages/api-client the Node-free typed client over those schemas
//   - packages/web        DOM code, resolved exactly as Vite bundles it
//
// A package missing from this list is a package whose `*.test.ts` files never run, however
// right they look (#61 — `contract` was in exactly that state).

// One `npm test` must not take the whole machine: the worker cap, `min(4, availableParallelism() - 1)`,
// and the reasoning behind it live in scripts/test-concurrency.mjs, which every package config and
// the node:test launcher read too, so a package run on its own (`npm test -w <pkg>`) and the
// node:test suites are capped exactly like this one.
//
// Both runtime overrides still win: `--maxWorkers=N` on the command line, and
// `VITEST_MAX_WORKERS`, which vitest applies AFTER config resolution.
export default defineConfig({
  test: {
    maxWorkers: TEST_MAX_WORKERS,
    // The suites are still being grown; a project that currently matches no file must not
    // fail the validation gate. Root-level only — vitest rejects this inside a project.
    passWithNoTests: true,
    projects: [
      './packages/xezar/vitest.config.ts',
      './packages/contract/vitest.config.ts',
      './packages/api-client/vitest.config.ts',
      './packages/web/vitest.config.ts',
    ],
  },
})
