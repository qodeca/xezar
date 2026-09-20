import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

/**
 * The ⌘K command palette (Step 4.3) against the shared dev env, driven the way a user drives
 * it: the keyboard. Ctrl+K (the same binding as ⌘K — the shared shortcut helper registers
 * both), type to filter, Enter to go.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.local/qa/artifacts_e2e')
const runId = `e2e-palette-${process.pid}`

const ROOT = '[cmdk-root]'
const INPUT = '[cmdk-input]'

/** Open means a dialog whose accessible name is "Command palette" is in the document. */
const paletteOpen = `[...document.querySelectorAll('[role="dialog"]')].some((dialog) => document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent === 'Command palette')`

/**
 * The palette is closed, asserted through the same facts the waits read.
 *
 * Both halves are waited for before either is read: the dialog's own absence (the closed state
 * this file names) AND the root's absence. A bare `count('[cmdk-root]')` with no wait of its own
 * is how a mid-unmount read becomes a failure — `expected 1 to be +0` (run 35203051673) — and
 * the root lives inside the dialog, so waiting for the dialog first is what makes the read safe.
 */
function expectPaletteClosed(): void {
  browser.waitForFunction(`!(${paletteOpen}) && document.querySelector('${ROOT}') === null`)
  expect(browser.evaluate(paletteOpen)).toBe(false)
  expect(browser.count(ROOT)).toBe(0)
}

let browser: AgentBrowser
let baseUrl: string
let bootProject: string

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(runId)
  browser.setViewport(1440, 900)
})

afterAll(() => {
  browser?.close()
})

describe('command palette', () => {
  it('opens on Ctrl+K, filters to a nav item, and Enter navigates and closes it', () => {
    browser.goto(baseUrl + '/')
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"]') !== null`)
    expect(browser.count(ROOT)).toBe(0)

    browser.press('Control+k')
    browser.waitForFunction(`document.querySelector('${ROOT}') !== null`)
    // The palette input owns focus — Enter and further typing land in it.
    browser.waitForFunction(`document.activeElement?.hasAttribute('cmdk-input') === true`)
    browser.screenshot(`${artifactsDir}/command-palette-open.png`)

    // "view work" rides the Views values' `view ` prefix, so the Workflows destination wins the
    // ranking regardless of which runs and skills this shared machine happens to have.
    browser.fill(INPUT, 'view work')
    browser.waitForFunction(
      `document.querySelector('[cmdk-item][aria-selected="true"]')?.getAttribute('data-nav-to') === '/workflows'`,
    )
    browser.screenshot(`${artifactsDir}/command-palette-filtered.png`)

    browser.press('Enter')
    browser.waitForFunction(`location.pathname === '/p/${bootProject}/workflows'`)
    expect(browser.url()).toContain('/workflows')
    expectPaletteClosed()
  })

  // #546: the sidebar's clickable `Search…` launcher is gone, so the keyboard is the only way in —
  // and closing must hand focus back to a control that still exists, never to the removed hint.
  //
  // Two things this case must not depend on (#559 review): a bare `/` restores the page the
  // previous case left (Workflows, whose `<aside>` lists "Add xezar-research to the flow"), so the
  // page is named explicitly; and the launcher check reads the SIDEBAR's controls by accessible
  // name, not every `<aside>` button whose text merely contains "search".
  it('has no sidebar launcher, closes on Escape and returns focus to where it was', () => {
    const sidebar = `document.querySelector('nav[aria-label="Main"]')?.closest('aside')`
    const gitLink = `${sidebar}?.querySelector('nav[aria-label="Main"] a[href$="/git"]')`

    browser.goto(`${baseUrl}/p/${bootProject}/`)
    browser.waitForFunction(`${gitLink} != null`)
    expect(
      browser.evaluate(
        `[...${sidebar}.querySelectorAll('button, a, [role="button"]')].map((c) => (c.getAttribute('aria-label') ?? c.textContent ?? '').trim()).filter((name) => /^search\\b/i.test(name))`,
      ),
    ).toEqual([])

    browser.evaluate(`${gitLink}.focus()`)
    browser.press('Control+k')
    browser.waitForFunction(paletteOpen)
    browser.waitForFunction(`document.activeElement?.getAttribute('role') === 'combobox'`)

    browser.press('Escape')
    expectPaletteClosed()
    browser.waitForFunction(`document.activeElement === ${gitLink}`)
  })

  it('does not open while typing in a page input', () => {
    // No shell surface has a free-standing input yet (the composer is R4), so the suppression
    // rule is exercised against an injected one — the guard is target-based, not page-based.
    browser.evaluate(
      `(() => { const field = document.createElement('input'); field.id = 'e2e-probe-input'; document.body.appendChild(field); field.focus(); return true })()`,
    )
    browser.press('Control+k')
    // Absence needs a positive signal first. The guard is target-based, so the honest proof is
    // that focus STAYED on the probe input — a palette that opened would have taken it — read
    // together with the closed-state expression every other case in this file reads. A bare
    // `count(ROOT)` with no wait cannot tell "the guard held" from "the commit has not landed"
    // and can pass for the wrong reason.
    browser.waitForFunction(
      `document.activeElement?.id === 'e2e-probe-input' && !(${paletteOpen})`,
    )
    expect(browser.evaluate(paletteOpen)).toBe(false)
    expect(browser.count(ROOT)).toBe(0)
    browser.evaluate(`document.getElementById('e2e-probe-input')?.remove()`)
  })
})
