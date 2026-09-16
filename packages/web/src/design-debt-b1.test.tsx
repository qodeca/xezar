import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Button } from '@/components/ui/button'
import { Input, nativeFieldClass } from '@/components/ui/input'
import { PopoverTitle } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusDot } from '@/components/status-dot'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

/**
 * Design-debt batch B1 — primitives, motion, focus and token contrast (#453, AC-1).
 *
 * Four groups, one per named break in T-1. Each group fails for its own break and for nothing
 * else, so a red run names the thing that regressed:
 *
 *  - GEOMETRY  — restoring the density-scaled `h-9` / the 30px icon target as the whole story.
 *  - MOTION    — restoring an unconditional tooltip or dialog animation.
 *  - SEMANTIC  — restoring the `div` PopoverTitle.
 *  - CONTRAST  — restoring the old light `--soft-foreground`, `--violet-foreground` or
 *                `--danger-foreground`.
 *
 * What this file does NOT claim: it reads classes and token values, not rendered pixels. jsdom has
 * no layout and no media queries, so "44px at 375px in Compact for real" is browser evidence and
 * belongs to the batch's browser suite and its QA pass. What the classes CAN settle is that the
 * absolute floor is spelled at all — which is exactly what the density lever silently removed.
 */

const WEB_ROOT = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.join(WEB_ROOT, 'components', 'ui')
const INDEX_CSS = path.join(WEB_ROOT, 'styles', 'index.css')
const COVERAGE_MD = path.join(WEB_ROOT, '..', '..', '..', 'docs', 'design-system', 'coverage.md')

afterEach(cleanup)

/** Comments describe the rules these scans enforce and would otherwise trip every one of them. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function primitiveSources(): { name: string; source: string }[] {
  return readdirSync(UI_DIR)
    .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
    .sort()
    .map((name) => ({ name, source: stripComments(readFileSync(path.join(UI_DIR, name), 'utf8')) }))
}

/** Every class-looking token in a source file, so a rule can ask "is this one prefixed?". */
function classTokens(source: string): string[] {
  return [...source.matchAll(/[\w[\]$:./&*=,'\\-]*animate-[\w-]+/g)].map((m) => m[0])
}

/**
 * The class string one token sits in — the `"…"`, `'…'` or backtick literal that encloses it.
 *
 * `motion-reduce:animate-none` is a class on the SAME element as the animation it switches off, so
 * "is this occurrence guarded?" is a question about one class string and never about the file.
 * Asking the file is fail-open: one guard anywhere exempts every animation in it, and a second,
 * unguarded spinner added to a file that already carries a guard passes green (AGENTS.md § *A
 * fail-open helper needs a populated-input guarantee, or it lies*). A token that sits inside no
 * literal is enclosed by nothing and is therefore never exempt.
 */
function enclosingClassString(source: string, at: number): string {
  for (const literal of source.matchAll(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g)) {
    const start = literal.index
    if (start <= at && at < start + literal[0].length) return literal[0]
  }
  return ''
}

/** Looping animations that nothing on their own element switches off, one entry per occurrence. */
function unguardedLoopingAnimations(name: string, source: string): string[] {
  return [...source.matchAll(/[\w[\]$:./&*=,'\\-]*animate-(?:pulse|spin|bounce|ping)\b/g)]
    .filter((match) => !match[0].includes('motion-safe:'))
    .filter((match) => !/motion-reduce:animate-none/.test(enclosingClassString(source, match.index)))
    .map((match) => `${name}: ${match[0]}`)
}

// ---------------------------------------------------------------------------
// GEOMETRY — the absolute phone target floor (owner decision Q2: 44px at EVERY density)
// ---------------------------------------------------------------------------

describe('B1 geometry: primitives carry the absolute phone target floor', () => {
  // `h-11` is 44 / 55 / 38.5 / 33px at comfortable / roomy / compact / ultra, so a
  // density-scaled height cannot BE the floor. `--spacing-tap` is a flat 44px; `md:` releases it.
  it.each([
    { size: 'default' },
    { size: 'sm' },
    { size: 'icon' },
    { size: 'icon-sm' },
  ] as const)('Button size=$size pins min-h-tap / min-w-tap and releases both at md', ({ size }) => {
    render(<Button size={size}>Label</Button>)
    const button = screen.getByRole('button')

    expect(button.className).toContain('min-h-tap')
    expect(button.className).toContain('min-w-tap')
    expect(button.className).toContain('md:min-h-0')
    expect(button.className).toContain('md:min-w-0')
  })

  it('Button small sizes are on the spacing scale, not hand-typed pixels', () => {
    render(<Button size="sm">Label</Button>)
    expect(screen.getByRole('button').className).toContain('h-7.5')
    expect(screen.getByRole('button').className).not.toContain('h-[30px]')
  })

  it('Input pins the floor; Textarea is above it at every density without one', () => {
    render(<Input aria-label="Name" />)
    const input = screen.getByRole('textbox', { name: 'Name' })
    expect(input.className).toContain('min-h-tap')
    expect(input.className).toContain('md:min-h-0')

    cleanup()
    render(<Textarea aria-label="Body" />)
    // `min-h-16` is 64px at comfortable and still 48px at "Compact for real". A second `min-h-*`
    // would only fight the first, so the absence here is deliberate and pinned.
    const textarea = screen.getByRole('textbox', { name: 'Body' })
    expect(textarea.className).toContain('min-h-16')
    expect(textarea.className).not.toContain('min-h-tap')
  })

  it('Switch grows a 44px pointer overlay rather than a 44px track', () => {
    render(<Switch aria-label="Follow-ups" />)
    const track = screen.getByRole('switch')

    // The root IS the visible track, so the target is a centred pseudo-element on it.
    expect(track.className).toContain('before:size-tap')
    expect(track.className).toContain('md:before:hidden')
    expect(track.className).toContain('relative')
    // …and the track keeps its own small geometry, on the scale.
    expect(track.className).toContain('data-[size=default]:h-4.5')
  })

  it('the shared native-field class carries the same floor', () => {
    // Settings and the branch picker keep a raw <select> on purpose (G-11); they get the styling
    // from here rather than from a second, half-adopted primitive.
    expect(nativeFieldClass).toContain('min-h-tap')
    expect(nativeFieldClass).toContain('md:min-h-0')

    // …and the same iOS rule `Input` itself carries (design review NB-3): Safari zooms the page
    // when a focused field's text is under 16px, and this string is about to be copied into two
    // dozen raw `<input>`/`<select>` sites. A flat `text-sm` is that zoom, waiting.
    expect(nativeFieldClass).toContain('text-base')
    expect(nativeFieldClass).toContain('md:text-sm')
    expect(nativeFieldClass).not.toMatch(/(?<![\w:-])text-sm/)
  })

  it('every primitive that sizes a row or a control spells the floor on the axes that need it', () => {
    // A guard against the floor being added to four files and forgotten in the fifth — and, since
    // B1-QA-1, against it being added on ONE AXIS and called done. The old sweep accepted any of
    // the three spellings anywhere in the file, so `tabs.tsx` passed on `min-h-tap` alone while a
    // two-character tab label ("pi") rendered 30.88px wide at ultra. Which axes a primitive needs
    // is a property of how its control is sized, so it is stated per file rather than guessed:
    //
    //  - `both`    the control is content-sized on BOTH axes, so a short label can shrink it.
    //  - `height`  the control stretches to its container's width (`w-full`, `flex-1` in a column),
    //              so only the height can fall under the floor.
    //  - `overlay` the drawn control IS the design and must not grow, so a centred
    //              `before:size-tap` carries both axes at once.
    const REQUIRE_TAP: { file: string; axes: 'both' | 'height' | 'overlay' }[] = [
      { file: 'button.tsx', axes: 'both' },
      { file: 'command.tsx', axes: 'height' },
      { file: 'dialog.tsx', axes: 'overlay' },
      { file: 'dropdown-menu.tsx', axes: 'height' },
      { file: 'input.tsx', axes: 'height' },
      { file: 'sheet.tsx', axes: 'overlay' },
      { file: 'switch.tsx', axes: 'overlay' },
      { file: 'tabs.tsx', axes: 'both' },
    ]
    const NEEDED = {
      both: ['min-h-tap', 'min-w-tap'],
      height: ['min-h-tap'],
      overlay: ['before:size-tap'],
    } as const
    // …and every floor must still be released at `md:`, or desktop silently grows with it.
    const RELEASE = {
      'min-h-tap': 'md:min-h-0',
      'min-w-tap': 'md:min-w-0',
      'before:size-tap': 'md:before:hidden',
    } as const

    const sources = new Map(primitiveSources().map(({ name, source }) => [name, source]))
    const missing = REQUIRE_TAP.flatMap(({ file, axes }) => {
      const source = sources.get(file)
      if (source === undefined) return [`${file}: not found`]
      return NEEDED[axes].flatMap((floor) => [
        ...(source.includes(floor) ? [] : [`${file}: no ${floor}`]),
        ...(source.includes(RELEASE[floor]) ? [] : [`${file}: no ${RELEASE[floor]} to release ${floor}`]),
      ])
    })
    expect(missing, 'primitives with an interactive control but no absolute phone floor').toEqual([])
  })

  it('no primitive hand-types a spacing pixel any more', () => {
    // The six rows B1 converted (S21, S28–S32). The allowlist ceiling drops with them; this
    // asserts the SOURCE is clean so a re-added literal cannot hide behind a stale row.
    const offenders = primitiveSources()
      .flatMap(({ name, source }) =>
        [...source.matchAll(/(?<![\w-])(?:[a-z]+:)*-?(?:p|px|py|gap|h|min-h|size)-\[\d[^\]]*\]/g)].map(
          (m) => `${name}: ${m[0]}`
        )
      )
    expect(offenders).toEqual([])
    expect(readFileSync(path.join(WEB_ROOT, 'components', 'status-dot.tsx'), 'utf8')).toContain(
      'size-1.75'
    )
  })
})

// ---------------------------------------------------------------------------
// MOTION — every animation answers the reduced-motion preference
// ---------------------------------------------------------------------------

describe('B1 motion: no primitive animates against the reader preference', () => {
  it('every enter/exit animation in a primitive is motion-safe:', () => {
    const unguarded = primitiveSources().flatMap(({ name, source }) =>
      classTokens(source)
        .filter((token) => /animate-(in|out)\b/.test(token))
        .filter((token) => !token.includes('motion-safe:'))
        .map((token) => `${name}: ${token}`)
    )
    expect(unguarded, 'enter/exit animations that ignore prefers-reduced-motion').toEqual([])
  })

  it('the tooltip animation hangs off data-[state=open], like every other floating surface', () => {
    // It used to carry no state hook at all (G-06), so it replayed on every re-render of an
    // already-open tooltip.
    const tooltip = stripComments(readFileSync(path.join(UI_DIR, 'tooltip.tsx'), 'utf8'))
    expect(tooltip).toContain('motion-safe:data-[state=open]:animate-in')
    expect(tooltip).not.toMatch(/(?<![\w:-])animate-in/)
  })

  it('every looping animation in a primitive can be switched off', () => {
    // `status-dot.tsx` lives outside `components/ui` and carries the batch's other looping
    // animation, so the scan reaches it too rather than leaving one B1 file unscanned.
    const scanned = [
      ...primitiveSources(),
      {
        name: 'status-dot.tsx',
        source: stripComments(readFileSync(path.join(WEB_ROOT, 'components', 'status-dot.tsx'), 'utf8')),
      },
    ]
    const unguarded = scanned.flatMap(({ name, source }) => unguardedLoopingAnimations(name, source))
    expect(unguarded, 'looping animations with no reduced-motion escape').toEqual([])
  })

  it('a second unguarded looping animation in an already-guarded file goes red', () => {
    // The fixture the per-FILE predicate let through: one guarded pulse and one unguarded spinner
    // in one file. Asked about the file, the answer is "guarded". Asked about the occurrence, it
    // is not — and the occurrence is what renders.
    const twoInOneFile = [
      'const a = cn("animate-pulse rounded-md bg-accent motion-reduce:animate-none", className)',
      'const b = cn("animate-spin size-4 text-muted-foreground", className)',
    ].join('\n')
    expect(unguardedLoopingAnimations('fixture.tsx', twoInOneFile)).toEqual([
      'fixture.tsx: animate-spin',
    ])

    // …and the scan is not simply always red: the guarded occurrence on its own stays green.
    expect(
      unguardedLoopingAnimations(
        'fixture.tsx',
        'const a = cn("animate-pulse motion-reduce:animate-none", className)'
      )
    ).toEqual([])

    // A guard in a DIFFERENT class string does not reach across to the unguarded one.
    expect(
      unguardedLoopingAnimations(
        'fixture.tsx',
        'const a = cn("motion-reduce:animate-none", "animate-spin size-4")'
      )
    ).toEqual(['fixture.tsx: animate-spin'])
  })

  it('Skeleton and a pulsing StatusDot both stop under reduced motion', () => {
    render(<Skeleton data-testid="sk" />)
    expect(screen.getByTestId('sk').className).toContain('motion-reduce:animate-none')

    cleanup()
    render(<StatusDot tone="pending" pulse data-testid="dot" />)
    const dot = screen.getByTestId('dot')
    expect(dot.className).toContain('animate-pulse')
    expect(dot.className).toContain('motion-reduce:animate-none')
    // The colour, not the motion, is what says which state this is.
    expect(dot.className).toContain('bg-pending')
  })
})

// ---------------------------------------------------------------------------
// FOCUS — one focus idiom across the primitives
// ---------------------------------------------------------------------------

describe('B1 focus: one ring idiom', () => {
  it('no primitive uses the older focus: ring', () => {
    // `focus:` paints a ring for a mouse click too; `focus-visible:` is the cockpit's rule and was
    // already on eight primitives when the dialog and sheet closes were still on the old one.
    const offenders = primitiveSources()
      .filter(({ source }) => /(?<![\w-])focus:ring-/.test(source))
      .map(({ name }) => name)
    expect(offenders, 'primitives on the pre-focus-visible ring idiom (G-06)').toEqual([])
  })

  it('the dialog and sheet close buttons carry the shared ring', () => {
    for (const name of ['dialog.tsx', 'sheet.tsx']) {
      const source = stripComments(readFileSync(path.join(UI_DIR, name), 'utf8'))
      expect(source, name).toContain('focus-visible:ring-[3px] focus-visible:ring-ring/50')
    }
  })
})

// ---------------------------------------------------------------------------
// SEMANTIC — a heading that is actually a heading
// ---------------------------------------------------------------------------

describe('B1 semantics: PopoverTitle renders the element it is typed as', () => {
  it('is an h2 in the document, not a div that merely looks like one', () => {
    render(<PopoverTitle>Filter tasks</PopoverTitle>)

    const title = screen.getByRole('heading', { name: 'Filter tasks', level: 2 })
    expect(title.tagName).toBe('H2')
    expect(title.dataset.slot).toBe('popover-title')
  })
})

// ---------------------------------------------------------------------------
// CONTRAST — computed, on the surfaces the ink is actually printed on
// ---------------------------------------------------------------------------

/** index.css theme blocks, flattened to `selector → token → value`. */
function themeTokens(): Map<string, Map<string, string>> {
  const css = readFileSync(INDEX_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks = new Map<string, Map<string, string>>()
  for (const match of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = match[1]!.slice(match[1]!.lastIndexOf(';') + 1).replace(/\s+/g, ' ').trim()
    const props = blocks.get(selector) ?? new Map<string, string>()
    for (const decl of match[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
      props.set(decl[1]!, decl[2]!.trim())
    }
    if (props.size > 0) blocks.set(selector, props)
  }
  return blocks
}

const TOKENS = themeTokens()

/** Resolve a token to a hex, following `var(--other)` and falling back to the dark block. */
function hex(theme: 'dark' | 'light', name: string, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`token cycle at ${name}`)
  seen.add(name)
  const dark = TOKENS.get(':root')
  const light = TOKENS.get('.light')
  const raw = (theme === 'light' ? light?.get(name) : undefined) ?? dark?.get(name)
  if (!raw) throw new Error(`token ${name} is not declared in index.css`)
  const ref = /^var\((--[\w-]+)\)$/.exec(raw)
  if (ref) return hex(theme, ref[1]!, seen)
  if (!/^#[0-9a-f]{6}$/i.test(raw)) throw new Error(`token ${name} is not a plain hex: ${raw}`)
  return raw
}

/** WCAG 2.1 relative luminance. */
function luminance(value: string): number {
  const channel = (pair: string): number => {
    const c = parseInt(pair, 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const r = channel(value.slice(1, 3))
  const g = channel(value.slice(3, 5))
  const b = channel(value.slice(5, 7))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** AA for text below 18.66px bold / 24px regular — which is all of the cockpit's small text. */
const AA_SMALL = 4.5

/** The surfaces `--soft-foreground` is actually printed on. `--muted` is the darkest of them in
 *  dark theme and the lightest-but-one in light, so it sets the bar in both. */
const SURFACES = ['--background', '--card', '--card-2', '--sidebar', '--muted'] as const

describe('B1 contrast: required small text clears AA on the surface it sits on', () => {
  it('the ratio helper agrees with the reference values (guards against a broken formula)', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    // The two values G-23 measured, on the tokens as they were before this batch.
    expect(contrast('#ffffff', '#ef4444')).toBeCloseTo(3.76, 1)
    expect(contrast('#a3a3a3', '#ffffff')).toBeCloseTo(2.54, 1)
  })

  it.each(['dark', 'light'] as const)(
    '%s: --soft-foreground clears AA on every surface it is used on',
    (theme) => {
      const ink = hex(theme, '--soft-foreground')
      const failures = SURFACES.map((surface) => ({
        surface,
        ratio: contrast(ink, hex(theme, surface)),
      })).filter(({ ratio }) => ratio < AA_SMALL)
      expect(
        failures.map((f) => `${f.surface} ${f.ratio.toFixed(2)}:1`),
        `${theme} --soft-foreground (${ink}) below ${AA_SMALL}:1`
      ).toEqual([])
    }
  )

  it.each(['dark', 'light'] as const)(
    '%s: --muted-foreground stays above AA too (it did; pin it)',
    (theme) => {
      const ink = hex(theme, '--muted-foreground')
      for (const surface of SURFACES) {
        expect(contrast(ink, hex(theme, surface)), `${theme} on ${surface}`).toBeGreaterThanOrEqual(
          AA_SMALL
        )
      }
    }
  )

  it.each(['dark', 'light'] as const)('%s: ink on a solid status fill clears AA', (theme) => {
    // The danger button and the danger toast print 13px on `--danger`; the Inbox badge prints
    // 10.5px on `--violet`. Both used to be white — 3.8:1 and 3.1:1 (G-23).
    expect(
      contrast(hex(theme, '--danger-foreground'), hex(theme, '--danger')),
      'danger ink'
    ).toBeGreaterThanOrEqual(AA_SMALL)
    expect(
      contrast(hex(theme, '--violet-foreground'), hex(theme, '--violet')),
      'violet ink'
    ).toBeGreaterThanOrEqual(AA_SMALL)
    expect(
      contrast(hex(theme, '--contrast-foreground'), hex(theme, '--contrast')),
      'contrast ink'
    ).toBeGreaterThanOrEqual(AA_SMALL)
    // D-08's recorded exception keeps its own ink token; it must still clear the bar.
    expect(
      contrast(hex(theme, '--danger-ink'), hex(theme, '--danger')),
      'development-build badge ink'
    ).toBeGreaterThanOrEqual(AA_SMALL)
  })

  it.each(['dark', 'light'] as const)('%s: both accents keep readable ink', (theme) => {
    // Lime is the default; Settings → Appearance repoints `--primary` at the violet family, which
    // brings `--violet-foreground` with it.
    expect(
      contrast(hex(theme, '--primary-foreground'), hex(theme, '--primary')),
      'lime accent'
    ).toBeGreaterThanOrEqual(AA_SMALL)
    const violetAccent = TOKENS.get(":root[data-accent='violet']")
    expect(violetAccent?.get('--primary')).toBe('var(--violet)')
    expect(violetAccent?.get('--primary-foreground')).toBe('var(--violet-foreground)')
    expect(
      contrast(hex(theme, '--violet-foreground'), hex(theme, '--violet')),
      'violet accent'
    ).toBeGreaterThanOrEqual(AA_SMALL)
  })
})

// ---------------------------------------------------------------------------
// DEAD PRIMITIVES — removed, and removed from the ledger in the same change
// ---------------------------------------------------------------------------

describe('B1 inventory: the four primitives with no importers are gone', () => {
  const REMOVED = ['card.tsx', 'scroll-area.tsx', 'select.tsx', 'separator.tsx']

  it('the files no longer exist', () => {
    const present = primitiveSources()
      .map(({ name }) => name)
      .filter((name) => REMOVED.includes(name))
    expect(present, 'dead shadcn scaffolding (G-20)').toEqual([])
  })

  it('coverage.md carries no row for them', () => {
    const coverage = readFileSync(COVERAGE_MD, 'utf8')
    const stale = REMOVED.filter((name) => coverage.includes(`components/ui/${name}`))
    expect(stale, 'coverage rows for files that no longer exist').toEqual([])
  })

  it('the target tokens are declared once, absolutely, and documented', () => {
    const statik = TOKENS.get('@theme static')
    expect(statik?.get('--spacing-tap')).toBe('44px')
    expect(statik?.get('--spacing-chip')).toBe('24px')
    // Not `calc(var(--spacing) * n)`: the density lever must not reach the floor.
    expect(statik?.get('--spacing-tap')).not.toContain('var(--spacing)')
    expect(statik?.get('--spacing-chip')).not.toContain('var(--spacing)')
  })
})
