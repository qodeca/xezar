import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootProjectId, readTestEnv } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Guide 10 — Settings reference (docs/guide/10-settings-reference.md): "This page names each
 * section and the task it helps you perform." The guide's own contract is navigational — every
 * named project and global settings section exists and renders its own heading — so this file
 * walks that contract rather than re-asserting individual controls already covered by
 * `settings-agents.e2e.ts`, `settings-appearance.e2e.ts`, `settings-monitoring.e2e.ts`,
 * `settings-resources.e2e.ts`, `settings-skills.e2e.ts` and `command-palette.e2e.ts`.
 *
 * Dry-run exception register: the command palette itself (⌘K/Ctrl+K open, filter, Enter) is
 * already a full browser journey in `command-palette.e2e.ts`; this file does not repeat it.
 */

let browser: GuideBrowser
let baseUrl: string
let bootProject: string

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  browser = GuideBrowser.open(`e2e-guide-10-${process.pid}`)
}, 60_000)

afterAll(() => {
  browser?.close()
})

describe('guide 10 — settings reference', () => {
  it('every project settings section link lands on a page whose own heading names it', async () => {
    // "General" is the index route: its own page heading stays "Settings" rather than repeating
    // the nav label, so it is checked on its own below; every other section's h1 names itself.
    const sections = [
      'Agents',
      'Agent config',
      'Project setup',
      'Worktrees',
      'Bookmarklets',
      'Prompt templates',
      'MCP connection',
      'MCP API',
    ]

    browser.goto(`${baseUrl}/p/${bootProject}/settings`)
    await browser.waitForRole('heading', 'Settings')
    expect(browser.hasRole('link', 'General')).toBe(true)

    for (const section of sections) {
      browser.clickRole('link', section, { exact: true })
      await browser.waitForRole('heading', section)
      expect(browser.textOfRole('heading', section, { exact: true })).toBe(section)
      // The section stays reachable from every other section — the nav re-renders, not replaces.
      expect(browser.hasRole('navigation', 'Settings sections')).toBe(true)
    }

    // Back to General from another section: the nav link returns to the "Settings" index page.
    browser.clickRole('link', 'General', { exact: true })
    await browser.waitForRole('heading', 'Settings')
    expect(browser.hasRole('link', 'Agents', { exact: true })).toBe(true)
  })

  it('"Global settings" leaves the project scope for the workspace-wide sections', async () => {
    // "General" is the global index too — its own heading stays "Global settings".
    const sections: Array<[slug: string, heading: string]> = [
      ['appearance', 'Appearance'],
      ['notifications', 'Notifications'],
      ['resources', 'Resources'],
      ['skills', 'Skills'],
      ['accounts', 'Agent accounts'],
      ['projects', 'Projects'],
    ]

    browser.goto(`${baseUrl}/p/${bootProject}/settings`)
    await browser.waitForRole('heading', 'Settings')
    browser.clickRole('link', 'Global settings')
    await browser.waitForRole('heading', 'Global settings')
    expect(browser.url()).toBe(`${baseUrl}/settings/global`)

    // The sidebar's own "Skills" (the skills catalog) and the "Global settings → Skills" link
    // share one accessible name, so each section is reached by its own URL — still no selector,
    // exact contract §11 gives for these routes — rather than risking the ambiguous click.
    for (const [slug, heading] of sections) {
      browser.goto(`${baseUrl}/settings/global/${slug}`)
      await browser.waitForRole('heading', heading)
      expect(browser.textOfRole('heading', heading, { exact: true })).toBe(heading)
      expect(browser.hasRole('link', 'General', { exact: true })).toBe(true)
    }

    browser.clickRole('link', 'General', { exact: true })
    await browser.waitForRole('heading', 'Global settings')
  })

  it('a project settings section that does not exist is the ordinary 404, not a blank page', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/settings/does-not-exist`)
    await browser.waitForRole('heading', 'Page not found')
    expect(browser.hasRole('link', 'Back to tasks')).toBe(true)
  })
})
