import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { AppearanceProvider } from '@/components/appearance-provider'
import { ThemeProvider } from '@/components/theme-provider'
import { AppRoutes } from '@/routes'
import { SETTINGS_SECTIONS, visibleSettingsSections } from './registry'

/**
 * The Settings shell + Appearance section (R6 Step 1.3): registry rendering, hidden gating,
 * the project/global scope split (step 3.5), the appearance round-trip against a stubbed
 * ui-state API, and boot application of persisted values. The URL map itself (including
 * hidden sections 404ing) lives in routes.test.tsx.
 *
 * The scope split is what most of this file now pins, and it is pinned where it is observable:
 * WHICH STORE a section writes. Appearance and Notifications must reach
 * `/api/v1/workspace/ui-state` (global), Agents must reach `/api/v1/config` (project) — the stub
 * below answers both and records every request, so a section writing the wrong one shows up as
 * a wrong URL rather than as a passing test.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

/** Both ui-state stores plus the project config answer; everything else the routes fetch stays
 *  honestly pending. Both stores are served on purpose — a section writing to the wrong one
 *  would otherwise hang instead of failing loudly. */
function serve(
  uiState: Record<string, unknown> = {},
  { rejectWorkspacePut = false, holdWorkspacePut }: { rejectWorkspacePut?: boolean; holdWorkspacePut?: Promise<void> } = {},
) {
  requests = []
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  const projectUiState: Record<string, unknown> = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/workspace/ui-state' && method === 'GET') return json(uiState)
      if (url === '/api/v1/workspace/ui-state' && method === 'PUT' && holdWorkspacePut) await holdWorkspacePut
      if (url === '/api/v1/workspace/ui-state' && method === 'PUT' && rejectWorkspacePut)
        return new Response(JSON.stringify({ error: 'invalid appearance.density' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      if (url === '/api/v1/workspace/ui-state' && method === 'PUT')
        return json({ ...uiState, ...(body as Record<string, unknown>) })
      if (url === '/api/v1/ui-state' && method === 'GET') return json(projectUiState)
      if (url === '/api/v1/ui-state' && method === 'PUT')
        return json({ ...projectUiState, ...(body as Record<string, unknown>) })
      if (url === '/api/v1/config') return json(AGENTS_CONFIG)
      if (url === '/api/v1/providers/status')
        return json({
          providers: [
            { provider: 'claude', status: 'connected', enabled: true },
            { provider: 'codex', status: 'connected', enabled: true },
            { provider: 'opencode', status: 'connected', enabled: true },
          ],
        })
      if (url === '/api/v1/models?runner=codex') return json({ runner: 'codex', models: [], source: 'unavailable', stale: false })
      return new Promise<never>(() => {})
    }),
  )
}

/** Enough of `GET /api/v1/config` for the Agents section to render its form. */
const AGENTS_CONFIG = {
  baseBranch: null,
  defaultRunner: 'claude',
  systemPrompt: null,
  defaultModels: {},
  maxParallel: 2,
  memoryLimitMb: null,
  worktreeRetention: 10,
  liveTitleUpdates: null,
  reviewGate: null,
}

/** Seeds the step-3.2 route gates — boot id (legacy redirect) + registry (known-check) — so a
 *  flat entry URL lands scoped immediately. The boot project mounts UNSCOPED, so the exact
 *  `/api/v1/*` paths this file's fetch stub matches stay byte-identical. */
function gateSeededClient(singleProject = false, singleProjectRoot = false) {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, {
    bootProject: 'boot',
    capabilities: {
      localHandoff: true,
      followups: true,
      singleProject,
      // Only sent when true, exactly as the server does (#600).
      ...(singleProjectRoot ? { singleProjectRoot: true } : {}),
    },
  })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/xezar/projects',
  })
  return client
}

function renderAt(
  entry: string,
  { singleProject = false, singleProjectRoot = false }: { singleProject?: boolean; singleProjectRoot?: boolean } = {},
) {
  render(
    <QueryClientProvider client={gateSeededClient(singleProject, singleProjectRoot)}>
      <ThemeProvider>
        <AppearanceProvider>
          <MemoryRouter initialEntries={[entry]}>
            <AppRoutes />
          </MemoryRouter>
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => serve())

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  delete document.documentElement.dataset.accent
  delete document.documentElement.dataset.density
  delete document.documentElement.dataset.width
  document.documentElement.classList.remove('light')
})

const PROJECT_SECTIONS = ['agents', 'agent-config', 'project-setup', 'worktrees', 'bookmarklets', 'prompt-templates', 'mcp-connection', 'mcp-api']
const GLOBAL_SECTIONS = [
  'appearance',
  'notifications',
  'resources',
  'skills',
  // Agent accounts (spec 2026-07-29-agent-profiles) sit beside Projects: both describe the
  // machine and the person at it, not any one repo.
  'accounts',
  'projects',
]

describe('the section registry', () => {
  it('declares the spec §Settings sections, later ones hidden', () => {
    const byId = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s]))
    for (const id of [...PROJECT_SECTIONS, ...GLOBAL_SECTIONS]) {
      expect(byId.get(id as never)?.hidden).toBeUndefined()
    }
    // Listed in the registry but hidden until implemented (later phase).
    for (const id of ['keyboard']) {
      expect(byId.get(id as never)?.hidden).toBe(true)
    }
  })

  it('splits the sections by scope (step 3.5) — each id belongs to exactly one area', () => {
    expect(visibleSettingsSections('project').map((s) => s.id)).toEqual(PROJECT_SECTIONS)
    expect(visibleSettingsSections('global').map((s) => s.id)).toEqual(GLOBAL_SECTIONS)
    // No id may appear in both areas — the two navs would then link to two different pages
    // under the same name, and the `settings/<id>` legacy redirect would be ambiguous.
    expect(PROJECT_SECTIONS.filter((id) => GLOBAL_SECTIONS.includes(id))).toEqual([])
  })

  it('hides Projects only when the single-project capability is active', () => {
    // Accounts survives: a single-project cockpit still runs on ONE of possibly several logins,
    // so "which account" is orthogonal to "how many projects".
    expect(visibleSettingsSections('global', { singleProject: true }).map((s) => s.id)).toEqual([
      'appearance', 'notifications', 'resources', 'skills', 'accounts',
    ])
    expect(visibleSettingsSections('global', { singleProject: false }).map((s) => s.id)).toEqual(GLOBAL_SECTIONS)
    expect(visibleSettingsSections('global').map((s) => s.id)).toEqual(GLOBAL_SECTIONS)
  })

  it('hides Projects in single-project mode too — the registry doors refuse there (#600)', () => {
    expect(visibleSettingsSections('global', { singleProjectRoot: true }).map((s) => s.id)).toEqual([
      'appearance', 'notifications', 'resources', 'skills', 'accounts',
    ])
    // The project area is unchanged by either narrowing.
    expect(visibleSettingsSections('project', { singleProjectRoot: true }).map((s) => s.id)).toEqual(PROJECT_SECTIONS)
  })
})

// #600 SP-4.3 (FR-9.3): in single-project mode each Settings section names the file its saves land
// in — the names `packages/xezar/src/state-layout.ts` resolves for the project layout. A section
// that writes no xezar file (a read-only reference, an action, the agents' own files) names none.
describe('single-project mode names the file each section writes (#600)', () => {
  const EXPECTED_FILE: Record<string, string | null> = {
    // project scope
    agents: '.xezar/config.json',
    'agent-config': null,
    'project-setup': null,
    worktrees: '.xezar/config.json',
    bookmarklets: null,
    'prompt-templates': '.local/xezar/ui-state.json',
    'mcp-connection': null,
    'mcp-api': null,
    // global scope
    appearance: '.xezar/workspace-ui.json',
    notifications: '.xezar/workspace-ui.json',
    resources: '.xezar/workspace.json',
    skills: '.xezar/workspace.json',
    accounts: '.xezar/agent-accounts.json',
  }
  const note = () => document.querySelector('[data-slot="settings-file-note"]')

  it('covers every section the mode shows, and no other', () => {
    const shown = [
      ...visibleSettingsSections('project', { singleProjectRoot: true }),
      ...visibleSettingsSections('global', { singleProjectRoot: true }),
    ].map((section) => section.id)
    expect(shown.toSorted()).toEqual(Object.keys(EXPECTED_FILE).toSorted())
  })

  for (const [id, file] of Object.entries(EXPECTED_FILE)) {
    const scope = PROJECT_SECTIONS.includes(id) ? 'project' : 'global'
    const url = scope === 'project' ? `/settings/${id}` : `/settings/global/${id}`
    it(`${id} names ${file ?? 'no file'}`, () => {
      if (file === null) {
        // Pinned on the registry entry: the shell renders a note only from `fileNote`.
        expect(SETTINGS_SECTIONS.find((section) => section.id === id)?.fileNote).toBeUndefined()
        return
      }
      renderAt(url, { singleProjectRoot: true })
      expect(note()?.querySelector('code')?.textContent).toBe(file)
    })
  }

  it('says the committed files travel and the runtime file does not', () => {
    renderAt('/settings/global/resources', { singleProjectRoot: true })
    expect(note()?.textContent).toBe(
      'Saved in this project — .xezar/workspace.json. It is committed, so a clone starts with these limits.',
    )
    cleanup()
    renderAt('/settings/prompt-templates', { singleProjectRoot: true })
    expect(note()?.textContent).toBe(
      'Saved in this project — .local/xezar/ui-state.json. It is not committed, so these templates stay on this machine.',
    )
  })

  it('renders no file note in global mode, nor under the XEZ_SINGLE_PROJECT narrowing', () => {
    renderAt('/settings/global/resources')
    expect(note()).toBeNull()
    cleanup()
    renderAt('/settings/agents', { singleProject: true })
    expect(note()).toBeNull()
  })

  it('renames the global scope chip and index to "Workspace settings" in the mode only', () => {
    const chip = () => document.querySelector('[data-slot="settings-scope-chip"]')
    renderAt('/settings/global/resources', { singleProjectRoot: true })
    expect(chip()?.textContent).toBe('Workspace settings')
    cleanup()
    renderAt('/settings/global/resources')
    expect(chip()?.textContent).toBe('Global settings')
    cleanup()
    renderAt('/settings/global', { singleProjectRoot: true })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Workspace settings')
    expect(document.querySelector('[data-slot="settings-index"] [data-section="projects"]')).toBeNull()
    cleanup()
    // The project index's cross-link names the same area, and no registry the mode does not have.
    renderAt('/settings', { singleProjectRoot: true })
    const link = document.querySelector('[data-slot="settings-global-link"]')
    expect(link?.textContent).toBe('Workspace settings')
    expect(link?.parentElement?.textContent).not.toContain('project registry')
    cleanup()
    renderAt('/settings')
    expect(document.querySelector('[data-slot="settings-global-link"]')?.textContent).toBe('Global settings')
  })
})

describe('the settings shell', () => {
  it('renders the PROJECT nav from the registry — project sections only', () => {
    renderAt('/settings/agents')
    const nav = document.querySelector('[data-slot="settings-nav"]')!
    const ids = [...nav.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section'))
    expect(ids).toEqual(PROJECT_SECTIONS)
    // The active section is marked for assistive tech, not just by color.
    expect(nav.querySelector('[aria-current="page"]')?.getAttribute('data-section')).toBe('agents')
    // The mobile pill row renders through the same registry — the two can never disagree.
    const pills = document.querySelector('[data-slot="settings-nav-mobile"]')!
    expect([...pills.querySelectorAll('[data-section]')].length).toBe(PROJECT_SECTIONS.length)
  })

  it('every section keeps a way BACK to the index: the "General" nav entry', () => {
    renderAt('/settings/worktrees')
    // Project scope: scoped like every other project link, and pointing at the area index.
    expect(
      document.querySelector('[data-slot="settings-nav"] [data-slot="settings-nav-index"]')?.getAttribute('href'),
    ).toBe('/p/boot/settings')
    // The mobile pill row carries it too — the index is the ONLY place small screens see it.
    expect(
      document.querySelector('[data-slot="settings-nav-mobile"] [data-slot="settings-nav-index"]')?.getAttribute('href'),
    ).toBe('/p/boot/settings')
    // A section is open, so "General" is not the current page.
    expect(document.querySelector('[data-slot="settings-nav-index"][aria-current="page"]')).toBeNull()
  })

  it('"General" is the current page on the index itself, and unprefixed in the global area', () => {
    renderAt('/settings')
    expect(
      document.querySelector('[data-slot="settings-nav"] [data-slot="settings-nav-index"]')?.getAttribute('aria-current'),
    ).toBe('page')
    cleanup()

    renderAt('/settings/global/resources')
    expect(
      document.querySelector('[data-slot="settings-nav"] [data-slot="settings-nav-index"]')?.getAttribute('href'),
    ).toBe('/settings/global')
  })

  it('renders the GLOBAL nav at /settings/global — global sections, unprefixed links', () => {
    renderAt('/settings/global/appearance')
    const nav = document.querySelector('[data-slot="settings-nav"]')!
    expect(nav.getAttribute('data-scope')).toBe('global')
    const ids = [...nav.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section'))
    expect(ids).toEqual(GLOBAL_SECTIONS)
    // The whole point of the plain (non-scoped) links: no `/p/<id>` prefix may appear, or the
    // target would not be a route at all.
    expect(nav.querySelector('[data-section="resources"]')?.getAttribute('href')).toBe(
      '/settings/global/resources',
    )
    expect(nav.querySelector('[data-section="skills"]')?.getAttribute('href')).toBe(
      '/settings/global/skills',
    )
  })

  it('/settings is the project registry as an index — one card per visible section', () => {
    renderAt('/settings')
    const index = document.querySelector('[data-slot="settings-index"]')!
    const ids = [...index.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section'))
    expect(ids).toEqual(PROJECT_SECTIONS)
    // Scope-aware links (step 3.2): the flat `to` picks up the active project's prefix.
    expect(index.querySelector('[data-section="bookmarklets"]')?.getAttribute('href')).toBe(
      '/p/boot/settings/bookmarklets',
    )
    // …and the cross-link out of the project area is NOT prefixed.
    expect(document.querySelector('[data-slot="settings-global-link"]')?.getAttribute('href')).toBe(
      '/settings/global',
    )
  })

  it('/settings/global is the global registry as an index', () => {
    renderAt('/settings/global')
    const index = document.querySelector('[data-slot="settings-index"]')!
    const ids = [...index.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section'))
    expect(ids).toEqual(GLOBAL_SECTIONS)
    expect(index.querySelector('[data-section="projects"]')?.getAttribute('href')).toBe(
      '/settings/global/projects',
    )
  })

  it('single-project mode removes Projects from the global index and navigation', () => {
    renderAt('/settings/global', { singleProject: true })
    expect(document.querySelector('[data-slot="settings-index"] [data-section="projects"]')).toBeNull()
    expect(document.querySelector('[data-slot="settings-nav"] [data-section="projects"]')).toBeNull()
    expect(document.querySelector('[data-section="resources"]')).not.toBeNull()
  })

  it('a moved section keeps its old URL working: /settings/appearance → the global twin', async () => {
    renderAt('/settings/appearance')
    // Legacy flat URL → boot project → the section's new global home. Two redirects, one hop
    // each, and the address bar ends up naming the real place.
    await waitFor(() => {
      expect(document.querySelector('[data-route="settings-global-appearance"]')).not.toBeNull()
    })
  })

  it('unfinished sections say so through the shared CenteredState template', () => {
    // Hidden sections are not routed (their URLs 404) — render the registry component
    // directly to pin the placeholder contract itself.
    const Keyboard = SETTINGS_SECTIONS.find((s) => s.id === 'keyboard')!.component
    render(<Keyboard />)
    const state = document.querySelector('[data-slot="centered-state"]')
    expect(state?.textContent).toContain('later phase')
  })
})

describe('the appearance section (global scope)', () => {
  it('persisted values apply at boot: server ui-state stamps the root and the controls', async () => {
    serve({ appearance: { accent: 'violet', density: 'compact' } })
    renderAt('/settings/global/appearance')

    await waitFor(() => {
      expect(document.documentElement.dataset.accent).toBe('violet')
    })
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(screen.getByRole('radio', { name: 'Violet' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe('true')
    // The mirror follows the server, so the next cold load pre-paints the truth.
    expect(localStorage.getItem('xez-accent')).toBe('violet')
    expect(localStorage.getItem('xez-density')).toBe('compact')
  })

  it('accent round-trip: apply immediately, PUT the FULL appearance object', async () => {
    serve({ appearance: { density: 'compact' } })
    renderAt('/settings/global/appearance')
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe('true')
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Violet' }))
    expect(document.documentElement.dataset.accent).toBe('violet')

    // The whole object, not a partial — the server's ui-state merge is shallow, so a bare
    // `{ accent }` would silently drop the stored density.
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')?.body).toEqual({
        appearance: { accent: 'violet', density: 'compact', width: 'narrow' },
      })
    })
    expect(localStorage.getItem('xez-accent')).toBe('violet')
  })

  it('density flips back to the default and the attribute comes OFF the root', async () => {
    serve({ appearance: { density: 'compact' } })
    renderAt('/settings/global/appearance')
    await waitFor(() => {
      expect(document.documentElement.dataset.density).toBe('compact')
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Comfortable' }))
    expect(document.documentElement.hasAttribute('data-density')).toBe(false)
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')?.body).toEqual({
        appearance: { accent: 'lime', density: 'comfortable', width: 'narrow' },
      })
    })
  })

  it('Roomy is offered first, stamps the root, mirrors, and PUTs the full object (#424 step 4)', async () => {
    serve({ appearance: { accent: 'violet' } })
    renderAt('/settings/global/appearance')
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Violet' }).getAttribute('aria-checked')).toBe('true')
    })

    const density = document.querySelector('[data-slot="appearance-density"]')!
    expect([...density.querySelectorAll('[role="radio"]')].map((r) => r.textContent)).toEqual([
      'Roomy',
      'Comfortable',
      'Compact',
      'Compact for real',
    ])
    expect(
      screen.getByText('Roomy adds space between things and the Compact options take it away — text stays the same size.'),
    ).not.toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: 'Roomy' }))
    expect(document.documentElement.dataset.density).toBe('roomy')
    expect(localStorage.getItem('xez-density')).toBe('roomy')
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')?.body).toEqual({
        appearance: { accent: 'violet', density: 'roomy', width: 'narrow' },
      })
    })
    expect(screen.getByRole('radio', { name: 'Roomy' }).getAttribute('aria-checked')).toBe('true')
  })

  // An older server refuses `roomy` with a 400. The server's GET answer has not changed, so a
  // refetch hands back a structurally shared, identical `data` reference and the provider's
  // "server wins" effect never re-runs: the control, the root attribute and the pre-paint mirror
  // must revert because the save handler restores them, not because a refetch happens to.
  it('a refused save reverts the control, the root attribute and the mirror', async () => {
    serve({ appearance: { density: 'compact' } }, { rejectWorkspacePut: true })
    renderAt('/settings/global/appearance')
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe('true')
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Roomy' }))
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')).toBe(true)
    })
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe('true')
    })
    expect(screen.getByRole('radio', { name: 'Roomy' }).getAttribute('aria-checked')).toBe('false')
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(localStorage.getItem('xez-density')).toBe('compact')
  })

  it('two queued refused saves end on the server value, not on the first unsaved click', async () => {
    // Roomy then Violet, both in flight before either answers, both refused. The second save's
    // click-time value is the unsaved Roomy, so reverting to it would keep painting a density the
    // server never stored — the only correct end state is the server's own appearance.
    let release!: () => void
    serve(
      { appearance: { density: 'compact' } },
      { rejectWorkspacePut: true, holdWorkspacePut: new Promise<void>((done) => (release = done)) },
    )
    renderAt('/settings/global/appearance')
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe('true')
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Roomy' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Violet' }))
    await waitFor(() => {
      expect(requests.filter((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')).toHaveLength(2)
    })
    release()

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe('true')
    })
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Lime' }).getAttribute('aria-checked')).toBe('true')
    })
    expect(screen.getByRole('radio', { name: 'Roomy' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('radio', { name: 'Violet' }).getAttribute('aria-checked')).toBe('false')
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(document.documentElement.hasAttribute('data-accent')).toBe(false)
    expect(localStorage.getItem('xez-density')).toBe('compact')
    expect(localStorage.getItem('xez-accent')).toBe('lime')
  })

  it('reading width round-trip: Wide stamps the root and PUTs the full object; back to Narrow clears it', async () => {
    serve({ appearance: { accent: 'violet' } })
    renderAt('/settings/global/appearance')
    // Wait for the server value to settle (Violet is server-provided; Narrow is the default and
    // would report "checked" from the mirror before the GET even lands), so the pending load
    // can't clobber the width write we're about to make.
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Violet' }).getAttribute('aria-checked')).toBe('true')
    })
    expect(screen.getByRole('radio', { name: 'Narrow' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: 'Wide' }))
    expect(document.documentElement.dataset.width).toBe('wide')
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')?.body).toEqual({
        appearance: { accent: 'violet', density: 'comfortable', width: 'wide' },
      })
    })

    // Narrow is the default — the attribute must come OFF the root, not be written as data-width="narrow".
    fireEvent.click(screen.getByRole('radio', { name: 'Narrow' }))
    await waitFor(() => {
      expect(document.documentElement.hasAttribute('data-width')).toBe(false)
    })
  })

  it('theme rides the existing theme system: class + localStorage, no ui-state write', async () => {
    renderAt('/settings/global/appearance')

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(localStorage.getItem('xez-theme')).toBe('light')
    expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement.classList.contains('light')).toBe(false)
    expect(localStorage.getItem('xez-theme')).toBe('dark')

    // Theme is per-browser by design (pre-paint) — it must never leak into ui-state.json.
    await waitFor(() => {
      expect(requests.some((r) => r.url === '/api/v1/workspace/ui-state' && r.method === 'GET')).toBe(true)
    })
    expect(requests.some((r) => r.method === 'PUT' && r.url.endsWith('ui-state'))).toBe(false)
  })
})

/**
 * The step-3.5 acceptance test, stated as bluntly as the spec states it: appearance and
 * notifications write the GLOBAL store, agents writes the PROJECT store. Each assertion checks
 * BOTH halves — the right URL was written AND the other store was left alone — because a
 * section wired to both would satisfy a one-sided check.
 */
describe('the settings split writes the right store', () => {
  const putsTo = (url: string) => requests.filter((r) => r.method === 'PUT' && r.url === url)

  it('appearance → /api/v1/workspace/ui-state, never the per-repo one', async () => {
    renderAt('/settings/global/appearance')
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Violet' })).toBeTruthy())

    fireEvent.click(screen.getByRole('radio', { name: 'Violet' }))

    await waitFor(() => expect(putsTo('/api/v1/workspace/ui-state')).toHaveLength(1))
    expect(putsTo('/api/v1/workspace/ui-state')[0]?.body).toEqual({
      appearance: { accent: 'violet', density: 'comfortable', width: 'narrow' },
    })
    expect(putsTo('/api/v1/ui-state')).toHaveLength(0)
  })

  it('notifications → /api/v1/workspace/ui-state, never the per-repo one', async () => {
    // `Notification` is absent in jsdom; the section only needs it to decide whether to ask for
    // permission, and "already granted" is the path that persists without any prompt.
    function FakeNotification() {}
    ;(FakeNotification as unknown as { permission: string }).permission = 'granted'
    vi.stubGlobal('Notification', FakeNotification)

    renderAt('/settings/global/notifications')
    const toggle = await screen.findByRole('switch', { name: 'Notify when an agent needs you' })
    fireEvent.click(toggle)

    await waitFor(() => expect(putsTo('/api/v1/workspace/ui-state')).toHaveLength(1))
    expect(putsTo('/api/v1/workspace/ui-state')[0]?.body).toEqual({ notifications: { enabled: true } })
    expect(putsTo('/api/v1/ui-state')).toHaveLength(0)
  })

  it('agents → the project-scoped /api/v1/config, never the workspace routes', async () => {
    renderAt('/settings/agents')
    const runner = await waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>('[data-slot="agents-runner"] [data-value="codex"]')
      expect(el).not.toBeNull()
      return el!
    })

    fireEvent.click(runner)

    await waitFor(() => expect(putsTo('/api/v1/config')).toHaveLength(1))
    expect(putsTo('/api/v1/config')[0]?.body).toEqual({ defaultRunner: 'codex' })
    expect(requests.some((r) => r.method === 'PUT' && r.url.startsWith('/api/v1/workspace/'))).toBe(false)
  })
})
