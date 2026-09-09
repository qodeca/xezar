import './scripts/test-local-state.mjs'
import { defineConfig } from 'vitest/config'

// Four packages, one `npm test`. Each owns its own vitest config — this file only names
// them, so `npm test -w <pkg>` and the whole-repo run execute the identical setup:
//   - packages/xezar     Node ESM (NodeNext, `.js` relative imports)
//   - packages/contract   the zod schemas every wire shape is defined by
//   - packages/api-client the Node-free typed client over those schemas
//   - packages/web        DOM code, resolved exactly as Vite bundles it
//
// A package missing from this list is a package whose `*.test.ts` files never run, however
// right they look (#61 — `contract` was in exactly that state).
export default defineConfig({
  test: {
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
