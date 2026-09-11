import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TaskThreadRoute } from '@/routes/task-thread/task-thread'
import type { ApiRun } from '@qodeca/xezar-api-client'

import { GlobalEventsProvider } from './global-events'
import { queryKeys } from './queries'
import { createQueryClient } from './query-client'

/**
 * #106, F-13: a change the leader makes through MCP shows up in the OPEN task view without a
 * reload — over the cockpit's one existing stream, with no new transport and no poll.
 *
 * The server half is proven in `packages/xezar/src/mcp/echo-guard.test.ts`: an MCP patch through
 * the real service adapter arrives on the real `/api/v1/workspace/events` as a `run` frame, the
 * store's record plus a `project` stamp. This half takes that frame, exactly as the server sends it,
 * and drives the real app shell: `GlobalEventsProvider` (the ONE global stream, mounted once at the
 * root) around the real `/tasks/:id` route.
 *
 * The fetch stub counts every request. "No reload" is asserted as "no request at all": the frame
 * alone must change what the reader sees.
 */

/** jsdom has no EventSource. Only what the hook touches, plus the levers a test needs. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  readyState = 0
  closeCount = 0
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  constructor(readonly url: string) {
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
}

const WORKSPACE_STREAM = '/api/v1/workspace/events'
const PROJECT = 'proj-a'

const workspaceStreams = (): FakeEventSource[] =>
  FakeEventSource.instances.filter((source) => source.url === WORKSPACE_STREAM)

function record(over: Partial<ApiRun> = {}): ApiRun {
  return {
    id: 'r1',
    title: 'first title',
    titleSummary: 'first title',
    workflow: 'quick-task',
    task: 'ship the thing',
    status: 'running',
    createdAt: '2026-09-11T00:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

/** A `run` frame as `/api/v1/workspace/events` writes it: `{ ...run, project }`. */
const frame = (run: ApiRun, project = PROJECT): string => JSON.stringify({ ...run, project })

let client: QueryClient
/** What `GET /api/v1/runs/r1` answers right now — the server's authoritative record. */
let serverRecord: ApiRun
let requests: string[]

function stubServer(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      requests.push(path)
      const body =
        path === '/api/v1/runs/r1' ? serverRecord
        : path === '/api/v1/runs/r1/history' ? { events: [], itemCount: 0, liveCursor: 'live-0', asOfSeq: 0, hasOlder: false }
        : path === '/api/v1/runs/r1/history-context' ? { contextEvents: [], asOfSeq: 0 }
        : path === '/api/v1/health' ? { bootProject: PROJECT }
        : path === '/api/v1/providers/status' ? { providers: [] }
        : []
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    }),
  )
}

/** The real shell, as the app mounts it: the provider once at the root, the task route inside. */
function openTaskView() {
  return render(
    <QueryClientProvider client={client}>
      <GlobalEventsProvider>
        <MemoryRouter initialEntries={['/tasks/r1']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskThreadRoute />} />
          </Routes>
        </MemoryRouter>
      </GlobalEventsProvider>
    </QueryClientProvider>,
  )
}

const heading = (): string => screen.getByRole('heading', { level: 1 }).textContent ?? ''

/** Every `GET /api/v1/runs/r1` so far — the request a reload of the record would make. */
const recordFetches = (): number => requests.filter((path) => path === '/api/v1/runs/r1').length

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  requests = []
  serverRecord = record()
  stubServer()
  client = createQueryClient()
  // What the first health answer establishes: this unscoped cockpit IS proj-a.
  client.setQueryData(queryKeys.health, { bootProject: PROJECT })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('an MCP-caused change reaches the open task view', () => {
  it('shows the leader’s rename from the stream frame alone — no reload, no request', async () => {
    openTaskView()
    await waitFor(() => expect(heading()).toBe('first title'))
    const stream = workspaceStreams()[0]!
    stream.open()
    const before = requests.length

    // What the server wrote for the MCP patch (echo-guard.test.ts proves this frame arrives).
    serverRecord = record({ title: 'renamed by the leader', titleSummary: 'renamed by the leader' })
    stream.emit('run', frame(serverRecord))

    // TanStack Query batches observer notifications onto the next tick, hence waitFor.
    await waitFor(() => expect(heading()).toBe('renamed by the leader'))
    // Nothing was fetched to get there: the cache was patched in place.
    expect(requests.slice(before)).toEqual([])
  })

  it('a status change the leader caused (cancel) shows at once, too', async () => {
    openTaskView()
    await waitFor(() => expect(heading()).toBe('first title'))
    const stream = workspaceStreams()[0]!
    stream.open()
    const before = recordFetches()

    stream.emit('run', frame(record({ status: 'cancelled', finishedAt: '2026-09-11T00:01:00.000Z' })))

    await waitFor(() => expect(client.getQueryData<ApiRun>(queryKeys.runs.detail('r1'))?.status).toBe('cancelled'))
    expect(recordFetches()).toBe(before)
  })

  it("does not let another project's frame for the same run id touch this view (N-01)", async () => {
    openTaskView()
    await waitFor(() => expect(heading()).toBe('first title'))
    const stream = workspaceStreams()[0]!
    stream.open()

    stream.emit('run', frame(record({ title: 'from another project', titleSummary: 'from another project' }), 'proj-b'))
    // Past the tick a patched cache would have rendered on (see the first test).
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(client.getQueryData<ApiRun>(queryKeys.runs.detail('r1'))?.title).toBe('first title')
    expect(heading()).toBe('first title')
  })
})

describe('one connection, no poll, and reconcile on reconnect', () => {
  it('opens exactly ONE workspace stream for the whole shell and closes it on unmount', async () => {
    const view = openTaskView()
    await waitFor(() => expect(heading()).toBe('first title'))
    expect(workspaceStreams()).toHaveLength(1)

    view.unmount()

    expect(workspaceStreams()[0]!.closeCount).toBe(1)
  })

  it('the open task record has no polling interval — the stream is what keeps it live', async () => {
    openTaskView()
    await waitFor(() => expect(heading()).toBe('first title'))
    const query = client.getQueryCache().find({ queryKey: queryKeys.runs.detail('r1') })
    expect(query).toBeDefined()
    // Every observer of the record: none of them may carry a refetchInterval.
    for (const observer of query!.observers) expect(observer.options.refetchInterval ?? false).toBe(false)
  })

  it('a reconnect reconciles: a change made while the stream was down appears from the authoritative read', async () => {
    openTaskView()
    await waitFor(() => expect(heading()).toBe('first title'))
    const stream = workspaceStreams()[0]!
    stream.open()
    const before = recordFetches()

    // The leader renamed it while this cockpit was disconnected: no frame ever arrived for it.
    serverRecord = record({ title: 'changed while disconnected', titleSummary: 'changed while disconnected' })
    stream.open()

    await waitFor(() => expect(heading()).toBe('changed while disconnected'))
    expect(recordFetches()).toBe(before + 1)
  })
})
