import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, removeDataRoot, stopFixtureServer } from '../agent-browser'
import { GuideBrowser } from '../guide-browser'
import { api, bootCockpit, DEMO_PROJECT, waitForStatus, type Cockpit } from './cockpit'
import { decodePng, encodeGif, encodePngPalette, type GifFrame, type RgbaImage } from './image-codec'
import {
  SCREENSHOT_DIR,
  SHOT_MAX_BYTES,
  SHOT_STATES,
  TOUR_FILE,
  TOUR_MAX_BYTES,
  TOUR_MAX_MS,
  shotFileName,
  type Width,
} from './manifest'
import { freezeJs, normalizeJs } from './page-scripts'
import {
  demo,
  exists,
  openPage,
  resetAppearance,
  scrollAboveComposer,
  SCENARIOS,
  seedScenario,
  settle,
  wait,
  withAllTasksProjects,
  type ScenarioContext,
} from './scenario-state'

/**
 * The seeded workspace, the per-state DOM preparation and the semantic visible-fact assertions all
 * live in `scenario-state.ts` now — the browser-test package's `screenshot-states.e2e.ts` shares
 * them rather than re-implementing this fixture (browser-test-spec.md § "Screenshot-state
 * reconciliation"). This file keeps only what is specific to producing PIXELS: `shoot()`, the
 * freeze/normalize page scripts, the tour recording and the generated README.
 */

/**
 * Reproducible 0.16.0 cockpit captures (#448 PR-1b, re-shot each release): every still in
 * `manifest.ts`, then the tour GIF, from one dry-run fixture cockpit.
 *
 *   npm run build
 *   npm run capture:screenshots -w @qodeca/xezar-web
 *   npm run capture:screenshots -w @qodeca/xezar-web -- -t tasks-list   # one state
 *
 * Output goes straight to `docs/screenshots/0.16.0/`. Nothing here asserts product behaviour;
 * the `expect`s only refuse to write a picture of the wrong state.
 */

const repoRoot = resolve(import.meta.dirname, '../../../..')
const outDir = resolve(repoRoot, SCREENSHOT_DIR)
const sessionId = `capture-docs-${process.pid}`

// The chip shows what the running (pre-release) build's own package.json says; the docs describe
// the version the screenshot folder is named for. Pin the chip to the latter, derived here so it
// never drifts from a second hand-typed literal.
const buildVersion = (JSON.parse(readFileSync(resolve(repoRoot, 'packages/xezar/package.json'), 'utf8')) as { version: string }).version
const docsVersion = SCREENSHOT_DIR.split('/').at(-1)!
const versionRewrite = { build: buildVersion, docs: docsVersion }

// Plan § 3.2: desktop stills at 1280 × 800, the same height as the tour.
const HEIGHT: Record<Width, number> = { 1280: 800, 375: 812 }

/**
 * How each seeded task reads wherever a value would otherwise differ on every run: its own branch
 * suffix and its own age. One fixed value PER TASK, so a list of tasks never reads as clones.
 */
const LOOKS: Record<string, { id8: string; age: string }> = {
  docs: { id8: '0d2f7a61', age: '3h' },
  docsFailed: { id8: '19c4e8b2', age: '3h' },
  failed: { id8: 'c41e2a90', age: '2h' },
  doneA: { id8: '7b09d13f', age: '1h' },
  doneB: { id8: 'e5a3c7d8', age: '52m' },
  variantA: { id8: '3f8b1c42', age: '41m' },
  variantB: { id8: 'a90d6e15', age: '41m' },
  review: { id8: '5c27f9b0', age: '28m' },
  ask: { id8: '8e61b4a3', age: '17m' },
  running: { id8: 'd4f0a2c9', age: '9m' },
  runningB: { id8: '62be8f17', age: '6m' },
  queuedA: { id8: 'b7c3d5e2', age: '2m' },
  queuedB: { id8: '4a1e9f86', age: '1m' },
  tour: { id8: '2d9c6b7e', age: '12s' },
}

const looks = () =>
  Object.fromEntries(Object.entries(runs).flatMap(([role, id]) => (LOOKS[role] ? [[id, LOOKS[role]]] : [])))

let cockpit: Cockpit
let browser: AgentBrowser
let guide: GuideBrowser
let frameDir: string

/** Ids of the seeded runs, by role. */
const runs: Record<string, string> = {}
let groupId = ''

const runPath = (id: string) => `/p/${DEMO_PROJECT}/runs/${id}`

/** Freeze, normalise, shoot the viewport, and keep it inside its budget. */
async function shoot(file: string): Promise<void> {
  browser.evaluate(freezeJs)
  await settle()
  browser.evaluate(normalizeJs(cockpit.dataRoot, cockpit.home, looks(), versionRewrite))
  const raw = browser.screenshot(join(frameDir, file), { viewport: true })
  const png = readFileSync(raw)
  const bytes: Uint8Array = png.length > SHOT_MAX_BYTES ? encodePngPalette(decodePng(png)) : png
  expect(bytes.length, `${file} is over its ${SHOT_MAX_BYTES} byte budget even as a palette PNG`).toBeLessThanOrEqual(SHOT_MAX_BYTES)
  writeFileSync(join(outDir, file), bytes)
}

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true })
  cockpit = await bootCockpit()
  frameDir = join(cockpit.dataRoot, 'frames')
  mkdirSync(frameDir, { recursive: true })
  browser = AgentBrowser.open(sessionId)
  guide = GuideBrowser.open(sessionId)
  const seeded = await seedScenario(cockpit, browser)
  Object.assign(runs, seeded.runs)
  groupId = seeded.groupId
  browser.setViewport(1280, HEIGHT[1280])
  browser.goto(`${cockpit.baseUrl}${demo('/')}`)
}, 300_000)

afterAll(async () => {
  browser?.close()
  if (cockpit) {
    // Cancel what still runs, so no `sleep` check step outlives the server.
    for (const id of Object.values(runs)) {
      await api(cockpit, 'POST', `${runPath(id)}/cancel`).catch(() => undefined)
    }
    await stopFixtureServer(cockpit.server)
    await removeDataRoot(cockpit.dataRoot)
  }
})

describe(`${SCREENSHOT_DIR} stills`, () => {
  for (const state of SHOT_STATES) {
    it(state.name, async () => {
      const scenario = SCENARIOS[state.name]
      if (!scenario) throw new Error(`xezar capture: no scenario for "${state.name}"`)
      for (const [theme, width] of state.variants) {
        const ctx: ScenarioContext = { cockpit, browser, guide, runs, groupId }
        browser.setViewport(width, HEIGHT[width])
        const run = async () => {
          await scenario(ctx, theme, width)
          await shoot(shotFileName(state.name, theme, width))
        }
        try {
          if (state.name === 'all-tasks') await withAllTasksProjects(cockpit, run)
          else await run()
        } finally {
          if (state.name === 'settings-appearance-roomy') await resetAppearance(cockpit)
          browser.press('Escape')
        }
      }
    })
  }
})

// ---- tour -----------------------------------------------------------------------------------

describe(`${SCREENSHOT_DIR}/${TOUR_FILE}`, () => {
  it('records new task → running thread → review → draft PR', async () => {
    const width = 1280
    const height = 800
    const frames: GifFrame[] = []
    let index = 0
    const grab = () => {
      browser.evaluate(freezeJs)
      browser.evaluate(normalizeJs(cockpit.dataRoot, cockpit.home, looks(), versionRewrite))
      const path = browser.screenshot(join(frameDir, `tour-${String(index).padStart(3, '0')}.png`), { viewport: true })
      index += 1
      return decodePng(readFileSync(path))
    }
    const frame = async (delayMs: number) => {
      frames.push({ image: grab(), delayMs })
    }

    browser.setViewport(width, height)
    openPage(browser, cockpit.baseUrl, demo('/'), 'dark')
    wait(browser, exists('[data-slot="queue-note"]'))
    await frame(2500)

    // The tour starts from the stills' state and keeps it: nothing is cancelled or deleted. A
    // wider workspace cap lets the two queued tasks start too, so the tour task starts at once
    // and the closing list still shows work running beside the finished tour task.
    await api(cockpit, 'PUT', '/workspace/config', { resources: { maxParallel: 5 } })
    for (const id of [runs.queuedA, runs.queuedB]) await waitForStatus(cockpit, runPath(id!), ['running'])

    openPage(browser, cockpit.baseUrl, demo('/new'), 'dark')
    wait(browser, `document.querySelector('[data-slot="model-pill"]') !== null && !document.querySelector('[data-slot="model-pill"]').disabled`)
    const prompt = 'Add a "Remember me" option to the login form'
    for (const cut of [8, 18, 30, prompt.length]) {
      browser.fill('[data-slot="composer"] textarea', prompt.slice(0, cut))
      await frame(cut === prompt.length ? 1500 : 300)
    }
    browser.click('[aria-label="Start task"]')
    wait(browser, `location.pathname.startsWith('${demo('/tasks/')}')`)
    const tourId = String(browser.evaluate(`location.pathname.split('/').pop()`))
    runs.tour = tourId
    wait(browser, exists('[data-slot="run-header"]'))

    // The scripted turn streams for about a second: sample it, keep each distinct picture once,
    // and share a fixed 2.4 s between them so the GIF's timing does not depend on this machine.
    const streamed: RgbaImage[] = []
    for (let i = 0; i < 12; i += 1) {
      const sample = grab()
      const last = streamed.at(-1)
      if (!last || !Buffer.from(last.data).equals(Buffer.from(sample.data))) streamed.push(sample)
      if ((await api(cockpit, 'GET', runPath(tourId))).status === 'waiting') break
      await settle(200)
    }
    for (const image of streamed) frames.push({ image, delayMs: Math.round(2400 / streamed.length) })
    await waitForStatus(cockpit, runPath(tourId), ['waiting'])
    wait(browser, exists('[data-slot="composer"] textarea'))
    await settle(600)
    await frame(2000)

    await api(cockpit, 'POST', `${runPath(tourId)}/finish`)
    await waitForStatus(cockpit, runPath(tourId), ['review'])
    wait(browser, exists('[data-slot="review-draft-pr"]'))
    wait(browser, `document.querySelectorAll('[data-slot="review-panel"] [data-slot="diff-file"]').length > 0`)
    await settle(800)
    scrollAboveComposer(browser, '[data-slot="review-draft-pr"]')
    await settle(300)
    await frame(2000)

    browser.click('[data-slot="review-draft-pr"]')
    wait(browser, exists('a[data-slot="pr-link"]'))
    // Opening the PR accepts the change, which plays a short celebration over the thread.
    wait(browser, `document.querySelector('[data-slot="accept-celebration"]') === null`)
    await settle(400)
    await frame(2000)

    openPage(browser, cockpit.baseUrl, demo('/'), 'dark')
    wait(browser, `document.querySelector('[data-slot="task-table-row"] [data-slot="pr-chip"]') !== null`)
    await frame(2500)

    const totalMs = frames.reduce((sum, f) => sum + f.delayMs, 0)
    expect(totalMs, `${TOUR_FILE} runs ${totalMs} ms`).toBeLessThanOrEqual(TOUR_MAX_MS)

    const gif = encodeGif(frames)
    expect(gif.length, `${TOUR_FILE} is over its ${TOUR_MAX_BYTES} byte budget`).toBeLessThanOrEqual(TOUR_MAX_BYTES)
    writeFileSync(join(outDir, TOUR_FILE), gif)
    expect(statSync(join(outDir, TOUR_FILE)).size).toBe(gif.length)
  })
})

// ---- index ----------------------------------------------------------------------------------

describe(`${SCREENSHOT_DIR}/README.md`, () => {
  it('lists every file, the state it shows and the command that made it', () => {
    const rows = SHOT_STATES.flatMap((state) =>
      state.variants.map(([theme, width]) => `| [\`${shotFileName(state.name, theme, width)}\`](${shotFileName(state.name, theme, width)}) | ${state.shows} | ${theme} | ${width} × ${HEIGHT[width]} |`),
    )
    const readme = `# xezar 0.16.0 cockpit screenshots

Captured from a dry-run cockpit (\`XEZ_DRY_RUN=1\` with a sandboxed \`XEZ_HOME\`, no login, no network)
with fixture data: a demo project with tasks in every status on Claude Code, Codex and pi, a second
project for All tasks, three Inbox follow-ups, one automation and a second Claude login. The data,
the viewport and the theme are fixed, so a re-run produces the same pictures (at most a few
anti-aliased pixels apart).

Generated by \`packages/web/e2e/capture/docs-screenshots.capture.ts\` — this file too. Do not edit
it by hand; change \`packages/web/e2e/capture/manifest.ts\` and re-run the command.

## Reproduce

\`\`\`bash
npm ci
npm run build
npm run capture:screenshots -w @qodeca/xezar-web
# one state only:
npm run capture:screenshots -w @qodeca/xezar-web -- -t tasks-list
\`\`\`

The command boots the shared browser environment (\`scripts/test-env-up.sh\`, which provisions
agent-browser) and then its own fixture server. It is not part of \`npm run test:e2e\` or any gate.

## What is scripted, and what is rewritten

- **The agents are scripted.** The capture server runs the harness's own stand-ins for Claude Code,
  Codex and pi (\`packages/web/e2e/capture/agents/\`), not the bundled test mocks. Each seeded task
  plays its own turn through that backend's real protocol: its own tool calls and results, real
  edits in its worktree, its own token counts and references. The cockpit renders them as it would
  render a real agent; the screenshot in the running thread is a page the harness renders.
- **Values that differ on every run are rewritten** to fixed values right before each capture:
  ages, clock times and ISO timestamps (kept in order), run ids and \`xez/<id8>\` branch suffixes
  (one fixed value per task), and the temporary workspace path (shown as \`~/code\`, its sandboxed
  home as \`~\`). Layout is untouched.
- **The dry-run forge's stand-ins are rewritten** to the fixture repository's own GitHub remote:
  \`mock/repo\` reads \`acme/demo-shop\`, the author \`mock\` reads as a person, the fake draft
  PR URL reads as a PR on that repository, and a mocked agent's \`mock (…)\` version reads as a
  version number.
- Animations are stopped, and the floating toasts, backdrops and the thread's "Jump to latest"
  pill are hidden, so no capture lands on a random frame.
- The Tasks table folds Model, Cost, CPU and Mem; with every column open it is wider than 1280 px
  beside the sidebar and IN / OUT is cut off.
- The version chip is pinned to v${docsVersion}, the version these docs describe, not the
  pre-release build's own \`package.json\` version.
- A still larger than 300 KB would be re-encoded as an 8-bit palette PNG. The tour's streaming
  frames are sampled live, so their count can vary; their total time is fixed, and the tour runs
  at most 20 seconds.

## Files

| File | Shows | Theme | Viewport |
| --- | --- | --- | --- |
${rows.join('\n')}
| [\`${TOUR_FILE}\`](${TOUR_FILE}) | A tour: the task list, a new task typed and started, the running thread, review, a draft PR, and the list again | dark | 1280 × 800 |
`
    writeFileSync(join(outDir, 'README.md'), readme)
  })
})
