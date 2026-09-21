import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { withProjectInstances } from '@/api/queries'
import type { HealthResponse, ProjectsResponse } from '@qodeca/xezar-api-client'
import { AppShellContainer } from '@/components/app-shell-container'
import { ThemeProvider } from '@/components/theme-provider'

/**
 * The "Other projects" band stays LIVE (#796, found in QA of #467 PR 4).
 *
 * The band's rows render `ProjectListEntry.instance`, which the server derives per request. It was
 * read exactly once, at page load, and nothing ever asked again: no workspace event fires when
 * ANOTHER process starts or stops, and the registry query has no interval. So a row answered
 * `checking` — the honest first read of a project with a remembered address, because the probe
 * runs off the request rather than blocking the list — sat on `checking…` for as long as the page
 * was open, and a project that stopped kept a link to a dead port.
 *
 * `BREAK-796-BAND-NEVER-REFRESHES` is the named break and this file is its proof: remove the
 * `useProjectInstancesSubscription` call from `app-shell-container.tsx` (or the topic listener
 * behind it) and both DOM cases below go red while every other test in the cockpit stays green —
 * which is exactly the shape the defect shipped in.
 */

/** Spied at the ws.ts seam, so the test drives the topic the way the server would: one listener
 *  per topic, and the release the effect must return. Counting frames on a fake WebSocket would
 *  count the module-level shared socket, which survives between tests. */
const topics = vi.hoisted(() => {
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  return {
    listeners,
    release: vi.fn(),
    subscribeTopic: vi.fn((topic: string, listener: (data: unknown) => void) => {
      const held = listeners.get(topic) ?? new Set()
      held.add(listener)
      listeners.set(topic, held)
      return () => {
        held.delete(listener)
        topics.release()
      }
    }),
  }
})

vi.mock('@/api/ws', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/ws')>()),
  subscribeTopic: topics.subscribeTopic,
}))

const fetchMock = vi.fn<typeof fetch>()

const PROJECT = {
  id: 'xezar',
  name: 'xezar',
  root: '/home/me/Projects/xezar',
  addedAt: '2026-07-01T00:00:00.000Z',
  lastOpenedAt: '2026-07-20T12:00:00.000Z',
  source: 'local' as const,
  status: 'ok' as const,
  branch: 'main',
}

const HEALTH: HealthResponse = {
  version: '0.1.3',
  channel: 'release',
  projects: [],
  bootProject: 'xezar',
  repoRoot: '/home/me/Projects/xezar',
  repo: { root: '/home/me/Projects/xezar', branch: 'main', remote: 'origin' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: {
    localHandoff: true,
    tokenMetrics: true,
    tokenUsageMetrics: true,
    costMetrics: true,
    followups: false,
    singleProject: false,
    automations: false,
    instanceMode: 'project',
  },
}

/** The registry as a cockpit opened right after `xez` boots really receives it: the sibling has a
 *  remembered address, so its first answer is `checking` (contract/src/projects.ts). */
const REGISTRY: ProjectsResponse = {
  projects: [
    PROJECT,
    {
      ...PROJECT,
      id: 'shop',
      name: 'shop',
      root: '/home/me/Projects/shop',
      lastOpenedAt: '2026-07-19T00:00:00.000Z',
      instance: { state: 'checking' },
    },
  ],
  bootProject: 'xezar',
  projectsDir: '/home/me/xezar/projects',
}

function serve(routes: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (input) => {
    const path = String(input)
    const response = routes[path]
    if (response === undefined) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    }
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  serve({
    '/api/v1/health': HEALTH,
    '/api/v1/projects': REGISTRY,
    '/api/v1/runs': [],
    '/api/v1/providers/status': { providers: [] },
    '/api/v1/workspace/ui-state': {},
  })
})

afterEach(() => {
  cleanup()
  topics.listeners.clear()
  topics.subscribeTopic.mockClear()
  topics.release.mockClear()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function renderShell() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/']}>
          <AppShellContainer>
            <p>route content</p>
          </AppShellContainer>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

/** Push one `project-instances` frame the way the server's publisher would. */
function publish(projects: Record<string, unknown>): void {
  act(() => {
    for (const listener of topics.listeners.get('project-instances') ?? []) {
      listener({ projects })
    }
  })
}

const row = (id: string) =>
  document.querySelector(`[data-slot="sidebar"] [data-slot="other-project"][data-project-id="${id}"]`)
const stateWord = (id: string) =>
  row(id)?.querySelector('[data-slot="other-project-state"]')?.textContent ?? null

describe('the Other projects band converges on what the server now says (#796)', () => {
  it('resolves `checking…` and then follows the sibling stopping and starting again', async () => {
    renderShell()

    // What the page-load read alone gives, and what it used to stay on forever.
    await waitFor(() => expect(row('shop')).not.toBeNull())
    expect(stateWord('shop')).toBe('checking…')
    await waitFor(() =>
      expect(topics.subscribeTopic.mock.calls.filter(([topic]) => topic === 'project-instances')).toHaveLength(1),
    )

    // The publisher's settled snapshot: it IS running, at its own address. The wait is TanStack's
    // own notify batching, not this subscription's — a direct `setQueryData` needs the same one.
    publish({ shop: { state: 'running', url: 'http://localhost:4401/p/shop/' } })
    await waitFor(() => expect(stateWord('shop')).toBe('running'))
    expect(row('shop')?.querySelector('a')?.getAttribute('href')).toBe('http://localhost:4401/p/shop/')

    // The QA reproduction: stop that project's cockpit. The row must lose the dead link.
    publish({ shop: { state: 'stopped' } })
    await waitFor(() => expect(stateWord('shop')).toBe('not running'))
    expect(row('shop')?.querySelector('a')).toBeNull()
    expect(row('shop')?.querySelector('[data-action="other-project-copy-command"]')).not.toBeNull()

    // And start it again.
    publish({ shop: { state: 'running', url: 'http://localhost:4401/p/shop/' } })
    await waitFor(() => expect(stateWord('shop')).toBe('running'))
  })

  it('releases the topic on unmount — a held subscription is a publisher that never stops', async () => {
    const { unmount } = renderShell()
    await waitFor(() =>
      expect(topics.subscribeTopic.mock.calls.filter(([topic]) => topic === 'project-instances')).toHaveLength(1),
    )
    unmount()
    expect(topics.release).toHaveBeenCalled()
    expect(topics.listeners.get('project-instances')?.size ?? 0).toBe(0)
  })

  it('opens no topic in workspace mode, and none in a hosted cockpit', async () => {
    serve({
      '/api/v1/health': { ...HEALTH, capabilities: { ...HEALTH.capabilities, instanceMode: undefined } },
      '/api/v1/projects': REGISTRY,
      '/api/v1/runs': [],
      '/api/v1/providers/status': { providers: [] },
      '/api/v1/workspace/ui-state': {},
    })
    renderShell()
    await screen.findByText('route content')
    expect(topics.listeners.get('project-instances')?.size ?? 0).toBe(0)

    cleanup()
    // Hosted: no browser WebSocket at all (it cannot carry the proxy's credentials), and the rows
    // carry no `instance` to refresh in the first place.
    serve({
      '/api/v1/health': { ...HEALTH, capabilities: { ...HEALTH.capabilities, localHandoff: false } },
      '/api/v1/projects': REGISTRY,
      '/api/v1/runs': [],
      '/api/v1/providers/status': { providers: [] },
      '/api/v1/workspace/ui-state': {},
    })
    renderShell()
    await screen.findByText('route content')
    expect(topics.listeners.get('project-instances')?.size ?? 0).toBe(0)
  })
})

describe('withProjectInstances', () => {
  it('returns the very same object when the frame says nothing new', () => {
    const same = withProjectInstances(REGISTRY, { projects: { shop: { state: 'checking' } } })
    // Identity, not equality: the hook re-applies the latest frame on every cache change, and its
    // own write is one — a fresh object each time would loop.
    expect(same).toBe(REGISTRY)
  })

  it('leaves a row the frame does not mention exactly as it was', () => {
    const merged = withProjectInstances(REGISTRY, { projects: {} })
    expect(merged).toBe(REGISTRY)
    expect(merged.projects[1]?.instance).toEqual({ state: 'checking' })
  })

  it('replaces the instance, and only the instance, of a row it names', () => {
    const merged = withProjectInstances(REGISTRY, {
      projects: { shop: { state: 'running', url: 'http://localhost:4401/p/shop/' } },
    })
    expect(merged).not.toBe(REGISTRY)
    expect(merged.projects[1]).toEqual({
      ...REGISTRY.projects[1],
      instance: { state: 'running', url: 'http://localhost:4401/p/shop/' },
    })
    expect(merged.projects[0]).toBe(REGISTRY.projects[0])
    expect(merged.bootProject).toBe(REGISTRY.bootProject)
  })

  it('notices a url that changed under an unchanged state', () => {
    const running: ProjectsResponse = withProjectInstances(REGISTRY, {
      projects: { shop: { state: 'running', url: 'http://localhost:4401/p/shop/' } },
    })
    const moved = withProjectInstances(running, {
      projects: { shop: { state: 'running', url: 'http://localhost:4402/p/shop/' } },
    })
    expect(moved).not.toBe(running)
    expect(moved.projects[1]?.instance?.url).toBe('http://localhost:4402/p/shop/')
  })
})
