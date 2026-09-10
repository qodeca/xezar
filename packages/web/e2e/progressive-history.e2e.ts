import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, fixtureServeEnv, removeDataRoot, stopFixtureServer } from './agent-browser'
import { largeThreadEvents } from './fixtures/make-large-thread'
import record from './fixtures/thread-run.record.json'

const repoRoot = resolve(import.meta.dirname, '../../..')
const artifactsDir = resolve(repoRoot, '.local/qa/artifacts_e2e')
const sessionId = `e2e-progressive-history-${process.pid}`
const RUN_ID = 'cccccccc-1111-4222-8333-dddddddddddd'
const RUN_B_ID = 'eeeeeeee-1111-4222-8333-ffffffffffff'
const RUN = {
  ...record,
  id: RUN_ID,
  title: 'Progressively page a very long session',
  titleSummary: 'Progressively page a long session',
  task: 'Inspect a long session without downloading the archive.',
  status: 'running',
  finishedAt: undefined,
  steps: [record.steps[0]],
  pullRequestUrl: undefined,
}
const RUN_B = {
  ...RUN,
  id: RUN_B_ID,
  title: 'Restore a second long session without jumping',
  titleSummary: 'Restore a second long session',
  task: 'Keep a second long session at its cached reading position.',
}

const contextPrefix = [
  {
    type: 'turn.started',
    turnId: 'context-turn',
    stepId: 'task',
  },
  {
    type: 'plan.updated',
    stepId: 'task',
    entries: [{ content: 'Keep the current plan visible', status: 'in_progress' }],
  },
  {
    type: 'item.started',
    stepId: 'task',
    item: {
      kind: 'tool',
      id: 'history-agent',
      name: 'Task',
      toolKind: 'task',
      title: 'Task: watch current history work',
      status: 'running',
    },
  },
]

const events = [...contextPrefix, ...largeThreadEvents(300)].map((event, index) => ({
  ...event,
  seq: index + 1,
  ts: new Date(Date.parse('2026-07-30T00:00:00.000Z') + index * 10).toISOString(),
}))

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolvePort(port))
    })
  })
}

async function waitForHealth(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/v1/health`)).ok) return
    } catch {
      // Server startup is expected to race the first probes.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`xezar e2e: fixture server never answered at ${baseUrl}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

const cursorRequestCount = `performance.getEntriesByType('resource').filter((entry) => {
  const url = new URL(entry.name)
  return url.pathname.endsWith('/runs/${RUN_ID}/history') && url.searchParams.has('cursor')
}).length`

function activateHistoryBoundary(): void {
  browser.evaluate(`document.querySelector('[data-slot="history-boundary"] button').focus()`)
  browser.press('Enter')
}

type ArrivalSample = { top: number; maxTop: number }
type Arrival = { samples: ArrivalSample[]; settled: ArrivalSample }

/** Consecutive identical frames that count as "the arrival has stopped moving". Frames, not
 *  milliseconds: the unit the scroller itself works in, so it means the same thing on a fast
 *  laptop and on a slow CI runner. */
const STILL_FRAMES = 8
/** A bound on the wait, not a budget the assertions are judged against: an arrival that never
 *  stops moving is a real failure and must be reported as one, not silently sampled anyway. */
const MAX_ARRIVAL_FRAMES = 900

/**
 * Capture every destination-transcript animation frame around a client-side task switch, and
 * keep sampling until the scroller has SETTLED — the same position and the same content height
 * for {@link STILL_FRAMES} frames in a row.
 *
 * Position assertions belong on the settled frame, never on frame N of a fixed count. The
 * scroller says why itself (`thread-scroller.tsx`): while a restore is pending, its
 * ResizeObserver re-applies `min(parked, maxTop)` on every content growth and only releases the
 * restore once `maxTop >= pending` AND the height has repeated. So an early frame legitimately
 * sits at a clamped-down offset while the transcript is still filling in — how many frames that
 * takes is a fact about the machine, which is exactly what a pixel budget over frame 0 ends up
 * measuring.
 */
function navigateAndSampleArrival(runId: string): Arrival {
  const href = `/p/${bootProject}/tasks/${runId}`
  browser.evaluate(`(() => {
    const link = document.querySelector(${JSON.stringify(`a[href="${href}"]`)})
    if (!link) throw new Error('missing task navigation link: ${href}')
    window.__xezArrivalSamples = []
    window.__xezArrivalSettled = null
    let attempts = 0
    let still = 0
    const sample = () => {
      attempts += 1
      const main = document.querySelector('[data-slot="main"]')
      const destination = document.querySelector(
        ${JSON.stringify(`[data-route="task-thread"][data-run-id="${runId}"]`)},
      )
      const ready = destination?.querySelector('[data-slot="thread-rows"]')
      if (main && ready) {
        const previous = window.__xezArrivalSamples[window.__xezArrivalSamples.length - 1]
        const next = { top: main.scrollTop, maxTop: main.scrollHeight - main.clientHeight }
        still = previous && previous.top === next.top && previous.maxTop === next.maxTop
          ? still + 1
          : 0
        window.__xezArrivalSamples.push(next)
        if (still >= ${STILL_FRAMES}) {
          window.__xezArrivalSettled = next
          return
        }
      }
      if (attempts < ${MAX_ARRIVAL_FRAMES}) requestAnimationFrame(sample)
      else window.__xezArrivalSettled = 'never-settled'
    }
    requestAnimationFrame(sample)
    link.click()
  })()`)
  browser.waitForFunction(`window.__xezArrivalSettled !== null`)
  const settled = browser.evaluate(`window.__xezArrivalSettled`) as ArrivalSample | 'never-settled'
  const samples = browser.evaluate(`window.__xezArrivalSamples`) as ArrivalSample[]
  if (settled === 'never-settled') {
    throw new Error(
      `xezar e2e: the arrival at ${runId} never settled in ${MAX_ARRIVAL_FRAMES} frames `
      + `(last ${JSON.stringify(samples.slice(-4))})`,
    )
  }
  return { samples, settled }
}

/**
 * Park the reader mid-transcript and return the offset they are ACTUALLY left at.
 *
 * NOT the offset written — the write is only where it starts. Rows carry
 * `content-visibility: auto` with a `3rem` intrinsic-size placeholder, so a row that has never
 * been rendered contributes a guess instead of its height. Scrolling renders a fresh band, the
 * guesses are replaced by real (smaller) heights, and the transcript keeps SHRINKING for
 * several frames after the write — measured here, 5672px of content became 5020px. Part of what
 * it loses is above the viewport, so the browser's own scroll anchoring (`overflow-anchor:
 * auto`, the default) slides `scrollTop` down to keep the same content on screen: 2386 → 1944.
 * Anchoring is what moves it, measured rather than assumed — with `overflow-anchor: none` on the
 * same scroller the transcript still shrinks and `scrollTop` does not move at all.
 *
 * The scroller then records THAT offset as where the reader is, and its restore returns them to
 * it — both correct. Reading `scrollTop` back synchronously captures a number the reader never
 * ended on, and whether the assertion below notices is a race between the anchoring adjustment
 * and the next navigation: this laptop leaves first and passes, a slower GitHub runner does not
 * and fails by the size of the shrink (365px there, #177). So settle FIRST — same rule, and the
 * same frame-counting unit, as {@link navigateAndSampleArrival}: the departure offset has to be
 * as final as the arrival one before a 1px budget can mean anything about the restore.
 */
function parkCurrentThread(): number {
  browser.evaluate(`(() => {
    const main = document.querySelector('[data-slot="main"]')
    main.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
    main.scrollTop = Math.max(160, Math.round((main.scrollHeight - main.clientHeight) / 2))
    main.dispatchEvent(new Event('scroll', { bubbles: true }))
    window.__xezParkSettled = null
    let attempts = 0
    let still = 0
    let previous = null
    const sample = () => {
      attempts += 1
      const next = { top: main.scrollTop, height: main.scrollHeight }
      still = previous && previous.top === next.top && previous.height === next.height ? still + 1 : 0
      previous = next
      if (still >= ${STILL_FRAMES}) {
        window.__xezParkSettled = next
        return
      }
      if (attempts < ${MAX_ARRIVAL_FRAMES}) requestAnimationFrame(sample)
      else window.__xezParkSettled = 'never-settled'
    }
    requestAnimationFrame(sample)
  })()`)
  browser.waitForFunction(`window.__xezParkSettled !== null`)
  const settled = browser.evaluate(`window.__xezParkSettled`) as { top: number; height: number } | 'never-settled'
  // A park that never stops moving is a real failure and must be reported as one, never
  // silently sampled anyway — the same contract the arrival sampler keeps.
  if (settled === 'never-settled') {
    throw new Error(
      `xezar e2e: the parked thread never stopped moving in ${MAX_ARRIVAL_FRAMES} frames`,
    )
  }
  return settled.top
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xezar-e2e-progressive-history-'))
  mkdirSync(join(dataRoot, '.local/xezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.local/xezar/runs.json'), JSON.stringify([RUN, RUN_B], null, 2), 'utf8')
  for (const runId of [RUN_ID, RUN_B_ID]) {
    writeFileSync(
      join(dataRoot, '.local/xezar/runs', `${runId}.ndjson`),
      events.map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf8',
    )
  }
  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [join(repoRoot, 'packages/xezar/dist/index.js'), 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/p/${bootProject}/tasks/${RUN_ID}`)
  browser.waitForFunction(
    `document.querySelector('[data-route="task-thread"]') !== null &&
     document.querySelector('[data-slot="thread-rows"]') !== null`,
  )
  browser.waitForFunction(
    `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages === '1' &&
     document.querySelector('[data-slot="history-boundary"] button:not([disabled])') !== null`,
  )
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  await removeDataRoot(dataRoot)
})

describe('progressive long-session history', () => {
  it('paints the current tail and docks without requesting an earlier page', () => {
    expect(Number(browser.evaluate(cursorRequestCount))).toBe(0)
    expect(browser.text('[data-slot="plan-dock"]')).toContain('Keep the current plan visible')
    expect(browser.text('[data-slot="agents-dock"]')).toContain('0/1')
    expect(browser.count('[data-slot="thread-row"]')).toBeLessThan(300)
    browser.screenshot(join(artifactsDir, 'progressive-history-tail.png'), { viewport: true })
  })

  it('loads exactly one page from the accessible control and preserves a bounded page count', async () => {
    activateHistoryBoundary()
    browser.waitForFunction(`${cursorRequestCount} === 1`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages === '2'`,
    )
    expect(Number(browser.evaluate(cursorRequestCount))).toBe(1)
    browser.screenshot(join(artifactsDir, 'progressive-history-earlier-page.png'), { viewport: true })
    // Let the prepend anchor's requestAnimationFrame settle before the next test supplies
    // a genuinely fresh upward gesture.
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  })

  it('consumes one upward intent without cascading while the boundary remains near', async () => {
    browser.evaluate(`(() => {
      const main = document.querySelector('[data-slot="main"]')
      main.scrollTop = 0
      main.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
    })()`)
    browser.waitForFunction(`${cursorRequestCount} === 2`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    expect(Number(browser.evaluate(cursorRequestCount))).toBe(2)
  })

  it('caps retained pages at five and jumps directly back to a fresh tail', () => {
    let page = Number(browser.evaluate(
      `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages`,
    ))
    while (page < 5) {
      page += 1
      // Polled retry rather than one un-timed press: the boundary disables itself while a page
      // is in flight and re-anchors the scroller on a frame after it lands, so a single
      // activation aimed at either of those moments is dropped. Asking again until the count
      // rises is safe HERE — this case is about the five-page ceiling, while the exactly-once
      // gesture semantics are the previous case's, and it still presses once per page.
      browser.waitForFunction(`(() => {
        const boundary = document.querySelector('[data-slot="history-boundary"]')
        if (boundary === null) return false
        if (boundary.dataset.retainedPages === '${page}') return true
        boundary.querySelector('button:not([disabled])')?.click()
        return false
      })()`)
    }
    expect(Number(browser.evaluate(
      `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages`,
    ))).toBe(5)
    browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop = 0`)
    browser.waitForFunction(`document.querySelector('[data-slot="jump-to-latest"]') !== null`)
    browser.click('[data-slot="jump-to-latest"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages === '1'`,
    )
  })

  it('switches between cached and live-tail threads without a near-zero destination frame', () => {
    // The preceding paging case deliberately visited the archive boundary. Establish the first
    // run's departure state as an explicit live-tail cache entry before warming the second run.
    browser.evaluate(`(() => {
      const main = document.querySelector('[data-slot="main"]')
      main.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }))
      main.scrollTop = main.scrollHeight - main.clientHeight
      main.dispatchEvent(new Event('scroll', { bubbles: true }))
    })()`)
    browser.waitForFunction(
      `(() => { const main = document.querySelector('[data-slot="main"]'); return main.scrollHeight - main.scrollTop - main.clientHeight < 80 })()`,
    )

    // Warm both query caches first. The destination transcript, not a loading placeholder, is
    // the surface whose paint ordering this regression measures.
    const firstTailArrival = navigateAndSampleArrival(RUN_B_ID)
    expect(firstTailArrival.settled.maxTop - firstTailArrival.settled.top).toBeLessThan(80)
    const parked = parkCurrentThread()
    expect(parked).toBeGreaterThan(100)

    const liveTailArrival = navigateAndSampleArrival(RUN_ID)
    expect(Math.min(...liveTailArrival.samples.map(({ top }) => top))).toBeGreaterThan(40)
    expect(liveTailArrival.settled.maxTop - liveTailArrival.settled.top).toBeLessThan(80)

    const cachedArrival = navigateAndSampleArrival(RUN_B_ID)
    // The regression this case is named for: no frame of the destination transcript is drawn at
    // the top of the session. Every captured frame, so a flash that lasts one frame still fails.
    expect(Math.min(...cachedArrival.samples.map(({ top }) => top))).toBeGreaterThan(40)
    // …and the arrival ENDS on the position the reader parked at. One pixel of slack, and it is
    // for sub-pixel rounding of a single `scrollTop`/`handle.scrollTo` write on a fractional
    // device pixel ratio — nothing else. Nothing else needs absorbing, because the timing is
    // absorbed WHERE IT HAPPENS: `parked` is the offset the departure SETTLED on, not the one it
    // was written to, so the restore has one number to reproduce. Anything larger is the
    // scroller landing somewhere else — a restore that missed, or a re-pin to the live tail.
    // That is what the 200px budget this replaces could not distinguish from a slow machine
    // (#133). The 365px this saw on a GitHub runner was neither: it was scroll anchoring moving
    // the DEPARTURE after `parked` had been read, which is now settled for rather than budgeted
    // for — see `parkCurrentThread` (#177). Measured here: settled exactly on `parked`, and
    // 1825px off it with the cache restore disabled.
    expect(Math.abs(cachedArrival.settled.top - parked)).toBeLessThanOrEqual(1)
    browser.screenshot(join(artifactsDir, 'progressive-history-thread-switch.png'), { viewport: true })

    browser.setViewport(390, 844)
    const mobileTailArrival = navigateAndSampleArrival(RUN_ID)
    expect(Math.min(...mobileTailArrival.samples.map(({ top }) => top))).toBeGreaterThan(40)
    expect(mobileTailArrival.settled.maxTop - mobileTailArrival.settled.top).toBeLessThan(80)
    browser.screenshot(join(artifactsDir, 'progressive-history-thread-switch-mobile.png'), {
      viewport: true,
    })
    browser.setViewport(1440, 900)
  }, 90_000)
})
