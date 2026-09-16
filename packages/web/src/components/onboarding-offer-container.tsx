import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { postOnboardingOffered } from '@/api/client'
import { queryKeys, useOnboarding, useSetupStart } from '@/api/queries'
import { useNavigate, useProjectMatch } from '@/lib/project-router'
import { setupMode } from '@/lib/onboarding'
import type { OnboardingOfferedInput } from '@qodeca/xezar-api-client'

import { OnboardingOfferRow } from './onboarding-offer-row'
import { toast } from './ui/toaster'

/**
 * The data half of the offer row (#464 P2) — the `ProviderBannerContainer` split, for the same
 * reason: every state of the row is then a pure render a unit test can drive.
 *
 * Two behaviours live here because they are decisions, not presentation:
 *
 *  - **Dismissed for this session, whatever the disk says.** The row goes away the moment Later is
 *    pressed. If the record could not be written (a read-only disk) the server answers
 *    `unwritable`, and the honest consequence is exactly what the design asks for: gone now, and a
 *    restart may show it once more. Nothing errors and no task starts.
 *  - **Focus moves to the page heading.** A keyboard user who dismisses the row must not be left
 *    standing on a removed element.
 */
export function OnboardingOfferContainer() {
  const onboarding = useOnboarding()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // The row is in the shell's banner slot, so it is on every route — including the one its own
  // link points at (design review of #497, NB-6). `useProjectMatch` ignores the `/p/:projectId`
  // prefix, so this holds for a scoped route too.
  const atSettings = useProjectMatch('/settings/project-setup') !== null
  const [dismissedThisSession, setDismissedThisSession] = useState(false)

  const later = useMutation({
    mutationFn: (identity: OnboardingOfferedInput) => postOnboardingOffered(identity),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.onboarding, result.onboarding)
    },
    // The server's own words, once. A dismissal that cannot be recorded is not a reason to keep
    // the row on screen — the person already answered it.
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const start = useSetupStart()

  if (onboarding.isError || !onboarding.data) return null
  const status = onboarding.data
  if (dismissedThisSession && status.state !== 'checking') return null

  const moveFocusToHeading = () => {
    const heading = document.querySelector<HTMLElement>('main h1')
    if (!heading) return
    heading.setAttribute('tabindex', '-1')
    heading.focus()
  }

  return (
    <OnboardingOfferRow
      status={status}
      pending={start.pending || later.isPending}
      atSettings={atSettings}
      onRecheck={() => {
        start.mutate(setupMode(status), {
          onSuccess: (run) => {
            toast('Re-check started — open the task to answer its questions')
            if ('id' in run) navigate(`/tasks/${run.id}`)
          },
          onError: (error: Error) => toast(error.message, { tone: 'danger' }),
        })
      }}
      onLater={() => {
        setDismissedThisSession(true)
        moveFocusToHeading()
        later.mutate(status.observed)
      }}
    />
  )
}
