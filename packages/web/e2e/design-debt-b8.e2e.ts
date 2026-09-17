import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  AgentBrowser,
  bootProjectId,
  fixtureServeEnv,
  removeDataRoot,
  stopFixtureServer,
  xezarCli,
} from './agent-browser'
import record from './fixtures/subagents-run.record.json'

/**
 * Design-debt batch B8 in a real browser — the image preview (#453, A06 / AC-8 / T-8).
 *
 * `packages/web/src/design-debt-b8.test.tsx` proves the component is built out of the Dialog
 * primitive and pins the ledger. It cannot prove the thing A06 is actually about: that a person
 * with a keyboard can open the preview, work inside it and get out again, and that a finger can
 * reach the thumbnail and the close control. jsdom has no layout, no media queries and no real
 * Tab key, so all of that is measured here, from the rendered box, at 375 px across all four
 * densities.
 *
 * What it measures:
 *
 *  1. the thumbnail is a real, named, focusable control, and its rendered hit region is
 *     ≥ 44 × 44 CSS px at comfortable, roomy, compact and "Compact for real";
 *  2. **Enter** and **Space** on the focused thumbnail open the preview — the half of A06 that
 *     was missing entirely, because an `<img>` cannot be focused or activated;
 *  3. focus MOVES into the dialog, and Tab cycles without ever leaving it (focus containment):
 *     pressed more times than the dialog has focusable elements, the active element is still
 *     inside it;
 *  4. **Escape** closes the preview and focus RETURNS to the thumbnail — measured as identity,
 *     not as "something is focused", because `<body>` is what the old version left behind;
 *  5. the Close control is ≥ 44 × 44 px and is the topmost element at its own centre while a
 *     picture wider and taller than the viewport is displayed (AC-8's "zoom/pan does not hide the
 *     close action"), and clicking it closes the preview;
 *  6. the scrim composites to the documented 80 % black over the page, which is the check that
 *     catches someone "tidying" the content's `bg-black/60` to `/80` without noticing the
 *     primitive's own overlay underneath;
 *  7. an image the server does not have is said in words, with no preview offered;
 *  8. no horizontal page overflow, and under `prefers-reduced-motion: reduce` no animation is
 *     RUNNING on the open preview.
 *
 * It owns its server over a throwaway data root, because it changes the density — which must never
 * land in the shared environment another spec reads.
 */

const sessionId = `e2e-design-debt-b8-${process.pid}`
const PHONE = { width: 375, height: 812 } as const
/** Owner decision Q2: a flat 44 px at EVERY density, never a density-scaled height. */
const TAP_PX = 44
/** Roomy and Compact for real give fractional pixels; a floor may round a hair low. */
const TOLERANCE_PX = 0.5

type Density = 'comfortable' | 'roomy' | 'compact' | 'ultra'
const DENSITIES: readonly Density[] = ['comfortable', 'roomy', 'compact', 'ultra']

const RUN_ID = '7c1f2a48-5d63-4e91-b0a7-2f8c6d15e934'
const IMAGE = 'agent-shot.png'
/**
 * The picture the preview enlarges: 600 × 600, generated here rather than committed as a fixture.
 * Bigger than the 375 px viewport in both axes on purpose — the preview really has to scale it
 * down, and the close control really has to sit over it, which is what AC-8's "zoom/pan does not
 * hide the close action" is about. A hand-written base64 blob would be unreadable and unverifiable;
 * this is eleven lines of PNG that any reader can check.
 */
function bigPng(): Buffer {
  const size = 600
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 3)
    raw[row] = 0 // filter: none
    for (let x = 0; x < size; x += 1) {
      const at = row + 1 + x * 3
      raw[at] = 200
      raw[at + 1] = 40 + ((x + y) % 40)
      raw[at + 2] = 60
    }
  }
  const table = Array.from({ length: 256 }, (_unused, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff
    for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc(typed))
    return Buffer.concat([length, typed, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // 8 bits per channel
  header[9] = 2 // truecolour RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const THUMB = '[data-slot="image-zoom-trigger"]'
const LIGHTBOX = '[data-slot="image-lightbox"]'
const CLOSE = `${LIGHTBOX} [data-slot="dialog-close"]`

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let url: string
let project: string

// ---------------------------------------------------------------------------
// Page-side helpers
// ---------------------------------------------------------------------------

/**
 * `rect` reports the PAINTED hit region, `::before` overlay included: the dialog close button is a
 * 16 px glyph in a corner whose 44 px target is drawn by a `before:size-tap` pseudo-element, so
 * the element's own box understates what a finger can hit. This is B1's recipe, kept identical on
 * purpose — two specs measuring "the target" two ways is how one of them starts lying.
 */
const HELPERS = `
  const rect = (el) => {
    const b = el.getBoundingClientRect(), s = getComputedStyle(el, '::before');
    const painted = s.content !== 'none' && s.display !== 'none' && s.position === 'absolute';
    const w = painted ? parseFloat(s.width) || 0 : 0, h = painted ? parseFloat(s.height) || 0 : 0;
    return {
      x: b.x - Math.max(0, w - b.width) / 2,
      y: b.y - Math.max(0, h - b.height) / 2,
      w: Math.max(b.width, w),
      h: Math.max(b.height, h),
    };
  };
  const one = (selector) => {
    const el = [...document.querySelectorAll(selector)].find((n) => {
      const b = n.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    });
    if (el === undefined) throw new Error('design-debt-b8: nothing painted matched ' + selector);
    return el;
  };
  const focused = () => {
    const el = document.activeElement;
    return el === null ? 'null' : (el.tagName + (el.dataset.slot ? '[' + el.dataset.slot + ']' : '')).toLowerCase();
  };
  const topmostAtCentre = (el) => {
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return hit !== null && (hit === el || el.contains(hit));
  };
`

function read<T>(expression: string): T {
  const raw = browser.evaluate(`JSON.stringify((() => {${HELPERS}\nreturn (${expression});\n})())`)
  return JSON.parse(raw as string) as T
}

function until(expression: string): void {
  browser.waitForFunction(`(() => { try { return Boolean(${expression}) } catch { return false } })()`)
}

/** Until nothing that ends is still animating — Radix enters with `zoom-in-95`, and a transformed
 *  box measures small for the ~150 ms the scale runs. A looping animation never stops, so it is
 *  excluded or this would wait forever. */
function settle(): void {
  browser.waitForFunction(
    `document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)`,
  )
}

function openThread(): void {
  browser.goto(`${url}/p/${project}/tasks/${RUN_ID}`)
  until(`document.querySelector('${THUMB}') !== null`)
  settle()
}

function focusThumb(): void {
  browser.evaluate(
    `(() => { const el = document.querySelector('${THUMB}'); el.scrollIntoView({ block: 'center', behavior: 'instant' }); el.focus(); return true })()`,
  )
  until(`document.activeElement === document.querySelector('${THUMB}')`)
}

function openPreview(key: 'Enter' | 'Space'): void {
  focusThumb()
  browser.press(key === 'Space' ? ' ' : 'Enter')
  until(`document.querySelector('${LIGHTBOX}') !== null`)
  settle()
}

function closePreview(): void {
  if (read<boolean>(`document.querySelector('${LIGHTBOX}') !== null`)) {
    browser.press('Escape')
    until(`document.querySelector('${LIGHTBOX}') === null`)
    settle()
  }
}

function chooseDensity(value: Density): void {
  browser.goto(`${url}/settings/global/appearance`)
  until(`document.querySelector('[data-slot="appearance-density"]') !== null`)
  browser.click(`[data-slot="appearance-density"] [data-value="${value}"]`)
  browser.waitForFunction(
    value === 'comfortable'
      ? `document.documentElement.dataset.density === undefined`
      : `document.documentElement.dataset.density === '${value}'`,
  )
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

type Target = { name: string; w: number; h: number }
const thumbTargets = new Map<Density, Target>()
const closeTargets = new Map<Density, Target>()

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xezar-e2e-b8-'))
  mkdirSync(join(dataRoot, '.local/xezar/runs'), { recursive: true })
  mkdirSync(join(dataRoot, '.local/xezar/runs', `${RUN_ID}-images`), { recursive: true })
  // The picture the preview enlarges, where `GET /runs/:id/images/:file` serves it from.
  writeFileSync(join(dataRoot, '.local/xezar/runs', `${RUN_ID}-images`, IMAGE), bigPng())

  // The shared record fixture with this spec's own id: a hand-written record is rejected by the
  // store's per-entry schema and the run then 404s, which reads as "the cockpit is broken" rather
  // than "the fixture is wrong" (B1 seeds its review run the same way).
  writeFileSync(
    join(dataRoot, '.local/xezar/runs.json'),
    JSON.stringify(
      [{ ...record, id: RUN_ID, title: 'Image preview fixture', task: 'Image preview fixture' }],
      null,
      2,
    ),
    'utf8',
  )
  // Two images on purpose: one the server really has, and one it does not, so the honest
  // "Image unavailable" state is measured on a real 404 rather than on a stubbed error.
  writeFileSync(
    join(dataRoot, '.local/xezar/runs', `${RUN_ID}.ndjson`),
    [
      `{"type":"lifecycle","message":"run started","seq":1,"ts":"2026-09-17T10:00:00.000Z"}`,
      `{"type":"image","url":"/api/runs/${RUN_ID}/images/${IMAGE}","name":"${IMAGE}","seq":2,"ts":"2026-09-17T10:00:01.000Z"}`,
      `{"type":"image","url":"/api/runs/${RUN_ID}/images/missing.png","name":"missing.png","seq":3,"ts":"2026-09-17T10:00:02.000Z"}`,
      `{"type":"lifecycle","message":"run finished","seq":4,"ts":"2026-09-17T10:00:10.000Z"}`,
      '',
    ].join('\n'),
    'utf8',
  )

  const port = await new Promise<number>((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const found = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(found))
    })
  })
  url = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [xezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  let healthy = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) {
        healthy = true
        break
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!healthy) throw new Error('design-debt-b8: the fixture server never answered')
  project = await bootProjectId(url)

  browser = AgentBrowser.open(sessionId)
  browser.goto(url)
  browser.setViewport(PHONE.width, PHONE.height)

  // One geometry sweep per density, taken once: each case below reads a slice of it, so a shrunk
  // thumbnail and a shrunk close button fail differently.
  for (const value of DENSITIES) {
    chooseDensity(value)
    openThread()
    thumbTargets.set(value, read<Target>(`(() => { const b = rect(one('${THUMB}')); return { name: 'thumbnail', w: b.w, h: b.h } })()`))
    openPreview('Enter')
    closeTargets.set(value, read<Target>(`(() => { const b = rect(one('${CLOSE}')); return { name: 'close', w: b.w, h: b.h } })()`))
    closePreview()
  }
  chooseDensity('comfortable')
}, 240_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  if (dataRoot) await removeDataRoot(dataRoot)
})

describe('#453 B8 — the image preview in a real browser', () => {
  it('gives the thumbnail a named, focusable control', () => {
    openThread()
    const described = read<{ tag: string; label: string | null; tabIndex: number }>(
      `(() => { const el = one('${THUMB}'); return { tag: el.tagName, label: el.getAttribute('aria-label'), tabIndex: el.tabIndex } })()`,
    )
    expect(described.tag).toBe('BUTTON')
    expect(described.label).toBe(`Open preview of ${IMAGE}`)
    expect(described.tabIndex).toBe(0)
  })

  it.each(DENSITIES)('the thumbnail is at least 44 x 44 px at %s', (value) => {
    const target = thumbTargets.get(value)
    expect(target, `no thumbnail sweep for ${value}`).toBeDefined()
    expect(target!.w).toBeGreaterThanOrEqual(TAP_PX - TOLERANCE_PX)
    expect(target!.h).toBeGreaterThanOrEqual(TAP_PX - TOLERANCE_PX)
  })

  it.each(DENSITIES)('the close control is at least 44 x 44 px at %s', (value) => {
    const target = closeTargets.get(value)
    expect(target, `no close sweep for ${value}`).toBeDefined()
    expect(target!.w).toBeGreaterThanOrEqual(TAP_PX - TOLERANCE_PX)
    expect(target!.h).toBeGreaterThanOrEqual(TAP_PX - TOLERANCE_PX)
  })

  /** The half of A06 that was missing entirely: an `<img>` can be neither focused nor activated. */
  it.each(['Enter', 'Space'] as const)('%s on the focused thumbnail opens the preview', (key) => {
    openThread()
    openPreview(key)
    expect(read<boolean>(`document.querySelector('${LIGHTBOX}') !== null`)).toBe(true)
    closePreview()
  })

  it('moves focus into the dialog and keeps Tab inside it', () => {
    openThread()
    openPreview('Enter')

    expect(read<boolean>(`document.querySelector('${LIGHTBOX}').contains(document.activeElement)`)).toBe(
      true,
    )
    const focusable = read<number>(
      `document.querySelector('${LIGHTBOX}').querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length`,
    )
    // Pressed more times than there are stops, so a trap that leaks shows up as an element
    // outside the dialog rather than as a lucky landing inside it.
    for (let press = 0; press < focusable + 3; press += 1) {
      browser.press('Tab')
      expect(
        read<boolean>(`document.querySelector('${LIGHTBOX}').contains(document.activeElement)`),
        `Tab press ${press + 1} left the dialog (now on ${read<string>('focused()')})`,
      ).toBe(true)
    }
    closePreview()
  })

  /** Identity, not "something has focus": `<body>` is exactly what the old version left behind. */
  it('returns focus to the thumbnail when Escape closes the preview', () => {
    openThread()
    openPreview('Enter')
    browser.press('Escape')
    until(`document.querySelector('${LIGHTBOX}') === null`)
    settle()
    expect(read<boolean>(`document.activeElement === document.querySelector('${THUMB}')`)).toBe(true)
  })

  /**
   * AC-8's "zoom/pan does not hide the close action". The fixture picture is 600 × 600 over a
   * 375 px viewport, so the image really does fill the preview — and the close control still has
   * to be the thing a finger lands on at its own centre.
   */
  it('keeps the close control hittable over a picture larger than the viewport, and it closes', () => {
    openThread()
    openPreview('Enter')

    const image = read<{ w: number; h: number; natural: number }>(
      `(() => { const el = one('${LIGHTBOX} img'); const b = el.getBoundingClientRect(); return { w: b.width, h: b.height, natural: el.naturalWidth } })()`,
    )
    expect(image.natural, 'the fixture PNG must really have loaded').toBeGreaterThan(375)
    expect(image.w).toBeGreaterThan(200)

    expect(read<boolean>(`topmostAtCentre(one('${CLOSE}'))`)).toBe(true)
    browser.click(CLOSE)
    until(`document.querySelector('${LIGHTBOX}') === null`)
    expect(read<boolean>(`document.activeElement === document.querySelector('${THUMB}')`)).toBe(true)
  })

  /**
   * The documented look is an 80 % black scrim, and it is now painted by TWO stacked layers: the
   * primitive's own `DialogOverlay` at `bg-black/50` and the content at `bg-black/60`. This reads
   * the composite rather than either class, so "tidying" one number to `/80` — which would give
   * 90 % — fails here instead of in a screenshot nobody compares.
   */
  it('composites the scrim to the documented 80 per cent black', () => {
    openThread()
    openPreview('Enter')
    // Read as STRINGS and parsed here, because Tailwind v4 serialises these as
    // `oklab(0 0 0 / 0.5)` rather than `rgba(…)` — an `rgba`-only regex matched nothing and threw
    // inside the page, which is a fixture bug wearing the costume of a layout finding.
    const colours = read<string[]>(
      `[...document.querySelectorAll('[data-slot="dialog-overlay"],${LIGHTBOX}')]
        .map((el) => getComputedStyle(el).backgroundColor)`,
    )
    expect(colours, 'the overlay and the content must both paint a scrim').toHaveLength(2)
    const alphas = colours.map((colour) => {
      const slash = colour.match(/\/\s*([\d.]+)\s*\)/)
      const rgba = colour.match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/)
      return Number(slash?.[1] ?? rgba?.[1] ?? 1)
    })
    expect(alphas.every((alpha) => alpha > 0 && alpha <= 1), `unparsed scrim colours: ${colours.join(' + ')}`).toBe(true)

    const composite = 1 - alphas.reduce((clear, alpha) => clear * (1 - alpha), 1)
    expect(composite).toBeCloseTo(0.8, 2)
    closePreview()
  })

  it('says an image the server does not have in words, and offers no preview of it', () => {
    openThread()
    until(`document.querySelector('[data-slot="image-unavailable"]') !== null`)
    const fallback = read<{ text: string; label: string | null; triggers: number }>(
      `(() => {
        const el = one('[data-slot="image-unavailable"]');
        return {
          text: el.textContent.trim(),
          label: el.getAttribute('aria-label'),
          triggers: document.querySelectorAll('${THUMB}').length,
        };
      })()`,
    )
    expect(fallback.text).toBe('Image unavailable')
    expect(fallback.label).toBe('missing.png — image unavailable')
    // The picture that DID load still offers its preview; only the missing one does not.
    expect(fallback.triggers).toBe(1)
  })

  it('adds no horizontal overflow, open or closed', () => {
    openThread()
    const closed = read<{ scrollWidth: number; innerWidth: number }>(
      `({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })`,
    )
    expect(closed.scrollWidth).toBeLessThanOrEqual(closed.innerWidth)

    openPreview('Enter')
    const open = read<{ scrollWidth: number; innerWidth: number }>(
      `({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })`,
    )
    expect(open.scrollWidth).toBeLessThanOrEqual(open.innerWidth)
    closePreview()
  })

  /**
   * The preview inherits the primitive's `motion-safe:`-gated enter animation, so a reader who
   * asked the OS for no animation gets none — including the scrim's fade.
   *
   * The `matchMedia` assertion first, per `AgentBrowser.setMedia`'s own warning: an emulation that
   * silently did nothing and a cockpit that correctly stopped animating look identical from here.
   */
  it('runs no animation under reduced motion', () => {
    browser.setMedia('dark', { reducedMotion: true })
    openThread()
    expect(read<boolean>(`matchMedia('(prefers-reduced-motion: reduce)').matches`)).toBe(true)

    openPreview('Enter')
    const running = read<string[]>(
      `document.getAnimations()
        .filter((a) => a.playState === 'running' && a.constructor.name === 'CSSAnimation')
        .map((a) => a.animationName ?? 'anonymous')`,
    )
    expect(running, 'the preview still animates under prefers-reduced-motion').toEqual([])
    closePreview()

    browser.setMedia('dark')
    expect(read<boolean>(`matchMedia('(prefers-reduced-motion: reduce)').matches`)).toBe(false)
  })
})
