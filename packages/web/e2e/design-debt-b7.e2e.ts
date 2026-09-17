import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, fixtureServeEnv, readTestEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'

/**
 * Design-debt batch B7 in a real browser — the remaining routes and feature panels (#453, AC-7 /
 * T-7 and the shared AC-0 matrix, plus #447 OD-1: GitHub, Compare and Automations on the #424
 * rhythm).
 *
 * `packages/web/src/design-debt-b7.test.tsx` and the co-located route suites pin the contracts and
 * the honest states in jsdom. This file is the browser half, against its own dry-run server over a
 * fixture repository with the Inbox, Automations and the review gate switched on: a project skill,
 * a saved workflow, two follow-ups, one automation and a settled ×2 variant group. It measures every
 * actionable target at 375 px on GitHub (list, an issue with its hand-off, a pull request and its
 * changes), Automations (list, editor, log), Compare, Inbox, New task and its plan review, Skills
 * (list and detail), Workflows, the 404 and the unknown-project page, at all four densities, from
 * the RENDERED box. It also checks that the page title and the body share one gutter on a desktop,
 * that the workflow overwrite confirm is a danger action that Escape cancels, reduced motion, and
 * composited small-text contrast in both themes.
 *
 * Locators are roles, accessible names and visible text, resolved inside the page (`find`), so a
 * renamed class or data attribute does not break the spec and a renamed LABEL does.
 *
 * It owns its server over a throwaway data root: it changes the density, which may not land in the
 * shared environment.
 */

const sessionId = `e2e-b7-${process.pid}`
const densities = ['comfortable', 'roomy', 'compact', 'ultra'] as const
const artifacts = resolve(import.meta.dirname, '../../../.local/qa/b7-captures')
const FLOW = 'b7-flow'
const SKILL = 'b7-skill'
let browser: AgentBrowser
let server: ChildProcess
let root: string
let url: string
let project: string
let groupId: string
let automationId: string
let issueNumber: number
let prNumber: number
let emulationSocket: WebSocket | undefined
let emulate: (hover: 'none' | 'hover') => Promise<void>

// ---- in-page locators: role + accessible name, or visible text ---------------------------------

const FIND = `
  const ROLE = { button: 'button,[role="button"]', link: 'a[href]', dialog: '[role="dialog"],[role="alertdialog"]', textbox: 'textarea,input:not([type]),input[type="text"],input[type="search"]', main: 'main', heading: 'h1,h2', radio: '[role="radio"]' };
  const shown = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const nameOf = el => (el.getAttribute('aria-label') || (el.labels && el.labels[0] ? el.labels[0].textContent : '') || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const matches = (el, name) => name === undefined || (name instanceof RegExp ? name.test(nameOf(el)) : nameOf(el) === name);
  const findAll = (role, name, within = document) => [...within.querySelectorAll(ROLE[role])].filter(shown).filter(el => matches(el, name));
  const find = (role, name, within = document) => { const el = findAll(role, name, within)[0]; if (!el) throw new Error('No ' + role + ' named ' + name); return el };
`
const q = (value: string | RegExp | undefined) => (value === undefined ? 'undefined' : value instanceof RegExp ? value.toString() : JSON.stringify(value))

function read<T>(expression: string): T {
  return JSON.parse(browser.evaluate(`JSON.stringify((() => { ${FIND} return (${expression}) })())`) as string) as T
}
function until(expression: string) {
  browser.waitForFunction(`(() => { ${FIND} try { return Boolean(${expression}) } catch { return false } })()`)
}
function settle() {
  browser.waitForFunction(`document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)`)
}
function visit(path: string, ready: string, width = 375) {
  browser.setViewport(width, 812)
  // Global settings and the unknown-project page live outside this project's scope.
  browser.goto(`${url}${path.startsWith('/settings/global') || path.startsWith('/p/') ? '' : `/p/${project}`}${path}`)
  until(ready)
  settle()
}
function density(value: string) {
  visit('/settings/global/appearance', `document.querySelector('[role="radiogroup"][aria-label="Density"]')`)
  const label = { comfortable: 'Comfortable', roomy: 'Roomy', compact: 'Compact', ultra: 'Compact for real' }[value]!
  read(`(() => { [...document.querySelector('[role="radiogroup"][aria-label="Density"]').querySelectorAll('[role="radio"]')].find(el => nameOf(el) === ${q(label)}).click(); return true })()`)
  browser.waitForFunction(`(document.documentElement.dataset.density ?? 'comfortable') === '${value}'`)
  // The PUT must land before the next navigation, or the server's older answer would win.
  browser.waitForFunction(`fetch('/api/v1/workspace/ui-state').then(r => r.json()).then(s => (s.appearance?.density ?? 'comfortable') === '${value}')`)
}

// ---- geometry (the B5 recipe, with B3's label-owned checkbox) --------------------------------------

type Geometry = { targets: string[]; markdownActions: string[]; smallest: string; short: string[]; clipped: string[]; overlaps: string[]; invisible: string[]; overflow: boolean }
/** Every actionable target inside `scope`, measured from what a finger can hit. A checkbox inside a
 *  `<label>` is measured through that label; a link inside a sentence of rendered Markdown is WCAG
 *  2.5.8's inline exception. Overlap is checked only within one layer. */
function geometry(scope: string): Geometry {
  return read(`(() => {
    const parent = ${scope};
    const visible = el => el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[aria-hidden="true"]');
    const owner = el => (el.matches('input[type="checkbox"],input[type="radio"]') && el.closest('label')) || el;
    const nodes = [...new Set([...parent.querySelectorAll('a[href],button,input,select,textarea,summary,[role="radio"],[role="tab"],[role="switch"],[role="option"],[role="menuitem"]')]
      .filter(visible).filter(el => el.type !== 'hidden' && el.type !== 'file')
      .filter(el => !(el.type === 'checkbox' && el.disabled))
      .filter(el => !(el.closest('[data-streamdown]') && el.parentElement && el.parentElement.textContent.trim() !== el.textContent.trim()))
      .map(owner))];
    // Rendered Markdown's own buttons (code-block and image actions) come from the Markdown library,
    // outside this batch's files: reported separately (known-gaps G-36, G-45), never passed silently.
    const markdownActions = nodes.filter(el => el.tagName === 'BUTTON' && el.closest('[data-streamdown]'));
    for (const el of markdownActions) nodes.splice(nodes.indexOf(el), 1);
    if (!nodes.length) throw new Error('No interactive targets in scope');
    const label = el => (nameOf(el) || el.alt || el.outerHTML.slice(0, 80)).slice(0, 80) + (el.disabled ? ' (disabled)' : '');
    const box = el => {
      const b = el.getBoundingClientRect(), s = getComputedStyle(el, '::before');
      const painted = s.content !== 'none' && s.display !== 'none' && s.position === 'absolute';
      const w = painted ? parseFloat(s.width) || 0 : 0, h = painted ? parseFloat(s.height) || 0 : 0;
      return { x: b.x - Math.max(0, w - b.width) / 2, y: b.y - Math.max(0, h - b.height) / 2, w: Math.max(b.width, w), h: Math.max(b.height, h) };
    };
    const layer = el => { for (let p = el; p; p = p.parentElement) { const pos = getComputedStyle(p).position; if (pos === 'fixed' || pos === 'sticky') return p } return null };
    const opacity = el => { let o = 1; for (let p = el; p; p = p.parentElement) o *= Number(getComputedStyle(p).opacity); return o };
    const short = [], clipped = [], overlaps = [], invisible = [];
    let minW = Infinity, minH = Infinity;
    for (const el of nodes) {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      if (!visible(el)) continue;
      const b = box(el);
      minW = Math.min(minW, b.w); minH = Math.min(minH, b.h);
      if (b.w < 43.5 || b.h < 43.5) short.push(label(el) + ': ' + Math.round(b.w * 10) / 10 + ' x ' + Math.round(b.h * 10) / 10);
      if (b.x < -0.5 || b.x + b.w > innerWidth + 0.5) clipped.push(label(el));
      if (opacity(el) < 0.5 && !el.disabled && !el.querySelector(':disabled')) invisible.push(label(el));
      for (const other of nodes) {
        if (el === other || el.contains(other) || other.contains(el) || layer(el) !== layer(other) || !visible(other)) continue;
        const a = box(other);
        if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5) overlaps.push(label(el) + ' / ' + label(other));
      }
    }
    return { targets: nodes.map(label), markdownActions: markdownActions.map(el => (el.dataset.streamdown || el.getAttribute('aria-label') || el.getAttribute('title') || 'button') + ': ' + Math.round(el.getBoundingClientRect().width) + ' x ' + Math.round(el.getBoundingClientRect().height)), smallest: Math.round(minW * 10) / 10 + ' x ' + Math.round(minH * 10) / 10, short, clipped, overlaps, invisible, overflow: document.documentElement.scrollWidth > innerWidth };
  })()`)
}
function collect(name: string, scope: string, into: string[], seen: Map<string, string>) {
  let g: Geometry
  try { g = geometry(scope) } catch (cause) { into.push(`${name}: ${String((cause as Error).message).match(/Evaluation error: ([^\\\n"]*)/)?.[1] ?? 'measure failed'}`); return }
  seen.set(name, `${g.targets.length} targets, smallest ${g.smallest}`)
  for (const action of g.markdownActions) knownMarkdown.add(`${name}: ${action}`)
  for (const s of g.short) into.push(`${name}: below 44px: ${s}`)
  for (const s of g.clipped) into.push(`${name}: clipped: ${s}`)
  for (const s of new Set(g.overlaps)) into.push(`${name}: overlap: ${s}`)
  for (const s of g.invisible) into.push(`${name}: invisible touch target: ${s}`)
  if (g.overflow) into.push(`${name}: horizontal page overflow`)
}

// ---- server, fixture and browser -------------------------------------------------------------------

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${url}${path}`, init)
  if (!response.ok) throw new Error(`B7: ${init?.method ?? 'GET'} ${path} answered ${response.status}`)
  return (await response.json()) as T
}
async function waitForStatus(id: string, wanted: string[]): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const record = await api<{ status: string }>(`/api/v1/runs/${id}`)
    if (wanted.includes(record.status)) return record.status
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`B7: run ${id} never reached ${wanted.join('/')}`)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'xezar-e2e-b7-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'b7@xezar.test')
  git('config', 'user.name', 'xezar b7')
  mkdirSync(join(root, '.xezar/skills'), { recursive: true })
  mkdirSync(join(root, '.xezar/workflows'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# B7 fixture\n')
  writeFileSync(join(root, `.xezar/skills/${SKILL}.md`), `---\nname: ${SKILL}\ndescription: A project skill the batch seven fixture carries.\n---\n\n# ${SKILL}\n\nFollow the steps.\n`)
  writeFileSync(join(root, `.xezar/workflows/${FLOW}.yaml`), `name: ${FLOW}\ndescription: Batch seven chain.\nskills:\n  - ${SKILL}\n`)
  git('add', '.')
  git('commit', '-qm', 'init')
  git('remote', 'add', 'origin', 'git@github.com:acme/b7-e2e.git')
  mkdirSync(join(root, '.local/xezar'), { recursive: true })
  writeFileSync(join(root, '.local/xezar/todos.json'), JSON.stringify([
    { id: 'b7-run', summary: 'Add a regression test for the flaky parser', suggestedSkill: SKILL, action: 'follow-up' },
    { id: 'b7-note', summary: 'The release notes mention a removed flag', action: 'note' },
  ], null, 2))

  const port = await new Promise<number>((done, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const a = s.address(); const n = typeof a === 'object' && a ? a.port : 0; s.close(() => done(n)) }) })
  url = `http://localhost:${port}`
  server = spawn(process.execPath, [xezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(root, { XEZ_REVIEW_GATE: '1', XEZ_AUTOMATIONS: '1', XEZ_FOLLOWUPS: '1' }),
    stdio: 'ignore',
  })
  let healthy = false
  for (let n = 0; n < 60; n++) { try { if ((await fetch(`${url}/api/v1/health`)).ok) { healthy = true; break } } catch {} await new Promise((r) => setTimeout(r, 250)) }
  if (!healthy) throw new Error('B7 fixture server did not start')
  project = await bootProjectId(url)

  const gh = await api<{ available: boolean; issues: Array<{ number: number }>; prs: Array<{ number: number }> }>('/api/v1/github')
  if (!gh.available || !gh.issues[0] || !gh.prs[0]) throw new Error('B7: the dry-run forge served no issues or pull requests')
  issueNumber = gh.issues[0].number
  prNumber = gh.prs[0].number

  const automation = await api<{ automation: { id: string } }>('/api/v1/automations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Triage new issues', events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Triage {{github.url}}', workflow: 'quick-task' } }),
  })
  automationId = automation.automation.id

  // A settled ×2 variant group (the variants-compare.e2e.ts recipe).
  const created = await api<{ runs: Array<{ id: string; groupId: string }> }>('/api/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'Improve the batch seven notes.', workflow: 'quick-task', variants: 2 }),
  })
  groupId = created.runs[0]!.groupId
  for (const run of created.runs) await waitForStatus(run.id, ['waiting'])
  for (const run of created.runs) {
    await fetch(`${url}/api/v1/runs/${run.id}/finish`, { method: 'POST' })
    await waitForStatus(run.id, ['review', 'done'])
  }

  browser = AgentBrowser.open(sessionId)
  const cli = (...args: string[]) => {
    const result = JSON.parse(execFileSync(readTestEnv().browser.command, ['--session', sessionId, ...args, '--json'], { encoding: 'utf8', timeout: 60_000 }))
    if (!result.success) throw new Error('B7 provider command failed')
    return result.data
  }
  // Launched as a hover device, then touch emulation switches `(hover: none)` on (the B4 recipe).
  cli('--args', '--blink-settings=primaryHoverType=2', 'open', url)
  const socket = new WebSocket(cli('get', 'cdp-url').cdpUrl)
  emulationSocket = socket
  await new Promise<void>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error('B7 emulation connection timed out')), 5_000)
    socket.onopen = () => { clearTimeout(timeout); done() }
    socket.onerror = () => { clearTimeout(timeout); fail(new Error('B7 emulation connection failed')) }
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
    const id = ++nextId, timeout = setTimeout(() => { pending.delete(id); fail(new Error('B7 emulation command timed out')) }, 5_000)
    pending.set(id, { resolve: (value) => { clearTimeout(timeout); done(value) }, reject: (error) => { clearTimeout(timeout); fail(error) } })
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))
  })
  const tab = cli('tab', 'list').tabs.find((t: { active: boolean }) => t.active)
  if (!tab) throw new Error('B7 provider has no active page')
  const attached = await send('Target.attachToTarget', { targetId: tab.targetId, flatten: true })
  emulate = async (hover) => {
    await send('Emulation.setTouchEmulationEnabled', { enabled: hover === 'none', maxTouchPoints: 1 }, attached.sessionId)
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: hover }, { name: 'pointer', value: hover === 'none' ? 'coarse' : 'fine' }] }, attached.sessionId)
  }
  await emulate('none')
  browser.setViewport(375, 812)
  mkdirSync(artifacts, { recursive: true })
}, 240_000)
afterAll(async () => { emulationSocket?.close(); browser?.close(); await stopFixtureServer(server); if (root) await removeDataRoot(root) })

const MAIN = `find('main')`
const PLAN = `document.querySelector('[data-slot="plan-review"]')`
const measured = new Map<string, Map<string, string>>()
const knownMarkdown = new Set<string>()

/** Open the plan review from /new: Plan first, a task, Plan task (the plan-mode.e2e.ts recipe). */
function openPlanReview(width = 375) {
  visit('/new', `find('radio', 'Plan first')`, width)
  read(`(() => { find('radio', 'Plan first').click(); return true })()`)
  until(`find('radio', 'Plan first').getAttribute('aria-checked') === 'true'`)
  browser.fill('[data-slot="composer"] textarea', 'Tighten the flaky suite end to end.')
  until(`!find('button', 'Plan task').disabled`)
  read(`(() => { find('button', 'Plan task').click(); return true })()`)
  until(PLAN)
  settle()
}

// ---- AC-0 / T-7: the phone matrix ------------------------------------------------------------------

describe('B7 phone matrix', () => {
  it.each(densities)('T-7/T-0 every B7 route and panel target at %s', (value) => {
    density(value)
    expect(read(`innerWidth`)).toBe(375)
    expect(read(`matchMedia('(hover: none)').matches`)).toBe(true)
    const failures: string[] = []
    const seen = new Map<string, string>()

    visit('/github', `document.querySelector('[data-slot="gh-row"]')`)
    collect('GitHub issues', MAIN, failures, seen)
    visit(`/github/issues/${issueNumber}`, `find('button', /^Run agent on this/)`)
    collect('GitHub issue + hand-off', MAIN, failures, seen)
    visit(`/github/prs/${prNumber}`, `document.querySelector('[data-slot="gh-merge-box"], [data-slot="gh-merge-unavailable"]')`)
    collect('GitHub pull request', MAIN, failures, seen)
    visit(`/github/prs/${prNumber}/changes`, `document.querySelector('[data-slot="gh-pr-changes"]') || find('link', 'Changes')`)
    collect('GitHub pull request changes', MAIN, failures, seen)

    visit('/automations', `find('button', 'Test filter')`)
    collect('Automations', MAIN, failures, seen)
    visit('/automations/new', `find('button', 'Save automation')`)
    collect('Automation editor', MAIN, failures, seen)
    visit(`/automations/${automationId}/log`, `find('heading', 'Execution log')`)
    collect('Automation log', MAIN, failures, seen)

    visit(`/compare/${groupId}`, `findAll('button', 'Pick this one').length === 2`)
    collect('Compare', MAIN, failures, seen)

    visit('/inbox', `document.querySelector('[data-slot="todo-card"][data-id="b7-run"]')`)
    collect('Inbox', MAIN, failures, seen)

    visit('/new', `find('button', 'Start task') && find('radio', 'Plan first')`)
    collect('New task', MAIN, failures, seen)
    openPlanReview()
    collect('Plan review', PLAN, failures, seen)
    browser.press('Escape')
    until(`!${PLAN}`)
    // The draft remembers Plan first; put it back so the next density's /new opens on Start.
    read(`(() => { find('radio', 'Start').click(); return true })()`)
    until(`find('button', 'Start task')`)

    visit('/skills', `find('link', /^${SKILL}/)`)
    collect('Skills', MAIN, failures, seen)
    visit(`/skills?skill=${SKILL}`, `find('link', 'Back to the list')`)
    collect('Skill detail', MAIN, failures, seen)

    visit(`/workflows/${FLOW}`, `document.querySelector('[data-slot="wb-step"]')`)
    collect('Workflows', MAIN, failures, seen)

    visit('/no-such-page', `find('link', 'Back to tasks')`)
    collect('Not found', MAIN, failures, seen)
    visit('/p/no-such-project/', `document.querySelector('[data-slot="registered-projects"] a')`)
    collect('Unknown project', `document.querySelector('[data-route="unknown-project"]')`, failures, seen)

    measured.set(value, seen)
    browser.screenshot(join(artifacts, `phone-${value}-unknown-project.png`), { viewport: true })
    expect(failures, `B7 phone matrix at ${value}`).toEqual([])
  }, 290_000)
})

// ---- OD-1 / D-03: one gutter on a desktop -----------------------------------------------------------

describe('OD-1 GitHub, Compare and Automations share one gutter on a desktop', () => {
  it.each(['comfortable', 'ultra'] as const)('title and body line up at %s', (value) => {
    density(value)
    const probe = `(() => { const p = document.createElement('div'); p.style.width = 'var(--spacing-section)'; document.body.append(p); const w = Math.round(p.getBoundingClientRect().width); p.remove(); return w })()`
    const left = `el => Math.round(el.getBoundingClientRect().left)`

    visit('/automations', `find('button', 'Test filter')`, 1280)
    const automations = read<{ gutter: number; card: number; title: number; section: number }>(`(() => {
      const L = ${left}; const title = find('heading', 'Automations');
      return { gutter: L(title) - L(find('main')), title: L(title), card: L(document.querySelector('[data-slot="automations-status"]')), section: ${probe} };
    })()`)
    expect(Math.abs(automations.gutter - automations.section), `automations gutter ${automations.gutter} vs ${automations.section}`).toBeLessThanOrEqual(1)
    expect(automations.card).toBe(automations.title)
    browser.screenshot(join(artifacts, `automations-desktop-${value}.png`), { viewport: true })

    visit(`/compare/${groupId}`, `findAll('button', 'Pick this one').length === 2`, 1280)
    const compare = read<{ gutter: number; column: number; title: number; section: number }>(`(() => {
      const L = ${left}; const title = document.querySelector('[data-slot="page-header"] h1');
      return { gutter: L(title) - L(find('main')), title: L(title), column: L(document.querySelector('[data-slot="variant-column"]')), section: ${probe} };
    })()`)
    expect(Math.abs(compare.gutter - compare.section), `compare gutter ${compare.gutter} vs ${compare.section}`).toBeLessThanOrEqual(1)
    expect(compare.column).toBe(compare.title)
    browser.screenshot(join(artifacts, `compare-desktop-${value}.png`), { viewport: true })

    visit(`/github/issues/${issueNumber}`, `find('button', /^Run agent on this/)`, 1280)
    const github = read<{ title: number; search: number; listGutter: number; detailGutter: number; section: number }>(`(() => {
      const L = ${left}; const list = document.querySelector('[data-slot="gh-list"]'); const detail = document.querySelector('[data-slot="gh-detail"]');
      const title = find('heading', 'GitHub');
      return { title: L(title), search: L(document.querySelector('[data-slot="gh-search"]')), listGutter: L(title) - L(list), detailGutter: L(detail.querySelector('h2')) - L(detail), section: ${probe} };
    })()`)
    expect(Math.abs(github.listGutter - github.section), `github list gutter ${github.listGutter}`).toBeLessThanOrEqual(1)
    expect(Math.abs(github.detailGutter - github.section), `github detail gutter ${github.detailGutter}`).toBeLessThanOrEqual(1)
    expect(github.search).toBe(github.title)
    browser.screenshot(join(artifacts, `github-desktop-${value}.png`), { viewport: true })
  }, 180_000)
})

// ---- T-7: the overwrite confirm is a danger action, Escape keeps the file ------------------------------

it('T-7 keyboard: the workflow overwrite confirm wears danger, and Escape keeps the file', async () => {
  await emulate('hover')
  try {
    const saved = readFileSync(join(root, `.xezar/workflows/${FLOW}.yaml`), 'utf8')
    visit(`/workflows/${FLOW}`, `document.querySelector('[data-slot="wb-step"]')`, 1280)
    read(`(() => { const el = find('button', 'Save'); el.focus(); el.click(); return true })()`)
    until(`find('dialog')`); settle()
    const colours = read<{ confirm: string; danger: string; cancel: string }>(`(() => {
      const dialog = find('dialog');
      const probe = document.createElement('div'); probe.style.backgroundColor = 'var(--danger)'; document.body.append(probe);
      const danger = getComputedStyle(probe).backgroundColor; probe.remove();
      return { confirm: getComputedStyle(find('button', 'Overwrite', dialog)).backgroundColor, danger, cancel: nameOf(find('button', 'Keep it', dialog)) };
    })()`)
    expect(colours.confirm).toBe(colours.danger)
    expect(colours.cancel).toBe('Keep it')
    browser.press('Escape')
    until(`findAll('dialog').length === 0`)
    expect(read<string>(`nameOf(document.activeElement)`)).toBe('Save')
    expect(readFileSync(join(root, `.xezar/workflows/${FLOW}.yaml`), 'utf8')).toBe(saved)
  } finally {
    await emulate('none')
  }
}, 120_000)

it('T-0 effective reduced motion: nothing loops on the B7 pages', () => {
  browser.setMedia('light', { reducedMotion: true })
  try {
    for (const [path, ready] of [
      ['/github', `document.querySelector('[data-slot="gh-row"]')`],
      [`/compare/${groupId}`, `findAll('button', 'Pick this one').length === 2`],
      ['/new', `find('button', 'Start task')`],
      ['/workflows', `document.querySelector('[data-slot="wb-yaml"]')`],
    ] as const) {
      visit(path, ready)
      const running = read<string[]>(`document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity).map(a => a.animationName ?? 'animation')`)
      expect(running, `${path} infinite animations under reduced motion`).toEqual([])
    }
  } finally {
    browser.setMedia('light')
  }
}, 120_000)

// ---- contrast ----------------------------------------------------------------------------------------

// Composited contrast through Canvas (the B2–B6 recipe): every ancestor background, the browser's own
// colour parser, genuinely disabled controls exempt.
function contrast(scope: string) {
  return read<{ name: string; color: string; ratio: number; label: boolean }[]>(`(() => {
    const surface = ${scope};
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = value => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].map((x, i) => i === 3 ? x / 255 : x) };
    const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
    const lum = c => c.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    return [...surface.querySelectorAll('*')].filter(el => el.getClientRects().length && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && !el.closest('[aria-hidden="true"], [disabled], :disabled, [data-disabled], pre, code, [data-slot="twinkle-backdrop"]')).map(el => {
      const chain = []; for (let p = el; p; p = p.parentElement) chain.unshift(p);
      let bg = [255, 255, 255]; for (const node of chain) bg = over(rgba(getComputedStyle(node).backgroundColor), bg);
      let fg = rgba(getComputedStyle(el).color); fg = over([...fg.slice(0, 3), fg[3] * chain.reduce((o, n) => o * Number(getComputedStyle(n).opacity), 1)], bg);
      const a = lum(fg), b = lum(bg);
      return { name: '"' + el.textContent.trim().slice(0, 30) + '"', color: getComputedStyle(el).color, label: Boolean(el.closest('[data-slot="gh-label"], [data-slot="gh-event-label"]')), ratio: Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100 };
    });
  })()`)
}

// Light-theme ink tokens already below 4.5:1 as small text (known-gaps G-23). B7 may not change a
// token (#453: B1 owns them), so these colours are reported, not passed; any OTHER colour below the
// line still fails, and so does one of these on a dark surface.
const G23_LIGHT_INKS: Record<string, string> = {
  'rgb(16, 185, 129)': '--success',
  'rgb(239, 68, 68)': '--danger',
  'rgb(143, 134, 232)': '--violet',
}

it.each(['light', 'dark'] as const)('small B7 text has composited contrast in %s', (theme) => {
  read(`(() => { localStorage.setItem('xez-theme', '${theme}'); return true })()`)
  browser.setMedia(theme)
  const low: string[] = []
  const known = new Set<string>()
  try {
    for (const [name, path, ready] of [
      ['github-issue', `/github/issues/${issueNumber}`, `find('button', /^Run agent on this/)`],
      ['automations', '/automations', `find('button', 'Test filter')`],
      ['compare', `/compare/${groupId}`, `findAll('button', 'Pick this one').length === 2`],
      ['inbox', '/inbox', `document.querySelector('[data-slot="todo-card"][data-id="b7-run"]')`],
      ['skills', `/skills?skill=${SKILL}`, `find('heading', ${q(SKILL)})`],
      ['workflows', `/workflows/${FLOW}`, `document.querySelector('[data-slot="wb-step"]')`],
    ] as const) {
      visit(path, ready, 1280)
      browser.screenshot(join(artifacts, `${theme}-${name}.png`), { viewport: true })
      const samples = contrast(MAIN)
      expect(samples.length).toBeGreaterThan(0)
      for (const sample of samples.filter((s) => s.ratio < 4.5)) {
        // A GitHub label chip is painted in the repository's OWN label colour (runtime data, not a
        // design token – github-filter.ts): reported, never passed silently or "fixed" here.
        const token = sample.label ? `GitHub label colour ${sample.color}` : theme === 'light' ? G23_LIGHT_INKS[sample.color] : undefined
        if (token) known.add(`${token} ${name} ${sample.name} ${sample.ratio}:1`)
        else low.push(`${name}: ${sample.name} ${sample.color} ${sample.ratio}:1`)
      }
    }
    writeFileSync(join(artifacts, `contrast-${theme}-known.json`), JSON.stringify([...known].sort(), null, 2))
    expect([...new Set(low)], `${theme} small text below 4.5:1`).toEqual([])
  } finally {
    read(`(() => { localStorage.setItem('xez-theme', 'light'); return true })()`)
    browser.setMedia('light')
  }
}, 240_000)

it('records what the phone matrix measured', () => {
  writeFileSync(join(artifacts, 'known-g36-g45-markdown-actions.json'), JSON.stringify([...knownMarkdown].sort(), null, 2))
  writeFileSync(join(artifacts, 'matrix.json'), JSON.stringify(Object.fromEntries([...measured].map(([d, m]) => [d, Object.fromEntries(m)])), null, 2))
  expect(measured.size).toBe(densities.length)
})
