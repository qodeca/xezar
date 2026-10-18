import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'

/**
 * Holds a page in place while it has unsaved edits, and asks before leaving.
 *
 * The cockpit mounts a declarative `BrowserRouter`, where React Router's `useBlocker` is not
 * available (it needs a data router), so this guards the two ways a reader actually leaves:
 *
 * - **a link click inside the app** (sidebar, settings nav, any `<a href>` to this origin): caught
 *   in the capture phase on `document`, before React Router's own handler, cancelled, and handed to
 *   `onAttempt` with a `proceed` callback that performs the same navigation once the reader agrees;
 * - **closing or reloading the tab**: the browser's own `beforeunload` prompt.
 *
 * Not covered, by design of the platform: the browser's Back and Forward buttons (a `popstate`
 * cannot be cancelled without a data router) and programmatic navigation such as the command
 * palette.
 * TODO: switch to `useBlocker` if the cockpit ever moves to a data router.
 *
 * Links that leave the app's own handling are never intercepted: another origin, `target` other
 * than `_self`, `download`, a modified or non-primary click (a new tab keeps this one intact), a
 * click something else already cancelled, and a link to the URL already on screen.
 *
 * @param dirty - Whether there is anything to lose. While `false` the guard does nothing at all.
 * @param onAttempt - Called instead of navigating; call `proceed()` to navigate after all.
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

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Chromium before 119 still needs `returnValue` set to show the prompt.
      event.returnValue = ''
    }

    const onClick = (event: MouseEvent) => {
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
      attemptRef.current(() => navigate(to))
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('click', onClick, true)
    }
  }, [dirty, navigate])
}
