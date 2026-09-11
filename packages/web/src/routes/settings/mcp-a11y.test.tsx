import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { AppearanceProvider } from '@/components/appearance-provider'
import { ThemeProvider } from '@/components/theme-provider'
import { AppRoutes } from '@/routes'
import type { McpOperation } from '@/routes/task-thread/mcp-operation-feedback'
import type { HealthResponse } from '@qodeca/xezar-api-client'
import { McpConnectionSurface } from './mcp-connection-section'
import type { McpConnectionState } from './mcp-connection-state'

/**
 * Issue #114 (U-M08, UX-M06): the accessibility and narrow-screen pass over the WHOLE MCP
 * settings surface — #111's setup guidance, #112's connection state, #113's operation outcomes
 * and #114's capabilities, assembled as one page, not checked piece by piece.
 *
 * jsdom computes no layout and no colour, so these assertions are STRUCTURAL: they pin the markup
 * that makes keyboard use, visible focus, wrapping and theming work. The real-browser walkthrough
 * (phone width, light and dark, keyboard only) is recorded as QA evidence on the pull request.
 */

const HEALTH: HealthResponse = {
  version: '0.14.0',
  projects: [{ id: 'boot', name: 'boot' }],
  bootProject: 'boot',
  repoRoot: '/home/me/Projects/a-rather-long-directory-name/that-keeps-going/boot',
  repo: { root: '/home/me/Projects/a-rather-long-directory-name/that-keeps-going/boot', branch: 'main' },
  checks: [
    { name: 'claude', available: true },
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
    followups: false,
    singleProject: false,
    automations: false,
  },
}

const PROJECTS = [{ id: 'boot', name: 'boot', root: HEALTH.repoRoot }]

const WORKSPACE = {
  browseRoot: '~',
  projectsDir: '~/xezar/projects',
  skillsAutoUpdate: null,
  effectiveSkillsAutoUpdate: true,
  followups: null,
  effectiveFollowups: false,
  agentEnvPassthrough: null,
  effectiveAgentEnvPassthrough: [],
  composerDefaults: { autonomous: null, worktree: null, inheritedAutonomous: false, inheritedWorktree: true },
  resources: {
    maxParallel: 3,
    maxMonitoringSessions: 2,
    monitoringWakeIntervalMinutes: 30,
    autoResumeOnUsageLimit: true,
    idleTimeoutMinutes: 15,
    memoryLimitMb: 4096,
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
  modelsLocked: true,
  maxParallel: 2,
  memoryLimitMb: null,
  worktreeRetention: 10,
  liveTitleUpdates: null,
  reviewGate: null,
  plannerModel: 'sonnet',
  namerModel: 'haiku',
  skillsRepos: [],
}

const FAILING_RUN = {
  id: 'r1',
  title: 'Add the thing',
  workflow: 'feature',
  task: 'do it',
  status: 'failed',
  createdAt: '2026-09-11T05:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [{ id: 'gates', name: 'repo-gates', kind: 'check', status: 'failed', iterations: 1, tokensUsed: 0 }],
}

/** Every inventory state #112 renders, and every outcome #113 renders. */
const STATES: McpConnectionState[] = [
  { kind: 'empty' },
  { kind: 'loading' },
  { kind: 'ready' },
  { kind: 'connecting' },
  { kind: 'active' },
  { kind: 'occupied' },
  { kind: 'waiting', task: { href: '/p/boot/tasks/r1', title: 'Add the thing' } },
  { kind: 'leader-paused' },
  { kind: 'server-restarting' },
  { kind: 'disconnected' },
  { kind: 'expired' },
  { kind: 'error', outcome: 'not-applied' },
  { kind: 'error', outcome: 'accepted' },
  { kind: 'error', outcome: 'unverified' },
  { kind: 'unsupported', missing: 'local connection' },
]

const OPERATIONS: McpOperation[] = (['accepted', 'running', 'completed', 'failed', 'conflict', 'unverified'] as const).map(
  (status, i) => ({ operationId: `op_${i}_${status}`, action: 'runs.create', status, retried: status === 'conflict', lastKnown: status === 'running' }),
)

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex], summary'

function serve() {
  const routes: Record<string, unknown> = {
    '/api/v1/health': HEALTH,
    '/api/v1/projects': { projects: PROJECTS, bootProject: 'boot', projectsDir: '~/xezar/projects' },
    '/api/v1/config': CONFIG,
    '/api/v1/workspace/config': WORKSPACE,
    '/api/v1/runs': [FAILING_RUN],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace('/api/v1/p/default/', '/api/v1/').replace('/api/v1/p/boot/', '/api/v1/')
      if (path in routes) {
        return new Response(JSON.stringify(routes[path]), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Promise<never>(() => {})
    }),
  )
}

function renderSurface(connection: McpConnectionState | null, operations: McpOperation[] = OPERATIONS) {
  const client = createQueryClient()
  const tree = (state: McpConnectionState | null) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/p/boot/settings/mcp-connection']}>
        <ProjectScopeProvider projectId={null}>
          <McpConnectionSurface health={HEALTH} projects={PROJECTS} connection={state} operations={operations} />
        </ProjectScopeProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
  const view = render(tree(connection))
  return { ...view, rerenderWith: (state: McpConnectionState | null) => view.rerender(tree(state)) }
}

async function settled(container: HTMLElement) {
  await waitFor(() => expect(container.querySelector('[data-slot="mcp-quality-failure"]')).toBeTruthy())
  await waitFor(() => expect(container.querySelectorAll('[data-slot="mcp-constraint"]').length).toBe(8))
}

function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby')
  const byRef = labelledBy ? document.getElementById(labelledBy)?.textContent ?? '' : ''
  return (el.getAttribute('aria-label') ?? byRef ?? '').trim() || (el.textContent ?? '').trim()
}

beforeEach(() => serve())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('dark', 'light')
})

describe('MCP surface — labelled, keyboard-reachable controls with visible focus (U-M08)', () => {
  it.each(STATES.map((state) => [state.kind + ('outcome' in state ? `:${state.outcome}` : ''), state] as const))(
    'every control is labelled and reachable by keyboard — %s',
    async (_name, state) => {
      const { container } = renderSurface(state, OPERATIONS.map((op) => ({ ...op })))
      await settled(container)
      const controls = [...container.querySelectorAll(FOCUSABLE)]
      expect(controls.length).toBeGreaterThan(0)
      for (const el of controls) {
        expect(accessibleName(el), el.outerHTML).not.toBe('')
        // Reachable by Tab: natively focusable, never removed from the tab order.
        expect(el.getAttribute('tabindex'), el.outerHTML).not.toBe('-1')
        expect(el.hasAttribute('disabled'), el.outerHTML).toBe(false)
        ;(el as HTMLElement).focus()
        expect(document.activeElement).toBe(el)
        // Focus stays visible: an element that removes the browser outline must replace it.
        const cls = el.getAttribute('class') ?? ''
        if (/\boutline-none\b/.test(cls)) expect(cls, el.outerHTML).toMatch(/focus-visible:/)
      }
    },
  )

  it('offers no disconnect, takeover, role, permission, waiver or countdown control anywhere on the page', async () => {
    for (const state of STATES) {
      const { container, unmount } = renderSurface(state)
      await settled(container)
      for (const el of container.querySelectorAll(FOCUSABLE)) {
        expect(accessibleName(el)).not.toMatch(/disconnect|take ?over|role|permission|waive|dismiss|override|exception|accept/i)
      }
      expect(container.querySelectorAll('input, select, textarea, [role="switch"], [role="checkbox"]').length).toBe(0)
      expect(container.textContent).not.toMatch(/expires in|\d+:\d{2}\b|seconds? left|minutes? left/i)
      unmount()
    }
  })
})

describe('MCP surface — status is conveyed in words and announced politely (U-M08)', () => {
  it('names every connection state, operation outcome and capability status in text, not colour alone', async () => {
    const { container, rerenderWith } = renderSurface(STATES[0]!)
    await settled(container)
    for (const state of STATES) {
      rerenderWith(state)
      const card = container.querySelector('[data-slot="mcp-connection-state"]')!
      expect(card.querySelector('h3')?.textContent?.trim().length ?? 0).toBeGreaterThan(3)
      // The icon tile is decorative; the title and copy carry the meaning.
      expect(card.querySelector('[data-slot="mcp-connection-state-icon"]')?.getAttribute('aria-hidden')).toBe('true')
    }
    const labels = [...container.querySelectorAll('[data-testid="mcp-operation-label"]')].map((el) => el.textContent)
    expect(labels).toEqual(['Accepted', 'Running', 'Completed', 'Failed', 'Conflict — not applied', 'Outcome being verified'])
    for (const row of container.querySelectorAll('[data-slot="mcp-capability"]')) {
      expect(row.querySelector('[data-slot="mcp-capability-status"]')?.textContent).toMatch(/^(Available|Unavailable|Read-only)$/)
    }
    for (const svg of container.querySelectorAll('svg')) expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('announces a connection-state change through a polite live region', async () => {
    const { container, rerenderWith } = renderSurface({ kind: 'active' })
    await settled(container)
    const region = container.querySelector('[data-slot="mcp-connection-status"]')!
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.textContent).toContain('Connected')
    rerenderWith({ kind: 'expired' })
    // Same region node, new words: that is what a screen reader announces.
    expect(container.querySelector('[data-slot="mcp-connection-status"]')).toBe(region)
    expect(region.textContent).toContain('Owner session expired')
    expect(container.querySelector('[data-slot="mcp-operations"]')?.getAttribute('aria-live')).toBe('polite')
    expect(container.querySelector('[data-slot="mcp-quality"]')?.getAttribute('aria-live')).toBe('polite')
  })

  it('says plainly when the server does not report the connection owner, instead of guessing', async () => {
    const { container } = renderSurface(null, [])
    await settled(container)
    const text = container.textContent ?? ''
    expect(container.querySelector('[data-slot="mcp-connection-status-unreported"]')).toBeTruthy()
    expect(container.querySelector('[data-slot="mcp-operations-empty"]')).toBeTruthy()
    expect(text).not.toContain('Ready to connect')
    expect(text).not.toContain('Connected')
  })
})

describe('MCP surface — narrow screens (U-M08, UX-M06)', () => {
  it('wraps configuration paths and blocks instead of scrolling them sideways', async () => {
    const { container } = renderSurface({ kind: 'ready' })
    await settled(container)
    const section = container.querySelector('[data-slot="mcp-connection-section"]')!
    // Nothing inside the section scrolls horizontally, keeps text on one line, or pins a width.
    for (const el of section.querySelectorAll('*')) {
      const cls = el.getAttribute('class') ?? ''
      expect(cls, el.outerHTML.slice(0, 160)).not.toMatch(/overflow-x-(auto|scroll)|\bwhitespace-nowrap\b|\bmin-w-\[|\bw-\[\d/)
    }
    // Every path and configuration block may break anywhere.
    const code = [...section.querySelectorAll('pre, .font-mono')]
    expect(code.length).toBeGreaterThan(4)
    for (const el of code) expect(el.getAttribute('class') ?? '', el.outerHTML.slice(0, 160)).toMatch(/break-all|break-words|whitespace-pre-wrap/)
    for (const pre of section.querySelectorAll('pre')) expect(pre.getAttribute('class')).toContain('whitespace-pre-wrap')
    // Phone layout keeps the bottom safe area clear, like every settings section.
    expect(section.getAttribute('class')).toContain('env(safe-area-inset-bottom)')
  })

  function seededClient() {
    const client = createQueryClient()
    client.setQueryData(queryKeys.health, HEALTH)
    client.setQueryData(workspaceQueryKeys.projects, { projects: PROJECTS, bootProject: 'boot', projectsDir: '~/xezar/projects' })
    return client
  }

  function renderApp(entry: string) {
    return render(
      <QueryClientProvider client={seededClient()}>
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

  it('uses the existing settings drill-in: the index lists MCP connection, the section keeps the phone nav', async () => {
    const index = renderApp('/settings')
    await waitFor(() => expect(document.querySelector('[data-slot="settings-index"] [data-section="mcp-connection"]')).toBeTruthy())
    // The stacked card list IS the phone menu (hidden from `md` up, where the rail lists it).
    expect(document.querySelector('[data-slot="settings-index"]')?.getAttribute('class')).toContain('md:hidden')
    index.unmount()

    renderApp('/settings/mcp-connection')
    await waitFor(() => expect(document.querySelector('[data-slot="mcp-connection-section"]')).toBeTruthy())
    const pills = document.querySelector('[data-slot="settings-nav-mobile"]')!
    expect(pills.getAttribute('class')).toContain('md:hidden')
    expect(pills.querySelector('[data-section="mcp-connection"]')?.getAttribute('aria-current')).toBe('page')
    // And the way back to the drill-in index exists on a phone.
    expect(pills.querySelector('[data-slot="settings-nav-index"]')).toBeTruthy()
  })
})

describe('MCP surface — light and dark (U-M08)', () => {
  it.each(['light', 'dark'] as const)('renders in %s theme with theme tokens only, no hard-coded colour', async (theme) => {
    document.documentElement.classList.add(theme)
    const { container } = renderSurface({ kind: 'occupied' })
    await settled(container)
    expect(container.querySelector('[data-slot="mcp-connection-section"]')).toBeTruthy()
    const hardCoded = /(?:^|\s)(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke)-(?:white|black|(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b|#[0-9a-f]{3,8}\b/i
    for (const el of container.querySelectorAll('*')) {
      expect(el.getAttribute('class') ?? '', el.outerHTML.slice(0, 160)).not.toMatch(hardCoded)
      expect(el.getAttribute('style') ?? '').toBe('')
    }
  })
})
