import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  AgentBrowser,
  bootProjectId,
  xezarCli,
  fixtureServeEnv,
  removeDataRoot,
  stopFixtureServer,
} from './agent-browser'
import record from './fixtures/subagents-run.record.json'

/**
 * Design-debt batch B1 in a real browser — the half of AC-1 that jsdom cannot give (#453).
 *
 * `packages/web/src/design-debt-b1.test.tsx` proves the primitives SPELL the absolute phone floor.
 * It says so about itself, at its own line 26: *"jsdom has no layout and no media queries, so
 * `44px at 375px in Compact for real` is browser evidence"*. This file is that evidence, and it is
 * the rule B2–B8 inherit: every batch ships its own `packages/web/e2e/design-debt-b<n>.e2e.ts`.
 *
 * What it measures, at **375 px** across **all four densities** (comfortable, roomy, compact and
 * "Compact for real"):
 *
 *  1. the RENDERED hit region of every primitive named in `REQUIRE_TAP` — ≥ 44 × 44 CSS px;
 *  2. the three `before:size-tap` overlays (switch track, dialog close, sheet close): their own
 *     44 × 44 region, their NON-overlap with every other focusable target on screen, and a real
 *     tap inside the overlay but OUTSIDE the drawn control activating the intended control;
 *  3. the 24 px chip floor where a chip renders;
 *  4. no horizontal overflow — `document.documentElement.scrollWidth <= window.innerWidth` on
 *     every route visited, which is what settles `min-w-tap` on every Button size below `md:`;
 *  5. effective reduced motion — with `prefers-reduced-motion: reduce` emulated, no CSS animation
 *     is RUNNING on an open dropdown, dialog, sheet or tooltip, and none on a pulsing status dot;
 *  6. focus entry on the dialog and the sheet, the `focus-visible` ring idiom on both close
 *     buttons (ring for a keyboard reader, none for a mouse press), and focus return — which
 *     measurement split in two: the nav drawer, which has a real Radix trigger, hands focus back
 *     to it, while a Sheet mounted from state with no trigger drops focus on `<body>`. That second
 *     half is an existing defect in files outside B1's manifest and is PINNED here, red in CI,
 *     rather than left as a sentence in a pull request. The add-account dialog was pinned the same
 *     way until #453 B3 (NB-4) wired its focus return; it now asserts focus on its trigger.
 *
 * Boot doctrine is `agents-dock.e2e.ts`'s: this spec owns its server over a throwaway `dataRoot`,
 * because it needs a replayed sub-agent fan-out (the only Sheet in the cockpit that renders the
 * primitive's own close button) and because it TOGGLES a switch and changes the density, which
 * must never land in the shared environment another spec reads.
 */

const sessionId = `e2e-design-debt-b1-${process.pid}`
const RUN = record
const RUN_ID: string = RUN.id
const REVIEW_RUN = {
  ...record,
  id: '5b7e1c04-3a92-4d6f-8c15-9e2a7f0d4b83',
  title: 'Reference chip and pulsing dot fixture',
  task: 'Reference chip and pulsing dot fixture',
  status: 'review',
  pullRequestUrl: 'https://github.com/example/repo/pull/7',
}

/** The batch's viewport. 375 px is the narrowest phone the spec's mobile rules name. */
const PHONE = { width: 375, height: 812 } as const
/** Owner decision Q2: a flat 44 px at EVERY density, never a density-scaled height. */
const TAP_PX = 44
/** The separate, smaller chip minimum (WCAG 2.2 SC 2.5.8) — never a phone pass. */
const CHIP_PX = 24
/** Roomy and Compact for real give fractional pixels; a floor may round a hair low. */
const TOLERANCE_PX = 0.5

type Density = 'comfortable' | 'roomy' | 'compact' | 'ultra'
const DENSITIES: readonly Density[] = ['comfortable', 'roomy', 'compact', 'ultra']

type Rect = { x: number; y: number; w: number; h: number }
type Target = { name: string; w: number; h: number }
type Overlay = { name: string; owner: Rect; overlay: Rect | null; overlapping: string[] }
type Overflow = { route: string; scrollWidth: number; innerWidth: number }
type Sweep = { targets: Target[]; chips: Target[]; overlays: Overlay[]; overflow: Overflow[] }

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
  throw new Error(`xezar e2e: the design-debt-b1 server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string
/** One sweep per density, taken once in `beforeAll`; each case below asserts a slice of it. */
const sweeps = new Map<Density, Sweep>()

// ---------------------------------------------------------------------------
// Page-side helpers
// ---------------------------------------------------------------------------

/**
 * The geometry vocabulary every expression below shares.
 *
 * `__overlay` is the whole reason this file exists: `getBoundingClientRect()` does NOT include a
 * pseudo-element, so the `before:size-tap` pointer region is invisible to every ordinary query.
 * It is reconstructed from the computed `::before` box — the primitive centres it with
 * `top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2`, so its centre IS the owner's centre — and
 * answers `null` when the pseudo-element is not painted, which is a measurable absence rather
 * than a silent zero.
 */
const HELPERS = `
  const __rect = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } };
  const __overlay = (el) => {
    const style = getComputedStyle(el, '::before');
    if (style.content === 'none' || style.display === 'none') return null;
    const w = parseFloat(style.width), h = parseFloat(style.height);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
    const b = __rect(el);
    return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
  };
  const __hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const __name = (el) => el.dataset.slot ?? el.getAttribute('aria-label') ?? el.tagName.toLowerCase();
  const __reachable = (el) =>
    el.getClientRects().length > 0 &&
    el.closest('[aria-hidden="true"]') === null &&
    el.closest('[inert]') === null &&
    getComputedStyle(el).pointerEvents !== 'none';
  const __focusables = (el) => [...document.querySelectorAll(
    'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[role="switch"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="tab"],[role="option"]'
  )].filter((other) => other !== el && !el.contains(other) && __reachable(other));
  // The first PAINTED match, never merely the first match. Below \`md:\` the cockpit still renders
  // desktop-only surfaces into the DOM at \`display: none\`, so \`querySelector\` can find a box
  // that is 0 x 0 — and a floor check against a box nobody can see is the same lie as no check
  // at all.
  const __measure = (name, selector) => {
    const el = [...document.querySelectorAll(selector)].find((node) => {
      const b = node.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    });
    if (el === undefined) throw new Error('design-debt-b1: nothing painted matched ' + selector + ' for ' + name);
    const b = __rect(el);
    return { name, w: b.w, h: b.h };
  };
  const __sample = (name, selector) => {
    const el = document.querySelector(selector);
    if (el === null) throw new Error('design-debt-b1: nothing matched ' + selector + ' for ' + name);
    // Scrolled into view FIRST, and unconditionally: the settings pane is 1900px long, and a
    // target parked below the fold has an overlay that intersects nothing because nothing else
    // is on screen either. An overlap check that answers "clear" for a row nobody can see is the
    // fail-open this whole file is a correction for.
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const overlay = __overlay(el);
    const overlapping = overlay === null
      ? []
      : __focusables(el).filter((other) => __hits(overlay, __rect(other))).map(__name);
    return { name, owner: __rect(el), overlay, overlapping };
  };
  const __overflow = (route) => ({ route, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth });
  const __running = () => document.getAnimations().filter((a) => a.constructor.name === 'CSSAnimation' && a.playState === 'running');
  const __motion = (name, selector) => {
    const el = document.querySelector(selector);
    if (el === null) throw new Error('design-debt-b1: nothing matched ' + selector + ' for ' + name);
    const style = getComputedStyle(el);
    return { name, animationName: style.animationName, running: el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length };
  };
`

/** Evaluate an expression in the page with `HELPERS` in scope, over JSON so nothing is scraped. */
function read<T>(expression: string): T {
  const raw = browser.evaluate(`JSON.stringify((() => {${HELPERS}\nreturn (${expression});\n})())`)
  return JSON.parse(raw as string) as T
}

// ---------------------------------------------------------------------------
// Routes, selectors and the density lever
// ---------------------------------------------------------------------------

const MENU_BUTTON = '[data-slot="mobile-top-bar"] button[aria-label="Open menu"]'
const DRAWER = '[data-slot="mobile-nav-drawer"]'
/**
 * The drawer is mounted, visible AND still parked at `left: -264` for ~500 ms of its slide, so
 * `!== null` is not "open". Measuring before it settles is off by up to 264 px — the same wait
 * `smoke.e2e.ts:436-439` carries for the same reason.
 */
const DRAWER_SETTLED = `(() => { const d = document.querySelector('${DRAWER}'); return !!d && d.getBoundingClientRect().left === 0 })()`
const ACCOUNTS_TABS = '[data-slot="accounts-tabs"]'
const ADD_ACCOUNT = '[data-action="accounts-add"]'
const ADD_ACCOUNT_DIALOG = '[data-slot="add-account-dialog"]'
const DIALOG_CLOSE = `${ADD_ACCOUNT_DIALOG} [data-slot="dialog-close"]`
const REVIEW_GATE = '[data-slot="agents-review-gate"]'
const LIVE_TITLES = '[data-slot="agents-live-title-updates"]'
const MODEL_PILL = '[data-slot="model-pill"]'
const DOCK = '[data-slot="agents-dock"]'
const AGENT_ROW = '[data-slot="agent-item"]'
const SUBAGENT_SHEET = '[data-slot="subagent-sheet"]'
/**
 * `sheet.tsx:83` gives the primitive's own close button no `data-slot` — only the exported
 * `SheetClose` wrapper carries one. Its stable handle is the `sr-only` label it always renders.
 */
const SHEET_CLOSE = `${SUBAGENT_SHEET} button:has(> span.sr-only)`

function home(): string {
  return `${baseUrl}/p/${bootProject}/`
}

function chooseDensity(value: Density): void {
  browser.goto(`${baseUrl}/settings/global/appearance`)
  browser.waitForFunction(`document.querySelector('[data-slot="appearance-density"]') !== null`)
  browser.click(`[data-slot="appearance-density"] [data-value="${value}"]`)
  browser.waitForFunction(
    value === 'comfortable'
      ? `document.documentElement.dataset.density === undefined`
      : `document.documentElement.dataset.density === '${value}'`,
  )
}

/**
 * Block until a floating surface has finished its enter animation.
 *
 * Radix enters with `zoom-in-95`, and `getBoundingClientRect()` reports the TRANSFORMED box — so
 * a 44 px menu row measures 41.8 px for the ~150 ms the scale is still running. That is not a
 * shrunken target, it is a measurement taken before the surface arrived; a finger taps the rest
 * position. Scoped to the surface's own subtree, and to animations that END: a looping one — a
 * status-dot pulse — never stops, so waiting on it waits
 * forever. An enter animation runs exactly once, which is the only kind that moves a box.
 */
function waitStill(selector: string): void {
  browser.waitForFunction(
    `(() => {
      const el = document.querySelector('${selector}');
      if (el === null) return false;
      return el.getAnimations({ subtree: true })
        .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)
        .length === 0;
    })()`,
  )
}

/**
 * Until an enabled control has held its position for 250 ms. The composer footer reflows a frame
 * or two after the model pill enables, and with 44 px phone pills that reflow wraps the pill onto
 * the next line, so a click aimed at the first position misses it (#453).
 */
function waitPlaced(selector: string): void {
  browser.waitForFunction(
    `(() => {
      const el = document.querySelector('${selector}');
      if (el === null || el.disabled) return false;
      const box = el.getBoundingClientRect();
      const at = box.x + ',' + box.y, now = performance.now();
      if (window.__placed?.at !== at) { window.__placed = { at, since: now }; return false }
      return now - window.__placed.since >= 250;
    })()`,
  )
}

/**
 * Until a control is really there to be clicked: painted, enabled, fully inside the viewport, and
 * the topmost thing at its own centre — then verified to be in the same place twice.
 *
 * This is the fix for #584. Two sites here scrolled a control into view and clicked it in the very
 * next statement, so the click went to whatever was at those coordinates a moment later, and the
 * `beforeAll` failed on "Run actions". `scrollIntoView` without `behavior: 'instant'` competes with
 * the thread scroller, which ends its own restore with a SMOOTH scroll
 * (`thread-scroller.tsx:217`) while virtua writes `scrollTop` from its measurement pass — so the
 * run header keeps moving after it exists, which is why this reproduced alone on a quiet machine
 * rather than only under load.
 *
 * Each check is one of the ways the old code could be wrong, and none is a retry, a longer timeout
 * or a softer assertion. The box must be inside the viewport (G-32's run header can sit partly
 * under the top bar); `elementFromPoint` at its centre must be the control itself (the phone top
 * bar is what was intercepting the click, and a click that lands on the bar is a click the control
 * never sees); and the box must read the same twice, which is what says the scrolling has stopped.
 * If the first two never become true the wait fails loudly naming the control, and a box that is
 * still moving throws with both positions — either is what a real regression should look like.
 *
 * **The predicate is pure, and that is load-bearing.** The first version of this helper kept its
 * own `window.__hittable` stamp to time a 250 ms hold, and it timed out every run: read back after
 * 25 s of polling, `window.__hittable` was still `null`, so the provider's `wait --fn` predicate
 * can READ page state (it observes `window.__samples` written by `eval` perfectly well) but its
 * own writes do not survive between polls. A predicate here must therefore answer from the DOM
 * alone; anything that needs to compare two moments in time is done from Node, as below, where the
 * two reads are two separate calls and the gap between them is real.
 */
/** The nearest ancestor that actually scrolls, as an expression the page can evaluate. */
const SCROLLER = (selector: string) => `(() => {
  const el = document.querySelector('${selector}');
  for (let p = el.parentElement; p; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (/(auto|scroll)/.test(style.overflowY) && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement;
})()`

/**
 * Until the surface around a control stops growing and stops moving.
 *
 * This is the other half of #584, and the half that made it look intermittent. The thread REPLAYS
 * its transcript — the fixture's events arrive over the event stream after the route mounts — and
 * the scroller follows the new content to the bottom with `behavior: 'smooth'` each time
 * (`thread-scroller.tsx:217`). So the run header is not settling into one position and staying
 * there; it is pushed around for as long as events keep arriving. Clearing the top bar before the
 * replay finishes is undone by the next chunk, which is why the same wait passed one run and timed
 * out the next on the same machine.
 *
 * Stability is compared across TWO SEPARATE reads from Node, each a real round trip apart, because
 * a `wait --fn` predicate cannot keep state of its own (see `waitHittable`). Bounded, and it throws
 * with the last two readings rather than waiting forever.
 */
function waitQuiet(selector: string): void {
  type Scroll = { top: number; height: number }
  const state = () => read<Scroll>(`(() => { const s = ${SCROLLER(selector)}; return { top: s.scrollTop, height: s.scrollHeight } })()`)
  let previous = state()
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const current = state()
    if (previous.top === current.top && previous.height === current.height) return
    previous = current
  }
  throw new Error(
    `design-debt-b1: the surface around ${selector} never went quiet — last scrollTop ${previous.top}, scrollHeight ${previous.height}`,
  )
}

function waitHittable(selector: string): void {
  /**
   * Bring the control into view AND out from under whatever fixed chrome covers it, then report
   * where it ended up.
   *
   * `scrollIntoView({ block: 'center' })` alone is not enough here, and that is G-32 rather than a
   * test problem: the thread restores its SAVED scroll position on every revisit, and when the
   * thread is only a little taller than the screen the container cannot scroll far enough to
   * centre the run header — so the header stays pinned near the top, under the phone top bar, and
   * a click at its centre is refused. The loop does what a finger does: notice that something else
   * is on top, drag the scroller back by exactly the overlap plus a small margin, and look again.
   * Bounded, and it never touches the click — an overlap it cannot clear falls through to the wait
   * below, which fails naming the control.
   */
  const scrollAndRead = () =>
    read<{ x: number; y: number; w: number; h: number }>(
      `(() => {
        const el = document.querySelector('${selector}');
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        const scroller = ${SCROLLER(selector)};
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const box = el.getBoundingClientRect();
          const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
          const hit = document.elementFromPoint(cx, cy);
          if (hit === null || hit === el || el.contains(hit)) break;
          // How far down the control has to move to clear what is covering it.
          const cover = hit.getBoundingClientRect();
          const push = Math.ceil(cover.bottom - box.top) + 4;
          if (push <= 0) break;
          const before = scroller.scrollTop;
          scroller.scrollTop = Math.max(0, before - push);
          if (scroller.scrollTop === before) break; // already at the top: nothing left to give
        }
        return __rect(el);
      })()`,
    )

  waitQuiet(selector)
  scrollAndRead()
  browser.waitForFunction(
    `(() => {
      const el = document.querySelector('${selector}');
      if (el === null || el.disabled) return false;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return false;
      if (box.top < 0 || box.left < 0 || box.bottom > window.innerHeight || box.right > window.innerWidth) return false;
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit !== null && (hit === el || el.contains(hit));
    })()`,
  )

  const first = scrollAndRead()
  const second = scrollAndRead()
  if (first.x !== second.x || first.y !== second.y) {
    throw new Error(
      `design-debt-b1: ${selector} is still moving — ${first.x},${first.y} then ${second.x},${second.y}`,
    )
  }
}

function openDrawer(): void {
  browser.click(MENU_BUTTON)
  browser.waitForFunction(DRAWER_SETTLED)
  waitStill(DRAWER)
}

function openSubagentSheet(): void {
  browser.goto(`${baseUrl}/p/${bootProject}/tasks/${RUN_ID}`)
  browser.waitForFunction(`document.querySelector('${DOCK}') !== null`)
  // The same race as "Run actions" (#584), one surface lower: the dock sits at the END of a thread
  // that is still restoring its scroll, so "the dock exists" is not "the dock's toggle is where a
  // click will find it". Both clicks here go through `waitHittable` for that reason — and the
  // agent rows only exist once the first click really landed, so a missed toggle used to surface
  // as "waited for two agent rows and found none", several statements away from its cause.
  waitHittable(`${DOCK} > button`)
  browser.click(`${DOCK} > button`)
  browser.waitForFunction(`document.querySelectorAll('${AGENT_ROW}').length === 2`)
  waitHittable(`${AGENT_ROW}:nth-of-type(2) button`)
  browser.click(`${AGENT_ROW}:nth-of-type(2) button`)
  browser.waitForFunction(`document.querySelector('${SUBAGENT_SHEET}') !== null`)
  // It slides in over ~500 ms; a mid-flight rect is not the rest position this file measures.
  browser.waitForFunction(
    `Math.abs(document.querySelector('${SUBAGENT_SHEET}').getBoundingClientRect().right - window.innerWidth) < 2`,
  )
  waitStill(SUBAGENT_SHEET)
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * Every rendered measurement this batch claims, taken on the screens that render it.
 *
 * Nothing here asserts: a sweep that threw halfway would report a wait timeout instead of the
 * measurement that regressed. The cases below read the collected numbers and name all of them at
 * once, so a shrunk target and a moved neighbour fail differently.
 */
function sweep(): Sweep {
  const targets: Target[] = []
  const chips: Target[] = []
  const overlays: Overlay[] = []
  const overflow: Overflow[] = []

  // --- the project home: the top bar's icon Button, and the Sheet it opens ------------------
  browser.goto(home())
  browser.waitForFunction(`document.querySelector('${MENU_BUTTON}') !== null`)
  targets.push(read<Target>(`__measure('Button size=icon (Open menu)', '${MENU_BUTTON}')`))
  browser.waitForFunction(
    `[...document.querySelectorAll('[data-slot="pr-chip"]')].some((el) => el.getBoundingClientRect().height > 0)`,
  )
  chips.push(read<Target>(`__measure('Chip (reference chip)', '[data-slot="pr-chip"]')`))
  overflow.push(read<Overflow>(`__overflow('/p/:projectId/')`))

  openDrawer()
  targets.push(
    read<Target>(
      `__measure('Button size=default (New task)', '${DRAWER} a[data-slot="button"][data-size="default"]')`,
    ),
    read<Target>(`__measure('Sheet close (drawer)', '${DRAWER} button[aria-label="Close menu"]')`),
  )
  overflow.push(read<Overflow>(`__overflow('/p/:projectId/ + nav drawer')`))
  browser.press('Escape')
  browser.waitForFunction(`document.querySelector('${DRAWER}') === null`)

  // --- the command palette: a Command inside a Dialog ---------------------------------------
  browser.press('Control+k')
  browser.waitForFunction(`document.querySelector('[cmdk-root]') !== null`)
  browser.waitForFunction(`document.activeElement?.hasAttribute('cmdk-input') === true`)
  browser.waitForFunction(`document.querySelectorAll('[cmdk-item]').length > 0`)
  waitStill('[data-slot="dialog-content"]')
  targets.push(
    read<Target>(`__measure('Command input', '[cmdk-input]')`),
    read<Target>(`__measure('Command input wrapper', '[data-slot="command-input-wrapper"]')`),
    read<Target>(`__measure('Command row', '[cmdk-item]')`),
    read<Target>(`__measure('Dialog content (palette)', '[data-slot="dialog-content"]')`),
  )
  overflow.push(read<Overflow>(`__overflow('/p/:projectId/ + command palette')`))
  browser.press('Escape')
  browser.waitForFunction(`document.querySelector('[cmdk-root]') === null`)

  // --- the composer: the icon-sm Button, the chip floor and a DropdownMenu -------------------
  browser.goto(`${baseUrl}/p/${bootProject}/new`)
  waitPlaced(MODEL_PILL)
  targets.push(
    read<Target>(
      `__measure('Button size=icon-sm (composer)', '[data-slot="composer"] button[aria-label="Start task"], [data-slot="composer"] button[aria-label="Plan task"]')`,
    ),
  )
  // A chip is the ONE control that is deliberately not a 44 px phone target: it carries the
  // separate 24 px floor instead, and that floor must hold at every density too.
  chips.push(read<Target>(`__measure('Chip (model pill)', '${MODEL_PILL}')`))
  browser.click(MODEL_PILL)
  browser.waitForFunction(`document.querySelectorAll('[data-slot="dropdown-menu-radio-item"]').length > 0`)
  waitStill('[data-slot="dropdown-menu-content"]')
  targets.push(read<Target>(`__measure('DropdownMenu row', '[data-slot="dropdown-menu-radio-item"]')`))
  overflow.push(read<Overflow>(`__overflow('/p/:projectId/new + model menu')`))
  browser.press('Escape')
  browser.waitForFunction(`document.querySelectorAll('[data-slot="dropdown-menu-radio-item"]').length === 0`)

  // --- the skills filter: an Input ----------------------------------------------------------
  browser.goto(`${baseUrl}/p/${bootProject}/skills`)
  browser.waitForFunction(`document.querySelector('[data-slot="skills-filter"]') !== null`)
  targets.push(read<Target>(`__measure('Input (skills filter)', '[data-slot="skills-filter"]')`))
  overflow.push(read<Overflow>(`__overflow('/p/:projectId/skills')`))

  // --- agent accounts: Tabs, a small Button, and the Dialog close overlay --------------------
  browser.goto(`${baseUrl}/settings/global/accounts`)
  browser.waitForFunction(`document.querySelector('${ACCOUNTS_TABS} [data-slot="tabs-trigger"]') !== null`)
  // EVERY trigger, not the first one. A tab is as wide as its label, so measuring only the widest
  // label in the strip is how `pi` shipped 30.88px wide at ultra (B1-QA-1) past a green suite.
  targets.push(
    ...read<Target[]>(
      `[...document.querySelectorAll('${ACCOUNTS_TABS} [data-slot="tabs-trigger"]')].map((el) => {
        const b = __rect(el);
        return { name: 'Tabs trigger (' + el.textContent.trim() + ')', w: b.w, h: b.h };
      })`,
    ),
    read<Target>(`__measure('Button size=sm (Add account)', '${ADD_ACCOUNT}')`),
  )
  overflow.push(read<Overflow>(`__overflow('/settings/global/accounts')`))

  // A 44px shell bar can leave this control partly below the phone viewport. Wait until the
  // whole target is in view, still and hittable before the pointer click (#584).
  waitHittable(ADD_ACCOUNT)
  browser.click(ADD_ACCOUNT)
  browser.waitForFunction(`document.querySelector('${DIALOG_CLOSE}') !== null`)
  waitStill(ADD_ACCOUNT_DIALOG)
  overlays.push(read<Overlay>(`__sample('Dialog close overlay', '${DIALOG_CLOSE}')`))
  overflow.push(read<Overflow>(`__overflow('/settings/global/accounts + add-account dialog')`))
  browser.press('Escape')
  browser.waitForFunction(`document.querySelector('${ADD_ACCOUNT_DIALOG}') === null`)

  // --- the agents pane: two Switches stacked, which is the overlap claim --------------------
  browser.goto(`${baseUrl}/p/${bootProject}/settings/agents`)
  browser.waitForFunction(`document.querySelector('${REVIEW_GATE}') !== null`)
  overlays.push(
    read<Overlay>(`__sample('Switch overlay (live titles)', '${LIVE_TITLES}')`),
    read<Overlay>(`__sample('Switch overlay (review gate)', '${REVIEW_GATE}')`),
  )
  overflow.push(read<Overflow>(`__overflow('/p/:projectId/settings/agents')`))

  // --- the thread: the phone-only icon-sm Button, its menu, and the Sheet close overlay ------
  browser.goto(`${baseUrl}/p/${bootProject}/tasks/${RUN_ID}`)
  browser.waitForFunction(`document.querySelector('button[aria-label="Run actions"]') !== null`)
  targets.push(
    read<Target>(`__measure('Button size=icon-sm (Run actions)', 'button[aria-label="Run actions"]')`),
  )
  // The thread opens scrolled to its end, the restore finishes with a SMOOTH scroll and virtua
  // keeps correcting `scrollTop` behind it, and the phone run header is not sticky — so the
  // header is still moving, and can sit partly under the top bar, well after it exists. Wait for
  // the control to be in view, still and the topmost thing at its own centre, as a finger would
  // (#584; G-32 is the underlying layout gap).
  waitHittable('button[aria-label="Run actions"]')
  browser.click('button[aria-label="Run actions"]')
  browser.waitForFunction(`document.querySelector('[data-slot="run-actions-menu"] [data-slot="dropdown-menu-item"]') !== null`)
  waitStill('[data-slot="run-actions-menu"]')
  targets.push(
    read<Target>(
      `__measure('DropdownMenu row (run actions)', '[data-slot="run-actions-menu"] [data-slot="dropdown-menu-item"]')`,
    ),
  )
  browser.press('Escape')
  browser.waitForFunction(`document.querySelector('[data-slot="run-actions-menu"]') === null`)

  openSubagentSheet()
  overlays.push(read<Overlay>(`__sample('Sheet close overlay', '${SHEET_CLOSE}')`))
  overflow.push(read<Overflow>(`__overflow('/p/:projectId/tasks/:runId + sub-agent sheet')`))
  browser.press('Escape')
  browser.waitForFunction(`document.querySelector('${SUBAGENT_SHEET}') === null`)

  return { targets, chips, overlays, overflow }
}

function sweepOf(density: Density): Sweep {
  const found = sweeps.get(density)
  if (found === undefined) throw new Error(`design-debt-b1: no sweep for ${density}`)
  return found
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xezar-e2e-b1-'))
  mkdirSync(join(dataRoot, '.local/xezar/runs'), { recursive: true })
  // A second run parked at `review`, carrying a pull request. It buys two things this file must
  // not have to hope for: a reference CHIP to measure the 24px floor on, and a status dot that
  // really pulses (`lib/attention.ts:114`), so the reduced-motion case has something to switch
  // off rather than an empty list that reads as a pass.
  writeFileSync(
    join(dataRoot, '.local/xezar/runs.json'),
    JSON.stringify([RUN, REVIEW_RUN], null, 2),
    'utf8',
  )
  writeFileSync(
    join(dataRoot, '.local/xezar/runs', `${RUN_ID}.ndjson`),
    readFileSync(resolve(import.meta.dirname, 'fixtures/subagents-run.ndjson'), 'utf8'),
    'utf8',
  )

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [xezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(PHONE.width, PHONE.height)

  for (const density of DENSITIES) {
    chooseDensity(density)
    sweeps.set(density, sweep())
  }
  chooseDensity('comfortable')
}, 900_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  await removeDataRoot(dataRoot)
})

// ---------------------------------------------------------------------------
// 1 — the measured floor
// ---------------------------------------------------------------------------

describe('B1 geometry at 375px: every phone target is 44 x 44 for real', () => {
  it.each(DENSITIES)('at %s density', (density) => {
    const short = sweepOf(density)
      .targets.filter(
        (target) => target.w < TAP_PX - TOLERANCE_PX || target.h < TAP_PX - TOLERANCE_PX,
      )
      .map((target) => `${target.name}: ${target.w} x ${target.h}px`)
    expect(short, `targets below ${TAP_PX}px at ${density}`).toEqual([])
  })

  it('measured every primitive the class scan lists in REQUIRE_TAP', () => {
    // The falsifier for this file itself. `design-debt-b1.test.tsx` fails when a primitive stops
    // SPELLING the floor; that is only protection if this file measures the same eight. A ninth
    // primitive added there with no rendered instance here would otherwise pass both.
    const measured = sweepOf('comfortable').targets.map((target) => target.name.toLowerCase())
    const overlays = sweepOf('comfortable').overlays.map((sample) => sample.name.toLowerCase())
    const covered = [...measured, ...overlays].join(' | ')
    const missing = ['button', 'command', 'dialog', 'dropdownmenu', 'input', 'sheet', 'switch', 'tabs'].filter(
      (primitive) => !covered.includes(primitive),
    )
    expect(missing, 'REQUIRE_TAP primitives with no rendered measurement').toEqual([])
  })

  it('the SHORTEST tab label is 44px wide at Compact for real (B1-QA-1)', () => {
    // The regression case QA asked to land with the fix, stated the way the defect was: a
    // two-character label at the smallest density, measured, not inspected. `min-h-tap` alone let
    // this render 30.88 x 44 — right height, unreachable width — and the whole strip had to be
    // measured for it to show, because the other three labels are wide enough to hide it.
    const tabs = sweepOf('ultra').targets.filter((target) => target.name.startsWith('Tabs trigger'))
    expect(tabs.length, 'no tab trigger was measured at ultra').toBeGreaterThanOrEqual(4)
    const narrowest = tabs.reduce((a, b) => (a.w <= b.w ? a : b))
    expect(
      narrowest.w,
      `narrowest tab at ultra is ${narrowest.name} at ${narrowest.w} x ${narrowest.h}px`,
    ).toBeGreaterThanOrEqual(TAP_PX - TOLERANCE_PX)
  })

  it('holds the 24px chip floor at every density', () => {
    const short = DENSITIES.flatMap((density) =>
      sweepOf(density)
        .chips.filter((chip) => chip.h < CHIP_PX - TOLERANCE_PX)
        .map((chip) => `${density} ${chip.name}: ${chip.h}px`),
    )
    expect(short, `chips below ${CHIP_PX}px`).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2 — the three pointer-region overlays (m-3)
// ---------------------------------------------------------------------------

describe('B1 overlays at 375px: 44px of pointer region that belongs to nobody else', () => {
  it.each(DENSITIES)('paints all three overlays at %s density', (density) => {
    const wrong = sweepOf(density)
      .overlays.filter(
        (sample) =>
          sample.overlay === null ||
          sample.overlay.w < TAP_PX - TOLERANCE_PX ||
          sample.overlay.h < TAP_PX - TOLERANCE_PX,
      )
      .map((sample) =>
        sample.overlay === null
          ? `${sample.name}: no ::before painted`
          : `${sample.name}: ${sample.overlay.w} x ${sample.overlay.h}px`,
      )
    expect(wrong, `overlays below ${TAP_PX}px at ${density}`).toEqual([])
  })

  it.each(DENSITIES)('overlaps no other focusable target at %s density', (density) => {
    // `switch.tsx:24` argues in prose that "settings rows stack far enough apart that it never
    // covers its neighbour". This is the measurement behind that sentence — and the general case
    // the review asked for: an overlay that swallowed a neighbour's tap would, on a dialog close,
    // close the dialog.
    const collisions = sweepOf(density)
      .overlays.filter((sample) => sample.overlapping.length > 0)
      .map((sample) => `${sample.name} covers ${sample.overlapping.join(', ')}`)
    expect(collisions, `overlay collisions at ${density}`).toEqual([])
  })

  it('a tap inside the switch overlay but off the track still toggles the switch', () => {
    browser.goto(`${baseUrl}/p/${bootProject}/settings/agents`)
    browser.waitForFunction(`document.querySelector('${REVIEW_GATE}') !== null`)
    const before = read<string | null>(
      `document.querySelector('${REVIEW_GATE}').getAttribute('aria-checked')`,
    )
    const sample = read<Overlay>(`__sample('switch', '${REVIEW_GATE}')`)
    expect(sample.overlay).not.toBeNull()
    const overlay = sample.overlay!

    // The centre first, as the review asked — then the point that actually proves the overlay:
    // inside it, below the 18px track, where nothing is drawn at all.
    browser.tapAt(Math.round(overlay.x + overlay.w / 2), Math.round(overlay.y + overlay.h / 2))
    browser.waitForFunction(
      `document.querySelector('${REVIEW_GATE}').getAttribute('aria-checked') !== '${before}'`,
    )

    const offTrack = Math.round(sample.owner.y + sample.owner.h + (overlay.y + overlay.h - sample.owner.y - sample.owner.h) / 2)
    expect(offTrack).toBeGreaterThan(Math.round(sample.owner.y + sample.owner.h))
    expect(offTrack).toBeLessThan(Math.round(overlay.y + overlay.h))
    browser.tapAt(Math.round(overlay.x + overlay.w / 2), offTrack)
    browser.waitForFunction(
      `document.querySelector('${REVIEW_GATE}').getAttribute('aria-checked') === '${before}'`,
    )
  }, 120_000)

  it('a tap inside the dialog close overlay but off the glyph closes the dialog', () => {
    browser.goto(`${baseUrl}/settings/global/accounts`)
    browser.waitForFunction(`document.querySelector('${ADD_ACCOUNT}') !== null`)
    browser.click(ADD_ACCOUNT)
    browser.waitForFunction(`document.querySelector('${DIALOG_CLOSE}') !== null`)
    const sample = read<Overlay>(`__sample('dialog close', '${DIALOG_CLOSE}')`)
    const overlay = sample.overlay!
    // Left of the 16px glyph, still inside the 44px overlay.
    const offGlyph = Math.round(sample.owner.x - (sample.owner.x - overlay.x) / 2)
    expect(offGlyph).toBeLessThan(Math.round(sample.owner.x))
    expect(offGlyph).toBeGreaterThan(Math.round(overlay.x))
    browser.tapAt(offGlyph, Math.round(overlay.y + overlay.h / 2))
    browser.waitForFunction(`document.querySelector('${ADD_ACCOUNT_DIALOG}') === null`)
  }, 120_000)

  it('a tap inside the sheet close overlay but off the glyph closes the sheet', () => {
    openSubagentSheet()
    const sample = read<Overlay>(`__sample('sheet close', '${SHEET_CLOSE}')`)
    const overlay = sample.overlay!
    const offGlyph = Math.round(sample.owner.x - (sample.owner.x - overlay.x) / 2)
    expect(offGlyph).toBeLessThan(Math.round(sample.owner.x))
    expect(offGlyph).toBeGreaterThan(Math.round(overlay.x))
    browser.tapAt(offGlyph, Math.round(overlay.y + overlay.h / 2))
    browser.waitForFunction(`document.querySelector('${SUBAGENT_SHEET}') === null`)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// 3 — no sideways scroll (m-2)
// ---------------------------------------------------------------------------

describe('B1 layout at 375px: the 44px floors cost no horizontal overflow', () => {
  it.each(DENSITIES)('no route scrolls sideways at %s density', (density) => {
    // CODE_REVIEW.md § Severity makes sideways scroll at 375px a Major, and `min-w-tap` on every
    // Button size below `md:` is exactly the change that could cause it.
    const wide = sweepOf(density)
      .overflow.filter((view) => view.scrollWidth > view.innerWidth)
      .map((view) => `${view.route}: ${view.scrollWidth}px > ${view.innerWidth}px`)
    expect(wide, `routes overflowing at ${density}`).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4 — effective reduced motion (A-05, G-06, G-08)
// ---------------------------------------------------------------------------


describe('B1 motion: prefers-reduced-motion actually stops the cockpit moving', () => {
  type Motion = { name: string; animationName: string; running: number }

  /** Open each guarded surface in turn and read what its CSS actually declares, and what runs. */
  function surfaces(): Motion[] {
    const seen: Motion[] = []

    browser.goto(home())
    browser.waitForFunction(`document.querySelector('${MENU_BUTTON}') !== null`)

    openDrawer()
    seen.push(read<Motion>(`__motion('sheet (nav drawer)', '${DRAWER}')`))
    seen.push(read<Motion>(`__motion('sheet overlay', '[data-slot="sheet-overlay"]')`))
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('${DRAWER}') === null`)

    browser.press('Control+k')
    browser.waitForFunction(`document.querySelector('[cmdk-root]') !== null`)
    waitStill('[data-slot="dialog-content"]')
    seen.push(read<Motion>(`__motion('dialog (command palette)', '[data-slot="dialog-content"]')`))
    seen.push(read<Motion>(`__motion('dialog overlay', '[data-slot="dialog-overlay"]')`))
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('[cmdk-root]') === null`)

    browser.goto(`${baseUrl}/p/${bootProject}/new`)
    waitPlaced(MODEL_PILL)
    browser.click(MODEL_PILL)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="dropdown-menu-radio-item"]').length > 0`)
    waitStill('[data-slot="dropdown-menu-content"]')
    seen.push(read<Motion>(`__motion('dropdown menu', '[data-slot="dropdown-menu-content"]')`))
    browser.press('Escape')
    browser.waitForFunction(`document.querySelectorAll('[data-slot="dropdown-menu-radio-item"]').length === 0`)

    return seen
  }

  /**
   * A pulsing status dot, guaranteed rather than hoped for.
   *
   * `lib/attention.ts:114` pulses a run parked at `review`, which is why the fixture seeds one.
   * Asserting the dot EXISTS before asserting it is still is the whole point: "nothing pulses"
   * and "nothing was on screen" must not be the same green.
   */
  function pulsingDots(): { tone: string; animationName: string; background: string }[] {
    browser.goto(home())
    browser.waitForFunction(`document.querySelector('[data-slot="status-dot"]') !== null`)
    return read<{ tone: string; animationName: string; background: string }[]>(
      `[...document.querySelectorAll('[data-slot="status-dot"]')].map((el) => ({ tone: el.dataset.tone ?? 'dot', animationName: getComputedStyle(el).animationName, background: getComputedStyle(el).backgroundColor }))`,
    )
  }

  it('with motion allowed, every guarded surface really declares an animation', () => {
    // The populated-input guarantee AGENTS.md § *A fail-open helper needs a populated-input
    // guarantee, or it lies* demands. Against a surface that never animated, "reduced motion
    // works" and "there was nothing to switch off" are the same result — and `motion-safe:`
    // removes the DECLARATION, so the computed `animation-name` is the honest witness: it is a
    // property of the stylesheet, not of whether a 150ms animation happens to be mid-flight.
    expect(read<boolean>(`matchMedia('(prefers-reduced-motion: reduce)').matches`)).toBe(false)
    const silent = surfaces()
      .filter((surface) => surface.animationName === 'none')
      .map((surface) => surface.name)
    expect(silent, 'surfaces with no animation to switch off — the reduce check would be vacuous').toEqual(
      [],
    )
  }, 180_000)

  it('with motion allowed, a status dot really pulses', () => {
    const dots = pulsingDots()
    expect(dots.length, 'no status dot on screen').toBeGreaterThan(0)
    expect(
      dots.filter((dot) => dot.animationName !== 'none').length,
      'no status dot pulses — the reduce check below would be vacuous',
    ).toBeGreaterThan(0)
  }, 120_000)

  it('stops every animation on the dropdown, dialog, sheet and their overlays', () => {
    browser.setMedia('light', { reducedMotion: true })
    try {
      browser.goto(home())
      browser.waitForFunction(`document.querySelector('${MENU_BUTTON}') !== null`)
      // The emulation itself is verified, never assumed: an emulation that silently did nothing
      // and a cockpit that correctly stopped moving look identical from the outside.
      expect(read<boolean>(`matchMedia('(prefers-reduced-motion: reduce)').matches`)).toBe(true)

      const moving = surfaces()
        .filter((surface) => surface.animationName !== 'none' || surface.running > 0)
        .map((surface) => `${surface.name}: ${surface.animationName} (${surface.running} running)`)
      expect(moving, 'surfaces still animating under prefers-reduced-motion').toEqual([])
    } finally {
      browser.setMedia('light')
    }
  }, 240_000)

  it('stops the status dot pulse without losing which state the dot means', () => {
    browser.setMedia('light', { reducedMotion: true })
    try {
      const dots = pulsingDots()
      expect(dots.length, 'no status dot on screen').toBeGreaterThan(0)
      expect(
        dots.filter((dot) => dot.animationName !== 'none').map((dot) => `${dot.tone}: ${dot.animationName}`),
        'status dots still pulsing under reduced motion',
      ).toEqual([])
      // The colour, not the motion, is what names the state — switching the pulse off must lose
      // no information. A transparent dot would mean it had.
      expect(
        dots.filter((dot) => dot.background === 'rgba(0, 0, 0, 0)').map((dot) => dot.tone),
        'status dots with no colour left to read',
      ).toEqual([])
    } finally {
      browser.setMedia('light')
    }
  }, 120_000)

  it('stops the tooltip, measured at the width that has one', () => {
    // The desktop width is deliberate and is not a hole in the 375px rule: the cockpit renders no
    // tooltip trigger below `md:` at all, and a tooltip check that quietly found nothing to hover
    // would be exactly the vacuous pass this file exists to refuse. The rule under test is a
    // media query, not a breakpoint.
    browser.setViewport(1280, 900)
    browser.setMedia('light', { reducedMotion: true })
    try {
      browser.goto(home())
      browser.waitForFunction(`document.querySelector('[data-slot="tooltip-trigger"]') !== null`)
      expect(read<boolean>(`matchMedia('(prefers-reduced-motion: reduce)').matches`)).toBe(true)
      browser.hover('[data-slot="tooltip-trigger"]')
      browser.waitForFunction(`document.querySelector('[data-slot="tooltip-content"]') !== null`)
      const tooltip = read<Motion>(`__motion('tooltip', '[data-slot="tooltip-content"]')`)
      expect(`${tooltip.animationName} (${tooltip.running} running)`).toBe('none (0 running)')
    } finally {
      browser.setMedia('light')
      browser.setViewport(PHONE.width, PHONE.height)
    }
  }, 180_000)

  it('names the one guarded primitive with no rendered instance, rather than passing over it', () => {
    // `Skeleton` has a single importer in the whole cockpit — the forge-gated GitHub tab — so no
    // route this file visits renders one, and its `motion-reduce:animate-none` is covered by
    // `design-debt-b1.test.tsx` at the render level instead. This case pins that absence: the day
    // a batch puts a skeleton on one of these screens, this goes red and the coverage follows it
    // here, rather than a browser check silently continuing to measure nothing.
    const routes = ['/', '/new', '/skills', `/tasks/${RUN_ID}`]
    const found = routes.flatMap((route) => {
      browser.goto(`${baseUrl}/p/${bootProject}${route}`)
      browser.waitForFunction(`document.querySelector('[data-slot="app-shell"]') !== null`)
      const count = read<number>(`document.querySelectorAll('[data-slot="skeleton"]').length`)
      return count > 0 ? [`${route}: ${count}`] : []
    })
    expect(found, 'a Skeleton now renders here and this file must measure it').toEqual([])
  }, 180_000)
})

// ---------------------------------------------------------------------------
// 5 — focus entry and return on the two close buttons (G-06)
// ---------------------------------------------------------------------------

describe('B1 focus: the dialog and sheet closes enter, ring and return', () => {
  /** `:focus-visible` as a mouse press leaves it, then as a keyboard walk leaves it. */
  function ringStates(selector: string): { reached: boolean; mouse: boolean; keyboard: boolean } {
    return read<{ reached: boolean; mouse: boolean; keyboard: boolean }>(
      `(() => {
        const el = document.querySelector('${selector}');
        el.focus();
        const mouse = el.matches(':focus-visible');
        // The blur is load-bearing: focus() on an ALREADY focused element is a no-op, so without
        // it the second call never re-decides focus-visible and the keyboard case reads the mouse
        // one back — green for the wrong reason.
        el.blur();
        el.focus({ focusVisible: true });
        return { reached: document.activeElement === el, mouse, keyboard: el.matches(':focus-visible') };
      })()`,
    )
  }

  it('the dialog takes focus, and rings its close for a keyboard reader only', () => {
    browser.goto(`${baseUrl}/settings/global/accounts`)
    browser.waitForFunction(`document.querySelector('${ADD_ACCOUNT}') !== null`)
    browser.click(ADD_ACCOUNT)
    browser.waitForFunction(`document.querySelector('${DIALOG_CLOSE}') !== null`)

    // Entry: focus moved into the dialog rather than staying behind on the trigger.
    expect(
      read<boolean>(`document.querySelector('${ADD_ACCOUNT_DIALOG}').contains(document.activeElement)`),
      'the dialog opened without taking focus',
    ).toBe(true)

    const ring = ringStates(DIALOG_CLOSE)
    expect(ring.reached).toBe(true)
    expect(ring.mouse, 'the close paints a ring for a mouse press (the pre-focus-visible idiom)').toBe(false)
    expect(ring.keyboard, 'the close paints no ring for a keyboard reader').toBe(true)

    // …and the close really closes on a keyboard activation.
    browser.press('Enter')
    browser.waitForFunction(`document.querySelector('${ADD_ACCOUNT_DIALOG}') === null`)
  }, 120_000)

  it('a Sheet with a real trigger hands focus back to that trigger on close', () => {
    // Focus RETURN, on the one surface where it is well defined: the nav drawer is the cockpit's
    // only floating surface opened through a real Radix trigger, so Radix has somewhere to put
    // focus back. The case below records what happens on the ones that have none.
    browser.goto(home())
    browser.waitForFunction(`document.querySelector('${MENU_BUTTON}') !== null`)
    openDrawer()
    expect(
      read<boolean>(`document.querySelector('${DRAWER}').contains(document.activeElement)`),
      'the drawer opened without taking focus',
    ).toBe(true)

    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('${DRAWER}') === null`)
    browser.waitForFunction(`document.activeElement?.matches('[data-slot="sheet-trigger"]') === true`)
  }, 120_000)

  it('the sheet takes focus, and rings its close the same way', () => {
    openSubagentSheet()
    expect(
      read<boolean>(`document.querySelector('${SUBAGENT_SHEET}').contains(document.activeElement)`),
      'the sheet opened without taking focus',
    ).toBe(true)

    const ring = ringStates(SHEET_CLOSE)
    expect(ring.reached).toBe(true)
    expect(ring.mouse, 'the sheet close paints a ring for a mouse press').toBe(false)
    expect(ring.keyboard, 'the sheet close paints no ring for a keyboard reader').toBe(true)

    browser.press('Enter')
    browser.waitForFunction(`document.querySelector('${SUBAGENT_SHEET}') === null`)
  }, 120_000)

  /** What `document.activeElement` is, as a name a failure message can print. */
  function activeName(): string {
    return read<string>(
      `document.activeElement === null || document.activeElement === document.body
        ? 'body'
        : (document.activeElement.dataset.slot ?? document.activeElement.dataset.action ?? document.activeElement.getAttribute('aria-label') ?? document.activeElement.tagName)`,
    )
  }

  it('pins focus return on the two state-mounted surfaces — the dialog restores it, the sheet does not yet', () => {
    // MEASURED, not assumed: a Dialog or Sheet mounted from state with NO Radix trigger has
    // nothing to restore focus to unless its owner wires `onCloseAutoFocus`, so closing it lands a
    // keyboard reader on `<body>` — at the top of the document, with the whole page to walk
    // again. Reproduced first on the add-account dialog with the trigger genuinely focused, and
    // on the sub-agent sheet; the nav drawer, which HAS a trigger, restores correctly.
    //
    // B1 changed these two close buttons' ring classes and nothing else — the trigger wiring lives
    // in `routes/settings/accounts-section.tsx` and `routes/task-thread/subagent-sheet.tsx`, both
    // outside B1's file manifest. This case exists so the defect is red in CI rather than true
    // only in a PR comment: the batch that fixes the wiring flips its expectation. #453 B3 (NB-4)
    // did that for the dialog; the sheet's half is still the pinned defect.
    browser.goto(`${baseUrl}/settings/global/accounts`)
    browser.waitForFunction(`document.querySelector('${ADD_ACCOUNT}') !== null`)
    read<boolean>(`(() => { document.querySelector('${ADD_ACCOUNT}').focus({ focusVisible: true }); return true })()`)
    browser.click(ADD_ACCOUNT)
    browser.waitForFunction(`document.querySelector('${DIALOG_CLOSE}') !== null`)
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('${ADD_ACCOUNT_DIALOG}') === null`)
    // Radix restores focus from its unmount path, which can land after the node is gone, so wait
    // for it rather than sample once. Every Button carries `data-slot="button"`, so `activeName()`
    // cannot tell the trigger from any other button: name the trigger only when focus is on that
    // exact element, and print whatever holds focus if it never gets there.
    let afterDialog: string
    try {
      browser.waitForFunction(`document.activeElement?.matches('${ADD_ACCOUNT}') === true`)
      afterDialog = 'accounts-add'
    } catch {
      afterDialog = activeName()
    }

    openSubagentSheet()
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('${SUBAGENT_SHEET}') === null`)
    const afterSheet = activeName()

    // #453 B3 NB-4 fixed the add-account half: the dialog now hands focus back to the "Add
    // account" trigger it was opened from, so that half asserts the RESTORED state. The sub-agent
    // sheet is still unwired and stays pinned on `<body>`.
    expect(
      { dialog: afterDialog, sheet: afterSheet },
      'focus return changed — update this case and move the surface to the trigger case above',
    ).toEqual({ dialog: 'accounts-add', sheet: 'body' })
  }, 180_000)
})
