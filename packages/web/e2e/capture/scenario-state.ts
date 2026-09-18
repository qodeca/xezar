import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'

import type { AgentBrowser } from '../agent-browser'
import type { GuideBrowser } from '../guide-browser'
import { api, DEMO_PROJECT, DOCS_PROJECT, waitForStatus, type Cockpit, type Json } from './cockpit'
import { editPrimaryCheckout, editWorktree } from './fixture-repo'
import type { Theme, Width } from './manifest'

/**
 * The one seeded workspace and the one set of per-state visible-fact assertions behind BOTH the
 * docs capture harness (`docs-screenshots.capture.ts`, which shoots pixels) and the browser-test
 * package's `screenshot-states.e2e.ts` (which asserts facts and shoots nothing) — browser-test-spec.md
 * § "Screenshot-state reconciliation": "semantic assertions belong beside the authoritative capture
 * preparation and should be consumed by a thin new test", never re-implemented.
 *
 * Every `Scenario` below is that authoritative preparation: the same navigation/wait/click steps
 * the capture harness has always run (data-slot selectors, unchanged — those existed long before
 * this file and are not a new locator design), plus, immediately before the state would be
 * captured, `expect(...)` calls that name the state's visible facts using ONLY an ARIA role with
 * an accessible name, an associated accessible label, or literal visible text (browser-test-spec.md
 * § Locator rule) — never a class, id, `data-*` attribute or other selector coupled to markup.
 *
 * Both callers share ONE `GuideBrowser` session with their own `AgentBrowser` (same `--session`
 * id, two thin clients over the same agent-browser session), so the semantic assertions below see
 * exactly the page the CSS-selector waits already navigated to.
 */

export type { Theme, Width }

export interface ScenarioContext {
  cockpit: Cockpit
  browser: AgentBrowser
  guide: GuideBrowser
  /** Ids of the seeded runs, by role — populated once by `seedScenario`. */
  runs: Record<string, string>
  groupId: string
}

export type Scenario = (ctx: ScenarioContext, theme: Theme, width: Width) => Promise<void> | void

export const demo = (path: string) => `/p/${DEMO_PROJECT}${path}`

// ---- seeding --------------------------------------------------------------------------------

async function createRun(cockpit: Cockpit, body: Json, project = DEMO_PROJECT): Promise<string> {
  const run = await api(cockpit, 'POST', `/p/${project}/runs`, body)
  return String(run.id)
}

const runPath = (id: string, project = DEMO_PROJECT) => `/p/${project}/runs/${id}`

async function settleDone(cockpit: Cockpit, id: string, project = DEMO_PROJECT): Promise<void> {
  await waitForStatus(cockpit, runPath(id, project), ['waiting'])
  await api(cockpit, 'POST', `${runPath(id, project)}/finish`)
  const parked = await waitForStatus(cockpit, runPath(id, project), ['review', 'done'])
  if (parked.status === 'review') {
    await api(cockpit, 'POST', `${runPath(id, project)}/finish`)
    await waitForStatus(cockpit, runPath(id, project), ['done'])
  }
}

/**
 * Wait until a live run is waiting again with its change measured. The stored change size is
 * written at the end of a turn, so a file count is the signal that the turn which made the
 * change has finished — a bare status poll can read the "waiting" from before the turn started.
 */
async function waitForChange(cockpit: Cockpit, id: string, files: number): Promise<void> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const run = await api(cockpit, 'GET', runPath(id))
    if (run.status === 'waiting' && (run.diffStat as { files?: number } | undefined)?.files === files) return
    if (Date.now() > deadline) throw new Error(`xezar capture: ${id} never measured its ${files}-file change`)
    await new Promise((r) => setTimeout(r, 400))
  }
}

/** A still of the page the running task screenshots: a checkout summary with both dates fixed. */
export function renderCheckoutAsset(cockpit: Cockpit, browser: AgentBrowser): void {
  const html = join(cockpit.dataRoot, 'assets', 'checkout.html')
  writeFileSync(
    html,
    `<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; font: 15px/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; background: #f6f4ef; color: #1d1c1a; }
      header { display: flex; align-items: center; justify-content: space-between; padding: 9px 20px; background: #1d1c1a; color: #f6f4ef; }
      header b { font-size: 17px; letter-spacing: .02em; } header span { opacity: .7; font-size: 13px; }
      main { display: grid; grid-template-columns: 1fr 200px; gap: 16px; padding: 14px 20px; }
      h1 { margin: 0 0 8px; font-size: 16px; } .card { background: #fff; border-radius: 8px; padding: 6px 12px; box-shadow: 0 1px 2px rgba(0,0,0,.06); font-size: 12.5px; }
      .row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #eee; } .row:last-child { border: 0; }
      .muted { color: #6f6b64; } .ok { color: #2f7d4f; font-weight: 600; } button { width: 100%; margin-top: 8px; padding: 7px; border: 0; border-radius: 6px; background: #2f7d4f; color: #fff; font-size: 13px; font-weight: 600; }
    </style></head><body>
      <header><b>demo-shop</b><span>Checkout · step 3 of 3</span></header>
      <main>
        <section><h1>Order summary</h1><div class="card">
          <div class="row"><span>Ceramic table lamp × 2</span><span>€118.00</span></div>
          <div class="row"><span class="muted">Order date</span><span class="ok">15 Sep 2026</span></div>
          <div class="row"><span class="muted">Estimated delivery</span><span class="ok">18 Sep 2026</span></div>
          <div class="row"><span class="muted">Card</span><span>•••• 4242 · expires 09/28</span></div>
        </div></section>
        <aside class="card"><div class="row"><span>Subtotal</span><span>€118.00</span></div><div class="row"><span>Shipping</span><span>€4.90</span></div><div class="row"><b>Total</b><b>€122.90</b></div><button>Place order</button></aside>
      </main></body></html>`,
    'utf8',
  )
  browser.setViewport(600, 228)
  browser.goto(`file://${html}`)
  browser.waitForFunction(`document.readyState === 'complete'`)
  const shot = browser.screenshot(join(cockpit.dataRoot, 'assets', 'checkout-raw.png'), { viewport: true })
  writeFileSync(join(cockpit.dataRoot, 'assets', 'checkout.png'), readFileSync(shot))
}

/** The full seeded workspace both callers need: every task status, a variant pair, a review-gate
 *  run, a second project, an inbox, an automation and a second agent account. Verbatim from the
 *  0.15.0 capture plan — trimming it would mean two fixtures answering "what does tasks-list show"
 *  differently, which is exactly the drift the shared module exists to prevent. */
export async function seedScenario(cockpit: Cockpit, browser: AgentBrowser): Promise<{ runs: Record<string, string>; groupId: string }> {
  const runs: Record<string, string> = {}
  let groupId = ''

  renderCheckoutAsset(cockpit, browser)

  // The tasks list shows every backend: each task names its own runner, and the scripted agents
  // in `agents/` play each one its own turn (`agents/scenarios.mjs`).
  // Finished work first, oldest first, so the list reads like a real afternoon.
  runs.failed = await createRun(cockpit, { task: 'Upgrade the payment SDK to v5', workflow: 'quick-task', runner: 'claude' })
  await waitForStatus(cockpit, runPath(runs.failed), ['failed'])

  runs.doneA = await createRun(cockpit, { task: 'Add a dark-mode toggle to the site header', workflow: 'quick-task', runner: 'codex' })
  await settleDone(cockpit, runs.doneA)
  runs.doneB = await createRun(cockpit, { task: 'Fix the rounding error in the cart total', workflow: 'quick-task', runner: 'pi' })
  await settleDone(cockpit, runs.doneB)

  // Two variants of one task that went two different ways, both parked at review: the compare view.
  const variants = await api<{ runs: Array<{ id: string; groupId: string; variant?: string }> }>(
    cockpit,
    'POST',
    `/p/${DEMO_PROJECT}/runs`,
    { task: 'Speed up the product search query', workflow: 'quick-task', variants: 2, runner: 'claude' },
  )
  groupId = variants.runs[0]?.groupId ?? ''
  const [variantA, variantB] = [...variants.runs].sort((x, y) => String(x.variant).localeCompare(String(y.variant)))
  runs.variantA = variantA!.id
  runs.variantB = variantB!.id
  const directions: Array<[string, string, number]> = [
    [runs.variantA, 'Add a trigram index on products.name.', 1],
    [runs.variantB, 'Cache the search results in memory instead.', 3],
  ]
  for (const [id] of directions) await waitForStatus(cockpit, runPath(id), ['waiting'])
  for (const [id, text, files] of directions) {
    await api(cockpit, 'POST', `${runPath(id)}/messages`, { text })
    await waitForChange(cockpit, id, files)
    await api(cockpit, 'POST', `${runPath(id)}/finish`)
    await waitForStatus(cockpit, runPath(id), ['review'])
  }

  // The review-gate task: a real multi-file change in its worktree, parked at review.
  runs.review = await createRun(cockpit, { task: 'Fix the login redirect that drops the session cookie', workflow: 'quick-task', runner: 'claude' })
  const reviewRun = await waitForStatus(cockpit, runPath(runs.review), ['waiting'])
  editWorktree(String(reviewRun.worktreePath ?? reviewRun.worktree))
  // The stored change size is measured at the end of a turn, so the edit only reaches the task
  // list and the thread header after one more turn.
  await api(cockpit, 'POST', `${runPath(runs.review)}/messages`, { text: 'Also cover the redirect with a regression test.' })
  await waitForChange(cockpit, runs.review, 3)
  await api(cockpit, 'POST', `${runPath(runs.review)}/finish`)
  await waitForStatus(cockpit, runPath(runs.review), ['review'])

  // A task that explored and then asked a question: "needs you" in the list.
  runs.ask = await createRun(cockpit, { task: 'Pick a date library for the checkout', workflow: 'explore-then-ask', runner: 'claude' })
  await waitForStatus(cockpit, runPath(runs.ask), ['waiting'])

  // The second project for All tasks: its own runs (seeded before the long runs fill the workspace-wide slots), then unregistered again so every other
  // capture shows the single-project shell most people run.
  await api(cockpit, 'POST', '/projects', { root: cockpit.docsRoot })
  runs.docs = await createRun(cockpit, { task: 'Document the new pricing API', workflow: 'quick-task', runner: 'pi' }, DOCS_PROJECT)
  await settleDone(cockpit, runs.docs, DOCS_PROJECT)
  // Terminal only: a project with a live task cannot be unregistered.
  runs.docsFailed = await createRun(cockpit, { task: 'Fix broken links in the getting-started guide', workflow: 'quick-task', runner: 'codex' }, DOCS_PROJECT)
  await waitForStatus(cockpit, runPath(runs.docsFailed, DOCS_PROJECT), ['failed'])
  await api(cockpit, 'DELETE', `/projects/${DOCS_PROJECT}`)

  // Two tasks genuinely running (their agents hold the turn open) fill both slots; two more queue
  // behind them. The first one is the thread the task-thread shots show.
  runs.running = await createRun(cockpit, { task: 'Standardise date handling across checkout', workflow: 'quick-task', runner: 'claude' })
  runs.runningB = await createRun(cockpit, { task: 'Add rate limiting to the public API', workflow: 'quick-task', runner: 'codex' })
  for (const id of [runs.running, runs.runningB]) await waitForStatus(cockpit, runPath(id), ['running'])
  runs.queuedA = await createRun(cockpit, { task: 'Write the release notes for 1.5.0', workflow: 'quick-task', runner: 'pi' })
  runs.queuedB = await createRun(cockpit, { task: 'Refresh the README screenshots', workflow: 'quick-task', runner: 'claude' })
  await waitForStatus(cockpit, runPath(runs.queuedB), ['queued'])

  // Inbox: three follow-ups a team would actually leave, tied to real seeded tasks.
  writeFileSync(
    join(cockpit.demoRoot, '.local/xezar/todos.json'),
    `${JSON.stringify(
      [
        { id: 'todo-1', ts: new Date().toISOString(), taskId: runs.doneA, summary: 'Add the dark-mode toggle to the mobile menu as well', suggestedPrompt: 'Add the dark-mode toggle to the mobile navigation menu', runnable: true },
        { id: 'todo-2', ts: new Date().toISOString(), taskId: runs.doneB, summary: 'Cover the cart total with a property-based test', suggestedSkill: 'write-tests', suggestedPrompt: 'Add a property-based test for cartTotal', runnable: true },
        { id: 'todo-3', ts: new Date().toISOString(), taskId: runs.review, summary: 'Rotate the session signing secret in staging before release', action: 'Rotate the secret in the staging dashboard', runnable: false },
      ],
      null,
      2,
    )}\n`,
    'utf8',
  )

  // Automations: one scheduled GitHub watch, enabled.
  const automation = await api(cockpit, 'POST', demo('/automations'), {
    name: 'Triage new bug reports',
    events: ['issue.opened'],
    intervalSeconds: 300,
    filters: { lookbackDays: 7, maxRecords: 25 },
    task: { prompt: 'Triage {{github.url}} and propose a fix', workflow: 'quick-task' },
    enable: true,
  })
  expect(JSON.stringify(automation)).toContain('Triage new bug reports')

  // Agent accounts: a second Claude login.
  const accountDir = join(cockpit.home, '.claude-work')
  mkdirSync(accountDir, { recursive: true })
  await api(cockpit, 'POST', '/workspace/agent-profiles', { provider: 'claude', label: 'Work', configDir: accountDir })

  await api(cockpit, 'PUT', '/workspace/ui-state', { taskTable: { expandedColumns: { model: false, cost: false, cpu: false, memory: false } } })

  return { runs, groupId }
}

// ---- shared per-state lifecycle helpers ------------------------------------------------------

/** The `all-tasks` state needs a second registered, tagged project only while it captures/asserts. */
export async function withAllTasksProjects<T>(cockpit: Cockpit, fn: () => Promise<T> | T): Promise<T> {
  await api(cockpit, 'POST', '/projects', { root: cockpit.docsRoot })
  await api(cockpit, 'PATCH', `/projects/${DEMO_PROJECT}`, { tags: ['storefront'] })
  await api(cockpit, 'PATCH', `/projects/${DOCS_PROJECT}`, { tags: ['docs'] })
  try {
    return await fn()
  } finally {
    await api(cockpit, 'DELETE', `/projects/${DOCS_PROJECT}`)
  }
}

/** Every other state shows the default density; only `settings-appearance-roomy` changes it. */
export async function resetAppearance(cockpit: Cockpit): Promise<void> {
  await api(cockpit, 'PUT', '/workspace/ui-state', { appearance: {} })
}

// ---- navigation/wait helpers (unchanged from the 0.15.0 capture plan; also reused, unmodified,
// by the capture harness's own tour recording, which has no per-state semantic assertions) -----

export function wait(browser: AgentBrowser, js: string): void {
  browser.waitForFunction(js)
}

export const exists = (selector: string) => `document.querySelector(${JSON.stringify(selector)}) !== null`

/** The theme is per browser (localStorage `xez-theme`) and pre-paints on load, so set it and
 *  then load the page fresh. */
export function openPage(browser: AgentBrowser, baseUrl: string, path: string, theme: Theme): void {
  browser.evaluate(`localStorage.setItem('xez-theme', ${JSON.stringify(theme)})`)
  browser.goto(`${baseUrl}${path}`)
  wait(browser, `document.documentElement.classList.contains('light') === ${theme === 'light'}`)
}

function open(ctx: ScenarioContext, path: string, theme: Theme): void {
  openPage(ctx.browser, ctx.cockpit.baseUrl, path, theme)
}

export async function settle(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/**
 * Scroll the thread until `selector` clears the reply composer, which floats over the bottom of
 * the thread — `scrollIntoView` alone leaves an end-of-thread control underneath it.
 */
export function scrollAboveComposer(browser: AgentBrowser, selector: string): void {
  const target = `document.querySelector(${JSON.stringify(selector)})`
  const limit = `((document.querySelector('[data-slot="composer"]')?.getBoundingClientRect().top ?? innerHeight) - 24)`
  browser.evaluate(`(() => {
    const node = ${target}
    let scroller = node.parentElement
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && getComputedStyle(scroller).overflowY !== 'visible')) {
      scroller = scroller.parentElement
    }
    scroller.scrollTop += node.getBoundingClientRect().bottom - ${limit}
    return true
  })()`)
  wait(browser, `${target}.getBoundingClientRect().bottom <= ${limit} + 1`)
}

// ---- scenarios: the authoritative preparation, with its visible-fact assertions --------------

export const SCENARIOS: Record<string, Scenario> = {
  'tasks-list': (ctx, theme, width) => {
    open(ctx, demo('/'), theme)
    wait(ctx.browser, width === 375 ? exists('[data-slot="task-card"]') : exists('[data-slot="task-table-row"]'))
    wait(ctx.browser, exists('[data-slot="compare-strip"]'))
    wait(ctx.browser, exists('[data-slot="queue-note"]'))

    const rows: Array<[string, string]> = [
      ['Upgrade the payment SDK to v5', 'failed'],
      ['Add a dark-mode toggle to the site header', 'done'],
      ['Fix the login redirect that drops the session cookie', 'needs review'],
      ['Standardise date handling across checkout', 'running'],
      ['Write the release notes for 1.5.0', 'queued'],
    ]
    for (const [name, status] of rows) {
      expect(ctx.guide.hasRole('link', name), `xezar screenshot-states: tasks-list row "${name}" missing`).toBe(true)
      expect(ctx.guide.hasText(status), `xezar screenshot-states: tasks-list status "${status}" missing`).toBe(true)
    }
    expect(ctx.guide.hasText('variants finished'), 'xezar screenshot-states: tasks-list variant group missing').toBe(true)
    expect(ctx.guide.hasRole('link', 'Compare'), 'xezar screenshot-states: tasks-list Compare link missing').toBe(true)
  },

  'task-thread': async (ctx, theme, width) => {
    // A RUNNING task: its earlier tool calls folded into a streak (opened here), a command with
    // its output, the screenshot the agent took, and the end-to-end run still in progress.
    open(ctx, demo(`/tasks/${ctx.runs.running}`), theme)
    wait(ctx.browser, exists('[data-slot="tool-streak"]'))
    wait(ctx.browser, `[...document.querySelectorAll('img[data-slot="thread-image"]')].some((img) => img.naturalWidth > 0)`)
    ctx.browser.evaluate(`document.querySelector('[data-slot="tool-streak"] button').click()`)
    wait(ctx.browser, exists('[data-slot="tool-streak"][data-state="open"]'))
    // One command opened on its output: the test run the agent just made.
    ctx.browser.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('npm test -- checkout')).click()`)
    wait(ctx.browser, `document.body.textContent.includes('Tests  10 passed (10)')`)
    await settle(300)
    // Scroll the opened streak to the top of the thread, so the tool calls and their results fill
    // the shot and the screenshot follows below them.
    ctx.browser.evaluate(`(() => {
      const node = document.querySelector('[data-slot="tool-streak"]')
      let scroller = node.parentElement
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight && getComputedStyle(scroller).overflowY !== 'visible')) {
        scroller = scroller.parentElement
      }
      const header = document.querySelector('[data-slot="run-header"]')?.getBoundingClientRect().bottom ?? 0
      scroller.scrollTop += node.getBoundingClientRect().top - header - ${width === 375 ? 12 : 16}
      return true
    })()`)
    await settle(300)

    expect(ctx.guide.hasRole('heading', 'Standardise date handling across checkout'), 'xezar screenshot-states: task-thread run title missing').toBe(true)
    expect(ctx.guide.hasText('running'), 'xezar screenshot-states: task-thread run state missing').toBe(true)
    expect(ctx.guide.hasRole('button', 'earlier tool call'), 'xezar screenshot-states: task-thread tool streak missing').toBe(true)
    expect(ctx.guide.hasText('Tests  10 passed (10)'), 'xezar screenshot-states: task-thread command output missing').toBe(true)
    expect(ctx.guide.hasRole('button', 'Open preview of'), 'xezar screenshot-states: task-thread image preview affordance missing').toBe(true)
  },

  'task-changes': (ctx, theme) => {
    open(ctx, demo(`/tasks/${ctx.runs.review}/changes`), theme)
    wait(ctx.browser, exists('[data-slot="diff-file"][data-path="src/auth/session.ts"]'))
    wait(ctx.browser, exists('[data-slot="changes-tree"]'))

    expect(ctx.guide.hasRole('navigation', 'Changed files'), 'xezar screenshot-states: task-changes tree missing').toBe(true)
    expect(ctx.guide.hasRole('button', 'src/auth/session.ts'), 'xezar screenshot-states: task-changes session.ts row missing').toBe(true)
    expect(ctx.guide.hasRole('button', 'test/auth/session.test.ts'), 'xezar screenshot-states: task-changes test file row missing').toBe(true)
    expect(ctx.guide.hasText('signedCookies'), 'xezar screenshot-states: task-changes diff content missing').toBe(true)
    expect(ctx.guide.hasText('files changed'), 'xezar screenshot-states: task-changes stat missing').toBe(true)
  },

  'compare-variants': (ctx, theme) => {
    open(ctx, demo(`/compare/${ctx.groupId}`), theme)
    wait(ctx.browser, `document.querySelectorAll('[data-slot="variant-column"]').length === 2`)

    expect(ctx.guide.hasRole('heading', 'Speed up the product search query'), 'xezar screenshot-states: compare-variants heading missing').toBe(true)
    expect(ctx.guide.hasText('db/migrations/0042_products_name_trgm.sql'), 'xezar screenshot-states: variant A missing').toBe(true)
    expect(ctx.guide.hasText('src/search/cache.ts'), 'xezar screenshot-states: variant B missing').toBe(true)
    expect(ctx.guide.hasText('Pick this one'), 'xezar screenshot-states: compare-variants pick action missing').toBe(true)
  },

  'new-task': (ctx, theme, width) => {
    open(ctx, demo('/new'), theme)
    wait(ctx.browser, exists('[data-slot="version-chip"]'))
    wait(ctx.browser, `!document.querySelector('[data-slot="source-pill"]')?.textContent.includes('…')`)
    wait(ctx.browser, `document.querySelector('[data-slot="model-pill"]') !== null && !document.querySelector('[data-slot="model-pill"]').disabled`)
    ctx.browser.fill('[data-slot="composer"] textarea', 'Add a "Remember me" option to the login form')

    // The route's own heading — verified against the real DOM rather than the plan's assumed
    // "New task" heading, which does not exist here (that string is the sidebar's own "New task"
    // link, a different element with a different accessible role).
    expect(ctx.guide.hasRole('heading', 'What should the agent work on?'), 'xezar screenshot-states: new-task heading missing').toBe(true)
    expect(ctx.guide.hasRole('checkbox', 'Worktree'), 'xezar screenshot-states: new-task Worktree control missing').toBe(true)
    expect(ctx.guide.hasRole('checkbox', 'Autonomous'), 'xezar screenshot-states: new-task Autonomous control missing').toBe(true)

    // On a phone the open picker covers the Worktree and Autonomous toggles, so the phone shot
    // shows the toggles and the desktop shots show the picker.
    if (width === 375) {
      wait(ctx.browser, exists('[data-slot="worktree-toggle"][aria-checked="true"]'))
      return
    }
    ctx.browser.click('[data-slot="source-pill"]')
    wait(ctx.browser, exists('[data-slot="source-option"][data-source-kind="workflow"][data-source-ref="ship-a-fix"]'))
    expect(ctx.guide.hasRole('option', 'ship-a-fix'), 'xezar screenshot-states: new-task workflow option missing').toBe(true)
  },

  'review-gate': async (ctx, theme) => {
    open(ctx, demo(`/tasks/${ctx.runs.review}`), theme)
    wait(ctx.browser, exists('[data-slot="review-draft-pr"]'))
    // The panel's diff loads after the panel itself and pushes the actions down: settle first.
    wait(ctx.browser, `document.querySelectorAll('[data-slot="review-panel"] [data-slot="diff-file"]').length === 3`)
    await settle(800)
    scrollAboveComposer(ctx.browser, '[data-slot="review-draft-pr"]')

    expect(ctx.guide.hasRole('region', 'Review the changes'), 'xezar screenshot-states: review panel missing').toBe(true)
    expect(ctx.guide.hasRole('button', 'Draft PR'), 'xezar screenshot-states: Draft PR action missing').toBe(true)
  },

  'all-tasks': async (ctx, theme) => {
    open(ctx, '/tasks?group=tag', theme)
    wait(ctx.browser, `document.querySelectorAll('section[data-slot="task-group"]').length >= 2`)

    expect(ctx.guide.hasRole('heading', 'All tasks'), 'xezar screenshot-states: all-tasks heading missing').toBe(true)
    expect(ctx.guide.hasText('demo-shop'), 'xezar screenshot-states: all-tasks demo-shop attribution missing').toBe(true)
    expect(ctx.guide.hasText('docs-site'), 'xezar screenshot-states: all-tasks docs-site attribution missing').toBe(true)
  },

  'repo-git': (ctx, theme) => {
    // Uncommitted work in the primary checkout, as a developer mid-change would have it: the
    // header carries the status, the Commits tab the history.
    editPrimaryCheckout(ctx.cockpit.demoRoot)
    open(ctx, demo('/git/commits'), theme)
    wait(ctx.browser, exists('[data-slot="repo-header"]'))
    wait(ctx.browser, `document.body.textContent.includes('feat(shop): header, product search and checkout dates')`)

    expect(ctx.guide.hasText('main'), 'xezar screenshot-states: repo-git branch missing').toBe(true)
    expect(ctx.guide.hasRole('link', 'Commits'), 'xezar screenshot-states: repo-git Commits tab missing').toBe(true)
    expect(
      ctx.guide.hasRole('link', 'feat(shop): header, product search and checkout dates'),
      'xezar screenshot-states: repo-git commit row missing',
    ).toBe(true)
  },

  'github-issues': (ctx, theme) => {
    open(ctx, demo('/github'), theme)
    wait(ctx.browser, exists('[data-slot="gh-row"]'))
    ctx.browser.click(`[data-slot="gh-tabs"] a[href="${demo('/github')}"]`)
    wait(ctx.browser, exists('[data-slot="gh-row"][data-number]'))
    ctx.browser.evaluate(`document.querySelector('[data-slot="gh-row"][data-number]').click()`)
    wait(ctx.browser, exists('[data-slot="gh-hand"]'))
    // The hand-to-agent block, with its start action, fully on screen. `+ 1`: the same sub-pixel
    // tolerance `scrollAboveComposer` below already uses — `scrollIntoView` can leave the block a
    // fraction of a pixel past `innerHeight` (observed: 800.078125 vs 800), which is not a real
    // overflow.
    ctx.browser.evaluate(`document.querySelector('[data-slot="gh-hand"]').scrollIntoView({ block: 'end' })`)
    wait(ctx.browser, `document.querySelector('[data-slot="gh-hand"]').getBoundingClientRect().bottom <= innerHeight + 1`)

    expect(ctx.guide.hasRole('link', 'Issues'), 'xezar screenshot-states: github-issues list missing').toBe(true)
    expect(ctx.guide.hasRole('button', 'Run agent on this issue'), 'xezar screenshot-states: github-issues hand-off action missing').toBe(true)
  },

  automations: (ctx, theme) => {
    // The list, not the log: under XEZ_DRY_RUN no check can reach GitHub, so a log page would
    // honestly read "No checks have run yet".
    open(ctx, demo('/automations'), theme)
    wait(ctx.browser, `document.body.textContent.includes('Triage new bug reports')`)

    expect(ctx.guide.hasRole('heading', 'Triage new bug reports'), 'xezar screenshot-states: automation card missing').toBe(true)
    expect(ctx.guide.hasText('Enabled'), 'xezar screenshot-states: automation enabled state missing').toBe(true)
    expect(ctx.guide.hasRole('button', 'Pause'), 'xezar screenshot-states: automation Pause control missing').toBe(true)
  },

  inbox: (ctx, theme) => {
    open(ctx, demo('/inbox'), theme)
    wait(ctx.browser, `document.querySelectorAll('[data-slot="todo-card"]').length === 3`)

    for (const summary of [
      'Add the dark-mode toggle to the mobile menu as well',
      'Cover the cart total with a property-based test',
      'Rotate the session signing secret in staging before release',
    ]) {
      expect(ctx.guide.hasText(summary), `xezar screenshot-states: inbox item "${summary}" missing`).toBe(true)
    }
    // "Run"/"Acknowledge" each label more than one card, so this checks presence as visible
    // text rather than a role+name lookup that could match more than one element.
    expect(ctx.guide.hasText('Run'), 'xezar screenshot-states: inbox runnable action missing').toBe(true)
    expect(ctx.guide.hasRole('button', 'Acknowledge'), 'xezar screenshot-states: inbox acknowledge action missing').toBe(true)
  },

  skills: (ctx, theme) => {
    open(ctx, demo('/skills'), theme)
    wait(ctx.browser, exists('[data-slot="skill-row"][data-skill="code-review"]'))
    ctx.browser.click('[data-slot="skill-row"][data-skill="code-review"]')
    wait(ctx.browser, exists('[data-slot="skills-detail"] [data-slot="skill-body"]'))

    expect(ctx.guide.hasRole('link', 'code-review'), 'xezar screenshot-states: skills row missing').toBe(true)
    expect(ctx.guide.hasRole('heading', 'code-review'), 'xezar screenshot-states: skill preview heading missing').toBe(true)
    expect(
      ctx.guide.hasText('Review the current diff for correctness, security and readability before a PR.'),
      'xezar screenshot-states: skill preview description missing',
    ).toBe(true)
  },

  workflows: (ctx, theme) => {
    open(ctx, demo('/workflows/ship-a-fix'), theme)
    wait(ctx.browser, `document.querySelectorAll('[data-slot="wb-step"]').length === 4`)

    expect(ctx.guide.valueOfRole('textbox', 'Workflow name'), 'xezar screenshot-states: workflow name missing').toBe('ship-a-fix')
    // The `tests`/`review` steps carry a `skill:` field, so their rendered titles are the SKILL
    // names ("write-tests"/"code-review"), not "Tests"/"Review" — verified against the real
    // rendering rule rather than the step ids.
    for (const step of ['Reproduce', 'Fix', 'write-tests', 'code-review']) {
      expect(ctx.guide.hasText(step), `xezar screenshot-states: workflow step "${step}" missing`).toBe(true)
    }
  },

  'settings-appearance-roomy': (ctx, theme) => {
    open(ctx, '/settings/global/appearance', theme)
    wait(ctx.browser, exists('[data-slot="appearance-density"] [data-value="roomy"]'))
    ctx.browser.click('[data-slot="appearance-density"] [data-value="roomy"]')
    wait(ctx.browser, `document.documentElement.dataset.density === 'roomy'`)

    expect(ctx.guide.hasRole('radiogroup', 'Density'), 'xezar screenshot-states: density control missing').toBe(true)
    expect(ctx.guide.hasRole('radio', 'Roomy'), 'xezar screenshot-states: Roomy option missing').toBe(true)
  },

  'settings-agents': (ctx, theme) => {
    open(ctx, demo('/settings/agents'), theme)
    wait(ctx.browser, exists('[data-slot="agents-section"]'))
    wait(ctx.browser, exists('[data-slot="agents-base-branch"]'))

    expect(ctx.guide.hasRole('heading', 'Agents'), 'xezar screenshot-states: Agents heading missing').toBe(true)
    expect(ctx.guide.hasRole('combobox', 'Base branch'), 'xezar screenshot-states: base-branch control missing').toBe(true)
  },

  'settings-accounts': (ctx, theme) => {
    open(ctx, '/settings/global/accounts', theme)
    wait(ctx.browser, exists('[data-slot="account-row"]'))
    wait(ctx.browser, `![...document.querySelectorAll('[data-slot="account-status"]')].some((n) => n.textContent.includes('Checking'))`)

    expect(ctx.guide.hasRole('heading', 'Agent accounts'), 'xezar screenshot-states: Agent accounts heading missing').toBe(true)
    // The seeded second login's own config directory, a more specific fact than its plain label.
    expect(ctx.guide.hasText('.claude-work'), 'xezar screenshot-states: second account row missing').toBe(true)
  },

  'settings-resources': (ctx, theme) => {
    open(ctx, '/settings/global/resources', theme)
    wait(ctx.browser, exists('[data-slot="resources-section"]'))

    expect(ctx.guide.hasRole('heading', 'Resources'), 'xezar screenshot-states: Resources heading missing').toBe(true)
    expect(ctx.guide.hasRole('combobox', 'Max parallel tasks'), 'xezar screenshot-states: resource limit control missing').toBe(true)
  },

  // Shot for the first time in 0.16.0 (#453 B8). Waits for a real registered row, not only the
  // section, because an empty table is exactly the picture that would hide G-30 — the sideways
  // scroll below `md` only happens once there are rows to squeeze. The registered-projects table
  // sits below the fold on a phone (two settings fields precede it), so the row is scrolled into
  // view before the shot — otherwise the 375-wide capture would show the prose above the table
  // instead of the table the state exists to picture.
  'settings-projects': (ctx, theme, width) => {
    open(ctx, '/settings/global/projects', theme)
    wait(ctx.browser, exists('[data-slot="projects-section"]'))
    wait(ctx.browser, exists('[data-slot="project-row"]'))
    if (width === 375) {
      ctx.browser.evaluate(`document.querySelector('[data-slot="project-row"]').scrollIntoView({ block: 'center' })`)
      wait(ctx.browser, `document.querySelector('[data-slot="project-row"]').getBoundingClientRect().top >= 0`)
    }

    expect(ctx.guide.hasRole('heading', 'Projects'), 'xezar screenshot-states: Projects heading missing').toBe(true)
    expect(ctx.guide.hasRole('table', 'Projects registered in this workspace'), 'xezar screenshot-states: projects table missing').toBe(true)
    expect(ctx.guide.hasRole('rowheader', 'demo-shop'), 'xezar screenshot-states: registered project row missing').toBe(true)
  },

  'settings-mcp-connection': (ctx, theme) => {
    open(ctx, demo('/settings/mcp-connection'), theme)
    wait(ctx.browser, exists('[data-slot="mcp-connection-section"] [data-slot="mcp-leader"]'))
    // The leader status and its Attach control, not only the setup prose above them.
    ctx.browser.evaluate(`document.querySelector('[data-slot="mcp-leader"]').scrollIntoView({ block: 'center' })`)
    wait(ctx.browser, `document.querySelector('[data-slot="mcp-leader"]').getBoundingClientRect().bottom <= innerHeight`)

    expect(ctx.guide.hasRole('heading', 'Connection status'), 'xezar screenshot-states: MCP connection heading missing').toBe(true)
    expect(ctx.guide.hasRole('button', 'Attach leader'), 'xezar screenshot-states: Attach leader control missing').toBe(true)
  },

  'command-palette': (ctx, theme) => {
    open(ctx, demo('/'), theme)
    wait(ctx.browser, exists('[data-slot="task-table-row"]'))
    ctx.browser.press('Control+k')
    wait(ctx.browser, `document.querySelector('[cmdk-root]') !== null && document.activeElement?.hasAttribute('cmdk-input')`)

    expect(ctx.guide.hasRole('dialog', 'Command palette'), 'xezar screenshot-states: command palette dialog missing').toBe(true)
    expect(
      ctx.guide.hasPlaceholder('Search projects, tasks, views, actions, skills…'),
      'xezar screenshot-states: command palette search box missing',
    ).toBe(true)
  },
}
