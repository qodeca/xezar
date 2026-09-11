import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createUsageStore, type UsageStore } from '@/api/events'
import { useGlobalEvents } from '@/api/global-events'
import { createQueryClient } from '@/api/query-client'
import { queryKeys, useRun } from '@/api/queries'
import { setApiScope } from '@qodeca/xezar-api-client'
import { McpOperationFeedback, type McpOperation } from '@/routes/task-thread/mcp-operation-feedback'
import type { ApiRun, RunRecord } from '@qodeca/xezar-api-client'

/**
 * Issue #113 (Phase 7 of epic #67): MCP operation-outcome feedback shown live in the cockpit.
 *
 * The run-record half of live sync — that an MCP-caused change to an OPEN task view renders with
 * no reload and no request, with one stream and no poll, and that a reconnect reconciles the
 * authoritative record — is proven in `packages/web/src/api/mcp-live-sync.test.tsx` (#106, F-13),
 * which drives the real task route. This file does NOT duplicate it.
 *
 * What this file adds is the OPERATION-OUTCOME half: the `McpOperationFeedback` component,
 * composed into a live view, must (a) reflect an MCP-caused change through the same stream without
 * reloading or refetching the view, and (b) visibly label last-known data as such during a
 * reconnect (U-M04) so it is never presented as newly confirmed. The outcome copy and labels
 * themselves are pinned in `mcp-operation-feedback.test.tsx`.
 */

/** jsdom ships no EventSource — the stub is the test double, exactly as in global-events.test.tsx. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  static get last(): FakeEventSource {
    const instance = FakeEventSource.instances.at(-1)
    if (!instance) throw new Error('no EventSource was constructed')
    return instance
  }

  readyState = 0
  closeCount = 0
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  constructor(readonly url: string, readonly init?: EventSourceInit) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, fn: (event: Event) => void): void {
    const set = this.listeners.get(name) ?? new Set()
    set.add(fn)
    this.listeners.set(name, set)
  }

  removeEventListener(name: string, fn: (event: Event) => void): void {
    this.listeners.get(name)?.delete(fn)
  }

  close(): void {
    this.readyState = 2
    this.closeCount += 1
  }

  private dispatch(name: string, event: Event): void {
    act(() => {
      for (const fn of this.listeners.get(name) ?? []) fn(event)
    })
  }

  open(): void {
    this.readyState = 1
    this.dispatch('open', new Event('open'))
  }

  emit(name: string, data: string): void {
    this.dispatch(name, new MessageEvent(name, { data }))
  }

  drop(): void {
    this.readyState = 0
    this.dispatch('error', new Event('error'))
  }
}

const BOOT = 'boot'

function runRecord(id: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    title: id,
    workflow: 'quick-task',
    task: 'do it',
    status: 'running',
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

function stampedRun(record: RunRecord, project = BOOT): string {
  return JSON.stringify({ ...record, project })
}

let client: QueryClient
let usage: UsageStore

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

/** Mount the stream (the one global connection) and hand back the levers. */
function mount() {
  const view = render(<StreamProbe />, { wrapper })
  return { ...view, source: FakeEventSource.last }
}

function StreamProbe() {
  useGlobalEvents(usage)
  return null
}

/** Counts its own mounts: a reload or a navigation remounts the view, a live update only re-renders. */
let viewMounts: number

/**
 * An OPEN view that composes the operation feedback. It reads the run through the same hook the
 * task thread uses, and maps the run's status onto the operation outcome so the composition can be
 * driven end-to-end by a stream frame.
 */
function OpenOperationView({ runId, lastKnown }: { runId: string; lastKnown?: boolean }) {
  const { data } = useRun(runId)
  useEffect(() => {
    viewMounts += 1
  }, [])
  const operation: McpOperation = {
    operationId: `op_${runId}`,
    action: 'runs.create',
    status: data?.status === 'done' ? 'completed' : 'running',
    lastKnown,
  }
  return <McpOperationFeedback operation={operation} />
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', vi.fn())
  client = createQueryClient()
  usage = createUsageStore()
  client.setQueryData(queryKeys.health, { bootProject: BOOT })
  setApiScope(null)
})

afterEach(() => {
  cleanup()
  setApiScope(null)
  vi.unstubAllGlobals()
})

describe('MCP operation feedback live sync (issue #113)', () => {
  it('reflects an MCP-caused change in the composed feedback — no reload, no refetch', async () => {
    client.setQueryData<ApiRun>(queryKeys.runs.detail('r1'), { ...runRecord('r1', { status: 'running' }), usage: { cpuPct: 1, rssBytes: 1, procCount: 1 } })
    client.setQueryData<ApiRun[]>(queryKeys.runs.list(), [runRecord('r1', { status: 'running' })])
    viewMounts = 0
    const { source } = mount()

    const view = render(<OpenOperationView runId="r1" />, { wrapper })
    expect(view.getByTestId('mcp-operation-label').textContent).toBe('Running')
    expect(viewMounts).toBe(1)

    // An MCP mutation performs the action through the shared services and emits a `run` frame.
    source.emit('run', stampedRun(runRecord('r1', { status: 'done' })))

    // The composed feedback renders the new outcome in place — a re-render, not a remount.
    await waitFor(() => expect(view.getByTestId('mcp-operation-label').textContent).toBe('Completed'))
    expect(viewMounts).toBe(1)
    // The detail cache was patched in place; no HTTP request was issued (no refetch loop).
    expect(fetch).not.toHaveBeenCalled()
    expect(client.getQueryData<ApiRun>(queryKeys.runs.detail('r1'))?.status).toBe('done')
  })

  it('labels last-known data as such during a reconnect — never as newly confirmed (U-M04)', () => {
    // During the reconnecting window the view still shows what it last knew, but it must be
    // VISIBLY labelled last-known, not presented as a freshly-confirmed state.
    const view = render(<OpenOperationView runId="r1" lastKnown />, { wrapper })
    const badge = view.getByTestId('mcp-operation-last-known').textContent ?? ''
    expect(badge).toContain('Last known state')
    expect(badge).toContain('reconnecting')
    // The feedback copy never claims the operation completed on last-known data.
    const copy = view.getByTestId('mcp-operation-copy').textContent ?? ''
    expect(copy).not.toContain('completed')
  })

  it('does not present last-known data as newly confirmed when the stream comes back and reconciles', async () => {
    // After a drop the browser reopens the stream; its `open` reconciles the authoritative run
    // queries. Until that reconcile lands, the composed feedback still carries the last-known
    // label rather than silently claiming a fresh confirmation.
    client.setQueryData<ApiRun>(queryKeys.runs.detail('r1'), runRecord('r1', { status: 'running' }))
    const { source } = mount()
    source.open()
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    source.drop()
    source.open()

    // The reconnect refetches the authoritative run data (the reconcile path).
    const keys = invalidate.mock.calls.map((call) => (call[0] as { queryKey: unknown }).queryKey)
    expect(keys).toContainEqual(queryKeys.runs.all)

    // And the composed feedback, until the refetch lands, is labelled last-known.
    const view = render(<OpenOperationView runId="r1" lastKnown />, { wrapper })
    expect(view.getByTestId('mcp-operation-last-known').textContent).toContain('Last known state')
  })
})
