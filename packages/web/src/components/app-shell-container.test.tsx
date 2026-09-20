import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import type {
  HealthResponse,
  ProviderStatusResponse,
  RunRecord,
  SkillsUpdateState,
} from '@qodeca/xezar-api-client'
import { AppShellContainer, repoChipOf, skillsUpdateMarkerOf } from '@/components/app-shell-container'
import { ThemeProvider } from '@/components/theme-provider'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  document.title = 'xezar'
  vi.stubGlobal('fetch', fetchMock)
  // jsdom ships no matchMedia; the shell's breakpoint effect and the theme toggle need one.
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  )
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

const HEALTH: HealthResponse = {
  version: '0.1.3',
  channel: 'release',
  projects: [],
  bootProject: 'default',
  repoRoot: '/home/me/Projects/xezar',
  repo: { root: '/home/me/Projects/xezar', branch: 'feat/cockpit', remote: 'origin' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false, automations: false },
}

/** One registered project — the degenerate workspace every existing install upgrades into. */
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

const TODOS = [
  { id: 't1', summary: 'Review the PR' },
  { id: 't2', summary: 'Rebase the branch' },
]

const PROVIDERS: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'disconnected', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
  ],
}

/** Answer each endpoint the shell reads; anything else 404s loudly rather than silently
 *  resolving to `{}` and making a broken wiring look fine. */
function serve(routes: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (input) => {
    const path = String(input)
    const response =
      path === '/api/v1/providers/status'
        ? (routes[path] ?? PROVIDERS)
        : path === '/api/v1/workspace/ui-state'
          ? (routes[path] ?? {})
          : routes[path]
    if (response === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    if (response instanceof Response) return response
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function renderShell(entry = '/', client: QueryClient = createQueryClient()) {
  return {
    client,
    ...render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <AppShellContainer>
            <p>route content</p>
          </AppShellContainer>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
    ),
  }
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    title: 'Raw task prompt',
    titleSummary: 'Implement page titles',
    workflow: 'quick-task',
    task: 'Implement page titles',
    status: 'running',
    createdAt: '2026-07-21T12:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...overrides,
  }
}

const repoChip = () => document.querySelector('[data-slot="repo-chip"]')
const versionChip = () => document.querySelector('[data-slot="version-chip"]')
const navBadge = () => document.querySelector('[data-slot="nav-badge"]')

describe('repoChipOf', () => {
  it.each([
    { name: 'a plain root', root: '/home/me/Projects/xezar', expected: 'xezar' },
    { name: 'a trailing slash', root: '/home/me/xezar/', expected: 'xezar' },
    { name: 'a windows path', root: 'C:\\Users\\me\\xezar', expected: 'xezar' },
    { name: 'the filesystem root as a repo', root: '/', expected: null },
  ])('takes the basename of $name', ({ root, expected }) => {
    const chip = repoChipOf({ ...HEALTH, repo: { root, branch: 'main' } })
    expect(chip?.name ?? null).toBe(expected)
  })

  it('is null while health is unknown, and outside a git repo', () => {
    expect(repoChipOf(undefined)).toBeNull()
    expect(repoChipOf({ ...HEALTH, repo: null })).toBeNull()
  })
})

const UPDATE: SkillsUpdateState = {
  status: 'available', available: true, autoUpdateEnabled: true, inherited: true,
  checkedAt: '2026-07-22T00:00:00.000Z', updatedAt: null, scopes: [], needsUpgradeNotes: false,
  catalog: [],
}

describe('skillsUpdateMarkerOf', () => {
  it.each([
    ['loading', undefined, false],
    ['available', UPDATE, true],
    ['proven available with an error', { ...UPDATE, status: 'error' as const }, true],
    ['current', { ...UPDATE, status: 'current' as const, available: false }, false],
    ['unavailable', { ...UPDATE, status: 'unavailable' as const, available: false }, false],
    ['updating', { ...UPDATE, status: 'updating' as const }, false],
  ])('%s → %s', (_name, state, expected) => {
    expect(skillsUpdateMarkerOf(state)).toBe(expected)
  })
})

describe('sidebar wiring', () => {
  it('renders the repo and version chips from /api/v1/health', async () => {
    serve({ '/api/v1/health': HEALTH, '/api/v1/todos': [] })
    renderShell()

    await waitFor(() => expect(repoChip()).not.toBeNull())
    // Basename of the root, then the branch — not the whole path.
    expect(repoChip()?.textContent).toBe('xezar / feat/cockpit')
    expect(versionChip()?.textContent).toBe('v0.1.3')
  })

  it('renders the inbox badge from /api/v1/todos', async () => {
    serve({ '/api/v1/health': HEALTH, '/api/v1/todos': TODOS })
    renderShell()

    await waitFor(() => expect(navBadge()).not.toBeNull())
    expect(navBadge()?.textContent).toBe('2')
    expect(screen.getByRole('link', { name: /Inbox/ })).toBeTruthy()
  })

  // #471 — the global inbox is opt-in; the shell must not offer what the server cannot fill.
  it('drops the Inbox nav item and its badge when the server has follow-ups off', async () => {
    serve({
      '/api/v1/health': { ...HEALTH, capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false } },
      '/api/v1/todos': TODOS,
    })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(screen.queryByRole('link', { name: /Inbox/ })).toBeNull()
    expect(navBadge()).toBeNull()
    // Every other view is untouched — the gate owns exactly one item.
    expect(screen.getByRole('link', { name: /Tasks/ })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Settings/ })).toBeTruthy()
  })

  it('never asks for todos on a server with the inbox off', async () => {
    serve({
      '/api/v1/health': { ...HEALTH, capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false } },
      '/api/v1/todos': TODOS,
    })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    // The badge query is keyed on the capability, so it never runs — unlike the /inbox route,
    // nothing here needs the list before health has spoken.
    const asked = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(asked).not.toContain('/api/v1/todos')
  })

  // #801 — the same honesty rule for the opt-in automations capability. Both cases carry a
  // reachable forge, so the ONLY thing deciding the Automations item here is the capability:
  // before the flag, every project with a GitHub remote saw that tab.
  const WITH_FORGE = { ...HEALTH, forge: { kind: 'github' as const, available: true } }

  it('drops the Automations nav item when the server has automations off', async () => {
    serve({ '/api/v1/health': WITH_FORGE, '/api/v1/todos': [] })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(screen.queryByRole('link', { name: /Automations/ })).toBeNull()
    // The gate owns exactly one item — GitHub is forge-gated, not automations-gated.
    expect(screen.getByRole('link', { name: /GitHub/ })).toBeTruthy()
  })

  it('shows the Automations nav item once health reports the capability', async () => {
    serve({
      '/api/v1/health': { ...WITH_FORGE, capabilities: { ...HEALTH.capabilities, automations: true } },
      '/api/v1/todos': [],
    })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(screen.getByRole('link', { name: /Automations/ })).toBeTruthy()
  })

  it('renders no badge for an empty inbox', async () => {
    serve({ '/api/v1/health': HEALTH, '/api/v1/todos': [] })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    // Zero follow-ups is not "0 follow-ups" — a badge reading 0 is noise the spec's chrome
    // rules do not want.
    expect(navBadge()).toBeNull()
  })

  it('shows no chips at all while health has not answered', () => {
    // A never-resolving fetch: the pending state, held.
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}))
    renderShell()

    expect(repoChip()).toBeNull()
    expect(versionChip()).toBeNull()
    expect(navBadge()).toBeNull()
    // …and the app itself is up. The chips being empty is not a loading screen.
    expect(screen.getByText('route content')).toBeTruthy()
    expect(document.querySelector('[data-slot="sidebar"]')).not.toBeNull()
  })

  it('shows no chips when the server is unreachable, and still renders the app', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    renderShell()

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // The honest empty state: xezar cannot answer what repo it is on, so it says nothing.
    // It does not invent one, and it does not take the whole cockpit down with it.
    expect(repoChip()).toBeNull()
    expect(versionChip()).toBeNull()
    expect(screen.getByText('route content')).toBeTruthy()
  })

  // XEZ_SINGLE_PROJECT pins this response to the boot row even when the saved registry has more.
  // The shell must collapse from that ordinary one-row response, not grow a second capability
  // branch for navigation: flat nav, repo chip, no group headers — and no task list (#546).
  it('keeps the sidebar flat when single-project mode pins the registry to the boot project', async () => {
    serve({
      '/api/v1/health': {
        ...HEALTH,
        capabilities: { ...HEALTH.capabilities, singleProject: true },
      },
      '/api/v1/todos': [],
      '/api/v1/projects': { projects: [PROJECT], bootProject: 'xezar', projectsDir: '/home/me/xezar/projects' },
      '/api/v1/runs': [],
    })
    renderShell()

    await waitFor(() => expect(repoChip()).not.toBeNull())
    expect(document.querySelector('[data-slot="project-groups"]')).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    expect(repoChip()?.textContent).toBe('xezar / feat/cockpit')
  })

  it('hides add-project chrome when health reports single-project mode', async () => {
    serve({
      '/api/v1/health': {
        ...HEALTH,
        capabilities: { ...HEALTH.capabilities, singleProject: true },
      },
      '/api/v1/todos': [],
      '/api/v1/projects': { projects: [PROJECT], bootProject: 'xezar', projectsDir: '/home/me/xezar/projects' },
      '/api/v1/runs': [],
    })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
    expect(screen.getByRole('link', { name: /New task/ })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
  })

  // #600 SP-4.2: the gate is the CAPABILITY, not the registry's length. A registry that lists two
  // rows in single-project mode must not bring the project groups or Add project back.
  it('hides the project groups and Add project in single-project mode whatever the registry lists', async () => {
    serve({
      '/api/v1/health': {
        ...HEALTH,
        capabilities: { ...HEALTH.capabilities, singleProjectRoot: true },
      },
      '/api/v1/todos': [],
      '/api/v1/projects': {
        projects: [PROJECT, { ...PROJECT, id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' }],
        bootProject: 'xezar',
        projectsDir: '/home/me/xezar/projects',
      },
      '/api/v1/runs': [],
    })
    const { client } = renderShell()

    await waitFor(() => expect(client.getQueryData(workspaceQueryKeys.projects)).toBeDefined())
    await waitFor(() => expect(document.querySelector('[data-slot="mode-badge"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="project-groups"]')).toBeNull()
    expect(document.querySelectorAll('[data-slot="project-group"]')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    expect(repoChip()?.textContent).toBe('xezar / feat/cockpit')
  })

  it('shows no mode badge while health is unknown or from a server that never sends the key', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/projects': { projects: [PROJECT], bootProject: 'xezar', projectsDir: '/home/me/xezar/projects' },
      '/api/v1/runs': [],
    })
    renderShell()
    expect(document.querySelector('[data-slot="mode-badge"]')).toBeNull()
    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(document.querySelector('[data-slot="mode-badge"]')).toBeNull()
  })

  it('renders one collapsible group per project once the workspace has two', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/projects': {
        projects: [PROJECT, { ...PROJECT, id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' }],
        bootProject: 'xezar',
        projectsDir: '/home/me/xezar/projects',
      },
      '/api/v1/workspace/ui-state': {},
      '/api/v1/p/xezar/runs': [],
    })
    renderShell()

    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="project-group"]')).toHaveLength(2),
    )
    // The flat nav steps aside — each group brings its own.
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull()
    // …and so does the repo chip, which the boot project's own group header now carries.
    expect(repoChip()).toBeNull()
  })

  // #546: the sidebar is navigation only. With real runs in the cache — the data the removed
  // panel used to list — neither shape paints a task row, a bucket heading, the Active/Archived
  // tabs or the Search launcher, and the badges keep their meanings (#399).
  describe('navigation-only sidebar (#546)', () => {
    const RUNS = [
      run({ id: 'waiting', titleSummary: 'Answer the waiting question', status: 'waiting' }),
      run({ id: 'finished', titleSummary: 'Ship the finished change', status: 'done', finishedAt: '2026-07-21T12:30:00.000Z' }),
      run({ id: 'old', titleSummary: 'Old archived work', status: 'done', archived: true }),
    ]
    const sidebarEl = () => document.querySelector('[data-slot="sidebar"]') as HTMLElement

    function expectNoTaskPanel() {
      const sidebar = within(sidebarEl())
      for (const title of ['Answer the waiting question', 'Ship the finished change', 'Old archived work']) {
        expect(sidebar.queryByText(title)).toBeNull()
      }
      expect(sidebar.queryByText(/^(Active|Archived|Needs you|Working|Recent|Pinned)$/)).toBeNull()
      expect(sidebar.queryByRole('tab')).toBeNull()
      expect(sidebar.queryByRole('button', { name: /search/i })).toBeNull()
    }

    it('lists no tasks in the flat single-project sidebar, and keeps the unread badge', async () => {
      serve({ '/api/v1/health': HEALTH, '/api/v1/todos': [], '/api/v1/runs': RUNS })
      renderShell()

      const badge = await waitFor(() => {
        const found = document.querySelector('[data-slot="nav-unread-badge"]')
        expect(found).not.toBeNull()
        return found as HTMLElement
      })
      expect(badge.getAttribute('title')).toBe('1 unread finished task')
      expectNoTaskPanel()
      expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    })

    it('lists no tasks inside project groups, and keeps the waiting/review attention badge', async () => {
      serve({
        '/api/v1/health': HEALTH,
        '/api/v1/todos': [],
        '/api/v1/projects': {
          projects: [PROJECT, { ...PROJECT, id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' }],
          bootProject: 'xezar',
          projectsDir: '/home/me/xezar/projects',
        },
        '/api/v1/runs': RUNS,
        '/api/v1/p/xezar/runs': RUNS,
      })
      renderShell('/p/xezar/')

      const attention = await waitFor(() => {
        const found = document.querySelector('[data-project="xezar"] [data-slot="project-attention"]')
        expect(found).not.toBeNull()
        return found as HTMLElement
      })
      expect(attention.getAttribute('title')).toBe('xezar: 1 task needs you')
      expectNoTaskPanel()
      expect(screen.getByRole('navigation', { name: 'xezar navigation' })).toBeTruthy()
    })

    it('still opens the globally mounted palette from the keyboard', async () => {
      // cmdk measures its list with a ResizeObserver and scrolls the selection into view; jsdom
      // has neither, and neither is what this test is about.
      vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
      Element.prototype.scrollIntoView = vi.fn()
      serve({ '/api/v1/health': HEALTH, '/api/v1/todos': [], '/api/v1/runs': [] })
      renderShell()

      await waitFor(() => expect(versionChip()).not.toBeNull())
      fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
      expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeTruthy()
    })
  })

  it('shows the version chip even outside a git repo', async () => {
    serve({ '/api/v1/health': { ...HEALTH, repo: null }, '/api/v1/todos': [] })
    renderShell()

    // Running xezar outside a repo is supported: no repo chip, but the rest of the chrome is
    // real and must not vanish with it.
    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(versionChip()?.textContent).toBe('v0.1.3')
    expect(repoChip()).toBeNull()
  })

  it('wires the provider query into the AppShell banner slot', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/providers/status': {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'not-installed', enabled: true },
          { provider: 'opencode', status: 'disconnected', enabled: true },
        ],
      },
    })
    renderShell('/p/xezar/')

    const banner = await within(document.querySelector('[data-slot="banner-slot"]') as HTMLElement).findByRole('status')
    expect(banner.textContent).toContain('No agent provider credentials were found.')
    expect(document.querySelector('[data-slot="banner-slot"]')?.contains(banner)).toBe(true)
  })

  it('shows a runtime authentication incident in the global banner slot', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/providers/status': {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'disconnected', enabled: true, authFailureId: 'open-1' },
        ],
      },
    })
    renderShell('/p/xezar/')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(
      'Provider authentication failed during a task: OpenCode.',
    )
    expect(document.querySelector('[data-slot="banner-slot"]')?.contains(alert)).toBe(true)
  })

  it('keeps the shell and route content when provider status fails', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/providers/status': new Response(JSON.stringify({ error: 'unavailable' }), { status: 500 }),
    })
    const client = createQueryClient()
    client.setDefaultOptions({
      queries: { ...client.getDefaultOptions().queries, retry: false },
    })
    renderShell('/', client)

    await waitFor(() =>
      expect(client.getQueryState(workspaceQueryKeys.providerStatus)?.status).toBe('error'),
    )
    expect(screen.getByText('route content')).toBeTruthy()
    expect(document.querySelector('[data-slot="app-shell"]')).not.toBeNull()
    expect(within(document.querySelector('[data-slot="banner-slot"]') as HTMLElement).queryByRole('status')).toBeNull()
  })

  it('keeps the shell and route content when a successful provider response is malformed', async () => {
    const secret = 'unexpected-provider-payload'
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/providers/status': { providers: [null, { provider: 'future', status: secret }] },
    })
    const client = createQueryClient()
    client.setDefaultOptions({
      queries: { ...client.getDefaultOptions().queries, retry: false },
    })
    renderShell('/', client)

    await waitFor(() =>
      expect(client.getQueryState(workspaceQueryKeys.providerStatus)?.status).toBe('error'),
    )
    expect(screen.getByText('route content')).toBeTruthy()
    expect(document.querySelector('[data-slot="app-shell"]')).not.toBeNull()
    expect(within(document.querySelector('[data-slot="banner-slot"]') as HTMLElement).queryByRole('status')).toBeNull()
    expect(screen.queryByText(secret)).toBeNull()
  })
})

/**
 * `--instance project` (#467, PR 4): the other registered projects are LINKS to their own
 * cockpits, and the default `workspace` sidebar does not move.
 *
 * Three named breaks live here. `BREAK-467-PROJECTSLOCKED-WIDENED` — folding the mode into
 * `projectsLocked` — takes out the Add project control and the other rows. `BREAK-467-LINKS-OPEN-
 * IN-PLACE` — pointing a row at `/p/<id>/` on this origin — takes out the absolute-address
 * assertion. `BREAK-467-DEFAULT-SIDEBAR-MOVED` — any edit to the workspace-mode markup — takes out
 * the two snapshots below, which is exactly what they are for: they fail when one class moves.
 */
describe('instance mode: links out to the other cockpits (#467, PR 4)', () => {
  const OTHERS = [
    PROJECT,
    { ...PROJECT, id: 'shop', name: 'shop', root: '/home/me/Projects/shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' },
    { ...PROJECT, id: 'blog', name: 'blog', root: '/home/me/Projects/blog', lastOpenedAt: '2026-07-18T00:00:00.000Z' },
  ]
  const registry = (projects: unknown[]) => ({
    projects,
    bootProject: 'xezar',
    projectsDir: '/home/me/xezar/projects',
  })
  /** Health in `project` mode. `instanceMode` is sent ONLY for `project` — see the contract. */
  const PROJECT_MODE = {
    ...HEALTH,
    bootProject: 'xezar',
    capabilities: { ...HEALTH.capabilities, instanceMode: 'project' as const },
  }
  const sidebar = () => document.querySelector('[data-slot="sidebar"]') as HTMLElement
  const otherRow = (id: string) =>
    document.querySelector(`[data-slot="sidebar"] [data-slot="other-project"][data-project-id="${id}"]`)

  function instanced(id: string, instance: unknown) {
    return OTHERS.map((project) => (project.id === id ? { ...project, instance } : project))
  }

  // AC-4.2. Both workspace-mode shapes, rendered from the same fixtures as before this PR: the
  // flat single-project sidebar and the grouped multi-project one. A snapshot rather than a set
  // of assertions because the claim is about the WHOLE markup, and an assertion list only pins
  // what someone thought to name.
  it('leaves the default workspace sidebar byte-for-byte unchanged — flat', async () => {
    serve({ '/api/v1/health': HEALTH, '/api/v1/todos': [], '/api/v1/runs': [] })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(document.querySelector('[data-slot="other-projects"]')).toBeNull()
    expect(sidebar().outerHTML).toMatchSnapshot()
  })

  it('leaves the default workspace sidebar byte-for-byte unchanged — project groups', async () => {
    serve({
      '/api/v1/health': { ...HEALTH, bootProject: 'xezar' },
      '/api/v1/todos': [],
      '/api/v1/projects': registry(OTHERS),
      '/api/v1/runs': [],
      '/api/v1/p/shop/runs': [],
      '/api/v1/p/blog/runs': [],
    })
    renderShell('/p/xezar/')

    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="project-group"]')).toHaveLength(3),
    )
    expect(document.querySelector('[data-slot="other-projects"]')).toBeNull()
    expect(sidebar().outerHTML).toMatchSnapshot()
  })

  // AC-4.1, and the `projectsLocked`-widened break: everything stays listed and manageable.
  it('keeps every registered project visible, and keeps Add project', async () => {
    serve({
      '/api/v1/health': PROJECT_MODE,
      '/api/v1/todos': [],
      '/api/v1/projects': registry(
        instanced('shop', { state: 'running', url: 'http://localhost:4401/p/shop/' }),
      ),
      '/api/v1/runs': [],
    })
    renderShell()

    await waitFor(() => expect(otherRow('shop')).not.toBeNull())
    expect(otherRow('blog')).not.toBeNull()
    // The boot project is the flat nav above the group, not a row inside it.
    expect(otherRow('xezar')).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    // Not `XEZ_SINGLE_PROJECT`: project management is untouched.
    expect(screen.getByRole('button', { name: 'Add project' })).toBeTruthy()
    // And no group whose every scoped route this process answers 409 for.
    expect(document.querySelectorAll('[data-slot="project-group"]')).toHaveLength(0)
  })

  // The `links-open-in-place` break.
  it('links a running project to its OWN cockpit, never to /p/<id>/ on this origin', async () => {
    serve({
      '/api/v1/health': PROJECT_MODE,
      '/api/v1/todos': [],
      '/api/v1/projects': registry(
        instanced('shop', { state: 'running', url: 'http://localhost:4401/p/shop/' }),
      ),
      '/api/v1/runs': [],
    })
    renderShell()

    const link = await waitFor(() => {
      // `?? null`, because `undefined` (no row yet) passes `not.toBeNull()` and would resolve
      // this wait on the first tick with nothing to assert against.
      const found = otherRow('shop')?.querySelector('a') ?? null
      expect(found).not.toBeNull()
      return found as HTMLAnchorElement
    })
    expect(link.getAttribute('href')).toBe('http://localhost:4401/p/shop/')
    expect(link.getAttribute('href')).not.toBe('/p/shop/')
  })

  // AC-4.3.
  it('offers Copy command for a stopped project, and nothing in hosted mode', async () => {
    serve({
      '/api/v1/health': PROJECT_MODE,
      '/api/v1/todos': [],
      '/api/v1/projects': registry(instanced('shop', { state: 'stopped' })),
      '/api/v1/runs': [],
    })
    renderShell()

    await waitFor(() => expect(otherRow('shop')).not.toBeNull())
    expect(otherRow('shop')?.querySelector('[data-action="other-project-copy-command"]')).not.toBeNull()

    cleanup()
    serve({
      '/api/v1/health': {
        ...PROJECT_MODE,
        capabilities: { ...PROJECT_MODE.capabilities, localHandoff: false },
      },
      '/api/v1/todos': [],
      // Hosted mode sends no `instance` at all: it never probes another port.
      '/api/v1/projects': registry(OTHERS),
      '/api/v1/runs': [],
    })
    renderShell()

    await waitFor(() => expect(otherRow('shop')).not.toBeNull())
    expect(otherRow('shop')?.querySelector('[data-action="other-project-copy-command"]')).toBeNull()
    expect(otherRow('shop')?.querySelector('[data-slot="other-project-state"]')).toBeNull()
  })
})

describe('document title wiring', () => {
  const REGISTRY = {
    projects: [PROJECT],
    bootProject: 'xezar',
    projectsDir: '/home/me/xezar/projects',
  }
  const HEALTH_WITH_BOOT = { ...HEALTH, bootProject: 'xezar' }

  it('combines the selected project with scoped page context', async () => {
    serve({
      '/api/v1/health': HEALTH_WITH_BOOT,
      '/api/v1/todos': [],
      '/api/v1/projects': {
        ...REGISTRY,
        projects: [{ ...PROJECT, id: 'shop', name: 'Storefront' }],
      },
      '/api/v1/runs': [],
    })
    renderShell('/p/shop/git')

    await waitFor(() => expect(document.title).toBe('Storefront — Git · xezar'))
  })

  it('falls back to the boot repository name when the registry is unavailable', async () => {
    serve({ '/api/v1/health': HEALTH_WITH_BOOT, '/api/v1/todos': [], '/api/v1/runs': [] })
    renderShell('/p/xezar/')

    await waitFor(() => expect(document.title).toBe('xezar — Tasks · xezar'))
  })

  it('keeps global settings and a no-repo task route free of invented project context', async () => {
    serve({
      '/api/v1/health': { ...HEALTH_WITH_BOOT, repo: null },
      '/api/v1/todos': [],
      '/api/v1/projects': REGISTRY,
      '/api/v1/runs': [],
    })
    const global = renderShell('/settings/global/projects')

    await waitFor(() => expect(document.title).toBe('Settings · xezar'))
    global.unmount()

    renderShell('/tasks/missing')
    await waitFor(() => expect(document.title).toBe('xezar'))
  })

  it('updates after in-app navigation without remounting the shell', async () => {
    serve({
      '/api/v1/health': HEALTH_WITH_BOOT,
      '/api/v1/todos': [],
      '/api/v1/projects': REGISTRY,
      '/api/v1/runs': [],
    })
    renderShell('/p/xezar/')

    await waitFor(() => expect(document.title).toBe('xezar — Tasks · xezar'))
    fireEvent.click(screen.getByRole('link', { name: 'Git' }))
    await waitFor(() => expect(document.title).toBe('xezar — Git · xezar'))
  })

  it('reacts to live project and task title cache updates', async () => {
    const initialRun = run()
    serve({
      '/api/v1/health': HEALTH_WITH_BOOT,
      '/api/v1/todos': [],
      '/api/v1/projects': {
        ...REGISTRY,
        projects: [{ ...PROJECT, id: 'shop', name: 'Storefront' }],
      },
      '/api/v1/runs': [],
      '/api/v1/p/shop/runs': [initialRun],
    })
    const { client } = renderShell('/p/shop/tasks/run-1')

    await waitFor(() =>
      expect(document.title).toBe('Storefront — Implement page titles · xezar'),
    )

    act(() => {
      client.setQueryData(workspaceQueryKeys.projects, {
        ...REGISTRY,
        projects: [{ ...PROJECT, id: 'shop', name: 'Renamed storefront' }],
      })
      client.setQueryData(['shop', 'runs', 'list'], [
        { ...initialRun, titleSummary: 'Rename browser titles' },
      ])
    })

    await waitFor(() =>
      expect(document.title).toBe('Renamed storefront — Rename browser titles · xezar'),
    )
  })
})
