import './scripts/test-local-state.mjs'
import { availableParallelism } from 'node:os'
import { defineConfig } from 'vitest/config'

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

// One `npm test` must not take the whole machine. Vitest's own default is
// `availableParallelism() - 1` workers, which is right for a laptop running ONE suite and
// catastrophic for a cockpit running several gate runs at once: ten concurrent gates on an
// 18-core box meant ~180 worker processes, and the symptom was starvation — unrelated
// suites timing out (909s on a single file), a different 17 files failing every run.
//
// The cap is `min(4, availableParallelism() - 1)`, which is deliberately a **no-op on CI**:
// a 2-core GitHub runner already resolves to 1 and a 4-core one to 3, so this only bites on
// a machine with more than 5 cores — exactly the machine that can run many gates at once.
// Four was reasoned, not measured: at the default `maxParallel` of 2 concurrent runs it
// keeps the fan-out at ~8 of 18 cores, and even at the ten-run worst case it is 2.2x
// oversubscription instead of 10x.
//
// Both runtime overrides still win: `--maxWorkers=N` on the command line, and
// `VITEST_MAX_WORKERS`, which vitest applies AFTER config resolution.
const MAX_WORKERS = Math.max(1, Math.min(4, availableParallelism() - 1))

export default defineConfig({
  test: {
    maxWorkers: MAX_WORKERS,
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
