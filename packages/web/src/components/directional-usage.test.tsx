import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DirectionalUsage, directionalUsageText, totalUsageText } from './directional-usage'

describe('DirectionalUsage', () => {
  it('uses the same compact direction order and an expanded accessible label', () => {
    render(<DirectionalUsage inputTokens={184_700} outputTokens={2_400} />)
    expect(screen.getByText('IN 184.7k · OUT 2.4k').getAttribute('aria-label')).toBe(
      'Input tokens: 184,700; output tokens: 2,400',
    )
  })

  it('shows one known side honestly and omits an entirely unknown compact value', () => {
    expect(directionalUsageText(184_700, undefined)).toBe('IN 184.7k · OUT —')
    const { container } = render(<DirectionalUsage />)
    expect(container.innerHTML).toBe('')
  })

  it('keeps both table placeholders when requested', () => {
    render(<DirectionalUsage variant="table" omitWhenUnknown={false} />)
    expect(screen.getByText('— / —').getAttribute('aria-label')).toBe(
      'Input tokens: unknown; output tokens: unknown',
    )
  })
})

describe('legacy total-only usage (#737 back-compat)', () => {
  it('shows the total a pre-split record does know, and never invents a direction', () => {
    render(<DirectionalUsage totalTokens={3_620} />)
    const el = screen.getByText('3.6k tokens')
    expect(el.getAttribute('aria-label')).toBe(
      'Total tokens: 3,620; input/output split not recorded',
    )
    expect(el.getAttribute('data-usage')).toBe('total')
  })

  it('keeps the unit out of dense surfaces that already name the column', () => {
    render(<DirectionalUsage totalTokens={128_400} variant="table" omitWhenUnknown={false} />)
    expect(screen.getByText('128.4k')).not.toBeNull()
    expect(totalUsageText(96_249, false)).toBe('96.2k')
  })

  it('prefers a recorded direction over the legacy total, including a metered zero', () => {
    render(<DirectionalUsage inputTokens={0} outputTokens={0} totalTokens={3_620} />)
    expect(screen.getByText('IN 0 · OUT 0')).not.toBeNull()
  })
})
