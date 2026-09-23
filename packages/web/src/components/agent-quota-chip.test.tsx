import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { agentQuotaResponseSchema, type AgentQuotaResponse } from '@qodeca/xezar-api-client'
// A test-only reach into the contract package for its committed fixture (AGENTS.md: ugly on purpose).
import fixtureJson from '../../../contract/src/__fixtures__/agent-quota.expected.json'

import { AgentQuotaChip } from './agent-quota-chip'

/**
 * The plan-limits chip (#867 FR-11, AC-36, D38): only applicable agents, `canWork/total` with a dot
 * AND words, a Popover that leads to Settings → Agent accounts, and no chip at all when nothing
 * applies or nothing is known.
 */

const FIXTURE: AgentQuotaResponse = agentQuotaResponseSchema.parse(fixtureJson)
const NOW = Date.parse(FIXTURE.generatedAt)

type Checks = Array<{ name: string; available: boolean }>
const BOTH: Checks = [
  { name: 'claude', available: true },
  { name: 'codex', available: true },
]

function Where() {
  const location = useLocation()
  return <output data-testid="where">{`${location.pathname}${location.hash}`}</output>
}

type ProfileRow = { provider: string; id: string; label: string; isDefault: boolean }

function mount(
  variant: 'band' | 'phone',
  { answer, checks = BOTH, profiles }: { answer?: AgentQuotaResponse; checks?: Checks | null; profiles?: ProfileRow[] },
) {
  const qc = createQueryClient()
  qc.setDefaultOptions({ queries: { ...qc.getDefaultOptions().queries, retry: false } })
  qc.setQueryData(queryKeys.health, {
    bootProject: 'boot',
    capabilities: { localHandoff: true },
    ...(checks ? { checks } : {}),
  })
  if (answer) qc.setQueryData(workspaceQueryKeys.agentQuota, answer)
  if (profiles) qc.setQueryData(workspaceQueryKeys.agentProfiles, { editable: true, profiles })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/p/boot/tasks']}>
        <Routes>
          <Route path="*" element={<><AgentQuotaChip variant={variant} /><Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const chip = () => document.querySelector('[data-slot="agent-quota-chip"]') as HTMLElement | null

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  // Every read here is a seeded cache: a request would mean the chip fetched on its own.
  vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('AgentQuotaChip', () => {
  it('desktop: one segment per applicable agent, a dot and the count in words', () => {
    mount('band', { answer: FIXTURE })
    const segments = [...document.querySelectorAll('[data-slot="agent-quota-segment"]')]
    expect(segments.map((s) => s.textContent)).toEqual(['Claude Code1/3', 'Codex1/2'])
    expect(segments.map((s) => s.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone'))).toEqual([
      'pending',
      'pending',
    ])
    expect(chip()?.getAttribute('aria-label')).toBe('Logins that can work now: Claude Code 1 of 3, Codex 1 of 2. Show details')
    expect(document.querySelector('[data-slot="agent-quota-band"]')).not.toBeNull()
  })

  it('phone: one combined count with the worst tone', () => {
    mount('phone', { answer: FIXTURE })
    expect(chip()?.textContent).toBe('2/5can work')
    expect(chip()?.getAttribute('aria-label')).toBe('2 of 5 logins can work now. Show details')
    // No band on a phone: the top bar is its home.
    expect(document.querySelector('[data-slot="agent-quota-band"]')).toBeNull()
  })

  it('leaves out an agent that is not installed (D38)', () => {
    mount('band', { answer: FIXTURE, checks: [{ name: 'claude', available: true }, { name: 'codex', available: false }] })
    expect([...document.querySelectorAll('[data-slot="agent-quota-segment"]')].map((s) => s.getAttribute('data-runner'))).toEqual([
      'claude',
    ])
  })

  it('renders nothing when no agent applies, before the answer, or before health says what is installed', () => {
    mount('band', { answer: { ...FIXTURE, accounts: FIXTURE.accounts.filter((a) => a.accountId === 'api-key') } })
    expect(chip()).toBeNull()
    cleanup()
    mount('band', {})
    expect(chip()).toBeNull()
    cleanup()
    mount('band', { answer: FIXTURE, checks: null })
    expect(chip()).toBeNull()
    expect(document.querySelector('[data-slot="agent-quota-band"]')).toBeNull()
  })

  it('opens a Popover naming the logins that are out or unknown, and links to the Plan limits block', () => {
    mount('band', { answer: FIXTURE })
    fireEvent.click(chip()!)
    const pop = document.querySelector('[data-slot="agent-quota-popover"]') as HTMLElement
    expect(pop).not.toBeNull()
    expect(pop.textContent).toContain('Claude Code: 1 of 3 logins can work.')
    expect(pop.textContent).toContain('quota-exhausted — out until')
    expect(pop.textContent).toContain('work — limits unknown')
    expect(pop.textContent).toContain('api-key — limits unknown')
    expect(pop.textContent).toContain('xezar shows these limits and never acts on them.')
    expect(chip()?.getAttribute('aria-label')).toMatch(/Hide details$/)
    act(() => {
      fireEvent.click(screen.getByRole('link', { name: 'Open agent accounts' }))
    })
    expect(screen.getByTestId('where').textContent).toBe('/settings/global/accounts#limits')
  })

  it('names a login by the pane’s own account name when the listing is known', () => {
    mount('band', {
      answer: FIXTURE,
      profiles: [
        { provider: 'claude', id: 'quota-exhausted', label: 'Personal', isDefault: false },
        { provider: 'claude', id: 'work', label: 'me@example.com', isDefault: false },
      ],
    })
    fireEvent.click(chip()!)
    const text = document.querySelector('[data-slot="agent-quota-popover"]')?.textContent ?? ''
    expect(text).toContain('Personal — out until')
    // A label that reads as an e-mail address is never printed (the pane's own rule).
    expect(text).toContain('Name hidden — limits unknown')
    expect(text).not.toContain('me@example.com')
  })

  it('says “stale” when every reading is over 15 minutes old', () => {
    vi.setSystemTime(NOW + 20 * 60_000)
    mount('band', { answer: FIXTURE })
    expect(chip()?.textContent).toContain('stale')
    expect(chip()?.getAttribute('aria-label')).toContain('stale, every reading is over 15 minutes old')
  })
})
