import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OnboardingStatus } from '@qodeca/xezar-api-client'

import { OnboardingOfferRow } from './onboarding-offer-row'

/**
 * The offer row, every state (#464 P2, `offer.html` and `states.html` § 3).
 *
 * Three claims are pinned here because breaking any of them is invisible in a screenshot: the row
 * is a STATUS and never an alert, it never renders without a real pending offer, and it never
 * carries meaning in colour alone.
 */

const base: OnboardingStatus = {
  state: 'changed',
  provenance: 'recorded',
  available: true,
  unavailableReason: null,
  localHandoff: true,
  offerPending: true,
  dismissed: false,
  observed: { engineVersion: '0.15.0', kitDigest: '9f1a3b4fff' },
  lastOffered: null,
  lastChecked: { engineVersion: '0.14.0', kitDigest: '9f1a3b4fff', at: '2026-09-02T16:40:00.000Z' },
  checkingRunId: null,
  launch: { workflowId: 'project-setup', modes: ['setup', 'preview', 'recheck'] },
}

function renderRow(over: Partial<OnboardingStatus> = {}, props: { pending?: boolean } = {}) {
  const onRecheck = vi.fn()
  const onLater = vi.fn()
  render(
    <MemoryRouter>
      <OnboardingOfferRow
        status={{ ...base, ...over }}
        pending={props.pending ?? false}
        onRecheck={onRecheck}
        onLater={onLater}
      />
    </MemoryRouter>,
  )
  return { onRecheck, onLater, row: () => document.querySelector('[data-slot="onboarding-offer"]') }
}

afterEach(cleanup)

describe('the offer row', () => {
  it('is a status row with exactly two actions, and is not an alert', () => {
    const { row } = renderRow()
    expect(row()?.getAttribute('role')).toBe('status')
    expect(row()?.getAttribute('aria-live')).toBe('polite')
    // Spending the alert tone on "a version changed" teaches people to ignore the row that means
    // an agent provider failed.
    expect(row()?.getAttribute('role')).not.toBe('alert')
    expect(row()?.className).not.toContain('destructive')
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['Re-check', 'Later'])
  })

  it('carries no status dot — the sentence is the whole meaning', () => {
    const { row } = renderRow()
    expect(row()?.querySelector('[data-slot="status-dot"]')).toBeNull()
    expect(row()?.textContent).toContain('xezar changed since this project was last checked')
  })

  it('renders nothing at all where the design says no offer appears', () => {
    for (const over of [
      { offerPending: false },
      { state: 'never' as const, offerPending: false, lastChecked: null },
      { state: 'unknown' as const, offerPending: false, lastChecked: null },
      { state: 'set-up' as const, offerPending: false },
    ]) {
      const { row } = renderRow(over)
      expect(row()).toBeNull()
      cleanup()
    }
    render(
      <MemoryRouter>
        <OnboardingOfferRow status={undefined} pending={false} onRecheck={vi.fn()} onLater={vi.fn()} />
      </MemoryRouter>,
    )
    expect(document.querySelector('[data-slot="onboarding-offer"]')).toBeNull()
  })

  it('a running check replaces the offer with a line naming the task', () => {
    const { row } = renderRow({ state: 'checking', checkingRunId: 'run-7', offerPending: false })
    expect(row()?.getAttribute('data-offer-state')).toBe('checking')
    expect(row()?.textContent).toContain('Re-checking this project')
    // Two clicks must not start two checks, so neither action is on screen beside a running one.
    expect(screen.queryByRole('button', { name: 'Re-check' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Open the task' }).getAttribute('href')).toContain('/tasks/run-7')
  })

  it('shows the pending label and disables both actions while a click is in flight', () => {
    const { onRecheck, onLater } = renderRow({}, { pending: true })
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['Starting…', 'Later'])
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(button)
    }
    expect(onRecheck).not.toHaveBeenCalled()
    expect(onLater).not.toHaveBeenCalled()
  })

  it('links to Settings only when four identifiers would not fit', () => {
    expect(screen.queryByRole('link', { name: 'See the exact versions' })).toBeNull()
    cleanup()
    renderRow({ lastChecked: { engineVersion: '0.14.0', kitDigest: '2c20c60aaa', at: '2026-09-02T16:40:00.000Z' } })
    expect(screen.getByRole('link', { name: 'See the exact versions' })).toBeTruthy()
  })

  it('keeps Later working, and gives the disabled Re-check a readable reason', () => {
    const { onLater } = renderRow({
      available: false,
      unavailableReason: 'Setup unavailable — no agent backend was found.',
    })
    const recheck = screen.getByRole('button', { name: 'Re-check' })
    expect((recheck as HTMLButtonElement).disabled).toBe(true)
    // Visible to a screen reader through `aria-describedby`, never a `title` alone.
    const describedBy = recheck.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toContain('no agent backend was found')
    // Dismissing never depends on being able to act: a person may always put the notice away.
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(onLater).toHaveBeenCalledTimes(1)
  })

  it('names none of xezar’s own working files or process, in any shape (#466)', () => {
    // Review round 1 finding 5: the pure copy rules are guarded in `lib/onboarding.test.ts`, and
    // this covers what the component itself writes — the labels, the link and the disabled reason,
    // which live in JSX and are the strings that list can never see.
    for (const over of [
      {},
      { lastChecked: { engineVersion: '0.14.0', kitDigest: '2c20c60aaa', at: '2026-09-02T16:40:00.000Z' } },
      { available: false, unavailableReason: 'Setup unavailable — no agent backend was found.' },
    ]) {
      cleanup()
      const { row } = renderRow(over)
      const text = row()?.textContent ?? ''
      expect(text.length).toBeGreaterThan(0)
      for (const forbidden of [/\.xezar/, /\bkit\b/i, /\bSDLC\b/, /\bworkflow/i, /\bskill/i]) {
        expect(text).not.toMatch(forbidden)
      }
    }
  })
})
