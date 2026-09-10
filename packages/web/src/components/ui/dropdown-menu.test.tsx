import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './dropdown-menu'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

beforeEach(() => {
  // Radix positions the menu with floating-ui, which observes the trigger's size. jsdom ships
  // no ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const slot = (name: string) => document.querySelector(`[data-slot="dropdown-menu-${name}"]`)
const slots = (name: string) =>
  Array.from(document.querySelectorAll(`[data-slot="dropdown-menu-${name}"]`))

/** One menu wearing every part the shim exports, open, so the slot contract is asserted once. */
function renderFullMenu() {
  return render(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem>
            Commit
            <DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked>Wrap lines</DropdownMenuCheckboxItem>
        <DropdownMenuRadioGroup value="unified">
          <DropdownMenuRadioItem value="unified">Unified</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="split">Split</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {/* `forceMount`: a sub menu only opens on hover/keyboard, neither of which jsdom can
            produce without a layout. Mounting it is what puts the sub parts in the document. */}
        <DropdownMenuSub defaultOpen>
          <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
          <DropdownMenuPortal forceMount>
            <DropdownMenuSubContent forceMount>
              <DropdownMenuItem>Another project</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

describe('DropdownMenu shim', () => {
  it('stamps a data-slot on every part, so the e2e selectors keep resolving', () => {
    renderFullMenu()

    for (const name of [
      'trigger',
      'content',
      'label',
      'group',
      'item',
      'shortcut',
      'separator',
      'checkbox-item',
      'radio-group',
      'radio-item',
      'sub-trigger',
      'sub-content',
    ]) {
      expect(slot(name), name).not.toBeNull()
    }
  })

  it('renders no element of its own for the state-only parts', () => {
    renderFullMenu()

    // `Root`, `Sub` and `Portal` are context providers — they emit no DOM, so their `data-slot`
    // has nowhere to land. Pinned so a future reader does not "fix" the missing attribute by
    // wrapping them in a div and changing the menu's layout.
    expect(slot('sub')).toBeNull()
    expect(slot('portal')).toBeNull()
    expect(document.querySelector('[data-slot="dropdown-menu"]')).toBeNull()
  })

  it('portals the content out of the trigger, so an overflow-hidden parent cannot clip it', () => {
    render(
      <div data-testid="clipper" style={{ overflow: 'hidden' }}>
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Commit</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )

    const content = slot('content')
    expect(content).not.toBeNull()
    expect(screen.getByTestId('clipper').contains(content)).toBe(false)
  })

  it('renders nothing but the trigger while the menu is closed', () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Commit</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )

    expect(slot('trigger')).not.toBeNull()
    expect(slot('content')).toBeNull()
  })

  describe('item variants', () => {
    it('defaults to the default variant and no inset', () => {
      render(
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Commit</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )

      const item = slot('item') as HTMLElement
      expect(item.dataset.variant).toBe('default')
      // `data-inset={undefined}` must not emit the attribute — the `data-[inset]:pl-8` rule
      // keys off its PRESENCE, so an emitted `data-inset="false"` would indent every row.
      expect(item.hasAttribute('data-inset')).toBe(false)
    })

    it('marks a destructive item so the red rules can key off it', () => {
      render(
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem variant="destructive" inset>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )

      const item = slot('item') as HTMLElement
      expect(item.dataset.variant).toBe('destructive')
      expect(item.dataset.inset).toBe('true')
    })

    it('passes disabled through to Radix so the row stops taking pointer events', () => {
      render(
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem disabled>Push</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )

      const item = slot('item') as HTMLElement
      expect(item.getAttribute('data-disabled')).not.toBeNull()
      expect(item.getAttribute('aria-disabled')).toBe('true')
    })
  })

  describe('label inset', () => {
    it('omits data-inset unless the caller asks for it', () => {
      render(
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>Plain</DropdownMenuLabel>
            <DropdownMenuLabel inset>Indented</DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>
      )

      const [plain, indented] = slots('label') as [HTMLElement, HTMLElement]
      expect(plain.hasAttribute('data-inset')).toBe(false)
      expect(indented.dataset.inset).toBe('true')
    })
  })

  describe('checkbox and radio indicators', () => {
    it('renders the check only while the box is checked', () => {
      const { rerender } = render(
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuCheckboxItem checked={false}>Wrap</DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )

      const unchecked = slot('checkbox-item') as HTMLElement
      expect(unchecked.getAttribute('aria-checked')).toBe('false')
      expect(unchecked.querySelector('svg')).toBeNull()

      rerender(
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuCheckboxItem checked>Wrap</DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )

      const checked = slot('checkbox-item') as HTMLElement
      expect(checked.getAttribute('aria-checked')).toBe('true')
      expect(checked.querySelector('svg')).not.toBeNull()
    })

    it('renders the dot on the selected radio row only', () => {
      render(
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value="split">
              <DropdownMenuRadioItem value="unified">Unified</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="split">Split</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )

      const [unified, split] = slots('radio-item') as [HTMLElement, HTMLElement]
      expect(unified.getAttribute('aria-checked')).toBe('false')
      expect(unified.querySelector('svg')).toBeNull()
      expect(split.getAttribute('aria-checked')).toBe('true')
      expect(split.querySelector('svg')).not.toBeNull()
    })
  })

  describe('sub menus', () => {
    it('appends the chevron after the sub-trigger children', () => {
      renderFullMenu()

      const trigger = slot('sub-trigger') as HTMLElement
      expect(trigger.textContent).toContain('Move to')
      // The affordance is added BY the shim, not by the caller — a caller that forgets it must
      // still get one, and it must sit last so it lands on the right edge.
      expect(trigger.lastElementChild?.tagName.toLowerCase()).toBe('svg')
      expect(trigger.lastElementChild?.getAttribute('class')).toContain('ml-auto')
    })

    it('omits data-inset on the sub-trigger unless asked', () => {
      renderFullMenu()

      expect((slot('sub-trigger') as HTMLElement).hasAttribute('data-inset')).toBe(false)
    })
  })

  describe('className merging', () => {
    it('lets a caller override a base class on the content', () => {
      render(
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-[20rem] p-0">
            <DropdownMenuItem>Commit</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )

      const content = slot('content') as HTMLElement
      expect(content.className).toContain('min-w-[20rem]')
      expect(content.className).not.toContain('min-w-[8rem]')
      expect(content.className).not.toContain('p-1')
      expect(content.className).toContain('bg-popover')
    })

    it('lets a caller override the separator and shortcut defaults', () => {
      render(
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSeparator className="bg-danger" />
            <DropdownMenuItem>
              Commit
              <DropdownMenuShortcut className="text-foreground">⌘K</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )

      const separator = slot('separator') as HTMLElement
      const shortcut = slot('shortcut') as HTMLElement
      expect(separator.className).toContain('bg-danger')
      expect(separator.className).not.toContain('bg-border')
      expect(separator.className).toContain('h-px')
      expect(shortcut.className).toContain('text-foreground')
      expect(shortcut.className).not.toContain('text-muted-foreground')
      expect(shortcut.className).toContain('ml-auto')
    })
  })
})
