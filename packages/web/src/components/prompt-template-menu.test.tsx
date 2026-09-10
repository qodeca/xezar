import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PromptTemplate } from '@/lib/prompt-templates'

import { PromptTemplateMenu } from './prompt-template-menu'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  // Radix positions the popover with floating-ui (ResizeObserver) and cmdk scrolls the active
  // row into view; jsdom ships neither.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Element.prototype.scrollIntoView = vi.fn()
})

const TEMPLATES: PromptTemplate[] = [
  { id: 'add-tests', label: 'Add tests', text: 'Also add or update tests covering this change.' },
  {
    id: 'update-docs',
    label: 'Update the docs',
    text: 'Update the documentation for this change.',
    skills: ['om-docs', 'om-review'],
  },
]

/** Where the imperative "Edit templates…" navigation actually landed. */
function LocationProbe() {
  const location = useLocation()
  return <span data-testid="pathname">{location.pathname}</span>
}

function renderMenu(props: Partial<Parameters<typeof PromptTemplateMenu>[0]> = {}) {
  const onInsert = vi.fn()
  const result = render(
    <MemoryRouter initialEntries={['/p/xezar/new']}>
      <PromptTemplateMenu templates={TEMPLATES} onInsert={onInsert} {...props} />
      <LocationProbe />
    </MemoryRouter>
  )
  return { ...result, onInsert }
}

const trigger = () =>
  document.querySelector<HTMLElement>('[data-slot="prompt-template-trigger"]')

const option = (id: string) =>
  document.querySelector<HTMLElement>(`[data-slot="prompt-template-option"][data-template="${id}"]`)

/** A Popover + cmdk (matching the skill pickers), so: click, not pointerdown. */
async function openMenu(): Promise<void> {
  fireEvent.click(trigger()!)
  await waitFor(() => expect(option('add-tests')).not.toBeNull())
}

describe('PromptTemplateMenu', () => {
  it('renders nothing at all when the user has cleared every template', () => {
    renderMenu({ templates: [] })

    // Not an empty menu behind a trigger — no trigger either.
    expect(trigger()).toBeNull()
    expect(document.querySelector('[data-slot="prompt-template-menu"]')).toBeNull()
  })

  it('labels the trigger for both sight and assistive tech', () => {
    renderMenu()

    expect(trigger()!.textContent).toContain('templates')
    expect(trigger()!.getAttribute('aria-label')).toBe('Insert a prompt template')
    expect(trigger()!.getAttribute('title')).toBe('Insert a prompt template')
  })

  it('drops the word and the chevron in iconOnly mode, keeping the accessible name', () => {
    renderMenu({ iconOnly: true })

    // The /new composer footer, where the pill row is already full.
    expect(trigger()!.textContent).not.toContain('templates')
    expect(trigger()!.className).toContain('w-[26px]')
    expect(trigger()!.getAttribute('aria-label')).toBe('Insert a prompt template')
  })

  it('applies a caller className on top of the pill styling', () => {
    renderMenu({ triggerClassName: 'ml-1' })

    expect(trigger()!.className).toContain('ml-1')
    expect(trigger()!.className).toContain('rounded-full')
  })

  it('disables the trigger while the composer says so', () => {
    renderMenu({ disabled: true })

    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
    expect(trigger()!.className).toContain('disabled:pointer-events-none')
  })

  it('hands the snippet text to the composer and closes itself', async () => {
    const { onInsert } = renderMenu()
    await openMenu()

    fireEvent.click(option('add-tests')!)

    await waitFor(() =>
      expect(onInsert).toHaveBeenCalledWith('Also add or update tests covering this change.')
    )
    await waitFor(() => expect(option('add-tests')).toBeNull())
  })

  it('shows each template as its label over its text', async () => {
    renderMenu()
    await openMenu()

    const row = option('update-docs')!
    expect(row.textContent).toContain('Update the docs')
    expect(row.textContent).toContain('Update the documentation for this change.')
    // The full text is the tooltip too, for a snippet the one-line clamp cuts off.
    expect(row.getAttribute('title')).toBe('Update the documentation for this change.')
  })

  describe('the assigned-skills badge', () => {
    it('counts the skills a template auto-applies with, and names them in the tooltip', async () => {
      renderMenu()
      await openMenu()

      const badge = option('update-docs')!.querySelector<HTMLElement>(
        '[data-slot="prompt-template-assigned"]'
      )!
      expect(badge.textContent).toContain('2')
      expect(badge.getAttribute('title')).toBe('Applied automatically with: om-docs, om-review')
    })

    it('is absent on a manual-only template', async () => {
      renderMenu()
      await openMenu()

      expect(
        option('add-tests')!.querySelector('[data-slot="prompt-template-assigned"]')
      ).toBeNull()
    })

    it('is absent on a template whose skills list is present but empty', async () => {
      renderMenu({
        templates: [{ id: 'add-tests', label: 'Add tests', text: 'text', skills: [] }],
      })
      await openMenu()

      expect(
        option('add-tests')!.querySelector('[data-slot="prompt-template-assigned"]')
      ).toBeNull()
    })
  })

  describe('searching', () => {
    it('matches on the label', async () => {
      renderMenu()
      await openMenu()

      fireEvent.change(screen.getByPlaceholderText('search templates…'), {
        target: { value: 'docs' },
      })

      await waitFor(() =>
        expect(document.querySelectorAll('[data-slot="prompt-template-option"]')).toHaveLength(1)
      )
      expect(option('update-docs')).not.toBeNull()
    })

    it('matches on the snippet text, not only the label someone gave it', async () => {
      renderMenu()
      await openMenu()

      fireEvent.change(screen.getByPlaceholderText('search templates…'), {
        target: { value: 'covering' },
      })

      await waitFor(() =>
        expect(document.querySelectorAll('[data-slot="prompt-template-option"]')).toHaveLength(1)
      )
      expect(option('add-tests')).not.toBeNull()
    })

    it('matches on the name of an assigned skill', async () => {
      renderMenu()
      await openMenu()

      fireEvent.change(screen.getByPlaceholderText('search templates…'), {
        target: { value: 'om-review' },
      })

      await waitFor(() =>
        expect(document.querySelectorAll('[data-slot="prompt-template-option"]')).toHaveLength(1)
      )
      expect(option('update-docs')).not.toBeNull()
    })

    it('says so when nothing matches, and scrolls the list back to the top as you type', async () => {
      renderMenu()
      await openMenu()

      const list = document.querySelector('[data-slot="prompt-template-list-menu"]')!
      const scrollTo = vi.fn()
      Object.defineProperty(list, 'scrollTo', { value: scrollTo, configurable: true })

      fireEvent.input(screen.getByPlaceholderText('search templates…'), {
        target: { value: 'zzzz' },
      })

      await waitFor(() => expect(screen.getByText('Nothing matches.')).not.toBeNull())
      expect(document.querySelectorAll('[data-slot="prompt-template-option"]')).toHaveLength(0)
      expect(scrollTo).toHaveBeenCalledWith(0, 0)
    })
  })

  it('navigates to the settings page from "Edit templates…" and closes', async () => {
    const { onInsert } = renderMenu()
    await openMenu()

    fireEvent.click(document.querySelector('[data-slot="prompt-template-settings"]')!)

    // Navigated imperatively rather than as a <Link>: cmdk swallows a link's own navigation.
    // Scoped to the active project by `lib/project-router`, not left flat.
    await waitFor(() =>
      expect(screen.getByTestId('pathname').textContent).toBe('/p/xezar/settings/prompt-templates')
    )
    expect(onInsert).not.toHaveBeenCalled()
  })
})
