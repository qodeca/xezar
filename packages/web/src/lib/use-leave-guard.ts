import { useEffect, useMemo, useRef } from 'react'
import { useNavigate, type NavigateFunction, type NavigateOptions, type To } from 'react-router'

/**
 * Holds a page in place while it has unsaved edits, and asks before leaving.
 *
 * The cockpit mounts a declarative `BrowserRouter`, where React Router's `useBlocker` is not
 * available (it needs a data router), so this module guards every way a reader leaves, behind
 * ONE confirm – whatever the screen that armed the guard renders for `onAttempt`:
 *
 * - **a link click inside the app** (sidebar, settings nav, any `<a href>` to this origin): caught
 *   in the capture phase on `document`, before React Router's own handler, and cancelled;
 * - **programmatic navigation** (the ⌘K palette, the `c` / ⌘N shortcuts): callers route their
 *   `navigate` through `useGuardedNavigate` (or call `requestLeave`), which is a plain pass-through
 *   while nothing is armed;
 * - **Back and Forward**: while armed, a sentinel copy of the current history entry sits on top
 *   of the stack. Back pops the sentinel, which changes nothing on screen; the guard pushes it
 *   straight back and asks. Keep editing leaves the sentinel in place; Discard goes back past the
 *   original entry (`history.go(-2)`), which is where the reader was heading;
 * - **closing or reloading the tab**: the browser's own `beforeunload` prompt.
 *
 * One guard is active at a time (the most recently armed one); a screen with several drafts arms
 * once with their combined `dirty`.
 *
 * Disarming removes the sentinel again (a `history.back()` the guard ignores), so a saved or
 * reverted draft leaves the history exactly as it found it. A confirmed leave removes it first
 * and only then navigates, so no duplicate entry is left behind either.
 */

/** Marks the sentinel history entry. Stored beside React Router's own `usr` / `key` / `idx`. */
const SENTINEL = '__xezLeaveGuard'

interface Guard {
  attempt: (proceed: () => void) => void
}

let active: Guard | null = null
/** A `history.back()` this module issued to remove the sentinel, not yet landed. */
let removing = false
/** A confirmed leave waiting for the sentinel's removal to land before it navigates. */
let afterPop: (() => void) | null = null
let popListenerInstalled = false

const onSentinel = (): boolean => {
  const state: unknown = window.history.state
  return typeof state === 'object' && state !== null && SENTINEL in state
}

function pushSentinel(): void {
  if (onSentinel()) return
  const state: unknown = window.history.state
  const base = typeof state === 'object' && state !== null ? state : {}
  window.history.pushState({ ...base, [SENTINEL]: true }, '', window.location.href)
}

function onPopState(): void {
  if (afterPop !== null) {
    const run = afterPop
    afterPop = null
    run()
    return
  }
  if (removing) {
    removing = false
    // A guard armed again while the old sentinel was on its way out (a quick save-and-edit):
    // put its sentinel back.
    if (active !== null) pushSentinel()
    return
  }
  // No guard: our own confirmed Back (`go(-2)`, issued after releasing), or ordinary history.
  const guard = active
  if (guard === null || onSentinel()) return
  // Back (or Forward) left the sentinel: stay, then ask.
  pushSentinel()
  guard.attempt(() => {
    if (active === guard) active = null
    window.history.go(-2)
  })
}

/** Removes the sentinel once no guard wants it. Deferred one task, so a guard that disarms and
 *  re-arms in the same turn (StrictMode's effect replay) keeps the one sentinel it already has
 *  instead of popping it and pushing a new one. */
function removeSentinelSoon(): void {
  setTimeout(() => {
    if (active !== null || removing || afterPop !== null || !onSentinel()) return
    removing = true
    window.history.back()
  }, 0)
}

function installPopListener(): void {
  if (popListenerInstalled) return
  popListenerInstalled = true
  window.addEventListener('popstate', onPopState)
}

/** The leave a guard's confirm runs: drop the guard and its sentinel, then navigate. */
function confirmedLeave(guard: Guard, proceed: () => void): () => void {
  return () => {
    if (active === guard) active = null
    if (onSentinel()) {
      afterPop = proceed
      window.history.back()
    } else {
      proceed()
    }
  }
}

/**
 * Runs `proceed` now, or – while a screen holds unsaved edits – hands it to that screen's
 * confirm, which runs it only if the reader agrees to discard.
 *
 * @param proceed - The navigation (or any action that leaves the page).
 *
 * @example
 * ```ts
 * requestLeave(() => navigate('/settings/appearance'))
 * ```
 */
export function requestLeave(proceed: () => void): void {
  const guard = active
  if (guard === null) proceed()
  else guard.attempt(confirmedLeave(guard, proceed))
}

/**
 * Wraps a navigate function so every call goes through `requestLeave`.
 *
 * @param navigate - React Router's (or the project-scoped) navigate.
 * @returns A stable guarded navigate taking a target and options; it returns nothing, because a
 *   guarded navigation may never happen.
 *
 * @example
 * ```ts
 * const navigate = useGuardedNavigate(useNavigate())
 * navigate('/new')
 * ```
 */
export function useGuardedNavigate(
  navigate: NavigateFunction,
): (to: To, options?: NavigateOptions) => void {
  return useMemo(
    () => (to: To, options?: NavigateOptions) =>
      requestLeave(() => {
        void navigate(to, options)
      }),
    [navigate],
  )
}

/**
 * Arms the guard while `dirty` is true.
 *
 * @param dirty - Whether there is anything to lose. While `false` the guard does nothing at all.
 * @param onAttempt - Called instead of leaving; call `proceed()` to leave after all. Not calling
 *   it means "keep editing" – the page, and the history, stay as they are.
 *
 * @example
 * ```tsx
 * const [leave, setLeave] = useState<(() => void) | null>(null)
 * useLeaveGuard(dirty, (proceed) => setLeave(() => proceed))
 * // render a confirm whose "Discard" runs `leave()`
 * ```
 */
export function useLeaveGuard(dirty: boolean, onAttempt: (proceed: () => void) => void): void {
  const navigate = useNavigate()
  // The latest callback without re-binding the listeners on every render.
  const attemptRef = useRef(onAttempt)
  attemptRef.current = onAttempt

  useEffect(() => {
    if (!dirty) return
    const guard: Guard = { attempt: (proceed) => attemptRef.current(proceed) }
    active = guard
    installPopListener()
    pushSentinel()

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Chromium before 119 still needs `returnValue` set to show the prompt.
      event.returnValue = ''
    }

    // Links that leave the app's own handling are never intercepted: another origin, `target`
    // other than `_self`, `download`, a modified or non-primary click (a new tab keeps this one
    // intact), a click something else already cancelled, and a link to the URL on screen.
    const onClick = (event: MouseEvent) => {
      if (active !== guard) return
      if (event.defaultPrevented || event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(anchor instanceof HTMLAnchorElement)) return
      if (anchor.hasAttribute('download')) return
      const target = anchor.getAttribute('target')
      if (target !== null && target !== '' && target !== '_self') return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      const to = `${url.pathname}${url.search}${url.hash}`
      if (to === `${window.location.pathname}${window.location.search}${window.location.hash}`) return
      event.preventDefault()
      // Keep React Router's Link handler from navigating anyway.
      event.stopPropagation()
      guard.attempt(confirmedLeave(guard, () => navigate(to)))
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('click', onClick, true)
      if (active !== guard) return // a confirmed leave already released it
      active = null
      removeSentinelSoon()
    }
  }, [dirty, navigate])
}
