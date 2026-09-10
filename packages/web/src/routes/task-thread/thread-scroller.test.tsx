import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearThreadScrollCaches, readThreadScroll, saveThreadScroll } from './thread-scroll'
import { JumpToLatestPill, ThreadRows, useThreadScroll, type ThreadRow } from './thread-scroller'

beforeEach(() => {
  // virtua measures with a ResizeObserver; jsdom has none and never lays anything out.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.unstubAllGlobals()
  clearThreadScrollCaches()
})

const rows = (count: number): ThreadRow[] =>
  Array.from({ length: count }, (_, index) => ({ key: `row-${index}`, node: <p>row {index}</p> }))

/** The mode is the caller's (threadRenderMode is pinned in thread-scroll.test.ts) — these
 *  tests pin what each mode RENDERS: the flat path keeps every row in the DOM with the
 *  content-visibility hint; the virtua path hands the same wrappers to the virtualizer. */
describe('ThreadRows — the threshold-switched renderer', () => {
  const controls = () => renderHook(() => useThreadScroll('r1')).result.current

  it('flat mode renders every row, marked and content-visibility-hinted', () => {
    render(<ThreadRows runId="r1" rows={rows(5)} mode="flat" controls={controls()} />)
    const region = document.querySelector('[data-slot="thread-rows"]')!
    expect(region.getAttribute('data-virtualized')).toBe('false')
    const rendered = document.querySelectorAll('[data-slot="thread-row"]')
    expect(rendered).toHaveLength(5)
    expect(rendered[0]!.className).toContain('[content-visibility:auto]')
    // Bubbles rely on flex alignment inside their row — every wrapper is a flex column.
    expect(rendered[0]!.className).toContain('flex-col')
    expect(rendered[0]!.className).toContain('w-full')
  })

  it('virtual mode mounts the virtua container instead', () => {
    render(<ThreadRows runId="r1" rows={rows(400)} mode="virtual" controls={controls()} />)
    const region = document.querySelector('[data-slot="thread-rows"]')!
    expect(region.getAttribute('data-virtualized')).toBe('true')
    // jsdom gives virtua a 0-height viewport, so it mounts a window, not the full list —
    // the honest jsdom-visible half of "the DOM stays bounded" (the real-browser half is
    // thread-scroll.e2e.ts's).
    const rendered = document.querySelectorAll('[data-slot="thread-row"]')
    expect(rendered.length).toBeLessThan(400)
    for (const row of rendered) expect(row.className).toContain('w-full')
  })

  it('flat rows keep their content in render order', () => {
    render(<ThreadRows runId="r1" rows={rows(3)} mode="flat" controls={controls()} />)
    const texts = [...document.querySelectorAll('[data-slot="thread-row"]')].map((el) => el.textContent)
    expect(texts).toEqual(['row 0', 'row 1', 'row 2'])
  })
})

describe('useThreadScroll — outside a shell scroller (jsdom, tests, storybook-ish hosts)', () => {
  it('attaches without a [data-slot=main] ancestor and stays inert', () => {
    const { result } = renderHook(() => useThreadScroll('r1'))
    const el = document.createElement('div')
    // No scroller to find — the controls must not throw, now or on use.
    act(() => result.current.attachContent(el))
    expect(result.current.scrollElRef.current).toBeNull()
    result.current.jumpToLatest()
    result.current.restickIfStuck()
    expect(result.current.pillVisible).toBe(false)
  })

  it('consumes one multi-event wheel gesture even when the page request settles quickly', async () => {
    vi.useFakeTimers()
    const onLoadOlder = vi.fn().mockResolvedValue(undefined)
    const Harness = () => {
      const controls = useThreadScroll('r1', { onLoadOlder })
      return <main data-slot="main"><div ref={controls.attachContent} /></main>
    }
    render(<Harness />)
    const scroller = document.querySelector<HTMLElement>('[data-slot="main"]')!
    Object.defineProperties(scroller, {
      scrollTop: { value: 0, writable: true },
      clientHeight: { value: 400 },
      scrollHeight: { value: 1_000 },
    })

    await act(async () => {
      fireEvent.wheel(scroller, { deltaY: -120 })
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.wheel(scroller, { deltaY: -80 })
      await Promise.resolve()
    })
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    act(() => vi.advanceTimersByTime(181))
    await act(async () => {
      fireEvent.wheel(scroller, { deltaY: -120 })
      await Promise.resolve()
    })
    expect(onLoadOlder).toHaveBeenCalledTimes(2)
  })
})

describe('useThreadScroll — route arrival (#761)', () => {
  function ArrivalHarness({ viewKey }: { viewKey: string }) {
    const controls = useThreadScroll(viewKey)
    return (
      <main
        ref={(element) => {
          if (element) {
            Object.defineProperties(element, {
              scrollTop: { value: element.scrollTop, writable: true, configurable: true },
              clientHeight: { value: 500, configurable: true },
              scrollHeight: { value: 2_000, configurable: true },
            })
          }
        }}
        data-slot="main"
      >
        <div ref={controls.attachContent} />
      </main>
    )
  }

  it('restores an away-from-tail destination before passive effects observe it', () => {
    saveThreadScroll('run-a:main', { top: 640, atBottom: false })

    render(<ArrivalHarness viewKey="run-a:main" />)

    expect((document.querySelector('[data-slot="main"]') as HTMLElement).scrollTop).toBe(640)
  })

  it('lands a live-tail destination at the bottom before passive effects observe it', () => {
    saveThreadScroll('run-b:main', { top: 120, atBottom: true })

    render(<ArrivalHarness viewKey="run-b:main" />)

    expect((document.querySelector('[data-slot="main"]') as HTMLElement).scrollTop).toBe(1_500)
  })

  it('keeps the jump-to-latest intent across the history reset it triggers', async () => {
    // The reader is parked in the archive; the pill resets the history query, which empties
    // and re-mounts the transcript. Without a recorded tail the fresh arrival would restore
    // the parked offset and strand them at the top with the pill gone — the real-browser half
    // is thread-scroll.e2e.ts "scrolling up shows the jump pill".
    saveThreadScroll('run-c:main', { top: 0, atBottom: false })
    const jumped = renderHook(() => useThreadScroll('run-c:main'))
    render(
      <main
        ref={(element) => {
          // jsdom has no scrollTo; the smooth follow-up write is not what this asserts.
          if (element) Object.assign(element, { scrollTo: () => {} })
        }}
        data-slot="main"
      >
        <div ref={jumped.result.current.attachContent} />
      </main>,
    )
    await act(async () => {
      jumped.result.current.jumpToLatest()
      await Promise.resolve()
    })
    cleanup()

    render(<ArrivalHarness viewKey="run-c:main" />)

    expect((document.querySelector('[data-slot="main"]') as HTMLElement).scrollTop).toBe(1_500)
  })

  it('re-applies the destination owner when the task id changes in place', () => {
    saveThreadScroll('run-a:main', { top: 640, atBottom: false })
    saveThreadScroll('run-b:main', { top: 920, atBottom: false })
    const view = render(<ArrivalHarness viewKey="run-a:main" />)

    view.rerender(<ArrivalHarness viewKey="run-b:main" />)

    expect((document.querySelector('[data-slot="main"]') as HTMLElement).scrollTop).toBe(920)
  })
})

/**
 * The intent handlers (research §6, the 1,000-row fixture): pinning follows a GESTURE, never a
 * position. During replay the scroller's offset moves without the reader's hand — this hook
 * pins it, virtua writes its own corrections, and the browser's scroll anchoring nudges it
 * again — so a position-derived rule unpins at random. These cases drive the gestures directly
 * and assert what the hook did with the pin, which is the only observable half in jsdom.
 */
describe('useThreadScroll — pinning follows intent', () => {
  /** A scroller whose geometry the test owns. `scrollTop` is writable so the hook's own writes
   *  are visible, and `at()` moves the reader without pretending jsdom laid anything out. */
  function mountScroller(
    options: Parameters<typeof useThreadScroll>[1] = {},
    viewKey = 'r1:main',
  ) {
    let controls!: ReturnType<typeof useThreadScroll>
    const Harness = () => {
      controls = useThreadScroll(viewKey, options)
      return (
        <main data-slot="main">
          <div ref={controls.attachContent} />
        </main>
      )
    }
    render(<Harness />)
    const scroller = document.querySelector<HTMLElement>('[data-slot="main"]')!
    Object.defineProperties(scroller, {
      scrollTop: { value: 0, writable: true, configurable: true },
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 4_000, writable: true, configurable: true },
    })
    return {
      scroller,
      get controls() {
        return controls
      },
      /** Put the reader at `top` and fire the scroll the browser would. */
      at(top: number) {
        scroller.scrollTop = top
        act(() => {
          fireEvent.scroll(scroller)
        })
      },
      /** The tail offset for this geometry. */
      bottom: 3_600,
    }
  }

  it('shows the pill when the reader leaves the tail and hides it on return', () => {
    const view = mountScroller()

    view.at(1_000)
    expect(view.controls.pillVisible).toBe(true)

    view.at(view.bottom)
    expect(view.controls.pillVisible).toBe(false)
  })

  it('remembers the parked position, and remembers the tail as the tail', () => {
    const view = mountScroller({}, 'remember:main')

    view.at(1_000)
    expect(readThreadScroll('remember:main')).toEqual({ top: 1_000, atBottom: false })

    view.at(view.bottom)
    expect(readThreadScroll('remember:main')).toEqual({ top: 3_600, atBottom: true })
  })

  it('unpins on a wheel up, and growth then leaves the reader where they are', () => {
    const view = mountScroller()
    view.scroller.scrollTop = 1_000

    act(() => {
      fireEvent.wheel(view.scroller, { deltaY: -120 })
    })
    // Growth arrives (the agent streams another block) — a stuck thread would jump to the tail.
    view.controls.restickIfStuck()

    expect(view.scroller.scrollTop).toBe(1_000)
  })

  it('re-pins only when a recent DOWN gesture accompanies being near the tail', () => {
    const view = mountScroller()

    // Away from the tail, unpinned by a wheel up.
    view.scroller.scrollTop = 1_000
    act(() => {
      fireEvent.wheel(view.scroller, { deltaY: -120 })
    })

    // Arriving near the tail with no intent at all must NOT re-pin: virtua's at-rest sub-pixel
    // corrections near the tail would otherwise re-pin a reader who just wheeled up.
    view.at(view.bottom)
    view.scroller.scrollTop = 1_000
    view.controls.restickIfStuck()
    expect(view.scroller.scrollTop).toBe(1_000)

    // A wheel DOWN is the intent; reaching the tail after it re-pins.
    act(() => {
      fireEvent.wheel(view.scroller, { deltaY: 120 })
    })
    view.at(view.bottom)
    view.scroller.scrollTop = 1_000
    view.controls.restickIfStuck()
    expect(view.scroller.scrollTop).toBe(view.bottom)
  })

  it('lets the latest gesture win — an up gesture voids a recent down one', () => {
    const view = mountScroller()

    act(() => {
      fireEvent.wheel(view.scroller, { deltaY: 120 })
      fireEvent.wheel(view.scroller, { deltaY: -120 })
    })
    view.at(view.bottom)
    view.scroller.scrollTop = 1_000
    view.controls.restickIfStuck()

    expect(view.scroller.scrollTop).toBe(1_000)
  })

  describe('keyboard', () => {
    it('unpins on the up keys and loads an older page at the history start', () => {
      const onLoadOlder = vi.fn().mockResolvedValue(undefined)
      const view = mountScroller({ onLoadOlder })

      act(() => {
        fireEvent.keyDown(view.scroller, { key: 'PageUp' })
      })

      expect(onLoadOlder).toHaveBeenCalledTimes(1)
      view.controls.restickIfStuck()
      expect(view.scroller.scrollTop).toBe(0)
    })

    it('ignores a held key rather than requesting a page per repeat', () => {
      const onLoadOlder = vi.fn().mockResolvedValue(undefined)
      const view = mountScroller({ onLoadOlder })

      act(() => {
        fireEvent.keyDown(view.scroller, { key: 'ArrowUp', repeat: true })
      })

      expect(onLoadOlder).not.toHaveBeenCalled()
    })

    it('does not load older pages from the middle of the transcript', () => {
      const onLoadOlder = vi.fn().mockResolvedValue(undefined)
      const view = mountScroller({ onLoadOlder })
      view.scroller.scrollTop = 2_000

      act(() => {
        fireEvent.keyDown(view.scroller, { key: 'Home' })
      })

      expect(onLoadOlder).not.toHaveBeenCalled()
    })

    it('treats the down keys as an intent to return to the tail', () => {
      const view = mountScroller()
      view.scroller.scrollTop = 1_000
      act(() => {
        fireEvent.wheel(view.scroller, { deltaY: -120 })
        fireEvent.keyDown(view.scroller, { key: 'End' })
      })

      view.at(view.bottom)
      view.scroller.scrollTop = 1_000
      view.controls.restickIfStuck()

      expect(view.scroller.scrollTop).toBe(view.bottom)
    })

    it('ignores keys that are not navigation', () => {
      const onLoadOlder = vi.fn().mockResolvedValue(undefined)
      const view = mountScroller({ onLoadOlder })

      act(() => {
        fireEvent.keyDown(view.scroller, { key: 'a' })
      })

      expect(onLoadOlder).not.toHaveBeenCalled()
    })
  })

  describe('scrollbar drag', () => {
    it('unpins on a grab away from the tail, but keeps a drag back to it able to re-pin', () => {
      const view = mountScroller()
      view.scroller.scrollTop = 1_000

      act(() => {
        fireEvent.pointerDown(view.scroller)
      })
      // Unpinned right now…
      view.controls.restickIfStuck()
      expect(view.scroller.scrollTop).toBe(1_000)

      // …but a scrollbar grab can go either way, so dragging to the tail re-pins.
      view.at(view.bottom)
      view.scroller.scrollTop = 1_000
      view.controls.restickIfStuck()
      expect(view.scroller.scrollTop).toBe(view.bottom)
    })

    it('leaves a grab at the tail pinned', () => {
      const view = mountScroller()
      view.scroller.scrollTop = view.bottom

      act(() => {
        fireEvent.pointerDown(view.scroller)
      })
      view.scroller.scrollTop = 1_000
      view.controls.restickIfStuck()

      expect(view.scroller.scrollTop).toBe(view.bottom)
    })

    it('loads one older page while dragging upward into the history start', () => {
      const onLoadOlder = vi.fn().mockResolvedValue(undefined)
      const view = mountScroller({ onLoadOlder })
      view.scroller.scrollTop = 1_000
      act(() => {
        fireEvent.pointerDown(view.scroller)
      })

      // Dragging up: two scroll events inside the history start must arm the page ONCE.
      view.at(500)
      view.at(100)

      expect(onLoadOlder).toHaveBeenCalledTimes(1)
    })

    it('arms nothing once the pointer is released', () => {
      const onLoadOlder = vi.fn().mockResolvedValue(undefined)
      const view = mountScroller({ onLoadOlder })
      view.scroller.scrollTop = 1_000
      act(() => {
        fireEvent.pointerDown(view.scroller)
        fireEvent.pointerUp(window)
      })

      view.at(100)

      expect(onLoadOlder).not.toHaveBeenCalled()
    })
  })

  describe('touch', () => {
    const touch = (y: number) => ({ touches: [{ clientY: y }] })

    it('unpins on a downward finger drag and loads one older page at the start', () => {
      const onLoadOlder = vi.fn().mockResolvedValue(undefined)
      const view = mountScroller({ onLoadOlder })

      act(() => {
        fireEvent.touchStart(view.scroller, touch(100))
        // Finger moving DOWN pans the content up, away from the tail.
        fireEvent.touchMove(view.scroller, touch(160))
        fireEvent.touchMove(view.scroller, touch(220))
      })

      // One page per gesture, not one per touchmove.
      expect(onLoadOlder).toHaveBeenCalledTimes(1)
      view.controls.restickIfStuck()
      expect(view.scroller.scrollTop).toBe(0)
    })

    it('treats an upward finger drag as an intent to return to the tail', () => {
      const view = mountScroller()
      view.scroller.scrollTop = 1_000

      act(() => {
        fireEvent.touchStart(view.scroller, touch(300))
        fireEvent.touchMove(view.scroller, touch(240))
      })
      view.at(view.bottom)
      view.scroller.scrollTop = 1_000
      view.controls.restickIfStuck()

      expect(view.scroller.scrollTop).toBe(view.bottom)
    })

    it('ignores a jitter of one pixel or less', () => {
      const onLoadOlder = vi.fn().mockResolvedValue(undefined)
      const view = mountScroller({ onLoadOlder })

      act(() => {
        fireEvent.touchStart(view.scroller, touch(100))
        fireEvent.touchMove(view.scroller, touch(101))
      })

      expect(onLoadOlder).not.toHaveBeenCalled()
    })

    it('ignores a touchmove that carries no touch point', () => {
      const view = mountScroller()

      act(() => {
        fireEvent.touchStart(view.scroller, { touches: [] })
        fireEvent.touchMove(view.scroller, { touches: [] })
      })

      expect(view.controls.pillVisible).toBe(false)
    })
  })
})

describe('JumpToLatestPill', () => {
  it('is a labelled button that reports the jump', () => {
    const onJump = vi.fn()
    render(<JumpToLatestPill onJump={onJump} />)

    const pill = document.querySelector<HTMLElement>('[data-slot="jump-to-latest"]')!
    expect(pill.textContent).toContain('Jump to latest')
    fireEvent.click(pill)
    expect(onJump).toHaveBeenCalledTimes(1)
  })
})

/**
 * Content growth — the branch the file's own source comment says was learned the hard way, and
 * the one a no-op `ResizeObserver` stub leaves entirely unexercised.
 *
 * "Reached AND still" is the rule: landing on the cached offset once is not enough, because a
 * destination that is still resizing (the replay filling in, the live buffer compacting back to
 * its newest page) moves content above the viewport and the browser's scroll anchoring slides the
 * reader off the position they were just restored to. So the restore is re-applied on every growth
 * and only released when the offset is reachable AND the height has stopped moving.
 */
describe('useThreadScroll — content growth', () => {
  /** A `ResizeObserver` that hands the test its callback, so growth can be driven frame by frame. */
  function mountWithObserver(viewKey: string) {
    const callbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )

    let controls!: ReturnType<typeof useThreadScroll>
    const Harness = () => {
      controls = useThreadScroll(viewKey)
      return (
        <main data-slot="main">
          <div ref={controls.attachContent} />
        </main>
      )
    }
    render(<Harness />)
    const scroller = document.querySelector<HTMLElement>('[data-slot="main"]')!
    Object.defineProperties(scroller, {
      scrollTop: { value: 0, writable: true, configurable: true },
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 1_000, writable: true, configurable: true },
    })
    return {
      scroller,
      get controls() {
        return controls
      },
      /** The transcript grows to `height`, and the observer fires as the browser's would. */
      growTo(height: number) {
        // `scrollHeight` is read-only on the DOM type; the harness redefined it as writable above.
        ;(scroller as unknown as { scrollHeight: number }).scrollHeight = height
        act(() => {
          for (const callback of callbacks) callback([], {} as ResizeObserver)
        })
      },
    }
  }

  it('follows growth to the tail while the reader is pinned', () => {
    const view = mountWithObserver('grow-stuck:main')

    view.growTo(4_000)
    expect(view.scroller.scrollTop).toBe(3_600)

    // Another streamed block: still pinned, so still at the bottom.
    view.growTo(6_000)
    expect(view.scroller.scrollTop).toBe(5_600)
  })

  it('holds a cached offset that is not reachable yet, and rides the growing bottom toward it', () => {
    saveThreadScroll('grow-restore:main', { top: 3_000, atBottom: false })
    const view = mountWithObserver('grow-restore:main')

    // The replay has only filled in part of the transcript: 3 000 is past the end, so the restore
    // clamps to the bottom rather than overshooting, and stays pending.
    view.growTo(2_000)
    expect(view.scroller.scrollTop).toBe(1_600)

    // Now tall enough — but the height CHANGED on this frame, so the restore is applied and NOT
    // released.
    view.growTo(8_000)
    expect(view.scroller.scrollTop).toBe(3_000)

    // THE case the "AND still" half of the rule exists for: content above the viewport resizes,
    // the browser's own scroll anchoring slides the reader off the offset they were just restored
    // to, and the still-pending restore has to put them back. Releasing on "reached" alone would
    // strand them here.
    view.scroller.scrollTop = 2_400
    view.growTo(9_000)
    expect(view.scroller.scrollTop).toBe(3_000)

    // Same height twice: reached and still. Now it is released.
    view.growTo(9_000)
    expect(view.scroller.scrollTop).toBe(3_000)

    // Released means released — a later growth leaves a reader parked mid-transcript alone.
    view.scroller.scrollTop = 2_400
    view.growTo(12_000)
    expect(view.scroller.scrollTop).toBe(2_400)
  })

  it('never traps the reader — an unpinning gesture abandons the pending restore', () => {
    saveThreadScroll('grow-escape:main', { top: 3_000, atBottom: false })
    const view = mountWithObserver('grow-escape:main')
    view.growTo(2_000)

    // The reader gives up waiting and scrolls away themselves.
    act(() => {
      fireEvent.wheel(view.scroller, { deltaY: -120 })
    })
    view.scroller.scrollTop = 500

    // Growth now moves nothing: the restore was dropped and the pin is off.
    view.growTo(8_000)
    expect(view.scroller.scrollTop).toBe(500)
  })

  it('leaves an unpinned reader alone as the transcript grows under them', () => {
    const view = mountWithObserver('grow-unpinned:main')
    view.scroller.scrollTop = 500
    act(() => {
      fireEvent.wheel(view.scroller, { deltaY: -120 })
    })

    view.growTo(9_000)

    expect(view.scroller.scrollTop).toBe(500)
  })
})
