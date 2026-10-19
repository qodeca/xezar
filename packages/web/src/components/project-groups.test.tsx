import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import type { ProjectListEntry, RunIndexEntry, RunRecord, RunsIndexResponse } from '@qodeca/xezar-api-client'
import { ProjectGroups } from '@/components/project-groups'
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from '@/lib/sidebar-collapse'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  localStorage.clear()
  vi.unstubAllGlobals()
})

/** Seed the per-browser collapse map the sidebar reads at mount. */
function storeCollapsed(collapsed: Record<string, boolean>): void {
  localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, JSON.stringify(collapsed))
}

function storedCollapsed(): unknown {
  const raw = localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
  return raw === null ? null : JSON.parse(raw)
}

function project(over: Partial<ProjectListEntry> = {}): ProjectListEntry {
  return {
    id: 'xezar',
    name: 'xezar',
    root: '/home/me/Projects/xezar',
    addedAt: '2026-07-01T00:00:00.000Z',
    lastOpenedAt: '2026-07-20T12:00:00.000Z',
    source: 'local',
    status: 'ok',
    branch: 'main',
    forge: 'github',
    ...over,
  }
}

let seq = 0

function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'default',
    task: `task ${seq}`,
    status: 'done',
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

/** One cross-project runs-index row (`GET /workspace/runs-index`) for `projectId`. */
function indexRow(projectId: string, over: Partial<RunIndexEntry> = {}): RunIndexEntry {
  seq += 1
  return {
    projectId,
    id: `r${seq}`,
    title: `Task ${seq}`,
    status: 'done',
    createdAt: '2026-07-14T10:00:00.000Z',
    archived: false,
    workflow: 'default',
    runner: 'claude',
    ...over,
  }
}

function runsIndex(runs: RunIndexEntry[]): RunsIndexResponse {
  return { runs, referenceStatuses: {}, perProjectLimit: 200, truncated: [], attention: {}, unreadable: [], registryUnreadable: false }
}

const INDEX_URL = '/api/v1/workspace/runs-index'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * Answer each endpoint the sidebar reads; anything else 404s loudly rather than silently
 * resolving and making a broken wiring look fine.
 *
 * Collapse is deliberately NOT among those endpoints — it is per-browser state (localStorage),
 * so a group toggle must cost this map zero requests.
 */
function serve(routes: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (input) => {
    const body = routes[String(input)]
    if (body === undefined) return json({ error: 'not found' }, 404)
    return json(body)
  })
}

function renderGroups(
  projects: ProjectListEntry[],
  entry = '/p/xezar/',
  // #801: workspace-wide, unlike the per-project forge gate — one env var on the one server that
  // serves every group. Off by default here, exactly as a default server reports it.
  { automations = false }: { automations?: boolean } = {},
) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <ProjectGroups projects={projects} bootProjectId="xezar" automationsAvailable={automations} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const group = (id: string) =>
  document.querySelector(`[data-slot="project-group"][data-project="${id}"]`) as HTMLElement

const header = (id: string) =>
  within(group(id)).getByRole('button') as HTMLButtonElement

describe('ProjectGroups', () => {
  // #546: a group is navigation only. With runs in its cache — the data the removed quick-list
  // painted — an expanded group holds its header and its nav, and nothing else: no task row, no
  // bucket heading, no pin button, no More… row. The Tasks nav item is the door to that project's
  // tasks.
  it('lists no tasks in an expanded group, only the project nav', async () => {
    const runs = [
      ...Array.from({ length: 12 }, (_, index) => run({ titleSummary: `Listed task ${index}` })),
      run({ titleSummary: 'Waiting on you', status: 'waiting' }),
      run({ titleSummary: 'Pinned work', pinned: true }),
    ]
    serve({
      '/api/v1/p/xezar/runs': runs,
      [INDEX_URL]: runsIndex(runs.map((r) => indexRow('xezar', { id: r.id, title: r.title, status: r.status }))),
    })
    renderGroups([project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })])

    // The badge proves the index arrived before the absence below is read.
    await waitFor(() =>
      expect(group('xezar').querySelector('[data-slot="project-attention"]')?.textContent).toBe('1'),
    )
    const xezar = within(group('xezar'))
    expect(xezar.queryByText(/^Listed task|^Waiting on you$|^Pinned work$/)).toBeNull()
    expect(xezar.queryByText(/^(Needs you|Working|Recent|Pinned)$/)).toBeNull()
    expect(xezar.queryByRole('link', { name: 'More…' })).toBeNull()
    expect(xezar.queryByRole('button', { name: /pin task/i })).toBeNull()
    // Every link in the group is a nav item, and the Tasks item still leads to the project's tasks.
    const nav = xezar.getByRole('navigation', { name: 'xezar navigation' })
    expect(xezar.getAllByRole('link')).toEqual(within(nav).getAllByRole('link'))
    expect(within(nav).getByRole('link', { name: 'Tasks' }).getAttribute('href')).toBe('/p/xezar/')
    // The only button is the header's disclosure toggle.
    expect(xezar.getAllByRole('button')).toEqual([header('xezar')])
  })

  it('orders groups by lastOpenedAt, and no group fetches its own runs — one index request', async () => {
    serve({ [INDEX_URL]: runsIndex([]) })
    renderGroups([
      project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-18T00:00:00.000Z' }),
      project(),
    ])

    await waitFor(() => expect(header('xezar').getAttribute('aria-expanded')).toBe('true'))
    expect(
      Array.from(document.querySelectorAll('[data-slot="project-group"]')).map((el) =>
        el.getAttribute('data-project'),
      ),
    ).toEqual(['xezar', 'shop'])
    // Collapsed or expanded, a group costs no runs request: every badge reads the one
    // workspace index.
    expect(header('shop').getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(INDEX_URL))
    // (The scope's own `/runs` list — the one the Tasks page holds — is the failed-index fallback
    // and is shared with that page; what must never happen is a request per group.)
    const asked = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(asked.filter((url) => /\/p\/[^/]+\/runs$/.test(url))).toEqual([])
  })

  it('renders each group’s nav scoped to that project', async () => {
    storeCollapsed({ shop: false })
    serve({ '/api/v1/p/xezar/runs': [], '/api/v1/p/shop/runs': [] })
    renderGroups([project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })])

    await waitFor(() => expect(header('shop').getAttribute('aria-expanded')).toBe('true'))
    const shopNav = within(group('shop')).getByRole('navigation', { name: 'shop navigation' })
    expect(within(shopNav).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/p/shop/',
      '/p/shop/git',
      '/p/shop/github',
      '/p/shop/skills',
      '/p/shop/workflows',
      '/p/shop/settings',
    ])
    // Only the group that owns the URL lights a nav row — `/p/xezar/` is the Tasks area of
    // exactly one project, not of every project whose nav lists a Tasks row.
    expect(within(shopNav).queryByRole('link', { current: 'page' })).toBeNull()
    const xezarNav = within(group('xezar')).getByRole('navigation', { name: 'xezar navigation' })
    expect(within(xezarNav).getByRole('link', { current: 'page' }).textContent).toBe('Tasks')
  })

  it("gates each group's GitHub tab on that project's own forge (#698)", async () => {
    // Two expanded groups, one with a GitHub remote and one without: the GitHub nav item must
    // follow each entry's own `forge` field, not one workspace-wide answer — the exact failure
    // was every group hiding (or showing) GitHub based on the folder xezar was LAUNCHED in.
    storeCollapsed({ plain: false })
    serve({
      '/api/v1/p/xezar/runs': [],
      '/api/v1/p/plain/runs': [],
    })
    renderGroups([
      project(),
      project({ id: 'plain', name: 'plain', forge: undefined, lastOpenedAt: '2026-07-19T00:00:00.000Z' }),
    ])

    await waitFor(() => expect(header('plain').getAttribute('aria-expanded')).toBe('true'))
    const xezarNav = within(group('xezar')).getByRole('navigation', { name: 'xezar navigation' })
    expect(within(xezarNav).getByRole('link', { name: 'GitHub' }).getAttribute('href')).toBe('/p/xezar/github')
    const plainNav = within(group('plain')).getByRole('navigation', { name: 'plain navigation' })
    expect(within(plainNav).queryByRole('link', { name: 'GitHub' })).toBeNull()
  })

  // #801: every group reads ONE workspace capability, so no group can offer Automations while
  // another hides it — and with the opt-in off, none of them offers it at all.
  it("gates every group's Automations tab on the workspace capability (#801)", async () => {
    storeCollapsed({ shop: false })
    serve({ '/api/v1/p/xezar/runs': [], '/api/v1/p/shop/runs': [] })
    const shop = project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })
    const view = renderGroups([project(), shop], '/p/xezar/', { automations: true })

    await waitFor(() => expect(header('shop').getAttribute('aria-expanded')).toBe('true'))
    for (const id of ['xezar', 'shop']) {
      const nav = within(group(id)).getByRole('navigation', { name: `${id} navigation` })
      expect(within(nav).getByRole('link', { name: 'Automations' }).getAttribute('href'))
        .toBe(`/p/${id}/automations`)
    }

    view.unmount()
    renderGroups([project(), shop])
    await waitFor(() => expect(header('shop').getAttribute('aria-expanded')).toBe('true'))
    for (const id of ['xezar', 'shop']) {
      const nav = within(group(id)).getByRole('navigation', { name: `${id} navigation` })
      expect(within(nav).queryByRole('link', { name: 'Automations' })).toBeNull()
    }
  })

  it('round-trips a collapse through this browser’s storage, never the server', async () => {
    serve({ '/api/v1/p/xezar/runs': [] })
    renderGroups([project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })])

    await waitFor(() => expect(header('xezar').getAttribute('aria-expanded')).toBe('true'))

    fireEvent.click(header('xezar'))
    await waitFor(() => expect(header('xezar').getAttribute('aria-expanded')).toBe('false'))
    expect(storedCollapsed()).toEqual({ xezar: true })

    // …and expanding it again writes the other way, composing with the entry already stored.
    fireEvent.click(header('xezar'))
    await waitFor(() => expect(header('xezar').getAttribute('aria-expanded')).toBe('true'))
    expect(storedCollapsed()).toEqual({ xezar: false })

    // Not one request either way: the collapse map never leaves this browser.
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).not.toContain('PUT')
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain(
      '/api/v1/workspace/ui-state',
    )
  })

  it('starts from the stored collapse rather than the active-project default', async () => {
    storeCollapsed({ xezar: true })
    serve({
      '/api/v1/p/xezar/runs': [],
    })
    renderGroups([project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })])

    // The active project, pinned shut by the user, stays shut across a reload.
    await waitFor(() => expect(header('xezar').getAttribute('aria-expanded')).toBe('false'))
  })

  it('badges a group with its needs-you count', async () => {
    serve({
      [INDEX_URL]: runsIndex([
        indexRow('xezar', { status: 'waiting' }),
        indexRow('xezar', { status: 'review' }),
        indexRow('xezar'),
        // Archived work is done with, whatever its status says — not counted.
        indexRow('xezar', { status: 'waiting', archived: true }),
      ]),
    })
    renderGroups([project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })])

    await waitFor(() =>
      expect(group('xezar').querySelector('[data-slot="project-attention"]')?.textContent).toBe('2'),
    )
    // Nothing waiting, nothing to badge — a "0" here is noise, not information.
    expect(group('shop').querySelector('[data-slot="project-attention"]')).toBeNull()
  })

  it('a COLLAPSED group still shows its count', async () => {
    // The bug: a collapsed group fetched nothing, and the default collapses every project but the
    // current one — so the projects you are not looking at, the ones a badge exists for, had none.
    serve({ [INDEX_URL]: runsIndex([indexRow('shop', { status: 'waiting' }), indexRow('shop', { status: 'review' })]) })
    renderGroups([project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })])

    expect(header('shop').getAttribute('aria-expanded')).toBe('false')
    await waitFor(() =>
      expect(group('shop').querySelector('[data-slot="project-attention"]')?.textContent).toBe('2'),
    )
    expect(group('shop').querySelector('[data-slot="project-attention"]')?.getAttribute('title')).toBe(
      '2 tasks need you',
    )
    // The header's accessible name reads cleanly: name, count sentence, branch — and the badge
    // is no live region of its own (the shell owns the one announcement).
    expect(header('shop').textContent?.replace(/\s+/g, ' ').trim()).toBe('shop 2 tasks need you2main')
    expect(within(header('shop')).getByText('2 tasks need you').closest('[role="status"]')).toBeNull()
  })

  it('counts a collapsed project’s tasks that are older than its newest rows', async () => {
    // The server counts over ALL runs; `beyondLimit` is the share no row carries.
    serve({ [INDEX_URL]: { ...runsIndex([indexRow('shop', { status: 'review' })]), attention: { shop: { total: 3, beyondLimit: 2 } } } })
    renderGroups([project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })])

    await waitFor(() =>
      expect(group('shop').querySelector('[data-slot="project-attention"]')?.textContent).toBe('3'),
    )
  })

  it('when the index cannot be read: the anchor project counts from its own list, the others show no number', async () => {
    // Not a silent zero: every badge disappearing reads as "nothing needs you", which is the
    // one thing nobody may conclude from a failed request.
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === INDEX_URL) return json({ error: 'workspace unreadable' }, 500)
      if (url === '/api/v1/runs') return json([run({ status: 'waiting' }), run({ status: 'review' })])
      return json({ error: 'not found' }, 404)
    })
    renderGroups([project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })])

    // The query client retries a 5xx once, so the failure lands after its retry delay.
    await waitFor(
      () => expect(group('xezar').querySelector('[data-slot="project-attention"]')?.textContent).toBe('2'),
      { timeout: 5_000 },
    )
    expect(group('shop').querySelector('[data-slot="project-attention"]')).toBeNull()
    // No per-row word: the one stale line lives under All tasks (app-shell), never in a header,
    // where it read as part of the branch name.
    expect(document.querySelector('[data-slot="attention-stale"]')).toBeNull()
    expect(header('shop').textContent).not.toContain('stale')
  })

  it("updates another project's badge the moment its index row changes", async () => {
    // What the global stream does for ANY project's run event (applyRunToIndex): patch the row
    // in place. The badge reads that cache, so no refetch is needed for it to move.
    const client = createQueryClient()
    const theirs = indexRow('shop', { status: 'running' })
    serve({ [INDEX_URL]: runsIndex([theirs]) })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/p/xezar/']}>
          <ProjectGroups projects={[project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })]} bootProjectId="xezar" />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(client.getQueryData(workspaceQueryKeys.runsIndex)).toBeDefined())
    expect(group('shop').querySelector('[data-slot="project-attention"]')).toBeNull()

    client.setQueryData(workspaceQueryKeys.runsIndex, runsIndex([{ ...theirs, status: 'waiting' }]))

    await waitFor(() =>
      expect(group('shop').querySelector('[data-slot="project-attention"]')?.textContent).toBe('1'),
    )
    expect(group('xezar').querySelector('[data-slot="project-attention"]')).toBeNull()
  })

  it('shows no badge at all while the index is unknown', async () => {
    serve({})
    renderGroups([project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })])
    await waitFor(() => expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(INDEX_URL))
    expect(document.querySelector('[data-slot="project-attention"]')).toBeNull()
  })

  it('renders a missing project greyed and inert, with no nav behind it', async () => {
    serve({ '/api/v1/p/xezar/runs': [] })
    renderGroups([project(), project({ id: 'gone', name: 'old-spike', status: 'missing', lastOpenedAt: '2026-07-01T00:00:00.000Z' })])

    await waitFor(() => expect(group('gone')).not.toBeNull())
    expect(group('gone').querySelector('[data-slot="project-missing"]')?.textContent).toBe(
      'folder not found',
    )
    // Every pane of a missing project 409s, so there is nothing to expand into and nothing to
    // link at — the row states the fact and stops.
    expect(within(group('gone')).queryByRole('button')).toBeNull()
    expect(within(group('gone')).queryAllByRole('link')).toHaveLength(0)
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain('/api/v1/p/gone/runs')
  })

  /**
   * A `/p/` prefix is the ONLY thing that makes a project the one you are standing in. On the
   * global pages — `/tasks` and `/settings/global` — there is no such prefix and no selected
   * project, so nothing may be painted as selected: highlighting the boot project while the
   * user reads an all-projects table says the page is about that project when it is not.
   */
  it('marks no project as selected on a page that belongs to none', async () => {
    serve({ '/api/v1/p/xezar/runs': [] })
    renderGroups(
      [project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })],
      '/tasks',
    )

    await waitFor(() => expect(group('xezar')).not.toBeNull())
    for (const id of ['xezar', 'shop']) {
      expect(group(id).hasAttribute('data-active')).toBe(false)
      expect(group(id).querySelector('[aria-current="page"]')).toBeNull()
    }
    // The boot group still OPENS by default: landing on a global page must not fold the whole
    // sidebar shut — that is a different question from which one is selected.
    expect(header('xezar').getAttribute('aria-expanded')).toBe('true')
  })

  it('still marks the scoped project on a project page', async () => {
    serve({ '/api/v1/p/shop/runs': [] })
    renderGroups(
      [project(), project({ id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' })],
      '/p/shop/git',
    )

    await waitFor(() => expect(group('shop')).not.toBeNull())
    expect(group('shop').hasAttribute('data-active')).toBe(true)
    expect(group('xezar').hasAttribute('data-active')).toBe(false)
    // …and the nav row for the URL's own area is the current page inside that group only.
    expect(group('shop').querySelector('[aria-current="page"]')?.textContent).toBe('Git')
    expect(group('xezar').querySelector('[aria-current="page"]')).toBeNull()
  })
})
