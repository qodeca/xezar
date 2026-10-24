import { afterEach, describe, expect, it } from 'vitest'

import { normalizeJs, quotaClockJs } from '../e2e/capture/page-scripts'

/**
 * The docs capture harness's page scripts (`e2e/capture/page-scripts.ts`) run inside the capture
 * browser, as strings. These run the same strings against jsdom, so a rewrite that changes what a
 * published picture says is caught here rather than in a design review of the pictures.
 */

const evaluate = (js: string): unknown => (0, eval)(js)

function normalized(text: string): string {
  document.body.innerHTML = ''
  const node = document.createElement('p')
  node.textContent = text
  document.body.appendChild(node)
  evaluate(normalizeJs('/capture-test/workspace', '/capture-test/home'))
  return node.textContent ?? ''
}

describe('normalizeJs clock times (#1173)', () => {
  it('pins a clock time but keeps the UTC offset printed beside it', () => {
    expect(normalized('09:30 CEST (+02:00)')).toBe('09:30 CEST (+02:00)')
    expect(normalized('is out until 17:10 CEST (+02:00).')).toBe('is out until 09:30 CEST (+02:00).')
    expect(normalized('Sep 28, 19:00 EDT (-04:00)')).toBe('Sep 28, 09:30 EDT (-04:00)')
  })

  it('keeps an offset written with UTC or GMT in front of it', () => {
    expect(normalized('14:24 UTC+05:30')).toBe('09:30 UTC+05:30')
    expect(normalized('14:24 GMT-03:00')).toBe('09:30 GMT-03:00')
  })

  it('still pins clock times that carry seconds or AM/PM, and leaves ISO timestamps to their own rule', () => {
    expect(normalized('started 14:24:07')).toBe('started 09:30')
    expect(normalized('at 2:24 PM')).toBe('at 09:30')
    expect(normalized('2026-10-24T14:24:07Z')).toBe('2026-09-15T08:40:00Z')
  })
})

describe('quotaClockJs (#1172)', () => {
  const original = JSON.parse
  afterEach(() => {
    JSON.parse = original
  })

  const frozen = {
    schemaVersion: 1,
    scope: 'agent-quota',
    generatedAt: '2026-09-22T14:24:00Z',
    accounts: [
      {
        runner: 'claude',
        accountId: 'quota-exhausted',
        status: 'out',
        resetsAt: '2026-09-22T15:10:00Z',
        observedAt: '2026-09-22T14:19:00Z',
        ageSeconds: 300,
        shortWindow: { usedPercent: 92, resetsAt: '2026-09-22T15:10:00Z', windowMinutes: 300 },
        modelWindows: [{ model: 'Fable', resetsAt: '2026-09-28T17:00:00Z' }],
      },
    ],
  }

  it('moves every instant of a plan-limits answer to the page clock, keeping the gaps between them', () => {
    evaluate(quotaClockJs)
    const before = Date.now()
    const answer = JSON.parse(JSON.stringify(frozen)) as typeof frozen
    const after = Date.now()

    const generated = Date.parse(answer.generatedAt)
    expect(generated).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 - 1000)
    expect(generated).toBeLessThanOrEqual(after)
    const gap = (iso: string) => Date.parse(iso) - generated
    const row = answer.accounts[0]!
    expect(gap(row.observedAt)).toBe(-5 * 60_000)
    expect(gap(row.resetsAt)).toBe(46 * 60_000)
    expect(gap(row.shortWindow.resetsAt)).toBe(46 * 60_000)
    expect(gap(row.modelWindows[0]!.resetsAt)).toBe(Date.parse('2026-09-28T17:00:00Z') - Date.parse('2026-09-22T14:24:00Z'))
    expect(row.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(row.ageSeconds).toBe(300)
    expect(row.status).toBe('out')
  })

  it('re-ages the answer inside a WebSocket topic frame, and leaves every other body alone', () => {
    evaluate(quotaClockJs)
    const frame = JSON.parse(JSON.stringify({ type: 'event', topic: 'agent-quota', data: frozen })) as { data: typeof frozen }
    expect(Date.parse(frame.data.generatedAt)).toBeGreaterThan(Date.parse(frozen.generatedAt))

    const other = { scope: 'health', generatedAt: '2026-09-22T14:24:00Z', at: '2026-09-22T14:24:00Z' }
    expect(JSON.parse(JSON.stringify(other))).toEqual(other)
    expect(JSON.parse('"2026-09-22T14:24:00Z"')).toBe('2026-09-22T14:24:00Z')
  })

  it('patches JSON.parse once, however often the page runs it', () => {
    evaluate(quotaClockJs)
    const patched = JSON.parse
    evaluate(quotaClockJs)
    expect(JSON.parse).toBe(patched)
  })
})
