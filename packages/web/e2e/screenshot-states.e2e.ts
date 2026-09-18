import { afterAll, beforeAll, describe, it } from 'vitest'

import { AgentBrowser, removeDataRoot, stopFixtureServer } from './agent-browser'
import { api, bootCockpit, type Cockpit } from './capture/cockpit'
import { SHOT_STATES, type Width } from './capture/manifest'
import { resetAppearance, SCENARIOS, seedScenario, withAllTasksProjects, type ScenarioContext } from './capture/scenario-state'
import { GuideBrowser } from './guide-browser'

/**
 * PR 4 of the browser-test package (Refs #549) — the screenshot-state contract, after Batch 8
 * (#602, image preview / known-gaps reconciliation / projects-section manifest).
 *
 * browser-test-spec.md § "Screenshot-state reconciliation" recommended asserting each state's
 * visible facts "inside its authoritative capture preparation, immediately before capture" and
 * consuming that from "a thin new test" — never duplicating the setup. That preparation and its
 * assertions now live in `capture/scenario-state.ts` (`SCENARIOS`), shared with
 * `capture/docs-screenshots.capture.ts`. This file is that thin consumer: it boots its own
 * spec-owned fixture (never the shared `.local/qa/test-env.json` server the rest of this package's
 * files reuse — capture-derived fixtures always own their data), seeds the same workspace, then
 * calls each state's `Scenario` for its assertions only. It never shoots a screenshot, never reads
 * or writes `SCREENSHOT_DIR`, and never touches `allShotFiles()`/`docs-screenshots.test.ts`'s
 * on-disk budget: a state's visible facts are asserted the same way whether it has shipped a
 * picture already or is still `plannedFor` a future release.
 *
 * Locator rule (browser-test-spec.md § Locator rule): every `expect(...)` inside `SCENARIOS` uses
 * only an ARIA role with an accessible name, an associated accessible label, or literal visible
 * text. The pre-existing `data-slot` waits/clicks those scenarios also run are the same DOM-ready
 * steps the 0.15.0 capture plan has always used to know a page settled — relocated, not redesigned
 * — and are not new locators this package adds.
 *
 * A state's variants (`manifest.ts`) can differ by theme, by width, or both; only WIDTH ever
 * changes the DOM shape a scenario walks (`new-task`'s picker, `tasks-list`'s card-vs-table
 * layout, …) — theme is a rendering product of the same state (browser-test-spec.md § Material
 * assumptions), so each state's scenario runs once per DISTINCT width its manifest entry lists,
 * not once per theme × width pixel variant; this is what keeps the whole file's runtime a small
 * fraction of the capture harness's own (which shoots every variant).
 */

const HEIGHT: Record<Width, number> = { 1280: 800, 375: 812 }

let cockpit: Cockpit
let browser: AgentBrowser
let guide: GuideBrowser
let runs: Record<string, string> = {}
let groupId = ''

beforeAll(async () => {
  cockpit = await bootCockpit()
  browser = AgentBrowser.open(`e2e-screenshot-states-${process.pid}`)
  guide = GuideBrowser.open(`e2e-screenshot-states-${process.pid}`)
  const seeded = await seedScenario(cockpit, browser)
  runs = seeded.runs
  groupId = seeded.groupId
  browser.setViewport(1280, HEIGHT[1280])
}, 300_000)

afterAll(async () => {
  browser?.close()
  if (cockpit) {
    // Cancel what still runs, so no scripted-agent check step outlives the server (the same rule
    // `docs-screenshots.capture.ts`'s own teardown follows).
    for (const id of Object.values(runs)) {
      await api(cockpit, 'POST', `/p/demo-shop/runs/${id}/cancel`).catch(() => undefined)
    }
    await stopFixtureServer(cockpit.server)
    await removeDataRoot(cockpit.dataRoot)
  }
})

describe('screenshot-state contract', () => {
  for (const state of SHOT_STATES) {
    it(state.name, async () => {
      const scenario = SCENARIOS[state.name]
      if (!scenario) throw new Error(`xezar screenshot-states: no scenario for "${state.name}"`)

      const widths = [...new Set(state.variants.map(([, width]) => width))]
      for (const width of widths) {
        const theme = state.variants.find(([, w]) => w === width)![0]
        const ctx: ScenarioContext = { cockpit, browser, guide, runs, groupId }
        browser.setViewport(width, HEIGHT[width])
        try {
          if (state.name === 'all-tasks') await withAllTasksProjects(cockpit, () => scenario(ctx, theme, width))
          else await scenario(ctx, theme, width)
        } finally {
          if (state.name === 'settings-appearance-roomy') await resetAppearance(cockpit)
          browser.press('Escape')
        }
      }
    })
  }
})
