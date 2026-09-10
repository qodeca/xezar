import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { WorkspaceConfigResponse } from '@qodeca/xezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * Global settings → Resources (step 3.5): `maxParallel` and `memoryLimitMb` moved out of the
 * per-repo config into `~/.xezar/config.json` (spec §"Resource governance" — they protect the
 * host, not a repo). What this pins is the store: every read and write goes to
 * `/api/v1/workspace/config`, and the per-repo `/api/v1/config` is never touched from here — a
 * regression there would silently re-introduce a value the engine no longer reads.
 *
 * The route contract itself (bounds, the semaphore refresh) is pinned server-side in
 * src/server/workspace-api.test.ts.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve(resources: Partial<WorkspaceConfigResponse['resources']> = {}) {
  requests = []
  const state: WorkspaceConfigResponse = {
    agentDefaults: {},
    browseRoot: '~/',
    projectsDir: '~/xezar/projects',
    skillsAutoUpdate: null,
    effectiveSkillsAutoUpdate: true,
    followups: null,
    effectiveFollowups: false,
    agentEnvPassthrough: null,
    effectiveAgentEnvPassthrough: [],
    composerDefaults: {
      autonomous: null,
      worktree: null,
      inheritedAutonomous: 'source-dependent',
      inheritedWorktree: true,
    },
    resources: {
      maxParallel: 2,
      maxMonitoringSessions: 2,
      monitoringWakeIntervalMinutes: null,
      idleTimeoutMinutes: 15,
      memoryLimitDefaultMb: 4096,
      autoResumeOnUsageLimit: true,
      memoryLimitMb: null,
      worktreeRetentionDefault: 10,
      ...resources,
    },
  }
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(state)
      if (url === '/api/v1/workspace/config' && method === 'PUT') {
        Object.assign(state.resources, (body?.resources ?? {}) as object)
        // Top-level keys too (F) — a resources-only merge would make every followups /
        // agentEnvPassthrough write look like a no-op to the readback.
        if (body && 'followups' in body) {
          state.followups = body.followups as boolean | null
          state.effectiveFollowups = (body.followups as boolean | null) ?? false
        }
        if (body && 'agentEnvPassthrough' in body) {
          state.agentEnvPassthrough = body.agentEnvPassthrough as string[] | null
          state.effectiveAgentEnvPassthrough = (body.agentEnvPassthrough as string[] | null) ?? []
        }
        return json(state)
      }
      return new Promise<never>(() => {})
    }),
  )
}

/** Seeds the step-3.2 route gates so the shell renders immediately. The global settings area is
 *  unscoped, but the gates still answer for the chrome rendered around it. */
function gateSeededClient() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/xezar/projects',
  })
  return client
}

function renderResources() {
  render(
    <QueryClientProvider client={gateSeededClient()}>
      <MemoryRouter initialEntries={['/settings/global/resources']}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const parallelSelect = () =>
  document.querySelector<HTMLSelectElement>('[data-slot="resources-max-parallel"]')
const memoryInput = () =>
  document.querySelector<HTMLInputElement>('[data-slot="resources-memory-limit"]')
const saveMemory = () =>
  document.querySelector<HTMLButtonElement>('[data-action="resources-save-memory"]')
const puts = () => requests.filter((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/config')
const monitoringSelect = () => document.querySelector<HTMLSelectElement>('[data-slot="resources-max-monitoring"]')
const wakeMode = () => document.querySelector<HTMLSelectElement>('[data-slot="resources-monitoring-wake-mode"]')
const wakeInterval = () => document.querySelector<HTMLInputElement>('[data-slot="resources-monitoring-wake-interval"]')
const saveWake = () => document.querySelector<HTMLButtonElement>('[data-action="resources-save-monitoring-wake"]')
const idleMode = () => document.querySelector<HTMLSelectElement>('[data-slot="resources-idle-mode"]')
const idleInput = () => document.querySelector<HTMLInputElement>('[data-slot="resources-idle-timeout"]')
const saveIdle = () => document.querySelector<HTMLButtonElement>('[data-action="resources-save-idle-timeout"]')
const retentionDefault = () =>
  document.querySelector<HTMLInputElement>('[data-slot="resources-worktree-retention-default"]')
const saveRetentionDefault = () =>
  document.querySelector<HTMLButtonElement>('[data-action="resources-save-retention-default"]')
const followupsSelect = () => document.querySelector<HTMLSelectElement>('[data-slot="resources-followups"]')
const passthroughInput = () => document.querySelector<HTMLInputElement>('[data-slot="resources-env-passthrough"]')
const savePassthrough = () =>
  document.querySelector<HTMLButtonElement>('[data-action="resources-save-env-passthrough"]')
const clearPassthrough = () =>
  document.querySelector<HTMLButtonElement>('[data-action="resources-clear-env-passthrough"]')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('Global settings → Resources', () => {
  it('renders the workspace values, read from /api/v1/workspace/config', async () => {
    serve({ maxParallel: 5, memoryLimitMb: 4096 })
    renderResources()

    await waitFor(() => expect(parallelSelect()).not.toBeNull())
    expect(parallelSelect()!.value).toBe('5')
    expect(memoryInput()!.value).toBe('4096')
    // The per-repo config is not even read by this pane.
    expect(requests.some((r) => r.url === '/api/v1/config')).toBe(false)
  })

  it('saves maxParallel to the WORKSPACE config, never the per-repo one', async () => {
    serve({ maxParallel: 2 })
    renderResources()
    await waitFor(() => expect(parallelSelect()).not.toBeNull())

    fireEvent.change(parallelSelect()!, { target: { value: '6' } })

    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { maxParallel: 6 } })
    expect(requests.some((r) => r.method === 'PUT' && r.url === '/api/v1/config')).toBe(false)
  })

  it('links workspace limits to the per-project controls', async () => {
    serve()
    renderResources()

    const link = await screen.findByRole('link', { name: 'Configure per-project limits' })
    expect(link.getAttribute('href')).toBe('/settings/global/projects')
    expect(screen.getByText(/Need a different limit for one project/)).not.toBeNull()
  })

  it('saves the extra monitoring capacity and explains the two pools', async () => {
    serve({ maxParallel: 4, maxMonitoringSessions: 2 })
    renderResources()
    await waitFor(() => expect(monitoringSelect()).not.toBeNull())
    expect(screen.getByText(/Capacity: 4 active \+ 2 monitoring/)).not.toBeNull()
    fireEvent.change(monitoringSelect()!, { target: { value: '3' } })
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { maxMonitoringSessions: 3 } })
  })

  it('keeps wake-ups parked by default and saves an explicit interval', async () => {
    serve({ monitoringWakeIntervalMinutes: null })
    renderResources()
    await waitFor(() => expect(wakeMode()).not.toBeNull())
    expect(wakeMode()!.value).toBe('park')
    expect(wakeInterval()).toBeNull()
    fireEvent.change(wakeMode()!, { target: { value: 'interval' } })
    expect(wakeInterval()!.value).toBe('5')
    fireEvent.click(saveWake()!)
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { monitoringWakeIntervalMinutes: 5 } })
  })

  it('shows auto-resume on by default and saves the opt-out', async () => {
    serve()
    renderResources()
    const select = (await screen.findByLabelText('Auto-resume after a usage limit')) as HTMLSelectElement
    // The shipped default (spec 2026-08-03-auto-resume-after-usage-limit) — a user who never
    // opens this pane still gets their limited tasks finished.
    expect(select.value).toBe('on')

    fireEvent.change(select, { target: { value: 'off' } })
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { autoResumeOnUsageLimit: false } })
  })

  it('saves a memory limit, and an empty field clears it back to "no limit"', async () => {
    serve({ memoryLimitMb: null })
    renderResources()
    await waitFor(() => expect(memoryInput()).not.toBeNull())

    fireEvent.change(memoryInput()!, { target: { value: '2048' } })
    fireEvent.click(saveMemory()!)
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ resources: { memoryLimitMb: 2048 } })

    fireEvent.change(memoryInput()!, { target: { value: '' } })
    fireEvent.click(saveMemory()!)
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect(puts()[1]?.body).toEqual({ resources: { memoryLimitMb: null } })
  })

  it('rejects a memory limit below the floor — Save stays disabled and nothing is PUT', async () => {
    serve()
    renderResources()
    await waitFor(() => expect(memoryInput()).not.toBeNull())

    for (const bad of ['12', '1024.5', '-1']) {
      fireEvent.change(memoryInput()!, { target: { value: bad } })
      expect(saveMemory()!.disabled).toBe(true)
      expect(document.querySelector('[data-slot="resources-memory-invalid"]')).not.toBeNull()
    }
    expect(puts()).toHaveLength(0)
  })

  it("a project's OWN worktree retention is still not here — only the workspace default is", async () => {
    serve()
    renderResources()
    await waitFor(() => expect(parallelSelect()).not.toBeNull())
    // The per-repo control lives in the project's Worktrees pane and writes /api/v1/config.
    expect(document.querySelector('[data-slot="resources-worktree-retention"]')).toBeNull()
    expect(screen.queryByText('Keep last N worktrees')).toBeNull()
    // The workspace DEFAULT is here now (E) — it was API-only before.
    expect(retentionDefault()).not.toBeNull()
  })

  it('renders and saves New task On/Off/Inherit policy', async () => {
    serve()
    renderResources()
    const autonomous = await screen.findByLabelText('Autonomous by default')
    const worktree = screen.getByLabelText('Use a worktree by default')
    expect((autonomous as HTMLSelectElement).value).toBe('inherit')
    expect(screen.getByText(/Source-dependent — skills on, workflows off/)).toBeTruthy()

    fireEvent.change(autonomous, { target: { value: 'off' } })
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({
      composerDefaults: { autonomous: false },
    }))
    fireEvent.change(worktree, { target: { value: 'on' } })
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({
      composerDefaults: { worktree: true },
    }))
  })

  /**
   * A — the idle timeout is reachable from the cockpit. Two modes: a duration, or "never",
   * which must state plainly what it costs.
   */
  describe('idle timeout (A)', () => {
    it('renders the configured value and saves a new one', async () => {
      serve({ idleTimeoutMinutes: 15 })
      renderResources()
      await waitFor(() => expect(idleInput()).not.toBeNull())
      expect(idleMode()!.value).toBe('timeout')
      expect(idleInput()!.value).toBe('15')
      expect(saveIdle()!.disabled).toBe(true) // unchanged

      fireEvent.change(idleInput()!, { target: { value: '120' } })
      fireEvent.click(saveIdle()!)
      await waitFor(() => expect(puts().at(-1)?.body).toEqual({ resources: { idleTimeoutMinutes: 120 } }))
    })

    it('sends null for "never close" and says what that gives up', async () => {
      serve({ idleTimeoutMinutes: 15 })
      renderResources()
      await waitFor(() => expect(idleMode()).not.toBeNull())

      fireEvent.change(idleMode()!, { target: { value: 'never' } })
      expect(idleInput()).toBeNull() // no duration to enter
      const warning = document.querySelector('[data-slot="resources-idle-never-warning"]')
      expect(warning?.textContent).toContain('Nothing will reclaim these sessions')
      expect(warning?.textContent).toContain('Default: 15 minutes')

      fireEvent.click(saveIdle()!)
      await waitFor(() => expect(puts().at(-1)?.body).toEqual({ resources: { idleTimeoutMinutes: null } }))
    })

    it('refuses an out-of-range duration client-side, with no PUT', async () => {
      serve({ idleTimeoutMinutes: 15 })
      renderResources()
      await waitFor(() => expect(idleInput()).not.toBeNull())
      for (const value of ['0', '1441', '12.5']) {
        fireEvent.change(idleInput()!, { target: { value } })
        expect(saveIdle()!.disabled).toBe(true)
      }
      expect(puts()).toHaveLength(0)
    })

    it('renders "never close" as the saved state when the workspace stored null', async () => {
      serve({ idleTimeoutMinutes: null })
      renderResources()
      await waitFor(() => expect(idleMode()).not.toBeNull())
      expect(idleMode()!.value).toBe('never')
      expect(saveIdle()!.disabled).toBe(true)
    })
  })

  /** B1 — the pane names this machine's derived ceiling so an empty field is not a mystery. */
  it('names the host-derived memory default beside the memory field', async () => {
    serve({ memoryLimitDefaultMb: 8192, memoryLimitMb: null })
    renderResources()
    await waitFor(() => expect(memoryInput()).not.toBeNull())
    expect(document.querySelector('[data-slot="resources-memory-default"]')?.textContent).toBe('8192')
  })

  /** E — the workspace worktree-retention default had no control at all. */
  it('saves the workspace worktree-retention default', async () => {
    serve({ worktreeRetentionDefault: 10 })
    renderResources()
    await waitFor(() => expect(retentionDefault()).not.toBeNull())
    expect(retentionDefault()!.value).toBe('10')
    expect(saveRetentionDefault()!.disabled).toBe(true)

    fireEvent.change(retentionDefault()!, { target: { value: '3' } })
    fireEvent.click(saveRetentionDefault()!)
    await waitFor(() =>
      expect(puts().at(-1)?.body).toEqual({ resources: { worktreeRetentionDefault: 3 } }),
    )
  })

  /**
   * F — the two boot-time env switches, now settings. Three states each: on, off, and
   * "follow the environment" (`null`).
   */
  describe('Inbox and agent env passthrough (F)', () => {
    it('saves the Inbox toggle and can hand it back to the environment', async () => {
      serve()
      renderResources()
      await waitFor(() => expect(followupsSelect()).not.toBeNull())
      expect(followupsSelect()!.value).toBe('inherit')

      fireEvent.change(followupsSelect()!, { target: { value: 'on' } })
      await waitFor(() => expect(puts().at(-1)?.body).toEqual({ followups: true }))

      fireEvent.change(followupsSelect()!, { target: { value: 'inherit' } })
      await waitFor(() => expect(puts().at(-1)?.body).toEqual({ followups: null }))
    })

    it('saves env-var NAMES, and an emptied field is a real "forward nothing"', async () => {
      serve()
      renderResources()
      await waitFor(() => expect(passthroughInput()).not.toBeNull())

      fireEvent.change(passthroughInput()!, { target: { value: 'VITEST_MAX_WORKERS, MY_TOOL_DIR' } })
      fireEvent.click(savePassthrough()!)
      await waitFor(() =>
        expect(puts().at(-1)?.body).toEqual({
          agentEnvPassthrough: ['VITEST_MAX_WORKERS', 'MY_TOOL_DIR'],
        }),
      )

      fireEvent.change(passthroughInput()!, { target: { value: '' } })
      fireEvent.click(savePassthrough()!)
      await waitFor(() => expect(puts().at(-1)?.body).toEqual({ agentEnvPassthrough: [] }))
    })

    it('rejects anything that is not a variable name, with no PUT', async () => {
      serve()
      renderResources()
      await waitFor(() => expect(passthroughInput()).not.toBeNull())
      for (const value of ['MY_VAR=secret', '9LIVES', 'has space']) {
        fireEvent.change(passthroughInput()!, { target: { value } })
        expect(savePassthrough()!.disabled).toBe(true)
      }
      expect(puts()).toHaveLength(0)
    })

    it('clears the stored list back to the environment default', async () => {
      serve()
      renderResources()
      await waitFor(() => expect(passthroughInput()).not.toBeNull())
      // Nothing stored yet, so there is nothing to clear.
      expect(clearPassthrough()!.disabled).toBe(true)

      fireEvent.change(passthroughInput()!, { target: { value: 'A' } })
      fireEvent.click(savePassthrough()!)
      await waitFor(() => expect(clearPassthrough()!.disabled).toBe(false))
      fireEvent.click(clearPassthrough()!)
      await waitFor(() => expect(puts().at(-1)?.body).toEqual({ agentEnvPassthrough: null }))
    })
  })
})
