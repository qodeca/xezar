import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agentQuotaResponseSchema, type AgentQuotaResponse } from '@qodeca/xezar-api-client'
// A test-only reach into the contract package for its committed fixture (AGENTS.md: ugly on purpose).
import fixtureJson from '../../../contract/src/__fixtures__/agent-quota.expected.json'

/**
 * How the plan-limits answer stays current (#867 FR-11, AC-33).
 *
 * Local: ONE `agent-quota` topic subscription at the root, released on unmount; readers never
 * touch the socket. Hosted: no WebSocket at all — the SSE change hint, reconnect/visibility and a
 * 15-minute interval re-read GET.
 */

const release = vi.fn()
const subscribeTopic = vi.fn((_topic: string, _listener: (data: unknown) => void) => release)
vi.mock('./ws', () => ({ subscribeTopic: (topic: string, listener: (data: unknown) => void) => subscribeTopic(topic, listener) }))

const { GlobalEventsProvider, useGlobalEvents } = await import('./global-events')
const { createUsageStore } = await import('./events')
const { createQueryClient } = await import('./query-client')
const { queryKeys, useAgentQuota, useAgentQuotaSubscription, workspaceQueryKeys } = await import('./queries')

const FIXTURE: AgentQuotaResponse = agentQuotaResponseSchema.parse(fixtureJson)

class FakeEventSource {
  static last: FakeEventSource | undefined
  readonly listeners = new Map<string, Array<(event: Event) => void>>()
  readyState = 0
  constructor(readonly url: string) {
    FakeEventSource.last = this
  }
  addEventListener(name: string, fn: (event: Event) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn])
  }
  removeEventListener(): void {}
  close(): void {
    this.readyState = 2
  }
  emit(name: string, data: string): void {
    act(() => {
      for (const fn of this.listeners.get(name) ?? []) fn(new MessageEvent(name, { data }))
    })
  }
}

const fetchMock = vi.fn<typeof fetch>()
const quotaReads = () => fetchMock.mock.calls.filter(([url]) => String(url) === '/api/v1/workspace/agent-quota').length

function clientFor(local: boolean): QueryClient {
  const qc = createQueryClient()
  qc.setDefaultOptions({ queries: { ...qc.getDefaultOptions().queries, retry: false } })
  qc.setQueryData(queryKeys.health, { bootProject: 'boot', capabilities: { localHandoff: local }, checks: [] })
  return qc
}

const wrap = (qc: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }

beforeEach(() => {
  subscribeTopic.mockClear()
  release.mockClear()
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify(FIXTURE), { status: 200, headers: { 'content-type': 'application/json' } }),
  )
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('local mode: one root subscription (AC-33)', () => {
  it('the root provider subscribes to agent-quota once, however many readers mount, and releases it', () => {
    const qc = clientFor(true)
    function Readers() {
      useAgentQuota()
      useAgentQuota()
      useAgentQuota()
      return null
    }
    const view = render(
      <QueryClientProvider client={qc}>
        <GlobalEventsProvider>
          <Readers />
        </GlobalEventsProvider>
      </QueryClientProvider>,
    )
    expect(subscribeTopic.mock.calls.filter(([topic]) => topic === 'agent-quota')).toHaveLength(1)
    view.unmount()
    expect(release).toHaveBeenCalled()
  })

  it('folds a pushed answer into the cache readers use, and drops a frame that is not an answer', () => {
    const qc = clientFor(true)
    renderHook(() => useAgentQuotaSubscription(), { wrapper: wrap(qc) })
    const listener = subscribeTopic.mock.calls[0]?.[1]
    expect(subscribeTopic.mock.calls[0]?.[0]).toBe('agent-quota')
    act(() => listener?.(FIXTURE))
    expect(qc.getQueryData(workspaceQueryKeys.agentQuota)).toEqual(FIXTURE)
    act(() => listener?.({ scope: 'something-else' }))
    expect(qc.getQueryData(workspaceQueryKeys.agentQuota)).toEqual(FIXTURE)
  })

  it('a reader alone never touches the socket', () => {
    renderHook(() => useAgentQuota(), { wrapper: wrap(clientFor(true)) })
    expect(subscribeTopic).not.toHaveBeenCalled()
  })

  it('ignores the SSE hint — the socket already pushed the whole answer', async () => {
    const qc = clientFor(true)
    const { result } = renderHook(
      () => {
        useGlobalEvents(createUsageStore())
        return useAgentQuota()
      },
      { wrapper: wrap(qc) },
    )
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true))
    const before = quotaReads()
    FakeEventSource.last?.emit('agent-quota', '{"changed":true}')
    // `invalidateQueries` marks the query and starts its refetch synchronously, so an untouched
    // state right after the hint is a deterministic "nothing was asked" — no waiting involved.
    const state = qc.getQueryState(workspaceQueryKeys.agentQuota)
    expect(state?.isInvalidated).toBe(false)
    expect(state?.fetchStatus).toBe('idle')
    expect(quotaReads()).toBe(before)
  })
})

describe('hosted mode: no WebSocket, GET on every signal (FR-11)', () => {
  it('opens no topic subscription', () => {
    renderHook(() => useAgentQuotaSubscription(), { wrapper: wrap(clientFor(false)) })
    expect(subscribeTopic).not.toHaveBeenCalled()
  })

  it('re-reads GET on the SSE agent-quota hint', async () => {
    const qc = clientFor(false)
    const { result } = renderHook(
      () => {
        useGlobalEvents(createUsageStore())
        return useAgentQuota()
      },
      { wrapper: wrap(qc) },
    )
    // Wait for the first ANSWER, not just the first request: a hint that lands while the very
    // first read is in flight is folded into that read by TanStack, which proves nothing here.
    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(quotaReads()).toBe(1)
    FakeEventSource.last?.emit('agent-quota', '{"changed":true}')
    await vi.waitFor(() => expect(quotaReads()).toBe(2))
  })

  it('re-reads GET every 15 minutes while the tab is visible', async () => {
    vi.useFakeTimers()
    renderHook(() => useAgentQuota(), { wrapper: wrap(clientFor(false)) })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(quotaReads()).toBe(1)
    await act(() => vi.advanceTimersByTimeAsync(14 * 60_000))
    expect(quotaReads()).toBe(1)
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(quotaReads()).toBe(2)
  })
})
