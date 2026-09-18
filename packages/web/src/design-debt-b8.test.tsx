import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import spacingAllowlist from './design-guardian-spacing-allowlist.json'
import { isSelectablePath, readFilesTabSelection, writeFilesTabSelection } from './lib/files-tab-selection'
import { ZoomableImage } from './components/zoomable-image'

/**
 * Design-debt batch B8 — the image preview and the final reconciliation (#453, AC-8 / T-8 and
 * AC-9 / T-9).
 *
 * B8 is the last batch, so this file carries two jobs the earlier ones did not. The first is the
 * ordinary one: pin the batch's own contracts in jsdom, here the keyboard-accessible image preview
 * (A06) and the three gaps B5–B7 explicitly deferred to B8. The second is **T-9's completeness
 * check** — the ledger itself. #453 AC-9 says no G/A/S/Q family may be "merely deferred" when the
 * series is called done, and a claim like that is only worth what checks it: the cases under
 * "the known-gaps ledger" read `docs/design-system/known-gaps.md` and fail when a row has no
 * disposition, when a retired id comes back, when the header's arithmetic stops matching the rows,
 * or when a row claims an issue number it does not name.
 *
 * jsdom has no layout and no media queries, so the 44 px geometry at every density, the rendered
 * Enter/Space path, the focus trap under a real Tab key and the composited scrim are measured in
 * `packages/web/e2e/design-debt-b8.e2e.ts`.
 */

afterEach(() => {
  cleanup()
  sessionStorage.clear()
})

const SRC = resolve(import.meta.dirname)
const REPO = resolve(SRC, '..', '..', '..')
const source = (rel: string) => readFileSync(join(SRC, rel), 'utf8')
/** The source with comment-only lines dropped, so a comment quoting an old spelling is not a hit. */
const code = (rel: string) =>
  source(rel)
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
    .join('\n')

const KNOWN_GAPS = readFileSync(join(REPO, 'docs/design-system/known-gaps.md'), 'utf8')
const DECISIONS = readFileSync(join(REPO, 'docs/design-system/decisions.md'), 'utf8')

/**
 * Every source file § B8 owns, plus the three files the leader's brief added for the gaps B5–B7
 * deferred here. The pull request reconciles the second group under "Reconciliation needed";
 * listing them here is what makes the batch-wide scans below cover them.
 */
const B8_FILES = [
  'components/zoomable-image.tsx',
  'routes/task-thread/run-header.tsx',
  'routes/task-git/task-files.tsx',
  'lib/files-tab-selection.ts',
] as const

// ---------------------------------------------------------------------------
// A06 / AC-8 — the image preview
// ---------------------------------------------------------------------------

describe('#453 A06 — the image preview is a real dialog', () => {
  /** T-8's first named break: "restore clickable-img-only preview". */
  it('opens from the keyboard because the thumbnail is a button, not a clickable img', () => {
    const src = code('components/zoomable-image.tsx')
    expect(src).toContain('<DialogTrigger asChild>')
    expect(src).toMatch(/<button\s/)
    // The picture carries no click handler of its own any more — that was the whole defect.
    expect(src).not.toMatch(/<img[^>]*onClick/s)
    expect(src).not.toContain('createPortal')
  })

  /** T-8's second named break: "remove focus return". */
  it('takes focus move, trap and return from the Dialog primitive rather than hand-rolling them', () => {
    const src = code('components/zoomable-image.tsx')
    for (const part of ['Dialog', 'DialogContent', 'DialogTrigger', 'DialogTitle']) {
      expect(src).toContain(part)
    }
    // The hand-rolled Escape listener is gone: the primitive owns dismissal now, so a second
    // listener would be a second answer to the same question.
    expect(src).not.toContain("event.key === 'Escape'")
    expect(src).not.toContain('window.addEventListener')
  })

  it('renders an explicit close control that the picture cannot cover', async () => {
    render(<ZoomableImage src="/api/v1/runs/r1/images/shot.png" alt="shot" />)
    fireEvent.click(document.querySelector('[data-slot="image-zoom-trigger"]') as HTMLElement)
    await waitFor(() => expect(document.querySelector('[data-slot="image-lightbox"]')).not.toBeNull())

    const lightbox = document.querySelector('[data-slot="image-lightbox"]') as HTMLElement
    const children = [...lightbox.children]
    expect(children.findIndex((c) => c.getAttribute('data-slot') === 'dialog-close')).toBe(
      children.length - 1,
    )
    expect(screen.getByText('Close')).toBeTruthy()
  })

  it('says an unavailable image in words instead of a black screen over nothing', () => {
    render(<ZoomableImage src="/gone.png" alt="pruned" />)
    fireEvent.error(document.querySelector('img') as HTMLImageElement)
    expect(document.querySelector('[data-slot="image-unavailable"]')?.textContent).toBe(
      'Image unavailable',
    )
    expect(document.querySelector('[data-slot="image-zoom-trigger"]')).toBeNull()
  })

  /**
   * The scrim composites from TWO layers, and that is easy to break by "tidying" one number.
   * `DialogContent` always paints its own `DialogOverlay` at `bg-black/50`, so the content's
   * `bg-black/60` gives 1 − (0.5 × 0.4) = 0.8 — the 80 % this component has always had. A single
   * `bg-black/80` here would composite to 90 %.
   */
  it('keeps the two-layer scrim arithmetic, and says so where a reader will find it', () => {
    expect(source('components/zoomable-image.tsx')).toContain('bg-black/60')
    expect(source('components/zoomable-image.tsx')).toContain('0.5 × 0.4')
    // tailwind-merge keeps a modifier'd class when the override carries none, so the `sm:` cap
    // has to be overridden by name or the preview is 32 rem wide from `sm:` up.
    expect(source('components/zoomable-image.tsx')).toContain('sm:max-w-none')
  })
})

// ---------------------------------------------------------------------------
// The gaps B5–B7 deferred to B8
// ---------------------------------------------------------------------------

describe('#453 B8 — the deferred gaps', () => {
  /**
   * G-10 is NOT asserted here, deliberately. It used to be — by reading the source for
   * `const returnFocus = useReturnFocus(confirming !== null)` — and that test was green against a
   * cockpit where Escape on the kebab's confirm still dropped focus on `<body>`, because the hook
   * captured the Radix menu container and the menu unmounts (design review B-1 on #602). A source
   * string cannot see that; only a rendered journey can.
   *
   * It now lives in `packages/web/e2e/design-debt-b8.e2e.ts` — "returns focus to the Run actions
   * kebab" — which drives the real menu at 375 px in the dark theme and checks
   * `document.activeElement` by IDENTITY for both exits, Escape and "Keep it".
   */

  /**
   * G-21 follow-up: B5 made the rename pencil permanently visible for touch, which took 28 px
   * from a 375 px title row and cut the title after about fifteen characters. The title wraps on a
   * phone now and keeps its one-line ellipsis from `md:`.
   */
  it('G-21: the phone run title wraps instead of truncating, and the desktop title is unchanged', () => {
    const src = code('routes/task-thread/run-header.tsx')
    expect(src).toContain('line-clamp-2 min-w-0 text-[15px] font-semibold md:line-clamp-1')
    // `truncate` and `line-clamp` fight each other (both set overflow and one sets display), so
    // the old spelling must be gone rather than merely overridden.
    expect(src).not.toMatch(/<h1 className="min-w-0 truncate text-\[15px\]/)
  })

  /** G-40: the selection lived in state a tab change unmounts. */
  it('G-40: the Files tab remembers the selected file across a trip to another tab', () => {
    const src = code('routes/task-git/task-files.tsx')
    expect(src).toContain("from '@/lib/files-tab-selection'")
    expect(src).toContain('useState<string | null>(() => readFilesTabSelection(run.id))')
    expect(src).toContain('writeFilesTabSelection(run.id, path)')
    // The tree must call the WRITING setter, not the bare one, or the selection is remembered
    // only until the first pick.
    expect(src).toContain('onSelect={select}')
    expect(src).not.toContain('onSelect={setSelected}')
  })

  it('G-40: a stored selection round-trips per run, and a clear is remembered as a clear', () => {
    writeFilesTabSelection('run-a', 'src/deep/file.ts')
    writeFilesTabSelection('run-b', 'README.md')
    expect(readFilesTabSelection('run-a')).toBe('src/deep/file.ts')
    expect(readFilesTabSelection('run-b')).toBe('README.md')
    expect(readFilesTabSelection('run-c')).toBeNull()

    writeFilesTabSelection('run-a', null)
    expect(readFilesTabSelection('run-a')).toBeNull()
    expect(readFilesTabSelection('run-b')).toBe('README.md')
  })

  /**
   * A path the tree cannot select must not come back, or the preview lands in an error state the
   * reader cannot clear by picking another file. The empty-input case is the one that matters:
   * "we never stored anything" and "we stored something unusable" have to read the same.
   */
  it('G-40: refuses a path the tree could never have handed out', () => {
    for (const bad of ['', '/etc/passwd', '../secrets', 'a/../../b', 'x'.repeat(1_025)]) {
      expect(isSelectablePath(bad)).toBe(false)
    }
    for (const good of ['README.md', 'src/lib/a.ts', 'a b/c.txt', 'x'.repeat(1_024)]) {
      expect(isSelectablePath(good)).toBe(true)
    }
    sessionStorage.setItem('xez-files-tab-selection:run-a', '/etc/passwd')
    expect(readFilesTabSelection('run-a')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Batch-wide contracts
// ---------------------------------------------------------------------------

describe('#453 B8 — batch-wide contracts', () => {
  /** T-8's third named break: "introduce an unlisted arbitrary spacing literal". */
  it('spells no hand-typed spacing pixel in any file it owns', () => {
    const pattern =
      /(?<![\w-])(?:[a-z]+:)*-?(?:p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y|h|min-h|size)-\[\d+(?:\.\d+)?(?:px|rem|em)\]/g
    const found = B8_FILES.flatMap((rel) => [...code(rel).matchAll(pattern)].map((m) => `${rel}  ${m[0]}`))
    expect(found).toEqual([])
  })

  /**
   * T-8's fourth named break: "leave a stale allowlist count". #453's own batch table gives B8
   * "None; **2**" — it deletes no key, so the ceiling stays where B7 left it, and both remaining
   * rows are the absolute 24 px chip floors WCAG 2.2 SC 2.5.8 asks for, which the density lever
   * must not be able to shrink. The leader's brief asked whether B8 should take the ceiling to 0;
   * #453 says otherwise, and this is the assertion that records which answer shipped.
   */
  it('keeps exactly the two justified 24 px floors in the spacing allowlist', () => {
    const rows = Object.entries(spacingAllowlist as Record<string, { count: number; reason: string }>)
    expect(rows).toHaveLength(2)
    expect(rows.map(([key]) => key).sort()).toEqual([
      'src/components/picker-pill.tsx|min-h-[24px]',
      'src/components/reference-chip.tsx|min-h-[24px]',
    ])
    for (const [key, row] of rows) {
      expect(row.count, key).toBe(1)
      expect(row.reason, key).toContain('24 px')
    }
    // The guardian's ceiling and this file must agree; a ceiling raised to admit a new pixel
    // fails here as well as there.
    expect(source('design-guardian.test.ts')).toContain('const SPACING_ALLOWLIST_CEILING = 2')
  })

  it('guards every animation it ships', () => {
    const found = B8_FILES.flatMap((rel) =>
      [...code(rel).matchAll(/(?<![\w:-])animate-(?:spin|pulse|bounce|ping)\b/g)].map(
        (m) => `${rel}  ${m[0]}`,
      ),
    )
    expect(found).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// T-9 — the ledger is complete
// ---------------------------------------------------------------------------

/**
 * Parsed once: the ids the header claims are live and retired, the ids that really have a section,
 * and the next free id. Everything below compares those four against each other, so the file
 * cannot claim one thing in its header and another in its body.
 */
const LIVE_FROM_HEADER = expandIdRanges(headerClause('are live'))
const RETIRED_FROM_HEADER = expandIdRanges(headerClause('are retired'))
const SECTION_IDS = [...KNOWN_GAPS.matchAll(/^### (G-\d\d) /gm)].map((m) => m[1] as string)

/**
 * The ids listed inside the emphasised span that ends with a claim such as "are live".
 *
 * Scoped to that ONE span on purpose: the prose above it names individual ids too ("G-31 is a live
 * axe-core violation"), and a clause that reached back past its own `**` would collect those and
 * then pass for the wrong reason.
 */
function headerClause(claim: string): string {
  const at = KNOWN_GAPS.indexOf(claim)
  if (at === -1) throw new Error(`known-gaps.md no longer says "${claim}"`)
  const from = KNOWN_GAPS.lastIndexOf('**', at - 1)
  if (from === -1) throw new Error(`"${claim}" is not inside an emphasised span in known-gaps.md`)
  return KNOWN_GAPS.slice(from, at)
}

/**
 * One row's text, from its heading to the next heading of any level.
 *
 * Measured from the END of the heading LINE, not from the `#`: slicing one character in leaves
 * `## G-06 …`, which the "next heading" pattern matches at position 0 — so every row would look
 * empty and every assertion over a body would pass for the wrong reason.
 */
function sectionBody(id: string): string {
  const heading = KNOWN_GAPS.indexOf(`### ${id} `)
  if (heading === -1) throw new Error(`known-gaps.md has no ${id} section`)
  const from = KNOWN_GAPS.indexOf('\n', heading)
  const next = KNOWN_GAPS.slice(from).search(/^(?:#{2,3} )/m)
  return next === -1 ? KNOWN_GAPS.slice(from) : KNOWN_GAPS.slice(from, from + next)
}

/** `G-01 to G-05, G-07 to G-13, G-21` → every id it covers. */
function expandIdRanges(text: string): string[] {
  const out: string[] = []
  const cleaned = text.replace(/\*\*/g, '')
  for (const part of cleaned.split(',')) {
    const range = part.match(/(G-\d\d)\s+to\s+(G-\d\d)/)
    if (range) {
      for (let n = Number(range[1]!.slice(2)); n <= Number(range[2]!.slice(2)); n += 1) {
        out.push(`G-${String(n).padStart(2, '0')}`)
      }
      continue
    }
    for (const single of part.matchAll(/G-\d\d/g)) out.push(single[0])
  }
  return [...new Set(out)]
}

describe('#453 T-9 — the known-gaps ledger has no merely-deferred debt', () => {
  it('gives every live row a dated disposition', () => {
    const undisposed = SECTION_IDS.filter(
      (id) => !/\*\*Final disposition \(#453 B8, \d{4}-\d{2}-\d{2}\)\*\*/.test(sectionBody(id)),
    )
    expect(undisposed).toEqual([])
  })

  it('names an issue number, or says why the row stays, in every disposition', () => {
    const problems: string[] = []
    for (const id of SECTION_IDS) {
      const body = sectionBody(id)
      const at = body.indexOf('**Final disposition (#453 B8')
      const line = body.slice(at, body.indexOf('\n', at))
      const filed = /filed as \*\*#\d+\*\*/.test(line)
      const kept = /kept, with a reason/.test(line)
      if (filed === kept) problems.push(`${id}: a disposition is either "filed as #n" or "kept, with a reason"`)
    }
    expect(problems).toEqual([])
  })

  it('agrees with its own header about which ids are live', () => {
    expect([...SECTION_IDS].sort()).toEqual([...LIVE_FROM_HEADER].sort())
  })

  /** Ids are never reused: a retired number must not come back as a section. */
  it('never reuses a retired id', () => {
    expect(SECTION_IDS.filter((id) => RETIRED_FROM_HEADER.includes(id))).toEqual([])
  })

  it('accounts for every id from G-01 up to the next free one, exactly once', () => {
    const nextFree = KNOWN_GAPS.match(/next free id is \*{0,2}(G-\d\d)/)
    expect(nextFree, 'known-gaps.md must state the next free id').not.toBeNull()
    const highest = Number(nextFree![1]!.slice(2)) - 1
    const all = Array.from({ length: highest }, (_, i) => `G-${String(i + 1).padStart(2, '0')}`)
    const accounted = [...LIVE_FROM_HEADER, ...RETIRED_FROM_HEADER]
    expect([...new Set(accounted)].sort()).toEqual(all)
    // Every id is live OR retired, never both.
    expect(LIVE_FROM_HEADER.filter((id) => RETIRED_FROM_HEADER.includes(id))).toEqual([])
  })

  /** A row kept rather than filed has to point at the record that justifies keeping it. */
  it('backs the retirements that were decisions rather than fixes with a decisions.md record', () => {
    for (const record of ['### D-10', '### D-11', '### D-12']) expect(DECISIONS).toContain(record)
    // D-10 retires G-01 and D-11 retires G-07, so neither may still be a section here.
    expect(SECTION_IDS).not.toContain('G-01')
    expect(SECTION_IDS).not.toContain('G-07')
  })
})
