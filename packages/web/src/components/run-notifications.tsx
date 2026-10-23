import { hashKey, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { useProjects, useWorkspaceAttention, useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import type { RunIndexEntry, RunsIndexResponse, RunStatus } from '@qodeca/xezar-api-client'
import {
  diffRunTransitions,
  normalizeNotifications,
  notificationSupport,
  shouldNotify,
  describeRunNotification,
  type NotifiableRun,
} from '@/lib/notifications'
import { attentionKey } from '@/lib/workspace-attention'

/**
 * The notification trigger (R6 Step 1.7, spec §"Cross-cutting"): browser `Notification` when a
 * run ENTERS `waiting`/`review`/failed while the tab is hidden.
 *
 * It watches the workspace attention model's source — the cross-project runs index — rather than
 * opening its own listener on the event stream: the global stream (api/global-events.tsx) folds
 * EVERY project's `run` event into that index and schedules its refetch, and the
 * reconnect/visibility reconciliation refetches it — so one cache subscription sees BOTH
 * deliveries of the same truth, for every registered project, not only the one the tab opened
 * in. (It used to watch the active project's run list under a key computed once at mount, so a
 * waiting task in any other project never notified.) That second path is not a bonus,
 * it is the point: a hidden tab is exactly when the stream is most likely to have been frozen
 * (mobile background freeze, laptop lid), and the run that flipped to `waiting` while the socket
 * was dead arrives via the reconciling refetch, not via an event.
 *
 * Statuses are tracked UNCONDITIONALLY — before the enabled/hidden/permission gate — so flipping
 * the toggle on later, or refocusing the tab, never replays transitions that already happened:
 * the gate decides whether a transition becomes a notification, never whether it was observed.
 *
 * Renders nothing. Mounted once in app.tsx, beside the providers, for the app's whole life.
 */
export function RunNotifications() {
  const queryClient = useQueryClient()
  // The toggle, straight from the GLOBAL ui-state (step 3.5 moved the section there — the
  // notifying browser is one browser whichever project is open). Read through the same query
  // AppearanceProvider keeps warm — no extra fetch, and a PUT from Settings updates this cache
  // entry, so the gate flips without any coupling between the two components.
  const uiState = useWorkspaceUiState()
  const enabled = normalizeNotifications(uiState.data?.notifications).enabled

  // A ref, not an effect dependency: re-running the effect on toggle flips would rebuild the
  // cache subscription and lose the status map — the whole "never replay" guarantee.
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const statusesRef = useRef<ReadonlyMap<string, RunStatus>>(new Map())
  // Keeps the index observed for the whole session, so the stream's debounced invalidation
  // refetches it even when no sidebar is mounted (single-project layout, phone without drawer).
  useWorkspaceAttention()
  // Project id → display name, for the body. A ref for the same reason as `enabledRef`: a
  // registry refetch must not rebuild the cache subscription and lose the status memory.
  const projects = useProjects().data?.projects
  const namesRef = useRef<ReadonlyMap<string, string>>(new Map())
  namesRef.current = new Map((projects ?? []).map((project) => [project.id, project.name]))

  useEffect(() => {
    // A workspace key, not a scope-led one: it names the same entry whichever project is open.
    const indexHash = hashKey(workspaceQueryKeys.runsIndex)

    const observe = (runs: readonly RunIndexEntry[] | undefined): void => {
      const { entering, statuses } = diffRunTransitions(statusesRef.current, runs, attentionKey)
      statusesRef.current = statuses
      if (entering.length === 0) return
      const gate = {
        enabled: enabledRef.current,
        hidden: document.visibilityState === 'hidden',
        permission: notificationSupport(),
      }
      if (!shouldNotify(gate)) return
      for (const run of entering) {
        // The id when the registry has not answered: still names the project, never a blank.
        fireRunNotification(run, namesRef.current.get(run.projectId) ?? run.projectId)
      }
    }

    // Seed from whatever the cache already holds: with an empty previous map nothing can
    // "enter", so a mount mid-session records the current statuses and stays silent.
    observe(queryClient.getQueryData<RunsIndexResponse>(workspaceQueryKeys.runsIndex)?.runs)

    return queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryHash !== indexHash || event.type !== 'updated') return
      // A failed refetch keeps the last good data and is not an observation; neither is an
      // index that has not answered yet. Observing `undefined` would forget every status and
      // turn the next answer into "first sight" — silence for transitions that really happened.
      const data = event.query.state.data as RunsIndexResponse | undefined
      if (!data) return
      observe(data.runs)
    })
  }, [queryClient])

  return null
}

/** The impure sliver: construct the `Notification`. Guarded and try/caught because both failure
 *  modes are real — no constructor at all (tests, old WebViews), and a constructor that THROWS
 *  on page-context construction (Chrome on Android insists on a ServiceWorker). A notification
 *  is a courtesy; it must never take the message loop down with it. */
function fireRunNotification(run: NotifiableRun, projectName: string): void {
  const N = globalThis.Notification
  if (typeof N !== 'function') return
  const content = describeRunNotification(run, projectName)
  try {
    new N(content.title, { body: content.body, tag: content.tag })
  } catch {
    // Degrade silently — the status dot on the Tasks page still tells the truth.
  }
}
