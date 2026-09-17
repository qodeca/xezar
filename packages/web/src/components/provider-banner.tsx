import { XIcon } from 'lucide-react'

import type { ProviderStatusResponse } from '@qodeca/xezar-api-client'
import { Link } from '@/lib/project-router'
import {
  type ProviderAuthDismissals,
  type ProviderAuthIncident,
  visibleProviderAuthIncidents,
} from '@/lib/provider-auth-alert'
import { parseProviderStatusResponse } from '@/lib/provider-status'
import { cn } from '@/lib/utils'

import { StatusDot } from './status-dot'

/** The banner's one action: a text link that is a 44 px target on a phone (#453 B7) and the
 *  cockpit's `focus-visible` ring (G-06). */
const LINK =
  'ml-auto inline-flex min-h-tap shrink-0 items-center rounded-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-0'

interface ProviderBannerProps {
  status: ProviderStatusResponse | undefined
  pending: boolean
  error: boolean
  dismissals: ProviderAuthDismissals
  onDismissAuthFailures: (incidents: readonly ProviderAuthIncident[]) => void
}

export function ProviderBanner({
  status,
  pending,
  error,
  dismissals,
  onDismissAuthFailures,
}: ProviderBannerProps) {
  if (pending || !status) return null
  let normalized: ProviderStatusResponse
  try {
    normalized = parseProviderStatusResponse(status)
  } catch {
    return null
  }

  const incidents = visibleProviderAuthIncidents(normalized, dismissals)
  if (incidents.length > 0) {
    return (
      <div
        data-slot="provider-banner"
        role="alert"
        className="flex min-h-10 flex-wrap items-center gap-x-row gap-y-1 border-b border-border bg-danger/10 px-4 py-1 text-sm text-foreground md:px-section"
      >
        <StatusDot tone="danger" />
        <span>
          Provider authentication failed during a task:{' '}
          {incidents.map(({ label }) => label).join(', ')}.
        </span>
        <Link
          to="/settings/agents#providers"
          className={LINK}
        >
          Open agent settings
        </Link>
        <button
          type="button"
          aria-label="Dismiss provider authentication alert"
          onClick={() => onDismissAuthFailures(incidents)}
          className="inline-flex min-h-tap min-w-tap shrink-0 items-center justify-center rounded-sm p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-0 md:min-w-0"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
      </div>
    )
  }

  if (error) return null
  const usable = normalized.providers.some(
    (row) => row.enabled && row.status === 'connected',
  )
  if (usable) return null
  const credentialsExist = normalized.providers.some(
    (row) => row.status === 'connected',
  )
  const uncertain = normalized.providers.some((row) => row.status === 'unknown')
  const message = credentialsExist
    ? 'No agent provider is enabled.'
    : uncertain
      ? 'No connected provider could be verified.'
      : 'No agent provider credentials were found.'

  return (
    <div
      data-slot="provider-banner"
      role="status"
      className="flex min-h-10 flex-wrap items-center gap-x-row gap-y-1 border-b border-border bg-muted/50 px-4 py-1 text-sm text-muted-foreground md:px-section"
    >
      <StatusDot tone={uncertain ? 'danger' : 'pending'} />
      <span>{message}</span>
      <Link
        to="/settings/agents#providers"
        className={cn(LINK, 'text-foreground')}
      >
        Configure providers
      </Link>
    </div>
  )
}
