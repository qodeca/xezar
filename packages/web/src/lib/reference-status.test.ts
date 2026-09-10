import { describe, expect, it } from 'vitest'

import type { ReferenceStatus } from '@qodeca/xezar-api-client'
import {
  isReferenceStatus,
  REFERENCE_CONFLICT,
  REFERENCE_STATUS,
  referenceStatusPresentation,
  referenceStatusText,
  type ReferenceStatusTone,
} from './reference-status'

const ALL_STATUSES = Object.keys(REFERENCE_STATUS) as ReferenceStatus[]

// The five roles `StatusDot` paints, plus the two this table adds. A tone outside the set is a
// status that can only be painted by inventing a colour, which is the drift the shared table exists
// to stop.
const TONES: ReferenceStatusTone[] = [
  'success',
  'danger',
  'violet',
  'neutral',
  'pending',
  'info',
  'conflict',
]

describe('REFERENCE_STATUS', () => {
  it('names exactly the eleven statuses the chip can paint', () => {
    expect(ALL_STATUSES).toEqual([
      'draft',
      'review-required',
      'changes-requested',
      'checks-pending',
      'checks-failing',
      'ready',
      'merged',
      'closed',
      'open',
      'completed',
      'not-planned',
    ])
  })

  it('gives every status a sentence-case label, a clause-shaped hint and a known tone', () => {
    for (const status of ALL_STATUSES) {
      const { label, hint, tone } = REFERENCE_STATUS[status]
      expect(label, status).not.toBe('')
      expect(label[0], status).toBe(label[0]?.toUpperCase())
      // Sentence case, never shouted: the label is not one long SHOUTED string.
      expect(label, status).not.toBe(label.toUpperCase())
      // The hint continues the label after an em dash, so it is a clause — no closing full stop.
      expect(hint, status).not.toBe('')
      expect(hint.endsWith('.'), status).toBe(false)
      expect(TONES, status).toContain(tone)
    }
  })

  it('keeps the tone/word pairs that a colour-only chip would get wrong', () => {
    // Each of these was reasoned about in the table's comments; pinning them here is what makes
    // "the colour says fine, the sentence says blocked" a test failure rather than a review catch.
    expect(REFERENCE_STATUS.draft.tone).toBe('neutral')
    // Waiting on a PERSON, so never violet — that is where merged and completed live.
    expect(REFERENCE_STATUS['review-required'].tone).toBe('info')
    expect(REFERENCE_STATUS['checks-pending'].tone).toBe('pending')
    expect(REFERENCE_STATUS['checks-failing'].tone).toBe('danger')
    expect(REFERENCE_STATUS['changes-requested'].tone).toBe('danger')
    expect(REFERENCE_STATUS.ready.tone).toBe('success')
    expect(REFERENCE_STATUS.merged.tone).toBe('violet')
    expect(REFERENCE_STATUS.completed.tone).toBe('violet')
    // Closed-without-merging is a loss; closed-as-not-planned is a shrug. Different tones.
    expect(REFERENCE_STATUS.closed.tone).toBe('danger')
    expect(REFERENCE_STATUS['not-planned'].tone).toBe('neutral')
    expect(REFERENCE_STATUS.open.tone).toBe('success')
  })
})

describe('REFERENCE_CONFLICT', () => {
  it('sits beside the eleven rather than inside them', () => {
    expect(REFERENCE_STATUS).not.toHaveProperty('conflict')
    expect(isReferenceStatus('conflict')).toBe(false)
  })

  it('claims its own tone so red keeps meaning what it already means', () => {
    expect(REFERENCE_CONFLICT.tone).toBe('conflict')
    // `danger` is already spoken for twice on these very chips.
    const dangerTones = ALL_STATUSES.filter((s) => REFERENCE_STATUS[s].tone === 'danger')
    expect(dangerTones.length).toBeGreaterThan(1)
    expect(REFERENCE_CONFLICT.tone).not.toBe('danger')
    // Nothing resolves a conflict on its own, so it must not read as in-flight either.
    expect(REFERENCE_CONFLICT.tone).not.toBe('pending')
  })

  it('leads with the blocker and says what to do about it', () => {
    expect(REFERENCE_CONFLICT.label).toBe('Merge conflicts')
    expect(REFERENCE_CONFLICT.hint).toContain('rebase')
  })
})

describe('isReferenceStatus', () => {
  it('accepts every status in the table', () => {
    for (const status of ALL_STATUSES) expect(isReferenceStatus(status), status).toBe(true)
  })

  it.each([
    // A value a NEWER server added after this bundle was built — the additive-vocabulary promise.
    'queued-for-merge',
    '',
    'Merged',
    // Inherited object keys must not read as statuses.
    'toString',
    'constructor',
    '__proto__',
  ])('rejects %j', (value) => {
    expect(isReferenceStatus(value)).toBe(false)
  })

  it.each([undefined, null, 12, {}, ['merged']])('rejects the non-string %j', (value) => {
    expect(isReferenceStatus(value)).toBe(false)
  })
})

describe('referenceStatusPresentation', () => {
  it('returns the table row for a known status', () => {
    expect(referenceStatusPresentation('merged')).toBe(REFERENCE_STATUS.merged)
  })

  it('returns undefined for an absent status rather than throwing', () => {
    expect(referenceStatusPresentation(undefined)).toBeUndefined()
  })

  it('returns undefined for a status this bundle has never heard of', () => {
    // The rollback case: a newer bundle wrote this into sessionStorage, the tab then reloaded an
    // older one. It must land on the neutral chip, not on an `undefined` that a render dereferences.
    expect(referenceStatusPresentation('queued-for-merge' as ReferenceStatus)).toBeUndefined()
  })
})

describe('referenceStatusText', () => {
  it('joins the label and the hint with an em dash', () => {
    expect(referenceStatusText('merged')).toBe('Merged — this landed on its base branch')
    expect(referenceStatusText('checks-failing')).toBe(
      'Checks failing — CI is red on the latest commit',
    )
  })

  it('produces one non-empty sentence for every status', () => {
    for (const status of ALL_STATUSES) {
      const text = referenceStatusText(status)
      expect(text, status).toContain(' — ')
      expect(text.startsWith(REFERENCE_STATUS[status].label), status).toBe(true)
      expect(text.endsWith(REFERENCE_STATUS[status].hint), status).toBe(true)
    }
  })
})
