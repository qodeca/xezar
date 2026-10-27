import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

const artifactsDir = resolve(import.meta.dirname, '../../../.local/qa/artifacts_e2e')
const sessionId = `e2e-automations-${process.pid}`

let browser: AgentBrowser
let baseUrl: string
let bootProject: string
/** `capabilities.automations` (#801) — the shared environment boots WITHOUT the opt-in, which is
 *  what a default xezar does, so the disabled path is the one this file asserts. */
let automationsAvailable = false

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  const health = (await fetch(`${baseUrl}/api/v1/health`).then((response) => response.json())) as {
    capabilities: { automations: boolean }
  }
  automationsAvailable = health.capabilities.automations
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
})

afterAll(() => {
  browser?.close()
})

/**
 * The enabled path lives elsewhere. `guide-07-github-automations.e2e.ts` boots its own
 * `XEZ_AUTOMATIONS=1` fixture and drives create (Paused) → Enable → execution log in a real
 * browser on every run. The preview check is unit-pinned in
 * `src/routes/automations/automations.test.tsx` and cannot run in a browser spec: the check
 * searches GitHub through `gh`, which the dry-run forge does not mock, so a fixture without a
 * signed-in `gh` answers `error` (docs/testing/coverage-gaps.md § 3.3).
 */
describe('GitHub automations', () => {
  // The default shape of the product, asserted in a real browser: nothing about automations is
  // reachable or advertised until an operator opts in. Before #801 this sidebar item was present
  // on every project with a GitHub remote, which is exactly what the flag exists to undo.
  it('is absent from the sidebar and refuses its API without the opt-in', async ({ skip }) => {
    skip(automationsAvailable, 'the shared environment explicitly enabled automations')
    browser.goto(`${baseUrl}/p/${bootProject}/`)
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"]') !== null`)
    expect(browser.text('[data-slot="sidebar"]')).not.toContain('Automations')

    // The deep link still resolves — the route map is unchanged — but says the feature is off.
    browser.goto(`${baseUrl}/p/${bootProject}/automations`)
    browser.waitForFunction(`document.body.textContent.includes('GitHub automations are off')`)
    expect(browser.text('main')).toContain('XEZ_AUTOMATIONS=1')
    browser.screenshot(`${artifactsDir}/automations-disabled.png`)

    const refused = await fetch(`${baseUrl}/api/v1/automations`)
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toContain('XEZ_AUTOMATIONS')
  }, 60_000)
})
