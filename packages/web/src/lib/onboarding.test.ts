import { describe, expect, it } from 'vitest'

import type { OnboardingStatus } from '@qodeca/xezar-api-client'
import {
  identityLabel,
  offerCopy,
  onboardingChange,
  setupActionLabel,
  setupBody,
  setupBrief,
  setupHeading,
  setupMode,
  HOSTED_SETUP_NOTE,
  SETUP_HERO_SENTENCE,
  shortDigest,
} from './onboarding'

/**
 * The text rules behind the onboarding surfaces (#464 P2).
 *
 * Pure functions, so every state of every surface is a case here rather than a render — and the
 * three surfaces provably state the same facts, which is the drift these rules were lifted out of
 * the components to prevent.
 */

const base: OnboardingStatus = {
  state: 'never',
  provenance: 'unknown',
  available: true,
  unavailableReason: null,
  localHandoff: true,
  offerPending: false,
  dismissed: false,
  observed: { engineVersion: '0.15.0', kitDigest: '9f1a3b4ffffffff' },
  lastOffered: null,
  lastChecked: null,
  checkingRunId: null,
  launch: { workflowId: 'project-setup', modes: ['setup', 'preview', 'recheck'] },
  issueFiling: { status: 'available', reason: null, skill: 'xez-issue-create' },
}

const status = (over: Partial<OnboardingStatus>): OnboardingStatus => ({ ...base, ...over })

const changed = (checked: { engineVersion: string; kitDigest: string }) =>
  status({
    state: 'changed',
    provenance: 'recorded',
    offerPending: true,
    lastChecked: { ...checked, at: '2026-09-02T16:40:00.000Z' },
  })

describe('identities', () => {
  it('shows a digest short, and calls it “templates” rather than “kit”', () => {
    expect(shortDigest('9f1a3b4ffffffff')).toBe('9f1a3b4')
    // #466 / OQ-5: "kit" is a xezar-internal word and must not reach a user.
    expect(identityLabel(base.observed)).toBe('xezar 0.15.0 · templates 9f1a3b4')
    expect(identityLabel(base.observed)).not.toMatch(/kit/i)
  })

  it('names what actually moved', () => {
    const templates = { engineVersion: '0.15.0', kitDigest: '2c20c60aaaaaaa' }
    expect(onboardingChange({ engineVersion: '0.14.0', kitDigest: base.observed.kitDigest }, base.observed)).toBe('engine')
    expect(onboardingChange(templates, base.observed)).toBe('templates')
    expect(onboardingChange({ engineVersion: '0.14.0', kitDigest: '2c20c60aaaaaaa' }, base.observed)).toBe('both')
  })
})

describe('the offer row', () => {
  it('renders nothing unless an offer is actually pending', () => {
    expect(offerCopy(base)).toBeNull()
    expect(offerCopy(status({ state: 'set-up' }))).toBeNull()
    expect(offerCopy(status({ state: 'changed', offerPending: false }))).toBeNull()
    // Belt and braces: a "pending" flag with no baseline still produces no sentence, because a
    // sentence would have to name a previous version that does not exist.
    expect(offerCopy(status({ state: 'changed', offerPending: true, lastChecked: null }))).toBeNull()
  })

  it('has one sentence shape per thing that moved, and puts both identities inline when two fit', () => {
    const engine = offerCopy(changed({ engineVersion: '0.14.0', kitDigest: base.observed.kitDigest }))!
    expect(engine.lead).toBe('xezar changed since this project was last checked')
    expect(engine.rest).toContain('0.15.0 now, 0.14.0 then')
    expect(engine.linkToSettings).toBe(false)

    const templates = offerCopy(changed({ engineVersion: '0.15.0', kitDigest: '2c20c60aaaaaaa' }))!
    expect(templates.lead).toBe('The setup templates changed since this project was last checked')
    expect(templates.rest).toContain('9f1a3b4 now, 2c20c60 then')

    // Four identifiers do not fit one line at 375 px, so `both` gets the short sentence + a link.
    const both = offerCopy(changed({ engineVersion: '0.14.0', kitDigest: '2c20c60aaaaaaa' }))!
    expect(both.linkToSettings).toBe(true)
    expect(both.rest).not.toMatch(/\d+\.\d+\.\d+/)
  })

  it('says the same thing for an upgrade, a downgrade and a development build', () => {
    const shapes = [
      offerCopy(changed({ engineVersion: '0.14.0', kitDigest: base.observed.kitDigest }))!,
      offerCopy(changed({ engineVersion: '0.16.0', kitDigest: base.observed.kitDigest }))!,
      offerCopy(changed({ engineVersion: '0.16.0-dev.20260916.abcd', kitDigest: base.observed.kitDigest }))!,
    ]
    // A rollback and a development build are changes to inspect, not migration authority.
    for (const shape of shapes) {
      expect(shape.lead).toBe('xezar changed since this project was last checked')
      expect(`${shape.lead}${shape.rest}`).not.toMatch(/\b(update|upgrade|newer)\b/i)
    }
  })
})

describe('the Settings card', () => {
  it('gives every state its own heading and its own sentence', () => {
    const headings = (['never', 'set-up', 'changed', 'unknown', 'checking'] as const).map((state) =>
      setupHeading(status({ state })),
    )
    expect(headings).toEqual([
      'Not set up yet',
      'Set up',
      'Changed since the last check',
      'Provenance unknown',
      'Re-checking',
    ])
    expect(new Set(headings).size).toBe(headings.length)
  })

  it('names what moved in the changed sentence too, not only in the offer row', () => {
    // Design review NB-2: an engine-only sentence prints the same version twice on a
    // templates-only change and names nothing that actually moved.
    const templatesOnly = setupBody(changed({ engineVersion: '0.15.0', kitDigest: '2c20c60aaaaaaa' }))
    expect(templatesOnly).toContain('setup templates 2c20c60')
    expect(templatesOnly).toContain('Templates 9f1a3b4 are in use now')
    expect(templatesOnly.match(/0\.15\.0/g)).toBeNull()

    const engineOnly = setupBody(changed({ engineVersion: '0.14.0', kitDigest: base.observed.kitDigest }))
    expect(engineOnly).toContain('finished against xezar 0.14.0')
    expect(engineOnly).toContain('xezar 0.15.0 is running now')
  })

  it('says a dismissal is not a switch that turns the check off', () => {
    const body = setupBody({
      ...changed({ engineVersion: '0.14.0', kitDigest: base.observed.kitDigest }),
      dismissed: true,
    })
    expect(body).toContain('You chose Later')
    expect(body).not.toContain('A re-check compares')
  })

  it('never claims a check on a project nothing has looked at', () => {
    for (const state of ['never', 'unknown'] as const) {
      const body = setupBody(status({ state }))
      expect(body).not.toMatch(/last check finished/i)
    }
    expect(setupBody(status({ state: 'unknown' }))).toContain('it cannot tell your own edits')
  })

  it('offers setup where there is nothing to re-check, and a re-check otherwise', () => {
    expect(setupMode(status({ state: 'never' }))).toBe('setup')
    expect(setupMode(status({ state: 'unknown' }))).toBe('setup')
    expect(setupMode(status({ state: 'set-up' }))).toBe('recheck')
    expect(setupMode(status({ state: 'changed' }))).toBe('recheck')
    expect(setupActionLabel(status({ state: 'never' }))).toBe('Set up this project')
    expect(setupActionLabel(status({ state: 'changed' }))).toBe('Re-check now')
    expect(setupActionLabel(status({ state: 'checking' }))).toBe('Open the task')
  })
})

describe('release hygiene (#466)', () => {
  /**
   * EVERY string this module ships, not a sample of them (review round 1 finding 5): the first
   * round covered the hero sentence, both briefs and the heading/body pair, which left the hosted
   * note, all three offer sentences and the action labels outside the guard a PR body claimed
   * covered "any shipped string". A string that is not in this list is not guarded, so a new
   * export belongs here in the same commit.
   */
  const everyShippedString = () =>
    [
      SETUP_HERO_SENTENCE,
      HOSTED_SETUP_NOTE,
      setupBrief('setup'),
      setupBrief('recheck'),
      ...(['never', 'set-up', 'changed', 'unknown', 'checking'] as const).flatMap((state) => [
        setupHeading(status({ state })),
        setupBody(status({ state, lastChecked: { ...base.observed, at: '2026-09-02T16:40:00.000Z' } })),
        setupActionLabel(status({ state })),
      ]),
      // The offer row's three shapes — engine only, templates only, and both.
      ...[
        { engineVersion: '0.14.0', kitDigest: base.observed.kitDigest },
        { engineVersion: base.observed.engineVersion, kitDigest: '0000000aaaaaaaa' },
        { engineVersion: '0.14.0', kitDigest: '0000000aaaaaaaa' },
      ].flatMap((checked) => {
        const copy = offerCopy(changed(checked))
        return copy ? [copy.lead, copy.rest] : []
      }),
    ].join('\n')

  it('no shipped string names xezar’s own working files or process', () => {
    const everything = everyShippedString()
    for (const forbidden of [/\.xezar/, /\bkit\b/i, /\bSDLC\b/, /\bworkflow/i, /\bskill/i]) {
      expect(everything).not.toMatch(forbidden)
    }
  })

  it('the hero sentence does not assume a software project', () => {
    // Design review NB-7: "ignore rules" and "a delivery pipeline" are the two most
    // software-shaped nouns in the deck, and they were in the first sentence a new user reads.
    expect(SETUP_HERO_SENTENCE).not.toMatch(/ignore rules|pipeline/i)
    expect(SETUP_HERO_SENTENCE).toContain('shows you every change before anything is written')
  })
})
