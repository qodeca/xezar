import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { resetToasts, Toaster } from '@/components/ui/toaster'
import type { OnboardingStatus } from '@qodeca/xezar-api-client'
import { AppRoutes } from '@/routes'

/**
 * Settings → Project setup, every state (#464 P2, `states.html` § 1 and § 2).
 *
 * The section is reached through the real router, so this also proves the registry row exists and
 * the route mounts — a section component nobody can navigate to is not a feature.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

const OBSERVED = { engineVersion: '0.15.0', kitDigest: '9f1a3b4fff' }
const OLD = { engineVersion: '0.14.0', kitDigest: '2c20c60aaa' }

const onboarding = (over: Partial<OnboardingStatus> = {}): OnboardingStatus => ({
  state: 'never',
  provenance: 'unknown',
  available: true,
  unavailableReason: null,
  localHandoff: true,
  offerPending: false,
  dismissed: false,
  observed: OBSERVED,
  lastOffered: null,
  lastChecked: null,
  checkingRunId: null,
  launch: { workflowId: 'project-setup', modes: ['setup', 'preview', 'recheck'] },
  ...over,
})

/** The onboarding read answers; everything else the shell fetches stays honestly pending. */
function serve(answer: OnboardingStatus | { status: number; error: string }, createRun?: { status: number; body: unknown }) {
  requests = []
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/onboarding' && method === 'GET') {
        return 'status' in answer ? json({ error: answer.error }, answer.status) : json(answer)
      }
      if (url === '/api/v1/runs' && method === 'POST' && createRun) {
        return json(createRun.body, createRun.status)
      }
      return new Promise<never>(() => {})
    }),
  )
}

function gateSeededClient(localHandoff = true) {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, {
    bootProject: 'boot',
    capabilities: { localHandoff, followups: false, singleProject: false },
  })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/xezar/projects',
  })
  return client
}

function renderSection({ localHandoff = true }: { localHandoff?: boolean } = {}) {
  render(
    <QueryClientProvider client={gateSeededClient(localHandoff)}>
      <MemoryRouter initialEntries={['/settings/project-setup']}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const card = () => document.querySelector('[data-slot="project-setup-card"]')
const rows = () =>
  [...(document.querySelectorAll('[data-slot="project-setup-identities"] > div') ?? [])].map(
    (row) => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent] as const,
  )

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

beforeEach(() => serve(onboarding()))

describe('Settings → Project setup', () => {
  it('shows one muted line while the state is unknown — never a premature “Not set up yet”', () => {
    serve({ status: 200, error: '' })
    vi.stubGlobal('fetch', vi.fn(async () => new Promise<never>(() => {})))
    renderSection()
    expect(document.querySelector('[data-slot="project-setup-loading"]')?.textContent).toBe(
      'Loading project setup…',
    )
    expect(card()).toBeNull()
  })

  it('reads the state and offers setup on a project nothing has looked at', async () => {
    renderSection()
    await waitFor(() => expect(card()).not.toBeNull())
    expect(card()?.getAttribute('data-setup-state')).toBe('never')
    expect(screen.getByRole('heading', { name: 'Not set up yet', level: 3 })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Set up this project/ })).toBeTruthy()
    // Three separate labelled rows, never one combined chip, and an absent value reads as a word.
    expect(rows().map(([label]) => label)).toEqual([
      'Last observed',
      'Last offered',
      'Last successfully checked',
    ])
    expect(rows()[2]?.[1]).toContain('not recorded')
  })

  it('states both identities after a version change, and keeps the older check visible', async () => {
    serve(
      onboarding({
        state: 'changed',
        provenance: 'recorded',
        lastChecked: { ...OLD, at: '2026-09-02T16:40:00.000Z' },
        dismissed: true,
        lastOffered: { ...OBSERVED, at: '2026-09-16T08:02:00.000Z' },
      }),
    )
    renderSection()
    await waitFor(() => expect(card()).not.toBeNull())
    expect(screen.getByRole('heading', { name: 'Changed since the last check', level: 3 })).toBeTruthy()
    // "Observed is not checked": the row for the finished check still names the OLD pair.
    expect(rows()[0]?.[1]).toContain('xezar 0.15.0')
    expect(rows()[2]?.[1]).toContain('xezar 0.14.0')
    expect(card()?.textContent).toContain('You chose Later')
    expect(card()?.textContent).toContain('A re-check is always here.')
  })

  it('disables the action with a readable reason when no agent backend was found', async () => {
    serve(onboarding({ available: false, unavailableReason: 'Setup unavailable — no agent backend was found.' }))
    renderSection()
    await waitFor(() => expect(card()).not.toBeNull())
    const button = screen.getByRole('button', { name: /Set up this project/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    const describedBy = button.getAttribute('aria-describedby')
    expect(document.getElementById(describedBy!)?.textContent).toContain('no agent backend was found')
  })

  it('keeps the entry in hosted mode and names the step that finishes elsewhere', async () => {
    // Hosted-ness comes from the payload, which is the one place the server answers it.
    serve(onboarding({ localHandoff: false }))
    renderSection({ localHandoff: false })
    await waitFor(() => expect(card()).not.toBeNull())
    // OQ-2 option A: the capability stays; only the honest caveat is added.
    expect((screen.getByRole('button', { name: /Set up this project/ }) as HTMLButtonElement).disabled).toBe(false)
    expect(card()?.textContent).toContain('One part finishes elsewhere.')
    // `writing.md` § 7: name the consequence and who can act, never the phrase itself.
    expect(card()?.textContent).not.toContain('not available in hosted mode')
  })

  it('points at the running task instead of offering a second check', async () => {
    serve(onboarding({ state: 'checking', checkingRunId: 'run-7', provenance: 'recorded' }))
    renderSection()
    await waitFor(() => expect(card()).not.toBeNull())
    expect(screen.getByRole('heading', { name: 'Re-checking', level: 3 })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open the task' }).getAttribute('href')).toContain('/tasks/run-7')
    expect(screen.queryByRole('button', { name: /Re-check now/ })).toBeNull()
  })

  it('offers a retry, not a dead page, when the state cannot be read', async () => {
    serve({ status: 500, error: "EACCES: permission denied, open '.local/xezar/onboarding-state.json'" })
    renderSection()
    // The cockpit's query client retries a 5xx once, so this waits past that backoff on purpose.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Could not load project setup' })).toBeTruthy(), {
      timeout: 5_000,
    })
    // The server's own message, verbatim.
    expect(document.body.textContent).toContain('EACCES: permission denied')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('starts an ordinary task from the bundled launch definition', async () => {
    serve(onboarding(), { status: 201, body: { id: 'run-9' } })
    renderSection()
    await waitFor(() => expect(card()).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /Set up this project/ }))
    await waitFor(() => expect(requests.some((r) => r.url === '/api/v1/runs')).toBe(true))
    const created = requests.find((r) => r.url === '/api/v1/runs')!
    expect(created.body).toMatchObject({ workflow: 'project-setup' })
    // No steps inline: it is a catalog workflow, which is what lets a leader dispatch the same one.
    expect(created.body).not.toHaveProperty('steps')
  })

  it('sends one create for two presses of the start control (AC-13)', async () => {
    // The visible half of design § 7.2. The rule itself is ENFORCED on the server, at the one place
    // a setup task is created — `onboarding-api.test.ts` § starting a setup task twice — so this
    // covers what the person sees, not what stops the second agent run. The whole pending window,
    // including the gap after the mutation settles, is held by `useSetupStart` and pinned in
    // `setup-start.test.tsx`; the card itself navigates away, so it cannot show that window.
    serve(onboarding(), { status: 201, body: { id: 'run-9' } })
    renderSection()
    await waitFor(() => expect(card()).not.toBeNull())
    const button = screen.getByRole('button', { name: /Set up this project/ })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(requests.some((r) => r.url === '/api/v1/runs')).toBe(true))
    // `fetch` is asynchronous, so a second create would not be recorded yet at this point: give it
    // time to arrive, or this passes against the bug it is here to catch.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(requests.filter((r) => r.url === '/api/v1/runs' && r.method === 'POST')).toHaveLength(1)
  })

  it('shows a failure to start in the server’s own words, inside the card', async () => {
    serve(onboarding(), { status: 409, body: { error: 'No agent backend is available, so the task was not created.' } })
    renderSection()
    await waitFor(() => expect(card()).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /Set up this project/ }))
    await waitFor(() =>
      expect(document.querySelector('[data-slot="project-setup-error"]')?.textContent).toContain(
        'No agent backend is available',
      ),
    )
    expect(document.querySelector('[data-slot="project-setup-error"]')?.getAttribute('role')).toBe('alert')
  })

  it('names none of xezar’s own working files or process, in any state (#466)', async () => {
    // Review round 1 finding 5. The pure copy rules are guarded in `lib/onboarding.test.ts`; this
    // covers what the section itself writes — the title, the intro, the three notes and the row
    // labels — which live in JSX and no list of exported strings can ever reach.
    const cases: Array<{ status: Partial<OnboardingStatus>; localHandoff?: boolean }> = [
      { status: {} },
      { status: { state: 'checking', checkingRunId: 'run-1', provenance: 'recorded' } },
      { status: { state: 'set-up', provenance: 'recorded', lastChecked: { ...OBSERVED, at: '2026-09-02T16:40:00.000Z' } } },
      { status: { state: 'changed', provenance: 'recorded', lastChecked: { ...OLD, at: '2026-09-02T16:40:00.000Z' }, dismissed: true } },
      { status: { state: 'unknown' } },
      { status: { available: false, unavailableReason: 'Setup unavailable — no agent backend was found.' } },
      { status: {}, localHandoff: false },
    ]
    for (const { status, localHandoff } of cases) {
      cleanup()
      serve(onboarding(status))
      renderSection({ localHandoff })
      await waitFor(() => expect(card()).not.toBeNull())
      const text = document.querySelector('[data-slot="project-setup-section"]')?.textContent ?? ''
      expect(text.length).toBeGreaterThan(0)
      for (const forbidden of [/\.xezar/, /\bkit\b/i, /\bSDLC\b/, /\bworkflow/i, /\bskill/i]) {
        expect(text).not.toMatch(forbidden)
      }
    }
  })
})
