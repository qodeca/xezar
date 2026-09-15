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
 * density, at Roomy (#424 step 4), where every value must be 125 %, and at Compact for real,
 * where every value must be 75 %.
 *
 * Boots its own server (the thread fixture, same doctrine as task-thread.e2e.ts) so the
 * density this spec saves lands in the fixture's pinned `XEZ_HOME`, never in the shared
 * environment another spec reads.
 *
 * The second half reads the hand-typed pixels step 3b put back on the scale (§ 9.3): they must
 * now shrink with the lever too, except the two chips, which an absolute 24 px floor holds up.
 */

const sessionId = `e2e-rhythm-${process.pid}`
const RUN_ID: string = record.id
/** A second run carrying a pull request, so the task table and the quick list paint a reference chip. */
const REFERENCE_RUN_ID = '3b0c5e2a-4d1f-4c8e-9a7b-2f6d8e1c0a93'

/** Roomy and Compact for real can give fractional pixels; allow for rounding. */
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

type Controls = Record<
  | 'navRow'
  | 'newTask'
  | 'brandGap'
  | 'tableHeader'
  | 'quickListPad'
  | 'toolRow'
  | 'pickerPill'
  | 'tableReferenceChip'
  | 'quickListReferenceChip',
  number
>

/** The converted controls at Comfortable, and the floor the two chips never go under. */
const CONTROLS: Controls = {
  navRow: 36,
  newTask: 40,
  brandGap: 8,
  tableHeader: 40,
  quickListPad: 8,
  toolRow: 32,
  pickerPill: 28,
  tableReferenceChip: 24,
  quickListReferenceChip: 24,
}
const CHIP_FLOOR_PX = 24
const FLOORED: ReadonlySet<keyof Controls> = new Set(['pickerPill', 'tableReferenceChip', 'quickListReferenceChip'])

/** Heights through the rendered box, spacing through computed style – each on its own screen. */
function measureControls(): Controls {
  browser.goto(`${baseUrl}/p/${bootProject}/tasks/${RUN_ID}`)
  browser.waitForFunction(`document.querySelector('[data-slot="tool-card"] > [data-slot="collapsible-trigger"]') !== null`)
  const thread = browser.evaluate(`(() => {
    const sidebar = document.querySelector('[data-slot="sidebar"]')
    const height = (el) => (el ? el.getBoundingClientRect().height : -1)
    const style = (el) => (el ? getComputedStyle(el) : null)
    return {
      navRow: height(sidebar.querySelector('nav a')),
      newTask: height(sidebar.querySelector('a[href$="/new"]')),
      brandGap: parseFloat(style(sidebar.querySelector('[data-slot="sidebar-brand"]'))?.columnGap ?? '-1'),
      quickListPad: parseFloat(style(sidebar.querySelector('[data-slot="task-row"] > a:not([data-slot])'))?.paddingTop ?? '-1'),
      quickListReferenceChip: height(sidebar.querySelector('[data-slot="task-row"] [data-slot="pr-chip"]')),
      // The trigger's min-height, not its box: the box also holds the text line, which does not scale.
      toolRow: parseFloat(style(document.querySelector('[data-slot="tool-card"] > [data-slot="collapsible-trigger"]'))?.minHeight ?? '-1'),
    }
  })()`) as Pick<Controls, 'navRow' | 'newTask' | 'brandGap' | 'quickListPad' | 'quickListReferenceChip' | 'toolRow'>

  browser.goto(`${baseUrl}/p/${bootProject}`)
  browser.waitForFunction(`document.querySelector('[data-route="tasks"] [data-slot="task-table-row"] [data-slot="pr-chip"]') !== null`)
  const table = browser.evaluate(`(() => ({
    tableHeader: document.querySelector('[data-route="tasks"] thead th').getBoundingClientRect().height,
    tableReferenceChip: document.querySelector('[data-route="tasks"] [data-slot="task-table-row"] [data-slot="pr-chip"]').getBoundingClientRect().height,
  }))()`) as Pick<Controls, 'tableHeader' | 'tableReferenceChip'>

  browser.goto(`${baseUrl}/p/${bootProject}/new`)
  browser.waitForFunction(`document.querySelector('[data-slot="model-pill"]') !== null`)
  const composer = browser.evaluate(
    `({ pickerPill: document.querySelector('[data-slot="model-pill"]').getBoundingClientRect().height })`,
  ) as Pick<Controls, 'pickerPill'>

  return { ...thread, ...table, ...composer }
}

function expectControls(actual: Controls, scale: number): void {
  const off = (Object.entries(CONTROLS) as [keyof Controls, number][])
    .map(([name, value]): [keyof Controls, number] => [
      name,
      FLOORED.has(name) ? Math.max(value * scale, CHIP_FLOOR_PX) : value * scale,
    ])
    .filter(([name, expected]) => !(Math.abs(actual[name] - expected) <= TOLERANCE_PX))
    .map(([name, expected]) => `${name}: ${actual[name]}px, expected ${expected}px`)
  expect(off).toEqual([])
}

function chooseDensity(value: 'comfortable' | 'roomy' | 'ultra'): void {
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
  const referenceRun = {
    ...record,
    id: REFERENCE_RUN_ID,
    title: 'Reference chip fixture',
    task: 'Reference chip fixture',
    pullRequestUrl: 'https://github.com/example/repo/pull/7',
  }
  writeFileSync(join(dataRoot, '.local/xezar/runs.json'), JSON.stringify([record, referenceRun], null, 2), 'utf8')
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

  it('scales every value to 125 % at Roomy (10/30/25/20/15/40/40/40)', () => {
    chooseDensity('roomy')
    try {
      expectRhythm(measure(), 1.25)
    } finally {
      chooseDensity('comfortable')
    }
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

describe('the pixels step 3b put back on the scale', () => {
  it('ships the converted controls at Comfortable', () => {
    expectControls(measureControls(), 1)
  })

  it('shrinks them to 75 % at Compact for real, and holds the chips at 24 px', () => {
    chooseDensity('ultra')
    try {
      expectControls(measureControls(), 0.75)
    } finally {
      chooseDensity('comfortable')
    }
  })
})
