import { readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The docs capture harness (#448 PR-1b) must never become part of the browser gate.
 *
 * It sits inside `packages/web/e2e/` so it can share the provider seam, and that is exactly the
 * risk: the browser suite's include is `**\/*.e2e.ts` rooted at `e2e/`, so ONE harness file named
 * `*.e2e.ts` — or a widened include — would add a multi-minute capture run (that also rewrites
 * `docs/screenshots/`) to every `npm run test:e2e`. This pins both configs and the files on disk.
 *
 * Lives in `src/` for the same reason as `e2e-file-parallelism.test.ts`: the web unit project
 * collects `src/**` only, and the rule must hold on the fast gate.
 */

const e2eDir = resolve(import.meta.dirname, '../e2e')
const captureDir = resolve(e2eDir, 'capture')

function filesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => relative(e2eDir, resolve(entry.parentPath, entry.name)))
}

/** `**\/*.<suffix>` rooted at `e2e/` — the only include shape either config uses. */
const matches = (suffix: string) => (file: string) => file.endsWith(suffix)

describe('the capture harness stays outside the browser suite', () => {
  it('the browser suite still collects *.e2e.ts and nothing else', async () => {
    const config = (await import('../e2e/vitest.config')).default as { test?: { include?: string[] } }
    expect(config.test?.include).toEqual(['**/*.e2e.ts'])
  })

  it('the capture config collects *.capture.ts and nothing else', async () => {
    const config = (await import('../e2e/capture/vitest.config')).default as {
      test?: { include?: string[]; root?: string }
    }
    expect(config.test?.include).toEqual(['**/*.capture.ts'])
    expect(config.test?.root).toBe(captureDir)
  })

  it('no file under e2e/capture/ is collected by the browser suite', () => {
    const collected = filesUnder(e2eDir).filter(matches('.e2e.ts'))
    expect(collected.filter((file) => file.startsWith('capture/'))).toEqual([])
    // And the harness really exists, so the check above is not vacuously green.
    expect(filesUnder(captureDir).filter(matches('.capture.ts')).length).toBeGreaterThan(0)
  })

  it('no *.capture.ts file sits outside e2e/capture/, where the browser suite could reach it by rename', () => {
    const stray = filesUnder(e2eDir).filter(matches('.capture.ts')).filter((f) => !f.startsWith('capture/'))
    expect(stray).toEqual([])
  })
})
