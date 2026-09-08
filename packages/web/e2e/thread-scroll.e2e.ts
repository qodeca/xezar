import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, removeDataRoot, stopFixtureServer } from './agent-browser'
import { expectedRowCount, largeThreadEvents } from './fixtures/make-large-thread'
import record from './fixtures/thread-run.record.json'

/**
 * R3 Step 2.4 in a real browser: virtualization on a LARGE transcript (the synthetic
 * 250-turn NDJSON from make-large-thread.ts — real wire shapes, >2,000 events, >1,000
 * rendered rows), the stick/jump behavior, the per-run scroll cache across a client-side
 * round trip, and the iPhone-viewport composer.
 *
 * HONESTY NOTES on what a headless browser can and cannot prove:
 *  - Smoothness is asserted by proxy: the DOM stays bounded under virtualization (rendered
 *    row count and total element count, compared against the SAME transcript force-rendered
 *    flat via `?thread=flat` — the measurement seam in thread-scroll.ts).
 *  - The iOS keyboard cannot be driven headless. The `--kb` adapter math is unit-tested
 *    against stub viewports (lib/keyboard-inset.test.ts); here the test drives the CSS seam
 *    it feeds (`--kb` → the dock's `bottom`) and verifies the composer fits an iPhone
 *    viewport. Real-device keyboard behavior remains a manual checklist item.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-thread-scroll-${process.pid}`

const TURNS = 250
/** The transcript's full size on disk — far more than any single screen ever holds, which is
 *  the point: this fixture exists to make the reader page and the renderer window. */
const ROWS = expectedRowCount(TURNS) // 1002
/** `MAX_HISTORY_PAGES` in `packages/web/src/api/run-history.ts`. */
const MAX_RETAINED_PAGES = 5
/** Rows on screen once all five pages are retained: five × the 100-item page bound
 *  (`RUN_HISTORY_PAGE_ITEMS`), plus the run's own task bubble, which is not a transcript item
 *  and is therefore always there — the same arithmetic that makes a freshly opened thread 101
 *  rows. Comfortably past the ~300 `VIRTUALIZE_THRESHOLD`, which is what lets the two
 *  measurements below compare flat and windowed rendering of the SAME state. */
const RETAINED_ROWS = 501

const RUN_ID = 'aaaaaaaa-1111-4222-8333-bbbbbbbbcccc'
/** The real record fixture, re-ided for the synthetic transcript; the untouched fields keep
 *  the store's zod shape. No PR url (this run never shipped one) and only the agent step. */
const RUN = {
  ...record,
  id: RUN_ID,
  title: 'Walk the whole git history in passes',
  titleSummary: 'Walk the whole git history',
  task: 'Walk the whole git history in passes.',
  tokensUsed: TURNS * 150,
  steps: [record.steps[0]],
  pullRequestUrl: undefined,
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`cezar e2e: the fixture server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

const MAIN = `document.querySelector('[data-slot="main"]')`
const nearBottom = `(() => { const m = ${MAIN}; return m.scrollHeight - m.scrollTop - m.clientHeight < 80 })()`
const rowCount = () => browser.count('[data-slot="thread-row"]')
const domSize = () => Number(browser.evaluate(`document.querySelectorAll('*').length`))
const assistantWidth = () =>
  Number(browser.evaluate(`document.querySelector('[data-slot="assistant-message"]')?.getBoundingClientRect().width ?? 0`))

/**
 * Scroll away from the tail like a reader would — and INSIST, like a reader would.
 * The wheel gesture is what unpins the thread (unpinning is intent-based); the scrollTop
 * write is the e2e's stand-in for the native scroll a real wheel performs. Raw writes can
 * lose a same-frame race against virtua's jump compensation (which real, event-synced
 * native scrolling doesn't hit), so the park is a polled retry until it holds.
 * `target` is a JS expression evaluated against the scroller (`m`).
 */
function parkAt(target: string) {
  browser.waitForFunction(`(() => {
    const m = ${MAIN}
    const target = ${target}
    if (Math.abs(m.scrollTop - target) > 50) {
      m.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
      m.scrollTop = target
      return false
    }
    return true
  })()`)
}

const BOUNDARY = `document.querySelector('[data-slot="history-boundary"]')`
const retainedPages = () => Number(browser.evaluate(`${BOUNDARY}?.dataset.retainedPages ?? 0`))

/**
 * Page the transcript back until the cockpit holds every page it will retain.
 *
 * Transcript history is PROGRESSIVE: arrival paints only the newest `RUN_HISTORY_PAGE_ITEMS`
 * (100) canonical items, and older pages load when the reader reaches the boundary. The client
 * keeps a five-page window (`MAX_HISTORY_PAGES` in api/run-history.ts) — asking for a sixth
 * drops the newest — so this is the largest thread a reader can ever have on screen at once,
 * and it is the state every measurement below is taken over.
 *
 * Activation goes through the boundary's own button rather than a synthetic wheel gesture:
 * it is the accessible control, and it cannot lose a race with the scroll anchor.
 */
function loadRetainedHistory() {
  for (let page = retainedPages(); page > 0 && page < MAX_RETAINED_PAGES; page += 1) {
    // Polled retry, like `parkAt` below and for the same reason: the boundary disables itself
    // while a page is in flight and re-anchors the scroller on a requestAnimationFrame after
    // it lands, so a single un-timed activation can be dropped between those two states.
    // Asking again until the retained count actually rises is what a reader does, and it is
    // the only formulation that does not encode a guessed delay.
    browser.waitForFunction(`(() => {
      const boundary = ${BOUNDARY}
      if (boundary === null) return true // start of session — nothing older to ask for
      if (Number(boundary.dataset.retainedPages ?? 0) > ${page}) return true
      boundary.querySelector('button:not([disabled])')?.click()
      return false
    })()`)
  }
}

/** Load the thread, wait until the SSE replay has finished growing it (the last turn's note is
 *  rendered), then page history back to the full retained window. */
function openThread(query = '') {
  browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}${query}`)
  browser.waitForFunction(
    `document.querySelector('[data-slot="thread-rows"]') !== null && document.body.textContent.includes('goal achieved — session closed')`,
  )
  loadRetainedHistory()
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-thread-scroll-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([RUN], null, 2), 'utf8')
  writeFileSync(
    join(dataRoot, '.ai/cezar/runs', `${RUN_ID}.ndjson`),
    largeThreadEvents(TURNS)
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
    'utf8',
  )

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  await removeDataRoot(dataRoot)
})

describe('thread virtualization on a 1,000-row transcript', () => {
  let flatRows = 0
  let flatDom = 0
  let flatAssistantWidth = 0

  it('force-flat renders every row (the before measurement)', () => {
    openThread('?thread=flat')
    expect(browser.evaluate(`document.querySelector('[data-slot="thread-rows"]').dataset.virtualized`)).toBe('false')
    flatRows = rowCount()
    flatDom = domSize()
    flatAssistantWidth = assistantWidth()
    expect(flatRows).toBe(RETAINED_ROWS)
    // Pagination is genuinely in play: the reader is holding a window, not the whole file.
    expect(flatRows).toBeLessThan(ROWS)
    expect(retainedPages()).toBe(MAX_RETAINED_PAGES)
    expect(flatAssistantWidth).toBeGreaterThan(200)
  }, 90_000)

  it('auto mode virtualizes past the threshold and keeps the DOM bounded', () => {
    openThread()
    expect(browser.evaluate(`document.querySelector('[data-slot="thread-rows"]').dataset.virtualized`)).toBe('true')

    const virtualRows = rowCount()
    const virtualDom = domSize()
    // The honest metric, same transcript, same browser: virtua holds a viewport window plus
    // overscan, not the list. The exact window varies with row heights — the bound is what
    // matters: an order of magnitude fewer live rows than flat mode.
    expect(virtualRows).toBeGreaterThan(0)
    expect(virtualRows).toBeLessThan(flatRows / 10)
    expect(virtualDom).toBeLessThan(flatDom / 2)
    const virtualAssistantWidth = assistantWidth()
    expect(virtualAssistantWidth).toBeGreaterThan(200)
    expect(Math.abs(virtualAssistantWidth - flatAssistantWidth)).toBeLessThan(2)
    // The numbers themselves are checkpoint material — persisted next to the screenshots.
    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(
      join(artifactsDir, 'thread-scroll-metrics.json'),
      JSON.stringify({ transcriptEvents: largeThreadEvents(TURNS).length, rows: { flat: flatRows, virtualized: virtualRows }, domElements: { flat: flatDom, virtualized: virtualDom } }, null, 2),
      'utf8',
    )
  }, 90_000)

  it('arrives pinned to the live tail (bottom-anchored), with no jump pill', () => {
    expect(browser.evaluate(nearBottom)).toBe(true)
    expect(browser.count('[data-slot="jump-to-latest"]')).toBe(0)
    browser.screenshot(`${artifactsDir}/thread-long-desktop.png`)
  })

  it('scrolling up shows the jump pill; clicking it returns to the tail', () => {
    parkAt('0')
    browser.waitForFunction(`document.querySelector('[data-slot="jump-to-latest"]') !== null`)
    // Viewport shot: full-page capture scroll-stitches 48k px and re-pins the thread,
    // unmounting the very pill this is photographing.
    browser.screenshot(`${artifactsDir}/thread-jump-pill.png`, { viewport: true })

    browser.click('[data-slot="jump-to-latest"]')
    browser.waitForFunction(nearBottom)
    browser.waitForFunction(`document.querySelector('[data-slot="jump-to-latest"]') === null`)
    // Let the smooth scroll LAND, not merely enter the near-bottom slack — the next test
    // parks mid-thread, and a still-running animation would carry its park away.
    browser.waitForFunction(
      `(() => { const m = ${MAIN}; return Math.abs(m.scrollHeight - m.clientHeight - m.scrollTop) < 2 })()`,
    )
  })

  it('restores the scroll position across a client-side leave and return', () => {
    // Park mid-thread (a position the arrival logic would never pick on its own).
    parkAt(`Math.round((m.scrollHeight - m.clientHeight) / 2)`)
    browser.waitForFunction(`document.querySelector('[data-slot="jump-to-latest"]') !== null`)
    const parked = Number(browser.evaluate(`${MAIN}.scrollTop`))
    expect(parked).toBeGreaterThan(1000)
    const maxTop = Number(browser.evaluate(`${MAIN}.scrollHeight - ${MAIN}.clientHeight`))
    expect(maxTop - parked).toBeGreaterThan(1000) // genuinely mid-thread, not a near-tail park

    // …leave through the sidebar (a client-side <Link> — a reload would drop the caches)…
    browser.click(`[data-slot="sidebar"] a[href="${scoped('/')}"]`)
    browser.waitForFunction(`document.querySelector('[data-route="task-thread"]') === null`)

    // …and come back through the quick list.
    browser.click(`a[href="${scoped(`/tasks/${RUN_ID}`)}"]`)
    browser.waitForFunction(`document.querySelector('[data-slot="thread-rows"]') !== null`)
    // The replay re-grows the thread; the cached offset is re-applied until reachable.
    browser.waitForFunction(`Math.abs(${MAIN}.scrollTop - ${parked}) < 200`)
    expect(browser.evaluate(nearBottom)).toBe(false) // back where the reader parked, not the tail
  }, 90_000)
})

describe('iPhone viewport (390×844)', () => {
  it('keeps the composer visible and wired to the --kb keyboard lift', () => {
    browser.setViewport(390, 844)
    openThread()

    // The composer dock fits the visual viewport (no keyboard yet: --kb is unset ⇒ 0px).
    const dock = browser.evaluate(`(() => {
      const dock = document.querySelector('[data-slot="thread-dock"]')
      const rect = dock.getBoundingClientRect()
      return { bottomGap: window.innerHeight - rect.bottom, cssBottom: getComputedStyle(dock).bottom }
    })()`) as { bottomGap: number; cssBottom: string }
    expect(dock.bottomGap).toBeGreaterThanOrEqual(0)
    expect(dock.cssBottom).toBe('0px')

    // The keyboard seam, driven directly: publishing --kb (what the visualViewport watcher
    // does on a real device — unit-tested against stubs) lifts the sticky dock by exactly
    // that inset. The keyboard itself cannot be summoned in a headless browser.
    browser.evaluate(`document.documentElement.style.setProperty('--kb', '280px')`)
    expect(browser.evaluate(`getComputedStyle(document.querySelector('[data-slot="thread-dock"]')).bottom`)).toBe('280px')
    browser.evaluate(`document.documentElement.style.removeProperty('--kb')`)
    expect(browser.evaluate(`getComputedStyle(document.querySelector('[data-slot="thread-dock"]')).bottom`)).toBe('0px')

    browser.screenshot(`${artifactsDir}/thread-iphone.png`, { viewport: true })
    browser.setViewport(1440, 900)
  }, 90_000)
})
