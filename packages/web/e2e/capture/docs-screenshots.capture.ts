import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, removeDataRoot, stopFixtureServer } from '../agent-browser'
import { api, bootCockpit, DEMO_PROJECT, DOCS_PROJECT, waitForStatus, type Cockpit, type Json } from './cockpit'
import { editPrimaryCheckout, editWorktree } from './fixture-repo'
import { decodePng, encodeGif, encodePngPalette, type GifFrame, type RgbaImage } from './image-codec'
import {
  SCREENSHOT_DIR,
  SHOT_MAX_BYTES,
  SHOT_STATES,
  TOUR_FILE,
  TOUR_MAX_BYTES,
  shotFileName,
  type Theme,
  type Width,
} from './manifest'
import { freezeJs, normalizeJs } from './page-scripts'

/**
 * Reproducible 0.15.0 cockpit captures (#448 PR-1b): every still in `manifest.ts`, then the tour
 * GIF, from one dry-run fixture cockpit.
 *
 *   npm run build
 *   npm run capture:screenshots -w @qodeca/xezar-web
 *   npm run capture:screenshots -w @qodeca/xezar-web -- -t tasks-list   # one state
 *
 * Output goes straight to `docs/screenshots/0.15.0/`. Nothing here asserts product behaviour;
 * the `expect`s only refuse to write a picture of the wrong state.
 */

const repoRoot = resolve(import.meta.dirname, '../../../..')
const outDir = resolve(repoRoot, SCREENSHOT_DIR)
const sessionId = `capture-docs-${process.pid}`

const HEIGHT: Record<Width, number> = { 1280: 900, 375: 812 }

let cockpit: Cockpit
let browser: AgentBrowser
let frameDir: string

/** Ids of the seeded runs, by role. */
const runs: Record<string, string> = {}
let groupId = ''

const demo = (path: string) => `/p/${DEMO_PROJECT}${path}`

// ---- seeding --------------------------------------------------------------------------------

async function createRun(body: Json, project = DEMO_PROJECT): Promise<string> {
  const run = await api(cockpit, 'POST', `/p/${project}/runs`, body)
  return String(run.id)
}

const runPath = (id: string, project = DEMO_PROJECT) => `/p/${project}/runs/${id}`

async function settleDone(id: string, project = DEMO_PROJECT): Promise<void> {
  await waitForStatus(cockpit, runPath(id, project), ['waiting'])
  await api(cockpit, 'POST', `${runPath(id, project)}/finish`)
  const parked = await waitForStatus(cockpit, runPath(id, project), ['review', 'done'])
  if (parked.status === 'review') {
    await api(cockpit, 'POST', `${runPath(id, project)}/finish`)
    await waitForStatus(cockpit, runPath(id, project), ['done'])
  }
}

async function seed(): Promise<void> {
  // Finished work first, oldest first, so the list reads like a real afternoon.
  runs.failed = await createRun({ task: 'Upgrade the payment SDK to v5 mock:auth-error', workflow: 'quick-task' })
  await waitForStatus(cockpit, runPath(runs.failed), ['failed'])
  await api(cockpit, 'PATCH', runPath(runs.failed), { title: 'Upgrade the payment SDK to v5' })

  runs.doneA = await createRun({ task: 'Add a dark-mode toggle to the site header', workflow: 'quick-task' })
  await settleDone(runs.doneA)
  runs.doneB = await createRun({ task: 'Fix the rounding error in the cart total', workflow: 'quick-task' })
  await settleDone(runs.doneB)

  // Two variants of one task, both parked at review: the compare view.
  const variants = await api<{ runs: Array<{ id: string; groupId: string }> }>(
    cockpit,
    'POST',
    `/p/${DEMO_PROJECT}/runs`,
    { task: 'Speed up the product search query', workflow: 'quick-task', variants: 2 },
  )
  groupId = variants.runs[0]?.groupId ?? ''
  for (const variant of variants.runs) await waitForStatus(cockpit, runPath(variant.id), ['waiting'])
  for (const variant of variants.runs) {
    await api(cockpit, 'POST', `${runPath(variant.id)}/finish`)
    await waitForStatus(cockpit, runPath(variant.id), ['review'])
  }

  // The review-gate task: a real multi-file change in its worktree, parked at review.
  runs.review = await createRun({ task: 'Fix the login redirect that drops the session cookie', workflow: 'quick-task' })
  const reviewRun = await waitForStatus(cockpit, runPath(runs.review), ['waiting'])
  editWorktree(String(reviewRun.worktreePath ?? reviewRun.worktree))
  // The stored change size is measured at the end of a turn, so the edit only reaches the task
  // list and the thread header after one more turn — without it they read `+1 -0` or `+13 -2`
  // depending on a race with finish.
  await api(cockpit, 'POST', `${runPath(runs.review)}/messages`, { text: 'Also cover the redirect with a regression test.' })
  const deadline = Date.now() + 60_000
  for (;;) {
    const run = await api(cockpit, 'GET', runPath(runs.review))
    if (run.status === 'waiting' && (run.diffStat as { files?: number } | undefined)?.files === 3) break
    if (Date.now() > deadline) throw new Error('xezar capture: the review task never measured its three-file change')
    await new Promise((r) => setTimeout(r, 400))
  }
  await api(cockpit, 'POST', `${runPath(runs.review)}/finish`)
  await waitForStatus(cockpit, runPath(runs.review), ['review'])

  // A task that asked a question: tool calls, a screenshot and XEZ:ASK chips.
  runs.ask = await createRun({ task: 'Standardise date handling across checkout', workflow: 'explore-then-ask' })
  await waitForStatus(cockpit, runPath(runs.ask), ['waiting'])

  // The second project for All tasks: its own runs (seeded before the long runs fill the workspace-wide slots), then unregistered again so every other
  // capture shows the single-project shell most people run.
  await api(cockpit, 'POST', '/projects', { root: cockpit.docsRoot })
  runs.docs = await createRun({ task: 'Document the new pricing API', workflow: 'quick-task' }, DOCS_PROJECT)
  await settleDone(runs.docs, DOCS_PROJECT)
  // Terminal only: a project with a live task cannot be unregistered.
  runs.docsFailed = await createRun({ task: 'Fix broken links in the getting-started guide mock:auth-error', workflow: 'quick-task' }, DOCS_PROJECT)
  await waitForStatus(cockpit, runPath(runs.docsFailed, DOCS_PROJECT), ['failed'])
  await api(cockpit, 'PATCH', runPath(runs.docsFailed, DOCS_PROJECT), { title: 'Fix broken links in the getting-started guide' })
  await api(cockpit, 'DELETE', `/projects/${DOCS_PROJECT}`)

  // Two tasks genuinely running (a long check step) fill both slots; two more queue behind them.
  runs.runningA = await createRun({ task: 'Migrate the cart to the new pricing API', workflow: 'build-and-verify' })
  runs.runningB = await createRun({ task: 'Add rate limiting to the public API', workflow: 'build-and-verify' })
  for (const id of [runs.runningA, runs.runningB]) {
    const deadline = Date.now() + 60_000
    for (;;) {
      const run = await api(cockpit, 'GET', runPath(id))
      const steps = (run.steps ?? []) as Array<{ id?: string; status?: string }>
      if (run.status === 'running' && steps.some((s) => s.id === 'verify' && s.status === 'running')) break
      if (Date.now() > deadline) throw new Error(`xezar capture: ${id} never reached its verify step`)
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  runs.queuedA = await createRun({ task: 'Write the release notes for 1.5.0', workflow: 'quick-task' })
  runs.queuedB = await createRun({ task: 'Refresh the README screenshots', workflow: 'quick-task' })
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
}

// ---- capture --------------------------------------------------------------------------------

function wait(js: string): void {
  browser.waitForFunction(js)
}

const exists = (selector: string) => `document.querySelector(${JSON.stringify(selector)}) !== null`

function open(path: string, theme: Theme): void {
  // The theme is per browser (localStorage `xez-theme`) and pre-paints on load, so set it and
  // then load the page fresh.
  browser.evaluate(`localStorage.setItem('xez-theme', ${JSON.stringify(theme)})`)
  browser.goto(`${cockpit.baseUrl}${path}`)
  wait(`document.documentElement.classList.contains('light') === ${theme === 'light'}`)
}

async function settle(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** Freeze, normalise, shoot the viewport, and keep it inside its budget. */
async function shoot(file: string): Promise<void> {
  browser.evaluate(freezeJs)
  await settle()
  browser.evaluate(normalizeJs(cockpit.dataRoot, cockpit.home))
  const raw = browser.screenshot(join(frameDir, file), { viewport: true })
  const png = readFileSync(raw)
  const bytes: Uint8Array = png.length > SHOT_MAX_BYTES ? encodePngPalette(decodePng(png)) : png
  expect(bytes.length, `${file} is over its ${SHOT_MAX_BYTES} byte budget even as a palette PNG`).toBeLessThanOrEqual(SHOT_MAX_BYTES)
  writeFileSync(join(outDir, file), bytes)
}

/**
 * Scroll the thread until `selector` clears the reply composer, which floats over the bottom of
 * the thread — `scrollIntoView` alone leaves an end-of-thread control underneath it.
 */
function scrollAboveComposer(selector: string): void {
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
  wait(`${target}.getBoundingClientRect().bottom <= ${limit} + 1`)
}

type Prepare = (theme: Theme, width: Width) => Promise<void> | void

const PREPARE: Record<string, Prepare> = {
  'tasks-list': (theme, width) => {
    open(demo('/'), theme)
    wait(width === 375 ? exists('[data-slot="task-card"]') : exists('[data-slot="task-table-row"]'))
    wait(exists('[data-slot="compare-strip"]'))
    wait(exists('[data-slot="queue-note"]'))
  },
  'task-thread': (theme) => {
    open(demo(`/tasks/${runs.ask}`), theme)
    wait(exists('[data-slot="ask-card"][data-resolved="false"]'))
    wait(`[...document.querySelectorAll('img[data-slot="thread-image"]')].every((img) => img.naturalWidth > 0)`)
    // The thread stays pinned to the latest item, which is the question. Scrolling it away would
    // raise the "Jump to latest" pill over the very content the shot is for.
  },
  'task-changes': (theme) => {
    open(demo(`/tasks/${runs.review}/changes`), theme)
    wait(exists('[data-slot="diff-file"][data-path="src/auth/session.ts"]'))
    wait(exists('[data-slot="changes-tree"]'))
  },
  'compare-variants': (theme) => {
    open(demo(`/compare/${groupId}`), theme)
    wait(`document.querySelectorAll('[data-slot="variant-column"]').length === 2`)
  },
  'new-task': (theme, width) => {
    open(demo('/new'), theme)
    wait(exists('[data-slot="version-chip"]'))
    wait(`!document.querySelector('[data-slot="source-pill"]')?.textContent.includes('…')`)
    wait(`document.querySelector('[data-slot="model-pill"]') !== null && !document.querySelector('[data-slot="model-pill"]').disabled`)
    browser.fill('[data-slot="composer"] textarea', 'Add a "Remember me" option to the login form')
    // On a phone the open picker covers the Worktree and Autonomous toggles, so the phone shot
    // shows the toggles and the desktop shots show the picker.
    if (width === 375) {
      wait(exists('[data-slot="worktree-toggle"][aria-checked="true"]'))
      return
    }
    browser.click('[data-slot="source-pill"]')
    wait(exists('[data-slot="source-option"][data-source-kind="workflow"][data-source-ref="ship-a-fix"]'))
  },
  'review-gate': async (theme) => {
    open(demo(`/tasks/${runs.review}`), theme)
    wait(exists('[data-slot="review-draft-pr"]'))
    // The panel's diff loads after the panel itself and pushes the actions down: settle first.
    wait(`document.querySelectorAll('[data-slot="review-panel"] [data-slot="diff-file"]').length === 3`)
    await settle(800)
    scrollAboveComposer('[data-slot="review-draft-pr"]')
  },
  'all-tasks': async (theme) => {
    open('/tasks?group=tag', theme)
    wait(`document.querySelectorAll('section[data-slot="task-group"]').length >= 2`)
  },
  'repo-git': (theme) => {
    // Uncommitted work in the primary checkout, as a developer mid-change would have it.
    rmSync(join(cockpit.demoRoot, 'notes.md'), { force: true })
    editPrimaryCheckout(cockpit.demoRoot)
    open(demo('/git'), theme)
    wait(exists('[data-slot="repo-header"]'))
    wait(exists('[data-slot="repo-changes"]'))
  },
  'github-issues': (theme) => {
    open(demo('/github'), theme)
    wait(exists('[data-slot="gh-row"]'))
    browser.click(`[data-slot="gh-tabs"] a[href="${demo('/github')}"]`)
    wait(exists('[data-slot="gh-row"][data-number]'))
    browser.evaluate(`document.querySelector('[data-slot="gh-row"][data-number]').click()`)
    wait(exists('[data-slot="gh-hand"]'))
  },
  automations: (theme) => {
    // The list, not the log: under XEZ_DRY_RUN no check can reach GitHub, so a log page would
    // honestly read "No checks have run yet".
    open(demo('/automations'), theme)
    wait(`document.body.textContent.includes('Triage new bug reports')`)
  },
  inbox: (theme) => {
    open(demo('/inbox'), theme)
    wait(`document.querySelectorAll('[data-slot="todo-card"]').length === 3`)
  },
  skills: (theme) => {
    open(demo('/skills'), theme)
    wait(exists('[data-slot="skill-row"][data-skill="code-review"]'))
    browser.click('[data-slot="skill-row"][data-skill="code-review"]')
    wait(exists('[data-slot="skills-detail"] [data-slot="skill-body"]'))
  },
  workflows: (theme) => {
    open(demo('/workflows/ship-a-fix'), theme)
    wait(`document.querySelectorAll('[data-slot="wb-step"]').length === 4`)
  },
  'settings-appearance-roomy': (theme) => {
    open('/settings/global/appearance', theme)
    wait(exists('[data-slot="appearance-density"] [data-value="roomy"]'))
    browser.click('[data-slot="appearance-density"] [data-value="roomy"]')
    wait(`document.documentElement.dataset.density === 'roomy'`)
  },
  'settings-agents': (theme) => {
    open(demo('/settings/agents'), theme)
    wait(exists('[data-slot="agents-section"]'))
    wait(exists('[data-slot="agents-base-branch"]'))
  },
  'settings-accounts': (theme) => {
    open('/settings/global/accounts', theme)
    wait(exists('[data-slot="account-row"]'))
    wait(`![...document.querySelectorAll('[data-slot="account-status"]')].some((n) => n.textContent.includes('Checking'))`)
  },
  'settings-resources': (theme) => {
    open('/settings/global/resources', theme)
    wait(exists('[data-slot="resources-section"]'))
  },
  'settings-mcp-connection': (theme) => {
    open(demo('/settings/mcp-connection'), theme)
    wait(exists('[data-slot="mcp-connection-section"] [data-slot="mcp-leader"]'))
  },
  'command-palette': (theme) => {
    open(demo('/'), theme)
    wait(exists('[data-slot="task-table-row"]'))
    browser.press('Control+k')
    wait(`document.querySelector('[cmdk-root]') !== null && document.activeElement?.hasAttribute('cmdk-input')`)
  },
}

// Every other capture shows the default density; only the Roomy shot changes it, and puts it back.
async function resetAppearance(): Promise<void> {
  await api(cockpit, 'PUT', '/workspace/ui-state', { appearance: {} })
}

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true })
  cockpit = await bootCockpit()
  frameDir = join(cockpit.dataRoot, 'frames')
  mkdirSync(frameDir, { recursive: true })
  await seed()
  browser = AgentBrowser.open(sessionId)
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
      const prepare = PREPARE[state.name]
      if (!prepare) throw new Error(`xezar capture: no prepare step for "${state.name}"`)
      for (const [theme, width] of state.variants) {
        if (state.name === 'all-tasks') {
          await api(cockpit, 'POST', '/projects', { root: cockpit.docsRoot })
          await api(cockpit, 'PATCH', `/projects/${DEMO_PROJECT}`, { tags: ['storefront'] })
          await api(cockpit, 'PATCH', `/projects/${DOCS_PROJECT}`, { tags: ['docs'] })
        }
        browser.setViewport(width, HEIGHT[width])
        try {
          await prepare(theme, width)
          await shoot(shotFileName(state.name, theme, width))
        } finally {
          if (state.name === 'all-tasks') await api(cockpit, 'DELETE', `/projects/${DOCS_PROJECT}`)
          if (state.name === 'settings-appearance-roomy') await resetAppearance()
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
      browser.evaluate(normalizeJs(cockpit.dataRoot, cockpit.home))
      const path = browser.screenshot(join(frameDir, `tour-${String(index).padStart(3, '0')}.png`), { viewport: true })
      index += 1
      return decodePng(readFileSync(path))
    }
    const frame = async (delayMs: number) => {
      frames.push({ image: grab(), delayMs })
    }

    browser.setViewport(width, height)
    open(demo('/'), 'dark')
    wait(exists('[data-slot="queue-note"]'))
    await frame(2500)

    // Free both slots so the tour task starts at once, and drop the cancelled tasks so the
    // closing frame shows the tour task beside finished work rather than four cancellations.
    for (const id of [runs.queuedA, runs.queuedB, runs.runningA, runs.runningB]) {
      if (!id) continue
      await api(cockpit, 'POST', `${runPath(id)}/cancel`).catch(() => undefined)
      await waitForStatus(cockpit, runPath(id), ['cancelled', 'failed', 'done'])
      await api(cockpit, 'DELETE', runPath(id))
    }

    open(demo('/new'), 'dark')
    wait(`document.querySelector('[data-slot="model-pill"]') !== null && !document.querySelector('[data-slot="model-pill"]').disabled`)
    const prompt = 'Add a "Remember me" option to the login form'
    for (const cut of [8, 18, 30, prompt.length]) {
      browser.fill('[data-slot="composer"] textarea', prompt.slice(0, cut))
      await frame(cut === prompt.length ? 1800 : 300)
    }
    browser.click('[aria-label="Start task"]')
    wait(`location.pathname.startsWith('${demo('/tasks/')}')`)
    const tourId = String(browser.evaluate(`location.pathname.split('/').pop()`))
    runs.tour = tourId
    wait(exists('[data-slot="run-header"]'))

    // The mock turn takes about two seconds: sample it while it streams, keep each distinct
    // picture once, and give the distinct ones a fixed 2.4 s between them so the GIF's timing
    // does not depend on how fast this machine took the samples.
    const streamed: RgbaImage[] = []
    for (let i = 0; i < 12; i += 1) {
      const sample = grab()
      const last = streamed.at(-1)
      if (!last || !Buffer.from(last.data).equals(Buffer.from(sample.data))) streamed.push(sample)
      if ((await api(cockpit, 'GET', runPath(tourId))).status === 'waiting') break
      await settle(250)
    }
    for (const image of streamed) frames.push({ image, delayMs: Math.round(2400 / streamed.length) })
    await waitForStatus(cockpit, runPath(tourId), ['waiting'])
    wait(exists('[data-slot="composer"] textarea'))
    await settle(600)
    await frame(3500)

    await api(cockpit, 'POST', `${runPath(tourId)}/finish`)
    await waitForStatus(cockpit, runPath(tourId), ['review'])
    wait(exists('[data-slot="review-draft-pr"]'))
    wait(`document.querySelectorAll('[data-slot="review-panel"] [data-slot="diff-file"]').length > 0`)
    await settle(800)
    scrollAboveComposer('[data-slot="review-draft-pr"]')
    await settle(300)
    await frame(3500)

    browser.click('[data-slot="review-draft-pr"]')
    wait(exists('a[data-slot="pr-link"]'))
    // Opening the PR accepts the change, which plays a short celebration over the thread.
    wait(`document.querySelector('[data-slot="accept-celebration"]') === null`)
    await settle(400)
    await frame(3000)

    open(demo('/'), 'dark')
    wait(exists(`[data-slot="task-table-row"] [data-slot="pr-chip"]`))
    await frame(4000)

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
    const readme = `# xezar 0.15.0 cockpit screenshots

Captured from a dry-run cockpit (\`XEZ_DRY_RUN=1\` with a sandboxed \`XEZ_HOME\`, agent CLIs mocked
— no login, no network) with fixture data: a demo project with tasks in every status, a second project for All tasks, three
Inbox follow-ups, one automation and a second Claude login. The data, the viewport and the theme
are fixed, so a re-run produces the same pictures (at most a few anti-aliased pixels apart).

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

What a re-run can still change, and why:

- Values that differ on every run are rewritten to one fixed spelling right before each capture:
  ages and durations, clock times, ISO timestamps, run ids and \`xez/<id8>\` branch suffixes, and
  the temporary workspace path (shown as \`~/code\`, its sandboxed home as \`~\`). Layout is untouched.
- Animations are stopped, and the floating toasts, backdrops and the thread's "Jump to latest"
  pill are hidden, so no capture lands on a random frame.
- The version chip shows the version of the build that ran the capture.
- A still larger than 300 KB would be re-encoded as an 8-bit palette PNG; none needed it at the
  time of writing. The tour's streaming frames are sampled live, so their count can vary; their
  total time is fixed.

## Files

| File | Shows | Theme | Viewport |
| --- | --- | --- | --- |
${rows.join('\n')}
| [\`${TOUR_FILE}\`](${TOUR_FILE}) | A tour: the task list, a new task typed and started, the running thread, review, a draft PR, and the list again | dark | 1280 × 800 |
`
    writeFileSync(join(outDir, 'README.md'), readme)
  })
})
