import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'
import { readSharedProjects, snapshotSharedHome, writeSharedProjects } from './workspace-registry'

/**
 * A real-browser project-switch journey (multi-project verification package, PR 3): one
 * cockpit, two registered scratch projects and a third registered-but-missing one, driven
 * through an actual click rather than a direct URL edit.
 *
 * This is deliberately narrower than `project-groups.e2e.ts`, which already proves the sidebar
 * renders one group per project, scopes each group's nav and persists a collapse. What that file
 * does NOT do is click FROM one project's own page INTO another one's and observe what survives
 * the jump — which is exactly the seam `routes.tsx`'s `<Outlet key={projectId} />` protects
 * (`ProjectScopeRoute`, "React Router keeps the matched child mounted when only this parent
 * param changes"). The existing jsdom regression for that exact seam
 * (`routes.test.tsx`, "remounts the same page and loads its new scope when the project param
 * changes") types a value into the Tasks page's search box, switches project, and asserts the
 * box reset — proof the routed child actually remounted rather than merely re-rendering with a
 * new prop. This file reproduces that same proof with a real click in a real browser, plus the
 * companion journeys the campaign's business-analysis spec named as still missing: a real
 * B-scoped network request following the switch, a cross-project task opening at ITS project
 * from the workspace-wide "All tasks" page (not the one currently in view), and the registered
 * but missing-folder row staying inert alongside two healthy ones.
 *
 * Locators are role/label/text only (`aria-controls`, `aria-label`, `href`, visible text) — this
 * file may not depend on a `data-slot` attribute the UI lane's own files use, because the
 * multi-project test package (issue #548) is scoped to ADD a browser file rather than touch any
 * UI source; a private test hook a future UI change quietly renames would break this file with no
 * component test to explain why. `href` values are asserted here because they are themselves
 * product output — `scopeTo`'s whole job is producing them — not a hook installed for the test.
 */

const repoRoot = resolve(import.meta.dirname, '../../..')
const sessionId = `e2e-project-switching-${process.pid}`
const DESKTOP = { width: 1440, height: 900 }

const PROJECT_A = { id: 'e2e-switch-a', name: 'e2e switch a' }
const PROJECT_B = { id: 'e2e-switch-b', name: 'e2e switch b' }
const MISSING = { id: 'e2e-switch-missing', name: 'e2e switch missing' }

let browser: AgentBrowser
let baseUrl: string
let seedDir: string
let restoreHome: () => void
let runId: string

/** A real (if empty) git repo, so the registry probe answers `ok` rather than `not-git`. No
 *  remote: this file asserts nothing about the GitHub nav item. */
function makeRepo(name: string): string {
  const root = join(seedDir, name)
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore' })
  execFileSync(
    'git',
    ['-C', root, '-c', 'user.name=xezar e2e', '-c', 'user.email=e2e@example.invalid',
     'commit', '-q', '--allow-empty', '-m', 'seed'],
    { stdio: 'ignore' },
  )
  return root
}

async function cockpitJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init)
  return (await response.json()) as T
}

/** A `mock:done` run finishes near-instantly under `XEZ_DRY_RUN=1` — see
 *  `mcp-live-sync.e2e.ts`. `worktree:false` skips branch/worktree creation, which this file has
 *  no use for and which would only add wall-clock to a 60s budget. */
async function createFinishedRun(projectId: string): Promise<string> {
  const created = await cockpitJson<{ id: string }>(`/api/v1/p/${projectId}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workflow: 'quick-task',
      task: 'mock:done a finished task for the project-switching journey',
      worktree: false,
      autonomous: true,
    }),
  })
  const deadline = Date.now() + 20_000
  for (;;) {
    const run = await cockpitJson<{ status: string }>(`/api/v1/p/${projectId}/runs/${created.id}`)
    if (run.status === 'done') return created.id
    if (Date.now() > deadline) {
      throw new Error(`xezar e2e: run ${created.id} in ${projectId} did not finish within 20s`)
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  restoreHome = snapshotSharedHome('config.json')
  seedDir = mkdtempSync(join(tmpdir(), 'xezar-e2e-switch-'))

  const rootA = makeRepo('switch-a')
  const rootB = makeRepo('switch-b')
  writeSharedProjects([
    ...readSharedProjects(),
    { ...PROJECT_A, root: rootA, lastOpenedAt: '2026-07-19T12:00:00Z', source: 'local' },
    { ...PROJECT_B, root: rootB, lastOpenedAt: '2026-07-20T12:00:00Z', source: 'local' },
    // A folder that was never created: the registry probe (`workspace/projects.ts`) reports
    // `status: 'missing'` for a root that does not `stat` as a directory, without ever needing a
    // registered-then-deleted repo.
    {
      ...MISSING,
      root: join(seedDir, 'never-created'),
      lastOpenedAt: '2026-07-18T12:00:00Z',
      source: 'local',
    },
  ])

  // The one task the journey's cross-project leg opens from the workspace-wide "All tasks"
  // page — created directly through the product's own door (`POST /runs`), not by driving the
  // composer, so the 60s budget goes to the switch itself rather than a mock agent turn's UI.
  runId = await createFinishedRun(PROJECT_A.id)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
}, 60_000)

afterAll(() => {
  browser?.close()
  restoreHome?.()
  if (seedDir) rmSync(seedDir, { recursive: true, force: true })
})

/** Every fetch the page issues from this point on, path-only (origin stripped) so an assertion
 *  reads `/api/v1/p/<id>/…` rather than a full URL. Installed on the live page via `evaluate`
 *  rather than a wrapped `agent-browser` network log: this file may not edit `agent-browser.ts`
 *  (an existing e2e file the UI lane's own specs already depend on), and the app's own `fetch`
 *  calls are exactly the product behaviour under test here. */
function captureFetches(): void {
  browser.evaluate(`(() => {
    window.__xezSeenPaths = [];
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      window.__xezSeenPaths.push(url.replace(location.origin, ''));
      return original(input, init);
    };
    return true;
  })()`)
}

function seenPaths(): string[] {
  return browser.evaluate('window.__xezSeenPaths') as string[]
}

const searchInput = 'input[aria-label="Search tasks"]'
const groupToggle = (projectId: string) => `button[aria-controls="project-group-${projectId}"]`
const scopedHref = (projectId: string) => `/p/${projectId}/`

describe('the real-browser project switch journey', () => {
  it(
    'switches from A to B without a reload, then opens a cross-project task at its own project from All tasks',
    () => {
      // --- Open A, and mark this page load so a later full reload would be unmistakable. ---
      browser.goto(`${baseUrl}${scopedHref(PROJECT_A.id)}`)
      browser.waitForFunction(`document.title.includes(${JSON.stringify(PROJECT_A.name)})`)
      browser.waitForFunction(`document.querySelector('${searchInput}') !== null`)

      // A value only the CURRENT route instance would hold — the same proof
      // `routes.test.tsx`'s "remounts the same page…" case uses, reproduced with a real click.
      browser.fill(searchInput, 'stale filter')
      expect(browser.evaluate(`document.querySelector('${searchInput}').value`)).toBe('stale filter')

      captureFetches()

      // --- Switch to B through the sidebar, exactly as a person would. ---
      browser.click(groupToggle(PROJECT_B.id))
      browser.waitForFunction(`${JSON.stringify(groupToggle(PROJECT_B.id))} && document.querySelector(${JSON.stringify(groupToggle(PROJECT_B.id))}).getAttribute('aria-expanded') === 'true'`)
      const bTasksLink = `a[href="${scopedHref(PROJECT_B.id)}"]`
      expect(browser.evaluate(`document.querySelector('${bTasksLink}')?.textContent.trim()`)).toBe('Tasks')
      browser.click(bTasksLink)

      // --- B content: the title (project name) and the URL both name B, with no reload. ---
      browser.waitForFunction(`document.title.includes(${JSON.stringify(PROJECT_B.name)})`)
      expect(browser.url()).toBe(`${baseUrl}${scopedHref(PROJECT_B.id)}`)
      // The regression this whole journey guards: without `<Outlet key={projectId} />`, the same
      // Tasks-page instance survives the param change and keeps A's typed filter. Remounted, the
      // fresh instance starts the search box empty again — B's content, not A's leftover state.
      expect(browser.evaluate(`document.querySelector('${searchInput}').value`)).toBe('')

      // --- B-scoped requests: the switch itself talked to B's own `/api/v1/p/<id>` prefix. ---
      const afterSwitch = seenPaths()
      expect(afterSwitch.some((path) => path.startsWith(`/api/v1/p/${PROJECT_B.id}/`))).toBe(true)

      // --- All tasks returns a cross-project row to ITS OWNER, not to B (the project in view). ---
      const allTasksLink = 'a[href="/tasks"]'
      expect(browser.evaluate(`document.querySelector('${allTasksLink}')?.textContent.trim()`)).toBe('All tasks')
      browser.click(allTasksLink)
      browser.waitForFunction(`document.title === 'All tasks · xezar'`)

      const ownRunHref = `/p/${PROJECT_A.id}/tasks/${runId}`
      const ownRunEndpoint = `/api/v1/p/${PROJECT_A.id}/runs/${runId}`
      browser.waitForFunction(`document.querySelector('a[href="${ownRunHref}"]') !== null`)
      browser.click(`a[href="${ownRunHref}"]`)
      browser.waitForFunction(`document.title.includes(${JSON.stringify(PROJECT_A.name)})`)
      // The title alone can settle from the registry before the thread's own run fetch lands —
      // wait for that fetch by name so the assertion below never races it.
      browser.waitForFunction(`window.__xezSeenPaths.includes(${JSON.stringify(ownRunEndpoint)})`)
      expect(browser.url()).toBe(`${baseUrl}${ownRunHref}`)

      // The thread read its OWN project's scoped endpoint, never the boot-scoped spelling a
      // stale scope would emit (`cross-project-task-navigation.test.tsx` pins the same pair at
      // jsdom level; this is the same regression class with a live browser and a live server).
      const afterOwnTask = seenPaths()
      expect(afterOwnTask).toContain(ownRunEndpoint)
      expect(afterOwnTask).not.toContain(`/api/v1/runs/${runId}`)

      // --- The missing-folder row: present, inert, and honest about why. ---
      const missingRow = browser.evaluate(`(() => {
        const el = [...document.querySelectorAll('[title]')].find((node) => node.title.includes('is gone'));
        return el ? { title: el.title, text: el.textContent.trim() } : null;
      })()`) as { title: string; text: string } | null
      expect(missingRow?.text).toContain('folder not found')
      expect(missingRow?.title).toContain('remove it in Global settings')
      // No expand affordance for it — unlike A and B, it carries no `aria-controls` toggle.
      expect(browser.count(groupToggle(MISSING.id))).toBe(0)
    },
  )
})
