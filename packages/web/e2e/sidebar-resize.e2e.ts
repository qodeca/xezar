import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

/**
 * The column the user can widen (#788, option C), in a real browser against the shared test env.
 *
 * These cases lived in `quick-list.e2e.ts` while the sidebar listed tasks, where the question was
 * how much of a row's title a width bought. The sidebar is navigation only since #546, so what
 * is left to prove is the resize itself: the drag, the clamp, the keyboard, the stored preference
 * and the phone drawer that has no handle at all. None of it needs fixture runs, so this spec
 * attaches to the shared env rather than booting its own server.
 *
 * jsdom cannot answer any of this — the whole question is what the REAL CSS does with the width —
 * so every assertion reads a measured rectangle. Elements are found by role and label: the
 * sidebar is the page's `<aside>` (complementary landmark) and the handle is the separator
 * labelled "Resize the sidebar".
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.local/qa/artifacts_e2e')
const sessionId = `e2e-sidebar-resize-${process.pid}`

const SIDEBAR = 'aside'
const HANDLE = '[role="separator"][aria-label="Resize the sidebar"]'

let browser: AgentBrowser
let baseUrl: string
let home: string

/** The `<aside>`'s resolved width in px — the number the drag is actually moving. */
const sidebarWidth = () =>
  Number(browser.evaluate(`document.querySelector('${SIDEBAR}').getBoundingClientRect().width`))

/** Grab the handle at its middle and pull it `dx` px horizontally. */
const dragHandle = (dx: number) => {
  const box = browser.evaluate(`(() => {
    const r = document.querySelector('${HANDLE}').getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`) as { x: number; y: number }
  browser.dragTo(box, { x: box.x + dx, y: box.y })
}

const loadHome = () => {
  browser.goto(home)
  browser.waitForFunction(`document.querySelector('${SIDEBAR} nav[aria-label="Main"]') !== null`)
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  home = `${baseUrl}/p/${await bootProjectId(baseUrl)}/`
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
})

afterAll(() => {
  browser?.close()
})

describe('the sidebar column the user can widen', () => {
  beforeEach(() => {
    browser.setViewport(1440, 900)
    browser.goto(home)
    // A width the last test dragged must not leak into the next one — the preference is real.
    browser.evaluate(`localStorage.removeItem('xez-sidebar-width')`)
    loadHome()
  })

  it('starts at 264px with the footer controls inside the column', () => {
    expect(sidebarWidth()).toBe(264)
    // Navigation only (#546): nothing in the column is wider than the column, so nothing scrolls
    // sideways and the footer's last control (the theme toggle) is still inside it.
    const fit = browser.evaluate(`(() => {
      const aside = document.querySelector('${SIDEBAR}').getBoundingClientRect()
      const theme = [...document.querySelectorAll('${SIDEBAR} button')]
        .find((b) => /^Theme:/.test(b.getAttribute('aria-label') ?? ''))
        .getBoundingClientRect()
      return { themeInside: theme.right <= aside.right && theme.left >= aside.left }
    })()`) as { themeInside: boolean }
    expect(fit.themeInside).toBe(true)
    browser.screenshot(`${artifactsDir}/sidebar-width-264.png`, { viewport: true })
  })

  it('drags wider and remembers the width across a reload', () => {
    dragHandle(100)
    expect(sidebarWidth()).toBe(364)
    expect(browser.evaluate(`document.querySelector('${HANDLE}').getAttribute('aria-valuenow')`)).toBe('364')

    dragHandle(56)
    expect(sidebarWidth()).toBe(420)
    browser.screenshot(`${artifactsDir}/sidebar-width-420.png`, { viewport: true })

    expect(browser.evaluate(`localStorage.getItem('xez-sidebar-width')`)).toBe('420')
    loadHome()
    expect(sidebarWidth()).toBe(420)
  })

  it('clamps at both ends — the column can never collapse or swallow the view', () => {
    dragHandle(4000)
    expect(sidebarWidth()).toBe(420)
    dragHandle(-4000)
    expect(sidebarWidth()).toBe(264)
  })

  it('resizes from the keyboard and resets on double-click', () => {
    browser.evaluate(`document.querySelector('${HANDLE}').focus()`)
    browser.press('End')
    expect(sidebarWidth()).toBe(420)
    browser.press('ArrowLeft')
    expect(sidebarWidth()).toBe(404)
    browser.press('Home')
    expect(sidebarWidth()).toBe(264)

    browser.press('ArrowRight')
    expect(sidebarWidth()).toBe(280)
    browser.evaluate(`(() => {
      const el = document.querySelector('${HANDLE}')
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })()`)
    browser.waitForFunction(`document.querySelector('${SIDEBAR}').getBoundingClientRect().width === 264`)
  })

  it('is a desktop affordance only: below md there is no handle to reach', () => {
    browser.setViewport(390, 844)
    browser.goto(home)
    browser.waitForFunction(`document.querySelector('button[aria-label="Open menu"]') !== null`)

    // The aside is still in the DOM (display:none), so the handle inside it is unreachable
    // rather than absent — and the drawer that replaces it brings no handle of its own.
    expect(browser.isVisible(HANDLE)).toBe(false)
    browser.click('button[aria-label="Open menu"]')
    browser.waitForFunction(`document.querySelector('[role="dialog"] nav[aria-label="Main"]') !== null`)
    expect(browser.evaluate(`document.querySelectorAll('[role="dialog"] ${HANDLE}').length`)).toBe(0)
    expect(
      browser.evaluate(`Math.round(document.querySelector('[role="dialog"]').getBoundingClientRect().width)`),
    ).toBe(264)
  })
})
