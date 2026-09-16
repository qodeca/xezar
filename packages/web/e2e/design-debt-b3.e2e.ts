import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, fixtureServeEnv, readTestEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'

/**
 * Design-debt batch B3 in a real browser — Settings (#453, AC-3 / T-3 and the shared AC-0 matrix).
 *
 * `packages/web/src/design-debt-b3.test.tsx` pins the class contracts and the save/refusal logic in
 * jsdom. This file is the browser half: every actionable settings target at 375 px, at all four
 * densities, measured from its RENDERED box (a switch's `::before` overlay included, a checkbox
 * through the label that owns its tap), plus the 24 px chip floor, no overlap, no clipping and no
 * horizontal page overflow. It also drives the appearance refusal race, the save contracts
 * (selects on change, numbers only on Save), keyboard focus on the segment groups, destructive
 * cancel, reduced motion and composited small-text contrast.
 *
 * It owns its server over a throwaway data root: it changes the density, refuses saves and opens
 * destructive dialogs, none of which may land in the shared environment. Fixture replies below
 * exercise UI refusal states, never server authorization.
 */

const sessionId = `e2e-b3-${process.pid}`
const densities = ['comfortable', 'roomy', 'compact', 'ultra'] as const
const artifacts = resolve(import.meta.dirname, '../../../.local/qa/b3-captures')
let browser: AgentBrowser
let server: ChildProcess
let root: string
let url: string
let project: string
let emulationSocket: WebSocket | undefined

const GLOBAL_SECTIONS = ['appearance', 'notifications', 'resources', 'skills', 'accounts', 'projects'] as const
const PROJECT_SECTIONS = ['agents', 'agent-config', 'project-setup', 'worktrees', 'bookmarklets', 'prompt-templates', 'mcp-connection', 'mcp-api'] as const

function read<T>(expression: string): T {
  return JSON.parse(browser.evaluate(`JSON.stringify((() => { return (${expression}) })())`) as string) as T
}
function wait(selector: string) {
  browser.waitForFunction(`document.querySelector(${JSON.stringify(selector)}) !== null`)
  // Overlays zoom in from 95 %: measure only once every finite animation has finished.
  browser.waitForFunction(`document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)`)
}
function waitGone(selector: string) {
  browser.waitForFunction(`document.querySelector(${JSON.stringify(selector)}) === null`)
}
/** A settings route is ready when its route root is painted and no section is still loading. */
function visit(path: string, route: string, width = 375) {
  browser.setViewport(width, 812)
  browser.goto(`${url}${path}`)
  wait(`[data-route="${route}"]`)
  browser.waitForFunction(`![...document.querySelectorAll('[data-route="${route}"] *')].some(el => el.children.length === 0 && /^Loading\\b/.test(el.textContent.trim()))`)
}
function density(value: string) {
  visit('/settings/global/appearance', 'settings-global-appearance')
  browser.click(`[data-slot="appearance-density"] [data-value="${value}"]`)
  browser.waitForFunction(`(document.documentElement.dataset.density ?? 'comfortable') === '${value}'`)
  // The PUT must land before the next navigation, or the server's older answer would win.
  browser.waitForFunction(`fetch('/api/v1/workspace/ui-state').then(r => r.json()).then(s => (s.appearance?.density ?? 'comfortable') === '${value}')`)
}

// Every actionable target in the scope — buttons, links, fields, summaries and ARIA widgets.
// A checkbox or radio wrapped in a <label> is measured through that label: the label is the
// element a finger actually hits, and it toggles the control. Pseudo-element hit regions
// (the switch's `before:size-tap`) count only when painted.
type Geometry = { targets: string[]; short: string[]; clipped: string[]; overlaps: string[]; overflow: boolean; chips: string[] }
function geometry(scope: string): Geometry {
  return read(`(() => {
    const parent = document.querySelector(${JSON.stringify(scope)});
    if (!parent) throw new Error('Missing measured surface: ' + ${JSON.stringify(scope)});
    const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[aria-hidden="true"]');
    const raw = [...parent.querySelectorAll('a[href],button,input,select,textarea,summary,[role="radio"],[role="tab"],[role="switch"],[role="option"],[role="menuitem"]')]
      .filter(visible).filter(el => el.type !== 'hidden')
      // DefaultAgentPicker (\`agents-runner\`) is B4's manifest; a closed <details> keeps stale boxes.
      .filter(el => !el.closest('[data-slot="agents-runner"]'))
      .filter(el => { for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) { if (!d.open && el.closest('summary')?.parentElement !== d) return false } return true });
    const owner = el => (el.matches('input[type="checkbox"],input[type="radio"]') && el.closest('label')) || el;
    const nodes = [...new Set(raw.map(owner))];
    if (!nodes.length) throw new Error('No interactive targets in ' + ${JSON.stringify(scope)});
    const name = el => el.dataset.action || (el.dataset.slot && el.dataset.slot !== 'button' ? el.dataset.slot : '') || el.getAttribute('aria-label') || el.tagName.toLowerCase() + ':' + el.textContent.trim().slice(0, 40);
    const box = el => {
      const b = el.getBoundingClientRect(), s = getComputedStyle(el, '::before');
      const painted = s.content !== 'none' && s.display !== 'none' && s.position === 'absolute';
      const w = painted ? parseFloat(s.width) || 0 : 0, h = painted ? parseFloat(s.height) || 0 : 0;
      return { x: b.x - Math.max(0, w - b.width) / 2, y: b.y - Math.max(0, h - b.height) / 2, w: Math.max(b.width, w), h: Math.max(b.height, h) };
    };
    const short = [], clipped = [], overlaps = [];
    for (const el of nodes) {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const b = box(el);
      if (b.w < 43.5 || b.h < 43.5) short.push(name(el) + ': ' + Math.round(b.w * 10) / 10 + ' x ' + Math.round(b.h * 10) / 10);
      const scroller = el.closest('[data-slot="settings-nav-mobile"]');
      const bounds = scroller ? scroller.getBoundingClientRect() : { left: 0, right: innerWidth };
      if (!scroller && (b.x < -0.5 || b.x + b.w > innerWidth + 0.5)) clipped.push(name(el));
      if (scroller && b.w > bounds.right - bounds.left + 0.5) clipped.push(name(el));
      for (const other of nodes) {
        if (el === other || el.contains(other) || other.contains(el)) continue;
        const a = box(other);
        if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5) overlaps.push(name(el) + ' / ' + name(other));
      }
    }
    const chips = [...parent.querySelectorAll('[data-slot="badge"],[data-slot="prompt-template-skill-chip"],[data-slot="prompt-template-skills-trigger"]')]
      .filter(visible).filter(el => el.getBoundingClientRect().height < 23.5).map(el => name(el) + ': ' + el.getBoundingClientRect().height);
    return { targets: nodes.map(name), short, clipped, overlaps, chips, overflow: document.documentElement.scrollWidth > innerWidth };
  })()`)
}
function collect(label: string, scope: string, into: string[]) {
  const g = geometry(scope)
  if (g.targets.length === 0) into.push(`${label}: no targets`)
  for (const s of g.short) into.push(`${label}: below 44px: ${s}`)
  for (const s of g.clipped) into.push(`${label}: clipped: ${s}`)
  for (const s of g.overlaps) into.push(`${label}: overlap: ${s}`)
  for (const s of g.chips) into.push(`${label}: chip below 24px: ${s}`)
  if (g.overflow) into.push(`${label}: horizontal page overflow`)
}

/** Replace `fetch` in the page so a chosen request is refused or recorded; everything else passes. */
function interceptor() {
  read(`(() => {
    window.__b3 = window.__b3 ?? { refuse: [], writes: [] };
    if (window.__b3Fetch) return true;
    window.__b3Fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const target = String(input instanceof Request ? input.url : input);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method !== 'GET') window.__b3.writes.push(method + ' ' + new URL(target, location.href).pathname);
      const rule = window.__b3.refuse.find(r => r.method === method && target.includes(r.path));
      if (rule) {
        if (rule.delay) await new Promise(done => setTimeout(done, rule.delay));
        return new Response(JSON.stringify({ error: rule.message }), { status: 409, headers: { 'content-type': 'application/json' } });
      }
      return window.__b3Fetch(input, init);
    };
    return true;
  })()`)
}
function refuse(rules: Array<{ method: string; path: string; message: string; delay?: number }>) {
  read(`(() => { window.__b3.refuse = ${JSON.stringify(rules)}; window.__b3.writes = []; return true })()`)
}
function writes(): string[] {
  return read<string[]>(`window.__b3.writes`)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'xezar-e2e-b3-'))
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  execFileSync('git', ['-C', root, '-c', 'user.name=b3', '-c', 'user.email=b3@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture'])
  mkdirSync(join(root, '.xez-home'), { recursive: true })
  mkdirSync(join(root, 'second'), { recursive: true })
  mkdirSync(join(root, '.xezar/skills'), { recursive: true })
  writeFileSync(join(root, '.xezar/skills/b3-fixture-skill.md'), '---\nname: b3-fixture-skill\ndescription: A fixture skill for the template picker\n---\nFixture.\n')
  const now = '2026-09-16T00:00:00.000Z'
  writeFileSync(join(root, '.xez-home/config.json'), JSON.stringify({ projects: [
    { id: 'b3-project', name: 'A long registered project name for settings geometry', root, addedAt: now, lastOpenedAt: now, source: 'local' },
    { id: 'b3-second', name: 'Second project with a long label', root: join(root, 'second'), addedAt: now, lastOpenedAt: now, source: 'local' },
  ] }))
  const port = await new Promise<number>((done, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const a = s.address(); const n = typeof a === 'object' && a ? a.port : 0; s.close(() => done(n)) }) })
  url = `http://localhost:${port}`
  server = spawn(process.execPath, [xezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], { env: fixtureServeEnv(root), stdio: 'ignore' })
  let healthy = false
  for (let n = 0; n < 60; n++) { try { if ((await fetch(`${url}/api/v1/health`)).ok) { healthy = true; break } } catch {} await new Promise((r) => setTimeout(r, 250)) }
  if (!healthy) throw new Error('B3 fixture server did not start')
  project = await bootProjectId(url)
  browser = AgentBrowser.open(sessionId)
  browser.goto(url)
  // Touch and no-hover emulation over the provider's own CDP endpoint, kept alive for the suite
  // (device presets alone do not switch `(hover: none)` on) — the B2 recipe.
  const cli = (...args: string[]) => {
    const result = JSON.parse(execFileSync(readTestEnv().browser.command, ['--session', sessionId, ...args, '--json'], { encoding: 'utf8', timeout: 60_000 }))
    if (!result.success) throw new Error('B3 provider command failed')
    return result.data
  }
  const socket = new WebSocket(cli('get', 'cdp-url').cdpUrl)
  emulationSocket = socket
  await new Promise<void>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error('B3 emulation connection timed out')), 5_000)
    socket.onopen = () => { clearTimeout(timeout); done() }
    socket.onerror = () => { clearTimeout(timeout); fail(new Error('B3 emulation connection failed')) }
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
    const id = ++nextId, timeout = setTimeout(() => { pending.delete(id); fail(new Error('B3 emulation command timed out')) }, 5_000)
    pending.set(id, { resolve: (value) => { clearTimeout(timeout); done(value) }, reject: (error) => { clearTimeout(timeout); fail(error) } })
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))
  })
  const tab = cli('tab', 'list').tabs.find((t: { active: boolean }) => t.active)
  if (!tab) throw new Error('B3 provider has no active page')
  const attached = await send('Target.attachToTarget', { targetId: tab.targetId, flatten: true })
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }, attached.sessionId)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] }, attached.sessionId)
  browser.setViewport(375, 812)
  mkdirSync(artifacts, { recursive: true })
}, 60_000)
afterAll(async () => { emulationSocket?.close(); browser?.close(); await stopFixtureServer(server); if (root) await removeDataRoot(root) })

describe('B3 phone matrix', () => {
  it.each(densities)('T-3/T-0 every settings target, dialog and picker at %s', (value) => {
    density(value)
    expect(read(`innerWidth`)).toBe(375)
    expect(read(`matchMedia('(hover: none)').matches`)).toBe(true)
    const failures: string[] = []
    visit('/settings/global', 'settings-global'); collect('global index', '[data-route="settings-global"]', failures)
    for (const id of GLOBAL_SECTIONS) {
      visit(`/settings/global/${id}`, `settings-global-${id}`)
      collect(`global/${id}`, `[data-route="settings-global-${id}"]`, failures)
    }
    visit(`/p/${project}/settings`, 'settings'); collect('project index', '[data-route="settings"]', failures)
    for (const id of PROJECT_SECTIONS) {
      visit(`/p/${project}/settings/${id}`, `settings-${id}`)
      collect(`project/${id}`, `[data-route="settings-${id}"]`, failures)
    }

    // Open states: the add-account dialog, the remove confirmation, the reclaim confirmation,
    // the template skills picker and a picked agent-config file.
    visit('/settings/global/accounts', 'settings-global-accounts')
    browser.evaluate(`document.querySelector('[data-action="accounts-add"]').scrollIntoView({ block: 'center' })`)
    browser.click('[data-action="accounts-add"]'); wait('[data-slot="add-account-dialog"]')
    collect('add-account dialog', '[data-slot="add-account-dialog"]', failures)
    browser.press('Escape'); waitGone('[data-slot="add-account-dialog"]')

    visit('/settings/global/projects', 'settings-global-projects')
    const remove = '[data-project="b3-second"] [data-action="project-remove"]'
    browser.evaluate(`document.querySelector('${remove}').scrollIntoView({ block: 'center' })`)
    browser.click(remove); wait('[data-slot="alert-dialog-content"]')
    collect('remove-project dialog', '[data-slot="alert-dialog-content"]', failures)
    browser.press('Escape'); waitGone('[data-slot="alert-dialog-content"]')

    visit(`/p/${project}/settings/worktrees`, 'settings-worktrees')
    browser.evaluate(`document.querySelector('[data-action="worktrees-reclaim-now"]').scrollIntoView({ block: 'center' })`)
    browser.click('[data-action="worktrees-reclaim-now"]'); wait('[data-slot="alert-dialog-content"]')
    collect('reclaim dialog', '[data-slot="alert-dialog-content"]', failures)
    browser.press('Escape'); waitGone('[data-slot="alert-dialog-content"]')

    visit(`/p/${project}/settings/prompt-templates`, 'settings-prompt-templates')
    const trigger = '[data-slot="prompt-template-skills-trigger"]'
    browser.evaluate(`document.querySelector('${trigger}').scrollIntoView({ block: 'center' })`)
    browser.click(trigger); wait('[data-slot="prompt-template-skill-option"]')
    collect('template skills picker', '[data-slot="popover-content"]', failures)
    browser.click('[data-slot="prompt-template-skill-option"]')
    browser.press('Escape'); waitGone('[data-slot="popover-content"]')
    wait('[data-slot="prompt-template-skill-chip"]')
    collect('template with a skill chip', '[data-route="settings-prompt-templates"]', failures)

    visit(`/p/${project}/settings/agent-config`, 'settings-agent-config')
    browser.evaluate(`document.querySelector('[data-slot="agent-config-file"]').scrollIntoView({ block: 'center' })`)
    browser.click('[data-slot="agent-config-file"]')
    collect('agent-config file picked', '[data-route="settings-agent-config"]', failures)

    expect(failures, `B3 phone matrix at ${value}`).toEqual([])
  }, 300_000)
})

it('T-3 two rapid refused density saves restore the last confirmed value', () => {
  density('comfortable')
  interceptor()
  refuse([{ method: 'PUT', path: '/workspace/ui-state', message: 'Appearance save refused for this fixture', delay: 300 }])
  browser.click('[data-slot="appearance-density"] [data-value="compact"]')
  browser.click('[data-slot="appearance-density"] [data-value="ultra"]')
  browser.waitForFunction(`window.__b3.writes.filter(w => w.endsWith('/workspace/ui-state')).length === 2`)
  browser.waitForFunction(`(document.documentElement.dataset.density ?? 'comfortable') === 'comfortable'`)
  // Settle past both refusals, then re-check: a late refusal must not repaint a stale choice.
  browser.waitForFunction(`new Promise(done => setTimeout(() => done(true), 800))`)
  expect(read(`document.documentElement.dataset.density ?? 'comfortable'`)).toBe('comfortable')
  expect(read(`document.querySelector('[data-slot="appearance-density"] [aria-checked="true"]').dataset.value`)).toBe('comfortable')
  expect(read(`localStorage.getItem('xez-density') ?? 'comfortable'`)).toBe('comfortable')
  refuse([])
}, 120_000)

it('T-3 selects save on change; number fields write nothing before Save', () => {
  visit('/settings/global/resources', 'settings-global-resources')
  interceptor(); refuse([])
  const select = '[data-slot="resources-max-parallel"]'
  const current = read<string>(`document.querySelector('${select}').value`)
  const next = current === '2' ? '3' : '2'
  read(`(() => { const el = document.querySelector('${select}'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, '${next}'); el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  browser.waitForFunction(`window.__b3.writes.some(w => w === 'PUT /api/v1/workspace/config')`)

  visit(`/p/${project}/settings/worktrees`, 'settings-worktrees')
  interceptor(); refuse([])
  const field = '[data-slot="resources-worktree-retention"]'
  browser.fill(field, '7')
  browser.press('Tab')
  // A bounded window for "nothing is written", not a wait for a state.
  browser.waitForFunction(`new Promise(done => setTimeout(() => done(true), 500))`)
  expect(writes(), 'no write before Save').toEqual([])
  browser.evaluate(`document.querySelector('[data-action="resources-save-retention"]').scrollIntoView({ block: 'center' })`)
  browser.click('[data-action="resources-save-retention"]')
  browser.waitForFunction(`window.__b3.writes.some(w => w.endsWith('/config'))`)
  expect(writes().filter((w) => w.endsWith('/config'))).toHaveLength(1)
}, 120_000)

it('T-3 every appearance segment shows a keyboard focus ring and arrows are not needed to reach it', () => {
  visit('/settings/global/appearance', 'settings-global-appearance', 1280)
  const groups = ['appearance-theme', 'appearance-accent', 'appearance-density', 'appearance-width']
  read(`(() => { document.activeElement?.blur(); document.querySelector('[data-slot="appearance-section"]').setAttribute('tabindex', '-1'); document.querySelector('[data-slot="appearance-section"]').focus(); return true })()`)
  const seen: string[] = []
  for (let n = 0; n < 12; n++) {
    browser.press('Tab')
    const focus = read<{ group: string | null; ring: string }>(`(() => { const el = document.activeElement; return { group: el?.closest('[role="radiogroup"]')?.dataset.slot ?? null, ring: el ? getComputedStyle(el).boxShadow : 'none' } })()`)
    if (focus.group === null) continue
    expect(focus.ring, `${focus.group} focus ring`).not.toBe('none')
    seen.push(focus.group)
  }
  expect([...new Set(seen)]).toEqual(groups)
  browser.press('Enter')
}, 120_000)

it('T-0 destructive confirmations: danger action, cancel keeps the project and writes nothing', () => {
  visit('/settings/global/projects', 'settings-global-projects')
  interceptor(); refuse([])
  const remove = '[data-project="b3-second"] [data-action="project-remove"]'
  browser.evaluate(`document.querySelector('${remove}').scrollIntoView({ block: 'center' })`)
  browser.click(remove); wait('[data-action="projects-confirm-remove"]')
  expect(read(`getComputedStyle(document.querySelector('[data-action="projects-confirm-remove"]')).backgroundColor`))
    .toBe(read(`(() => { const probe = document.createElement('span'); probe.className = 'bg-danger'; document.body.append(probe); const c = getComputedStyle(probe).backgroundColor; probe.remove(); return c })()`))
  expect(read(`document.querySelector('[data-slot="alert-dialog-content"]').contains(document.activeElement)`)).toBe(true)
  browser.click('[data-slot="alert-dialog-cancel"]'); waitGone('[data-slot="alert-dialog-content"]')
  expect(writes()).toEqual([])
  expect(read(`document.querySelector('[data-project="b3-second"]') !== null`)).toBe(true)
  expect(read(`document.activeElement?.dataset.action`)).toBe('project-remove')

  // A refused remove stays honest: the row remains and the refusal is announced.
  refuse([{ method: 'DELETE', path: '/projects/b3-second', message: 'Remove refused for this fixture' }])
  browser.click(remove); wait('[data-action="projects-confirm-remove"]')
  browser.click('[data-action="projects-confirm-remove"]')
  browser.waitForFunction(`document.body.textContent.includes('Remove refused for this fixture')`)
  expect(read(`document.querySelector('[data-project="b3-second"]') !== null`)).toBe(true)
  refuse([])
}, 120_000)

it('T-0 effective reduced motion: nothing animates on the settings routes', () => {
  browser.setMedia('light', { reducedMotion: true })
  for (const id of ['appearance', 'accounts', 'resources']) {
    visit(`/settings/global/${id}`, `settings-global-${id}`)
    const running = read<string[]>(`document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity).map(a => a.animationName ?? 'animation')`)
    expect(running, `${id} infinite animations under reduced motion`).toEqual([])
  }
  browser.setMedia('light')
}, 120_000)

// Composited contrast through Canvas (the B2 recipe): every ancestor background, the browser's own
// colour parser, genuinely disabled controls exempt.
function contrast(scope: string) {
  return read<{ name: string; ratio: number }[]>(`(() => {
    const surface = document.querySelector(${JSON.stringify(scope)});
    if (!surface) throw new Error('No contrast surface');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = value => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].map((x, i) => i === 3 ? x / 255 : x) };
    const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
    const lum = c => c.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    return [...surface.querySelectorAll('*')].filter(el => el.getClientRects().length && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && !el.closest('[aria-hidden="true"], [disabled], :disabled, [data-disabled], .cm-editor')).map(el => {
      const chain = []; for (let p = el; p; p = p.parentElement) chain.unshift(p);
      let bg = [255, 255, 255]; for (const node of chain) bg = over(rgba(getComputedStyle(node).backgroundColor), bg);
      let fg = rgba(getComputedStyle(el).color); fg = over([...fg.slice(0, 3), fg[3] * chain.reduce((o, n) => o * Number(getComputedStyle(n).opacity), 1)], bg);
      const a = lum(fg), b = lum(bg);
      return { name: el.textContent.trim().slice(0, 60), ratio: Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100 };
    });
  })()`)
}

it.each(['light', 'dark'] as const)('small settings text has composited contrast in %s with both accents', (theme) => {
  for (const accent of ['lime', 'violet']) {
    visit('/settings/global/appearance', 'settings-global-appearance')
    browser.click(`[data-slot="appearance-accent"] [data-value="${accent}"]`)
    browser.waitForFunction(`(document.documentElement.dataset.accent ?? 'lime') === '${accent}'`)
    read(`(() => { localStorage.setItem('xez-theme', '${theme}'); return true })()`)
    browser.setMedia(theme)
    const samples: { name: string; ratio: number }[] = []
    for (const [path, route] of [
      ['/settings/global/appearance', 'settings-global-appearance'],
      ['/settings/global/resources', 'settings-global-resources'],
      ['/settings/global/accounts', 'settings-global-accounts'],
      [`/p/${project}/settings/agents`, 'settings-agents'],
      [`/p/${project}/settings/worktrees`, 'settings-worktrees'],
      [`/p/${project}/settings/prompt-templates`, 'settings-prompt-templates'],
      [`/p/${project}/settings/mcp-connection`, 'settings-mcp-connection'],
    ] as const) {
      visit(path, route)
      samples.push(...contrast(`[data-route="${route}"]`))
    }
    browser.screenshot(join(artifacts, `${theme}-${accent}-prompt-templates.png`), { viewport: true })
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.filter((s) => s.ratio < 4.5), `${theme}/${accent} small text below 4.5:1`).toEqual([])
  }
  read(`(() => { localStorage.setItem('xez-theme', 'light'); return true })()`)
  browser.setMedia('light')
}, 240_000)
