import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { SkillsUpdateState, WorkspaceConfigResponse } from '@qodeca/xezar-api-client'
import { AppRoutes } from '@/routes'

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve(
  overrides: Partial<WorkspaceConfigResponse> = {},
  updateOverrides: Partial<SkillsUpdateState> = {},
) {
  requests = []
  const config: WorkspaceConfigResponse = {
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
      inheritedWorktree: false,
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
    agentDefaults: {},
    ...overrides,
  }
  const update: SkillsUpdateState = {
    status: 'current',
    available: false,
    autoUpdateEnabled: true,
    inherited: true,
    checkedAt: null,
    updatedAt: null,
    needsUpgradeNotes: false,
    catalog: [],
    scopes: [
      {
        scope: 'project',
        status: 'current',
        available: false,
        skills: [],
        checkedAt: null,
        updatedAt: null,
        reason: 'installation is not tracked',
      },
      {
        scope: 'global',
        status: 'current',
        available: false,
        skills: [],
        checkedAt: null,
        updatedAt: null,
        reason: 'installation is not tracked',
      },
    ],
    ...updateOverrides,
  }
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(config)
      if (url === '/api/v1/workspace/config' && method === 'PUT') {
        if (body && 'skillsAutoUpdate' in body) {
          config.skillsAutoUpdate = body.skillsAutoUpdate as boolean | null
          config.effectiveSkillsAutoUpdate = config.skillsAutoUpdate ?? true
        }
        return json(config)
      }
      if (url === '/api/v1/workspace/skills-update?projectId=boot') return json(update)
      return new Promise<never>(() => {})
    }),
  )
}

function renderSkills() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/xezar/projects',
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/global/skills']}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const puts = () => requests.filter((request) => request.method === 'PUT')

describe('Global settings → Skills', () => {
  it('renders the inherited default and quiet no-installation state', async () => {
    serve()
    renderSkills()
    const toggle = await screen.findByRole('switch', {
      name: 'Update xezar-skills automatically',
    })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('On (default)')).toBeTruthy()
    expect(screen.getByText(/XEZ_SKILLS_AUTO_UPDATE supplies/)).toBeTruthy()
    expect(await screen.findByText('No tracked xezar-skills installation found.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Use default' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('surfaces the reason a current scope was left alone (skills from another source)', async () => {
    const reason = 'Installed skills come from another source; xezar does not update them'
    serve(
      {},
      {
        scopes: [
          { scope: 'project', status: 'current', available: false, skills: [], checkedAt: null, updatedAt: null, reason },
          { scope: 'global', status: 'current', available: false, skills: [], checkedAt: null, updatedAt: null, reason: 'installation is not tracked' },
        ],
      },
    )
    renderSkills()
    expect(await screen.findByText(reason)).toBeTruthy()
    expect(screen.queryByText('No tracked xezar-skills installation found.')).toBeNull()
  })

  it('writes an explicit boolean, then can clear it back to the inherited default', async () => {
    serve()
    renderSkills()
    const toggle = await screen.findByRole('switch', {
      name: 'Update xezar-skills automatically',
    })
    fireEvent.click(toggle)
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({ skillsAutoUpdate: false }))
    const reset = screen.getByRole('button', { name: 'Use default' })
    await waitFor(() => expect((reset as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(reset)
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({ skillsAutoUpdate: null }))
  })

  // ---- the skill catalog version block (#744) ----

  const INSTALLED = { commit: 'c'.repeat(40), shortCommit: 'c30432d', date: '2026-09-19', tag: 'v1.0.0' }
  const AVAILABLE = { commit: 'd'.repeat(40), shortCommit: 'de525c6', date: '2026-09-20', tag: 'v1.1.0' }

  it('shows the served catalog version, the version last seen upstream and the state', async () => {
    serve(
      {},
      {
        catalog: [
          {
            repo: 'qodeca/xezar-skills',
            ref: 'main',
            state: 'update-available',
            installed: INSTALLED,
            available: AVAILABLE,
            fetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          },
        ],
      },
    )
    renderSkills()
    expect(await screen.findByText('Skill catalog')).toBeTruthy()
    expect(screen.getByText('v1.0.0 (c30432d, 2026-09-19)')).toBeTruthy()
    expect(screen.getByText('v1.1.0 (de525c6, 2026-09-20)')).toBeTruthy()
    expect(screen.getByText('Update available')).toBeTruthy()
    expect(screen.getByText('Tracking qodeca/xezar-skills main — last checked 2h ago.')).toBeTruthy()
  })

  it('reads up to date when both halves name the same commit, and drops an absent tag', async () => {
    const untagged = { commit: 'e'.repeat(40), shortCommit: 'e1e1e1e', date: '2026-09-20' }
    serve(
      {},
      {
        catalog: [
          {
            repo: 'qodeca/xezar-skills',
            ref: 'main',
            state: 'up-to-date',
            installed: untagged,
            available: untagged,
            fetchedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
          },
        ],
      },
    )
    renderSkills()
    expect(await screen.findByText('Up to date')).toBeTruthy()
    // No tag: the sha carries the version on its own, never an empty pair of brackets.
    expect(screen.getAllByText('e1e1e1e (2026-09-20)').length).toBe(2)
  })

  it('renders the cold-cache unknown state quietly, and leaves the npx status line untouched', async () => {
    serve(
      {},
      {
        catalog: [{ repo: 'qodeca/xezar-skills', ref: 'main', state: 'unknown', fetchedAt: null }],
      },
    )
    renderSkills()
    expect(await screen.findByText('Version unknown')).toBeTruthy()
    expect(
      screen.getByText(
        'xezar has not read this catalog clone yet — it appears once the skills are first loaded.',
      ),
    ).toBeTruthy()
    // Both missing halves read as an em dash, never as "undefined".
    expect(screen.getAllByText('—').length).toBe(2)
    // Not an error: the danger empty state belongs to a failed config load only.
    expect(screen.queryByText('Could not load skill settings')).toBeNull()
    // Guard (passes with and without the change): the existing line keeps its exact words.
    expect(screen.getByText('No tracked xezar-skills installation found.')).toBeTruthy()
  })

  it('says so when no team skill source is configured', async () => {
    serve()
    renderSkills()
    expect(await screen.findByText('No team skill source is configured.')).toBeTruthy()
  })

  it('degrades to an unavailable status without disabling the preference', async () => {
    serve(
      {},
      {
        status: 'unavailable',
        scopes: [
          {
            scope: 'project',
            status: 'unavailable',
            available: false,
            skills: [],
            checkedAt: null,
            updatedAt: null,
            reason: 'npx is unavailable',
          },
        ],
      },
    )
    renderSkills()
    expect(await screen.findByText('npx is unavailable')).toBeTruthy()
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false)
  })
})
