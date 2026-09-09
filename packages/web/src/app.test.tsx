import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectScope } from './api/project-scope-context'
import { useUsage } from './api/global-events'
import { useQueryClient } from '@tanstack/react-query'
import { App } from './app'

/**
 * The boot shell (#50, coverage gap R11).
 *
 * Every other cockpit test mounts its route under providers it builds itself, so the REAL
 * composition in app.tsx — query client → global events → theme → appearance → router →
 * reference registry → shell → routes → project scope — is the one stack nothing executes.
 * A reordering that puts a consumer above its provider therefore passes every route test and
 * blanks the app.
 *
 * Two session-global signals are asserted by COUNT, not by presence, because that is what
 * AGENTS.md actually requires of the root: exactly one `/api/v1/workspace/events` stream and
 * exactly one `health` topic subscription for the app's whole life, each released on unmount.
 * "A leaked subscription is a server publisher that never stops."
 */

/** The one `health` topic subscription, spied at the ws.ts seam. Counting frames on a fake
 *  WebSocket would count the module-level shared socket's state instead, which survives
 *  between tests; ws.ts's own ref-counting is covered by api/ws.test.ts. */
const topics = vi.hoisted(() => {
  const release = vi.fn()
  return {
    release,
    subscribeTopic: vi.fn((_topic: string, _listener: (data: unknown) => void) => release),
  }
})

vi.mock('./api/ws', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api/ws')>()),
  subscribeTopic: topics.subscribeTopic,
}))

/**
 * A hole in the routed tree, at the deepest point of the real stack.
 *
 * The catch-all 404 is registered INSIDE `/p/:projectId` (routes.tsx), so swapping it lets a
 * probe mount under `ProjectScopeProvider` — the one provider no wrapper above `AppRoutes`
 * supplies. Nothing is stubbed while `renderNode` is null, so the other tests see the real 404.
 */
const routeHole = vi.hoisted(() => ({ renderNode: null as null | (() => unknown) }))

vi.mock('./routes/not-found', async (importOriginal) => {
  const [actual, react] = await Promise.all([
    importOriginal<typeof import('./routes/not-found')>(),
    import('react'),
  ])
  return {
    ...actual,
    NotFoundRoute: () =>
      routeHole.renderNode
        ? (routeHole.renderNode() as ReturnType<typeof react.createElement>)
        : react.createElement(actual.NotFoundRoute),
  }
})

/** Just enough EventSource for global-events.tsx: records every instance so the test can count
 *  them, and lets the test deliver a named server frame by hand. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>()
  readyState = 0
  closed = false

  constructor(readonly url: string, readonly options?: EventSourceInit) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, listener: (event: MessageEvent<string>) => void): void {
    let held = this.listeners.get(name)
    if (!held) {
      held = new Set()
      this.listeners.set(name, held)
    }
    held.add(listener)
  }

  removeEventListener(name: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.get(name)?.delete(listener)
  }

  close(): void {
    this.closed = true
    this.readyState = 2
  }

  /** Deliver one named server-sent event, exactly as the browser would. */
  emit(name: string, payload: unknown): void {
    const event = { data: JSON.stringify(payload) } as MessageEvent<string>
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event)
  }
}

const BOOT = 'boot'
/** A registered NON-boot project: the boot project mounts the scope provider with `null` by
 *  design (step 3.1), so only a second project proves the scope actually reached the child. */
const SCOPED = 'other'

const HEALTH = {
  version: '0.0.0-test',
  repoRoot: '/home/u/xezar',
  repo: { root: '/home/u/xezar', branch: 'main' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  // localHandoff drives the health TRANSPORT choice (queries.ts): local cockpits subscribe to
  // the topic, remote ones stay on authenticated HTTP.
  capabilities: { localHandoff: true, followups: false, singleProject: false, automations: false },
  projects: [
    { id: BOOT, name: 'xezar' },
    { id: SCOPED, name: 'other-repo' },
  ],
  bootProject: BOOT,
}

const REGISTRY = {
  projects: [
    { id: BOOT, name: 'xezar', root: '/home/u/xezar', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok' },
    { id: SCOPED, name: 'other-repo', root: '/home/u/other', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok' },
  ],
  bootProject: BOOT,
  projectsDir: '~/xezar/projects',
}

/** The mocked API. Only the boot inputs answer; everything else stays honestly in flight, the
 *  same stance routes.test.tsx takes — this file is about the shell, not about any view's data. */
function mockApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname
      const body =
        path === '/api/v1/health' ? HEALTH
        : path === '/api/v1/projects' ? REGISTRY
        : path === '/api/v1/workspace/ui-state' ? {}
        : undefined
      if (body === undefined) return new Promise<never>(() => {})
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    }),
  )
}

/** Cold-load the real `<App />` at a URL. BrowserRouter reads `window.location`, so the URL is
 *  the address bar — exactly how the app boots in a browser. */
function renderApp(url: string) {
  window.history.pushState({}, '', url)
  return render(<App />)
}

beforeEach(() => {
  mockApi()
  vi.stubGlobal('EventSource', FakeEventSource)
  FakeEventSource.instances = []
  topics.subscribeTopic.mockClear()
  topics.release.mockClear()
  routeHole.renderNode = null
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  routeHole.renderNode = null
  localStorage.clear()
  window.history.pushState({}, '', '/')
  vi.unstubAllGlobals()
})

describe('<App /> — the boot shell', () => {
  it('renders the shell and the routed outlet without throwing', async () => {
    renderApp(`/p/${BOOT}/`)

    // The shell chrome, from the real AppShellContainer inside the real provider stack. Painted
    // on the very first commit, before any request answers — the cockpit has no boot spinner.
    expect(document.querySelector('[data-slot="app-shell"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="sidebar"]')).not.toBeNull()
    expect(screen.getByRole('navigation', { name: 'Main' })).not.toBeNull()

    // The outlet really routed: `/` under a registered project is the Tasks view, and it only
    // resolves once the registry answers through the shell's own query client.
    await waitFor(() => expect(document.querySelector('[data-route="tasks"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="main"]')).not.toBeNull()
    // …and the settled registry reached the sidebar too: two registered projects is the grouped
    // sidebar, so the shell is reading the same cache the routes are.
    await waitFor(() => expect(document.querySelector('[data-slot="project-groups"]')).not.toBeNull())
  })

  it('paints the version chip from the health it fetched itself', async () => {
    renderApp(`/p/${BOOT}/`)
    // Nothing seeds this cache: the shell's own `useHealth` fetched it through the query client
    // App created. A chip carrying the mocked version proves the whole request path, not just
    // the markup.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="version-chip"]')?.textContent).toContain('v0.0.0-test'),
    )
  })

  /**
   * The acceptance criterion's named test: reorder two providers in app.tsx so a consumer sits
   * above its provider and this fails. It reads all three contexts from a probe mounted at the
   * DEEPEST point of the real tree — the routed 404, inside `ProjectScopeProvider` — so the
   * whole chain has to be intact for it to pass.
   */
  it('resolves the query client, the project scope and the global-events store for a routed child', async () => {
    let scopeSeen: string | null | undefined
    let clientSeen: unknown
    // Inlined into the mocked route's own component body, so these are ordinary hook calls.
    routeHole.renderNode = () => {
      clientSeen = useQueryClient()
      scopeSeen = useProjectScope().projectId
      const usage = useUsage()
      return <div data-testid="probe" data-usage={JSON.stringify(usage)} />
    }

    renderApp(`/p/${SCOPED}/probe-hole`)
    await waitFor(() => expect(screen.getByTestId('probe')).not.toBeNull())

    // QueryClientProvider — `useQueryClient` throws outside it, so reaching here is the proof.
    expect(clientSeen).toBeDefined()
    // ProjectScopeProvider, mounted by the routes below the shell.
    expect(scopeSeen).toBe(SCOPED)

    // GlobalEventsProvider: `useUsage` returns an empty map outside a provider rather than
    // throwing, so presence is proved by a live sample arriving through the root stream and
    // reaching this child. Nothing but a mounted provider can deliver it.
    const stream = FakeEventSource.instances.at(-1)
    if (!stream) throw new Error('the app opened no workspace event stream')
    stream.emit('usage', { project: SCOPED, usage: { 'run-1': { cpuPct: 12, rssBytes: 1024, procCount: 2 } } })
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('probe').getAttribute('data-usage') ?? '{}')).toEqual({
        'run-1': { cpuPct: 12, rssBytes: 1024, procCount: 2 },
      }),
    )
  })

  it('opens exactly one workspace event stream for the whole app and closes it on unmount', async () => {
    const view = renderApp(`/p/${BOOT}/`)
    await waitFor(() => expect(document.querySelector('[data-route="tasks"]')).not.toBeNull())

    // One stream, at the root, for the app's whole life — not one per route or per reader.
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]?.url).toBe('/api/v1/workspace/events')
    expect(FakeEventSource.instances[0]?.closed).toBe(false)

    view.unmount()
    expect(FakeEventSource.instances[0]?.closed).toBe(true)
  })

  it('establishes the health topic subscription exactly once and releases it on unmount', async () => {
    const view = renderApp(`/p/${BOOT}/`)

    // The subscription opens only after health confirms a LOCAL cockpit, and the sync callback
    // re-runs on every query-cache event — a busy boot is exactly where a missing guard shows up
    // as a second subscribe.
    await waitFor(() => expect(topics.subscribeTopic).toHaveBeenCalledTimes(1))
    expect(topics.subscribeTopic.mock.calls[0]?.[0]).toBe('health')
    await waitFor(() => expect(document.querySelector('[data-route="tasks"]')).not.toBeNull())
    expect(topics.subscribeTopic).toHaveBeenCalledTimes(1)
    expect(topics.release).not.toHaveBeenCalled()

    view.unmount()
    expect(topics.release).toHaveBeenCalledTimes(1)
  })

  /**
   * PINS A GAP, not a guarantee (#50 asked for the opposite and the shell does not have it).
   * There is no error boundary anywhere in packages/web/src, so a routed child that throws
   * takes the whole document with it — sidebar included — and the reader gets a blank page with
   * no way back. This test records exactly that, so the day a boundary is added it fails and
   * has to be rewritten into the assertion #50 actually wants.
   */
  it('has NO error boundary — a throwing routed child blanks the whole shell', async () => {
    const errors: unknown[] = []
    const onError = (event: ErrorEvent): void => {
      errors.push(event.error)
      event.preventDefault()
    }
    window.addEventListener('error', onError)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    routeHole.renderNode = () => {
      throw new Error('a routed child exploded')
    }

    try {
      renderApp(`/p/${SCOPED}/probe-hole`)
      // The shell paints first — the throw only happens once the registry settles and the scoped
      // route mounts, which is the realistic shape of this failure.
      expect(document.querySelector('[data-slot="app-shell"]')).not.toBeNull()

      await waitFor(() => expect(document.querySelector('[data-slot="app-shell"]')).toBeNull())
      // Nothing recoverable is left: no shell, no route, no message.
      expect(document.querySelector('[data-route]')).toBeNull()
      expect(document.body.textContent).toBe('')
      expect(errors.some((error) => (error as Error | undefined)?.message === 'a routed child exploded')).toBe(true)
    } finally {
      window.removeEventListener('error', onError)
      consoleError.mockRestore()
    }
  })
})
