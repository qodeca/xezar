import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectListEntry } from '@qodeca/xezar-api-client'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { ListViewProvider } from '@/components/list-view'
import { AppRoutes } from '@/routes'

/**
 * Project settings → General (project-general.tsx): the dashboard the settings index became.
 *
 * What it must answer about the project you are inside — where it is, what state its folder is
 * in, how many of its tasks may run at once — and the action that used to exist only as a row in
 * the GLOBAL registry table: Remove. The removal path is the one worth pinning hardest, because
 * it deregisters the project whose URL the page is rendered at.
 */

const ROOT = '/Users/me/code/demo-project'
const BOOT_ROOT = '/Users/me/code/xezar'

let requests: Array<{ method: string; url: string; body?: unknown }> = []
/** What `GET /config` answers for the project; `PUT /config` merges `memoryLimitMb` into it the way
 *  the route does (null or 0 clears). Only the field under test varies. */
let projectConfig: Record<string, unknown> = {}

function configAnswer(memoryLimitMb: number | null) {
  return {
    baseBranch: null,
    defaultRunner: 'claude',
    systemPrompt: null,
    defaultModels: {},
    modelsLocked: false,
    maxParallel: 2,
    memoryLimitMb,
    worktreeRetention: 10,
    liveTitleUpdates: null,
    reviewGate: null,
    plannerModel: 'haiku',
    namerModel: 'haiku',
    skillsRepos: [],
  }
}

function serve(memoryLimitMb: number | null = null) {
  requests = []
  projectConfig = configAnswer(memoryLimitMb)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.endsWith('/open-targets')) return json({ targets: [] })
      // Scoped under a project URL, or the unscoped mount single-project mode renders at.
      if (/^\/api\/v1\/(p\/[^/]+\/)?config$/.test(url)) {
        if (method === 'PUT') {
          const next = (body as { memoryLimitMb?: number | null }).memoryLimitMb
          projectConfig = { ...projectConfig, memoryLimitMb: next ? next : null }
        }
        return json(projectConfig)
      }
      if (url.startsWith('/api/v1/projects/') && method === 'DELETE') {
        return json({ removed: true, id: url.split('/').pop() })
      }
      if (url.startsWith('/api/v1/projects/') && method === 'PATCH') {
        return json({ project: { ...project('demo'), maxParallel: 3 } })
      }
      return new Promise<never>(() => {})
    }),
  )
}

function project(id: 'boot' | 'demo') {
  return id === 'boot'
    ? {
        id: 'boot',
        name: 'xezar',
        root: BOOT_ROOT,
        addedAt: '2026-01-05T10:00:00.000Z',
        lastOpenedAt: '2026-07-31T10:00:00.000Z',
        source: 'local' as const,
        status: 'ok' as const,
        branch: 'main',
      }
    : {
        id: 'demo',
        name: 'demo-project',
        root: ROOT,
        addedAt: '2026-07-20T10:00:00.000Z',
        lastOpenedAt: '2026-08-01T10:00:00.000Z',
        source: 'checkout' as const,
        status: 'ok' as const,
        branch: 'feature/x',
      }
}

/** Seeds everything the page reads: the route gates, the registry, and the workspace cap the
 *  concurrency select names in its "Inherit workspace (N)" option.
 *
 *  `singleProject` flips the capability the registry half of the page is gated on, and
 *  `registry` overrides the seeded entries — a folder that has gone missing, or a workspace
 *  holding only the boot project. */
function seededClient({
  singleProject = false,
  singleProjectRoot = false,
  registry,
}: { singleProject?: boolean; singleProjectRoot?: boolean; registry?: ProjectListEntry[] } = {}) {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, {
    bootProject: 'boot',
    capabilities: {
      localHandoff: true,
      followups: true,
      singleProject,
      ...(singleProjectRoot ? { singleProjectRoot: true } : {}),
    },
  })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: registry ?? [project('boot'), project('demo')],
    bootProject: 'boot',
    projectsDir: '~/xezar/projects',
  })
  client.setQueryData(workspaceQueryKeys.config, {
    browseRoot: '~/',
    projectsDir: '~/xezar/projects',
    skillsAutoUpdate: null,
    effectiveSkillsAutoUpdate: true,
    composerDefaults: {
      autonomous: null,
      worktree: null,
      inheritedAutonomous: 'source-dependent',
      inheritedWorktree: true,
    },
    resources: {
      maxParallel: 4,
      maxMonitoringSessions: 2,
      monitoringWakeIntervalMinutes: null,
      memoryLimitMb: 4096,
      worktreeRetentionDefault: 10,
    },
  })
  return client
}

function renderAt(entry: string, seed?: Parameters<typeof seededClient>[0]) {
  render(
    <QueryClientProvider client={seededClient(seed)}>
      {/* The app shell normally provides it; the removal test navigates onto the tasks overview,
          which reads it. */}
      <ListViewProvider>
        <MemoryRouter initialEntries={[entry]}>
          <AppRoutes />
        </MemoryRouter>
      </ListViewProvider>
    </QueryClientProvider>,
  )
}

const general = () => document.querySelector('[data-slot="project-general"]')

beforeEach(() => serve())

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the General page', () => {
  it('reads out the registry entry for the project you are inside', async () => {
    renderAt('/p/demo/settings')
    const facts = await waitFor(() => {
      const el = document.querySelector('[data-slot="project-facts"]')
      expect(el).not.toBeNull()
      return el!
    })
    const text = facts.textContent ?? ''
    expect(text).toContain('demo-project')
    expect(text).toContain('feature/x')
    // Source is stated in the reader's words, not the wire's enum.
    expect(text).toContain('cloned from GitHub')
    expect(facts.querySelector('[data-slot="project-general-status"]')?.textContent).toContain('ok')
    // The folder itself, in full.
    expect(general()?.querySelector('[data-slot="project-location-path"]')?.textContent).toBe(ROOT)
  })

  it('carries the per-project concurrency ceiling, named against the workspace cap', async () => {
    renderAt('/p/demo/settings')
    const select = await screen.findByLabelText('Max parallel tasks for demo-project')
    expect(select.textContent).toContain('Inherit workspace (4)')

    fireEvent.change(select, { target: { value: '3' } })

    await waitFor(() => {
      const patch = requests.find((r) => r.method === 'PATCH')
      expect(patch?.url).toBe('/api/v1/projects/demo')
      expect(patch?.body).toEqual({ maxParallel: 3 })
    })
  })

  it('removes the project after a confirm, then leaves the URL that just stopped resolving', async () => {
    renderAt('/p/demo/settings')
    const remove = await screen.findByRole('button', { name: /^Remove demo-project from the workspace/ })

    fireEvent.click(remove)

    // The confirm insists on what Remove does NOT do, and names the folder it will not delete.
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('nothing on disk is deleted')
    expect(dialog.textContent).toContain(ROOT)

    fireEvent.click(screen.getByRole('button', { name: 'Remove from list' }))

    await waitFor(() => {
      expect(requests.some((r) => r.method === 'DELETE' && r.url === '/api/v1/projects/demo')).toBe(true)
    })
    // Straight to the boot project — staying would render a settings page for a project the
    // registry no longer has.
    await waitFor(() => {
      expect(document.querySelector('[data-route="settings"]')).toBeNull()
    })
  })

  it('refuses to remove the boot project before the click, with the reason', async () => {
    renderAt('/p/boot/settings')
    const remove = await screen.findByRole('button', { name: /^Remove xezar from the workspace/ })
    expect(remove.hasAttribute('disabled')).toBe(true)
    expect(document.querySelector('[data-slot="project-general-remove-boot"]')?.textContent).toContain(
      're-registers itself',
    )
  })

  it('is the project area only — global settings has no project to describe', async () => {
    renderAt('/settings/global')
    await waitFor(() => {
      expect(document.querySelector('[data-slot="settings-index"]')).not.toBeNull()
    })
    expect(general()).toBeNull()
  })

  it('names a folder that is gone, and says what to do about it', async () => {
    renderAt('/p/demo/settings', {
      registry: [project('boot'), { ...project('demo'), status: 'missing' }],
    })
    const status = await waitFor(() => {
      const el = document.querySelector('[data-slot="project-general-status"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(status.textContent).toContain('folder not found')
    // "folder not found" alone does not say what to do about it; the hint points at the Remove
    // field rendered directly below.
    expect(status.textContent).toContain('remove it below')
  })

  it('single-project mode keeps what describes the project and drops what manages the registry', async () => {
    // `XEZ_SINGLE_PROJECT=1` makes PATCH and DELETE `/api/v1/projects/:id` answer 409 (server.ts)
    // and drops the whole global Projects section from the nav registry. Offering the same two
    // controls here would be a knob whose every change is refused; what the project IS stays true.
    renderAt('/settings', { singleProject: true, registry: [project('boot')] })
    await waitFor(() => {
      expect(general()).not.toBeNull()
    })
    expect(document.querySelector('[data-slot="project-facts"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="project-location-path"]')?.textContent).toBe(BOOT_ROOT)
    expect(screen.queryByLabelText('Max parallel tasks for xezar')).toBeNull()
    expect(document.querySelector('[data-action="project-general-remove"]')).toBeNull()
  })

  // #600: single-project mode drops the same two controls — the registry doors refuse there too —
  // and it is the capability that decides, not a registry that happens to list one row.
  it('single-project mode (#600) drops the registry controls even when the registry lists two rows', async () => {
    renderAt('/settings', { singleProjectRoot: true })
    await waitFor(() => {
      expect(general()).not.toBeNull()
    })
    expect(document.querySelector('[data-slot="project-facts"]')).not.toBeNull()
    expect(screen.queryByLabelText('Max parallel tasks for xezar')).toBeNull()
    expect(document.querySelector('[data-action="project-general-remove"]')).toBeNull()
  })

  it('sends a missing folder to the path when there is no Remove button to point at', async () => {
    // The other half of the gate: single-project mode took the Remove field away, so the hint
    // must not send the reader "below" to a control that is not rendered.
    renderAt('/settings', {
      singleProject: true,
      registry: [{ ...project('boot'), status: 'missing' }],
    })
    const status = await waitFor(() => {
      const el = document.querySelector('[data-slot="project-general-status"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(status.textContent).toContain('folder not found')
    expect(status.textContent).toContain('restore the folder at the path above')
    expect(status.textContent).not.toContain('remove it below')
  })

  /** #677 C1 — the project's own per-task memory ceiling, written through `PUT /config`. */
  describe('the per-task memory limit', () => {
    const memoryInput = () => screen.findByLabelText('Per-task memory limit for demo-project in MiB')
    const saveButton = () => document.querySelector<HTMLButtonElement>('[data-action="project-save-memory"]')!
    const puts = () => requests.filter((r) => r.method === 'PUT' && r.url === '/api/v1/p/demo/config')
    const effective = () => document.querySelector('[data-slot="project-memory-effective"]')?.textContent ?? ''

    it('sets a value, then clears it back to the workspace limit, and says which one applies', async () => {
      renderAt('/p/demo/settings')
      const input = (await memoryInput()) as HTMLInputElement
      expect(input.value).toBe('')
      await waitFor(() => expect(effective()).toContain('This project uses the workspace limit (4096 MiB).'))
      // Nothing to save until the draft differs from what is stored.
      expect(saveButton().disabled).toBe(true)

      fireEvent.change(input, { target: { value: '1024' } })
      fireEvent.click(saveButton())
      await waitFor(() => expect(puts()).toHaveLength(1))
      expect(puts()[0]!.body).toEqual({ memoryLimitMb: 1024 })
      await waitFor(() => expect(effective()).toContain('This project’s tasks pause at 1024 MiB.'))
      expect(saveButton().disabled).toBe(true)

      // Emptying the field is the clear: `null`, which the route turns into a deleted key.
      fireEvent.change(input, { target: { value: '' } })
      fireEvent.click(saveButton())
      await waitFor(() => expect(puts()).toHaveLength(2))
      expect(puts()[1]!.body).toEqual({ memoryLimitMb: null })
      await waitFor(() => expect(effective()).toContain('This project uses the workspace limit (4096 MiB).'))
    })

    it('treats 0 as a clear too, and empties the field once it lands', async () => {
      serve(2048)
      renderAt('/p/demo/settings')
      const input = (await memoryInput()) as HTMLInputElement
      await waitFor(() => expect(input.value).toBe('2048'))

      fireEvent.change(input, { target: { value: '0' } })
      fireEvent.click(saveButton())
      await waitFor(() => expect(puts()).toHaveLength(1))
      expect(puts()[0]!.body).toEqual({ memoryLimitMb: null })
      await waitFor(() => expect(input.value).toBe(''))
    })

    it('refuses a draft the schema would reject before any request', async () => {
      renderAt('/p/demo/settings')
      const input = (await memoryInput()) as HTMLInputElement
      for (const value of ['100', '12.5', '2000000']) {
        fireEvent.change(input, { target: { value } })
        expect(saveButton().disabled).toBe(true)
        expect(document.querySelector('[data-slot="project-memory-invalid"]')).not.toBeNull()
      }
      expect(puts()).toHaveLength(0)
    })

    it('names a workspace "no limit" as such, whether it is stored as null or 0', async () => {
      for (const stored of [null, 0]) {
        const client = seededClient()
        const ws = client.getQueryData(workspaceQueryKeys.config) as { resources: Record<string, unknown> }
        client.setQueryData(workspaceQueryKeys.config, { ...ws, resources: { ...ws.resources, memoryLimitMb: stored } })
        render(
          <QueryClientProvider client={client}>
            <ListViewProvider>
              <MemoryRouter initialEntries={['/p/demo/settings']}>
                <AppRoutes />
              </MemoryRouter>
            </ListViewProvider>
          </QueryClientProvider>,
        )
        await waitFor(() => expect(effective()).toContain('This project uses the workspace limit (no limit).'))
        cleanup()
      }
    })

    it('stays in single-project mode, where the registry controls are gone', async () => {
      // `PUT /config` is the project's own file, not a registry door, so nothing refuses it there.
      renderAt('/settings', { singleProjectRoot: true })
      expect(await screen.findByLabelText('Per-task memory limit for xezar in MiB')).not.toBeNull()
      expect(screen.queryByLabelText('Max parallel tasks for xezar')).toBeNull()
    })
  })
})
