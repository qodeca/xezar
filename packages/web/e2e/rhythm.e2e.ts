import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, xezarCli, fixtureServeEnv, removeDataRoot, stopFixtureServer } from './agent-browser'
import record from './fixtures/thread-run.record.json'

/**
 * The shipped rhythm (#424 step 2, design `designs/design-system-air/` § 9.2 and AC 3), read
 * off the rendered cockpit through computed style – not off class names – at the default
 * density and again at Compact for real, where every value must be 75 %.
 *
 * Boots its own server (the thread fixture, same doctrine as task-thread.e2e.ts) so the
 * density this spec saves lands in the fixture's pinned `XEZ_HOME`, never in the shared
 * environment another spec reads. The Roomy leg (125 %) arrives with step 4.
 */

const sessionId = `e2e-rhythm-${process.pid}`
const RUN_ID: string = record.id

/** Compact and Compact for real can give half pixels; allow for rounding. */
const TOLERANCE_PX = 0.5

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
  throw new Error(`xezar e2e: the fixture server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

type Rhythm = Record<
  | 'threadRow'
  | 'speakerChange'
  | 'cardPadding'
  | 'cardListGap'
  | 'settingsField'
  | 'settingsList'
  | 'desktopGutter'
  | 'bodyTop',
  number
>

/** The shipped values at Comfortable (4 px per unit). */
const DEFAULT: Rhythm = {
  threadRow: 8,
  speakerChange: 24,
  cardPadding: 20,
  cardListGap: 16,
  settingsField: 12,
  settingsList: 32,
  desktopGutter: 32,
  bodyTop: 32,
}

/** Every measurement, taken on the screen that renders it. */
function measure(): Rhythm {
  browser.goto(`${baseUrl}/p/${bootProject}/tasks/${RUN_ID}`)
  // Wait for the replay (two user bubbles), not for the speaker marker: a build without the
  // marker must fail on the measured values below, not on a timeout.
  browser.waitForFunction(`document.querySelectorAll('[data-slot="user-bubble"]').length >= 2`)
  const thread = browser.evaluate(`(() => {
    const inTurn = document.querySelector('[data-slot="thread-row"]:not([data-speaker-end])')
    const boundary = document.querySelector('[data-slot="thread-row"][data-speaker-end="true"]')
    return {
      threadRow: inTurn ? parseFloat(getComputedStyle(inTurn).paddingBottom) : -1,
      speakerChange: boundary ? parseFloat(getComputedStyle(boundary).paddingBottom) : -1,
    }
  })()`) as Pick<Rhythm, 'threadRow' | 'speakerChange'>

  browser.goto(`${baseUrl}/p/${bootProject}`)
  browser.waitForFunction(`document.querySelector('[data-route="tasks"] > header + div') !== null`)
  const page = browser.evaluate(`(() => {
    const body = getComputedStyle(document.querySelector('[data-route="tasks"] > header + div'))
    return { desktopGutter: parseFloat(body.paddingLeft), bodyTop: parseFloat(body.paddingTop) }
  })()`) as Pick<Rhythm, 'desktopGutter' | 'bodyTop'>

  browser.goto(`${baseUrl}/settings/global`)
  browser.waitForFunction(`document.querySelector('[data-slot="settings-index"] a') !== null`)
  const cards = browser.evaluate(`(() => {
    const list = getComputedStyle(document.querySelector('[data-slot="settings-index"]'))
    const card = getComputedStyle(document.querySelector('[data-slot="settings-index"] a'))
    return { cardPadding: parseFloat(card.paddingTop), cardListGap: parseFloat(list.rowGap) }
  })()`) as Pick<Rhythm, 'cardPadding' | 'cardListGap'>

  browser.goto(`${baseUrl}/settings/global/appearance`)
  browser.waitForFunction(`document.querySelector('[data-slot="appearance-section"] > section') !== null`)
  const settings = browser.evaluate(`(() => {
    const list = getComputedStyle(document.querySelector('[data-slot="appearance-section"]'))
    const field = getComputedStyle(document.querySelector('[data-slot="appearance-section"] > section'))
    return { settingsList: parseFloat(list.rowGap), settingsField: parseFloat(field.rowGap) }
  })()`) as Pick<Rhythm, 'settingsList' | 'settingsField'>

  return { ...thread, ...page, ...cards, ...settings }
}

function expectRhythm(actual: Rhythm, scale: number): void {
  // One assertion over every value, so a failure names all eight measurements at once.
  const off = (Object.entries(DEFAULT) as [keyof Rhythm, number][])
    .filter(([name, value]) => !(Math.abs(actual[name] - value * scale) <= TOLERANCE_PX))
    .map(([name, value]) => `${name}: ${actual[name]}px, expected ${value * scale}px`)
  expect(off).toEqual([])
}

function chooseDensity(value: 'comfortable' | 'ultra'): void {
  browser.goto(`${baseUrl}/settings/global/appearance`)
  browser.waitForFunction(`document.querySelector('[data-slot="appearance-density"]') !== null`)
  browser.click(`[data-slot="appearance-density"] [data-value="${value}"]`)
  browser.waitForFunction(
    value === 'comfortable'
      ? `document.documentElement.dataset.density === undefined`
      : `document.documentElement.dataset.density === '${value}'`,
  )
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xezar-e2e-rhythm-'))
  mkdirSync(join(dataRoot, '.local/xezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.local/xezar/runs.json'), JSON.stringify([record], null, 2), 'utf8')
  copyFileSync(
    resolve(import.meta.dirname, 'fixtures/thread-run.ndjson'),
    join(dataRoot, '.local/xezar/runs', `${RUN_ID}.ndjson`),
  )

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [xezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(dataRoot),
    stdio: 'ignore',
  })
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(sessionId)
  // Desktop, so the `md:` gutters apply.
  browser.setViewport(1280, 900)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  await removeDataRoot(dataRoot)
})

describe('the rhythm tokens on the rendered cockpit', () => {
  it('ships the default rhythm at Comfortable', () => {
    expectRhythm(measure(), 1)
  })

  it('scales every value to 75 % at Compact for real', () => {
    chooseDensity('ultra')
    try {
      expectRhythm(measure(), 0.75)
    } finally {
      chooseDensity('comfortable')
    }
  })
})
