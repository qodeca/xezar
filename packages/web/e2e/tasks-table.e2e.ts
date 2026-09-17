import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, xezarCli, fixtureServeEnv, removeDataRoot, stopFixtureServer } from './agent-browser'

/**
 * The Tasks table — and the sidebar beside it listing none of the same runs (#546) — in a real
 * browser, against a real xezar serving real runs.
 *
 * Why this spec boots its own server instead of using the shared test env: the run store reads
 * `.local/xezar/runs.json` **once, at startup** (`RunStore.open`) and is in-memory from then on, so
 * writing that file under the already-running instance would change nothing — the way the inbox
 * spec can, because todos are file-watched and re-broadcast. The list would just render the empty
 * state. And "whatever runs happen to be in the dev checkout" is not a fixture: it is whatever the
 * last person did.
 *
 * So: a throwaway data dir, a fixture `runs.json`, one `node dist/index.js serve --repo <tmp>`.
 *
 * (This file was `quick-list.e2e.ts` while the sidebar carried a task list. Its sidebar-resize
 * cases moved to `sidebar-resize.e2e.ts`, which needs no fixture runs.)
 * The fixture is not invented data — `runs.json` is xezar's documented state contract (a
 * `RunRecord[]`, the exact shape `GET /api/v1/runs` answers with and `src/runs/store.ts` parses with
 * zod). If a record here were wrong, the store would drop it and these assertions would fail.
 *
 * Deliberate limitation: the statuses below are all terminal (`review`/`done`/`failed`). A serve
 * boot *recovers* live runs — `manager.recover()` re-queues `queued`, settles `waiting`, resumes
 * `running` — so a fixture cannot hold those still, and live rows are therefore not covered here.
 * They are covered by the jsdom tests, which drive the components directly.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.local/qa/artifacts_e2e')
const runId = `e2e-tasks-table-${process.pid}`

const now = Date.now()
const ago = (ms: number) => new Date(now - ms).toISOString()

/** A `RunRecord[]` — xezar's on-disk run index. */
const FIXTURE = [
  {
    id: 'fix-review-pr',
    // The raw title is the user's prompt-ish phrasing; `titleSummary` is what the server derived
    // on turn-end (#389). Every surface must show the summary — the raw title appearing anywhere
    // is a regression these specs now catch.
    title: 'add a structured changes endpoint plz',
    titleSummary: 'Structured changes endpoint for the git view',
    workflow: 'default',
    task: 'add a structured changes endpoint',
    status: 'review',
    createdAt: ago(40 * 60_000),
    finishedAt: ago(26 * 60_000),
    tokensUsed: 128_400,
    diffStat: { adds: 128, dels: 14, files: 6 },
    pullRequestUrl: 'https://github.com/qodeca/xezar/pull/396',
    archived: false,
    steps: [],
  },
  {
    id: 'fix-var-a',
    title: 'Add skills autocomplete to composer (A)',
    workflow: 'default',
    task: 'add skills autocomplete',
    status: 'review',
    createdAt: ago(30 * 60_000),
    finishedAt: ago(12 * 60_000),
    tokensUsed: 96_249,
    runner: 'claude',
    groupId: 'fix-group-1',
    variant: 'A',
    archived: false,
    steps: [],
  },
  {
    id: 'fix-var-b',
    title: 'Add skills autocomplete to composer (B)',
    workflow: 'default',
    task: 'add skills autocomplete',
    status: 'review',
    createdAt: ago(30 * 60_000),
    finishedAt: ago(11 * 60_000),
    tokensUsed: 41_800,
    runner: 'codex',
    groupId: 'fix-group-1',
    variant: 'B',
    archived: false,
    steps: [],
  },
  {
    id: 'fix-done',
    title: 'README parallel-agents tagline',
    workflow: 'default',
    task: 'update the readme',
    status: 'done',
    createdAt: ago(3 * 3_600_000),
    finishedAt: ago(2 * 3_600_000),
    tokensUsed: 12_000,
    diffStat: { adds: 9, dels: 2, files: 1 },
    archived: false,
    steps: [],
  },
  {
    id: 'fix-failed',
    title: 'Bump zod to v4',
    workflow: 'default',
    task: 'bump zod',
    status: 'failed',
    createdAt: ago(4 * 3_600_000),
    finishedAt: ago(3 * 3_600_000),
    tokensUsed: 4_100,
    error: 'checks failed',
    archived: false,
    steps: [],
  },
  {
    id: 'fix-archived',
    title: 'Sync merged PR issues',
    workflow: 'default',
    task: 'sync issues',
    status: 'done',
    createdAt: ago(30 * 3_600_000),
    finishedAt: ago(29 * 3_600_000),
    tokensUsed: 8_000,
    archived: true,
    archivedAt: ago(28 * 3_600_000),
    steps: [],
  },
]

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

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2).
 *  Every in-app link the cockpit renders is scoped, so every href assertion below is too. */
const scoped = (path: string) => `/p/${bootProject}${path}`

/**
 * What the removed sidebar task panel would paint, read from the sidebar a person sees: the
 * desktop `<aside>` (complementary landmark) or the phone drawer (the "Navigation" dialog).
 * Located by role, label and visible text only, so a panel that came back under any new
 * markup still reads as present here.
 */
const panelLeftovers = (scope: string) =>
  browser.evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(scope)})
    if (!root) return null
    const text = root.textContent
    return {
      titles: ['Structured changes endpoint', 'Add skills autocomplete', 'README parallel-agents tagline', 'Bump zod to v4', 'Sync merged PR issues']
        .filter((title) => text.includes(title)),
      headings: [...root.querySelectorAll('h2, h3')].map((h) => h.textContent.trim())
        .filter((label) => ['Needs you', 'Working', 'Recent', 'Pinned', 'Archived'].includes(label)),
      tabs: root.querySelectorAll('[role="tab"], [role="tablist"]').length
        + [...root.querySelectorAll('button')].filter((b) => /^(Active|Archived)\s*\d*$/.test(b.textContent.trim())).length,
      search: [...root.querySelectorAll('button, input')]
        .filter((el) => /search/i.test(el.textContent + ' ' + (el.getAttribute('aria-label') ?? '') + ' ' + (el.getAttribute('placeholder') ?? ''))).length,
    }
  })()`) as { titles: string[]; headings: string[]; tabs: number; search: number } | null

const NO_PANEL = { titles: [], headings: [], tabs: 0, search: 0 }

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xezar-e2e-'))
  mkdirSync(join(dataRoot, '.local/xezar'), { recursive: true })
  writeFileSync(join(dataRoot, '.local/xezar/runs.json'), JSON.stringify(FIXTURE, null, 2), 'utf8')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [xezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    // Dry-run + a pinned XEZ_HOME, exactly as the shared test env does — see `fixtureServeEnv`.
    // Nothing in this spec starts a run, but the boot probes the backends.
    env: fixtureServeEnv(dataRoot),
    stdio: 'ignore',
  })
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(runId)
  browser.setViewport(1440, 900)
}, 90_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  await removeDataRoot(dataRoot)
})

describe('the sidebar is navigation only, with real runs to list (#546)', () => {
  beforeAll(() => {
    browser.setViewport(1440, 900)
    browser.goto(`${baseUrl}${scoped('/')}`)
    // The table is the proof the runs arrived: the sidebar is asserted empty of them only after.
    browser.waitForFunction(`document.querySelectorAll('[data-slot="task-table-row"]').length > 0`)
  })

  it('serves the fixture through the real API', async () => {
    // The store parsed and kept every record: if the shape were wrong, zod would have dropped the
    // index and every absence below would be asserting against an empty list that "passes" nothing.
    const runs = (await fetch(`${baseUrl}/api/v1/runs`).then((r) => r.json())) as Array<{ id: string }>
    expect(runs.map((r) => r.id).sort()).toEqual(
      ['fix-archived', 'fix-done', 'fix-failed', 'fix-review-pr', 'fix-var-a', 'fix-var-b'].sort()
    )
  })

  it('lists no task, bucket, Active/Archived tab or Search launcher in the desktop sidebar', () => {
    expect(panelLeftovers('aside')).toEqual(NO_PANEL)
    // …and it is still the navigation it always was, with the unread badge on Tasks (#399
    // unchanged): the two finished fixture runs were never opened.
    expect(browser.count('aside nav[aria-label="Main"] a')).toBeGreaterThan(3)
    expect(
      browser.evaluate(
        `[...document.querySelectorAll('aside nav[aria-label="Main"] [role="status"]')].map((el) => el.textContent).filter(Boolean)`
      )
    ).toContain('2 unread finished tasks')

    browser.screenshot(`${artifactsDir}/sidebar-navigation-only-1440.png`, { viewport: true })
  })

  it('opens the command palette from the keyboard, with no sidebar control to click', () => {
    browser.press('Control+k')
    browser.waitForFunction(`document.querySelector('[role="dialog"] input') === document.activeElement`)
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('[role="dialog"]') === null`)
  })

  it('shows the same navigation-only content in the phone drawer', () => {
    browser.setViewport(390, 844)
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="task-card"]').length > 0`)
    browser.click('button[aria-label="Open menu"]')
    // Settled, not merely mounted: the drawer slides in, and a click aimed at a link that is still
    // moving lands on the backdrop, which dismisses the drawer instead of navigating.
    browser.waitForFunction(
      `(() => { const d = document.querySelector('[role="dialog"]'); return !!d && d.querySelector('nav[aria-label="Main"]') !== null && d.getBoundingClientRect().left === 0 && d.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity) })()`
    )

    expect(panelLeftovers('[role="dialog"]')).toEqual(NO_PANEL)
    // The drawer still navigates: Git from the drawer lands on Git and closes it.
    browser.screenshot(`${artifactsDir}/sidebar-navigation-only-drawer-390.png`, { viewport: true })
    browser.click('[role="dialog"] nav[aria-label="Main"] a[href$="/git"]')
    browser.waitForFunction(`location.pathname === '${scoped('/git')}'`)
    browser.waitForFunction(`document.querySelector('[role="dialog"]') === null`)
    browser.setViewport(1440, 900)
  })
})

/**
 * The Tasks table overview (Step 3.4) — the same fixture server, through the real `/` home.
 *
 * Same deliberate limitation as above: every fixture status is terminal, so the live/queued
 * columns cannot be exercised here (a serve boot recovers non-terminal runs). Those are covered
 * by the jsdom suite (`src/routes/tasks-overview.test.tsx`), which drives the components with
 * queued/running records and a stubbed usage stream directly.
 */
describe('tasks table overview', () => {
  const TABLE_ROW = '[data-slot="task-table-row"]'

  beforeAll(() => {
    browser.setViewport(1440, 900)
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelectorAll('${TABLE_ROW}').length > 0`)
  })

  it('is the home: the table renders every active fixture run with its status', () => {
    const rows = browser.evaluate(`[...document.querySelectorAll('${TABLE_ROW}')].map((tr) => ({
      id: tr.dataset.runId,
      status: tr.querySelector('[data-slot="pill"]').textContent,
    }))`) as Array<{ id: string; status: string }>

    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      'fix-review-pr': 'needs review',
      'fix-var-a': 'needs review',
      'fix-var-b': 'needs review',
      'fix-done': 'done',
      'fix-failed': 'failed',
    })
    // Needs-you first, history after — `sortRuns`' status weight.
    expect(rows.slice(0, 3).map((r) => r.id).sort()).toEqual(['fix-review-pr', 'fix-var-a', 'fix-var-b'])
    expect(rows.slice(3).map((r) => r.id)).toEqual(['fix-done', 'fix-failed'])

    // A spot check across the columns: tokens formatted, the PR chip numbered and pointed out —
    // and the Task cell shows the auto-summary, never the raw fixture title behind it.
    const reviewRow = browser.evaluate(`(() => {
      const tr = document.querySelector('${TABLE_ROW}[data-run-id="fix-review-pr"]')
      const pr = tr.querySelector('[data-slot="pr-chip"]')
      return { text: tr.textContent, prHref: pr.href, prTarget: pr.target }
    })()`) as { text: string; prHref: string; prTarget: string }
    expect(reviewRow.text).toContain('128.4k')
    expect(reviewRow.text).toContain('Structured changes endpoint for the git view')
    expect(reviewRow.text).not.toContain('add a structured changes endpoint plz')
    expect(reviewRow.prHref).toBe('https://github.com/qodeca/xezar/pull/396')
    expect(reviewRow.prTarget).toBe('_blank')

    browser.screenshot(`${artifactsDir}/tasks-table.png`)
  })

  it('fills the ± column where a run recorded a diff, and keeps the honest dash where none exists', () => {
    // Column 7 is ± (Status | Task | Workflow | Tool Name | Model | Branch | ±) — read it for
    // every row at once. Positional on purpose: it pins the table's column ORDER as well as the
    // cell's content, which a `data-column-id` selector would stop doing.
    const diffs = browser.evaluate(`Object.fromEntries(
      [...document.querySelectorAll('${TABLE_ROW}')].map((tr) => [
        tr.dataset.runId,
        tr.querySelector('td:nth-child(7)').textContent,
      ])
    )`) as Record<string, string>

    expect(diffs).toEqual({
      'fix-review-pr': '+128 −14',
      'fix-var-a': '—', // no diffStat on these fixture records — nothing is fabricated
      'fix-var-b': '—',
      'fix-done': '+9 −2',
      'fix-failed': '—',
    })
  })

  it('offers the compare strip for the finished variant group', () => {
    expect(browser.text('[data-slot="compare-strip"]')).toContain('Add skills autocomplete to composer')
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="compare-strip"] a[href$="/compare/fix-group-1"]').getAttribute('href')`
      )
    ).toBe(scoped('/compare/fix-group-1'))
  })

  it('switches the table to Archived from the header tabs, and back', () => {
    browser.click('[data-slot="overview-tab"][data-view="archived"]')
    browser.waitForFunction(`document.querySelector('${TABLE_ROW}[data-run-id="fix-archived"]') !== null`)
    expect(browser.count(TABLE_ROW)).toBe(1)
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="overview-tab"][data-view="archived"]').getAttribute('aria-pressed')`
      )
    ).toBe('true')

    browser.click('[data-slot="overview-tab"][data-view="active"]')
    browser.waitForFunction(`document.querySelector('${TABLE_ROW}[data-run-id="fix-review-pr"]') !== null`)
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="overview-tab"][data-view="active"]').getAttribute('aria-pressed')`
      )
    ).toBe('true')
    expect(browser.count(`${TABLE_ROW}[data-run-id="fix-archived"]`)).toBe(0)
  })

  it('opens the task from a row click', () => {
    browser.click(`${TABLE_ROW}[data-run-id="fix-done"]`)
    browser.waitForFunction(`location.pathname === '${scoped('/tasks/fix-done')}'`)
    expect(browser.url()).toContain(scoped('/tasks/fix-done'))
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelectorAll('${TABLE_ROW}').length > 0`)
  })

  it('renames a task inline from its row — the hover pencil, committed by Enter, stored for real', async () => {
    const row = `${TABLE_ROW}[data-run-id="fix-failed"]`
    // The pencil is a hover affordance (mockup `.task-title .pencil`): produce a real pointer.
    browser.hover(row)
    browser.click(`${row} [data-slot="row-rename"]`)
    browser.waitForFunction(`document.querySelector('${row} [data-slot="title-input"]') !== null`)
    // Viewport mode: a full-page capture scrolls the document, and this shot exists to show the
    // open editor exactly as the user sees it.
    browser.screenshot(`${artifactsDir}/tasks-table-row-edit.png`, { viewport: true })

    browser.fill(`${row} [data-slot="title-input"]`, 'Bump zod to v4 — second attempt')
    browser.press('Enter')

    // The readback, twice over. First the UI: the PATCH invalidates `runs`, the refetched list
    // re-renders the row under its new name and the editor is gone.
    browser.waitForFunction(
      `document.querySelector('${row}').textContent.includes('Bump zod to v4 — second attempt')`
    )
    expect(browser.count(`${row} [data-slot="title-input"]`)).toBe(0)

    // Then the record: the server stored the edit as BOTH title and the displayed summary
    // (an edit must beat any past or future auto-summary).
    const runs = (await fetch(`${baseUrl}/api/v1/runs`).then((r) => r.json())) as Array<{
      id: string
      title: string
      titleSummary?: string
    }>
    const renamed = runs.find((r) => r.id === 'fix-failed')
    expect(renamed?.title).toBe('Bump zod to v4 — second attempt')
    expect(renamed?.titleSummary).toBe('Bump zod to v4 — second attempt')
  })

  it('reflows to cards plus a New-task FAB at phone width, with no horizontal overflow', () => {
    browser.setViewport(390, 844)
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="task-card"]').length > 0`)

    expect(browser.count('[data-slot="task-card"]')).toBe(5)
    expect(browser.isVisible('[data-slot="new-task-fab"]')).toBe(true)
    expect(
      browser.evaluate(`document.querySelector('[data-slot="new-task-fab"]').getAttribute('href')`)
    ).toBe(scoped('/new'))
    // The table is the desktop framing — at phone width the cards replace it, not join it.
    expect(
      browser.evaluate(`getComputedStyle(document.querySelector('[data-slot="tasks-table"]')).display`)
    ).toBe('none')
    // Nothing forces the page wider than the phone.
    expect(browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true)
    expect(
      browser.evaluate(`(() => {
        const main = document.querySelector('[data-slot="main"]')
        return main.scrollWidth <= main.clientWidth
      })()`)
    ).toBe(true)

    browser.screenshot(`${artifactsDir}/tasks-cards-mobile.png`)
    browser.setViewport(1440, 900)
  })
})
