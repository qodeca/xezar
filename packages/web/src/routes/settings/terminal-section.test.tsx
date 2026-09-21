import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { WorkspaceConfigResponse } from '@qodeca/xezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * Global settings → Terminal (#467, PR 5): the instance mode, `cli.instance`.
 *
 * Three things this pane must get right and only it can:
 *   - the write is the tri-state (`'project' | 'workspace' | null`), through the workspace route
 *     and no other, so "Follow XEZ_INSTANCE" sends `null` rather than a mode;
 *   - the copy says the change applies at the NEXT start, because the mode was settled at boot
 *     (AC-5.2);
 *   - a narrowed cockpit gets the honest line instead of a stored value that is not what it is
 *     doing (AC-5.3).
 *
 * The route contract itself — the clearing rules, and that an unrelated write never materializes
 * the key — is pinned server-side in `packages/xezar/src/server/workspace-api.test.ts`.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve(cli: Partial<WorkspaceConfigResponse['cli']> = {}) {
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
    cli: { instance: null, effectiveInstance: 'workspace', inForce: 'workspace', ...cli },
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
    },
  }
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(state)
      if (url === '/api/v1/workspace/config' && method === 'PUT') {
        // The server's own rule, mirrored: a body that does not name `cli` leaves it alone, and
        // `null` clears the stored key back to the environment's answer.
        const patch = body?.cli as { instance?: 'project' | 'workspace' | null } | undefined
        if (patch && 'instance' in patch) {
          state.cli = {
            ...state.cli,
            instance: patch.instance ?? null,
            effectiveInstance: patch.instance ?? 'workspace',
          }
        }
        return json(state)
      }
      return new Promise<never>(() => {})
    }),
  )
}

function renderTerminal() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/xezar/projects',
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/global/terminal']}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const control = () => document.querySelector<HTMLSelectElement>('[data-slot="terminal-instance"]')
const puts = () => requests.filter((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/config')

describe('Global settings → Terminal', () => {
  afterEach(() => {
    cleanup()
    resetToasts()
    vi.unstubAllGlobals()
  })

  it('shows the stored mode and writes it through the workspace route only', async () => {
    serve()
    renderTerminal()
    await waitFor(() => expect(control()).not.toBeNull())
    expect(control()!.value).toBe('inherit') // nothing stored

    fireEvent.change(control()!, { target: { value: 'project' } })
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]!.body).toEqual({ cli: { instance: 'project' } })
    // The per-repo settings route is never touched from a workspace-wide pane.
    expect(requests.some((r) => r.url === '/api/v1/config')).toBe(false)
    await waitFor(() => expect(control()!.value).toBe('project'))
  })

  it('sends null — never a mode — when the person chooses to follow the variable', async () => {
    serve({ instance: 'project', effectiveInstance: 'project' })
    renderTerminal()
    await waitFor(() => expect(control()?.value).toBe('project'))

    fireEvent.change(control()!, { target: { value: 'inherit' } })
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]!.body).toEqual({ cli: { instance: null } })
  })

  /** AC-5.2. The mode is a boot decision; copy that implied otherwise would be the whole defect. */
  it('says the change applies at the next start, never that it is live', async () => {
    serve()
    renderTerminal()
    await waitFor(() => expect(control()).not.toBeNull())
    const hint = document.querySelector('[data-slot="terminal-instance-hint"]')!.textContent!
    expect(hint).toContain('applies the next time you start xezar')
    expect(hint).toContain('this cockpit keeps running as it is')
    expect(document.querySelector('[data-slot="terminal-instance-narrowed"]')).toBeNull()
  })

  /**
   * AC-5.3, and the named break `inForce-mirrors-stored`: make the pane read `instance` or
   * `effectiveInstance` here instead of `inForce` and this goes red — it would tell a cockpit
   * that serves one project that it opens every project.
   */
  it('tells a narrowed cockpit that the setting does not change what it does here', async () => {
    serve({ instance: 'workspace', effectiveInstance: 'workspace', inForce: 'narrowed' })
    renderTerminal()
    await waitFor(() => expect(control()?.value).toBe('workspace'))

    expect(screen.getByText(/already serves one project only/)).toBeTruthy()
    expect(document.querySelector('[data-slot="terminal-instance-hint"]')).toBeNull()
  })
})
