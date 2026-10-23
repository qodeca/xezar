import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { useCallback, useMemo, useRef } from 'react'

import type { RunEvent, RunHistoryPage } from '@qodeca/xezar-api-client'
import { queryScope } from '@qodeca/xezar-api-client'
import { getRunHistory, getRunHistoryContext } from './client'
import { useRunEvents } from './run-events'

const MAX_HISTORY_PAGES = 5
const COMPACT_LIVE_AT_EVENTS = 200
const MAX_LIVE_EVENTS = 5_000

function orderedUnique(...groups: readonly RunEvent[][]): RunEvent[] {
  const bySeq = new Map<number, RunEvent>()
  for (const group of groups) {
    for (const event of group) bySeq.set(event.seq, event)
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/**
 * Folds a freshly fetched tail page into the retained history pages after live compaction.
 *
 * Compaction drops the live buffer, so every event between the newest retained page and the new
 * tail exists only in the tail. Replacing the newest page in place (the old rule) kept the OLDER
 * pages around it, and the transcript then showed them, a hole, and the tail – with "Load earlier"
 * reading the oldest page's cursor, so the hole could never be filled. The rule now is
 * contiguity, never a gap:
 *
 * - the tail reaches back to (or overlaps) the newest retained page → keep every retained page and
 *   append the tail; the overlap is de-duplicated by seq when the pages are flattened;
 * - otherwise → the tail alone. Its own `olderCursor` then drives "Load earlier", which walks back
 *   through the skipped items in order, so nothing is unreachable.
 *
 * Older pages are trimmed from the front to `MAX_HISTORY_PAGES`, which keeps the first page's
 * `olderCursor` the honest next step back.
 *
 * @param current - The infinite-query data before compaction (at least one page).
 * @param latestPage - The cursorless tail page fetched for compaction.
 * @returns The new infinite-query data, contiguous from its first page to the tail.
 *
 * @example
 * ```ts
 * queryClient.setQueryData(key, (current) => current ? compactedHistory(current, tail) : seed)
 * ```
 */
export function compactedHistory(
  current: InfiniteData<RunHistoryPage, string | undefined>,
  latestPage: RunHistoryPage,
): InfiniteData<RunHistoryPage, string | undefined> {
  const newestRetained = current.pages.reduce<RunHistoryPage | undefined>(
    (newest, page) => (newest === undefined || page.asOfSeq > newest.asOfSeq ? page : newest),
    undefined,
  )
  const tailStart = latestPage.events[0]?.seq
  // Seqs are integers, so `asOfSeq + 1` is the first event the retained pages cannot hold.
  // An empty tail, or one with nothing older, is the whole story on its own.
  const connects =
    newestRetained !== undefined &&
    tailStart !== undefined &&
    latestPage.olderCursor !== undefined &&
    tailStart <= newestRetained.asOfSeq + 1
  if (!connects) return { pages: [latestPage], pageParams: [undefined] }
  const pages = [...current.pages, latestPage]
  const pageParams = [...current.pageParams, undefined]
  while (pages.length > MAX_HISTORY_PAGES) {
    pages.shift()
    pageParams.shift()
  }
  return { pages, pageParams }
}

export interface RunHistoryState {
  visibleEvents: RunEvent[]
  currentEvents: RunEvent[]
  isPending: boolean
  contextPending: boolean
  fallback: boolean
  hasOlder: boolean
  isFetchingOlder: boolean
  olderError: string | undefined
  loadOlder: () => Promise<void>
  jumpToLatest: () => Promise<void>
  retainedPages: number
}

/**
 * Bounded transcript hydration: newest page and compact current-state context load in parallel,
 * then one cursor-resumed SSE carries live frames. Any optimized-path failure switches once to
 * the protected full-replay hook so a missing optimization never makes a session unreadable.
 */
export function useRunHistory(runId: string | undefined): RunHistoryState {
  const scope = queryScope()
  const queryClient = useQueryClient()
  const historyKey = ['run-history', scope, runId] as const
  const contextKey = ['run-history-context', scope, runId] as const

  const history = useInfiniteQuery({
    queryKey: historyKey,
    enabled: runId !== undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => getRunHistory(runId!, pageParam, { signal }),
    getPreviousPageParam: (firstPage) => firstPage.olderCursor,
    getNextPageParam: (lastPage) => lastPage.newerCursor,
    maxPages: MAX_HISTORY_PAGES,
    retry: 1,
  })
  const context = useQuery({
    queryKey: contextKey,
    enabled: runId !== undefined,
    queryFn: ({ signal }) => getRunHistoryContext(runId!, { signal }),
    retry: 1,
  })

  const fallback = history.isError || context.isError
  const fallbackEvents = useRunEvents(fallback ? runId : undefined)
  const pages = history.data?.pages ?? []
  const newestPage = pages.reduce<RunHistoryPage | undefined>(
    (latest, page) =>
      page.newerCursor === undefined
        ? page
        : latest ?? page,
    undefined,
  )
  const compactingLive = useRef(false)
  const compactLive = useCallback(() => {
    if (runId === undefined || compactingLive.current) return
    compactingLive.current = true
    void getRunHistory(runId, undefined)
      .then((latestPage) => {
        queryClient.setQueryData<InfiniteData<RunHistoryPage, string | undefined>>(
          ['run-history', scope, runId],
          (current) => {
            if (!current) return { pages: [latestPage], pageParams: [undefined] }
            return compactedHistory(current, latestPage)
          },
        )
      })
      // Compaction is an optimization, not a load: this call is fire-and-forget (`void`), so a
      // rejection here has no query to reject and would surface as an unhandled rejection. The
      // live buffer still holds every event, and the next `onCompact` retries — so swallowing is
      // the graceful outcome. Reachable via a transport error, and now also via a malformed page
      // body, which the client validates rather than casts (#827).
      .catch(() => {})
      .finally(() => {
        compactingLive.current = false
      })
  }, [queryClient, runId, scope])
  const liveEvents = useRunEvents(!fallback && newestPage ? runId : undefined, {
    cursor: newestPage?.liveCursor,
    afterSeq: newestPage?.asOfSeq,
    maxEvents: MAX_LIVE_EVENTS,
    compactAt: COMPACT_LIVE_AT_EVENTS,
    onCompact: compactLive,
  })

  const pagedEvents = useMemo(
    () => orderedUnique(...pages.map((page) => page.events as RunEvent[])),
    [pages],
  )
  const visibleEvents = useMemo(
    () => fallback ? fallbackEvents : orderedUnique(pagedEvents, liveEvents),
    [fallback, fallbackEvents, pagedEvents, liveEvents],
  )
  const currentEvents = useMemo(() => {
    if (fallback) return fallbackEvents
    const contextEvents = (context.data?.contextEvents ?? []) as RunEvent[]
    const contextHighWater = context.data?.asOfSeq ?? 0
    return orderedUnique(contextEvents, visibleEvents.filter(({ seq }) => seq > contextHighWater))
  }, [context.data, fallback, fallbackEvents, visibleEvents])

  const loadOlder = useCallback(async () => {
    await history.fetchPreviousPage()
  }, [history.fetchPreviousPage])

  const jumpToLatest = useCallback(async () => {
    await queryClient.resetQueries({ queryKey: historyKey, exact: true })
  }, [historyKey, queryClient])

  return {
    visibleEvents,
    currentEvents,
    isPending: !fallback && history.isPending,
    contextPending: !fallback && context.isPending,
    fallback,
    hasOlder: !fallback && Boolean(history.hasPreviousPage),
    isFetchingOlder: history.isFetchingPreviousPage,
    olderError: history.isFetchPreviousPageError
      ? history.error instanceof Error ? history.error.message : 'Could not load earlier items'
      : undefined,
    loadOlder,
    jumpToLatest,
    retainedPages: pages.length,
  }
}
