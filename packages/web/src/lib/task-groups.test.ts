import { describe, expect, it } from 'vitest'

import type { RunRecord } from '@qodeca/xezar-api-client'
import { groupTitle, listCounts, queuePositions, runTitle, sortRuns } from '@/lib/task-groups'

let seq = 0

function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'default',
    task: `task ${seq}`,
    status: 'done',
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

describe('sortRuns', () => {
  it('orders by status priority, then newest first', () => {
    const runs = [
      run({ id: 'done-old', status: 'done', createdAt: '2026-07-14T09:00:00.000Z' }),
      run({ id: 'running', status: 'running', createdAt: '2026-07-14T08:00:00.000Z' }),
      run({ id: 'done-new', status: 'done', createdAt: '2026-07-14T11:00:00.000Z' }),
      run({ id: 'review', status: 'review', createdAt: '2026-07-14T07:00:00.000Z' }),
      run({ id: 'queued', status: 'queued', createdAt: '2026-07-14T12:00:00.000Z' }),
      run({ id: 'waiting', status: 'waiting', createdAt: '2026-07-14T06:00:00.000Z' }),
    ]
    // Needs-you first even though it is the oldest run in the list; a fresh `done` never
    // outranks a run that is blocked on you.
    expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual([
      'waiting',
      'review',
      'running',
      'queued',
      'done-new',
      'done-old',
    ])
  })

  it('orders scheduled runs by their appointment — soonest on top, not newest', () => {
    // "What happens next" has to hold INSIDE the rank too: a task resuming at 11:14 sits above
    // one resuming at 11:40 however old each is (spec 2026-08-03-auto-resume-after-usage-limit).
    // Creation order is deliberately the inverse of appointment order here.
    const runs = [
      run({ id: 'late', status: 'failed', autoResumeAt: '2026-08-03T11:40:00.000Z', createdAt: '2026-07-14T12:00:00.000Z' }),
      run({ id: 'soon', status: 'failed', autoResumeAt: '2026-08-03T11:14:00.000Z', createdAt: '2026-07-14T08:00:00.000Z' }),
      run({ id: 'mid', status: 'failed', autoResumeAt: '2026-08-03T11:20:00.000Z', createdAt: '2026-07-14T10:00:00.000Z' }),
    ]
    expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual(['soon', 'mid', 'late'])
  })

  it('orders queued runs FIFO, so the row order matches the #N positions they print', () => {
    const runs = [
      run({ id: 'third', status: 'queued', createdAt: '2026-07-14T12:00:00.000Z' }),
      run({ id: 'first', status: 'queued', createdAt: '2026-07-14T10:00:00.000Z' }),
      run({ id: 'second', status: 'queued', createdAt: '2026-07-14T11:00:00.000Z' }),
    ]
    const sorted = sortRuns(runs, 'active')
    expect(sorted.map((r) => r.id)).toEqual(['first', 'second', 'third'])
    // …which is exactly the order `queuePositions` numbers them in.
    const positions = queuePositions(runs)
    expect(sorted.map((r) => positions.get(r.id))).toEqual([1, 2, 3])
  })

  it('ranks the outcomes done → failed → cancelled, recency within each', () => {
    const runs = [
      run({ id: 'cancelled', status: 'cancelled', createdAt: '2026-07-14T09:00:00.000Z' }),
      run({ id: 'failed', status: 'failed', createdAt: '2026-07-14T10:00:00.000Z' }),
      run({ id: 'done', status: 'done', createdAt: '2026-07-14T08:00:00.000Z' }),
      run({ id: 'done-newer', status: 'done', createdAt: '2026-07-14T11:00:00.000Z' }),
    ]
    expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual([
      'done-newer',
      'done',
      'failed',
      'cancelled',
    ])
  })

  it('puts a scheduled run between running and queued — the pipeline in the order it happens', () => {
    // A usage-limit wait is work with an appointment, not an outcome (spec
    // 2026-08-03-auto-resume-after-usage-limit), so it must never sink into the terminal block
    // with the plain failures. Reading top-down answers "what happens next".
    const runs = [
      run({ id: 'failed', status: 'failed', createdAt: '2026-07-14T12:00:00.000Z' }),
      run({ id: 'queued', status: 'queued', createdAt: '2026-07-14T11:00:00.000Z' }),
      run({
        id: 'scheduled',
        status: 'failed',
        autoResumeAt: '2026-08-03T19:33:53.000Z',
        createdAt: '2026-07-14T08:00:00.000Z',
      }),
      run({ id: 'running', status: 'running', createdAt: '2026-07-14T07:00:00.000Z' }),
      run({ id: 'waiting', status: 'waiting', createdAt: '2026-07-14T06:00:00.000Z' }),
    ]
    expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual([
      'waiting',
      'running',
      'scheduled',
      'queued',
      'failed',
    ])
  })

  it('filters to the view', () => {
    const runs = [run({ id: 'a' }), run({ id: 'b', archived: true })]
    expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual(['a'])
    expect(sortRuns(runs, 'archived').map((r) => r.id)).toEqual(['b'])
  })

  it('does not reorder its input', () => {
    const runs = [run({ id: 'done', status: 'done' }), run({ id: 'waiting', status: 'waiting' })]
    sortRuns(runs, 'active')
    expect(runs.map((r) => r.id)).toEqual(['done', 'waiting'])
  })
})

describe('queuePositions', () => {
  it('numbers queued runs 1..n by creation order, not list order', () => {
    const runs = [
      run({ id: 'third', status: 'queued', createdAt: '2026-07-14T12:00:00.000Z' }),
      run({ id: 'first', status: 'queued', createdAt: '2026-07-14T10:00:00.000Z' }),
      run({ id: 'second', status: 'queued', createdAt: '2026-07-14T11:00:00.000Z' }),
    ]
    expect(queuePositions(runs)).toEqual(
      new Map([
        ['first', 1],
        ['second', 2],
        ['third', 3],
      ])
    )
  })

  it('counts only active queued runs', () => {
    const runs = [
      run({ id: 'running', status: 'running' }),
      run({ id: 'archived-queued', status: 'queued', archived: true, createdAt: '2026-07-14T09:00:00.000Z' }),
      run({ id: 'queued', status: 'queued', createdAt: '2026-07-14T10:00:00.000Z' }),
    ]
    // The archived one is not in the engine's queue, so it must not push the real one to #2.
    expect(queuePositions(runs)).toEqual(new Map([['queued', 1]]))
  })
})

describe('groupTitle', () => {
  it.each([
    ['Add skills autocomplete (A)', 'Add skills autocomplete'],
    ['Add skills autocomplete (C)', 'Add skills autocomplete'],
    ['Add skills autocomplete', 'Add skills autocomplete'],
    // Only the server's own ` (A)`…` (C)` suffix — a title that happens to end in parentheses
    // keeps them.
    ['Bump zod to v4 (draft)', 'Bump zod to v4 (draft)'],
    ['Rename the (D) flag', 'Rename the (D) flag'],
  ])('%s → %s', (title, expected) => {
    expect(groupTitle(run({ title }))).toBe(expected)
  })
})

describe('runTitle — the one name every surface shows', () => {
  it.each([
    {
      label: 'the auto-summary wins over the raw title once a turn produced one',
      over: { title: 'fix the login bug plz', titleSummary: 'Catch AuthError in the login handler' },
      expected: 'Catch AuthError in the login handler',
    },
    {
      label: 'no summary yet (or a pre-R2 record) → the raw title, honestly',
      over: { title: 'fix the login bug plz' },
      expected: 'fix the login bug plz',
    },
    {
      label: 'a user edit set BOTH fields (PATCH /api/v1/runs/:id), so the edit is what shows',
      over: { title: 'Login 500 fix', titleSummary: 'Login 500 fix' },
      expected: 'Login 500 fix',
    },
    {
      label: 'legacy concatenated narration falls back without rewriting persisted state',
      over: {
        title: '469: /xez-auto-review-pr',
        titleSummary: 'Loading the pipeline config and tracker descriptor, then claim PR #469.Config loaded',
      },
      expected: '469: /xez-auto-review-pr',
    },
    {
      label: 'user-owned titles preserve punctuation byte-for-byte',
      over: {
        title: 'Release v2.Config migration',
        titleSummary: 'Release v2.Config migration',
        titleOrigin: 'user' as const,
      },
      expected: 'Release v2.Config migration',
    },
    {
      label: 'marker-owned titles preserve punctuation byte-for-byte',
      over: {
        title: 'raw task',
        titleSummary: 'Testing SDK.Config support',
        titleOrigin: 'marker' as const,
      },
      expected: 'Testing SDK.Config support',
    },
    {
      label: 'well-formed identifiers and acronyms remain untouched',
      over: { title: 'raw task', titleSummary: 'updating README.md for OAuth2' },
      expected: 'updating README.md for OAuth2',
    },
  ])('$label', ({ over, expected }) => {
    expect(runTitle(run(over))).toBe(expected)
  })
})

describe('listCounts', () => {
  it('counts active, archived, and the runs that want you', () => {
    const runs = [
      run({ status: 'running' }),
      run({ status: 'waiting' }),
      run({ status: 'review' }),
      run({ status: 'failed' }),
      run({ status: 'done', archived: true }),
      run({ status: 'waiting', archived: true }),
    ]
    // The archived `waiting` counts as archived only — an archived run is not asking for you.
    expect(listCounts(runs)).toEqual({ active: 4, archived: 2, waiting: 2 })
  })

  it('is all zeroes for an empty list', () => {
    expect(listCounts([])).toEqual({ active: 0, archived: 0, waiting: 0 })
  })
})

describe('pinned tasks (#935)', () => {
  const pinned = (over: Partial<RunRecord> = {}) => run({ pinned: true, pinnedAt: '2026-08-29T10:00:00.000Z', ...over })

  describe('sortRuns', () => {
    it('puts pinned runs first, ahead of every status weight', () => {
      const runs = [
        run({ id: 'waiting', status: 'waiting' }),
        pinned({ id: 'pinned-done', status: 'done' }),
        run({ id: 'running', status: 'running' }),
      ]
      expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual(['pinned-done', 'waiting', 'running'])
    })

    it('keeps the ordinary rules INSIDE the pinned block', () => {
      const runs = [
        pinned({ id: 'pinned-done', status: 'done' }),
        pinned({ id: 'pinned-waiting', status: 'waiting' }),
        run({ id: 'plain-waiting', status: 'waiting' }),
      ]
      expect(sortRuns(runs, 'active').map((r) => r.id)).toEqual([
        'pinned-waiting',
        'pinned-done',
        'plain-waiting',
      ])
    })

    it('ignores the pin in the archived view', () => {
      const runs = [
        run({ id: 'newer', archived: true, createdAt: '2026-07-14T12:00:00.000Z' }),
        pinned({ id: 'older-pinned', archived: true, createdAt: '2026-07-14T09:00:00.000Z' }),
      ]
      expect(sortRuns(runs, 'archived').map((r) => r.id)).toEqual(['newer', 'older-pinned'])
    })
  })

  it('does not change the tab counts — those count by status, never by pin', () => {
    const runs = [pinned({ status: 'waiting' }), run({ status: 'done' }), run({ archived: true })]
    expect(listCounts(runs)).toEqual({ active: 2, archived: 1, waiting: 1 })
  })
})
