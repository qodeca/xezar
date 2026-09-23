import { describe, expect, it } from 'vitest'

import { agentQuotaResponseSchema, type AgentQuotaAccount, type AgentQuotaResponse, type BackendCheck } from '@qodeca/xezar-api-client'
// A test-only reach into the contract package for its committed fixture (AGENTS.md: ugly on purpose).
import fixtureJson from '../../../contract/src/__fixtures__/agent-quota.expected.json'

import {
  ageText,
  chipSummaries,
  creditsText,
  formatQuotaTime,
  isQuotaStale,
  nextCheckAllowedAt,
  quotaLoginName,
  notReportedWords,
  quotaAgeSeconds,
  quotaStatusSentence,
  quotaWindowLines,
  sourceText,
  summarizeAgent,
  worstTone,
} from './agent-quota'

/** The owner-approved frozen answer (#867 D33) — the one shape every surface agrees on. */
const FIXTURE: AgentQuotaResponse = agentQuotaResponseSchema.parse(fixtureJson)

const NOW = Date.parse(FIXTURE.generatedAt)
const row = (runner: string, accountId: string): AgentQuotaAccount => {
  const found = FIXTURE.accounts.find((a) => a.runner === runner && a.accountId === accountId)
  if (!found) throw new Error(`fixture has no ${runner}/${accountId}`)
  return found
}
const check = (name: string, available: boolean): BackendCheck => ({ name, available }) as BackendCheck

describe('formatQuotaTime (#867 D32: zone name and offset on every value)', () => {
  it('says the clock, zone and offset for a time today', () => {
    expect(formatQuotaTime('2026-09-22T15:10:00Z', NOW, 'Europe/Warsaw')).toBe('17:10 CEST (+02:00)')
  })

  it('adds the day for another day', () => {
    expect(formatQuotaTime('2026-09-28T17:00:00Z', NOW, 'Europe/Warsaw')).toBe('Sep 28, 19:00 CEST (+02:00)')
  })

  it('keeps each value’s own offset across a DST change', () => {
    expect(formatQuotaTime('2026-10-26T12:00:00Z', NOW, 'Europe/Warsaw')).toBe('Oct 26, 13:00 CET (+01:00)')
  })

  it('reads UTC as UTC and an unparseable value as nothing', () => {
    expect(formatQuotaTime('2026-09-22T15:10:00Z', NOW, 'UTC')).toBe('15:10 UTC (+00:00)')
    expect(formatQuotaTime('not a time', NOW, 'UTC')).toBe('')
  })
})

describe('ages, staleness and the refresh gap', () => {
  it('is the answer’s ageSeconds when read at generatedAt, and keeps counting after', () => {
    expect(quotaAgeSeconds(row('claude', 'default'), FIXTURE.generatedAt, NOW)).toBe(240)
    expect(quotaAgeSeconds(row('claude', 'default'), FIXTURE.generatedAt, NOW + 60_000)).toBe(300)
    expect(ageText(240)).toBe('4m')
  })

  it('marks a reading stale only past 15 minutes', () => {
    expect(isQuotaStale(900)).toBe(false)
    expect(isQuotaStale(901)).toBe(true)
  })

  it('holds the next check 5 minutes after a CHECK, and never after a failed task', () => {
    expect(nextCheckAllowedAt(row('claude', 'default'))).toBe(Date.parse('2026-09-22T14:25:00Z'))
    expect(nextCheckAllowedAt(row('claude', 'quota-exhausted'))).toBeNull()
  })
})

describe('window lines', () => {
  it('names every window the answer carries, in order, and no other', () => {
    expect(quotaWindowLines(row('claude', 'default'))).toEqual([
      { key: 'short', label: '5-hour window', usedPercent: 92, resetsAt: '2026-09-22T15:10:00Z' },
      { key: 'weekly', label: 'Weekly, all models', usedPercent: 26, resetsAt: '2026-09-28T17:00:00Z' },
      { key: 'model-0', label: 'Weekly, Fable', usedPercent: 29, resetsAt: '2026-09-28T17:00:00Z' },
    ])
    expect(quotaWindowLines(row('codex', 'default')).map((l) => l.label)).toEqual(['Weekly'])
    expect(quotaWindowLines(row('claude', 'work'))).toEqual([])
  })
})

describe('status sentence, credits, source and not reported', () => {
  it('reads status from the answer, never from the numbers', () => {
    // 92 % of the 5-hour window, and still `ok`: the cockpit does not invent a warning status.
    expect(quotaStatusSentence(row('claude', 'default'), 240, NOW)).toMatchObject({ tone: 'success', word: 'Can work' })
    const out = quotaStatusSentence(row('claude', 'quota-exhausted'), 300, NOW)
    expect(out.tone).toBe('danger')
    expect(out.word).toBe(`Out until ${formatQuotaTime('2026-09-22T15:10:00Z', NOW)}`)
    expect(out.reason).toBe('— a task under this login stopped on the usage limit 5m ago.')
    expect(quotaStatusSentence(row('claude', 'work'), 180, NOW)).toMatchObject({
      tone: 'neutral',
      word: 'Limits unknown',
      reason: '— Claude Code reported no limits for this login.',
    })
  })

  it('prints Codex credits as reported', () => {
    expect(creditsText(row('codex', 'default'))).toBe('none — balance 0.')
    expect(creditsText(row('claude', 'default'))).toBeNull()
  })

  it('says where each reading came from', () => {
    expect(sourceText(row('claude', 'default'), 240)).toBe('checked 4m ago')
    expect(sourceText(row('claude', 'quota-exhausted'), 300)).toBe('from a failed task 5m ago')
    expect(sourceText({ ...row('claude', 'default'), source: 'live' }, 60)).toBe('seen 1m ago in a running task')
  })

  it('names every notReported field in words, and an unknown name as sent', () => {
    expect(notReportedWords(row('claude', 'default'))).toEqual(['credits', 'plan'])
    expect(notReportedWords({ ...row('claude', 'default'), notReported: ['credits', 'planType', 'spendLimit'] })).toEqual([
      'credits',
      'plan',
      'spendLimit',
    ])
  })
})

describe('the per-agent summary (D30) and the chip (D38)', () => {
  it('counts the rows’ status', () => {
    expect(summarizeAgent(FIXTURE, 'claude', NOW)).toMatchObject({
      total: 3,
      canWork: 1,
      tone: 'pending',
      text: 'Claude Code: 1 of 3 logins can work.',
    })
    expect(summarizeAgent(FIXTURE, 'codex', NOW)).toMatchObject({ total: 2, canWork: 1, text: 'Codex: 1 of 2 logins can work.' })
  })

  it('names the first free time when no login can work', () => {
    const allOut: AgentQuotaResponse = { ...FIXTURE, accounts: [row('claude', 'quota-exhausted')] }
    expect(summarizeAgent(allOut, 'claude', NOW)).toMatchObject({
      tone: 'danger',
      text: `Claude Code: 0 of 1 login can work; first free at ${formatQuotaTime('2026-09-22T15:10:00Z', NOW)}.`,
    })
  })

  it('shows an agent only when it is installed and has a subscription login (#867 AC-36)', () => {
    const both = [check('claude', true), check('codex', true)]
    expect(chipSummaries(FIXTURE, both, NOW).map((s) => s.runner)).toEqual(['claude', 'codex'])
    expect(chipSummaries(FIXTURE, [check('claude', true), check('codex', false)], NOW).map((s) => s.runner)).toEqual(['claude'])
    // An API-key login: no segment.
    const apiKey: AgentQuotaResponse = { ...FIXTURE, accounts: [row('codex', 'api-key')] }
    expect(chipSummaries(apiKey, both, NOW)).toEqual([])
    // A login of unknown kind is never read as a subscription — even one that is out or reports a
    // plan (the old rule inferred a subscription from exactly those facts).
    const unknownKind: AgentQuotaResponse = {
      ...FIXTURE,
      accounts: [row('claude', 'quota-exhausted'), { ...row('codex', 'default'), loginKind: 'unknown' }],
    }
    expect(chipSummaries(unknownKind, both, NOW)).toEqual([])
    // A subscription login that reported nothing yet still counts: the kind decides, not the facts.
    const quietSubscription: AgentQuotaResponse = {
      ...FIXTURE,
      accounts: [{ ...row('claude', 'work'), loginKind: 'subscription' }],
    }
    expect(chipSummaries(quietSubscription, both, NOW)).toMatchObject([{ runner: 'claude', total: 1, canWork: 0 }])
    // Unknown answer or unknown install state: no chip rather than a guess.
    expect(chipSummaries(undefined, both, NOW)).toEqual([])
    expect(chipSummaries(FIXTURE, undefined, NOW)).toEqual([])
  })

  it('takes the worst tone for the phone chip', () => {
    expect(worstTone(['success', 'pending'])).toBe('pending')
    expect(worstTone(['success', 'danger', 'pending'])).toBe('danger')
    expect(worstTone(['neutral'])).toBe('neutral')
  })
})

describe('quotaLoginName', () => {
  const listing = [
    { provider: 'claude' as const, id: 'default', isDefault: true, label: 'Default' },
    { provider: 'claude' as const, id: 'work', isDefault: false, label: 'Work' },
    { provider: 'claude' as const, id: 'mail', isDefault: false, label: 'me@example.com' },
  ]
  it('uses the pane’s own name when the listing has the account', () => {
    expect(quotaLoginName(listing, 'claude', 'default')).toBe('Built-in login')
    expect(quotaLoginName(listing, 'claude', 'work')).toBe('Work')
    expect(quotaLoginName(listing, 'claude', 'mail')).toBe('Name hidden')
  })
  it('falls back to the answer’s id under the same rules (hosted mode has no listing)', () => {
    expect(quotaLoginName(undefined, 'codex', 'default')).toBe('Built-in login')
    expect(quotaLoginName(undefined, 'codex', 'api-key')).toBe('api-key')
    expect(quotaLoginName(undefined, 'codex', 'me@example.com')).toBe('Name hidden')
  })
})
