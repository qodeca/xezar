import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type {
  AutomationCheck,
  AutomationListEntry,
  AutomationLogRecord,
  AutomationsResponse,
} from '@qodeca/xezar-api-client'

import { AutomationsRoute } from './automations'

/**
 * The ENABLED automations view (#48, coverage gap R9).
 *
 * `routes.test.tsx` already pins the two degraded shapes — health silent (loading) and the
 * capability off (the "GitHub automations are off" panel) — so everything here runs with
 * `capabilities.automations: true` in the mocked `/api/v1/health` answer. Deliberately NOT gated
 * on `XEZ_AUTOMATIONS`: the enabled path is the one that spends the user's money and touches
 * their repo, so it has to run on every `npm test`, not only under an env var nothing sets.
 *
 * The stub below is a small stand-in server rather than a per-path canned answer, because half
 * these behaviours are round trips: create → list, enable → list. It keeps its automations in a
 * mutable array and mirrors the two server rules this view depends on — a definition is created
 * PAUSED unless `enable: true` asks otherwise, and enable/pause flip exactly that one flag.
 */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures ----------------------------------------------------------------------------------

/** Full enough that nothing reading health crashes; `automations: true` is the point of it. */
const HEALTH = {
  version: '0.0.0-test',
  repoRoot: '/home/u/xezar',
  repo: null,
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, followups: true, singleProject: false, automations: true },
  projects: [{ id: 'boot', name: 'xezar' }],
  bootProject: 'boot',
}

const PAUSED: AutomationListEntry = {
  id: 'a-1',
  revision: 1,
  name: 'Triage new issues',
  enabled: false,
  events: ['issue.opened'],
  intervalSeconds: 300,
  filters: { lookbackDays: 7, maxRecords: 25 },
  task: { prompt: 'Review {{github.url}}', workflow: 'quick-task' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  counts: { matches: 0, launched: 0, duplicates: 0, errors: 0 },
}

const ENABLED: AutomationListEntry = {
  ...PAUSED,
  id: 'a-2',
  name: 'Review pull requests',
  enabled: true,
  events: ['pull_request.opened'],
  intervalSeconds: 600,
}

const LOG: AutomationLogRecord[] = [
  {
    seq: 2,
    ts: '2026-01-02T10:00:00.000Z',
    automationId: 'a-1',
    revision: 1,
    event: 'issue.opened',
    result: 'launched',
    runId: 'run-9',
    githubNumber: 48,
    githubTitle: 'Add a cockpit unit test',
    githubUrl: 'https://github.com/qodeca/xezar/issues/48',
  },
  {
    seq: 1,
    ts: '2026-01-02T09:00:00.000Z',
    automationId: 'a-1',
    revision: 1,
    event: 'issue.opened',
    result: 'no-match',
    reason: 'label filter excluded it',
  },
]

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The `checkId` the stub hands back from `POST …/check` and answers `GET /automation-checks/…` for. */
const CHECK_ID = 'chk-1'

interface StubOptions {
  automations?: AutomationListEntry[]
  log?: AutomationLogRecord[]
  /** What the manual check has become by the time the view first polls it. */
  check?: Partial<AutomationCheck>
}

/**
 * Fetch stub in the house style (workflows.test.tsx): records every request with its body, and
 * serves the automations family from mutable state so a create or an enable is visible to the
 * refresh that follows it.
 *
 * Paths are the UNSCOPED spelling. The typed client always builds `/api/v1/p/default/…` and
 * `withApiBase` strips the `default` segment when no project scope is mounted — which is what
 * rendering under a bare `MemoryRouter` gives us.
 */
function stubFetch({ automations = [PAUSED, ENABLED], log = LOG, check = {} }: StubOptions = {}) {
  const state = { automations: [...automations], created: 0 }
  const sent: SentRequest[] = []

  const listResponse = (): AutomationsResponse => ({
    available: true,
    scheduler: { state: state.automations.some((a) => a.enabled) ? 'scheduled' : 'idle' },
    automations: state.automations,
  })

  const setEnabled = (id: string, enabled: boolean) => {
    const found = state.automations.find((a) => a.id === id)
    if (!found) return jsonResponse({ error: 'automation not found' }, 404)
    const next = { ...found, enabled, revision: found.revision + 1 }
    state.automations = state.automations.map((a) => (a.id === id ? next : a))
    return jsonResponse({ automation: next })
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      const body = init.body ? JSON.parse(String(init.body)) : undefined
      sent.push({ path, method, body })

      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(HEALTH)
      if (method === 'GET' && path === '/api/v1/automations') return jsonResponse(listResponse())

      if (method === 'POST' && path === '/api/v1/automations') {
        // The server's own rule (contract `createAutomationInputSchema`): a definition is created
        // PAUSED, and `enable: true` is what asks for a current-time baseline instead.
        const input = body as { name: string; enable?: boolean; [k: string]: unknown }
        state.created += 1
        const automation: AutomationListEntry = {
          ...PAUSED,
          ...input,
          id: `a-new-${state.created}`,
          revision: 1,
          enabled: input.enable === true,
          counts: { matches: 0, launched: 0, duplicates: 0, errors: 0 },
        }
        state.automations = [...state.automations, automation]
        return jsonResponse({ automation }, 201)
      }

      const enable = /^\/api\/v1\/automations\/([^/]+)\/enable$/.exec(path)
      if (method === 'POST' && enable) return setEnabled(enable[1]!, true)
      const pause = /^\/api\/v1\/automations\/([^/]+)\/pause$/.exec(path)
      if (method === 'POST' && pause) return setEnabled(pause[1]!, false)

      const manualCheck = /^\/api\/v1\/automations\/([^/]+)\/check$/.exec(path)
      if (method === 'POST' && manualCheck) return jsonResponse({ checkId: CHECK_ID }, 202)
      if (method === 'GET' && path === `/api/v1/automation-checks/${CHECK_ID}`) {
        return jsonResponse({
          id: CHECK_ID,
          automationId: 'a-1',
          mode: 'preview',
          status: 'complete',
          createdAt: '2026-01-02T10:00:00.000Z',
          matches: 2,
          ...check,
        } satisfies AutomationCheck)
      }

      if (method === 'GET' && path.startsWith('/api/v1/automation-log?')) {
        return jsonResponse({ records: log })
      }
      return jsonResponse({ error: `unstubbed ${method} ${path}` }, 404)
    }),
  )
  return { sent, state }
}

function renderAt(entry: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/automations" element={<AutomationsRoute />} />
          <Route path="/automations/new" element={<AutomationsRoute mode="new" />} />
          <Route path="/automations/:automationId" element={<AutomationsRoute mode="edit" />} />
          <Route path="/automations/:automationId/log" element={<AutomationsRoute mode="log" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const rows = () => [...document.querySelectorAll<HTMLElement>('article')]
const rowNamed = (name: string) =>
  rows().find((row) => row.querySelector('h2')?.textContent === name)!
const stateOf = (name: string) => {
  const row = rowNamed(name)
  return within(row).queryByText('Enabled') ? 'Enabled' : within(row).queryByText('Paused') ? 'Paused' : null
}
const posts = (sent: SentRequest[], path: string) =>
  sent.filter((request) => request.method === 'POST' && request.path === path)

// ---- the list ----------------------------------------------------------------------------------

describe('/automations with the capability on', () => {
  it('renders one row per automation, each showing its paused or enabled state', async () => {
    stubFetch()
    renderAt('/automations')

    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows().map((row) => row.querySelector('h2')?.textContent)).toEqual([
      'Triage new issues',
      'Review pull requests',
    ])
    // The state chip is the whole point of the row: it says whether this thing is spending money.
    expect(stateOf('Triage new issues')).toBe('Paused')
    expect(stateOf('Review pull requests')).toBe('Enabled')
    // The trigger summary beside the name, seconds rendered as whole minutes.
    expect(within(rowNamed('Triage new issues')).getByText('issue.opened · every 5 min')).toBeTruthy()
    expect(
      within(rowNamed('Review pull requests')).getByText('pull_request.opened · every 10 min'),
    ).toBeTruthy()
    // The header band reports the forge and the scheduler — one automation is enabled, so: scheduled.
    expect(screen.getByText('GitHub available')).toBeTruthy()
    expect(screen.getByText(/Scheduler scheduled/)).toBeTruthy()
  })

  it('an empty list explains the create-paused-then-enable sequence instead of showing nothing', async () => {
    stubFetch({ automations: [] })
    renderAt('/automations')

    await screen.findByText(
      'No automations yet. Create one paused, test its bounded filter, then enable it from a current-time baseline.',
    )
    expect(rows()).toHaveLength(0)
  })
})

// ---- create ------------------------------------------------------------------------------------

describe('/automations/new', () => {
  it('posts the composed definition and lands on the new automation — created PAUSED', async () => {
    const { sent } = stubFetch({ automations: [] })
    renderAt('/automations/new')

    // The form renders as soon as health has answered — never before it (routes.test.tsx pins that).
    await screen.findByText('New automation')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Triage new issues' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Triage {{github.url}}' } })
    // The enable checkbox is unchecked by default: the documented paused default is what the form
    // offers, and enabling is a second, deliberate act.
    const enableBox = screen.getByRole('checkbox') as HTMLInputElement
    expect(enableBox.checked).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Save automation' }))

    await waitFor(() => expect(posts(sent, '/api/v1/automations')).toHaveLength(1))
    expect(posts(sent, '/api/v1/automations')[0]!.body).toEqual({
      name: 'Triage new issues',
      events: ['issue.opened'],
      intervalSeconds: 300,
      filters: { lookbackDays: 7, maxRecords: 25 },
      task: { prompt: 'Triage {{github.url}}', workflow: 'quick-task' },
      enable: false,
    })

    // Saving navigates back to the list and re-reads it — the new automation is there, paused.
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rowNamed('Triage new issues')).toBeTruthy()
    expect(stateOf('Triage new issues')).toBe('Paused')
  })

  it('ticking “save and enable” is what carries enable: true', async () => {
    const { sent } = stubFetch({ automations: [] })
    renderAt('/automations/new')

    await screen.findByText('New automation')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Review pull requests' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Save automation' }))

    await waitFor(() => expect(posts(sent, '/api/v1/automations')).toHaveLength(1))
    expect(posts(sent, '/api/v1/automations')[0]!.body).toMatchObject({ enable: true })
    await waitFor(() => expect(stateOf('Review pull requests')).toBe('Enabled'))
  })

  it('Cancel leaves for the list without posting anything', async () => {
    const { sent } = stubFetch({ automations: [] })
    renderAt('/automations/new')

    await screen.findByText('New automation')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Never saved' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await screen.findByText(
      'No automations yet. Create one paused, test its bounded filter, then enable it from a current-time baseline.',
    )
    expect(posts(sent, '/api/v1/automations')).toHaveLength(0)
  })
})

// ---- preview -----------------------------------------------------------------------------------

describe('test filter (preview)', () => {
  it('previews without enabling anything and renders the match count', async () => {
    const { sent } = stubFetch()
    renderAt('/automations')
    await waitFor(() => expect(rows()).toHaveLength(2))

    fireEvent.click(within(rowNamed('Triage new issues')).getByRole('button', { name: 'Test filter' }))

    await screen.findByText('2 matches found; no tasks launched.')
    expect(posts(sent, '/api/v1/automations/a-1/check')[0]!.body).toEqual({ mode: 'preview' })
    // A preview launches nothing and enables nothing — the row is still paused, and no enable
    // request was ever made.
    expect(stateOf('Triage new issues')).toBe('Paused')
    expect(posts(sent, '/api/v1/automations/a-1/enable')).toHaveLength(0)
  })

  it('one match reads in the singular', async () => {
    stubFetch({ check: { matches: 1 } })
    renderAt('/automations')
    await waitFor(() => expect(rows()).toHaveLength(2))

    fireEvent.click(within(rowNamed('Triage new issues')).getByRole('button', { name: 'Test filter' }))
    await screen.findByText('1 match found; no tasks launched.')
  })

  it('a failed check reports the server’s reason in place of a count', async () => {
    stubFetch({ check: { status: 'error', error: 'gh is not authenticated' } })
    renderAt('/automations')
    await waitFor(() => expect(rows()).toHaveLength(2))

    fireEvent.click(within(rowNamed('Triage new issues')).getByRole('button', { name: 'Test filter' }))
    await screen.findByText('gh is not authenticated')
  })
})

// ---- enable / pause ----------------------------------------------------------------------------

describe('enable and pause', () => {
  it('Enable posts to the enable route and the row reflects the new state', async () => {
    const { sent } = stubFetch()
    renderAt('/automations')
    await waitFor(() => expect(rows()).toHaveLength(2))

    fireEvent.click(within(rowNamed('Triage new issues')).getByRole('button', { name: 'Enable' }))

    await waitFor(() => expect(stateOf('Triage new issues')).toBe('Enabled'))
    expect(posts(sent, '/api/v1/automations/a-1/enable')).toHaveLength(1)
    // The same button is now the opposite act.
    expect(within(rowNamed('Triage new issues')).getByRole('button', { name: 'Pause' })).toBeTruthy()
  })

  it('Pause posts to the pause route — enabling and pausing are two routes, not a toggle flag', async () => {
    const { sent } = stubFetch()
    renderAt('/automations')
    await waitFor(() => expect(rows()).toHaveLength(2))

    fireEvent.click(within(rowNamed('Review pull requests')).getByRole('button', { name: 'Pause' }))

    await waitFor(() => expect(stateOf('Review pull requests')).toBe('Paused'))
    expect(posts(sent, '/api/v1/automations/a-2/pause')).toHaveLength(1)
    expect(posts(sent, '/api/v1/automations/a-2/enable')).toHaveLength(0)
  })
})

// ---- the execution log -------------------------------------------------------------------------

describe('/automations/:id/log', () => {
  it('renders the receipts newest-first, with their GitHub and task links', async () => {
    stubFetch()
    renderAt('/automations/a-1/log')

    const list = await screen.findByLabelText('Automation execution log')
    const items = [...list.querySelectorAll('li')]
    expect(items).toHaveLength(2)
    // `no-match` is rendered as words, not as the stored slug.
    expect(items.map((item) => item.querySelector('span')?.textContent)).toEqual(['launched', 'no match'])
    expect(within(items[1]!).getByText('label filter excluded it')).toBeTruthy()

    const issue = within(items[0]!).getByRole('link', { name: 'Add a cockpit unit test' })
    expect(issue.getAttribute('href')).toBe('https://github.com/qodeca/xezar/issues/48')
    expect(within(items[0]!).getByRole('link', { name: 'Open task' }).getAttribute('href')).toBe('/runs/run-9')
    // The header names the automation, which the log route reads out of the list it also loads.
    await waitFor(() => expect(screen.getByText('Triage new issues')).toBeTruthy())
  })

  it('no receipts yet renders an empty state, not a blank screen', async () => {
    stubFetch({ log: [] })
    renderAt('/automations/a-1/log')

    await screen.findByText('No checks have run yet.')
    expect(screen.queryByLabelText('Automation execution log')).toBeNull()
    // Still a real page: the frame and the way back are both there.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Execution log')
    expect(screen.getByRole('link', { name: 'Back to automations' }).getAttribute('href')).toBe('/automations')
  })
})
