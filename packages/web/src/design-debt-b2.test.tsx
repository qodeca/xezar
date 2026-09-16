import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MissingProjectBadge, NavBadge, SkillsUpdateMarker } from './components/app-shell'
import { CenteredState, PageHeader } from './components/centered-state'
import { RouteErrorBoundary } from './components/route-error-boundary'
import { FolderBrowser } from './components/folder-browser'
import { readStoredCollapsed, writeStoredCollapsed } from './lib/sidebar-collapse'
import { readStoredSidebarWidth, writeStoredSidebarWidth } from './lib/sidebar-width'

const listing = vi.hoisted(() => ({ data: undefined as unknown, isError: false, error: null as unknown }))
vi.mock('@/api/queries', async (original) => ({ ...await original<object>(), useFsBrowse: () => listing }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

describe('B2 shared states and helpers', () => {
  it('exports a semantic PageHeader with an action and a subordinate state', () => {
    render(<><PageHeader title="Projects"><button>Add</button></PageHeader><CenteredState heading="h2" title="Loading projects" icon="…" /></>)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Projects')
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Loading projects')
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy()
  })

  it('T-2 missing-project badge remains explicit and distinct from counts and updates', () => {
    render(<><MissingProjectBadge /><NavBadge title="2 unread finished tasks">2</NavBadge><SkillsUpdateMarker /></>)
    expect(screen.getByText('folder not found').className).toContain('text-danger')
    expect(screen.getByTitle('2 unread finished tasks').textContent).toBe('2')
    expect(screen.getByText('Skills update available')).toBeTruthy()
  })

  it.each([
    [undefined, 'Inbox: 3'],
    ['3 unread finished tasks', '3 unread finished tasks'],
    ['Research: 3 tasks need you', 'Research: 3 tasks need you'],
  ])('keeps the count live-region owner through 0 → count (%s)', (title, message) => {
    const view = render(<NavBadge title={title}>{0}</NavBadge>)
    const owner = screen.getByRole('status')
    expect(owner.getAttribute('role')).toBe('status')
    expect(owner.getAttribute('aria-atomic')).toBe('true')
    expect(owner.textContent).toBe('')
    expect(document.querySelector('[data-slot="nav-badge"]')).toBeNull()
    view.rerender(<NavBadge title={title}>{3}</NavBadge>)
    expect(screen.getByRole('status')).toBe(owner)
    expect(owner.textContent).toBe(message)
    view.rerender(<NavBadge title={title}>{0}</NavBadge>)
    expect(screen.getByRole('status')).toBe(owner)
    expect(owner.textContent).toBe('')
  })

  it('keeps the Skills live-region owner before an update becomes available', () => {
    const view = render(<SkillsUpdateMarker available={false} />)
    const owner = screen.getByRole('status')
    expect(owner.getAttribute('role')).toBe('status')
    expect(owner.textContent).toBe('')
    view.rerender(<SkillsUpdateMarker available />)
    expect(screen.getByRole('status')).toBe(owner)
    expect(owner.textContent).toBe('Skills update available')
  })

  it('T-0 route error stays a danger alert with a working retry, never an empty state', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let broken = true
    function Page() { if (broken) throw new Error('fixture render failure'); return <p>Recovered page</p> }
    render(<MemoryRouter><RouteErrorBoundary><Page /></RouteErrorBoundary></MemoryRouter>)
    expect(screen.getByRole('alert').querySelector('[data-tone="danger"]')).toBeTruthy()
    expect(screen.getByRole('heading').textContent).toBe('Could not display this page')
    broken = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.getByText('Recovered page')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('T-0 folder loading, empty and error are three different answers', () => {
    const props = { path: null, selected: null, onSelect: vi.fn(), onEnter: vi.fn(), emptyHint: 'No subfolders' }
    listing.data = undefined; listing.isError = false
    const view = render(<FolderBrowser {...props} />)
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByText('No subfolders')).toBeNull()
    listing.data = { path: '/fixture', parent: null, dirs: [] }
    view.rerender(<FolderBrowser {...props} />)
    expect(screen.getByText('No subfolders')).toBeTruthy()
    listing.isError = true; listing.error = new Error('Access refused')
    view.rerender(<FolderBrowser {...props} />)
    expect(screen.getByRole('alert').textContent).toBe('Access refused')
    expect(screen.queryByText('No subfolders')).toBeNull()
    listing.isError = false; listing.data = undefined
  })

  it('storage keeps independent keys, explicit false and width bounds across reload reads', () => {
    writeStoredCollapsed({ one: false, two: true }); writeStoredSidebarWidth(333)
    expect(readStoredCollapsed()).toEqual({ one: false, two: true })
    expect(readStoredSidebarWidth()).toBe(333)
    writeStoredSidebarWidth(1000)
    expect(readStoredSidebarWidth()).toBe(420)
    expect(readStoredCollapsed()).toEqual({ one: false, two: true })
  })

  it('unavailable browser storage never prevents navigation defaults', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    expect(readStoredCollapsed()).toEqual({})
    expect(readStoredSidebarWidth()).toBe(264)
    expect(() => { writeStoredCollapsed({ one: true }); writeStoredSidebarWidth(300) }).not.toThrow()
  })
})

it('T-0 B2 removed keys stay absent and the guardian ceiling cannot rise', () => {
  const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
  const keys = Object.keys(JSON.parse(read('./design-guardian-spacing-allowlist.json')))
  const owned = ['app-shell', 'centered-state', 'command-palette', 'project-groups']
  expect(keys.filter((key) => owned.some((name) => key.startsWith(`src/components/${name}.tsx|`)))).toEqual([])
  expect(keys.length).toBeLessThanOrEqual(45)
  expect(Number(read('./design-guardian.test.ts').match(/const SPACING_ALLOWLIST_CEILING = (\d+)/)?.[1])).toBeLessThanOrEqual(45)
})
