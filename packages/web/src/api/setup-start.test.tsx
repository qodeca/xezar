import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, useSetupStart } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { OnboardingStatus } from '@qodeca/xezar-api-client'

/**
 * `useSetupStart` — "two clicks cannot start two checks", the half a person SEES (#464 P2, `AC-13`,
 * design § 7.2; QA `8d6a08ca`, QA-1).
 *
 * The rule is enforced on the server, at the one place a setup task is created, and that is what
 * stops a second agent run. This hook is why the control does not LIE in the meantime. QA measured
 * the shipped gap: the create settles in about 30 ms, the status read that replaces the control
 * lands about 500 ms later, and in between `isPending` is false — so the button read `Re-check`,
 * enabled, at 50 ms, 120 ms and 250 ms after a press, and a second press at any of those moments
 * started a second task.
 *
 * The fixture reproduces that shape exactly: the create answers at once, and the status read after
 * it never lands. Every assertion below is about that window.
 */
const STATUS: OnboardingStatus = {
  state: 'changed',
  provenance: 'recorded',
  available: true,
  unavailableReason: null,
  localHandoff: true,
  offerPending: true,
  dismissed: false,
  observed: { engineVersion: '0.15.0', kitDigest: '2c20c60' },
  lastOffered: null,
  lastChecked: { engineVersion: '0.14.0', kitDigest: '2c20c60', at: '2026-09-02T16:40:00.000Z' },
  checkingRunId: null,
  launch: { workflowId: 'project-setup', modes: ['setup', 'preview', 'recheck'] },
  issueFiling: { status: 'available', reason: null, skill: 'xez-issue-create' },
}

let creates: number

/**
 * @param reads how many onboarding reads answer before the rest hang. `1` is the measured gap: the
 *   first render's read lands, the one the create invalidates does not (yet).
 */
function serve(options: { reads: number; createStatus?: number; after?: OnboardingStatus }) {
  creates = 0
  let served = 0
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/api/v1/onboarding' && method === 'GET') {
        served += 1
        if (served > options.reads) return new Promise<never>(() => {})
        return json(served === 1 ? STATUS : (options.after ?? STATUS))
      }
      if (url === '/api/v1/runs' && method === 'POST') {
        creates += 1
        const status = options.createStatus ?? 201
        return status === 201
          ? json({ id: `run-${creates}` }, 201)
          : json({ error: 'No agent backend is available, so the task was not created.' }, status)
      }
      return new Promise<never>(() => {})
    }),
  )
}

/** Mounted, with the first status read already landed — the state a person presses in. */
async function harness() {
  const client = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const rendered = renderHook(() => useSetupStart(), { wrapper })
  await waitFor(() => expect(client.getQueryData(queryKeys.onboarding)).toBeDefined())
  return rendered
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useSetupStart', () => {
  it('stays pending after the create settles, until the next status read lands', async () => {
    serve({ reads: 1 })
    const { result } = await harness()
    expect(result.current.pending).toBe(false)

    act(() => result.current.mutate('recheck'))
    await waitFor(() => expect(creates).toBe(1))
    // The create has answered. This is the exact moment the shipped control became live again.
    expect(result.current.pending).toBe(true)

    // And it is still pending well past the whole window QA sampled.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(result.current.pending).toBe(true)
  })

  it('sends one create for two presses 200 ms apart', async () => {
    serve({ reads: 1 })
    const { result } = await harness()
    act(() => result.current.mutate('recheck'))
    await waitFor(() => expect(creates).toBe(1))

    await new Promise((resolve) => setTimeout(resolve, 200))
    act(() => result.current.mutate('recheck'))
    // Long enough for a second create to have reached the fake server if one had been sent — the
    // assertion right after `mutate` would pass against the bug, because `fetch` is asynchronous.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(creates).toBe(1)
  })

  it('releases when the status read lands, whatever it says', async () => {
    // Deliberately NOT `checking`: a check that finished before the read, or a record that could
    // not be written, must release the control too. Holding until one particular answer arrives is
    // how a pending state becomes permanent.
    // Keep both observations inside one millisecond: a timestamp comparison must not mistake an
    // answered read for the old one and leave the control pending forever.
    vi.spyOn(Date, 'now').mockReturnValue(1_789_549_400_000)
    serve({ reads: 2, after: { ...STATUS, state: 'set-up', offerPending: false } })
    const { result } = await harness()
    act(() => result.current.mutate('recheck'))
    await waitFor(() => expect(creates).toBe(1))
    await waitFor(() => expect(result.current.pending).toBe(false))
  })

  it('releases at once when the create fails, and reports the server’s own words', async () => {
    serve({ reads: 1, createStatus: 409 })
    const { result } = await harness()
    let message = ''
    act(() => result.current.mutate('recheck', { onError: (error) => { message = error.message } }))
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(message).toContain('No agent backend is available')
    // Released, so the person can act on what they were just told.
    act(() => result.current.mutate('recheck'))
    await waitFor(() => expect(creates).toBe(2))
  })
})
