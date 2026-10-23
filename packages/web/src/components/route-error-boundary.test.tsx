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

it('Retry reloads the document when the page code failed to load (a tab older than the build)', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const reload = vi.fn()
  const original = window.location
  // jsdom's location.reload is not configurable on the instance; swap the whole object.
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } })
  try {
    let renders = 0
    function StalePage(): never {
      renders += 1
      throw new TypeError('Failed to fetch dynamically imported module: http://x/assets/task-thread-old.js')
    }
    render(
      <MemoryRouter>
        <RouteErrorBoundary><StalePage /></RouteErrorBoundary>
      </MemoryRouter>,
    )
    const before = renders
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(reload).toHaveBeenCalledTimes(1)
    // No re-render of the cached failure.
    expect(renders).toBe(before)
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: original })
  }
})

it('Retry re-renders an ordinary page failure without reloading', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const reload = vi.fn()
  const original = window.location
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } })
  try {
    let fail = true
    function Flaky() {
      if (fail) throw new Error('route failed')
      return <p>Recovered</p>
    }
    render(
      <MemoryRouter>
        <RouteErrorBoundary><Flaky /></RouteErrorBoundary>
      </MemoryRouter>,
    )
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByText('Recovered')).toBeTruthy()
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: original })
  }
})
