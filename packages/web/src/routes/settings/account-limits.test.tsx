import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { formatQuotaTime } from '@/lib/agent-quota'
import { agentQuotaResponseSchema, type AgentQuotaAccount, type AgentQuotaResponse } from '@qodeca/xezar-api-client'
// A test-only reach into the contract package for its committed fixture (AGENTS.md: ugly on purpose).
import fixtureJson from '../../../../contract/src/__fixtures__/agent-quota.expected.json'

import { AccountLimitsView, HostedQuotaRows, PlanLimitsBlock, type QuotaNameOf } from './account-limits'

/**
 * Plan limits in Settings → Agent accounts (#867 S5).
 *
 * The first block is AC-37 / D37 — "the cockpit renders exactly the fields and values of the
 * answer": every row of the owner-approved frozen fixture, every value it carries, and nothing it
 * does not. The expected values are read from the RAW fixture JSON, not through the cockpit's own
 * helpers, so a helper that dropped or invented a value cannot vouch for itself. Times go through
 * `formatQuotaTime` because the zone they are printed in is the reader's (a display choice, pinned
 * in lib/agent-quota.test.ts).
 */

const FIXTURE: AgentQuotaResponse = agentQuotaResponseSchema.parse(fixtureJson)
const RAW = fixtureJson as unknown as {
  accounts: Array<{
    runner: 'claude' | 'codex'
    accountId: string
    status: 'ok' | 'out' | 'unknown'
    resetsAt?: string
    checkedAt: string
    ageSeconds: number
    source: string
    shortWindow: { usedPercent: number; resetsAt: string } | null
    weeklyWindow: { usedPercent: number; resetsAt: string } | null
    modelWindows: Array<{ model: string; usedPercent: number; resetsAt: string }> | null
    credits: { hasCredits: boolean; unlimited: boolean; balance: string } | null
    planType: string | null
    notReported: string[]
  }>
}
const NOW = Date.parse(FIXTURE.generatedAt)
const AGENT = { claude: 'Claude Code', codex: 'Codex' } as const
const nameOf: QuotaNameOf = (_runner, accountId) => (accountId === 'default' ? 'Built-in login' : accountId)
const NOT_REPORTED: Record<string, string> = {
  shortWindow: 'short window',
  weeklyWindow: 'weekly window',
  modelWindows: 'per-model windows',
  credits: 'credits',
  planType: 'plan',
}

let requests: Array<{ method: string; url: string; body?: unknown }> = []
let refreshAnswer: AgentQuotaResponse = FIXTURE

function stubFetch() {
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url === '/api/v1/workspace/agent-quota/refresh' && method === 'POST') {
        return new Response(JSON.stringify(refreshAnswer), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Promise<never>(() => {})
    }),
  )
}

function client(answer?: AgentQuotaResponse): QueryClient {
  const qc = createQueryClient()
  qc.setDefaultOptions({ queries: { ...qc.getDefaultOptions().queries, retry: false } })
  qc.setQueryData(queryKeys.health, {
    bootProject: 'boot',
    capabilities: { localHandoff: true },
    checks: [
      { name: 'claude', available: true },
      { name: 'codex', available: true },
    ],
  })
  if (answer) qc.setQueryData(workspaceQueryKeys.agentQuota, answer)
  return qc
}

function mount(ui: ReactNode, qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/global/accounts']}>
        {ui}
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const group = (account: { runner: 'claude' | 'codex'; accountId: string }) =>
  screen.getByRole('group', { name: `Plan limits of ${nameOf(account.runner, account.accountId)}, ${AGENT[account.runner]}` })

const ageWords = (seconds: number) => `${Math.floor(seconds / 60)}m`

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  refreshAnswer = FIXTURE
  stubFetch()
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function renderEveryRow(answer: AgentQuotaResponse, showDetails = true) {
  const qc = client(answer)
  mount(
    <>
      {answer.accounts.map((account) => (
        <AccountLimitsView
          key={`${account.runner}:${account.accountId}`}
          account={account}
          answer={answer}
          name={nameOf(account.runner, account.accountId)}
          showDetails={showDetails}
          nameOf={nameOf}
        />
      ))}
    </>,
    qc,
  )
}

describe('AC-37: for one answer, the cockpit renders exactly its fields and values', () => {
  it('renders every row of the frozen fixture with every value it carries and no other', () => {
    renderEveryRow(FIXTURE)

    for (const raw of RAW.accounts) {
      const el = group(raw)
      const text = el.textContent ?? ''

      // status — from `status`, and for `out` the answer's own `resetsAt`.
      const word = raw.status === 'ok' ? 'Can work' : raw.status === 'out' ? `Out until ${formatQuotaTime(raw.resetsAt!, NOW)}` : 'Limits unknown'
      expect(el.querySelector('[data-slot="limit-status"] b')?.textContent).toBe(word)
      expect(el.getAttribute('data-quota-status')).toBe(raw.status)

      // windows — exactly the ones the answer carries, each with its percent and its reset.
      const windows = [raw.shortWindow, raw.weeklyWindow, ...(raw.modelWindows ?? [])].filter((w) => w !== null)
      const lines = [...el.querySelectorAll('[data-slot="limit-window"]')]
      expect(lines).toHaveLength(windows.length)
      windows.forEach((window, index) => {
        expect(lines[index]?.querySelector('[data-slot="limit-window-used"]')?.textContent).toBe(`${window.usedPercent}% used`)
        expect(lines[index]?.querySelector('[data-slot="limit-window-reset"]')?.textContent).toBe(
          `resets ${formatQuotaTime(window.resetsAt, NOW)}`,
        )
      })
      for (const model of raw.modelWindows ?? []) expect(text).toContain(model.model)
      // No percentage appears that the answer does not carry (AQ-3).
      expect([...text.matchAll(/(\d+(?:\.\d+)?)% used/g)].map((m) => Number(m[1]))).toEqual(windows.map((w) => w.usedPercent))

      // credits — Codex's object as reported; nothing when the answer has none.
      const credits = el.querySelector('[data-slot="limit-credits"]')
      if (raw.credits) {
        expect(credits?.textContent).toContain(`balance ${raw.credits.balance}`)
        expect(text).toContain(raw.credits.hasCredits ? 'available' : 'none available')
        expect(text).toContain(raw.credits.unlimited ? 'unlimited' : 'not unlimited')
      } else {
        expect(credits).toBeNull()
      }

      // plan, source and age.
      const meta = el.querySelector('[data-slot="limit-meta-text"]')?.textContent ?? ''
      expect(meta).toContain(`Plan: ${raw.planType ?? '—'}`)
      const sourceWords =
        raw.source === 'failedRun' ? `from a failed task ${ageWords(raw.ageSeconds)} ago` : `checked ${ageWords(raw.ageSeconds)} ago`
      expect(meta).toContain(sourceWords)
      expect(text).toContain(formatQuotaTime(raw.checkedAt, NOW))

      // every notReported field, in words, under "Not reported by <agent>".
      const details = within(el.querySelector('[data-slot="account-limits-details"]') as HTMLElement)
      const term = details.getByText(`Not reported by ${AGENT[raw.runner]}`)
      expect(term.nextElementSibling?.textContent).toBe(raw.notReported.map((f) => NOT_REPORTED[f]).join(', '))

      // Fresh fixture: no row is stale.
      expect(el.querySelector('[data-slot="limit-stale"]')).toBeNull()
    }
  })

  it('shows one D30 summary line per agent, from the rows’ status, with a jump to the login that is out', () => {
    mount(<PlanLimitsBlock nameOf={nameOf} hosted={false} />, client(FIXTURE))
    const lines = [...document.querySelectorAll('[data-slot="agent-quota-summary-lines"] > li')]
    expect(lines.map((li) => li.getAttribute('data-runner'))).toEqual(['claude', 'codex'])
    expect(lines[0]?.textContent).toBe(
      `Claude Code: 1 of 3 logins can work. quota-exhausted is out until ${formatQuotaTime('2026-09-22T15:10:00Z', NOW)}.`,
    )
    expect(lines[1]?.textContent).toBe('Codex: 1 of 2 logins can work.')
    expect(screen.getByRole('link', { name: 'quota-exhausted' }).getAttribute('href')).toBe('#limits-claude-quota-exhausted')
    // The live region is a wrapper, never the list itself (design review B-1 on #870).
    const list = document.querySelector('[data-slot="agent-quota-summary-lines"]')
    expect(list?.getAttribute('role')).toBeNull()
    expect(list?.parentElement?.getAttribute('role')).toBe('status')
    expect(screen.getByText(/never switches logins, holds a task back or changes auto-resume/)).toBeTruthy()
  })
})

describe('row states', () => {
  it('marks a reading older than 15 minutes Stale, with its age', () => {
    const stale = { ...FIXTURE, accounts: [{ ...FIXTURE.accounts[0]!, ageSeconds: 1200 }] } as AgentQuotaResponse
    renderEveryRow(stale, false)
    const el = group({ runner: 'claude', accountId: 'default' })
    expect(el.querySelector('[data-slot="limit-stale"]')?.textContent).toBe('Stale')
    expect(el.textContent).toContain('checked 20m ago — the numbers may have moved since')
  })

  it('says why a login with no limit lines has none, and draws no bar', () => {
    renderEveryRow(FIXTURE, false)
    const el = group({ runner: 'claude', accountId: 'qodeca-priv' })
    expect(el.textContent).toContain('Claude Code reported no limits for this login.')
    expect(el.textContent).toContain('Tasks can still start under this login.')
    expect(el.querySelector('[data-slot="usage-bar"]')).toBeNull()
  })

  it('tints the bar amber from 80 % and red at 100 %, always beside its number', () => {
    const row = FIXTURE.accounts[0] as AgentQuotaAccount
    const full = { ...row, status: 'out', resetsAt: '2026-09-22T15:10:00Z', shortWindow: { ...row.shortWindow!, usedPercent: 100 } }
    renderEveryRow({ ...FIXTURE, accounts: [full as AgentQuotaAccount] }, false)
    const bars = [...document.querySelectorAll('[data-slot="usage-bar"]')].map((bar) => bar.getAttribute('data-tone'))
    expect(bars).toEqual(['danger', 'neutral', 'neutral'])
    expect(document.body.textContent).toContain('— the 5-hour limit is used up.')
  })
})

describe('Refresh', () => {
  it('is aria-disabled inside the 5-minute gap, says when the next check is allowed, and sends nothing', () => {
    renderEveryRow(FIXTURE, false)
    const el = group({ runner: 'claude', accountId: 'default' })
    const button = within(el).getByRole('button', { name: 'Refresh limits of Built-in login, Claude Code' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    const reason = document.getElementById(button.getAttribute('aria-describedby') ?? '')
    expect(reason?.textContent).toContain(`next check allowed at ${formatQuotaTime('2026-09-22T14:25:00Z', NOW)}`)
    fireEvent.click(button)
    expect(requests.filter((r) => r.method === 'POST')).toEqual([])
  })

  it('posts the contract selector for one login and reports what came back', async () => {
    const moved = FIXTURE.accounts.map((a) =>
      a.accountId === 'quota-exhausted' ? { ...a, checkedAt: '2026-09-22T14:24:00Z', ageSeconds: 0 } : a,
    )
    refreshAnswer = { ...FIXTURE, accounts: moved as AgentQuotaAccount[] }
    renderEveryRow(FIXTURE, false)
    const el = group({ runner: 'claude', accountId: 'quota-exhausted' })
    const button = within(el).getByRole('button', { name: 'Refresh limits of quota-exhausted, Claude Code' })
    // A failed task is not a check, so nothing holds this one back.
    expect(button.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(button)
    await waitFor(() =>
      expect(requests).toContainEqual({
        method: 'POST',
        url: '/api/v1/workspace/agent-quota/refresh',
        body: { provider: 'claude', accountId: 'quota-exhausted' },
      }),
    )
    await screen.findByText('Refreshed the limits of quota-exhausted')
  })

  it('opens again once the gap has passed, and Refresh all posts {}', async () => {
    vi.setSystemTime(NOW + 6 * 60_000)
    mount(<PlanLimitsBlock nameOf={nameOf} hosted={false} />, client(FIXTURE))
    const all = screen.getByRole('button', { name: /Refresh all/ })
    expect(all.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(all)
    await waitFor(() => expect(requests).toContainEqual({ method: 'POST', url: '/api/v1/workspace/agent-quota/refresh', body: {} }))
  })
})

describe('the Plan limits block’s other states', () => {
  it('says it is loading, with no summary and no Refresh all', () => {
    mount(<PlanLimitsBlock nameOf={nameOf} hosted={false} />, client())
    expect(screen.getByText('Loading plan limits…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Refresh all/ })).toBeNull()
  })

  it('says there is nothing to show when no login is known', () => {
    mount(<PlanLimitsBlock nameOf={nameOf} hosted={false} />, client({ ...FIXTURE, accounts: [] }))
    expect(screen.getByText('No plan limits to show')).toBeTruthy()
  })

  it('hosted: names each login and its limits with no folder, and says how the page stays current', () => {
    const qc = client(FIXTURE)
    mount(
      <>
        <PlanLimitsBlock nameOf={nameOf} hosted />
        <HostedQuotaRows nameOf={nameOf} />
      </>,
      qc,
    )
    expect(screen.getByText(/reads the limits again when the server reports a change/)).toBeTruthy()
    expect(document.querySelectorAll('[data-slot="account-row"]')).toHaveLength(FIXTURE.accounts.length)
    expect(document.querySelector('[data-slot="account-path"]')).toBeNull()
  })
})
