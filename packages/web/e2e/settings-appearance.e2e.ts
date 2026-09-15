import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'

/**
 * Global settings shell + Appearance (R6 Step 1.3; moved to the global area in the
 * multi-project step 3.5) end-to-end against the shared dry-run environment.
 *
 * Reachability: everything here is honestly reachable — the settings routes need no forge, no
 * agent CLI and no seeded runs. The suite mutates exactly two stores and restores/neutralizes
 * both: the WORKSPACE `ui-state.json` (saved in beforeAll, restored in afterAll — the inbox
 * suite's save/restore discipline) and the browser session's localStorage theme mirror
 * (flipped back to dark in the same spec, and the session is unique per run anyway).
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.local/qa/artifacts_e2e')
const sessionId = `e2e-settings-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }

// Appearance persists in the WORKSPACE ui-state since step 3.5. `scripts/test-env-up.sh`
// pins `XEZ_HOME` under `.local/qa/xez-home`, so that — not the developer's `~/.xezar`, and not
// the repo's `.local/xezar` — is the file this suite reads and restores.
const xezHomeDir = resolve(import.meta.dirname, '../../../.local/qa/xez-home')
const uiStateFile = resolve(xezHomeDir, 'ui-state.json')

let browser: AgentBrowser
let baseUrl: string
let previousUiState: string | null = null

beforeAll(() => {
  baseUrl = readTestEnv().baseUrl
  previousUiState = existsSync(uiStateFile) ? readFileSync(uiStateFile, 'utf8') : null
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  // Never leave a developer's cockpit wearing this test's appearance.
  if (previousUiState === null) rmSync(uiStateFile, { force: true })
  else writeFileSync(uiStateFile, previousUiState, 'utf8')
  browser?.close()
})

/** The PUT behind an appearance click is fire-and-forget from the UI's point of view — poll
 *  the API until the write lands rather than assume it beat this assertion. */
async function waitForServerAppearance(check: (appearance: Record<string, unknown>) => boolean) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await fetch(`${baseUrl}/api/v1/workspace/ui-state`)
    const state = (await res.json()) as { appearance?: Record<string, unknown> }
    if (state.appearance && check(state.appearance)) return state.appearance
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('ui-state.json never showed the expected appearance')
}

describe('settings → appearance against the live dry-run server', () => {
  it('the shell renders the registry sections — hidden ones absent, active one marked', () => {
    browser.goto(`${baseUrl}/settings/global/appearance`)
    browser.waitForFunction(`document.querySelector('[data-route="settings-global-appearance"]') !== null`)

    // The GLOBAL nav: the original four sections, the xezar-skills preference and the
    // Agent accounts section (registered unconditionally in settings/registry.tsx), and
    // nothing project-scoped.
    const nav = '[data-slot="settings-nav"][data-scope="global"]'
    expect(browser.count(`${nav} [data-section]`)).toBe(6)
    expect(browser.count(`${nav} [data-section="accounts"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="appearance"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="notifications"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="resources"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="skills"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="projects"]`)).toBe(1)
    // Project sections live in the OTHER area; hidden registry entries are nowhere at all.
    expect(browser.count(`${nav} [data-section="agents"]`)).toBe(0)
    expect(browser.count(`${nav} [data-section="bookmarklets"]`)).toBe(0)
    expect(browser.count(`${nav} [data-section="mcp"]`)).toBe(0)
    expect(browser.count(`${nav} [aria-current="page"][data-section="appearance"]`)).toBe(1)
  })

  it('flipping the theme flips the root class and persists across a reload', () => {
    browser.click('[data-slot="appearance-theme"] [data-value="light"]')
    browser.waitForFunction(`document.documentElement.classList.contains('light')`)

    // A fresh navigation: the pre-paint script must re-apply the choice before the bundle.
    browser.goto(`${baseUrl}/settings/global/appearance`)
    browser.waitForFunction(`document.documentElement.classList.contains('light')`)
    expect(browser.count('[data-slot="appearance-theme"] [data-value="light"][aria-checked="true"]')).toBe(1)

    // Back to dark so every other suite screenshots the default palette.
    browser.click('[data-slot="appearance-theme"] [data-value="dark"]')
    browser.waitForFunction(`!document.documentElement.classList.contains('light')`)
  })

  it('accent lands in ui-state.json and re-applies at boot', async () => {
    browser.click('[data-slot="appearance-accent"] [data-value="violet"]')
    browser.waitForFunction(`document.documentElement.dataset.accent === 'violet'`)

    // The server actually persisted it — not just the query cache.
    const appearance = await waitForServerAppearance((a) => a.accent === 'violet')
    expect(appearance.accent).toBe('violet')

    // Cold load: pre-paint mirror + server truth both say violet.
    browser.goto(`${baseUrl}/settings/global/appearance`)
    browser.waitForFunction(`document.documentElement.dataset.accent === 'violet'`)
    expect(browser.count('[data-slot="appearance-accent"] [data-value="violet"][aria-checked="true"]')).toBe(1)
  })

  it('compact density measurably tightens the spacing scale', async () => {
    // h-14 header: 14 spacing units. Comfortable = 4px/unit → 56px.
    const header = `document.querySelector('[data-route="settings-global-appearance"] header')`
    expect(Number(browser.evaluate(`${header}.offsetHeight`))).toBe(56)

    browser.click('[data-slot="appearance-density"] [data-value="compact"]')
    browser.waitForFunction(`document.documentElement.dataset.density === 'compact'`)
    // The same 14 units at 3.5px/unit — the token really drives the built CSS.
    expect(Number(browser.evaluate(`${header}.offsetHeight`))).toBe(49)
    await waitForServerAppearance((a) => a.density === 'compact')

    browser.screenshot(`${artifactsDir}/settings-appearance.png`)

    // Neutralize for the rest of the suite run (afterAll restores the file itself too).
    browser.click('[data-slot="appearance-density"] [data-value="comfortable"]')
    browser.click('[data-slot="appearance-accent"] [data-value="lime"]')
    browser.waitForFunction(
      `document.documentElement.dataset.density === undefined && document.documentElement.dataset.accent === undefined`,
    )
  })

  // #424 step 4 — the loose end of the same one-token lever.
  it('roomy density loosens the scale by 25%, saves, and survives a cold load', async () => {
    const header = `document.querySelector('[data-route="settings-global-appearance"] header')`
    expect(Number(browser.evaluate(`${header}.offsetHeight`))).toBe(56)

    const density = '[data-slot="appearance-density"]'
    expect(browser.evaluate(`[...document.querySelectorAll('${density} [role="radio"]')].map((r) => r.dataset.value).join(',')`)).toBe(
      'roomy,comfortable,compact,ultra',
    )

    // Keyboard: every option is its own tab stop. From Comfortable, Shift+Tab reaches Roomy and
    // Enter selects it; Tab goes back and Space selects Comfortable again.
    browser.evaluate(`document.querySelector('${density} [data-value="comfortable"]').focus()`)
    browser.press('Shift+Tab')
    expect(browser.evaluate(`document.activeElement?.dataset.value`)).toBe('roomy')
    browser.press('Enter')
    browser.waitForFunction(`document.documentElement.dataset.density === 'roomy'`)
    // The same 14 units at 5px/unit.
    expect(Number(browser.evaluate(`${header}.offsetHeight`))).toBe(70)
    await waitForServerAppearance((a) => a.density === 'roomy')
    browser.press('Tab')
    browser.press(' ')
    browser.waitForFunction(`document.documentElement.dataset.density === undefined`)
    await waitForServerAppearance((a) => a.density === 'comfortable')

    browser.click(`${density} [data-value="roomy"]`)
    browser.waitForFunction(`document.documentElement.dataset.density === 'roomy'`)
    await waitForServerAppearance((a) => a.density === 'roomy')
    expect(browser.evaluate(`localStorage.getItem('xez-density')`)).toBe('roomy')

    // Pre-paint: run the SERVED page's inline head script on its own — no bundle, no React —
    // against a stand-in root and the real mirror. It must stamp roomy by itself, or a cold load
    // paints comfortable first and jumps when the provider mounts.
    const stamped = browser.evaluate(`(() => {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', '/settings/global/appearance', false)
      xhr.send()
      const html = new DOMParser().parseFromString(xhr.responseText, 'text/html')
      const script = [...html.head.querySelectorAll('script:not([src])')].find((s) => s.textContent.includes('xez-density'))
      const root = { classList: { toggle() {} }, style: {}, dataset: {} }
      new Function('document', 'localStorage', 'matchMedia', script.textContent)(
        { documentElement: root },
        localStorage,
        () => ({ matches: false }),
      )
      return root.dataset.density ?? 'absent'
    })()`)
    expect(stamped).toBe('roomy')

    browser.goto(`${baseUrl}/settings/global/appearance`)
    browser.waitForFunction(`document.documentElement.dataset.density === 'roomy'`)
    expect(browser.count(`${density} [data-value="roomy"][aria-checked="true"]`)).toBe(1)
  })

  it('at 375px every density option stays reachable at every density, with no sideways scroll', async () => {
    const density = '[data-slot="appearance-density"]'
    const values = ['roomy', 'comfortable', 'compact', 'ultra']
    browser.setViewport(375, 812)
    try {
      browser.goto(`${baseUrl}/settings/global/appearance`)
      browser.waitForFunction(`document.querySelector('${density}') !== null`)
      const segmentHeights: Record<string, number> = {}
      for (const active of values) {
        browser.click(`${density} [data-value="${active}"]`)
        browser.waitForFunction(
          active === 'comfortable'
            ? `document.documentElement.dataset.density === undefined`
            : `document.documentElement.dataset.density === '${active}'`,
        )
        await waitForServerAppearance((a) => a.density === active)
        const report = browser.evaluate(`(() => {
          document.querySelector('${density}').scrollIntoView({ block: 'center' })
          const vw = document.documentElement.clientWidth
          const problems = []
          for (const button of document.querySelectorAll('${density} [role="radio"]')) {
            const r = button.getBoundingClientRect()
            if (r.left < 0 || r.right > vw) problems.push(button.dataset.value + ' outside the viewport')
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            if (!hit || !button.contains(hit)) problems.push(button.dataset.value + ' covered or clipped')
          }
          const section = document.querySelector('[data-slot="appearance-section"]')
          if (document.scrollingElement.scrollWidth > vw) problems.push('page scrolls sideways')
          if (section.scrollWidth > section.clientWidth) problems.push('appearance section overflows')
          const height = document.querySelector('${density} [role="radio"]').getBoundingClientRect().height
          return JSON.stringify({ problems, height })
        })()`) as string
        const { problems, height } = JSON.parse(report) as { problems: string[]; height: number }
        expect(problems, `at density ${active}`).toEqual([])
        segmentHeights[active] = height
      }
      // Recorded for the design review (touch targets), not asserted: segment height is older
      // than Roomy and changing it is outside #424 step 4.
      console.info(`[settings-appearance] density segment height at 375px: ${JSON.stringify(segmentHeights)}`)
      browser.screenshot(`${artifactsDir}/settings-appearance-density-375.png`)
    } finally {
      browser.setViewport(DESKTOP.width, DESKTOP.height)
      browser.click(`${density} [data-value="comfortable"]`)
      browser.waitForFunction(`document.documentElement.dataset.density === undefined`)
      await waitForServerAppearance((a) => a.density === 'comfortable')
    }
  })
})
