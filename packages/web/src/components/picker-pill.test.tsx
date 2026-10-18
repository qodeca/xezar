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
