import { useEffect, useState } from 'react'

/** The md-and-up breakpoint — the ONE place the cockpit's JavaScript asks for it. */
const DESKTOP_QUERY = '(min-width: 768px)'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** md-and-up, right now (no subscription) — for a one-off default such as the plan dock's first
 *  open state. jsdom (no matchMedia) counts as desktop. */
export function isDesktopNow(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia(DESKTOP_QUERY).matches
}

/** True when the OS asks for reduced motion, right now (no subscription). False where
 *  `matchMedia` is missing (old jsdom, SSR), so motion stays the default there. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  )
}

/**
 * md-and-up, live: the "phones force unified+wrap" rule (spec §"Session git view — Changes &
 * Files tabs (#390)") must follow a rotation/resize, not the first render. jsdom (no
 * matchMedia) counts as desktop, same convention as `isDesktopNow`.
 *
 * Shared by the task Changes tab and the repo view (R5 1.7) — one seam, one rule.
 */
export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(isDesktopNow)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(DESKTOP_QUERY)
    const onChange = (event: MediaQueryListEvent) => setDesktop(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return desktop
}
