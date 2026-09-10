import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The browser suite's sequential guarantee (#162).
 *
 * `packages/web/e2e/vitest.config.ts` declares `fileParallelism: false` because those specs
 * share one server, one machine and one set of on-disk fixtures — `project-groups.e2e.ts`
 * rewrites the workspace registry that decides whether the sidebar renders its flat shell (and
 * therefore whether `[data-slot="repo-chip"]` exists at all), and three separate specs seed AND
 * delete the same two files under `<repo>/.ai/skills/`.
 *
 * Vitest does not treat that declaration as final: `VITEST_MAX_WORKERS` is applied at the very
 * end of config resolution and overrides it, as does nothing on the command line. An operator
 * who exports the variable to speed up `npm test` silently re-parallelizes the browser suite,
 * and specs start failing on content that a CONCURRENT spec deleted — a different file each
 * run, none of them related to the change under test.
 *
 * So the config deletes the variable, and this pins that it does. It lives here rather than
 * beside the specs because `packages/web/vitest.config.ts` collects `src/**` only, and because
 * the rule must hold for `npm test` — the fast gate — not just for `npm run test:e2e`.
 */
describe('the e2e suite pins itself to one worker', () => {
  const CONFIG = '../e2e/vitest.config'
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.VITEST_MAX_WORKERS
    // `resetModules` so the config's module body — where the deletion lives — runs again for
    // this test rather than being served from the ESM cache of an earlier import.
    vi.resetModules()
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.VITEST_MAX_WORKERS
    else process.env.VITEST_MAX_WORKERS = saved
  })

  it('neutralizes VITEST_MAX_WORKERS, which outranks fileParallelism and the CLI', async () => {
    process.env.VITEST_MAX_WORKERS = '4'

    await import(CONFIG)

    expect(process.env.VITEST_MAX_WORKERS).toBeUndefined()
  })

  it('still asks for it the declarative way too, so the intent survives a vitest change', async () => {
    const config = (await import(CONFIG)).default as { test?: { fileParallelism?: boolean } }

    expect(config.test?.fileParallelism).toBe(false)
  })
})
