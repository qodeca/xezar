import { CompassIcon, InfoIcon, LockIcon, RotateCwIcon } from 'lucide-react'
import { useState } from 'react'

import { useOnboarding, useSetupStart } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Link, useNavigate } from '@/lib/project-router'
import {
  HOSTED_SETUP_NOTE,
  identityLabel,
  setupActionLabel,
  setupBody,
  setupHeading,
  setupMode,
} from '@/lib/onboarding'
import type { OnboardingStamp, OnboardingStatus } from '@qodeca/xezar-api-client'

/**
 * Settings → Project setup (#464 P2) — the durable home of the setup entry, and the only place the
 * three identities live.
 *
 * It exists because the Tasks hero disappears the moment a first task exists, and the question
 * "what was actually checked, and when" has to outlive that. Everything here is a derived fact:
 * there is nothing to type and no setting to author.
 */
export function ProjectSetupSection() {
  const onboarding = useOnboarding()

  if (onboarding.isPending) {
    // One muted line. No skeleton, and above all no premature "Not set up yet" — a state that has
    // not answered yet must not be shown as a state.
    return (
      <p data-slot="project-setup-loading" className="p-list text-[13px] text-muted-foreground md:p-group">
        Loading project setup…
      </p>
    )
  }
  if (onboarding.isError) {
    return (
      <CenteredState
        icon={<CompassIcon />}
        tone="danger"
        title="Could not load project setup"
        subtitle={onboarding.error.message}
        heading="h2"
        actions={
          <Button variant="outline" onClick={() => void onboarding.refetch()}>
            Retry
          </Button>
        }
      />
    )
  }
  // Hosted mode is read from the ONE payload field, never a second time off `useHealth()`: two
  // sources for one fact is how a surface comes to disagree with itself, and the server already
  // answered it. The entry itself stays available either way (OQ-2 A) — a hosted person still gets
  // the useful part, and only the step that finishes elsewhere is named.
  return <ProjectSetupCard status={onboarding.data} hosted={!onboarding.data.localHandoff} />
}

/** The dot is the LAST carrier of the state, never the first: the heading beside it already says
 *  the state in words, so it is `aria-hidden` and removing all colour loses nothing. */
function dotTone(status: OnboardingStatus): StatusDotTone {
  if (status.state === 'checking') return 'violet'
  if (status.state === 'set-up') return 'success'
  return status.state === 'changed' ? 'pending' : 'neutral'
}

function ProjectSetupCard({ status, hosted }: { status: OnboardingStatus; hosted: boolean }) {
  const navigate = useNavigate()
  const start = useSetupStart()
  const [startError, setStartError] = useState<string | null>(null)
  const mode = setupMode(status)
  const running = status.state === 'checking' && status.checkingRunId

  return (
    <div
      data-slot="project-setup-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-section p-list pb-[calc(90px+env(safe-area-inset-bottom))] md:p-group md:pb-group"
    >
      <section className="flex flex-col gap-stack">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Guided setup</h2>
          <p className="text-[13px] text-muted-foreground">
            An agent looks at this project and prepares the files it needs. You see every change
            before it is written.
          </p>
        </div>

        <div
          data-slot="project-setup-card"
          data-setup-state={status.state}
          className="flex flex-col gap-list rounded-lg border border-border bg-card p-inset shadow-xs"
        >
          <div className="flex flex-col gap-stack md:flex-row md:items-start md:gap-list">
            <div className="flex min-w-0 flex-1 flex-col gap-row">
              <h3 className="flex items-center gap-row text-sm font-semibold text-foreground">
                <StatusDot
                  tone={dotTone(status)}
                  pulse={status.state === 'checking'}
                  aria-hidden="true"
                />
                {setupHeading(status)}
              </h3>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                {setupBody(status)}
              </p>
            </div>
            <div className="shrink-0 max-md:w-full">
              {running ? (
                <Button asChild variant="outline" className="max-md:h-11 max-md:w-full">
                  <Link to={`/tasks/${status.checkingRunId}`}>{setupActionLabel(status)}</Link>
                </Button>
              ) : (
                <Button
                  variant={status.state === 'set-up' ? 'outline' : 'contrast'}
                  disabled={!status.available || start.pending}
                  {...(status.available ? {} : { 'aria-describedby': 'project-setup-why' })}
                  data-action="start-setup"
                  className="max-md:h-11 max-md:w-full"
                  onClick={() => {
                    setStartError(null)
                    start.mutate(mode, {
                      onSuccess: (run) => {
                        if ('id' in run) navigate(`/tasks/${run.id}`)
                      },
                      // The server's own words, once, as an alert line inside the card — not a
                      // toast that vanishes while the person is still reading the card.
                      onError: (error: Error) => setStartError(error.message),
                    })
                  }}
                >
                  {mode === 'setup' ? <CompassIcon aria-hidden="true" /> : <RotateCwIcon aria-hidden="true" />}
                  {start.pending ? 'Starting…' : setupActionLabel(status)}
                </Button>
              )}
            </div>
          </div>

          {status.available ? null : (
            // Visible text, wired with `aria-describedby` — never a `title` a pointer alone reveals.
            <p id="project-setup-why" className="text-[13px] text-muted-foreground">
              {status.unavailableReason}
            </p>
          )}
          {startError ? (
            <p role="alert" data-slot="project-setup-error" className="text-[13px] text-danger">
              {startError}
            </p>
          ) : null}

          <IdentityRows status={status} />

          {hosted ? (
            <SetupNote icon={<LockIcon aria-hidden="true" className="size-4 shrink-0" />}>
              <strong className="font-semibold text-foreground">One part finishes elsewhere.</strong>{' '}
              {HOSTED_SETUP_NOTE}
            </SetupNote>
          ) : null}
          {status.state === 'unknown' ? (
            <SetupNote icon={<InfoIcon aria-hidden="true" className="size-4 shrink-0" />}>
              <strong className="font-semibold text-foreground">This is not an error.</strong> The
              record is local scratch. Deleting it loses the history of checks and nothing else —
              xezar and your tasks work exactly as before.
            </SetupNote>
          ) : null}
          {status.dismissed ? (
            <SetupNote icon={<InfoIcon aria-hidden="true" className="size-4 shrink-0" />}>
              <strong className="font-semibold text-foreground">A re-check is always here.</strong>{' '}
              Choosing Later hides the notice for this version only. It never turns the check off.
            </SetupNote>
          ) : null}
          <SetupNote icon={<InfoIcon aria-hidden="true" className="size-4 shrink-0" />}>
            <strong className="font-semibold text-foreground">Observed is not checked.</strong>{' '}
            “Last observed” is what is running now. Only a check that finished moves “Last
            successfully checked” — a partial or failed check leaves it where it was.
          </SetupNote>
          <SetupNote icon={<InfoIcon aria-hidden="true" className="size-4 shrink-0" />}>
            <strong className="font-semibold text-foreground">Setup starts an ordinary task.</strong>{' '}
            It appears in Tasks with every other task, you can read what it did, and you can cancel
            it. Nothing runs on its own when xezar starts.
          </SetupNote>
        </div>
      </section>
    </div>
  )
}

/**
 * The three identities, as a description list.
 *
 * Three labelled rows, never one combined chip and never the words "up to date": a version xezar
 * happens to be running proves nothing about this project's files, and collapsing the three is
 * exactly how a surface like this comes to lie.
 */
function IdentityRows({ status }: { status: OnboardingStatus }) {
  return (
    <dl data-slot="project-setup-identities" className="flex flex-col gap-row text-[13px]">
      <IdentityRow label="Last observed" value={identityLabel(status.observed)} />
      <IdentityRow label="Last offered" stamp={status.lastOffered} />
      <IdentityRow label="Last successfully checked" stamp={status.lastChecked} />
    </dl>
  )
}

function IdentityRow({
  label,
  value,
  stamp,
}: {
  label: string
  value?: string
  stamp?: OnboardingStamp | null
}) {
  const text = value ?? (stamp ? identityLabel(stamp) : null)
  return (
    <div className="flex flex-col gap-0.5 md:flex-row md:items-baseline md:justify-between md:gap-list">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground md:text-right">
        {text === null ? (
          <>
            —<span className="sr-only">not recorded</span>
          </>
        ) : (
          <>
            {text}
            {stamp ? (
              <span className="text-muted-foreground"> — {formatWhen(stamp.at)}</span>
            ) : null}
          </>
        )}
      </dd>
    </div>
  )
}

/** The timestamp suffix. An unparseable value prints verbatim rather than "Invalid Date". */
function formatWhen(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** A hint block inside the card — the cockpit's own page → card → hint elevation, spelled here as
 *  a feature composition rather than a new shared primitive. */
function SetupNote({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-row rounded-md bg-muted/50 p-stack text-[13px] leading-relaxed text-muted-foreground">
      {icon}
      <span>{children}</span>
    </p>
  )
}
