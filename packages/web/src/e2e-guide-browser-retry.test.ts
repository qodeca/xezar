import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GuideBrowser } from '../e2e/guide-browser'

/**
 * `clickRoleWhenStable`'s retry, against the failure shape agent-browser ACTUALLY produces.
 *
 * The retry exists for exactly one error — a click whose point is covered by another element — and
 * it recognizes it by matching the phrase "covered by" in the thrown message. On 2026-09-19 three
 * CI runs (main 35451994733, PR #702 35451195569 and #706's neighbour) went red on guide-02's
 * `find role link click --name Files` with `Element '@e13' is covered by <a.-mb-px.flex inside
 * div#root>`, and the failing run's own log shows how that text reaches the helper: agent-browser
 * writes `{"success":false,…,"error":"… covered by …"}` to STDOUT and exits 1, so it is `run()`'s
 * `execFileSync` catch that fires — whose message named only the command. The retry's predicate
 * therefore matched nothing and rethrew the covered click it exists to retry.
 *
 * The fake CLI below reproduces that transport byte for byte (non-zero exit, payload on stdout),
 * and `GuideBrowser.forBinary` drives it through the REAL `run()`, so this pins the whole path —
 * execFileSync's error, the wrapper's message, the predicate and the retry loop — rather than a
 * hand-built error object that could quietly drift from the CLI's real shape.
 *
 * Lives in `src/` for the same reason as `e2e-file-parallelism.test.ts`: the web unit project
 * collects `src/**` only, and this must hold on the fast gate (`npm test`), not only under
 * `npm run test:e2e`, which needs a real browser.
 */
describe('clickRoleWhenStable retries the covered click agent-browser really reports', () => {
  let dir: string
  let attempts: string

  const COVERED =
    "Element '@e13' is covered by <a.-mb-px.flex inside div#root> at its click point, so the input would land on that element instead."

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xezar-guide-browser-'))
    attempts = join(dir, 'attempts')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * A fake agent-browser: it answers the read-only commands `clickRoleWhenStable` issues, and its
   * click fails `fails` times with the covered-click payload before succeeding. Every click attempt
   * is counted in `attempts`, which is how a test tells "retried" from "succeeded first time" —
   * the outcome alone cannot.
   */
  function fakeAgentBrowser(fails: number, error: string = COVERED): GuideBrowser {
    const script = join(dir, 'agent-browser')
    writeFileSync(
      script,
      [
        '#!/usr/bin/env node',
        "import { readFileSync, writeFileSync } from 'node:fs'",
        'const args = process.argv.slice(2)',
        `const attemptsPath = ${JSON.stringify(attempts)}`,
        `const failUntil = ${fails}`,
        `const failure = ${JSON.stringify(error)}`,
        "let seen = 0; try { seen = Number(readFileSync(attemptsPath, 'utf8')) } catch {}",
        "const ok = (data) => process.stdout.write(JSON.stringify({ success: true, data }) + '\\n')",
        'const bad = () => {',
        "  process.stdout.write(JSON.stringify({ success: false, data: null, error: failure }) + '\\n')",
        '  process.exit(1)',
        '}',
        "if (args.includes('find')) {",
        '  seen += 1',
        '  writeFileSync(attemptsPath, String(seen))',
        '  if (seen <= failUntil) bad()',
        '  ok({})',
        "} else if (args.includes('snapshot')) {",
        "  ok({ snapshot: '', refs: { e13: { role: 'link', name: 'Files' } } })",
        "} else if (args.includes('box')) {",
        '  ok({ x: 10, y: 10, width: 40, height: 20 })',
        '} else {',
        '  ok({})',
        '}',
      ].join('\n'),
      'utf8',
    )
    chmodSync(script, 0o755)
    return GuideBrowser.forBinary(script, 'unit-guide-browser')
  }

  function clickAttempts(): number {
    try {
      return Number(readFileSync(attempts, 'utf8'))
    } catch {
      return 0
    }
  }

  it('retries past a covered click and succeeds on the second attempt', async () => {
    const browser = fakeAgentBrowser(1)

    await browser.clickRoleWhenStable('link', 'Files', { intervalMs: 1 })

    expect(clickAttempts()).toBe(2)
  })

  it('rethrows a failure that is not a covered click, after exactly one attempt (guard)', async () => {
    const browser = fakeAgentBrowser(5, 'Element @e13 is not visible')

    await expect(browser.clickRoleWhenStable('link', 'Files', { intervalMs: 1 })).rejects.toThrow(
      /agent-browser find role link click/,
    )
    expect(clickAttempts()).toBe(1)
  })

  it('the bare clickRole the spec used before has no retry at all', () => {
    const browser = fakeAgentBrowser(1)

    expect(() => browser.clickRole('link', 'Files')).toThrow(/covered by/)
    expect(clickAttempts()).toBe(1)
  })
})
