import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PickerPill } from './picker-pill'

afterEach(cleanup)

describe('PickerPill catalog status', () => {
  it('keeps radio options selectable and renders a disabled status row', async () => {
    render(
      <PickerPill
        slot="model-pill"
        ariaLabel="Model"
        label="auto"
        value=""
        onPick={() => {}}
        options={[{ value: '', label: 'auto' }, { value: 'gpt-future', label: 'Future' }]}
        status="Using cached Codex model list"
      />,
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: /^Model:/u }))
    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(2)
    expect(screen.getByText('Using cached Codex model list').closest('[data-disabled]')).not.toBeNull()
  })
})

describe('PickerPill accessible name (WCAG 2.5.3 Label in Name)', () => {
  const props = {
    slot: 'model-pill',
    ariaLabel: 'Model',
    label: 'sonnet',
    value: 'sonnet',
    onPick: () => {},
    options: [{ value: 'sonnet', label: 'sonnet' }],
  }

  it('names the setting AND its value, so a reader hears which model is chosen', () => {
    render(<PickerPill {...props} />)
    const pill = screen.getByRole('button', { name: /^Model:\s?sonnet$/u })
    expect(pill.getAttribute('aria-label')).toBeNull()
    // The visible text is unchanged: the setting name is hidden text.
    expect(pill.querySelector('.sr-only')?.textContent).toBe('Model: ')
  })

  it('the read-only pill carries the same words as text', () => {
    render(<PickerPill {...props} readOnly />)
    const pill = document.querySelector('[data-slot="model-pill"]') as HTMLElement
    expect(pill.getAttribute('aria-label')).toBeNull()
    expect(pill.textContent).toBe('Model: sonnet')
  })

  it('the disabled pill keeps the value in its name too', () => {
    render(<PickerPill {...props} disabled disabledHint="Locked." />)
    expect(screen.getByRole('button', { name: /^Model:\s?sonnet$/u })).not.toBeNull()
  })
})

describe('PickerPill disabled reason (visible, not a title only)', () => {
  const props = {
    slot: 'variants-pill',
    ariaLabel: 'Parallel variants',
    label: '×1',
    value: '1',
    onPick: () => {},
    options: [{ value: '1', label: '×1' }],
    disabledHint: 'Parallel variants need a git repository — each variant runs in its own worktree.',
    disabledNote: 'Variants need a git repository',
  }

  it('a disabled pill shows its short reason beside it and is described by it', () => {
    render(<PickerPill {...props} disabled />)
    const pill = screen.getByRole('button', { name: /^Parallel variants:/u })
    const note = document.querySelector('[data-slot="variants-pill-note"]') as HTMLElement
    expect(note.textContent).toBe('Variants need a git repository')
    expect(pill.getAttribute('aria-describedby')).toBe(note.id)
  })

  it('an enabled pill shows no reason', () => {
    render(<PickerPill {...props} />)
    expect(document.querySelector('[data-slot="variants-pill-note"]')).toBeNull()
    expect(screen.getByRole('button', { name: /^Parallel variants:/u }).getAttribute('aria-describedby')).toBeNull()
  })
})
