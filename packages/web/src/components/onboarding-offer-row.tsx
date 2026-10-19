import type { OnboardingStatus } from '@qodeca/xezar-api-client'
import { ExternalLinkIcon } from 'lucide-react'

import { Link } from '@/lib/project-router'
import { offerCopy, UPGRADE_GUIDE_LINK_LABEL } from '@/lib/onboarding'

import { Button } from './ui/button'

/**
 * The post-update offer (#464 P2): one non-blocking row above the page, two actions, and nothing
 * else.
 *
 * It shares the shell's banner row shape with `ProviderBanner` but is deliberately the STATUS
 * tone, never the alert tone: nothing is broken, and spending the alert tone on "a version
 * changed" is how people learn to ignore the row that means an agent provider failed.
 *
 * It has no status dot at all. The sentence carries the whole meaning, so removing every colour
 * loses nothing — and there is no count to announce, which is why `aria-live` is `polite` and the
 * row never takes focus on arrival.
 *
 * Presentational by construction: every decision it could get wrong (is there an offer, what
 * changed, what does the sentence say) is answered by `lib/onboarding.ts` and by the container.
 */
export function OnboardingOfferRow({
  status,
  pending,
  atSettings = false,
  onRecheck,
  onLater,
}: {
  status: OnboardingStatus | undefined
  /** A click is in flight — both actions disable and the primary shows the pending label. */
  pending: boolean
  /** The reader is already on Settings → Project setup, with both identities on the page below
   *  (design review of #497, NB-6). The sentence and the two actions stay; only the link that
   *  points at this very page goes, because a link to where you are is not an offer. */
  atSettings?: boolean
  onRecheck: () => void
  onLater: () => void
}) {
  if (!status) return null

  // A check for this project is already running: the row becomes a line naming it. Two clicks
  // must not start two checks, and an offer next to a running check would be nonsense.
  if (status.state === 'checking' && status.checkingRunId) {
    return (
      <div
        data-slot="onboarding-offer"
        data-offer-state="checking"
        role="status"
        className="flex min-h-10 flex-wrap items-center gap-row border-b border-border bg-muted/50 px-section py-row text-sm text-muted-foreground md:flex-nowrap"
      >
        <span className="min-w-0">
          <strong className="font-semibold text-foreground">Re-checking this project</strong> — open
          the task to answer its questions and accept its changes.
        </span>
        <Button asChild variant="outline" size="default" className="ml-auto shrink-0 max-md:w-full">
          <Link to={`/tasks/${status.checkingRunId}`}>Open the task</Link>
        </Button>
      </div>
    )
  }

  const copy = offerCopy(status)
  if (!copy) return null

  return (
    <div
      data-slot="onboarding-offer"
      data-offer-state={copy.upgradeGuideUrl ? 'older-setup' : 'pending'}
      role="status"
      aria-live="polite"
      className="flex min-h-10 flex-wrap items-center gap-row border-b border-border bg-muted/50 px-section py-row text-sm text-muted-foreground md:flex-nowrap"
    >
      <span className="min-w-0">
        <strong className="font-semibold text-foreground">{copy.lead}</strong>
        {copy.rest}
        {copy.linkToSettings && !atSettings ? (
          <>
            {' '}
            <Link
              to="/settings/project-setup"
              className="font-medium text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              See the exact versions
            </Link>
          </>
        ) : null}
      </span>
      {/* Both actions keep full width at 44 px on a phone; neither ever disappears (§ 12). */}
      {/* `flex-wrap` on phones: the upgrade-guide link is wider than half a 375 px row, so it takes
          the whole row and Later wraps below it, both still 44 px tall (QA of the kit-pin PR). */}
      <span className="flex shrink-0 items-center gap-row max-md:w-full max-md:flex-wrap md:ml-auto">
        {copy.upgradeGuideUrl ? (
          // An older setup collection: a re-check before the upgrade changes nothing, so the
          // primary action opens the upgrade guide. Re-check stays on Settings for afterwards.
          <Button asChild variant="outline" className="max-md:h-11 max-md:w-full max-md:basis-full">
            <a
              href={copy.upgradeGuideUrl}
              target="_blank"
              rel="noreferrer"
              data-action="open-upgrade-guide"
            >
              <ExternalLinkIcon aria-hidden="true" />
              {UPGRADE_GUIDE_LINK_LABEL}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </Button>
        ) : (
          <Button
            variant="outline"
            onClick={onRecheck}
            disabled={pending || !status.available}
            {...(status.available ? {} : { 'aria-describedby': 'onboarding-offer-why' })}
            className="max-md:h-11 max-md:flex-1"
          >
            {pending ? 'Starting…' : 'Re-check'}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={onLater}
          disabled={pending}
          className="max-md:h-11 max-md:flex-1"
        >
          Later
        </Button>
      </span>
      {status.available || copy.upgradeGuideUrl ? null : (
        <span id="onboarding-offer-why" className="sr-only">
          {status.unavailableReason}
        </span>
      )}
    </div>
  )
}
