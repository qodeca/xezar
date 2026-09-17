import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, fixtureServeEnv, readTestEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'
import record from './fixtures/subagents-run.record.json'

/**
 * Design-debt batch B4 in a real browser — task lists, pins, chips and pills (#453, AC-4 / T-4 and
 * the shared AC-0 matrix).
 *
 * `packages/web/src/design-debt-b4.test.tsx` pins the class contracts, row navigation, the
 * clipboard helper and the byte formatter in jsdom. This file is the browser half: every
 * actionable target on the task surfaces at 375 px, at all four densities, measured from its
 * RENDERED box — a reference chip's `::before` hit area included — with no overlap, no clipping,
 * no invisible touch target and no horizontal page overflow. Open states are measured too: a
 * facet filter's list, the `+N`
 * reference list, the prompt-template menu, the rename field, the run header's tabs and the
 * default-agent picker. Separately it holds the 24 px chip floor at every density on a desktop,
 * checks a no-hover tablet, drives a nested pin tap and a card tap, keyboard focus on the table's
 * hover-revealed controls, reduced motion and composited small-text contrast. The "Resolve
 * conflicts" action (`reference-conflict-action`) is measured the same way at every density in
 * light and dark, open and disabled, on the project cards and the global cards, from a conflicting
 * pull request seeded where the cockpit remembers one. (The phone drawer lists no tasks since
 * #546; its navigation targets are measured by design-debt-b2.e2e.ts.)
 *
 * It owns its server over a throwaway data root: it pins a task and changes the density, neither
 * of which may land in the shared environment.
 */

const sessionId = `e2e-b4-${process.pid}`
const densities = ['comfortable', 'roomy', 'compact', 'ultra'] as const
const artifacts = resolve(import.meta.dirname, '../../../.local/qa/b4-captures')
let browser: AgentBrowser
let server: ChildProcess
let root: string
let url: string
let project: string
let emulationSocket: WebSocket | undefined
let emulate: (hover: 'none' | 'hover') => Promise<void>

const NOW = '2026-09-16T12:00:00.000Z'
const LONG = 'A deliberately long task title that must wrap on a phone card without pushing the pin or the age sideways'
const THREAD_ID: string = record.id
const RUNS = [
  { ...record, createdAt: '2026-09-16T08:00:00.000Z', finishedAt: '2026-09-16T08:05:00.000Z', seenAt: NOW },
  {
    ...record,
    id: 'b4-review',
    title: LONG,
    task: LONG,
    status: 'review',
    // No recorded agent session, so its conflict action is the DISABLED one, with its reason.
    steps: record.steps.map((step) => ({ ...step, sessionId: undefined })),
    createdAt: '2026-09-16T09:00:00.000Z',
    pinned: true,
    branch: 'xez/b4-review-with-a-long-branch-name',
    diffStat: { adds: 59514, dels: 12160, files: 40 },
    costUsd: 3.21,
    peakRssBytes: 612 * 1024 ** 2,
    // Three references, so the global row folds two of them into `+2`.
    pullRequestUrl: 'https://github.com/example/repo/pull/7',
    referencedPullRequestUrl: 'https://github.com/example/repo/pull/5',
    referencedIssueUrl: 'https://github.com/example/repo/issues/3',
  },
  {
    ...record,
    id: 'b4-unread',
    title: 'Unread finished task',
    task: 'Unread finished task',
    status: 'done',
    createdAt: '2026-09-16T10:00:00.000Z',
    finishedAt: '2026-09-16T10:30:00.000Z',
    issueNumber: 12,
    referencedIssueUrl: 'https://github.com/example/repo/issues/12',
    // A session to resume, so its conflict action is the ENABLED one.
    pullRequestUrl: 'https://github.com/example/repo/pull/9',
  },
  { ...record, id: 'b4-var-a', groupId: 'b4-group', variant: 'A', title: 'Variant task (A)', task: 'Variant task', createdAt: '2026-09-16T07:00:00.000Z', finishedAt: '2026-09-16T07:10:00.000Z', seenAt: NOW },
  { ...record, id: 'b4-var-b', groupId: 'b4-group', variant: 'B', title: 'Variant task (B)', task: 'Variant task', runner: 'codex', createdAt: '2026-09-16T07:00:00.000Z', finishedAt: '2026-09-16T07:12:00.000Z', seenAt: NOW },
  { ...record, id: 'b4-archived', title: 'An archived task', task: 'An archived task', archived: true, archivedAt: NOW, createdAt: '2026-09-15T07:00:00.000Z', finishedAt: '2026-09-15T07:10:00.000Z', seenAt: NOW },
]

function read<T>(expression: string): T {
  return JSON.parse(browser.evaluate(`JSON.stringify((() => { return (${expression}) })())`) as string) as T
}
function wait(selector: string, settle = true) {
  browser.waitForFunction(`document.querySelector(${JSON.stringify(selector)}) !== null`)
  if (!settle) return
  // Overlays zoom in and the drawer slides: measure only once every finite animation has finished.
  browser.waitForFunction(`document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)`)
}
function waitGone(selector: string) {
  browser.waitForFunction(`document.querySelector(${JSON.stringify(selector)}) === null`)
}
function visit(path: string, ready: string, width = 375, settle = true) {
  browser.setViewport(width, 812)
  browser.goto(`${url}${path}`)
  wait(ready, settle)
}
function density(value: string) {
  visit('/settings/global/appearance', '[data-route="settings-global-appearance"]')
  browser.click(`[data-slot="appearance-density"] [data-value="${value}"]`)
  browser.waitForFunction(`(document.documentElement.dataset.density ?? 'comfortable') === '${value}'`)
  // The PUT must land before the next navigation, or the server's older answer would win.
  browser.waitForFunction(`fetch('/api/v1/workspace/ui-state').then(r => r.json()).then(s => (s.appearance?.density ?? 'comfortable') === '${value}')`)
}

// Every actionable target in the scope, measured from what a finger can hit: the element's box,
// or its painted, centred `::before` hit area when that is larger (the reference chip, the switch).
type Geometry = { targets: string[]; smallest: string; short: string[]; clipped: string[]; overlaps: string[]; invisible: string[]; overflow: boolean; rows: string[] }
function geometry(scope: string, only = '*'): Geometry {
  return read(`(() => {
    const parent = [...document.querySelectorAll(${JSON.stringify(scope)})].find(el => el.getClientRects().length > 0);
    if (!parent) throw new Error('Missing measured surface: ' + ${JSON.stringify(scope)});
    const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[aria-hidden="true"]');
    const nodes = [...parent.querySelectorAll('a[href],button,input,select,textarea,summary,[role="radio"],[role="tab"],[role="switch"],[role="option"],[role="menuitem"]')]
      .filter(visible).filter(el => el.type !== 'hidden').filter(el => el.matches(${JSON.stringify(only)}));
    if (!nodes.length) throw new Error('No interactive targets in ' + ${JSON.stringify(scope)});
    const name = el => (el.dataset.action || (el.dataset.slot && el.dataset.slot !== 'button' ? el.dataset.slot : '') || el.getAttribute('aria-label') || el.tagName.toLowerCase() + ':' + el.textContent.trim().slice(0, 40)) + (el.disabled ? ' (disabled)' : '');
    const box = el => {
      const b = el.getBoundingClientRect(), s = getComputedStyle(el, '::before');
      const painted = s.content !== 'none' && s.display !== 'none' && s.position === 'absolute';
      const w = painted ? parseFloat(s.width) || 0 : 0, h = painted ? parseFloat(s.height) || 0 : 0;
      return { x: b.x - Math.max(0, w - b.width) / 2, y: b.y - Math.max(0, h - b.height) / 2, w: Math.max(b.width, w), h: Math.max(b.height, h) };
    };
    const opacity = el => { let o = 1; for (let p = el; p; p = p.parentElement) o *= Number(getComputedStyle(p).opacity); return o };
    const short = [], clipped = [], overlaps = [], invisible = [];
    let minW = Infinity, minH = Infinity;
    for (const el of nodes) {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const b = box(el);
      minW = Math.min(minW, b.w); minH = Math.min(minH, b.h);
      if (b.w < 43.5 || b.h < 43.5) short.push(name(el) + ': ' + Math.round(b.w * 10) / 10 + ' x ' + Math.round(b.h * 10) / 10);
      if (b.x < -0.5 || b.x + b.w > innerWidth + 0.5) clipped.push(name(el));
      if (opacity(el) < 0.5) invisible.push(name(el));
      for (const other of nodes) {
        if (el === other || el.contains(other) || other.contains(el)) continue;
        const a = box(other);
        if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5) overlaps.push(name(el) + ' / ' + name(other));
      }
    }
    // A row that is wider than its box pushes content out of the drawer or the card.
    const rows = [...parent.querySelectorAll('[data-slot="task-card"],[data-slot="global-task-card"]')]
      .filter(visible).filter(el => el.scrollWidth > el.clientWidth + 0.5).map(el => (el.dataset.runId ?? el.dataset.slot) + ': ' + el.scrollWidth + ' > ' + el.clientWidth);
    return { targets: nodes.map(name), smallest: Math.round(minW * 10) / 10 + ' x ' + Math.round(minH * 10) / 10, short, clipped, overlaps, invisible, rows, overflow: document.documentElement.scrollWidth > innerWidth };
  })()`)
}
function collect(label: string, scope: string, into: string[], seen: Map<string, string>, only?: string) {
  const g = geometry(scope, only)
  seen.set(label, `${g.targets.length} targets, smallest ${g.smallest}`)
  if (g.targets.length === 0) into.push(`${label}: no targets`)
  for (const s of g.short) into.push(`${label}: below 44px: ${s}`)
  for (const s of g.clipped) into.push(`${label}: clipped: ${s}`)
  for (const s of g.overlaps) into.push(`${label}: overlap: ${s}`)
  for (const s of g.invisible) into.push(`${label}: invisible touch target: ${s}`)
  for (const s of g.rows) into.push(`${label}: row overflows: ${s}`)
  if (g.overflow) into.push(`${label}: horizontal page overflow`)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'xezar-e2e-b4-'))
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  execFileSync('git', ['-C', root, '-c', 'user.name=b4', '-c', 'user.email=b4@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture'])
  mkdirSync(join(root, '.xez-home'), { recursive: true })
  mkdirSync(join(root, '.local/xezar/runs'), { recursive: true })
  writeFileSync(join(root, '.local/xezar/runs.json'), JSON.stringify(RUNS, null, 2))
  writeFileSync(join(root, '.local/xezar/runs', `${THREAD_ID}.ndjson`), readFileSync(resolve(import.meta.dirname, 'fixtures/subagents-run.ndjson'), 'utf8'))
  writeFileSync(join(root, '.xez-home/config.json'), JSON.stringify({ projects: [
    { id: 'b4-project', name: 'A long registered project name for the task cards', root, addedAt: NOW, lastOpenedAt: NOW, source: 'local', tags: ['storefront', 'a-rather-long-tag-name'] },
  ] }))
  const port = await new Promise<number>((done, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const a = s.address(); const n = typeof a === 'object' && a ? a.port : 0; s.close(() => done(n)) }) })
  url = `http://localhost:${port}`
  server = spawn(process.execPath, [xezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], { env: fixtureServeEnv(root), stdio: 'ignore' })
  let healthy = false
  for (let n = 0; n < 60; n++) { try { if ((await fetch(`${url}/api/v1/health`)).ok) { healthy = true; break } } catch {} await new Promise((r) => setTimeout(r, 250)) }
  if (!healthy) throw new Error('B4 fixture server did not start')
  project = await bootProjectId(url)
  browser = AgentBrowser.open(sessionId)
  // Touch and no-hover emulation over the provider's own CDP endpoint, kept alive for the suite
  // (device presets alone do not switch `(hover: none)` on) — the B2/B3 recipe.
  const cli = (...args: string[]) => {
    const result = JSON.parse(execFileSync(readTestEnv().browser.command, ['--session', sessionId, ...args, '--json'], { encoding: 'utf8', timeout: 60_000 }))
    if (!result.success) throw new Error('B4 provider command failed')
    return result.data
  }
  // Launched as a hover device. Chrome ignores a `hover` media override, so turning touch
  // emulation off only returns the MACHINE's hover type — and a headless Linux runner has no
  // mouse, so it stays `(hover: none)` there. This setting is re-applied on each page load, while
  // touch emulation still wins over it. One setting only: the provider splits `--args` on commas.
  cli('--args', '--blink-settings=primaryHoverType=2', 'open', url)
  const socket = new WebSocket(cli('get', 'cdp-url').cdpUrl)
  emulationSocket = socket
  await new Promise<void>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error('B4 emulation connection timed out')), 5_000)
    socket.onopen = () => { clearTimeout(timeout); done() }
    socket.onerror = () => { clearTimeout(timeout); fail(new Error('B4 emulation connection failed')) }
  })
  let nextId = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>()
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)), request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result)
  }
  const send = (method: string, params: object, session?: string) => new Promise<any>((done, fail) => {
    const id = ++nextId, timeout = setTimeout(() => { pending.delete(id); fail(new Error('B4 emulation command timed out')) }, 5_000)
    pending.set(id, { resolve: (value) => { clearTimeout(timeout); done(value) }, reject: (error) => { clearTimeout(timeout); fail(error) } })
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))
  })
  const tab = cli('tab', 'list').tabs.find((t: { active: boolean }) => t.active)
  if (!tab) throw new Error('B4 provider has no active page')
  const attached = await send('Target.attachToTarget', { targetId: tab.targetId, flatten: true })
  emulate = async (hover) => {
    await send('Emulation.setTouchEmulationEnabled', { enabled: hover === 'none', maxTouchPoints: 1 }, attached.sessionId)
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: hover }, { name: 'pointer', value: hover === 'none' ? 'coarse' : 'fine' }] }, attached.sessionId)
  }
  await emulate('none')
  browser.setViewport(375, 812)
  mkdirSync(artifacts, { recursive: true })
}, 60_000)
afterAll(async () => { emulationSocket?.close(); browser?.close(); await stopFixtureServer(server); if (root) await removeDataRoot(root) })

/** The matrix, one entry per surface, recorded so the PR can quote what was measured. */
const measured = new Map<string, Map<string, string>>()

describe('B4 phone matrix', () => {
  it.each(densities)('T-4/T-0 every task-list target, card, chip, pin and open list at %s', (value) => {
    density(value)
    expect(read(`innerWidth`)).toBe(375)
    expect(read(`matchMedia('(hover: none)').matches`)).toBe(true)
    const failures: string[] = []
    const seen = new Map<string, string>()

    // The project Tasks page: phone toolbar, cards (pinned, long title, references), compare strip, FAB.
    visit(`/p/${project}/`, '[data-slot="task-card"]')
    collect('project tasks', '[data-route="tasks"]', failures, seen)
    // The archived view, through the phone toolbar's own tab.
    browser.click('[data-slot="tasks-phone-toolbar"] [data-view="archived"]')
    wait('[data-slot="task-card"][data-run-id="b4-archived"]')
    collect('project tasks, archived', '[data-route="tasks"]', failures, seen)
    browser.click('[data-slot="tasks-phone-toolbar"] [data-view="active"]')
    wait('[data-slot="task-card"][data-run-id="b4-review"]')

    // The global Tasks page: toolbar, filters, cards; grouped by project; the archived view.
    visit('/tasks', '[data-slot="global-task-card"]')
    collect('global tasks', '[data-route="global-tasks"]', failures, seen)
    browser.click('[data-slot="group-by"] [data-value="project"]')
    wait('[data-slot="group-project-link"]')
    collect('global tasks, grouped by project', '[data-route="global-tasks"]', failures, seen)
    browser.click('[data-slot="group-by"] [data-value="project"]')
    waitGone('[data-slot="group-project-link"]')

    // A facet filter's list, with one value picked so its Clear action shows.
    browser.click('[data-slot="facet-status"]')
    wait('[data-slot="facet-option"]')
    browser.click('[data-slot="facet-option"]')
    wait('[data-action="facet-status-clear"]')
    collect('status facet list', '[data-slot="popover-content"]', failures, seen)
    browser.click('[data-action="facet-status-clear"]')
    browser.press('Escape'); waitGone('[data-slot="popover-content"]')

    // The `+N` reference list. Opened from the keyboard: the provider's click is a mouse, whose
    // `pointerenter` opens the hover list that the click then toggles shut — a finger does not.
    read(`(() => { const el = document.querySelector('[data-slot="global-task-card"][data-run-id="b4-review"] [data-slot="reference-overflow"]'); el.scrollIntoView({ block: 'center' }); el.focus(); return true })()`)
    browser.press('Enter')
    wait('[data-slot="reference-overflow-list"][data-state="open"]')
    collect('+N reference list', '[data-slot="reference-overflow-list"]', failures, seen)
    browser.press('Escape'); waitGone('[data-slot="reference-overflow-list"]')

    // The archived global view, through the phone toolbar.
    browser.click('[data-slot="global-tasks-phone-toolbar"] [data-view="archived"]')
    wait('[data-slot="global-task-card"][data-run-id="b4-archived"]')
    collect('global tasks, archived', '[data-route="global-tasks"]', failures, seen)
    browser.click('[data-slot="global-tasks-phone-toolbar"] [data-view="active"]')

    // The composer's pills and the prompt-template menu.
    visit(`/p/${project}/new`, '[data-slot="prompt-template-trigger"]')
    // Only this batch's pills: the composer's own Start/Plan switch is B5's (`routes/new-task.tsx`).
    collect('composer pills', '[data-slot="composer"]', failures, seen, '[data-slot$="-pill"], [data-slot="prompt-template-trigger"]')
    browser.click('[data-slot="prompt-template-trigger"]')
    wait('[data-slot="prompt-template-option"]')
    collect('prompt-template menu', '[data-slot="prompt-template-menu"]', failures, seen)
    browser.press('Escape'); waitGone('[data-slot="prompt-template-menu"]')

    // The run header's tabs and its rename field.
    visit(`/p/${project}/tasks/${THREAD_ID}`, '[data-slot="run-tabs"] a[aria-current="page"]')
    collect('run header tabs', '[data-slot="run-tabs"]', failures, seen)
    expect(read<number>(`document.querySelectorAll('[data-slot="run-tabs"] a').length`), 'the four run header tabs').toBe(4)
    // The run header's own pencil is outside this batch (known-gaps G-21); it opens the shared field.
    browser.evaluate(`document.querySelector('[data-slot="run-header"] button[aria-label="Rename task"]').click()`)
    wait('[data-slot="title-input"]')
    const field = read<{ h: number; w: number }>(`(() => { const b = document.querySelector('[data-slot="title-input"]').getBoundingClientRect(); return { h: b.height, w: b.width } })()`)
    seen.set('rename field', `1 target, ${Math.round(field.w * 10) / 10} x ${Math.round(field.h * 10) / 10}`)
    if (field.h < 43.5) failures.push(`rename field: below 44px: ${field.w} x ${field.h}`)
    browser.press('Escape'); waitGone('[data-slot="title-input"]')

    // The default-agent picker (G-29).
    visit(`/p/${project}/settings/agents`, '[data-slot="agents-runner"]')
    collect('default-agent picker', '[data-slot="agents-runner"]', failures, seen)

    measured.set(value, seen)
    expect(failures, `B4 phone matrix at ${value}`).toEqual([])
  }, 300_000)
})

// "Resolve conflicts" needs a pull request the forge calls conflicting, and the dry-run forge
// answers every number with no status at all. So, for this test only, the provider answers the
// one request the chips make — `ref-status` — with what a real forge says about a conflicting PR:
// PR #7 on `b4-review` (no session: the disabled action and its reason) and PR #9 on `b4-unread`
// (a session to resume: the enabled action). Every other reference keeps its no-status answer.
const CONFLICT_ROUTE = '**/github/ref-status*'
const CONFLICT_ANSWER = JSON.stringify({ available: true, prs: { 7: 'review-required', 9: 'review-required' }, issues: {}, conflicts: [7, 9], recheckAfterMs: 600_000 })
function provider(...args: string[]) {
  const result = JSON.parse(execFileSync(readTestEnv().browser.command, ['--session', sessionId, ...args, '--json'], { encoding: 'utf8', timeout: 60_000 }))
  if (!result.success) throw new Error(`B4 provider command failed: ${args[0]} ${args[1]}`)
}
const CONFLICT_CARD = '[data-slot="reference-status-card"][data-state="open"]'
const CONFLICT_ACTION = `${CONFLICT_CARD} [data-slot="reference-conflict-action"]`
const conflictMeasured = new Map<string, Map<string, string>>()

function theme(value: 'light' | 'dark') {
  read(`(() => { localStorage.setItem('xez-theme', '${value}'); return true })()`)
  browser.setMedia(value)
}

/** Opens a conflicting chip's panel from the keyboard (the provider's click is a mouse, see `+N`)
 *  and checks what it says about itself. Returns the failures; the panel is left open. */
function openConflict(chip: string, enabled: boolean): string[] {
  const failures: string[] = []
  wait(chip, false)
  read(`(() => { const el = document.querySelector(${JSON.stringify(chip)}); el.scrollIntoView({ block: 'center' }); el.focus(); return true })()`)
  wait(CONFLICT_ACTION)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(CONFLICT_ACTION)}).disabled === ${!enabled}`)
  const facts = read<{ role: string | null; popup: string | null; expanded: string | null; label: string; reason: string; overlap: boolean; outside: boolean }>(`(() => {
    const chip = document.querySelector(${JSON.stringify(chip)}), card = document.querySelector(${JSON.stringify(CONFLICT_CARD)});
    const button = card.querySelector('[data-slot="reference-conflict-action"]');
    const a = chip.getBoundingClientRect(), b = button.getBoundingClientRect(), c = card.getBoundingClientRect();
    return {
      role: card.getAttribute('role'), popup: chip.getAttribute('aria-haspopup'), expanded: chip.getAttribute('aria-expanded'),
      label: button.textContent.trim(), reason: button.nextElementSibling?.textContent.trim() ?? '',
      overlap: Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5,
      outside: c.left < -0.5 || c.right > innerWidth + 0.5,
    };
  })()`)
  if (facts.role !== 'dialog') failures.push(`${chip}: panel role is ${facts.role}, not dialog`)
  if (facts.popup !== 'dialog' || facts.expanded !== 'true') failures.push(`${chip}: chip announces aria-haspopup=${facts.popup} aria-expanded=${facts.expanded}`)
  if (facts.label !== 'Resolve conflicts') failures.push(`${chip}: action reads "${facts.label}"`)
  if (!enabled && !facts.reason) failures.push(`${chip}: the disabled action does not say why`)
  if (enabled && facts.reason) failures.push(`${chip}: the enabled action carries a refusal: ${facts.reason}`)
  if (facts.overlap) failures.push(`${chip}: the action covers its own chip`)
  if (facts.outside) failures.push(`${chip}: the panel leaves the viewport`)
  for (const s of contrast(CONFLICT_CARD).filter((s) => s.ratio < 4.5)) failures.push(`${chip}: panel text ${s.name} ${s.color} ${s.ratio}:1`)
  return failures
}

function closeConflict() {
  browser.press('Escape')
  waitGone(CONFLICT_CARD)
}

describe('B4 conflict action (B-1)', () => {
  it.each(densities)('T-4/T-0 "Resolve conflicts", open and disabled, in light and dark at %s', (value) => {
    density(value)
    const failures: string[] = []
    const seen = new Map<string, string>()
    provider('network', 'route', CONFLICT_ROUTE, '--body', CONFLICT_ANSWER)
    try {
      for (const scheme of ['light', 'dark'] as const) {
        theme(scheme)
        const panel = (label: string, chip: string, enabled: boolean) => {
          const name = `${label}, ${enabled ? 'open' : 'disabled'} (${scheme})`
          failures.push(...openConflict(chip, enabled).map((f) => `${name}: ${f}`))
          collect(name, CONFLICT_CARD, failures, seen)
        }

        visit(`/p/${project}/`, '[data-slot="task-card"][data-run-id="b4-review"]')
        expect(read(`matchMedia('(hover: none)').matches`)).toBe(true)
        const card = (id: string) => `[data-slot="task-card"][data-run-id="${id}"] [data-slot="pr-chip"][data-conflicting="true"]`
        panel('project card', card('b4-unread'), true)
        // The enabled action is reachable from the chip by Tab, and Escape brings focus back.
        browser.press('Tab')
        browser.waitForFunction(`document.activeElement?.dataset.slot === 'reference-conflict-action'`)
        closeConflict()
        panel('project card', card('b4-review'), false)
        closeConflict()

        visit('/tasks', '[data-slot="global-task-card"][data-run-id="b4-review"]')
        const global = (id: string) => `[data-slot="global-task-card"][data-run-id="${id}"] [data-slot="pr-chip"][data-conflicting="true"]`
        panel('global card', global('b4-unread'), true)
        closeConflict()
        panel('global card', global('b4-review'), false)
        closeConflict()
      }
    } finally {
      theme('light')
      provider('network', 'unroute', CONFLICT_ROUTE)
      // The cockpit remembers answers for the tab's lifetime; forget these so no later test paints
      // a status the dry-run forge never gave.
      read(`(() => { sessionStorage.removeItem('xez.reference-statuses.v1'); sessionStorage.removeItem('xez.reference-conflicts.v1'); return true })()`)
      browser.goto('about:blank')
    }
    conflictMeasured.set(value, seen)
    expect(failures, `conflict action at ${value}`).toEqual([])
  }, 300_000)
})

it('T-4 the chip floor holds at 24 px at every density on a desktop, where 44 px is not asked', async () => {
  const short: string[] = []
  for (const value of densities) {
    density(value)
    visit(`/p/${project}/`, '[data-slot="task-table-row"]', 1280)
    visit(`/p/${project}/`, '[data-slot="task-table-row"]', 1280)
    const chips = (scope: string) => read<string[]>(`[...document.querySelectorAll(${JSON.stringify(scope)})].filter(el => el.getClientRects().length > 0).map(el => ({ n: (el.dataset.slot || el.tagName) + ' ' + el.textContent.trim().slice(0, 20), h: el.getBoundingClientRect().height })).filter(c => c.h < 23.5).map(c => c.n + ': ' + c.h)`)
    short.push(...chips('[data-slot="pr-chip"],[data-slot="issue-chip"]').map((c) => `${value} project: ${c}`))
    visit('/tasks', '[data-slot="global-task-row"]', 1280)
    short.push(...chips('[data-slot="pr-chip"],[data-slot="issue-chip"],[data-slot^="facet-"],[data-slot="tag-filter"]').map((c) => `${value} global: ${c}`))
    // No settle wait: the desktop composer's backdrop animates for longer than any wait allows,
    // and a chip's height does not depend on it.
    visit(`/p/${project}/new`, '[data-slot="prompt-template-trigger"]', 1280, false)
    short.push(...chips('[data-slot="model-pill"],[data-slot="runner-pill"],[data-slot="prompt-template-trigger"]').map((c) => `${value} composer: ${c}`))
    const phoneSized = read<number>(`document.querySelector('[data-slot="prompt-template-trigger"]').getBoundingClientRect().height`)
    expect(phoneSized, `${value}: the desktop chip is not phone-sized`).toBeLessThan(40)
  }
  density('comfortable')
  expect(short).toEqual([])
}, 300_000)

it('G-21 a no-hover tablet shows the table pin and rename as 44 px targets', () => {
  visit(`/p/${project}/`, '[data-slot="task-table-row"]', 1024)
  const controls = read<{ name: string; w: number; h: number; opacity: string }[]>(`[...document.querySelectorAll('[data-slot="task-table-row"][data-run-id="b4-unread"] [data-slot="pin-toggle"], [data-slot="task-table-row"][data-run-id="b4-unread"] [data-slot="row-rename"]')].map(el => { const b = el.getBoundingClientRect(); return { name: el.dataset.slot, w: b.width, h: b.height, opacity: getComputedStyle(el).opacity } })`)
  expect(controls.map((c) => c.name).sort()).toEqual(['pin-toggle', 'row-rename'])
  for (const control of controls) {
    expect(control.opacity, control.name).toBe('1')
    expect(control.w, control.name).toBeGreaterThanOrEqual(43.5)
    expect(control.h, control.name).toBeGreaterThanOrEqual(43.5)
  }
}, 120_000)

it('T-4 a phone pin tap pins the task and leaves the page; a card tap opens the task', () => {
  visit(`/p/${project}/`, '[data-slot="task-card"][data-run-id="b4-unread"]')
  const pin = '[data-slot="task-card"][data-run-id="b4-unread"] [data-slot="pin-toggle"]'
  expect(read(`document.querySelector('${pin}').getAttribute('aria-pressed')`)).toBe('false')
  browser.evaluate(`document.querySelector('${pin}').scrollIntoView({ block: 'center' })`)
  browser.click(pin)
  browser.waitForFunction(`document.querySelector('${pin}')?.getAttribute('aria-pressed') === 'true'`)
  expect(read(`location.pathname`)).toBe(`/p/${project}/`)
  browser.click(pin)
  browser.waitForFunction(`document.querySelector('${pin}')?.getAttribute('aria-pressed') === 'false'`)
  browser.click('[data-slot="task-card"][data-run-id="b4-unread"] [data-slot="task-card-model"]')
  browser.waitForFunction(`location.pathname === '/p/${project}/tasks/b4-unread'`)

  visit('/tasks', '[data-slot="global-task-card"][data-run-id="b4-unread"]')
  const card = '[data-slot="global-task-card"][data-run-id="b4-unread"]'
  browser.evaluate(`document.querySelector('${card}').scrollIntoView({ block: 'center' })`)
  browser.click(`${card} [data-action="mark-read"], ${card} [data-action="mark-unread"]`)
  expect(read(`location.pathname`)).toBe('/tasks')
  browser.click(`${card} [data-slot="global-task-card-model"]`)
  browser.waitForFunction(`location.pathname === '/p/${project}/tasks/b4-unread'`)
}, 120_000)

it('the table reveals pin and rename on keyboard focus, with the focus ring', async () => {
  await emulate('hover')
  try {
    visit(`/p/${project}/`, '[data-slot="task-table-row"]', 1280)
    expect(read(`matchMedia('(hover: none)').matches`)).toBe(false)
    const row = '[data-slot="task-table-row"][data-run-id="b4-unread"]'
    expect(read(`getComputedStyle(document.querySelector('${row} [data-slot="row-rename"]')).opacity`)).toBe('0')
    read(`(() => { document.querySelector('${row} [data-column-id="task"] a').focus(); return true })()`)
    const seen: { slot: string; opacity: string; ring: string }[] = []
    for (let n = 0; n < 2; n++) {
      browser.press('Tab')
      // The reveal is a 150 ms opacity transition.
      browser.waitForFunction(`getComputedStyle(document.activeElement).opacity === '1'`)
      seen.push(read(`(() => { const el = document.activeElement; return { slot: el.dataset.slot ?? el.tagName, opacity: getComputedStyle(el).opacity, ring: getComputedStyle(el).boxShadow } })()`))
    }
    expect(seen.map((s) => s.slot)).toEqual(['row-rename', 'pin-toggle'])
    for (const s of seen) {
      expect(s.opacity, s.slot).toBe('1')
      expect(s.ring, s.slot).not.toBe('none')
    }
    browser.press('Enter')
    browser.waitForFunction(`document.querySelector('${row} [data-slot="pin-toggle"]')?.getAttribute('aria-pressed') === 'true'`)
    expect(read(`location.pathname`)).toBe(`/p/${project}/`)
    browser.press('Enter')
    browser.waitForFunction(`document.querySelector('${row} [data-slot="pin-toggle"]')?.getAttribute('aria-pressed') === 'false'`)
  } finally {
    await emulate('none')
  }
}, 120_000)

it('T-0 effective reduced motion: nothing loops on the task lists', () => {
  browser.setMedia('light', { reducedMotion: true })
  for (const [path, ready] of [[`/p/${project}/`, '[data-slot="task-card"]'], ['/tasks', '[data-slot="global-task-card"]']] as const) {
    visit(path, ready)
    const running = read<string[]>(`document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity).map(a => a.animationName ?? 'animation')`)
    expect(running, `${path} infinite animations under reduced motion`).toEqual([])
  }
  browser.setMedia('light')
}, 120_000)

// Composited contrast through Canvas (the B2/B3 recipe): every ancestor background, the browser's
// own colour parser, genuinely disabled controls exempt.
function contrast(scope: string) {
  return read<{ name: string; color: string; ratio: number }[]>(`(() => {
    const surfaces = [...document.querySelectorAll(${JSON.stringify(scope)})].filter(el => el.getClientRects().length > 0);
    if (!surfaces.length) throw new Error('No contrast surface');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = value => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].map((x, i) => i === 3 ? x / 255 : x) };
    const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
    const lum = c => c.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    return surfaces.flatMap(surface => [...surface.querySelectorAll('*')]).filter(el => el.getClientRects().length && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && !el.closest('[aria-hidden="true"], [disabled], :disabled, [data-disabled]')).map(el => {
      const chain = []; for (let p = el; p; p = p.parentElement) chain.unshift(p);
      let bg = [255, 255, 255]; for (const node of chain) bg = over(rgba(getComputedStyle(node).backgroundColor), bg);
      let fg = rgba(getComputedStyle(el).color); fg = over([...fg.slice(0, 3), fg[3] * chain.reduce((o, n) => o * Number(getComputedStyle(n).opacity), 1)], bg);
      const a = lum(fg), b = lum(bg);
      return { name: (el.closest('[data-slot]')?.dataset.slot ?? '') + ' "' + el.textContent.trim().slice(0, 30) + '"', color: getComputedStyle(el).color, ratio: Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100 };
    });
  })()`)
}

// Light-theme ink tokens already below 4.5:1 as small text, recorded in known-gaps G-23. B4 may
// not change a token (#453: B1 owns them), so these three colours are reported, not passed: any
// OTHER colour below the line still fails, and so does one of these on a dark surface.
const G23_LIGHT_INKS: Record<string, string> = {
  'rgb(16, 185, 129)': '--success',
  'rgb(239, 68, 68)': '--danger',
  'rgb(143, 134, 232)': '--violet',
}

it.each(['light', 'dark'] as const)('small task-list text has composited contrast in %s with both accents', (theme) => {
  const low: string[] = []
  const known = new Set<string>()
  for (const accent of ['lime', 'violet']) {
    visit('/settings/global/appearance', '[data-route="settings-global-appearance"]')
    browser.click(`[data-slot="appearance-accent"] [data-value="${accent}"]`)
    browser.waitForFunction(`(document.documentElement.dataset.accent ?? 'lime') === '${accent}'`)
    read(`(() => { localStorage.setItem('xez-theme', '${theme}'); return true })()`)
    browser.setMedia(theme)
    const samples: { name: string; color: string; ratio: number }[] = []
    visit(`/p/${project}/`, '[data-slot="task-card"]')
    samples.push(...contrast('[data-slot="task-card"], [data-slot="tasks-phone-toolbar"]'))
    browser.screenshot(join(artifacts, `${theme}-${accent}-tasks.png`), { viewport: true })
    visit('/tasks', '[data-slot="global-task-card"]')
    samples.push(...contrast('[data-slot="global-task-card"], [data-slot="global-tasks-phone-toolbar"]'))
    browser.screenshot(join(artifacts, `${theme}-${accent}-global-tasks.png`), { viewport: true })
    expect(samples.length).toBeGreaterThan(0)
    for (const sample of samples.filter((s) => s.ratio < 4.5)) {
      const token = theme === 'light' ? G23_LIGHT_INKS[sample.color] : undefined
      if (token) known.add(`${token} ${sample.name} ${sample.ratio}:1`)
      else low.push(`${accent}: ${sample.name} ${sample.color} ${sample.ratio}:1`)
    }
  }
  writeFileSync(join(artifacts, `contrast-${theme}-known-g23.json`), JSON.stringify([...known].sort(), null, 2))
  expect([...new Set(low)], `${theme} small text below 4.5:1`).toEqual([])
  read(`(() => { localStorage.setItem('xez-theme', 'light'); return true })()`)
  browser.setMedia('light')
}, 240_000)

it('records what the phone matrix measured', () => {
  // Written for the pull request: surface → number of targets measured, per density.
  writeFileSync(join(artifacts, 'matrix.json'), JSON.stringify(Object.fromEntries([...measured].map(([d, m]) => [d, Object.fromEntries(m)])), null, 2))
  writeFileSync(join(artifacts, 'conflict-matrix.json'), JSON.stringify(Object.fromEntries([...conflictMeasured].map(([d, m]) => [d, Object.fromEntries(m)])), null, 2))
  expect(measured.size).toBe(densities.length)
  expect(conflictMeasured.size).toBe(densities.length)
})
