import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ABSENT_CLI_SETTINGS } from '@/api/client'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { WorkspaceConfigResponse } from '@qodeca/xezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * Global settings → Terminal (#467, PR 5): the instance mode, `cli.instance`, and — by the owner's
 * decision D-5 — the three presentation keys stored beside it.
 *
 * What this pane must get right and only it can:
 *   - every write is the tri-state (a value, or `null` for "Not set"), through the workspace route
 *     and no other;
 *   - the copy says the change applies at the NEXT start, because every key was settled at boot
 *     (AC-5.2), and claims nothing that did not happen — no "Saved." before a save, no environment
 *     variable unless the server says it decides (design review B-1 on PR #798);
 *   - a narrowed cockpit gets the honest line instead of a stored value that is not what it is
 *     doing (AC-5.3), and the two narrowings are told apart (B-2).
 *
 * The route contract itself — the clearing rules, and that an unrelated write never materializes
 * the key — is pinned server-side in `packages/xezar/src/server/workspace-api.test.ts`.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve(cli: Partial<WorkspaceConfigResponse['cli']> = {}, opts: { failPut?: boolean } = {}) {
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
    cli: { ...ABSENT_CLI_SETTINGS, ...cli },
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
      worktreeRetentionDefault: 10, gateSlots: 1,
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
        if (opts.failPut) {
          return new Response(JSON.stringify({ error: 'could not write the settings file' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
        // The server's own rule, mirrored: a key the body does not name is left alone, and `null`
        // clears the stored key back to the default.
        const patch = (body?.cli ?? {}) as Record<string, string | null>
        const defaults = { instance: 'workspace', output: 'auto', color: 'auto', logLevel: 'info' } as const
        const effective = { instance: 'effectiveInstance', output: 'effectiveOutput', color: 'effectiveColor', logLevel: 'effectiveLogLevel' } as const
        const next: Record<string, unknown> = { ...state.cli }
        for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
          if (!(key in patch)) continue
          next[key] = patch[key]
          next[effective[key]] = patch[key] ?? defaults[key]
          next[`${key}Source`] = patch[key] === null ? 'default' : 'stored'
        }
        state.cli = next as WorkspaceConfigResponse['cli']
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

const select = (slot: string) => document.querySelector<HTMLSelectElement>(`[data-slot="${slot}"]`)
const text = (slot: string) => document.querySelector(`[data-slot="${slot}"]`)?.textContent ?? ''

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

  it('sends null — never a mode — when the person chooses Not set', async () => {
    serve({ instance: 'project', effectiveInstance: 'project', instanceSource: 'stored' })
    renderTerminal()
    await waitFor(() => expect(control()?.value).toBe('project'))

    fireEvent.change(control()!, { target: { value: 'inherit' } })
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]!.body).toEqual({ cli: { instance: null } })
  })

  /**
   * Design review B-1. The default state must not claim a save nobody made, must not name a
   * variable nobody set, and must name its "no stored key" option by what it does. Named break
   * `saved-before-save`: make the "Saved." prefix unconditional again and this goes red.
   */
  it('the default state claims no save and names no variable', async () => {
    serve()
    renderTerminal()
    await waitFor(() => expect(control()).not.toBeNull())
    const options = [...control()!.options].map((o) => o.textContent)
    expect(options).toContain('Not set — use the default')
    expect(options.join(' ')).not.toContain('XEZ_INSTANCE')

    const hint = text('terminal-instance-hint')
    expect(hint).toContain('applies the next time you start xezar')
    expect(hint).toContain('this cockpit keeps running as it is')
    expect(hint).toContain('The next start will use one cockpit for every project.')
    expect(hint).not.toContain('Saved.')
    expect(hint).not.toContain('XEZ_INSTANCE')
    expect(hint).not.toContain('environment')
    expect(document.querySelector('[data-slot="terminal-instance-narrowed"]')).toBeNull()
  })

  it('says "Saved." only after a save in this visit succeeded', async () => {
    serve()
    renderTerminal()
    await waitFor(() => expect(control()).not.toBeNull())
    fireEvent.change(control()!, { target: { value: 'project' } })
    await waitFor(() => expect(text('terminal-instance-hint')).toMatch(/^Saved\. /))
    // Only the field that was saved says so.
    expect(text('terminal-output-hint')).not.toContain('Saved.')
  })

  it('never says "Saved." beside a save that failed', async () => {
    serve({}, { failPut: true })
    renderTerminal()
    await waitFor(() => expect(control()).not.toBeNull())
    fireEvent.change(control()!, { target: { value: 'project' } })
    await waitFor(() => expect(puts()).toHaveLength(1))
    await waitFor(() => expect(control()!.disabled).toBe(false))
    expect(text('terminal-instance-hint')).not.toContain('Saved.')
  })

  it('names XEZ_INSTANCE only when the server says the variable decides', async () => {
    serve({ effectiveInstance: 'project', instanceSource: 'env' })
    renderTerminal()
    await waitFor(() => expect(control()).not.toBeNull())
    expect(text('terminal-instance-hint')).toContain('one cockpit per project (from XEZ_INSTANCE).')
  })

  /** NB-1's screen half: the mode multiplies cockpits, so the hint says each keeps its own limit. */
  it('says each cockpit applies its own task limit', async () => {
    serve()
    renderTerminal()
    await waitFor(() => expect(control()).not.toBeNull())
    expect(screen.getByText(/Each cockpit applies its own task limit\./)).toBeTruthy()
  })

  /**
   * Advisory Minor 1: a `--instance` flag decided this process while nothing stored says so. The
   * pane names the mode this cockpit runs in rather than describing the next start only.
   */
  it('names the mode this cockpit was started in when a flag made it differ', async () => {
    serve({ inForce: 'project' })
    renderTerminal()
    await waitFor(() => expect(control()).not.toBeNull())
    expect(text('terminal-instance-in-force')).toContain('This cockpit was started as one cockpit per project.')
  })

  it('stays quiet about the running mode when it matches the next start', async () => {
    serve()
    renderTerminal()
    await waitFor(() => expect(control()).not.toBeNull())
    expect(document.querySelector('[data-slot="terminal-instance-in-force"]')).toBeNull()
  })

  /**
   * AC-5.3 in the env-flag narrowing, and the named break `inForce-mirrors-stored`: make the pane
   * read `instance` or `effectiveInstance` here instead of `inForce` and this goes red — it would
   * tell a cockpit that serves one project that it opens every project. Under
   * `XEZ_SINGLE_PROJECT` the value goes to this machine's file, so the control stays (B-2).
   */
  it('tells an env-narrowed cockpit that the setting does not change what it does here', async () => {
    serve({ instance: 'workspace', instanceSource: 'stored', inForce: 'narrowed', narrowing: 'env-flag' })
    renderTerminal()
    await waitFor(() => expect(control()?.value).toBe('workspace'))

    expect(screen.getByText(/already serves one project only/)).toBeTruthy()
    expect(document.querySelector('[data-slot="terminal-instance-hint"]')).toBeNull()
  })

  /**
   * Design review B-2. A folder that owns its state is narrowed again at every start, so a stored
   * mode could never take effect: the answer is read-only text and there is no control to change.
   */
  it('shows a folder that owns its state as read-only, with no control', async () => {
    serve({ inForce: 'narrowed', narrowing: 'project-root' })
    renderTerminal()
    await waitFor(() => expect(text('terminal-instance-owned')).not.toBe(''))
    expect(text('terminal-instance-owned')).toBe(
      'This project has its own settings, so this cockpit always serves one project.',
    )
    expect(control()).toBeNull()
    expect(screen.queryByText(/start elsewhere/)).toBeNull()
    // No hint describing choices this folder does not offer.
    expect(screen.queryByText(/XEZ_INSTANCE/)).toBeNull()
    // The presentation keys still reach this folder's own next start, so they stay editable.
    expect(select('terminal-output')).not.toBeNull()
  })

  /** The owner's D-5: the three presentation keys, each through the same route and tri-state. */
  it('writes each presentation key, and null for Not set', async () => {
    serve()
    renderTerminal()
    await waitFor(() => expect(select('terminal-output')).not.toBeNull())

    fireEvent.change(select('terminal-output')!, { target: { value: 'rich' } })
    await waitFor(() => expect(puts()).toHaveLength(1))
    await waitFor(() => expect(select('terminal-output')!.disabled).toBe(false))
    fireEvent.change(select('terminal-color')!, { target: { value: 'never' } })
    await waitFor(() => expect(puts()).toHaveLength(2))
    await waitFor(() => expect(select('terminal-color')!.disabled).toBe(false))
    fireEvent.change(select('terminal-log-level')!, { target: { value: 'debug' } })
    await waitFor(() => expect(puts()).toHaveLength(3))
    await waitFor(() => expect(select('terminal-log-level')!.disabled).toBe(false))
    fireEvent.change(select('terminal-output')!, { target: { value: 'inherit' } })
    await waitFor(() => expect(puts()).toHaveLength(4))

    expect(puts().map((r) => r.body)).toEqual([
      { cli: { output: 'rich' } },
      { cli: { color: 'never' } },
      { cli: { logLevel: 'debug' } },
      { cli: { output: null } },
    ])
    await waitFor(() => expect(text('terminal-log-level-hint')).toContain('will print everything, for debugging.'))
    expect(text('terminal-color-hint')).toContain('will print without colour.')
  })

  it('names the variable or NO_COLOR only when it decides a presentation key', async () => {
    serve({
      effectiveOutput: 'lines',
      outputSource: 'env',
      effectiveColor: 'never',
      colorSource: 'no-color',
      logLevel: 'warn',
      effectiveLogLevel: 'warn',
      logLevelSource: 'stored',
    })
    renderTerminal()
    await waitFor(() => expect(select('terminal-output')).not.toBeNull())
    expect(text('terminal-output-hint')).toContain('print one line per event (from XEZ_OUTPUT).')
    expect(text('terminal-color-hint')).toContain('print without colour (NO_COLOR is set).')
    expect(text('terminal-log-level-hint')).toContain('print warnings and errors.')
    expect(text('terminal-log-level-hint')).not.toContain('XEZ_LOG_LEVEL')
    expect(select('terminal-log-level')!.value).toBe('warn')
  })
})
