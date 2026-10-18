import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { setApiScope } from '@qodeca/xezar-api-client'
import type {
  RunIndexEntry,
  RunRecord,
  RunsIndexResponse,
  RunStatus,
  WorkspaceUiState,
} from '@qodeca/xezar-api-client'
import { RunNotifications } from './run-notifications'

/**
 * The notification trigger's wiring (R6 Step 1.7): cache observation → Notification.
 *
 * UNIT-PINNED ON PURPOSE: the `Notification` constructor is stubbed. Headless Chromium has the
 * API but never displays anything and Playwright cannot observe a constructed notification, so
 * an e2e assertion would be a stub test with extra steps — the honest pin is here, against the
 * real cache-subscription path (`setQueryData` is exactly what the SSE layer calls).
 *
 * The watched cache is the cross-project runs index (the workspace attention model's source):
 * the SSE layer patches it for EVERY project's run events, so a run waiting in a project other
 * than the one on screen notifies too.
 */

let clients: QueryClient[] = []

/** The toggle lives in the GLOBAL ui-state since step 3.5 — seed the workspace key, which is
 *  the only one `RunNotifications` reads. */
function makeClient(uiState: WorkspaceUiState): QueryClient {
  const client = createQueryClient()
  client.setQueryData(workspaceQueryKeys.uiState, uiState)
  clients.push(client)
  return client
}

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    title: 'Normalize the agent-event protocol',
    workflow: 'default',
    task: 'normalize the protocol',
    status: 'running',
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

/** A Notification stand-in: records constructions, throws never. */
function stubNotification(permission: NotificationPermission = 'granted') {
  const constructed: Array<{ title: string; options?: NotificationOptions }> = []
  function FakeNotification(this: unknown, title: string, options?: NotificationOptions) {
    constructed.push({ title, options })
  }
  ;(FakeNotification as unknown as { permission: string }).permission = permission
  vi.stubGlobal('Notification', FakeNotification)
  return constructed
}

/** Same override pattern as global-events.test.tsx; the own property is removed in afterEach. */
function hideTab(hidden = true) {
  Object.defineProperty(document, 'visibilityState', {
    value: hidden ? 'hidden' : 'visible',
    configurable: true,
  })
}

/** A runs-index row for a record — the slim shape `GET /workspace/runs-index` sends. */
function row(record: RunRecord, projectId = 'boot'): RunIndexEntry {
  return {
    projectId,
    id: record.id,
    title: record.title,
    ...(record.titleSummary !== undefined ? { titleSummary: record.titleSummary } : {}),
    status: record.status,
    ...(record.autoResumeAt !== undefined ? { autoResumeAt: record.autoResumeAt } : {}),
    createdAt: record.createdAt,
    archived: record.archived,
    workflow: record.workflow,
    runner: 'claude',
  }
}

/** Records (defaulting to the boot project) or ready rows → a complete index answer. */
function indexOf(rows: Array<RunRecord | RunIndexEntry>): RunsIndexResponse {
  return {
    runs: rows.map((r) => ('projectId' in r ? r : row(r))),
    referenceStatuses: {},
    perProjectLimit: 200,
    truncated: [],
  }
}

/** Mount the trigger, seed the index, then apply the same patch the SSE layer would. */
function mount(uiState: WorkspaceUiState, seed: Array<RunRecord | RunIndexEntry>) {
  // Queries would otherwise fire real fetches for ui-state/runs — keep them honestly pending.
  vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
  const client = makeClient(uiState)
  client.setQueryData(workspaceQueryKeys.runsIndex, indexOf(seed))
  render(
    <QueryClientProvider client={client}>
      <RunNotifications />
    </QueryClientProvider>,
  )
  const patch = (rows: Array<RunRecord | RunIndexEntry>) =>
    act(() => client.setQueryData(workspaceQueryKeys.runsIndex, indexOf(rows)))
  return { client, patch }
}

afterEach(() => {
  cleanup()
  for (const client of clients) client.clear()
  clients = []
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // Drop the visibility override so the next test starts from happy-dom's own 'visible'.
  delete (document as unknown as Record<string, unknown>).visibilityState
  setApiScope(null)
})

describe('RunNotifications', () => {
  it('notifies when a run enters waiting while the tab is hidden', () => {
    const constructed = stubNotification('granted')
    hideTab()
    const { patch } = mount({ notifications: { enabled: true } }, [run({ status: 'running' })])

    patch([run({ status: 'waiting' })])

    expect(constructed).toEqual([
      {
        title: 'Normalize the agent-event protocol',
        options: { body: 'Task needs you', tag: 'xezar-run-r1' },
      },
    ])
  })

  it('review and failed transitions notify too — one per run, tagged for replacement', () => {
    const constructed = stubNotification('granted')
    hideTab()
    const { patch } = mount({ notifications: { enabled: true } }, [
      run({ id: 'a', status: 'running' }),
      run({ id: 'b', status: 'running' }),
    ])

    patch([run({ id: 'a', status: 'review' }), run({ id: 'b', status: 'failed' })])

    expect(constructed.map((n) => [n.options?.tag, n.options?.body])).toEqual([
      ['xezar-run-a', 'Task needs review'],
      ['xezar-run-b', 'Task failed'],
    ])
  })

  it('the seeded list never notifies — a run already waiting at mount is the dot’s job', () => {
    const constructed = stubNotification('granted')
    hideTab()
    mount({ notifications: { enabled: true } }, [run({ status: 'waiting' })])
    expect(constructed).toEqual([])
  })

  it('the toggle gates: disabled (and the default OFF) stays silent', () => {
    const constructed = stubNotification('granted')
    hideTab()
    for (const uiState of [{}, { notifications: { enabled: false } }] as WorkspaceUiState[]) {
      const { patch } = mount(uiState, [run({ status: 'running' })])
      patch([run({ status: 'waiting' })])
    }
    expect(constructed).toEqual([])
  })

  it('a visible tab stays silent', () => {
    const constructed = stubNotification('granted')
    hideTab(false)
    const { patch } = mount({ notifications: { enabled: true } }, [run({ status: 'running' })])
    patch([run({ status: 'waiting' })])
    expect(constructed).toEqual([])
  })

  it('permission denied degrades to silence — no construction, no throw', () => {
    const constructed = stubNotification('denied')
    hideTab()
    const { patch } = mount({ notifications: { enabled: true } }, [run({ status: 'running' })])
    patch([run({ status: 'waiting' })])
    expect(constructed).toEqual([])
  })

  it('no Notification API at all degrades to silence', () => {
    vi.stubGlobal('Notification', undefined)
    hideTab()
    const { patch } = mount({ notifications: { enabled: true } }, [run({ status: 'running' })])
    expect(() => patch([run({ status: 'waiting' })])).not.toThrow()
  })

  it('a constructor that throws (Android Chrome) is swallowed — the courtesy never crashes the app', () => {
    hideTab()
    const Throwing = vi.fn(() => {
      throw new Error('Use ServiceWorkerRegistration.showNotification() instead.')
    })
    ;(Throwing as unknown as { permission: string }).permission = 'granted'
    vi.stubGlobal('Notification', Throwing)
    const { patch } = mount({ notifications: { enabled: true } }, [run({ status: 'running' })])
    expect(() => patch([run({ status: 'waiting' })])).not.toThrow()
    expect(Throwing).toHaveBeenCalledOnce()
  })

  it('statuses are tracked while disabled, so enabling later never replays old transitions', async () => {
    const constructed = stubNotification('granted')
    hideTab()
    const { client, patch } = mount({ notifications: { enabled: false } }, [
      run({ status: 'running' }),
    ])

    // The transition happens with the toggle off…
    patch([run({ status: 'waiting' })])
    expect(constructed).toEqual([])

    // …then the user enables (Settings PUT lands in the same cache). The macrotask flush lets
    // the query observer's deferred notification re-render the component with the new flag.
    act(() => client.setQueryData(workspaceQueryKeys.uiState, { notifications: { enabled: true } }))
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))

    // A token tick re-announces the unchanged waiting state — still no notification, because
    // the transition was observed (and remembered) while the toggle was off.
    patch([run({ status: 'waiting', tokensUsed: 42 })])
    expect(constructed).toEqual([])

    // A REAL new transition after enabling does notify.
    patch([run({ status: 'running', tokensUsed: 50 })])
    patch([run({ status: 'review', tokensUsed: 51 })])
    expect(constructed.map((n) => n.options?.body)).toEqual(['Task needs review'])
  })

  it('ignores unrelated cache updates (a detail or list query moving is not the index)', () => {
    const constructed = stubNotification('granted')
    hideTab()
    const { client } = mount({ notifications: { enabled: true } }, [run({ status: 'running' })])
    act(() => client.setQueryData(queryKeys.runs.detail('r1'), run({ status: 'waiting' })))
    act(() => client.setQueryData(queryKeys.runs.list(), [run({ status: 'waiting' })]))
    expect(constructed).toEqual([])
  })

  it('notifies for a task waiting in ANOTHER project, not only the one the tab opened in', () => {
    // The bug: the trigger watched the active project's run list under a key computed once at
    // mount, so a task in any other registered project could wait for hours without a ding.
    const constructed = stubNotification('granted')
    hideTab()
    const theirs = run({ id: 'x1', title: 'Draft the campaign brief', status: 'running' })
    const { patch } = mount({ notifications: { enabled: true } }, [row(theirs, 'agency')])

    patch([row({ ...theirs, status: 'waiting' }, 'agency')])

    expect(constructed.map((n) => [n.title, n.options?.body])).toEqual([
      ['Draft the campaign brief', 'Task needs you'],
    ])
  })

  it('keeps notifying after the user switches to another project', () => {
    const constructed = stubNotification('granted')
    hideTab()
    const { patch } = mount({ notifications: { enabled: true } }, [run({ status: 'running' })])

    act(() => setApiScope('agency'))
    patch([run({ status: 'waiting' })])

    expect(constructed).toHaveLength(1)
  })

  it('tracks the same run id in two projects separately', () => {
    const constructed = stubNotification('granted')
    hideTab()
    const mine = run({ id: 'same', status: 'running' })
    const { patch } = mount({ notifications: { enabled: true } }, [row(mine, 'a'), row(mine, 'b')])

    patch([row(mine, 'a'), row({ ...mine, status: 'waiting' }, 'b')])

    expect(constructed).toHaveLength(1)
  })

  it('an index reset to no data forgets nothing', () => {
    const constructed = stubNotification('granted')
    hideTab()
    const { client, patch } = mount({ notifications: { enabled: true } }, [run({ status: 'running' })])

    // A reset publishes an `updated` event with no data. An observation of "nothing" must not
    // wipe the memory, or the next answer would be first sight and the real transition would go
    // unannounced.
    act(() => void client.resetQueries({ queryKey: workspaceQueryKeys.runsIndex }))
    expect(client.getQueryData(workspaceQueryKeys.runsIndex)).toBeUndefined()
    patch([run({ status: 'waiting' })])

    expect(constructed).toHaveLength(1)
  })
})

// Type-level guard: the statuses this suite drives are real RunStatus members.
const _statuses: RunStatus[] = ['running', 'waiting', 'review', 'failed']
void _statuses
