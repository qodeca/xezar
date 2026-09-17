import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootProjectId, readTestEnv } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Guide 11 — Configuration reference (docs/guide/11-configuration-reference.md), § "To start with
 * zero configuration". The shared fixture server boots with a fresh, pinned `XEZ_HOME`
 * (`scripts/test-env-up.sh`) and no project `.xezar/config.json`, so its Settings controls show
 * the documented defaults exactly — this file asserts the values the guide's tables promise
 * rather than re-deriving them.
 *
 * Dry-run exception register: disk corruption, a read-only home, concurrent writes and
 * environment/stored precedence are covered by `packages/xezar/src/workspace/config.test.ts`,
 * `config-lock.test.ts` and `migrations.test.ts` (browser-test-spec.md row "11"); this file
 * asserts only the resolved, visible defaults.
 */

let browser: GuideBrowser
let baseUrl: string
let bootProject: string

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  browser = GuideBrowser.open(`e2e-guide-11-${process.pid}`)
}, 60_000)

afterAll(() => {
  browser?.close()
})

describe('guide 11 — configuration reference', () => {
  it('an absent .xezar/config.json leaves every project default in place', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/settings/agents`)
    await browser.waitForRole('heading', 'Providers')

    // `skillsRepos` absent → the default catalog name is shown as the field's own value.
    expect(browser.valueOfRole('textbox', 'Team skill repositories')).toBe('qodeca/xezar-skills')
    // `plannerModel` / `namerModel` absent → "sonnet" / "haiku".
    expect(browser.valueOfRole('textbox', 'Planner model')).toBe('sonnet')
    expect(browser.valueOfRole('textbox', 'Namer model')).toBe('haiku')
    // `defaultRunner` absent → the machine's `agentDefaults.runner`, otherwise `claude` — the
    // composer and health-check cross-check this exact default in guide-04's own file.
    expect(browser.hasRole('radio', 'claude')).toBe(true)
    expect(browser.hasRole('switch', 'Review changes before finishing')).toBe(true)
  })

  it('an absent ~/.xezar/config.json leaves every workspace resource default in place', async () => {
    browser.goto(`${baseUrl}/settings/global/resources`)
    await browser.waitForRole('heading', 'Resources')

    expect(browser.valueOfRole('combobox', 'Max parallel tasks')).toBe('2')
    expect(browser.valueOfRole('combobox', 'Extra monitoring sessions')).toBe('2')
    expect(browser.valueOfRole('combobox', 'Monitoring wake-up')).toBe('Re-check on an interval')
    expect(browser.valueOfRole('spinbutton', 'Wake interval in minutes')).toBe('5')
    expect(browser.valueOfRole('combobox', 'Auto-resume after a usage limit')).toBe('On')
    expect(browser.valueOfRole('combobox', 'Idle session behaviour')).toBe('Close after')
    expect(browser.valueOfRole('spinbutton', 'Idle timeout in minutes')).toBe('15')
    expect(browser.valueOfRole('spinbutton', 'Default worktrees kept per project')).toBe('10')
    // `followups` absent → inherits `XEZ_FOLLOWUPS`, whose own default is off.
    expect(browser.valueOfRole('combobox', 'Follow-up Inbox')).toBe('Follow XEZ_FOLLOWUPS')
    // `composerDefaults` absent → each key inherits its own env seed.
    expect(browser.valueOfRole('combobox', 'Autonomous by default')).toBe('Inherit environment')
    expect(browser.valueOfRole('combobox', 'Use a worktree by default')).toBe('Inherit environment')
  })

  it('an absent skillsAutoUpdate leaves automatic skill updates on', async () => {
    browser.goto(`${baseUrl}/settings/global/skills`)
    await browser.waitForRole('heading', 'Skills')
    expect(browser.hasRole('switch', 'Update xezar-skills automatically')).toBe(true)
    expect(browser.hasText('Update xezar-skills automatically')).toBe(true)
  })
})
