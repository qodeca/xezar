import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, fixtureServeEnv, readTestEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'
import subagents from './fixtures/subagents-run.record.json'
import thread from './fixtures/thread-run.record.json'

/**
 * Design-debt batch B5 in a real browser — thread, composer and launch menus (#453, AC-5 / T-5 and
 * the shared AC-0 matrix).
 *
 * `packages/web/src/design-debt-b5.test.tsx` pins the class contracts, the clipboard helper and the
 * single-delivery answer in jsdom. This file is the browser half: every actionable target on the
 * task thread at 375 px, at all four densities, measured from its RENDERED box — the run header
 * and its details, the Agents and Plan docks, tool cards, the review panel, an ask card, the
 * composer with an attachment, the run-actions menu, the delete confirm and the drawer's Tools
 * menu — with no overlap inside one layer, no clipping and no invisible touch target. It also
 * checks keyboard reveal on a hover device, an honest toast when the clipboard refuses, reduced
 * motion and composited small-text contrast.
 *
 * Locators are roles, accessible names and visible text, resolved inside the page (`find`), so a
 * renamed class or data attribute does not break the spec and a renamed LABEL does.
 *
 * It owns its server over a throwaway data root: it changes the density, which may not land in
 * the shared environment.
 */

const sessionId = `e2e-b5-${process.pid}`
const densities = ['comfortable', 'roomy', 'compact', 'ultra'] as const
const artifacts = resolve(import.meta.dirname, '../../../.local/qa/b5-captures')
let browser: AgentBrowser
let server: ChildProcess
let root: string
let url: string
let project: string
let emulationSocket: WebSocket | undefined
let emulate: (hover: 'none' | 'hover') => Promise<void>

const NOW = '2026-09-17T12:00:00.000Z'
const SUBAGENTS_ID: string = subagents.id
const THREAD_ID: string = thread.id
const ASK_EVENT = {
  type: 'ask.requested',
  requestId: 'ask_b5',
  questions: [
    {
      header: 'Library',
      question: 'Which date library should the cockpit standardise on?',
      multiSelect: false,
      options: [
        { label: 'date-fns', description: 'Tree-shakeable functions' },
        { label: 'Luxon', description: 'Immutable and time-zone aware' },
      ],
    },
  ],
  stepId: 'task',
  seq: 61,
  ts: '2026-07-14T20:28:18.000Z',
}
const RUNS = [
  { ...subagents, seenAt: NOW },
  { ...thread, seenAt: NOW },
  { ...thread, id: 'b5-review', title: 'A task waiting for review', status: 'review', finishedAt: undefined, seenAt: NOW },
  { ...thread, id: 'b5-ask', title: 'A task with a question', seenAt: NOW },
]

// ---- in-page locators: role + accessible name, or visible text ---------------------------------

const FIND = `
  const ROLE = { button: 'button,[role="button"]', link: 'a[href]', menu: '[role="menu"]', menuitem: '[role="menuitem"]', dialog: '[role="dialog"]', alertdialog: '[role="alertdialog"]', textbox: 'textarea,input:not([type]),input[type="text"]', main: 'main', region: 'section[aria-label]', group: '[role="group"]', radiogroup: '[role="radiogroup"]', radio: '[role="radio"]', status: '[role="status"]' };
  const shown = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const nameOf = el => (el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') ? el.getAttribute('aria-labelledby').split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ') : '') || el.textContent || '').replace(/\\s+/g, ' ').trim();
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
/** Focus a control by role and name and press a key: Radix menus open on pointerdown or a key. */
function press(role: string, name: string | RegExp, key = 'Enter') {
  read(`(() => { const el = find('${role}', ${q(name)}); el.scrollIntoView({ block: 'center' }); el.focus(); return true })()`)
  browser.press(key)
}
function visit(path: string, ready: string, width = 375) {
  browser.setViewport(width, 812)
  browser.goto(`${url}${path}`)
  until(ready)
  settle()
}
function density(value: string) {
  visit('/settings/global/appearance', `find('radiogroup', 'Density')`)
  const label = { comfortable: 'Comfortable', roomy: 'Roomy', compact: 'Compact', ultra: 'Compact for real' }[value]!
  read(`(() => { find('radio', ${q(label)}, find('radiogroup', 'Density')).click(); return true })()`)
  browser.waitForFunction(`(document.documentElement.dataset.density ?? 'comfortable') === '${value}'`)
  // The PUT must land before the next navigation, or the server's older answer would win.
  browser.waitForFunction(`fetch('/api/v1/workspace/ui-state').then(r => r.json()).then(s => (s.appearance?.density ?? 'comfortable') === '${value}')`)
}

// ---- geometry ----------------------------------------------------------------------------------

type Geometry = { targets: string[]; markdownActions: string[]; smallest: string; short: string[]; clipped: string[]; overlaps: string[]; invisible: string[]; overflow: boolean }
/** Every actionable target inside `scope` (an in-page expression), measured from what a finger can
 *  hit: the box, or a painted centred `::before` hit area when that is larger. Overlap is checked
 *  only within one layer — a sticky composer legitimately sits over scrolled thread content. */
function geometry(scope: string, only?: string): Geometry {
  return read(`(() => {
    const parent = ${scope};
    const visible = el => el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[aria-hidden="true"]');
    let nodes = [...parent.querySelectorAll('a[href],button,input,select,textarea,summary,[role="radio"],[role="tab"],[role="switch"],[role="option"],[role="menuitem"],[role="menuitemcheckbox"]')]
      .filter(visible).filter(el => el.type !== 'hidden' && el.type !== 'file')
      // Not a target: a read-only task-list tick in rendered Markdown.
      .filter(el => !(el.type === 'checkbox' && el.disabled))
      // WCAG 2.5.8's inline exception: a link inside a sentence is sized by the line it sits in.
      // Only rendered Markdown carries running sentences; a control row's link is still a target.
      .filter(el => !(el.closest('[data-streamdown]') && el.parentElement && el.parentElement.textContent.trim() !== el.textContent.trim()));
    // Rendered Markdown's code-block actions come from the Markdown library, outside this batch's
    // files: reported separately (known-gaps G-36), never passed silently.
    const markdownActions = nodes.filter(el => /^code-block-(copy|download)-button$/.test(el.dataset.streamdown ?? ''));
    nodes = nodes.filter(el => !markdownActions.includes(el));
    ${only ? `nodes = nodes.filter(el => ${only});` : ''}
    if (!nodes.length) throw new Error('No interactive targets in scope');
    const label = el => (nameOf(el) || el.alt || el.querySelector('img')?.alt || el.outerHTML.slice(0, 80)).slice(0, 80) + (el.disabled ? ' (disabled)' : '');
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
      if (opacity(el) < 0.5) invisible.push(label(el));
      for (const other of nodes) {
        if (el === other || el.contains(other) || other.contains(el) || layer(el) !== layer(other) || !visible(other)) continue;
        const a = box(other);
        if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5) overlaps.push(label(el) + ' / ' + label(other));
      }
    }
    return { targets: nodes.map(label), markdownActions: markdownActions.map(el => el.dataset.streamdown + ': ' + Math.round(el.getBoundingClientRect().width) + ' x ' + Math.round(el.getBoundingClientRect().height)), smallest: Math.round(minW * 10) / 10 + ' x ' + Math.round(minH * 10) / 10, short, clipped, overlaps, invisible, overflow: document.documentElement.scrollWidth > innerWidth };
  })()`)
}
function collect(name: string, scope: string, into: string[], seen: Map<string, string>, only?: string) {
  let g: Geometry
  try { g = geometry(scope, only) } catch (cause) { into.push(`${name}: ${String((cause as Error).message).match(/Evaluation error: ([^\\\n"]*)/)?.[1] ?? 'measure failed'}`); return }
  seen.set(name, `${g.targets.length} targets, smallest ${g.smallest}`)
  for (const action of g.markdownActions) knownMarkdown.add(`${name}: ${action}`)
  for (const s of g.short) into.push(`${name}: below 44px: ${s}`)
  for (const s of g.clipped) into.push(`${name}: clipped: ${s}`)
  for (const s of new Set(g.overlaps)) into.push(`${name}: overlap: ${s}`)
  for (const s of g.invisible) into.push(`${name}: invisible touch target: ${s}`)
  if (g.overflow) into.push(`${name}: horizontal page overflow`)
}

// ---- server + browser --------------------------------------------------------------------------

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'xezar-e2e-b5-'))
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  execFileSync('git', ['-C', root, '-c', 'user.name=b5', '-c', 'user.email=b5@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture'])
  mkdirSync(join(root, '.xez-home'), { recursive: true })
  mkdirSync(join(root, '.local/xezar/runs'), { recursive: true })
  writeFileSync(join(root, '.local/xezar/runs.json'), JSON.stringify(RUNS, null, 2))
  const fixture = (name: string) => readFileSync(resolve(import.meta.dirname, `fixtures/${name}`), 'utf8')
  writeFileSync(join(root, '.local/xezar/runs', `${SUBAGENTS_ID}.ndjson`), fixture('subagents-run.ndjson'))
  writeFileSync(join(root, '.local/xezar/runs', `${THREAD_ID}.ndjson`), fixture('thread-run.ndjson'))
  writeFileSync(join(root, '.local/xezar/runs', 'b5-review.ndjson'), fixture('thread-run.ndjson'))
  writeFileSync(join(root, '.local/xezar/runs', 'b5-ask.ndjson'), `${fixture('thread-run.ndjson').trimEnd()}\n${JSON.stringify(ASK_EVENT)}\n`)
  writeFileSync(join(root, '.xez-home/config.json'), JSON.stringify({ projects: [{ id: 'b5-project', name: 'B5 thread project', root, addedAt: NOW, lastOpenedAt: NOW, source: 'local' }] }))
  const port = await new Promise<number>((done, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const a = s.address(); const n = typeof a === 'object' && a ? a.port : 0; s.close(() => done(n)) }) })
  url = `http://localhost:${port}`
  server = spawn(process.execPath, [xezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], { env: fixtureServeEnv(root), stdio: 'ignore' })
  let healthy = false
  for (let n = 0; n < 60; n++) { try { if ((await fetch(`${url}/api/v1/health`)).ok) { healthy = true; break } } catch {} await new Promise((r) => setTimeout(r, 250)) }
  if (!healthy) throw new Error('B5 fixture server did not start')
  project = await bootProjectId(url)
  browser = AgentBrowser.open(sessionId)
  const cli = (...args: string[]) => {
    const result = JSON.parse(execFileSync(readTestEnv().browser.command, ['--session', sessionId, ...args, '--json'], { encoding: 'utf8', timeout: 60_000 }))
    if (!result.success) throw new Error('B5 provider command failed')
    return result.data
  }
  // Launched as a hover device, then touch emulation switches `(hover: none)` on (the B4 recipe).
  cli('--args', '--blink-settings=primaryHoverType=2', 'open', url)
  const socket = new WebSocket(cli('get', 'cdp-url').cdpUrl)
  emulationSocket = socket
  await new Promise<void>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error('B5 emulation connection timed out')), 5_000)
    socket.onopen = () => { clearTimeout(timeout); done() }
    socket.onerror = () => { clearTimeout(timeout); fail(new Error('B5 emulation connection failed')) }
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
    const id = ++nextId, timeout = setTimeout(() => { pending.delete(id); fail(new Error('B5 emulation command timed out')) }, 5_000)
    pending.set(id, { resolve: (value) => { clearTimeout(timeout); done(value) }, reject: (error) => { clearTimeout(timeout); fail(error) } })
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))
  })
  const tab = cli('tab', 'list').tabs.find((t: { active: boolean }) => t.active)
  if (!tab) throw new Error('B5 provider has no active page')
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

const task = (id: string) => `/p/${project}/tasks/${id}`
const MAIN = `find('main')`
const measured = new Map<string, Map<string, string>>()
const knownMarkdown = new Set<string>()

/** A pasted image on the composer, through the browser's own clipboard event. */
function attachImage() {
  read(`(() => {
    const field = find('textbox', 'Reply to the agent');
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([png], 'b5-shot.png', { type: 'image/png' }));
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return true;
  })()`)
  until(`find('button', 'Remove b5-shot.png')`)
}

describe('B5 phone matrix', () => {
  it.each(densities)('T-5/T-0 every thread, composer, dock, review, ask and menu target at %s', (value) => {
    density(value)
    expect(read(`innerWidth`)).toBe(375)
    expect(read(`matchMedia('(hover: none)').matches`)).toBe(true)
    const failures: string[] = []
    const seen = new Map<string, string>()

    // The subagent thread: run header, Agents dock and its rows, tool cards, the composer.
    visit(task(SUBAGENTS_ID), `find('button', /^Agents/)`)
    press('button', 'Show run details')
    until(`find('button', 'Hide run details')`)
    collect('subagent thread (details open)', MAIN, failures, seen)

    // The run-actions menu and the delete confirm it opens.
    press('button', 'Run actions')
    until(`find('menu')`); settle()
    collect('run actions menu', `find('menu')`, failures, seen)
    read(`(() => { find('menuitem', /Delete/).click(); return true })()`)
    until(`find('alertdialog')`); settle()
    collect('delete confirm', `find('alertdialog')`, failures, seen)
    expect(read<string>(`nameOf(find('button', 'Keep it', find('alertdialog')))`)).toBe('Keep it')
    browser.press('Escape')
    until(`findAll('alertdialog').length === 0`)

    // The plan thread: Plan dock, tool cards and context groups, expanded workflow steps.
    visit(task(THREAD_ID), `find('button', /^Plan/)`)
    press('button', /^Workflow:/)
    collect('plan thread (steps open)', MAIN, failures, seen)

    // The composer with an attachment: its remove mark is shown on a device that cannot hover.
    attachImage()
    const mark = read<{ display: string; markW: number; buttonW: number }>(`(() => {
      const button = find('button', 'Remove b5-shot.png'), mark = button.querySelector('svg').parentElement;
      return { display: getComputedStyle(mark).display, markW: mark.getBoundingClientRect().width, buttonW: button.getBoundingClientRect().width };
    })()`)
    if (mark.display === 'none') failures.push('composer: the attachment remove mark is hidden on a no-hover device')
    if (mark.markW >= mark.buttonW) failures.push('composer: the remove mark covers the whole attachment')
    collect('composer with an attachment', `find('textbox', 'Reply to the agent').parentElement`, failures, seen)

    // The review panel.
    visit(task('b5-review'), `find('region', 'Review the changes')`)
    collect('review panel', `find('region', 'Review the changes')`, failures, seen)

    // An open question.
    visit(task('b5-ask'), `find('group', /Which date library/)`)
    collect('ask card', `find('group', /Which date library/).parentElement.parentElement`, failures, seen)

    // The drawer's Tools trigger and its menu.
    browser.click('button[aria-label="Open menu"]')
    until(`find('button', /Tools/)`); settle()
    collect('drawer Tools trigger', `find('button', /Tools/).parentElement`, failures, seen, `/Tools/.test(nameOf(el))`)
    press('button', /Tools/)
    until(`find('menu')`); settle()
    collect('Tools menu', `find('menu')`, failures, seen)
    browser.press('Escape')

    measured.set(value, seen)
    expect(failures, `B5 phone matrix at ${value}`).toEqual([])
  }, 290_000)
})

it('G-21 keyboard focus reveals the title pencil and the message actions, with the focus ring, on a hover device', async () => {
  await emulate('hover')
  try {
    visit(task(THREAD_ID), `find('button', 'Rename task')`, 1280)
    expect(read(`matchMedia('(hover: none)').matches`)).toBe(false)
    expect(read(`getComputedStyle(find('button', 'Rename task')).opacity`)).toBe('0')
    read(`(() => { find('button', 'Rename task').focus(); return true })()`)
    browser.waitForFunction(`getComputedStyle(document.activeElement).opacity === '1'`)
    const pencil = read<{ name: string; ring: string }>(`({ name: nameOf(document.activeElement), ring: getComputedStyle(document.activeElement).boxShadow })`)
    expect(pencil.name).toBe('Rename task')
    expect(pencil.ring).not.toBe('none')
    browser.press('Enter')
    until(`find('textbox', 'Task title')`)
    browser.press('Escape')
    until(`findAll('textbox', 'Task title').length === 0`)
  } finally {
    await emulate('none')
  }
}, 120_000)

it('G-21 a no-hover tablet shows the title pencil as a 44 px target', () => {
  visit(task(THREAD_ID), `find('button', 'Rename task')`, 1024)
  const pencil = read<{ w: number; h: number; opacity: string }>(`(() => { const el = find('button', 'Rename task'), b = el.getBoundingClientRect(); return { w: b.width, h: b.height, opacity: getComputedStyle(el).opacity } })()`)
  expect(pencil.opacity).toBe('1')
  expect(pencil.w).toBeGreaterThanOrEqual(43.5)
  expect(pencil.h).toBeGreaterThanOrEqual(43.5)
}, 120_000)

it('T-5 a refused clipboard never reports a copy', () => {
  visit(task(THREAD_ID), `find('button', /take over interactively/)`)
  read(`(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Document is not focused.')) } }); return true })()`)
  read(`(() => { const el = find('button', /take over interactively/); el.scrollIntoView({ block: 'center' }); el.click(); return true })()`)
  until(`findAll('status').some(el => /Run manually:/.test(el.textContent))`)
  expect(read<string[]>(`findAll('status').map(el => el.textContent)`).filter((text) => /copied/i.test(text))).toEqual([])
}, 120_000)

it('T-0 effective reduced motion: nothing loops on the thread surfaces', () => {
  browser.setMedia('light', { reducedMotion: true })
  try {
    for (const [id, ready] of [[SUBAGENTS_ID, `find('button', /^Agents/)`], [THREAD_ID, `find('button', /^Plan/)`], ['b5-review', `find('region', 'Review the changes')`]] as const) {
      visit(task(id), ready)
      const running = read<string[]>(`document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity).map(a => a.animationName ?? 'animation')`)
      expect(running, `${id} infinite animations under reduced motion`).toEqual([])
    }
  } finally {
    browser.setMedia('light')
  }
}, 120_000)

// Composited contrast through Canvas (the B2–B4 recipe): every ancestor background, the browser's
// own colour parser, genuinely disabled controls exempt.
function contrast(scope: string) {
  return read<{ name: string; color: string; ratio: number }[]>(`(() => {
    const surface = ${scope};
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = value => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].map((x, i) => i === 3 ? x / 255 : x) };
    const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
    const lum = c => c.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    return [...surface.querySelectorAll('*')].filter(el => el.getClientRects().length && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && !el.closest('[aria-hidden="true"], [disabled], :disabled, [data-disabled], pre, code')).map(el => {
      const chain = []; for (let p = el; p; p = p.parentElement) chain.unshift(p);
      let bg = [255, 255, 255]; for (const node of chain) bg = over(rgba(getComputedStyle(node).backgroundColor), bg);
      let fg = rgba(getComputedStyle(el).color); fg = over([...fg.slice(0, 3), fg[3] * chain.reduce((o, n) => o * Number(getComputedStyle(n).opacity), 1)], bg);
      const a = lum(fg), b = lum(bg);
      return { name: '"' + el.textContent.trim().slice(0, 30) + '"', color: getComputedStyle(el).color, ratio: Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100 };
    });
  })()`)
}

// Light-theme ink tokens already below 4.5:1 as small text (known-gaps G-23). B5 may not change a
// token (#453: B1 owns them), so these colours are reported, not passed; any OTHER colour below the
// line still fails, and so does one of these on a dark surface.
const G23_LIGHT_INKS: Record<string, string> = {
  'rgb(16, 185, 129)': '--success',
  'rgb(239, 68, 68)': '--danger',
  'rgb(143, 134, 232)': '--violet',
}

it.each(['light', 'dark'] as const)('small thread text has composited contrast in %s', (theme) => {
  read(`(() => { localStorage.setItem('xez-theme', '${theme}'); return true })()`)
  browser.setMedia(theme)
  const low: string[] = []
  const known = new Set<string>()
  try {
    for (const [id, ready, scope] of [
      [SUBAGENTS_ID, `find('button', /^Agents/)`, MAIN],
      ['b5-review', `find('region', 'Review the changes')`, `find('region', 'Review the changes')`],
      ['b5-ask', `find('group', /Which date library/)`, `find('group', /Which date library/)`],
    ] as const) {
      visit(task(id), ready)
      browser.screenshot(join(artifacts, `${theme}-${id.slice(0, 8)}.png`), { viewport: true })
      const samples = contrast(scope)
      expect(samples.length).toBeGreaterThan(0)
      for (const sample of samples.filter((s) => s.ratio < 4.5)) {
        const token = theme === 'light' ? G23_LIGHT_INKS[sample.color] : undefined
        if (token) known.add(`${token} ${sample.name} ${sample.ratio}:1`)
        else low.push(`${id}: ${sample.name} ${sample.color} ${sample.ratio}:1`)
      }
    }
    writeFileSync(join(artifacts, `contrast-${theme}-known-g23.json`), JSON.stringify([...known].sort(), null, 2))
    expect([...new Set(low)], `${theme} small text below 4.5:1`).toEqual([])
  } finally {
    read(`(() => { localStorage.setItem('xez-theme', 'light'); return true })()`)
    browser.setMedia('light')
  }
}, 240_000)

it('records what the phone matrix measured', () => {
  writeFileSync(join(artifacts, 'known-g36-markdown-actions.json'), JSON.stringify([...knownMarkdown].sort(), null, 2))
  writeFileSync(join(artifacts, 'matrix.json'), JSON.stringify(Object.fromEntries([...measured].map(([d, m]) => [d, Object.fromEntries(m)])), null, 2))
  expect(measured.size).toBe(densities.length)
})
