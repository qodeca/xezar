import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KeyboardViewport } from '@/lib/keyboard-inset'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from './popover'

/** Every `collisionPadding` the content handed Radix, newest last. */
const { paddings } = vi.hoisted(() => ({
  paddings: [] as Record<'top' | 'right' | 'bottom' | 'left', number>[],
}))

// Radix's positioning is a no-op in jsdom, so the only observable half of the keyboard fix is
// the value the content COMPUTES. Wrap the real merge rather than replacing it: the assertions
// below still pin the arithmetic in `keyboard-inset`, not a stub's idea of it.
vi.mock('@/lib/keyboard-inset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/keyboard-inset')>()
  return {
    ...actual,
    keyboardAwareCollisionPadding: (
      ...args: Parameters<typeof actual.keyboardAwareCollisionPadding>
    ) => {
      const merged = actual.keyboardAwareCollisionPadding(...args)
      paddings.push(merged)
      return merged
    },
  }
})

const lastCollisionPadding = () => paddings.at(-1)

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

beforeEach(() => {
  paddings.length = 0
  // Radix positions the content with floating-ui, which observes the trigger's size. jsdom
  // ships no ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

const REAL_VIEWPORT = Object.getOwnPropertyDescriptor(window, 'visualViewport')

afterEach(() => {
  vi.unstubAllGlobals()
  // Put the descriptor back rather than leaving a `null` behind: jsdom ships no `visualViewport`
  // at all, so the first test in this file would otherwise run in a different world than the rest.
  if (REAL_VIEWPORT) Object.defineProperty(window, 'visualViewport', REAL_VIEWPORT)
  else delete (window as { visualViewport?: unknown }).visualViewport
})

/** A visual viewport that is `bottom` px shorter than the layout one — an open iOS keyboard. */
function stubKeyboard(bottom: number, offsetTop = 0): void {
  const viewport: KeyboardViewport = {
    height: window.innerHeight - bottom - offsetTop,
    offsetTop,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
}

/** The whole shim rendered open, so every wrapper gets its slot asserted in one place. */
function renderOpenPopover() {
  return render(
    <Popover defaultOpen>
      <PopoverAnchor />
      <PopoverTrigger>Open</PopoverTrigger>
      <PopoverContent>
        <PopoverHeader>
          <PopoverTitle>Rename branch</PopoverTitle>
          <PopoverDescription>This does not push anything.</PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  )
}

describe('Popover shim', () => {
  it('stamps a data-slot on every part, so the e2e selectors keep resolving', () => {
    renderOpenPopover()

    expect(document.querySelector('[data-slot="popover-trigger"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="popover-anchor"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="popover-content"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="popover-header"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="popover-title"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="popover-description"]')).not.toBeNull()
  })

  it('portals the content out of the trigger, so an overflow-hidden parent cannot clip it', () => {
    render(
      <div data-testid="clipper" style={{ overflow: 'hidden' }}>
        <Popover defaultOpen>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent>Body</PopoverContent>
        </Popover>
      </div>
    )

    const content = document.querySelector('[data-slot="popover-content"]')
    expect(content).not.toBeNull()
    expect(screen.getByTestId('clipper').contains(content)).toBe(false)
  })

  it('renders the description as a <p> and the title as a plain div', () => {
    renderOpenPopover()

    expect(document.querySelector('[data-slot="popover-description"]')?.tagName).toBe('P')
    // A div, deliberately: `PopoverTitle` is typed as an h2 but rendered as a div so it never
    // injects a heading level into a page whose outline it knows nothing about.
    expect(document.querySelector('[data-slot="popover-title"]')?.tagName).toBe('DIV')
  })

  it('merges a caller className into the content instead of dropping the base classes', () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent className="w-[336px] p-0">Body</PopoverContent>
      </Popover>
    )

    const content = document.querySelector('[data-slot="popover-content"]') as HTMLElement
    expect(content.className).toContain('w-[336px]')
    // `w-72` and `p-4` are the two the caller overrides; the rest of the base survives.
    expect(content.className).not.toContain('w-72')
    expect(content.className).not.toContain('p-4')
    expect(content.className).toContain('rounded-md')
    expect(content.className).toContain('bg-popover')
  })

  it('lets a caller className override the header, title and description defaults', () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>
          <PopoverHeader className="text-base">
            <PopoverTitle className="font-bold">T</PopoverTitle>
            <PopoverDescription className="text-foreground">D</PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>
    )

    const header = document.querySelector('[data-slot="popover-header"]') as HTMLElement
    const title = document.querySelector('[data-slot="popover-title"]') as HTMLElement
    const description = document.querySelector('[data-slot="popover-description"]') as HTMLElement

    expect(header.className).toContain('text-base')
    expect(header.className).not.toContain('text-sm')
    expect(header.className).toContain('flex-col')
    expect(title.className).toContain('font-bold')
    expect(title.className).not.toContain('font-medium')
    expect(description.className).toContain('text-foreground')
    expect(description.className).not.toContain('text-muted-foreground')
  })

  it('renders nothing until the popover opens', () => {
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Body</PopoverContent>
      </Popover>
    )

    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()
    expect(document.querySelector('[data-slot="popover-trigger"]')).not.toBeNull()
  })

  describe('keyboard-aware collision padding', () => {
    it('keeps Radix at zero padding on an engine with no visualViewport', () => {
      // Desktop and jsdom: {0,0} insets, and the content keeps its exact pre-fix behavior.
      render(
        <Popover defaultOpen>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent>Body</PopoverContent>
        </Popover>
      )

      expect(lastCollisionPadding()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
    })

    it('adds the open keyboard to the bottom padding the caller asked for', async () => {
      stubKeyboard(300)
      render(
        <Popover defaultOpen>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent collisionPadding={8}>Body</PopoverContent>
        </Popover>
      )

      // 8 from the caller, 300 from the keyboard; left/right stay at the caller's 8.
      await vi.waitFor(() =>
        expect(lastCollisionPadding()).toEqual({ top: 8, right: 8, bottom: 308, left: 8 })
      )
    })

    it('adds a panned-down visual viewport to the top padding', async () => {
      stubKeyboard(0, 120)
      render(
        <Popover defaultOpen>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent collisionPadding={{ top: 4 }}>Body</PopoverContent>
        </Popover>
      )

      // A per-side object keeps the sides the caller left out at 0, not at the top's value.
      await vi.waitFor(() =>
        expect(lastCollisionPadding()).toEqual({ top: 124, right: 0, bottom: 0, left: 0 })
      )
    })
  })
})
