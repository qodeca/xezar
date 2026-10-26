import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AppShell } from '@/components/app-shell'
import { ThemeProvider } from '@/components/theme-provider'
import { useGuardedNavigate, useLeaveGuard } from './use-leave-guard'

/**
 * The guard against the REAL browser history (BrowserRouter on jsdom's `window.history`), so
 * Back, the sentinel entry and its removal are exercised the way the cockpit runs them.
 */

const isSentinel = () => {
  const state: unknown = window.history.state
  return typeof state === 'object' && state !== null && '__xezLeaveGuard' in state
}

/** A draft screen: "Edit" makes it dirty, "Save" clean; the confirm is two buttons. */
function DraftScreen() {
  const [dirty, setDirty] = useState(false)
  const [leave, setLeave] = useState<(() => void) | null>(null)
  useLeaveGuard(dirty, (proceed) => setLeave(() => proceed))
  // Stands in for the ⌘K palette and the `c` shortcut, which navigate in code.
  const navigate = useGuardedNavigate(useNavigate())
  return (
    <div>
      <p>Draft screen</p>
      <button type="button" onClick={() => setDirty(true)}>Edit</button>
      <button type="button" onClick={() => setDirty(false)}>Save</button>
      <button type="button" onClick={() => navigate('/elsewhere')}>Palette: Elsewhere</button>
      {leave ? (
        <div role="alertdialog">
          <button type="button" onClick={() => setLeave(null)}>Keep it</button>
          <button
            type="button"
            onClick={() => {
              setLeave(null)
              setDirty(false)
              leave()
            }}
          >
            Discard
          </button>
        </div>
      ) : null}
    </div>
  )
}

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>
}

function renderApp(shell = false) {
  const routes = (
    <Routes>
      <Route path="/draft" element={<DraftScreen />} />
      <Route path="/elsewhere" element={<p>Elsewhere page</p>} />
      <Route path="/start" element={<p>Start page</p>} />
      <Route path="/skills" element={<p>Skills page</p>} />
    </Routes>
  )
  const wrap = (children: ReactNode) =>
    shell ? (
      <ThemeProvider>
        <AppShell>{children}</AppShell>
      </ThemeProvider>
    ) : (
      children
    )
  return render(
    <BrowserRouter>
      {wrap(routes)}
      <Where />
    </BrowserRouter>,
  )
}

const where = () => screen.getByTestId('where').textContent
const dialog = () => screen.queryByRole('alertdialog')

beforeEach(() => {
  // A fresh two-entry history for every test: /start, then /draft.
  window.history.replaceState(null, '', '/start')
  window.history.pushState(null, '', '/draft')
})

afterEach(async () => {
  cleanup()
  // Let a sentinel removal from an unmounted guard land before the next test rewrites history.
  // Wait for the removal itself, not a fixed time (#1105): it is three chained timer tasks (the
  // guard's deferred `history.back()`, then jsdom's two traversal tasks), which outlasted a 30 ms
  // sleep on a loaded Windows runner. The next test's `pushState` then cancelled the traversal
  // still in flight, the guard kept waiting for that removal's popstate, and took the next test's
  // own Back for it – no dialog. The sentinel stays the current entry until the traversal lands
  // and its popstate has run, so this resolves exactly then (at once when no sentinel was left).
  await waitFor(() => expect(isSentinel()).toBe(false))
})

describe('useLeaveGuard — Back and Forward', () => {
  it('Back with unsaved edits asks, stays on the page, and asks again after Keep it', async () => {
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(isSentinel()).toBe(true))

    act(() => window.history.back())
    await waitFor(() => expect(dialog()).not.toBeNull())
    expect(where()).toBe('/draft')
    expect(screen.getByText('Draft screen')).toBeTruthy()
    await waitFor(() => expect(isSentinel()).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.getByText('Draft screen')).toBeTruthy()

    act(() => window.history.back())
    await waitFor(() => expect(dialog()).not.toBeNull())
    expect(where()).toBe('/draft')
  })

  it('Discard after Back goes where the reader was heading', async () => {
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(isSentinel()).toBe(true))
    act(() => window.history.back())
    await waitFor(() => expect(dialog()).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(where()).toBe('/start'))
    expect(screen.getByText('Start page')).toBeTruthy()
  })

  it('without edits Back simply goes back, and saving removes the sentinel entry', async () => {
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(isSentinel()).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(isSentinel()).toBe(false))
    expect(where()).toBe('/draft')

    act(() => window.history.back())
    await waitFor(() => expect(where()).toBe('/start'))
    expect(dialog()).toBeNull()
  })
})

describe('useLeaveGuard — in-app navigation', () => {
  it('a programmatic navigate (the palette) asks first; Discard navigates without a stray entry', async () => {
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(isSentinel()).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Palette: Elsewhere' }))
    expect(dialog()).not.toBeNull()
    expect(where()).toBe('/draft')

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(where()).toBe('/elsewhere'))
    // Back lands on the draft page itself, not on a leftover copy of it.
    act(() => window.history.back())
    await waitFor(() => expect(where()).toBe('/draft'))
    expect(isSentinel()).toBe(false)
  })

  it('a programmatic navigate with nothing to lose goes at once', () => {
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Palette: Elsewhere' }))
    expect(where()).toBe('/elsewhere')
  })

  it('a sidebar nav link asks first, and Keep it stays', async () => {
    renderApp(true)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(isSentinel()).toBe(true))
    const nav = screen.getByRole('navigation', { name: 'Main' })
    const skills = [...nav.querySelectorAll('a')].find((a) => a.textContent?.includes('Skills'))!
    fireEvent.click(skills)
    expect(dialog()).not.toBeNull()
    expect(where()).toBe('/draft')
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(where()).toBe('/draft')

    fireEvent.click(skills)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(where()).toBe('/skills'))
  })
})

describe('useLeaveGuard — reload and tab close', () => {
  it('asks the browser to confirm a reload only while there are unsaved edits', async () => {
    renderApp()
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(unload()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await waitFor(() => expect(isSentinel()).toBe(true))
    expect(unload()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(isSentinel()).toBe(false))
    expect(unload()).toBe(false)
  })
})
