import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import type { HealthResponse, WorkspaceConfigResponse } from '@qodeca/xezar-api-client'
import {
  deriveProjectCapabilities,
  deriveSharedConstraints,
  failingQualityChecks,
  McpCapabilities,
  McpCapabilitiesView,
  type McpCapability,
} from './mcp-capabilities'
import { McpConnectionSection } from './mcp-connection-section'

/**
 * Issue #114 (Phase 7 of epic #67): what the MCP leader can and cannot do in this project.
 *
 * U-M06 (required): every capability renders as a usable project function, an unavailable
 * dependency WITH A NAMED REASON, or a read-only shared constraint — and authority is not
 * configurable: full project authority includes delete and merge, with no role toggle and no
 * permission checklist. F-22 / UX-M05: a failing quality check stays visible, with a reason and
 * the next legitimate action, and nothing that dismisses, accepts or overrides it.
 */

const FULL: HealthResponse = {
  version: '0.14.0',
  projects: [
    { id: 'xezar', name: 'xezar' },
    { id: 'other', name: 'secret-other-project' },
  ],
  bootProject: 'xezar',
  repoRoot: '/home/me/Projects/xezar',
  repo: { root: '/home/me/Projects/xezar', branch: 'main' },
  checks: [
    { name: 'claude', available: true, version: '2.1.0' },
    { name: 'codex', available: true },
    { name: 'gh', available: true },
    { name: 'git', available: true },
  ],
  defaultRunner: 'claude',
  forge: { kind: 'github', available: true },
  capabilities: {
    localHandoff: true,
    tokenMetrics: true,
    tokenUsageMetrics: true,
    costMetrics: true,
    followups: true,
    singleProject: false,
    automations: true,
  },
}

/** Every dependency absent at once: no git, no forge, no agent, hosted, features off. */
const DEGRADED: HealthResponse = {
  ...FULL,
  repo: null,
  forge: null,
  checks: [
    { name: 'claude', available: false },
    { name: 'codex', available: false },
  ],
  capabilities: { ...FULL.capabilities, localHandoff: false, followups: false, automations: false },
}

const WORKSPACE: WorkspaceConfigResponse = {
  browseRoot: '~',
  projectsDir: '~/xezar/projects',
  skillsAutoUpdate: null,
  effectiveSkillsAutoUpdate: true,
  followups: null,
  effectiveFollowups: true,
  agentEnvPassthrough: null,
  effectiveAgentEnvPassthrough: [],
  composerDefaults: { autonomous: null, worktree: null, inheritedAutonomous: 'source-dependent', inheritedWorktree: true },
  resources: {
    maxParallel: 4,
    maxMonitoringSessions: 2,
    monitoringWakeIntervalMinutes: null,
    autoResumeOnUsageLimit: true,
    idleTimeoutMinutes: null,
    memoryLimitMb: null,
    memoryLimitDefaultMb: 4096,
    worktreeRetentionDefault: 10,
  },
  agentDefaults: {},
}

const CONFIG = {
  baseBranch: null,
  defaultRunner: 'claude',
  systemPrompt: null,
  defaultModels: {},
  modelsLocked: false,
  maxParallel: 2,
  memoryLimitMb: null,
  worktreeRetention: 10,
  liveTitleUpdates: null,
  reviewGate: null,
  plannerModel: 'sonnet',
  namerModel: 'haiku',
  skillsRepos: [],
}

const REGISTRY = {
  projects: [{ id: 'xezar', name: 'xezar', root: '/home/me/Projects/xezar', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok' }],
  bootProject: 'xezar',
  projectsDir: '~/xezar/projects',
}

function run(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: `Task ${id}`,
    workflow: 'feature',
    task: 'do it',
    status: 'failed',
    createdAt: '2026-09-11T05:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [
      { id: 'author', name: 'author', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0 },
      {
        id: 'gates',
        name: 'repo-gates',
        kind: 'check',
        status: 'failed',
        iterations: 1,
        tokensUsed: 0,
        // A check's output can carry anything — it must never reach this screen.
        error: 'exit 1: GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked',
      },
    ],
    ...over,
  }
}

/** Every interactive element a person could operate. A toggle of any shape would be one of these. */
const INTERACTIVE = 'a[href], button, input, select, textarea, [role="switch"], [role="checkbox"], [role="radio"], [role="menuitemcheckbox"], [tabindex]'

const fetchMock = vi.fn<typeof fetch>()

function serve(routes: Record<string, unknown>, failing: Record<string, number> = {}) {
  fetchMock.mockImplementation(async (input) => {
    const path = String(input).replace('/api/v1/p/default/', '/api/v1/')
    if (path in failing) return new Response(JSON.stringify({ error: 'boom' }), { status: failing[path] })
    if (!(path in routes)) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    return new Response(JSON.stringify(routes[path]), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

function renderWired(node: React.ReactNode) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/p/xezar/settings/mcp-connection']}>
        <ProjectScopeProvider projectId={null}>{node}</ProjectScopeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const byId = (list: McpCapability[], id: string) => list.find((c) => c.id === id)!

beforeEach(() => vi.stubGlobal('fetch', fetchMock))
afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

describe('deriveProjectCapabilities (U-M06)', () => {
  it('reports every project function usable when every dependency is present — delete and merge included', () => {
    const list = deriveProjectCapabilities({ health: FULL, modelsLocked: false })
    expect(list.map((c) => c.status)).toEqual(list.map(() => 'available'))
    // Full project authority includes delete and merge.
    expect(byId(list, 'delete_task').label).toContain('Delete a task')
    expect(byId(list, 'github').label).toContain('merging')
  })

  it('names a reason AND the next legitimate action for every dependency that is missing', () => {
    const list = deriveProjectCapabilities({ health: DEGRADED, modelsLocked: true })
    // Only the two functions with no dependency stay usable.
    expect(list.filter((c) => c.status === 'available').map((c) => c.id)).toEqual(['delete_task', 'project_settings'])
    for (const capability of list) {
      if (capability.status === 'available') continue
      expect(capability.reason.length).toBeGreaterThan(10)
      expect(capability.next.length).toBeGreaterThan(10)
    }
    expect(byId(list, 'model_selection').status).toBe('read-only')
    expect(byId(list, 'create_task').status).toBe('unavailable')
    expect(byId(list, 'github').status).toBe('unavailable')
    expect(byId(list, 'agent_config_write').status).toBe('unavailable')
  })

  it('tells "GitHub not checked yet" apart from "GitHub unavailable"', () => {
    const pending = deriveProjectCapabilities({ health: { ...FULL, forge: { kind: 'github' } }, modelsLocked: false })
    const down = deriveProjectCapabilities({
      health: { ...FULL, forge: { kind: 'github', available: false, reason: 'HTTP 401: acme-org/private for jane@example.com' } },
      modelsLocked: false,
    })
    const pendingGithub = byId(pending, 'github')
    const downGithub = byId(down, 'github')
    expect(pendingGithub.status === 'unavailable' && pendingGithub.reason).toContain('not been checked yet')
    // The forge's raw text can name an account or an organisation (F-12): it is classified, never forwarded.
    expect(downGithub.status === 'unavailable' && downGithub.reason).not.toMatch(/acme-org|jane@|401/)
  })
})

describe('deriveSharedConstraints (read-only shared limits)', () => {
  it('reports the effective workspace limits and the composer defaults, in words', () => {
    const values = Object.fromEntries(deriveSharedConstraints(WORKSPACE).map((c) => [c.id, c.value]))
    expect(values.max_parallel).toBe('4 across all projects')
    expect(values.memory_limit).toBe('No limit')
    expect(values.monitoring_wake).toContain('Never')
    expect(values.idle_timeout).toBe('Never')
    expect(values.auto_resume).toBe('On')
    expect(values.default_autonomous).toBe('Depends on how the task is started')
    expect(values.default_worktree).toBe('On')
  })

  it("lets THIS project's own override win, and reads no other project", () => {
    const values = Object.fromEntries(
      deriveSharedConstraints(
        { ...WORKSPACE, resources: { ...WORKSPACE.resources, memoryLimitMb: 6144, idleTimeoutMinutes: 15 } },
        { maxParallel: 1, memoryLimitMb: 2048 },
      ).map((c) => [c.id, c.value]),
    )
    expect(values.max_parallel).toBe('1 (this project; 4 across all projects)')
    expect(values.memory_limit).toBe('2048 MiB (this project)')
    expect(values.idle_timeout).toBe('After 15 minutes')
  })
})

describe('McpCapabilitiesView — three forms, no toggles (U-M06)', () => {
  it('renders usable, unavailable-with-reason and read-only forms, each with its status in words', () => {
    const { container } = render(
      <MemoryRouter>
        <McpCapabilitiesView
          capabilities={deriveProjectCapabilities({ health: DEGRADED, modelsLocked: true })}
          constraints={deriveSharedConstraints(WORKSPACE)}
          failingChecks={[]}
        />
      </MemoryRouter>,
    )
    const row = (id: string) => container.querySelector(`[data-capability="${id}"]`)!
    expect(row('delete_task').getAttribute('data-status')).toBe('available')
    expect(row('delete_task').textContent).toContain('Available')

    expect(row('github').getAttribute('data-status')).toBe('unavailable')
    expect(row('github').textContent).toContain('Unavailable')
    expect(row('github').querySelector('[data-slot="mcp-capability-reason"]')?.textContent).toContain('not a git repository')
    expect(row('github').querySelector('[data-slot="mcp-capability-next"]')?.textContent).toMatch(/Next: .+/)

    expect(row('model_selection').getAttribute('data-status')).toBe('read-only')
    expect(row('model_selection').textContent).toContain('Read-only')

    const constraints = container.querySelectorAll('[data-slot="mcp-constraint"]')
    expect(constraints.length).toBe(8)
    for (const constraint of constraints) expect(constraint.textContent).toContain('Read-only')

    // No toggle, switch, checkbox, field or button exists for any capability or limit.
    expect(container.querySelectorAll(INTERACTIVE).length).toBe(0)
    // And the copy says authority is not configurable, rather than implying a missing setting.
    expect(container.textContent).toContain('There are no roles or per-action permissions to set.')
  })

  it('withholds unconfirmed values while loading instead of guessing them', () => {
    const { container } = render(<McpCapabilitiesView capabilities={null} constraints={null} failingChecks={null} />)
    expect(container.querySelectorAll('[data-slot="mcp-capability"]').length).toBe(0)
    expect(container.querySelectorAll('[role="status"]').length).toBe(3)
  })
})

describe('Quality checks stay visible and cannot be waived (F-22, UX-M05, A-22)', () => {
  it('renders a failing check with a reason and the next action, and NO dismiss, exception or override affordance', () => {
    const failing = failingQualityChecks([run('r1'), run('r2', { archived: true })] as never)
    expect(failing).toEqual([{ runId: 'r1', title: 'Task r1', step: 'repo-gates' }])

    const { container } = render(
      <MemoryRouter>
        <McpCapabilitiesView capabilities={[]} constraints={[]} failingChecks={failing} />
      </MemoryRouter>,
    )
    const region = container.querySelector('[data-slot="mcp-quality"]')!
    const text = region.textContent ?? ''
    expect(text).toContain('Check failed:')
    expect(text).toContain('repo-gates')
    expect(text).toContain('Task r1')
    expect(text).toContain('not complete until it passes')

    // The ONLY interactive element is the link that opens the task — nothing dismisses, accepts
    // the failure as an exception, overrides, waives or skips it.
    const controls = [...region.querySelectorAll(INTERACTIVE)]
    expect(controls.map((el) => el.tagName)).toEqual(['A'])
    expect(controls[0]!.textContent).toBe('Open task: Task r1')
    for (const el of controls) {
      expect(`${el.textContent} ${el.getAttribute('aria-label') ?? ''}`).not.toMatch(/dismiss|exception|override|waive|skip|ignore|accept/i)
    }
    // The check's raw output is never rendered: it can carry a secret (F-15).
    expect(container.textContent).not.toContain('ghp_')
    expect(container.textContent).not.toContain('GITHUB_TOKEN')
  })
})

describe('McpCapabilities wired to the server facts', () => {
  it('renders the real facts and never another project or an account identity (F-12, N-01)', async () => {
    serve({
      '/api/v1/health': FULL,
      '/api/v1/projects': REGISTRY,
      '/api/v1/config': CONFIG,
      '/api/v1/workspace/config': WORKSPACE,
      '/api/v1/runs': [run('r1')],
    })
    const { container } = renderWired(<McpCapabilities />)
    await waitFor(() => expect(container.querySelectorAll('[data-slot="mcp-capability"]').length).toBeGreaterThan(0))
    await waitFor(() => expect(container.querySelector('[data-slot="mcp-quality-failure"]')).toBeTruthy())
    await waitFor(() => expect(container.querySelectorAll('[data-slot="mcp-constraint"]').length).toBe(8))
    const text = container.textContent ?? ''
    expect(text).not.toContain('secret-other-project')
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i)
  })

  it('keeps rendering the other parts when one source fails, with a readable error (N-07)', async () => {
    serve(
      { '/api/v1/health': FULL, '/api/v1/projects': REGISTRY, '/api/v1/workspace/config': WORKSPACE, '/api/v1/runs': [] },
      { '/api/v1/config': 409 },
    )
    const { container } = renderWired(<McpCapabilities />)
    await waitFor(() => expect(container.querySelector('[data-slot="mcp-capabilities-error"]')).toBeTruthy())
    expect(container.querySelector('[data-slot="mcp-capabilities-error"]')?.getAttribute('role')).toBe('alert')
    await waitFor(() => expect(container.querySelectorAll('[data-slot="mcp-constraint"]').length).toBe(8))
    await waitFor(() => expect(container.querySelector('[data-slot="mcp-quality-clear"]')).toBeTruthy())
  })
})

describe('The MCP connection section mounts the capability view (#114)', () => {
  it('shows capabilities, shared limits and quality checks inside Project settings → MCP connection', async () => {
    serve({
      '/api/v1/health': FULL,
      '/api/v1/projects': REGISTRY,
      '/api/v1/config': CONFIG,
      '/api/v1/workspace/config': WORKSPACE,
      '/api/v1/runs': [],
    })
    const { container } = renderWired(<McpConnectionSection />)
    await waitFor(() => expect(container.querySelector('[data-slot="mcp-capabilities"]')).toBeTruthy())
    await waitFor(() => expect(container.querySelectorAll('[data-slot="mcp-capability"]').length).toBe(12))
    expect(container.textContent).toContain('What the leader can do')
    expect(container.textContent).toContain('Shared limits')
    expect(container.textContent).toContain('Quality checks')
  })
})
