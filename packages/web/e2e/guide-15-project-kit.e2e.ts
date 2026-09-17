import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootProjectId, readTestEnv } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Guide 15 — Project kit (docs/guide/15-project-kit.md). Its one cockpit surface is Settings →
 * Project setup: guided setup's not-yet-run state, and the same `skillsRepos`-absent default the
 * guide's own table promises ("qodeca/xezar-skills", subject to personal skill selection).
 *
 * Dry-run exception register: writing `.xezar/workflows/fix-and-verify.yaml` and
 * `.xezar/skills/project-conventions.md`, and the collision guard when the kit path would be the
 * workspace home, are covered by `packages/xezar/src/init-kit.test.ts:12-52` and
 * `packages/xezar/src/project-kit-cli.test.ts:8-29` (browser-test-spec.md's guide-15 row); running
 * the actual `xez-onboard` guided-setup skill end to end is manual with a dated record, since it
 * depends on a real team-skills network fetch this dry-run fixture does not perform.
 */

let browser: GuideBrowser
let baseUrl: string
let bootProject: string

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  browser = GuideBrowser.open(`e2e-guide-15-${process.pid}`)
}, 60_000)

afterAll(() => {
  browser?.close()
})

describe('guide 15 — project kit', () => {
  it('an unconfigured project offers guided setup rather than assuming one already ran', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/settings/project-setup`)
    await browser.waitForRole('heading', 'Project setup')
    await browser.waitForRole('heading', 'Guided setup')

    expect(browser.hasRole('heading', 'Guided setup')).toBe(true)
    expect(browser.hasRole('heading', 'Not set up yet')).toBe(true)
    expect(browser.hasRole('button', 'Set up this project')).toBe(true)
  })

  it('an absent skillsRepos keeps the default team-skills catalog visible on the Agents page', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/settings/agents`)
    await browser.waitForRole('heading', 'Team skill repositories')
    expect(browser.valueOfRole('textbox', 'Team skill repositories')).toBe('qodeca/xezar-skills')
    // Guide 15's own table: an explicit list "hides Manage skills" — since nothing is explicit
    // here, the shared-catalog affordance stays.
    expect(browser.hasRole('button', 'Use the shared catalog')).toBe(true)
  })
})
