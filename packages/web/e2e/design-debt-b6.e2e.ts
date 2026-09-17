import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, fixtureServeEnv, readTestEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'

/**
 * Design-debt batch B6 in a real browser — the Git tabs and the shared diff renderer (#453, AC-6 /
 * T-6 and the shared AC-0 matrix, plus #447 OD-1: the Git pages on the #424 rhythm).
 *
 * `packages/web/src/design-debt-b6.test.tsx` pins the engine facade, the patch shapes, byte
 * precision and the class contracts in jsdom. This file is the browser half, against a LIVE dry run
 * parked at review whose worktree the spec then shapes from the outside: a copy, a rename, a
 * binary image, a 420-line file and one uncommitted edit. It measures every actionable target at
 * 375 px on the repository Git tabs (Changes, Commits, a commit, Branches), the task Git tabs
 * (Changes, Commits, a commit, Files with a folder open) and the review gate's diff, at all four
 * densities, from the RENDERED box. It also checks that the review diff carries every line through
 * the one engine, that the page title, toolbar and body share one gutter on a desktop, keyboard
 * routes through the Files tree and the commit dialog's cancel, reduced motion and composited
 * small-text contrast.
 *
 * Locators are roles, accessible names and visible text, resolved inside the page (`find`), so a
 * renamed class or data attribute does not break the spec and a renamed LABEL does.
 *
 * It owns its server over a throwaway data root: it changes the density, which may not land in the
 * shared environment.
 */

const sessionId = `e2e-b6-${process.pid}`
const densities = ['comfortable', 'roomy', 'compact', 'ultra'] as const
const artifacts = resolve(import.meta.dirname, '../../../.local/qa/b6-captures')
const LONG_LINES = 420
let browser: AgentBrowser
let server: ChildProcess
let root: string
let url: string
let project: string
let runId: string
let worktree: string
let taskCommit: string
let repoCommit: string
let emulationSocket: WebSocket | undefined
let emulate: (hover: 'none' | 'hover') => Promise<void>

// ---- in-page locators: role + accessible name, or visible text ---------------------------------

const FIND = `
  const ROLE = { button: 'button,[role="button"]', link: 'a[href]', menu: '[role="menu"]', menuitem: '[role="menuitem"]', dialog: '[role="dialog"]', textbox: 'textarea,input:not([type]),input[type="text"]', main: 'main', region: 'section[aria-label]', navigation: 'nav[aria-label]', combobox: 'select', heading: 'h1,h2', status: '[role="status"]', alert: '[role="alert"]' };
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
  // Global settings live outside the project scope; every other page is scoped.
  browser.goto(`${url}${path.startsWith('/settings/global') ? '' : `/p/${project}`}${path}`)
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

// ---- geometry (the B5 recipe) --------------------------------------------------------------------

type Geometry = { targets: string[]; smallest: string; short: string[]; clipped: string[]; overlaps: string[]; invisible: string[]; overflow: boolean }
/** Every actionable target inside `scope`, measured from what a finger can hit. Overlap is checked
 *  only within one layer — a sticky diff header legitimately sits over scrolled rows. */
function geometry(scope: string): Geometry {
  return read(`(() => {
    const parent = ${scope};
    const visible = el => el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[aria-hidden="true"]');
    const nodes = [...parent.querySelectorAll('a[href],button,input,select,textarea,summary,[role="radio"],[role="tab"],[role="switch"],[role="option"],[role="menuitem"]')]
      .filter(visible).filter(el => el.type !== 'hidden' && el.type !== 'file');
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
      if (opacity(el) < 0.5 && !el.disabled) invisible.push(label(el));
      for (const other of nodes) {
        if (el === other || el.contains(other) || other.contains(el) || layer(el) !== layer(other) || !visible(other)) continue;
        const a = box(other);
        if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5) overlaps.push(label(el) + ' / ' + label(other));
      }
    }
    return { targets: nodes.map(label), smallest: Math.round(minW * 10) / 10 + ' x ' + Math.round(minH * 10) / 10, short, clipped, overlaps, invisible, overflow: document.documentElement.scrollWidth > innerWidth };
  })()`)
}
function collect(name: string, scope: string, into: string[], seen: Map<string, string>) {
  let g: Geometry
  try { g = geometry(scope) } catch (cause) { into.push(`${name}: ${String((cause as Error).message).match(/Evaluation error: ([^\\\n"]*)/)?.[1] ?? 'measure failed'}`); return }
  seen.set(name, `${g.targets.length} targets, smallest ${g.smallest}`)
  for (const s of g.short) into.push(`${name}: below 44px: ${s}`)
  for (const s of g.clipped) into.push(`${name}: clipped: ${s}`)
  for (const s of new Set(g.overlaps)) into.push(`${name}: overlap: ${s}`)
  for (const s of g.invisible) into.push(`${name}: invisible touch target: ${s}`)
  if (g.overflow) into.push(`${name}: horizontal page overflow`)
}

// ---- server, fixture and browser -------------------------------------------------------------------

async function waitForStatus(id: string, wanted: string[]): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const record = (await (await fetch(`${url}/api/v1/runs/${id}`)).json()) as { status: string }
    if (wanted.includes(record.status)) return record.status
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`B6: run ${id} never reached ${wanted.join('/')}`)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'xezar-e2e-b6-'))
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'b6@xezar.test')
  git(root, 'config', 'user.name', 'xezar b6')
  // `git diff` (the review gate's endpoint) reports copies only when asked; the worktree shares it.
  git(root, 'config', 'diff.renames', 'copies')
  mkdirSync(join(root, 'src/deep/er'), { recursive: true })
  mkdirSync(join(root, 'old'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# B6 fixture\n')
  writeFileSync(join(root, 'src/base.ts'), Array.from({ length: 30 }, (_, i) => `export const value${i} = ${i}`).join('\n') + '\n')
  writeFileSync(join(root, 'src/deep/er/leaf.ts'), 'export const leaf = true\n')
  writeFileSync(join(root, 'old/name.ts'), Array.from({ length: 20 }, (_, i) => `export const kept${i} = ${i}`).join('\n') + '\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'init')
  git(root, 'branch', 'feature/b6-long-branch-name-for-the-branches-tab')
  writeFileSync(join(root, 'README.md'), '# B6 fixture\n\nA second commit on main.\n')
  git(root, 'commit', '-qam', 'docs: a second commit on main')
  repoCommit = git(root, 'rev-parse', 'HEAD').trim()
  git(root, 'remote', 'add', 'origin', 'git@github.com:acme/b6-e2e.git')
  // An uncommitted edit in the MAIN working tree, for the repository Changes tab.
  writeFileSync(join(root, 'README.md'), '# B6 fixture\n\nA second commit on main.\nAnd an uncommitted line.\n')

  const port = await new Promise<number>((done, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const a = s.address(); const n = typeof a === 'object' && a ? a.port : 0; s.close(() => done(n)) }) })
  url = `http://localhost:${port}`
  server = spawn(process.execPath, [xezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], { env: fixtureServeEnv(root, { XEZ_REVIEW_GATE: '1' }), stdio: 'ignore' })
  let healthy = false
  for (let n = 0; n < 60; n++) { try { if ((await fetch(`${url}/api/v1/health`)).ok) { healthy = true; break } } catch {} await new Promise((r) => setTimeout(r, 250)) }
  if (!healthy) throw new Error('B6 fixture server did not start')
  project = await bootProjectId(url)

  // A live dry run parked at review (the review-gate.e2e.ts recipe).
  const created = (await (await fetch(`${url}/api/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'Reshape the fixture for batch six.', workflow: 'quick-task' }) })).json()) as { id: string }
  runId = created.id
  await waitForStatus(runId, ['waiting'])
  await fetch(`${url}/api/v1/runs/${runId}/finish`, { method: 'POST' })
  if ((await waitForStatus(runId, ['review', 'done'])) !== 'review') throw new Error('B6: the dry run settled as done')
  worktree = ((await (await fetch(`${url}/api/v1/runs/${runId}`)).json()) as { worktreePath: string }).worktreePath

  // Shape the task's branch from the outside: a copy, a rename, a binary image and a long file.
  writeFileSync(join(worktree, 'src/copy.ts'), readFileSync(join(worktree, 'src/base.ts'), 'utf8').replace('value3 = 3', 'value3 = 33'))
  // Plain `git diff` finds a copy only from a file that changed in the same diff, so the source moves too.
  writeFileSync(join(worktree, 'src/base.ts'), readFileSync(join(worktree, 'src/base.ts'), 'utf8').replace('value0 = 0', 'value0 = 100'))
  git(worktree, 'mv', 'old/name.ts', 'src/renamed.ts')
  writeFileSync(join(worktree, 'logo.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  writeFileSync(join(worktree, 'big.txt'), Array.from({ length: LONG_LINES }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
  git(worktree, 'add', '.')
  git(worktree, 'commit', '-qm', 'feat: copy, rename, image and a long file')
  taskCommit = git(worktree, 'rev-parse', 'HEAD').trim()
  // …and one uncommitted edit, so Commit is offered.
  writeFileSync(join(worktree, 'README.md'), '# B6 fixture\n\nEdited in the worktree.\n')

  browser = AgentBrowser.open(sessionId)
  const cli = (...args: string[]) => {
    const result = JSON.parse(execFileSync(readTestEnv().browser.command, ['--session', sessionId, ...args, '--json'], { encoding: 'utf8', timeout: 60_000 }))
    if (!result.success) throw new Error('B6 provider command failed')
    return result.data
  }
  // Launched as a hover device, then touch emulation switches `(hover: none)` on (the B4 recipe).
  cli('--args', '--blink-settings=primaryHoverType=2', 'open', url)
  const socket = new WebSocket(cli('get', 'cdp-url').cdpUrl)
  emulationSocket = socket
  await new Promise<void>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error('B6 emulation connection timed out')), 5_000)
    socket.onopen = () => { clearTimeout(timeout); done() }
    socket.onerror = () => { clearTimeout(timeout); fail(new Error('B6 emulation connection failed')) }
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
    const id = ++nextId, timeout = setTimeout(() => { pending.delete(id); fail(new Error('B6 emulation command timed out')) }, 5_000)
    pending.set(id, { resolve: (value) => { clearTimeout(timeout); done(value) }, reject: (error) => { clearTimeout(timeout); fail(error) } })
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))
  })
  const tab = cli('tab', 'list').tabs.find((t: { active: boolean }) => t.active)
  if (!tab) throw new Error('B6 provider has no active page')
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
const REVIEW = `find('region', 'Review the changes')`
const DIFF_READY = `document.querySelector('[data-slot="diff-file-header"]')`
const measured = new Map<string, Map<string, string>>()

// ---- AC-6: the review gate renders the one engine -------------------------------------------------

describe('AC-6 the review gate diff is the one engine', () => {
  it('copied, renamed and binary cards, word marks, gutters and every line of a long file', () => {
    visit(`/tasks/${runId}`, `${REVIEW}.querySelector('[data-slot="diff-file"][data-path="big.txt"] [data-slot="diff-line"]')`, 1280)
    const facts = read<{ paths: Record<string, string>; bigLines: number; lastLine: string; words: number; toggles: number }>(`(() => {
      const region = ${REVIEW};
      const cards = [...region.querySelectorAll('[data-slot="diff-file"]')];
      const paths = Object.fromEntries(cards.map(card => [card.dataset.path, card.querySelector('header').textContent.replace(/\\s+/g, ' ').trim()]));
      const big = region.querySelector('[data-slot="diff-file"][data-path="big.txt"]');
      const lines = [...big.querySelectorAll('[data-slot="diff-line"]')];
      return { paths, bigLines: lines.length, lastLine: lines.at(-1).textContent, words: region.querySelectorAll('[data-word]').length, toggles: [...region.querySelectorAll('button')].filter(b => /Show all \\d+ lines/.test(b.textContent)).length };
    })()`)
    expect(facts.paths['src/copy.ts']).toMatch(/src\/base\.ts → src\/copy\.ts.*copied/)
    expect(facts.paths['src/renamed.ts']).toMatch(/old\/name\.ts → src\/renamed\.ts.*renamed/)
    expect(facts.paths['logo.png']).toMatch(/binary/)
    expect(facts.bigLines).toBe(LONG_LINES)
    expect(facts.lastLine).toContain(`line ${LONG_LINES}`)
    expect(facts.words).toBeGreaterThan(0)
    expect(facts.toggles).toBe(0)
    browser.screenshot(join(artifacts, 'review-diff-desktop.png'), { viewport: true })
  }, 120_000)
})

// A guard, not a red proof: this fixture's thread is short and settles before the diff mounts, so
// it passes with or without the scroller-resize re-measure in `diff-view.tsx` (checked). It pins
// that the forced virtual tier works at all inside the review gate.
describe('AC-6 a virtualized review diff under the thread still reaches its last line', () => {
  it('?diff=virtual: scrolling to the end of the page renders line 420 of big.txt', () => {
    browser.setViewport(1280, 812)
    browser.goto(`${url}/p/${project}/tasks/${runId}?diff=virtual`)
    until(`${REVIEW}.querySelector('[data-slot="diff-files"][data-virtualized="true"]')`)
    settle()
    // Scroll the one scroller to the bottom in steps, letting virtua mount what comes into view.
    for (let n = 0; n < 40 && !read<boolean>(`[...${REVIEW}.querySelectorAll('[data-slot="diff-line"]')].some(el => /line ${LONG_LINES}$/.test(el.textContent.trim()))`); n++) {
      read(`(() => { const main = find('main'); main.scrollTop = main.scrollTop + main.clientHeight; return true })()`)
      settle()
    }
    expect(read<boolean>(`[...${REVIEW}.querySelectorAll('[data-slot="diff-line"]')].some(el => /line ${LONG_LINES}$/.test(el.textContent.trim()))`)).toBe(true)
  }, 120_000)
})

// ---- AC-0: the phone matrix -------------------------------------------------------------------------

describe('B6 phone matrix', () => {
  it.each(densities)('T-6/T-0 every Git tab and review diff target at %s', (value) => {
    density(value)
    expect(read(`innerWidth`)).toBe(375)
    expect(read(`matchMedia('(hover: none)').matches`)).toBe(true)
    const failures: string[] = []
    const seen = new Map<string, string>()

    visit('/git', DIFF_READY)
    collect('repo Changes', MAIN, failures, seen)
    visit('/git/commits', `find('link', /second commit on main/)`)
    collect('repo Commits', MAIN, failures, seen)
    visit(`/git/commits/${repoCommit}`, DIFF_READY)
    collect('repo commit', MAIN, failures, seen)
    visit('/git/branches', `find('combobox', /base branch/)`)
    collect('repo Branches', MAIN, failures, seen)

    visit(`/tasks/${runId}/changes`, DIFF_READY)
    collect('task Changes', MAIN, failures, seen)
    visit(`/tasks/${runId}/commits`, `find('link', /copy, rename, image/)`)
    collect('task Commits', MAIN, failures, seen)
    visit(`/tasks/${runId}/commits/${taskCommit}`, DIFF_READY)
    collect('task commit', MAIN, failures, seen)
    visit(`/tasks/${runId}/files`, `find('button', 'src')`)
    read(`(() => { find('button', 'src').click(); return true })()`)
    until(`find('button', 'deep')`)
    collect('task Files (folder open)', MAIN, failures, seen)

    visit(`/tasks/${runId}`, `${REVIEW}.querySelector('[data-slot="diff-file-header"]')`)
    collect('review diff', REVIEW, failures, seen)

    measured.set(value, seen)
    expect(failures, `B6 phone matrix at ${value}`).toEqual([])
  }, 290_000)
})

// ---- OD-1 / D-03: one gutter on a desktop -----------------------------------------------------------

describe('OD-1 the Git pages share one gutter on a desktop', () => {
  it.each(['comfortable', 'ultra'] as const)('title, toolbar and body line up at %s', (value) => {
    density(value)
    visit('/git', DIFF_READY, 1280)
    const repo = read<{ title: number; toolbar: number; tree: number; gutter: number; section: number }>(`(() => {
      const left = el => Math.round(el.getBoundingClientRect().left);
      const probe = document.createElement('div'); probe.style.width = 'var(--spacing-section)'; document.body.append(probe);
      const section = Math.round(probe.getBoundingClientRect().width); probe.remove();
      const title = find('heading', 'Git');
      return { title: left(title), toolbar: left(document.querySelector('[data-slot="repo-changes-toolbar"]').firstElementChild), tree: left(find('navigation', 'Changed files')), gutter: left(title) - left(find('main')), section };
    })()`)
    expect(Math.abs(repo.gutter - repo.section), `gutter ${repo.gutter} vs section ${repo.section}`).toBeLessThanOrEqual(1)
    expect(repo.toolbar).toBe(repo.title)
    expect(repo.tree).toBe(repo.title)

    visit(`/tasks/${runId}/changes`, DIFF_READY, 1280)
    const task = read<{ toolbar: number; tree: number; gutter: number }>(`(() => {
      const left = el => Math.round(el.getBoundingClientRect().left);
      const toolbar = document.querySelector('[data-slot="git-toolbar"]').firstElementChild;
      return { toolbar: left(toolbar), tree: left(find('navigation', 'Changed files')), gutter: left(toolbar) - left(find('main')) };
    })()`)
    expect(task.tree).toBe(task.toolbar)
    expect(Math.abs(task.gutter - repo.section)).toBeLessThanOrEqual(1)
    browser.screenshot(join(artifacts, `git-desktop-${value}.png`), { viewport: true })
  }, 120_000)
})

// ---- NB-1 / OD-1: the sticky diff header clears the run header at every density ---------------------

/**
 * The design review's NB-1: the file header parked at a hand-typed `10rem` while the run header's
 * own height moves with the density lever (236 / 197 / 179 / 163 px), so at Roomy and Comfortable
 * the file name and its collapse toggle were covered. The offset is measured now
 * (`--page-header-h`, `src/lib/page-header-offset.ts`), and this is the proof in real layout —
 * jsdom lays nothing out, so no unit test can see a covered header.
 *
 * Red proof: reverting the two pages to `[--diff-sticky-top:10rem]` fails this at roomy and
 * comfortable (the file header's top lands 45 / 37 px above the run header's bottom) and passes at
 * compact and ultra — which is the density dependence OD-1 rules out.
 */
describe('NB-1 a diff’s sticky file header clears the run header', () => {
  it.each(densities)('the file name stays fully visible while scrolling at %s', (value) => {
    density(value)
    visit(`/tasks/${runId}/changes`, DIFF_READY, 1280)
    // Scroll the one scroller until a file card is genuinely scrolled past its own top — only then
    // is its header STUCK, and only a stuck header can be covered.
    const stuck = `(() => {
      const header = document.querySelector('[data-slot="run-header"]').getBoundingClientRect();
      return [...document.querySelectorAll('[data-slot="diff-file"]')].find(el => { const r = el.getBoundingClientRect(); return r.top < header.bottom && r.bottom > header.bottom + 120 }) ?? null
    })()`
    for (let n = 0; n < 20 && !read<boolean>(`Boolean(${stuck})`); n++) {
      read(`(() => { const main = find('main'); main.scrollTop = main.scrollTop + main.clientHeight; return true })()`)
      settle()
    }
    const geo = read<{ headerBottom: number; fileTop: number; paneTop: number; published: number; path: string }>(`(() => {
      const header = document.querySelector('[data-slot="run-header"]').getBoundingClientRect();
      const card = ${stuck};
      if (!card) throw new Error('no diff card scrolled under the run header');
      const file = card.querySelector('[data-slot="diff-file-header"]').getBoundingClientRect();
      const pane = document.querySelector('[data-slot="changes-tree-pane"]').getBoundingClientRect();
      return {
        headerBottom: Math.round(header.bottom),
        fileTop: Math.round(file.top),
        paneTop: Math.round(pane.top),
        published: Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--page-header-h'))),
        path: card.dataset.path,
      }
    })()`)
    // The measured offset IS the run header, not a constant that happens to fit one density.
    expect(Math.abs(geo.published - geo.headerBottom), `published ${geo.published} vs header ${geo.headerBottom}`).toBeLessThanOrEqual(1)
    // …so nothing of the stuck file header (or of the tree pane pinned from the same var) is covered.
    expect(geo.fileTop, `${value}: ${geo.path} header top ${geo.fileTop} vs run header bottom ${geo.headerBottom}`).toBeGreaterThanOrEqual(geo.headerBottom - 1)
    expect(geo.paneTop, `${value}: tree pane top ${geo.paneTop} vs run header bottom ${geo.headerBottom}`).toBeGreaterThanOrEqual(geo.headerBottom - 1)
    browser.screenshot(join(artifacts, `task-changes-sticky-${value}.png`), { viewport: true })
  }, 120_000)
})

// ---- keyboard, cancel, motion ------------------------------------------------------------------------

it('keyboard: the Files tree opens a folder and picks a file with Tab and Enter', async () => {
  await emulate('hover')
  try {
    visit(`/tasks/${runId}/files`, `find('button', 'src')`, 1280)
    read(`(() => { find('button', 'src').focus(); return true })()`)
    browser.press('Enter')
    until(`find('button', /^base\.ts/)`)
    expect(read<string>(`find('button', 'src').getAttribute('aria-expanded')`)).toBe('true')
    // Tab walks into the opened folder: deep → copy.ts … reaches base.ts.
    for (let n = 0; n < 6 && !/^base\.ts/.test(read<string>(`nameOf(document.activeElement)`)); n++) browser.press('Tab')
    expect(read<string>(`nameOf(document.activeElement)`)).toMatch(/^base\.ts/)
    browser.press('Enter')
    until(`document.activeElement.getAttribute('aria-current') === 'true'`)
  } finally {
    await emulate('none')
  }
}, 120_000)

it('cancel: the commit dialog closes on Cancel and on Escape and commits nothing', async () => {
  await emulate('hover')
  try {
    const before = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    // The policy enables Commit once the changes have answered; a click before that does nothing.
    visit(`/tasks/${runId}/changes`, `find('button', /^Commit/).disabled === false`, 1280)
    // Focused and clicked, as a pointer click in Chrome does, so the dialog has an element to hand focus back to.
    read(`(() => { const el = find('button', /^Commit/); el.focus(); el.click(); return true })()`)
    until(`find('dialog')`); settle()
    read(`(() => { find('button', 'Cancel', find('dialog')).click(); return true })()`)
    until(`findAll('dialog').length === 0`)
    expect(read<string>(`nameOf(document.activeElement)`)).toMatch(/^Commit/)
    browser.press('Enter')
    until(`find('dialog')`); settle()
    browser.press('Escape')
    until(`findAll('dialog').length === 0`)
    expect(execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(before)
  } finally {
    await emulate('none')
  }
}, 120_000)

it('T-0 effective reduced motion: nothing loops and no chevron turns on the Git pages', () => {
  browser.setMedia('light', { reducedMotion: true })
  try {
    for (const [path, ready] of [['/git', DIFF_READY], [`/tasks/${runId}/changes`, DIFF_READY], [`/tasks/${runId}/files`, `find('button', 'src')`]] as const) {
      visit(path, ready)
      const running = read<string[]>(`document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity).map(a => a.animationName ?? 'animation')`)
      expect(running, `${path} infinite animations under reduced motion`).toEqual([])
      const turning = read<string[]>(`[...document.querySelectorAll('main svg.lucide-chevron-right')].map(el => getComputedStyle(el).transitionProperty).filter(p => p !== 'none' && p !== 'all' ? /transform|rotate/.test(p) : false)`)
      expect(turning, `${path} chevron transitions under reduced motion`).toEqual([])
    }
  } finally {
    browser.setMedia('light')
  }
}, 120_000)

// ---- contrast ----------------------------------------------------------------------------------------

// Composited contrast through Canvas (the B2–B5 recipe): every ancestor background, the browser's own
// colour parser, genuinely disabled controls exempt.
function contrast(scope: string) {
  return read<{ name: string; color: string; ratio: number; syntax: boolean }[]>(`(() => {
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
      return { name: '"' + el.textContent.trim().slice(0, 30) + '"', color: getComputedStyle(el).color, syntax: Boolean(el.style.color && el.closest('[data-slot="diff-line"], [data-slot="diff-cell"]')), ratio: Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100 };
    });
  })()`)
}

// Light-theme ink tokens already below 4.5:1 as small text (known-gaps G-23). B6 may not change a
// token (#453: B1 owns them), so these colours are reported, not passed; any OTHER colour below the
// line still fails, and so does one of these on a dark surface.
const G23_LIGHT_INKS: Record<string, string> = {
  'rgb(16, 185, 129)': '--success',
  'rgb(239, 68, 68)': '--danger',
  'rgb(143, 134, 232)': '--violet',
}

it.each(['light', 'dark'] as const)('small Git text has composited contrast in %s', (theme) => {
  read(`(() => { localStorage.setItem('xez-theme', '${theme}'); return true })()`)
  browser.setMedia(theme)
  const low: string[] = []
  const known = new Set<string>()
  try {
    for (const [name, path, ready, scope] of [
      ['repo-changes', '/git', DIFF_READY, MAIN],
      ['repo-branches', '/git/branches', `find('combobox', /base branch/)`, MAIN],
      ['task-changes', `/tasks/${runId}/changes`, DIFF_READY, MAIN],
      ['task-files', `/tasks/${runId}/files`, `find('button', 'src')`, MAIN],
      ['review-diff', `/tasks/${runId}`, `${REVIEW}.querySelector('[data-slot="diff-file-header"]')`, REVIEW],
    ] as const) {
      visit(path, ready, 1280)
      browser.screenshot(join(artifacts, `${theme}-${name}.png`), { viewport: true })
      const samples = contrast(scope)
      expect(samples.length).toBeGreaterThan(0)
      for (const sample of samples.filter((s) => s.ratio < 4.5)) {
        // A syntax-theme colour on a diff tint or word mark (known-gaps G-38): `--syn-*` and
        // `--diff-*` are B1's tokens, so it is reported, never passed silently or fixed here.
        const token = sample.syntax ? `G-38 syntax ${sample.color}` : theme === 'light' ? G23_LIGHT_INKS[sample.color] : undefined
        if (token) known.add(`${token} ${sample.name} ${sample.ratio}:1`)
        else low.push(`${name}: ${sample.name} ${sample.color} ${sample.ratio}:1`)
      }
    }
    writeFileSync(join(artifacts, `contrast-${theme}-known-g23-g38.json`), JSON.stringify([...known].sort(), null, 2))
    expect([...new Set(low)], `${theme} small text below 4.5:1`).toEqual([])
  } finally {
    read(`(() => { localStorage.setItem('xez-theme', 'light'); return true })()`)
    browser.setMedia('light')
  }
}, 240_000)

it('records what the phone matrix measured', () => {
  writeFileSync(join(artifacts, 'matrix.json'), JSON.stringify(Object.fromEntries([...measured].map(([d, m]) => [d, Object.fromEntries(m)])), null, 2))
  expect(measured.size).toBe(densities.length)
})
