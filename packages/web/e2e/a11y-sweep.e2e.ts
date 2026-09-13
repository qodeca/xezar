import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

/**
 * Accessibility sweep: every primary view (the same list as ios-sweep.e2e.ts) at a phone width
 * (390) and a desktop width (1440), against the shared dry-run environment. Per view and width
 * one DOM probe reports the facts a screen-reader or keyboard user cannot live without, and the
 * spec asserts them:
 *
 *   1. every visible button, link and input has an accessible name — text, `aria-label`,
 *      `aria-labelledby`, `title`, an associated `<label>` (`for=` or wrapping — a `<button>` is
 *      labelable too, which is how the notifications `Switch` is named), an `alt`-bearing image,
 *      or (text fields only) a `placeholder`;
 *   2. every `<img>` carries an `alt` attribute (empty is fine — that is decorative);
 *   3. the document never scrolls sideways (`scrollWidth <= innerWidth`);
 *   4. at desktop width, a nav-backed route marks its active item `aria-current="page"`
 *      (below `md` the nav lives in a closed drawer, so the fact is reported, not asserted).
 *
 * Then a keyboard walk: up to five Tab presses from the top of the page (fewer if focus leaves the
 * document first — at least three must land), and after each the focused element must show a
 * visible focus ring — a box-shadow (how `focus-visible:ring-*` renders in
 * the shadcn primitives, see src/components/ui/button.tsx) or a real outline. "Real" matters:
 * Tailwind's `outline-hidden` paints `outline: 2px solid transparent`, so `outlineStyle` alone
 * would count an invisible outline as a ring; the probe requires a non-zero, non-transparent one.
 *
 * axe-core is deliberately NOT used. It is not a dependency of this repo, and agent-browser
 * passes `eval` JavaScript as one argv string, which rules out injecting axe's ~550 KB source
 * into the page. Even injected, axe covers roughly 30–40 % of WCAG's success criteria; the
 * probe below targets the checks that catch this cockpit's real regressions (an icon-only
 * button that lost its label, an image without alt, a view that grew a sideways scroll), and
 * the keyboard walk covers what no static rule engine sees.
 *
 * Degradation matrix is the iOS sweep's: `/github` runs only when the live health payload reports
 * the forge available; the forge-off branches are pinned by github.e2e.ts and the unit suites.
 */

const sessionId = `e2e-a11y-${process.pid}`

const WIDTHS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
] as const

/** The one probe: returns a JSON-serialisable report of the four facts. Kept small on purpose —
 *  agent-browser hands it to Chrome as a single argv string. */
const PROBE = `(() => {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
  const text = (el) => (el.textContent || '').trim()
  const byId = (ids) => (ids || '').split(/\\s+/).filter(Boolean)
    .map((id) => { const t = document.getElementById(id); return t ? text(t) : '' }).join(' ').trim()
  const named = (el) => {
    if (el.getAttribute('aria-label')?.trim()) return true
    if (byId(el.getAttribute('aria-labelledby'))) return true
    if (el.getAttribute('title')?.trim()) return true
    if (text(el)) return true
    if (el.querySelector('img[alt]:not([alt=""])')) return true
    if (el.matches('button, input, select, textarea')) {
      if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return true
      if (el.closest('label') && text(el.closest('label'))) return true
    }
    if (el.matches('input, textarea') && el.getAttribute('placeholder')?.trim()) return true
    return false
  }
  const describe = (el) => el.tagName.toLowerCase()
    + (el.id ? '#' + el.id : '') + (el.dataset.slot ? '[data-slot=' + el.dataset.slot + ']' : '')
    + (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\\s+/).slice(0, 3).join('.') : '')
  const controls = [...document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea')]
    .filter(visible)
  return {
    unlabelled: controls.filter((el) => !named(el)).map(describe),
    imagesWithoutAlt: [...document.querySelectorAll('img')].filter((img) => !img.hasAttribute('alt')).map(describe),
    navCurrent: !!document.querySelector('nav [aria-current="page"], [role="navigation"] [aria-current="page"]'),
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }
})()`

/** After a Tab press: what has focus, and whether it shows a ring. */
const FOCUS_PROBE = `(() => {
  const el = document.activeElement
  if (!el || el === document.body) return { tag: 'body', ring: false }
  const cs = getComputedStyle(el)
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0
    && !/^rgba\\(\\d+, \\d+, \\d+, 0\\)$/.test(cs.outlineColor) && cs.outlineColor !== 'transparent'
  const shadow = cs.boxShadow !== 'none'
  return {
    tag: el.tagName.toLowerCase() + (el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label') + ']' : ''),
    ring: outline || shadow,
    outline: cs.outline,
    boxShadow: cs.boxShadow,
  }
})()`

interface ProbeReport {
  unlabelled: string[]
  imagesWithoutAlt: string[]
  navCurrent: boolean
  scrollWidth: number
  innerWidth: number
}

interface FocusReport {
  tag: string
  ring: boolean
  outline?: string
  boxShadow?: string
}

let browser: AgentBrowser
let baseUrl: string
let forgeAvailable = false
let inboxAvailable = false
/** The tasks overview is opened at its SCOPED path: a bare `/` restores the last remembered
 *  location (routes.tsx, `locationToRestore`), which after a thread visit is the thread. */
let bootProject: string
let threadRunId: string

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`)
  if (!res.ok) throw new Error(`xezar e2e: GET ${path} answered ${res.status}`)
  return (await res.json()) as T
}

interface RunRecord {
  id: string
  status: string
  createdAt: string
  archived?: boolean
}

async function waitForStatus(id: string, wanted: string[]): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const record = await api<RunRecord>(`/api/v1/runs/${id}`)
    if (wanted.includes(record.status)) return record.status
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`xezar e2e: run ${id} never reached status "${wanted.join('/')}"`)
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  const health = await api<{
    forge: { available: boolean } | null
    capabilities?: { followups?: boolean }
  }>('/api/v1/health')
  forgeAvailable = health.forge?.available === true
  // The Inbox nav item exists only with the opt-in global inbox (#471) — without it `/inbox`
  // still renders, but no nav item can be current.
  inboxAvailable = health.capabilities?.followups === true
  bootProject = await bootProjectId(baseUrl)

  // Same subject rule as the iOS sweep: an existing run when the env has one, else one dry run
  // started and settled here so no open session is left for another spec to trip over.
  const runs = await api<RunRecord[]>('/api/v1/runs')
  const existing = [...runs]
    .filter((r) => !r.archived)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (existing) {
    threadRunId = existing.id
  } else {
    const created = (await (
      await fetch(`${baseUrl}/api/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'Say hello to the accessibility sweep.', workflow: 'quick-task' }),
      })
    ).json()) as { id: string }
    threadRunId = created.id
    const status = await waitForStatus(threadRunId, ['waiting', 'review', 'done', 'failed'])
    if (status === 'waiting') {
      await fetch(`${baseUrl}/api/v1/runs/${threadRunId}/finish`, { method: 'POST' })
      await waitForStatus(threadRunId, ['review', 'done', 'failed'])
    }
  }

  browser = AgentBrowser.open(sessionId)
}, 180_000)

afterAll(() => {
  browser?.close()
})

interface View {
  slug: string
  path: () => string
  /** Real view content, not the route div — the lazy routes render a skeleton under the same
   *  `data-route`, and probing that would measure the wrong page. */
  ready: string
  /** The route has a sidebar nav item, so `aria-current` is asserted at desktop width. */
  nav: boolean | (() => boolean)
  /** Runs only when the live health payload reports the forge available. */
  forgeGated?: boolean
}

const VIEWS: View[] = [
  { slug: 'tasks', path: () => `/p/${encodeURIComponent(bootProject)}/`, ready: '[data-slot="tasks-table"], [data-slot="task-cards"], [data-slot="tasks-empty"]', nav: true },
  { slug: 'inbox', path: () => '/inbox', ready: '[data-slot="todo-card"], [data-route="inbox"] [data-slot="centered-state"]', nav: () => inboxAvailable },
  { slug: 'git', path: () => '/git', ready: '[data-slot="repo-header"]', nav: true },
  { slug: 'github', path: () => '/github', ready: '[data-slot="gh-header"]', nav: true, forgeGated: true },
  { slug: 'workflows', path: () => '/workflows', ready: '[data-slot="wb-main"]', nav: true },
  { slug: 'settings-appearance', path: () => '/settings/global/appearance', ready: '[data-route="settings-global-appearance"]', nav: false },
  { slug: 'settings-skills', path: () => '/settings/skills', ready: '[data-slot="skill-row"]', nav: false },
  { slug: 'settings-agents', path: () => '/settings/agents', ready: '[data-route="settings-agents"]', nav: false },
  { slug: 'settings-notifications', path: () => '/settings/global/notifications', ready: '[data-route="settings-global-notifications"]', nav: false },
  { slug: 'new', path: () => '/new', ready: '[data-route="new"]', nav: false },
  { slug: 'task-thread', path: () => `/tasks/${threadRunId}`, ready: '[data-slot="thread-dock"]', nav: false },
]

function open(view: View): void {
  browser.goto(baseUrl + view.path())
  browser.waitForFunction(`document.querySelector(${JSON.stringify(view.ready)}) !== null`)
}

describe('accessibility sweep — every primary view at phone and desktop widths', () => {
  for (const size of WIDTHS) {
    describe(`${size.name} (${size.width}×${size.height})`, () => {
      for (const view of VIEWS) {
        it(`${view.slug}: names, alt text, no sideways scroll${view.nav ? ', aria-current' : ''}`, () => {
          if (view.forgeGated && !forgeAvailable) return
          const hasNav = typeof view.nav === 'function' ? view.nav() : view.nav
          browser.setViewport(size.width, size.height)
          open(view)
          const report = browser.evaluate(PROBE) as ProbeReport

          expect(report.unlabelled, `${view.slug} @${size.width}: controls without an accessible name`).toEqual([])
          expect(report.imagesWithoutAlt, `${view.slug} @${size.width}: <img> without alt`).toEqual([])
          expect(report.scrollWidth, `${view.slug} @${size.width}: scrolls sideways`).toBeLessThanOrEqual(report.innerWidth)
          if (hasNav && size.name === 'desktop') {
            expect(report.navCurrent, `${view.slug} @${size.width}: no nav item carries aria-current="page"`).toBe(true)
          }
        })
      }
    })
  }

  describe('keyboard walk', () => {
    for (const size of WIDTHS) {
      it(`${size.name}: five Tab presses from the top of the tasks view each land on an element with a visible focus ring`, () => {
        browser.setViewport(size.width, size.height)
        open(VIEWS[0]!)
        const stops: FocusReport[] = []
        for (let i = 0; i < 5; i += 1) {
          browser.press('Tab')
          const stop = browser.evaluate(FOCUS_PROBE) as FocusReport
          // Focus on `body` means the walk left the document (into the browser chrome): the phone
          // overview with one run has four tabbable stops, so the fifth Tab exits. A short page is
          // not a missing ring; the stops that did land are what the assertion is about.
          if (stop.tag === 'body') break
          stops.push(stop)
        }
        expect(stops.length, `${size.name}: fewer than three focus stops before leaving the document`).toBeGreaterThanOrEqual(3)
        const withoutRing = stops.filter((s) => !s.ring)
        expect(
          withoutRing,
          `${size.name}: focus stops without a visible ring (of ${stops.map((s) => s.tag).join(' → ')})`,
        ).toEqual([])
      })
    }
  })
})
