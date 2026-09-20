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
 * #424 follow-through (decisions.md D-03): a Settings section's LOADING state must pad itself with
 * the same rhythm tokens as its loaded container, so the page does not jump when the data arrives.
 * Twelve sections still spelled that gutter by hand as `p-4 … md:p-6` — a hand-picked 24 px where
 * the rhythm gives `md:p-group` (foundations.md §4.1, "Settings section container: `p-list … md:p-group`").
 *
 * The break this pins is BREAK-424-LOADING-PAD: restore any of those twelve loading lines to
 * `p-4 … md:p-6` and the source contract below goes red naming the file.
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

/** Every `*-section.tsx` that renders its own pending state with a `data-slot="…loading"` element. */
const sectionsWithLoadingState = readdirSync(SETTINGS)
  .filter((name) => name.endsWith('-section.tsx') && !name.endsWith('.test.tsx'))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(SETTINGS, name), 'utf8') }))
  .map((file) => ({
    ...file,
    loading: /data-slot="[a-z-]*loading"[^>]*?className="([^"]*)"/.exec(file.text)?.[1] ?? null,
  }))
  .filter((file): file is { name: string; text: string; loading: string } => file.loading !== null)

/** The section's loaded container(s): every other class list in the file carrying the gutter token. */
const containersOf = (file: { text: string; loading: string }) =>
  [...file.text.matchAll(/className="([^"]*\bp-list\b[^"]*)"/g)]
    .map((m) => m[1] ?? '')
    .filter((c) => c !== file.loading)

describe('BREAK-424-LOADING-PAD — a Settings section loads and renders on the same gutter', () => {
  it('finds the twelve sections that render a padded loading state', () => {
    expect(sectionsWithLoadingState.map((f) => f.name)).toEqual([
      'accounts-section.tsx',
      'agent-config-section.tsx',
      'agents-section.tsx',
      'bookmarklets-section.tsx',
      'mcp-api-section.tsx',
      'mcp-connection-section.tsx',
      'project-setup-section.tsx',
      'projects-section.tsx',
      'prompt-templates-section.tsx',
      'resources-section.tsx',
      'skills-section.tsx',
      'worktrees-section.tsx',
    ])
  })

  it('each loading state pads itself exactly like the container it is replaced by', () => {
    const offenders: string[] = []
    for (const file of sectionsWithLoadingState) {
      const containers = containersOf(file)
      if (containers.length === 0) {
        offenders.push(`${file.name}: no loaded container carries the rhythm gutter`)
        continue
      }
      const loading = paddingTokens(file.loading)
      for (const container of containers) {
        const loaded = paddingTokens(container)
        if (loading.join(' ') !== loaded.join(' ')) {
          offenders.push(`${file.name}: loading [${loading.join(' ')}] ≠ loaded [${loaded.join(' ')}]`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the gutter is the documented rhythm spelling, never a hand-set pixel', () => {
    for (const file of sectionsWithLoadingState) {
      expect(paddingTokens(file.loading), file.name).toEqual(['md:p-group', 'p-list'])
      expect(file.text, file.name).not.toMatch(/(?<![\w:-])(?:p-4|md:p-6)(?![\w-])/)
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

describe('BREAK-424-LOADING-PAD — the rendered loading class names', () => {
  it('Bookmarklets renders its pending state on `p-list md:p-group`', async () => {
    servePending()
    renderSection(<BookmarkletsSection />)
    const loading = await screen.findByText('Loading bookmarklets…')
    expect(paddingTokens(loading.getAttribute('class') ?? '')).toEqual(['md:p-group', 'p-list'])
  })

  it('Worktrees renders its pending state on `p-list md:p-group`', async () => {
    servePending()
    renderSection(<WorktreesSection />)
    const loading = await screen.findByText('Loading worktree settings…')
    expect(paddingTokens(loading.getAttribute('class') ?? '')).toEqual(['md:p-group', 'p-list'])
  })
})
