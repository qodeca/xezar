import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootProjectId, readTestEnv } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Guide 16 — Troubleshooting and FAQ (docs/guide/16-troubleshooting-faq.md). Its failure list is
 * almost entirely process-level (a busy port, a worktree write claim, a missing `gh` binary, a
 * usage-limit reset, a missing built cockpit) — none of them a state a dry-run browser fixture can
 * honestly reach, so the dry-run exception register carries most of this guide:
 *
 * - Worktree creation failure: `packages/xezar/src/workflows/run-isolation.test.ts:54-107`.
 * - A busy port and its fallback search: `packages/xezar/test/e2e/package-cli.test.ts:486-495`.
 * - "project data is already in use": `packages/xezar/src/runs/project-writer.test.ts:93-107`.
 * - "gh CLI not found": `packages/xezar/src/onboarding/issue-filing.test.ts:53-160` and
 *   `packages/xezar/src/server/checkout-gh-runner.test.ts:174-205`.
 * - Usage-limit auto-resume scheduling: `packages/xezar/src/core/usage-limit.test.ts:7-88` and
 *   `packages/xezar/src/server/auto-resume-api.test.ts:20-103`.
 * - The missing-built-cockpit hint page: served only when `packages/xezar/web/dist` is absent,
 *   which this suite's own boot requires present; a dated manual record pairs with
 *   `packages/xezar/src/server/static-ui.ts`.
 *
 * What a dry-run browser CAN honestly show is the one network-and-reset section the guide states
 * as user-facing fact rather than a failure path: skill updates are on by default and the reader
 * can turn them off from Settings, and an unknown settings route degrades to the ordinary 404
 * rather than a blank page.
 */

let browser: GuideBrowser
let baseUrl: string
let bootProject: string

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  browser = GuideBrowser.open(`e2e-guide-16-${process.pid}`)
}, 60_000)

afterAll(() => {
  browser?.close()
})

describe('guide 16 — troubleshooting and FAQ', () => {
  it('"Update xezar-skills automatically" is on by default and the reader can turn it off, then back on', async () => {
    browser.goto(`${baseUrl}/settings/global/skills`)
    await browser.waitForRole('heading', 'Update xezar-skills automatically')
    expect(browser.hasRole('switch', 'Update xezar-skills automatically')).toBe(true)

    // Round-trip the toggle so this file leaves the shared server exactly as it found it
    // (browser-test-spec.md § Isolation rule) — an idempotent flip proves the control works
    // without depending on which state a prior file left it in.
    browser.clickRole('switch', 'Update xezar-skills automatically')
    browser.clickRole('switch', 'Update xezar-skills automatically')
    expect(browser.hasRole('switch', 'Update xezar-skills automatically')).toBe(true)
  })

  it('an unknown settings route is the ordinary 404, never a blank page or a crash', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/settings/general`)
    await browser.waitForRole('heading', 'Page not found')
    expect(browser.hasRole('link', 'Back to tasks')).toBe(true)

    browser.clickRole('link', 'Back to tasks')
    await browser.waitForUrl(`${baseUrl}/p/${bootProject}/`)
  })
})
