import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { BookmarkletsSection } from '@/routes/settings/bookmarklets-section'
import { WorktreesSection } from '@/routes/settings/worktrees-section'

/**
 * #424 follow-through (decisions.md D-03): a Settings section's LOADING state must sit where its
 * LOADED content sits, so the page does not jump when the data arrives. Two things place that first
 * content edge, and a loading state needs both:
 *
 *  - the gutter. Twelve sections spelled it by hand as `p-4 … md:p-6` — a hand-picked 24 px where
 *    the rhythm gives `md:p-group` (foundations.md §4.1, "Settings section container:
 *    `p-list … md:p-group`"). Pinned as BREAK-424-LOADING-PAD.
 *  - the centred reading measure (`mx-auto w-full max-w-…`) the loaded content is constrained to.
 *    Padding alone still left the first content edge 44–81 px out at 1280 px, because the loaded
 *    column is centred and the loading line was not. Pinned as BREAK-424-LOADING-MEASURE.
 *
 * Both breaks name the offending file: restore a loading line to `p-4 … md:p-6`, or drop a measure
 * wrapper, and the source contract below goes red on that section.
 */

const SRC = resolve(import.meta.dirname)
const SETTINGS = join(SRC, 'routes', 'settings')

/** The `p-*` shorthands in a class list — the whole-box gutter, per breakpoint. `pb-[calc(…)]`
 *  and the other axis overrides are deliberately NOT gutter: the phone dock clearance is one. */
const paddingTokens = (className: string) =>
  className
    .split(/\s+/)
    .filter((token) => /^(?:(?:sm|md|lg|xl):)?p-/.test(token))
    .sort()

const RHYTHM_GUTTER = 'md:p-group p-list'

/**
 * What one element contributes to where the first content edge lands: the rhythm gutter, the
 * centred reading measure, both, or neither. A measure only counts when it is centred — a bare
 * `max-w-md` on a field constrains a control, it does not place the column.
 */
const roleOf = (className: string): string | null => {
  const gutter = paddingTokens(className).join(' ') === RHYTHM_GUTTER
  const measure = /\bmx-auto\b/.test(className) ? (/\bmax-w-[\w.[\]()%-]+/.exec(className)?.[0] ?? null) : null
  if (gutter && measure) return `gutter+measure:${measure}`
  if (gutter) return 'gutter'
  if (measure) return `measure:${measure}`
  return null
}

const classListsIn = (source: string) => [...source.matchAll(/className="([^"]*)"/g)].map((m) => m[1] ?? '')

/** The rhythm chain of a block of JSX, outermost element first (source order). */
const rhythmChain = (source: string) => classListsIn(source).map(roleOf).filter((role): role is string => role !== null)

/**
 * The pending branch of a section, as source text: from its `return (` to the closing `)` of that
 * return. Taking the whole block — not just the `data-slot` element — is what lets a section place
 * the gutter and the measure on two different elements, which is exactly what Bookmarklets does.
 */
const loadingBlockOf = (text: string): string | null => {
  const slot = text.search(/data-slot="[a-z-]*loading"/)
  if (slot < 0) return null
  const start = text.lastIndexOf('return (', slot)
  const end = text.indexOf('\n    )', slot)
  return start < 0 || end < 0 ? null : text.slice(start, end)
}

/** Every `*-section.tsx` that renders its own pending state with a `data-slot="…loading"` element. */
const sectionsWithLoadingState = readdirSync(SETTINGS)
  .filter((name) => name.endsWith('-section.tsx') && !name.endsWith('.test.tsx'))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(SETTINGS, name), 'utf8') }))
  .map((file) => ({ ...file, block: loadingBlockOf(file.text) }))
  .filter((file): file is { name: string; text: string; block: string } => file.block !== null)
  .map((file) => ({ ...file, loaded: file.text.replace(file.block, '') }))

/**
 * The rhythm chain each section's LOADED content sits on, read from the loaded branch of the same
 * file. This is the shape the pending branch has to reproduce, element for element and in the same
 * order — a gutter *inside* a measure and a measure *inside* a gutter place the first content edge
 * a whole gutter apart, so the chain, not a set of tokens, is the contract.
 */
const LOADED_RHYTHM: Record<string, string[]> = {
  'accounts-section.tsx': ['gutter+measure:max-w-2xl'], //           AccountsPane's root
  'agent-config-section.tsx': ['gutter'], //                         AgentConfigView is full-width: no measure
  'agents-section.tsx': ['gutter+measure:max-w-2xl'], //             AgentsForm's root
  'bookmarklets-section.tsx': ['gutter', 'measure:max-w-2xl'], //    scroll container, then BookmarkletPanel
  'mcp-api-section.tsx': ['gutter+measure:max-w-3xl'], //            McpApiReferenceView's root — wider than the rest
  'mcp-connection-section.tsx': ['gutter+measure:max-w-2xl'], //     McpConnectionSurface's root
  'project-setup-section.tsx': ['gutter+measure:max-w-2xl'], //      ProjectSetupCard's root
  'projects-section.tsx': ['gutter+measure:max-w-4xl'], //           ProjectsPane's root — the registry table needs it
  'prompt-templates-section.tsx': ['gutter+measure:max-w-2xl'], //   PromptTemplatesForm's root
  'resources-section.tsx': ['gutter+measure:max-w-2xl'], //          ResourcesForm's root
  'skills-section.tsx': ['gutter+measure:max-w-2xl'], //             SkillsForm's root
  'terminal-section.tsx': ['gutter+measure:max-w-2xl'], //           TerminalForm's root
  'worktrees-section.tsx': ['gutter+measure:max-w-2xl'], //          WorktreesForm's root
}

describe('BREAK-424-LOADING-PAD — a Settings section loads and renders on the same gutter', () => {
  it('finds the thirteen sections that render a padded loading state', () => {
    expect(sectionsWithLoadingState.map((f) => f.name)).toEqual(Object.keys(LOADED_RHYTHM))
  })

  it('each loading state pads itself exactly like the container it is replaced by', () => {
    const offenders: string[] = []
    for (const file of sectionsWithLoadingState) {
      // `p-list` as a whole token — `gap-list` contains it as a substring and is not a gutter.
      const containers = classListsIn(file.loaded).filter((c) => c.split(/\s+/).includes('p-list'))
      if (containers.length === 0) {
        offenders.push(`${file.name}: no loaded container carries the rhythm gutter`)
        continue
      }
      const loading = classListsIn(file.block).flatMap(paddingTokens).sort().join(' ')
      for (const container of containers) {
        const loaded = paddingTokens(container).join(' ')
        if (loading !== loaded) offenders.push(`${file.name}: loading [${loading}] ≠ loaded [${loaded}]`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the gutter is the documented rhythm spelling, never a hand-set pixel', () => {
    for (const file of sectionsWithLoadingState) {
      expect(classListsIn(file.block).flatMap(paddingTokens).sort(), file.name).toEqual(['md:p-group', 'p-list'])
      expect(file.text, file.name).not.toMatch(/(?<![\w:-])(?:p-4|md:p-6)(?![\w-])/)
    }
  })
})

describe('BREAK-424-LOADING-MEASURE — a loading state is centred on the same reading measure', () => {
  it('each pending branch reproduces its loaded rhythm chain, in order', () => {
    for (const file of sectionsWithLoadingState) {
      expect(rhythmChain(file.block), file.name).toEqual(LOADED_RHYTHM[file.name])
    }
  })

  it('every measure the table claims is a real container of that section, not a copied constant', () => {
    for (const file of sectionsWithLoadingState) {
      for (const role of LOADED_RHYTHM[file.name] ?? []) {
        const measure = /measure:(.+)$/.exec(role)?.[1]
        if (!measure) continue
        const carriers = classListsIn(file.loaded).filter(
          (c) => c.includes('mx-auto') && c.split(/\s+/).includes(measure),
        )
        expect(carriers.length, `${file.name}: no loaded container is centred on ${measure}`).toBeGreaterThan(0)
      }
    }
  })
})

// ---- the same contract on the rendered class names ----------------------------------------------

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Nothing ever answers, so every query stays honestly pending and the section renders loading. */
const servePending = () => vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))

const renderSection = (ui: React.ReactElement) =>
  render(
    <MemoryRouter initialEntries={['/p/default/settings']}>
      <QueryClientProvider client={createQueryClient()}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  )

describe('BREAK-424-LOADING-PAD / -MEASURE — the rendered loading class names', () => {
  it('Bookmarklets renders its pending state on the gutter, with the panel measure inside it', async () => {
    servePending()
    renderSection(<BookmarkletsSection />)
    const text = await screen.findByText('Loading bookmarklets…')
    const gutter = text.closest('[data-slot="bookmarklets-loading"]')
    expect(paddingTokens(gutter?.getAttribute('class') ?? '')).toEqual(['md:p-group', 'p-list'])
    expect(roleOf(text.getAttribute('class') ?? '')).toBe('measure:max-w-2xl')
  })

  it('Worktrees renders its pending state on the gutter and the measure together', async () => {
    servePending()
    renderSection(<WorktreesSection />)
    const loading = await screen.findByText('Loading worktree settings…')
    expect(roleOf(loading.getAttribute('class') ?? '')).toBe('gutter+measure:max-w-2xl')
  })
})
