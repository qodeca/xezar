import { afterEach, describe, expect, it, vi } from 'vitest'

import { pageHeaderOffset, watchPageHeaderOffset } from './page-header-offset'

/**
 * The page-header offset (#453 B6, NB-1). jsdom lays nothing out, so the geometry is checked
 * through the pure function's structural stub and the watcher is driven by a fake
 * `ResizeObserver` — the real-layout proof (the sticky file header clears the run header at all
 * four densities) is `e2e/design-debt-b6.e2e.ts`.
 */

const box = (height: number) => ({ getBoundingClientRect: () => ({ height }) })

describe('pageHeaderOffset', () => {
  it('is the header’s own height while it stays at the top of the viewport', () => {
    expect(pageHeaderOffset(box(236), 'sticky')).toBe(236)
    expect(pageHeaderOffset(box(163), 'fixed')).toBe(163)
  })

  it('rounds a fractional height UP, so no hairline of the file name stays covered', () => {
    expect(pageHeaderOffset(box(196.4), 'sticky')).toBe(197)
  })

  it('is zero for a header that scrolls away — it holds none of the viewport’s top edge', () => {
    // The phone layout: the run header drops `md:sticky` so the transcript owns the small viewport.
    expect(pageHeaderOffset(box(236), 'static')).toBe(0)
    expect(pageHeaderOffset(box(236), 'relative')).toBe(0)
  })

  it('is zero when there is no header at all', () => {
    expect(pageHeaderOffset(null, 'sticky')).toBe(0)
  })
})

describe('watchPageHeaderOffset', () => {
  const originalObserver = globalThis.ResizeObserver

  afterEach(() => {
    globalThis.ResizeObserver = originalObserver
    vi.restoreAllMocks()
  })

  /** A fake `ResizeObserver` whose single instance can be fired on demand. */
  function stubResizeObserver(): { fire: () => void } {
    const callbacks: Array<() => void> = []
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        callbacks.push(callback)
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver
    return { fire: () => callbacks.forEach((cb) => cb()) }
  }

  function header(height: number, position: string): HTMLElement {
    const el = document.createElement('header')
    el.getBoundingClientRect = () => ({ height }) as DOMRect
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ position } as CSSStyleDeclaration)
    return el
  }

  it('publishes the height once on subscribe, before anything resizes', () => {
    stubResizeObserver()
    const seen: number[] = []
    const stop = watchPageHeaderOffset(header(236, 'sticky'), (px) => seen.push(px))
    expect(seen).toEqual([236])
    stop()
  })

  it('re-measures when the header itself changes size — the density lever', () => {
    const observer = stubResizeObserver()
    let height = 236
    const el = document.createElement('header')
    el.getBoundingClientRect = () => ({ height }) as DOMRect
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ position: 'sticky' } as CSSStyleDeclaration)
    const seen: number[] = []
    const stop = watchPageHeaderOffset(el, (px) => seen.push(px))
    height = 163
    observer.fire()
    expect(seen).toEqual([236, 163])
    stop()
  })

  it('re-measures on a viewport resize — the breakpoint decides whether it is sticky at all', () => {
    stubResizeObserver()
    const seen: number[] = []
    const stop = watchPageHeaderOffset(header(236, 'sticky'), (px) => seen.push(px))
    window.dispatchEvent(new Event('resize'))
    expect(seen).toEqual([236, 236])
    stop()
  })

  it('still publishes a first measurement without a ResizeObserver', () => {
    // @ts-expect-error — the engine may not carry one; the fallback must not be silent nothing.
    delete globalThis.ResizeObserver
    const seen: number[] = []
    const stop = watchPageHeaderOffset(header(197, 'sticky'), (px) => seen.push(px))
    expect(seen).toEqual([197])
    stop()
  })

  it('publishes zero on cleanup, so a stale offset never outlives the header', () => {
    stubResizeObserver()
    const seen: number[] = []
    watchPageHeaderOffset(header(236, 'sticky'), (px) => seen.push(px))()
    expect(seen.at(-1)).toBe(0)
  })

  it('publishes zero and subscribes to nothing when the header is absent', () => {
    const seen: number[] = []
    const stop = watchPageHeaderOffset(null, (px) => seen.push(px))
    expect(seen).toEqual([0])
    stop()
  })
})
