import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Link, MemoryRouter, useLocation } from 'react-router'

import { RouteErrorBoundary } from './route-error-boundary'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('contains an initial route failure and recovers through sidebar navigation', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  function Page() {
    if (useLocation().pathname === '/broken') throw new Error('route failed')
    return <p>Healthy destination</p>
  }
  render(
    <MemoryRouter initialEntries={['/broken']}>
      <nav><Link to="/healthy">Open another page</Link></nav>
      <RouteErrorBoundary><Page /></RouteErrorBoundary>
    </MemoryRouter>,
  )
  expect(screen.getByRole('alert')).toBeTruthy()
  fireEvent.click(screen.getByRole('link', { name: 'Open another page' }))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText('Healthy destination')).toBeTruthy()
})
