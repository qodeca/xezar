import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { chipSummaries, formatQuotaTime, quotaStatusSentence } from '@/lib/agent-quota'
import {
  agentQuotaProducerResponseSchema,
  agentQuotaResponseSchema,
  type AgentQuotaResponse,
  type BackendCheck,
} from '@qodeca/xezar-api-client'

import { AccountLimitsView, PlanLimitsBlock, type QuotaNameOf } from './account-limits'

/**
 * The answer #888 (S3) actually sends (#867 S5, review round 1 on #889, Major 2).
 *
 * The frozen fixture predates S3 and carries none of its fields, so this answer is built here and
 * validated with the STRICT producer schema first: every row below is a shape the server may emit
 * today, not one this test imagined. Each row pins one S3 value the cockpit must read rather than
 * re-derive — `nextCheckAt`, `stale`, `refreshing`, `source: check-text | none`, `statusReason`,
 * `warnings`, `toolVersion`/`minimumVersion` and `unavailableReason`. A last answer, validated with
 * the tolerant READER schema only, carries a `source` and a `statusReason` this cockpit does not
 * know: it must render as unknown and act on `status` alone.
 */

const GENERATED = '2026-09-22T14:24:00Z'
const NOW = Date.parse(GENERATED)
const NONE = ['shortWindow', 'weeklyWindow', 'modelWindows', 'credits', 'planType'] as const
const empty = {
  shortWindow: null,
  weeklyWindow: null,
  modelWindows: null,
  credits: null,
  planType: null,
  notReported: [...NONE],
}
const window5h = { usedPercent: 40, resetsAt: '2026-09-22T15:10:00Z', windowMinutes: 300 }
const weekly = { usedPercent: 10, resetsAt: '2026-09-28T17:00:00Z', windowMinutes: 10080 }
const s3 = { stale: false, refreshing: false, toolVersion: '2.1.300', minimumVersion: '2.1.278', statusReason: null, warnings: [], unavailableReason: null }

const S3_ANSWER: AgentQuotaResponse = agentQuotaResponseSchema.parse(
  agentQuotaProducerResponseSchema.parse({
    schemaVersion: 1,
    scope: 'agent-quota',
    generatedAt: GENERATED,
    accounts: [
      // The /usage text fallback: a check, held for 5 minutes by the SERVER's nextCheckAt.
      {
        runner: 'claude',
        accountId: 'text-row',
        status: 'ok',
        loginKind: 'subscription',
        observedAt: '2026-09-22T14:22:00Z',
        ageSeconds: 120,
        source: 'check-text',
        shortWindow: window5h,
        weeklyWindow: weekly,
        modelWindows: null,
        credits: null,
        planType: null,
        notReported: ['modelWindows', 'credits', 'planType'],
        ...s3,
        nextCheckAt: '2026-09-22T14:27:00Z',
        warnings: ['Quota was read from the Claude Code /usage text fallback.'],
      },
      // Never checked: the store's placeholder row. No check ran, so nothing is "checked 0m ago".
      {
        runner: 'claude',
        accountId: 'never',
        status: 'unknown',
        loginKind: 'unknown',
        observedAt: GENERATED,
        ageSeconds: 0,
        source: 'none',
        ...empty,
        ...s3,
        stale: true,
        toolVersion: null,
        nextCheckAt: null,
        unavailableReason: 'No quota check has completed yet.',
      },
      // A check 1 minute ago whose gap the server no longer holds (nextCheckAt: null, e.g. after a
      // restart): the cockpit must not invent a 5-minute hold from observedAt.
      {
        runner: 'claude',
        accountId: 'no-hold',
        status: 'ok',
        loginKind: 'subscription',
        observedAt: '2026-09-22T14:23:00Z',
        ageSeconds: 60,
        source: 'check',
        shortWindow: window5h,
        weeklyWindow: weekly,
        modelWindows: null,
        credits: null,
        planType: 'max',
        notReported: ['modelWindows', 'credits'],
        ...s3,
        nextCheckAt: null,
      },
      // The server says stale although the age is small, and a background check is running.
      {
        runner: 'claude',
        accountId: 'server-stale',
        status: 'ok',
        loginKind: 'subscription',
        observedAt: '2026-09-22T14:22:00Z',
        ageSeconds: 120,
        source: 'live',
        shortWindow: window5h,
        weeklyWindow: weekly,
        modelWindows: null,
        credits: null,
        planType: null,
        notReported: ['modelWindows', 'credits', 'planType'],
        ...s3,
        stale: true,
        refreshing: true,
        nextCheckAt: null,
      },
      {
        runner: 'claude',
        accountId: 'too-old',
        status: 'unknown',
        loginKind: 'unknown',
        observedAt: '2026-09-22T14:23:00Z',
        ageSeconds: 60,
        source: 'check',
        ...empty,
        ...s3,
        toolVersion: '2.1.200',
        nextCheckAt: '2026-09-22T14:28:00Z',
        statusReason: 'version-too-old',
        warnings: ['Update Claude Code to at least 2.1.278 to report limits.'],
        unavailableReason: 'Update Claude Code to at least 2.1.278 to report limits.',
      },
      {
        runner: 'claude',
        accountId: 'format',
        status: 'unknown',
        loginKind: 'unknown',
        observedAt: '2026-09-22T14:23:00Z',
        ageSeconds: 60,
        source: 'check',
        ...empty,
        ...s3,
        nextCheckAt: '2026-09-22T14:28:00Z',
        statusReason: 'format-changed',
        warnings: ['Claude Code 2.1.300 changed its quota format.'],
        unavailableReason: 'Claude Code 2.1.300 changed its quota format.',
      },
      {
        runner: 'codex',
        accountId: 'failed',
        status: 'unknown',
        loginKind: 'unknown',
        observedAt: '2026-09-22T14:23:00Z',
        ageSeconds: 60,
        source: 'check',
        ...empty,
        ...s3,
        toolVersion: '0.160.0',
        minimumVersion: '0.155.1',
        nextCheckAt: '2026-09-22T14:28:00Z',
        statusReason: 'check-failed',
        warnings: ['Codex quota check failed.'],
        unavailableReason: 'Codex quota check failed.',
      },
      {
        runner: 'codex',
        accountId: 'missing',
        status: 'unknown',
        loginKind: 'unknown',
        observedAt: '2026-09-22T14:23:00Z',
        ageSeconds: 60,
        source: 'check',
        ...empty,
        ...s3,
        toolVersion: null,
        minimumVersion: '0.155.1',
        nextCheckAt: '2026-09-22T14:28:00Z',
        statusReason: 'not-installed',
        warnings: ['Codex is not installed.'],
        unavailableReason: 'Codex is not installed.',
      },
      {
        runner: 'codex',
        accountId: 'key',
        status: 'unknown',
        loginKind: 'api-key',
        observedAt: '2026-09-22T14:23:00Z',
        ageSeconds: 60,
        source: 'check',
        ...empty,
        ...s3,
        minimumVersion: '0.155.1',
        nextCheckAt: '2026-09-22T14:28:00Z',
        statusReason: 'api-key',
        warnings: [],
        unavailableReason: 'API-key logins do not report plan limits.',
      },
    ],
  }),
)

/** A later server: a `source` and a `statusReason` this cockpit has never heard of. */
const FUTURE: AgentQuotaResponse = agentQuotaResponseSchema.parse({
  schemaVersion: 1,
  scope: 'agent-quota',
  generatedAt: GENERATED,
  accounts: [
    {
      runner: 'claude',
      accountId: 'future-ok',
      status: 'ok',
      loginKind: 'org-seat',
      observedAt: '2026-09-22T14:23:00Z',
      ageSeconds: 60,
      source: 'telepathy',
      shortWindow: window5h,
      weeklyWindow: weekly,
      modelWindows: null,
      credits: null,
      planType: null,
      notReported: ['modelWindows', 'credits', 'planType'],
      statusReason: 'moon-phase',
      nextCheckAt: null,
    },
    {
      runner: 'claude',
      accountId: 'future-unknown',
      status: 'unknown',
      loginKind: 'unknown',
      observedAt: '2026-09-22T14:23:00Z',
      ageSeconds: 60,
      source: 'telepathy',
      ...empty,
      statusReason: 'moon-phase',
      nextCheckAt: null,
    },
  ],
})

const AGENT = { claude: 'Claude Code', codex: 'Codex' } as const
const nameOf: QuotaNameOf = (_runner, accountId) => accountId
let posts = 0

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  posts = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') posts += 1
      return new Promise<never>(() => {})
    }),
  )
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function renderRows(answer: AgentQuotaResponse, showDetails = true) {
  const qc = createQueryClient()
  qc.setQueryData(queryKeys.health, { bootProject: 'boot', capabilities: { localHandoff: true }, checks: [] })
  qc.setQueryData(workspaceQueryKeys.agentQuota, answer)
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        {answer.accounts.map((account) => (
          <AccountLimitsView
            key={account.accountId}
            account={account}
            answer={answer}
            name={account.accountId}
            showDetails={showDetails}
            nameOf={nameOf}
          />
        ))}
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const row = (answer: AgentQuotaResponse, accountId: string) => {
  const account = answer.accounts.find((a) => a.accountId === accountId)!
  return screen.getByRole('group', { name: `Plan limits of ${accountId}, ${AGENT[account.runner]}` })
}
const statusOf = (el: HTMLElement) => el.querySelector('[data-slot="limit-status"]')?.textContent?.trim()
const metaOf = (el: HTMLElement) => el.querySelector('[data-slot="limit-meta-text"]')?.textContent ?? ''
const refreshOf = (el: HTMLElement) => within(el).queryByRole('button', { name: /^Refresh limits of/ })
const warningsOf = (el: HTMLElement) => [...el.querySelectorAll('[data-slot="limit-warning"]')].map((li) => li.textContent?.trim())
const detail = (el: HTMLElement, term: string) =>
  within(el.querySelector('[data-slot="account-limits-details"]') as HTMLElement).queryByText(term)?.nextElementSibling?.textContent

describe('S3 answer (#888): the cockpit reads what the server sends', () => {
  it('holds Refresh until the server’s nextCheckAt, not a gap derived from observedAt', () => {
    renderRows(S3_ANSWER, false)
    const text = row(S3_ANSWER, 'text-row')
    // check-text is a check: its hold comes from nextCheckAt (14:27), and it is described as one.
    expect(refreshOf(text)?.getAttribute('aria-disabled')).toBe('true')
    expect(metaOf(text)).toContain('checked 2m ago')
    expect(metaOf(text)).toContain(`next check allowed at ${formatQuotaTime('2026-09-22T14:27:00Z', NOW)}`)
    fireEvent.click(refreshOf(text)!)
    expect(posts).toBe(0)

    // nextCheckAt: null — the server holds nothing back, even one minute after a check.
    const open = row(S3_ANSWER, 'no-hold')
    expect(refreshOf(open)?.getAttribute('aria-disabled')).toBeNull()
    expect(metaOf(open)).not.toContain('next check allowed')
  })

  it('shows every warning the server sends, verbatim, and the fallback source in words', () => {
    renderRows(S3_ANSWER, false)
    expect(warningsOf(row(S3_ANSWER, 'text-row'))).toEqual(['Quota was read from the Claude Code /usage text fallback.'])
    expect(warningsOf(row(S3_ANSWER, 'no-hold'))).toEqual([])
  })

  it('says a never-checked login was not checked, and never calls it a zero-token check', () => {
    renderRows(S3_ANSWER)
    const never = row(S3_ANSWER, 'never')
    expect(statusOf(never)).toBe('Limits unknown — this login has not been checked yet.')
    expect(metaOf(never)).toContain('Not checked yet')
    expect(metaOf(never)).not.toContain('checked 0m ago')
    expect(never.textContent).not.toContain('It uses no model tokens')
    // The server's own reason is kept, in the details.
    expect(detail(never, 'Why the limits are unknown')).toBe('No quota check has completed yet.')
  })

  it('takes Stale and Checking… from the server’s stale and refreshing flags', () => {
    renderRows(S3_ANSWER, false)
    const busy = row(S3_ANSWER, 'server-stale')
    expect(busy.querySelector('[data-slot="limit-stale"]')?.textContent).toBe('Stale')
    const button = refreshOf(busy)!
    expect(button.textContent).toBe('Checking…')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    // stale: false from the server wins over the cockpit's own age rule.
    expect(row(S3_ANSWER, 'text-row').querySelector('[data-slot="limit-stale"]')).toBeNull()
  })

  it('words every statusReason, and offers no Refresh where a check cannot help', () => {
    renderRows(S3_ANSWER)
    const old = row(S3_ANSWER, 'too-old')
    expect(statusOf(old)).toBe('Limits unknown — update Claude Code to at least 2.1.278 to report limits.')
    expect(old.textContent).toContain('Claude Code 2.1.200 is installed.')
    expect(refreshOf(old)).toBeNull()

    expect(statusOf(row(S3_ANSWER, 'format'))).toBe(
      'Limits unknown — Claude Code 2.1.300 changed how it reports usage, so xezar cannot read it.',
    )
    expect(refreshOf(row(S3_ANSWER, 'format'))).not.toBeNull()

    const failed = row(S3_ANSWER, 'failed')
    expect(statusOf(failed)).toBe('Limits unknown — the last check failed.')
    expect(metaOf(failed)).toContain('tried 1m ago')
    expect(detail(failed, 'Tool version')).toBe('Codex 0.160.0 (limits need 0.155.1 or later)')

    const missing = row(S3_ANSWER, 'missing')
    expect(statusOf(missing)).toBe('Limits unknown — Codex is not installed on this machine.')
    expect(refreshOf(missing)).toBeNull()

    const key = row(S3_ANSWER, 'key')
    expect(statusOf(key)).toBe('Limits not reported — API-key logins do not report plan limits.')
    expect(refreshOf(key)).toBeNull()
    // A warning that only repeats the reason the status already gives is not printed twice.
    expect(warningsOf(failed)).toEqual([])
  })

  it('Refresh all is held only while every login that can be checked is held', () => {
    const qc = createQueryClient()
    qc.setQueryData(queryKeys.health, { bootProject: 'boot', capabilities: { localHandoff: true }, checks: [] })
    const held = {
      ...S3_ANSWER,
      accounts: S3_ANSWER.accounts.filter((a) => ['text-row', 'too-old', 'missing', 'key'].includes(a.accountId)),
    }
    qc.setQueryData(workspaceQueryKeys.agentQuota, held)
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <PlanLimitsBlock nameOf={nameOf} hosted={false} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const all = screen.getByRole('button', { name: /Refresh all/ })
    expect(all.getAttribute('aria-disabled')).toBe('true')
    expect(all.className).not.toMatch(/aria-disabled:opacity/)
    expect(document.body.textContent).toContain(`The next check is allowed at ${formatQuotaTime('2026-09-22T14:27:00Z', NOW)}.`)
  })
})

/**
 * #908 B-1: `get_usage` (no plan limits) and `auth status` (the login kind) are two processes that
 * can disagree. The row is worded from the login kind, so a subscription or unknown login never
 * calls itself an API key and keeps its Refresh. The rows are what the checker sends for that pair.
 */
const NO_LIMITS = (accountId: string, loginKind: 'subscription' | 'unknown') => ({
  runner: 'claude' as const,
  accountId,
  status: 'unknown' as const,
  loginKind,
  observedAt: '2026-09-22T14:17:00Z',
  ageSeconds: 420,
  source: 'check' as const,
  ...empty,
  ...s3,
  nextCheckAt: '2026-09-22T14:22:00Z',
  statusReason: 'api-key' as const,
  warnings: ['Claude Code reported no plan limits for this login.'],
  unavailableReason: 'Claude Code reported no plan limits for this login.',
})
const MISMATCHED: AgentQuotaResponse = agentQuotaResponseSchema.parse(
  agentQuotaProducerResponseSchema.parse({
    schemaVersion: 1,
    scope: 'agent-quota',
    generatedAt: GENERATED,
    accounts: [NO_LIMITS('sub-no-limits', 'subscription'), NO_LIMITS('unknown-no-limits', 'unknown')],
  }),
)

describe('a login that reported no plan limits is worded from its login kind (#908 B-1)', () => {
  it('never calls a subscription or unknown login an API key, and keeps its Refresh', () => {
    renderRows(MISMATCHED)
    for (const [accountId, kind] of [
      ['sub-no-limits', 'Subscription'],
      ['unknown-no-limits', 'Unknown — Claude Code did not say'],
    ] as const) {
      const el = row(MISMATCHED, accountId)
      expect(statusOf(el)).toBe('Limits not reported — Claude Code reported no plan limits for this login.')
      expect(detail(el, 'Login kind')).toBe(kind)
      expect(detail(el, 'Why the limits are unknown')).toBe('Claude Code reported no plan limits for this login.')
      expect(el.textContent).not.toMatch(/API.key/i)
      expect(refreshOf(el)).not.toBeNull()
    }
  })

  it('keeps the API-key words and withholds Refresh only for an api-key login', () => {
    renderRows(S3_ANSWER)
    const key = row(S3_ANSWER, 'key')
    expect(detail(key, 'Login kind')).toBe('API key — plan limits do not apply')
    expect(statusOf(key)).toBe('Limits not reported — API-key logins do not report plan limits.')
    expect(refreshOf(key)).toBeNull()
  })
})

describe('an unknown source or statusReason renders as unknown and acts only on status', () => {
  it('keeps Can work for status ok and Limits unknown for status unknown', () => {
    renderRows(FUTURE)
    const ok = row(FUTURE, 'future-ok')
    expect(statusOf(ok)).toBe('Can work')
    expect(metaOf(ok)).toContain('read 1m ago, from a source this cockpit does not know')
    expect(ok.textContent).not.toContain('It uses no model tokens')

    const unknown = row(FUTURE, 'future-unknown')
    expect(statusOf(unknown)).toBe('Limits unknown — Claude Code did not say whether this login can work.')
  })

  it('names a loginKind this cockpit does not know as sent, never as a subscription', () => {
    renderRows(FUTURE)
    expect(detail(row(FUTURE, 'future-ok'), 'Login kind')).toBe('“org-seat”, a kind this version of the cockpit does not know')
    expect(detail(row(FUTURE, 'future-unknown'), 'Login kind')).toBe('Unknown — Claude Code did not say')
  })

  it('does not guess at an unknown statusReason on a known source', () => {
    const account = { ...FUTURE.accounts[1]!, source: 'check' }
    expect(quotaStatusSentence(account, 60, NOW)).toMatchObject({
      word: 'Limits unknown',
      reason: '— Claude Code did not say whether this login can work.',
    })
  })

  it('never counts unknown as a login that can work', () => {
    const checks = [{ name: 'claude', available: true }] as BackendCheck[]
    // A loginKind this cockpit does not know is never a subscription (#867 AC-36): no chip for it.
    expect(chipSummaries(FUTURE, checks, NOW)).toEqual([])
    const subscribed = { ...FUTURE, accounts: FUTURE.accounts.map((row) => ({ ...row, loginKind: 'subscription' })) }
    expect(chipSummaries(subscribed, checks, NOW)[0]).toMatchObject({ total: 2, canWork: 1 })
    expect(chipSummaries(S3_ANSWER, checks, NOW)[0]).toMatchObject({ canWork: 3 })
  })
})
