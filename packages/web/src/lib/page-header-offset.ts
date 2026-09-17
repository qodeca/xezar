import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * The page-header offset adapter (#453 B6, design review NB-1).
 *
 * A diff parks its sticky file header under the page header with `--diff-sticky-top`. That offset
 * was a hand-typed `10rem` while the run header's own height moves with the density lever —
 * 236 / 197 / 179 / 163 px at Roomy / Comfortable / Compact / Compact for real — so at Roomy and
 * Comfortable the header covered the file name and its collapse toggle. A bigger fixed number only
 * moves which density is wrong; OD-1 (#447) asks for one drawing at four sizes, so the offset has
 * to be MEASURED.
 *
 * The mechanism is the `--kb` pattern `lib/keyboard-inset.ts` already uses: watch the header
 * element, publish its height as `--page-header-h` on `:root`, and let a page spell
 * `[--diff-sticky-top:var(--page-header-h,10rem)]`. The fallback is the old constant, so a browser
 * without `ResizeObserver` degrades to exactly today's behavior rather than to zero.
 *
 * A header that is not stuck to the top of the viewport holds nothing there and publishes 0: the
 * run header drops `md:sticky` on a phone so the transcript owns the small viewport, and a file
 * header parked 160 px down from a viewport with nothing above it is just lost space.
 *
 * The geometry is a pure function over structural stubs, so tests read it without a real browser.
 */

/** The subset of an element the math reads — stubbable. */
export interface HeaderElement {
  getBoundingClientRect(): { height: number }
}

/**
 * How many px of the viewport's top edge this header holds right now. `position` is the header's
 * COMPUTED position: only a header that stays put (`sticky` or `fixed`) covers what scrolls under
 * it. Rounded up, so a fractional header height never leaves a hairline of the file name covered.
 */
export function pageHeaderOffset(el: HeaderElement | null, position: string): number {
  if (!el) return 0
  if (position !== 'sticky' && position !== 'fixed') return 0
  return Math.max(0, Math.ceil(el.getBoundingClientRect().height))
}

/**
 * Watch a header and publish its offset. Re-measures on a viewport resize (the `md` breakpoint
 * decides whether the header is sticky at all) and on every size change of the element itself
 * (the density lever, an expanded meta row, a wrapped title). Returns the cleanup; it publishes 0
 * so a stale offset never outlives the header.
 */
export function watchPageHeaderOffset(el: HTMLElement | null, apply: (px: number) => void): () => void {
  if (!el) {
    apply(0)
    return () => {}
  }
  const measure = () => apply(pageHeaderOffset(el, getComputedStyle(el).position))
  measure()
  window.addEventListener('resize', measure)
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
  observer?.observe(el)
  return () => {
    window.removeEventListener('resize', measure)
    observer?.disconnect()
    apply(0)
  }
}

/**
 * The React binding: keeps `--page-header-h` on `:root` while the header is mounted. Returns the
 * ref to put on the header element. `useLayoutEffect` so the first measurement lands before paint —
 * a frame at the wrong offset would jump a sticky file header visibly.
 */
export function usePageHeaderOffsetVar<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T | null>(null)
  useLayoutEffect(() => {
    const root = document.documentElement
    return watchPageHeaderOffset(ref.current, (px) => root.style.setProperty('--page-header-h', `${px}px`))
  }, [])
  return ref
}
