import type { OnboardingIdentity, OnboardingStatus } from '@qodeca/xezar-api-client'

/**
 * The text rules behind the three onboarding surfaces (#464 P2).
 *
 * They live here, not in the components, for the reason `lib/runner-label.ts` exists: the Tasks
 * hero, the banner row and the Settings card all state the same facts, the phone card cannot host
 * the same components, and the last time two surfaces each kept their own copy of a rule they
 * drifted. Pure functions, no JSX, no hooks — so every state is a unit test rather than a render.
 *
 * Two conventions the whole deck follows (`docs/design-system/writing.md`): the digest is called
 * **setup templates**, never "kit" (a xezar-internal word, #466 / OQ-5), and the words *update*,
 * *upgrade* and *newer* appear nowhere — a downgrade and a development build are changes to
 * inspect, not migration authority.
 */

/** What actually moved between the checked identity and the running one. */
export type OnboardingChange = 'engine' | 'templates' | 'both'

/** The short form a digest is shown in. The full value stays in the record and the MCP answer. */
export function shortDigest(digest: string): string {
  return digest.slice(0, 7)
}

/** "xezar 0.15.0 · templates 2c20c60" — the identity-row value, and the only spelling of a pair. */
export function identityLabel(identity: OnboardingIdentity): string {
  return `xezar ${identity.engineVersion} · templates ${shortDigest(identity.kitDigest)}`
}

/**
 * Which of the two identities moved.
 *
 * `both` is its own answer rather than a pair of booleans because it is the one case the offer row
 * cannot render inline: four identifiers do not fit one line at 375 px, so it gets a shorter
 * sentence and a link instead.
 */
export function onboardingChange(
  checked: OnboardingIdentity,
  observed: OnboardingIdentity,
): OnboardingChange {
  const engine = checked.engineVersion !== observed.engineVersion
  const templates = checked.kitDigest !== observed.kitDigest
  if (engine && templates) return 'both'
  return engine ? 'engine' : 'templates'
}

/** The sentence every "what a re-check does" clause ends with. One string, so it cannot drift. */
const RECHECK_SENTENCE =
  'A re-check compares this project’s files against the pinned defaults and shows you the differences.'

/** What the offer row says, split so the lead clause can be bold and the rest plain. */
export interface OfferCopy {
  /** The bold lead. */
  lead: string
  /** The rest of the sentence, already including the identities when they fit. */
  rest: string
  /** `both` needs a link to Settings, where the four identifiers have room. */
  linkToSettings: boolean
}

/**
 * The offer row's sentence for a changed identity.
 *
 * `null` when there is nothing to offer — which is most of the time, and every clause of
 * `offerPending` is a rule the design states as "no offer appears": no baseline, same identity,
 * already offered, or a check already running.
 */
export function offerCopy(status: OnboardingStatus): OfferCopy | null {
  if (!status.offerPending || !status.lastChecked) return null
  const change = onboardingChange(status.lastChecked, status.observed)
  if (change === 'engine') {
    return {
      lead: 'xezar changed since this project was last checked',
      rest: ` — ${status.observed.engineVersion} now, ${status.lastChecked.engineVersion} then. ${RECHECK_SENTENCE}`,
      linkToSettings: false,
    }
  }
  if (change === 'templates') {
    return {
      lead: 'The setup templates changed since this project was last checked',
      rest: ` — ${shortDigest(status.observed.kitDigest)} now, ${shortDigest(status.lastChecked.kitDigest)} then. ${RECHECK_SENTENCE}`,
      linkToSettings: false,
    }
  }
  return {
    lead: 'xezar and the setup templates changed since this project was last checked.',
    rest: ` ${RECHECK_SENTENCE}`,
    linkToSettings: true,
  }
}

/** The Settings card's state heading. Never merged with the sentence: both have to stand alone. */
export function setupHeading(status: OnboardingStatus): string {
  switch (status.state) {
    case 'checking':
      return 'Re-checking'
    case 'set-up':
      return 'Set up'
    case 'changed':
      return 'Changed since the last check'
    case 'unknown':
      return 'Provenance unknown'
    default:
      return 'Not set up yet'
  }
}

/**
 * The Settings card's sentence.
 *
 * The `changed` state has the SAME three variants the offer row has (design review NB-2): a
 * single engine-only sentence would print one version twice on a templates-only change and name
 * nothing that moved.
 */
export function setupBody(status: OnboardingStatus): string {
  switch (status.state) {
    case 'checking':
      return 'A task is comparing this project’s files against the pinned defaults. It may ask you a question, and it writes nothing until you accept its preview.'
    case 'set-up':
      return `The last check finished against xezar ${status.lastChecked?.engineVersion} and templates ${shortDigest(status.lastChecked?.kitDigest ?? '')}. ${RECHECK_SENTENCE}`
    case 'changed':
      return `${changedClause(status)} ${
        status.dismissed
          ? 'You chose Later, so the notice above the page will not come back for this version.'
          : RECHECK_SENTENCE
      }`
    case 'unknown':
      return 'A record of earlier checks exists for this project and cannot be read, so nothing here can say what was checked or when. A re-check can still read what is here and show you the pinned defaults, but it cannot tell your own edits from an older default, so it will not replace a file on its own.'
    default:
      return 'No setup has been recorded for this project. You can still create ordinary tasks — setup is optional, and it is never required to start work.'
  }
}

/** "The last check finished against X. Y is running now." — one variant per thing that moved. */
function changedClause(status: OnboardingStatus): string {
  const checked = status.lastChecked
  if (!checked) return ''
  switch (onboardingChange(checked, status.observed)) {
    case 'engine':
      return `The last check finished against xezar ${checked.engineVersion}. xezar ${status.observed.engineVersion} is running now.`
    case 'templates':
      return `The last check finished against setup templates ${shortDigest(checked.kitDigest)}. Templates ${shortDigest(status.observed.kitDigest)} are in use now.`
    default:
      return `The last check finished against xezar ${checked.engineVersion} and templates ${shortDigest(checked.kitDigest)}. xezar ${status.observed.engineVersion} and templates ${shortDigest(status.observed.kitDigest)} are running now.`
  }
}

/** Which action the card offers. A project nothing has checked is "set up"; everything else is a
 *  re-check, and a running check points at the task instead. */
export function setupActionLabel(status: OnboardingStatus): string {
  if (status.state === 'checking') return 'Open the task'
  return status.state === 'never' || status.state === 'unknown'
    ? 'Set up this project'
    : 'Re-check now'
}

/** The two modes the cockpit surfaces. `preview` is a property of a brief, not of a button, so it
 *  is offered to a leader through the MCP and not here (§ 16, design review NB-6). */
export type CockpitSetupMode = 'setup' | 'recheck'

export function setupMode(status: OnboardingStatus): CockpitSetupMode {
  return status.state === 'never' || status.state === 'unknown' ? 'setup' : 'recheck'
}

/**
 * The task text the button sends.
 *
 * Generic on purpose (#466): it describes the user's own project and names none of xezar's
 * internal working files, its process or its skills. The concrete file list comes from the task's
 * own preview, where it is about their project rather than about ours.
 */
export function setupBrief(mode: CockpitSetupMode): string {
  return mode === 'setup'
    ? 'Set this project up: look at what is already here, ask only what you cannot tell from the project itself, and show me a preview of every change before you write anything.'
    : 'Re-check this project against the pinned defaults: compare what is here with the current defaults, show me the differences, and write nothing until I accept a preview.'
}

/** The hero sentence on a fresh Tasks page. It leads with the generic promise and leaves the file
 *  list to the task's own preview (design review NB-7): a project may be a campaign or a piece of
 *  research, and "ignore rules" and "a delivery pipeline" are software-shaped nouns. */
export const SETUP_HERO_SENTENCE =
  'New to this project? An agent can look at it and prepare the files it needs, and it shows you every change before anything is written.'

/** The note naming the one step a hosted cockpit cannot finish. It states the consequence and who
 *  can act, and never the phrase "not available in hosted mode" (`writing.md` § 7). */
export const HOSTED_SETUP_NOTE =
  'Connecting an agent on your own computer is done from the machine that owns the checkout — this cockpit runs in hosted mode. Setup prepares that file here and leaves the last step to a person on that machine.'
