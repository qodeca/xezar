import { Fragment, useState } from 'react'
import { Link as RouterLink } from 'react-router'

import { useAgentProfiles, useAgentQuota, useHealth } from '@/api/queries'
import { StatusDot } from '@/components/status-dot'
import { buttonVariants } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { chipClass } from '@/components/picker-pill'
import {
  ageText,
  chipSummaries,
  formatQuotaTime,
  accountIsStale,
  quotaAgeSeconds,
  quotaLoginName,
  worstTone,
  type QuotaAgentSummary,
} from '@/lib/agent-quota'
import { RUNNER_LABEL } from '@/lib/runner-label'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/**
 * The plan-limits chip (#867 FR-11, designs/agent-quota § 5.5).
 *
 * Desktop (`variant="band"`): its own band directly above the sidebar footer's controls row, one
 * segment per applicable agent — dot, product name, `canWork/total` — because the footer row is
 * one row that never wraps (#702) and the cockpit has no desktop top bar (OD-1). Phone
 * (`variant="phone"`): one combined count with the worst tone in the top bar's status slot.
 *
 * It opens a Popover naming the logins that are out or unknown, with a link to the Plan limits
 * block in Settings → Agent accounts (OD-3). It never starts a check.
 *
 * ABSENT — renders nothing at all — while the answer or health is unknown, after a failed load,
 * and when no agent applies (D38): a `0/0` or `—` chip would claim something nobody measured.
 * Colour is never alone: every dot has its count and name beside it.
 */
export function AgentQuotaChip({ variant }: { variant: 'band' | 'phone' }) {
  const quota = useAgentQuota()
  const health = useHealth()
  const now = useNow(30_000)
  const [open, setOpen] = useState(false)
  const summaries = chipSummaries(quota.data, health.data?.checks, now)
  if (!quota.data || summaries.length === 0) return null

  const answer = quota.data
  const rows = summaries.flatMap((summary) => answer.accounts.filter((row) => row.runner === summary.runner))
  const ages = rows.map((row) => quotaAgeSeconds(row, answer.generatedAt, now))
  const youngest = Math.min(...ages)
  const oldest = Math.max(...ages)
  // "Every reading is stale": the server's per-row `stale` when it sends one (#888), else the age.
  const stale = rows.every((row, index) => accountIsStale(row, ages[index]!))
  const hosted = health.data?.capabilities?.localHandoff !== true
  const sentence = summaries.map((s) => `${RUNNER_LABEL[s.runner]} ${s.canWork} of ${s.total}`).join(', ')
  const canWork = summaries.reduce((sum, s) => sum + s.canWork, 0)
  const total = summaries.reduce((sum, s) => sum + s.total, 0)
  const staleWords = stale ? ' — stale, every reading is over 15 minutes old' : ''
  const label =
    variant === 'band'
      ? `Logins that can work now: ${sentence}${staleWords}. ${open ? 'Hide' : 'Show'} details`
      : `${canWork} of ${total} logins can work now${staleWords}. ${open ? 'Hide' : 'Show'} details`

  const trigger = (
    <PopoverTrigger
      data-slot="agent-quota-chip"
      data-variant={variant}
      aria-label={label}
      className={cn(
        chipClass,
        'h-auto flex-wrap gap-x-row gap-y-1 py-1 text-[11.5px] text-foreground',
        variant === 'band' ? 'w-full justify-start px-2' : 'shrink-0',
      )}
    >
      {variant === 'band' ? (
        summaries.map((summary, index) => (
          <Fragment key={summary.runner}>
            {index > 0 ? <span className="text-soft-foreground" aria-hidden="true">·</span> : null}
            <span data-slot="agent-quota-segment" data-runner={summary.runner} className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <StatusDot tone={summary.tone} aria-hidden="true" />
              {RUNNER_LABEL[summary.runner]}
              <span className="font-mono tabular-nums">
                {summary.canWork}/{summary.total}
              </span>
            </span>
          </Fragment>
        ))
      ) : (
        <span data-slot="agent-quota-segment" className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <StatusDot tone={worstTone(summaries.map((s) => s.tone))} aria-hidden="true" />
          <span className="font-mono tabular-nums">
            {canWork}/{total}
          </span>
          can work
        </span>
      )}
      {stale ? <span className="text-muted-foreground">stale</span> : null}
    </PopoverTrigger>
  )

  const chip = (
    <Popover open={open} onOpenChange={setOpen}>
      {trigger}
      <PopoverContent
        data-slot="agent-quota-popover"
        side={variant === 'band' ? 'right' : 'bottom'}
        align="end"
        className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-stack p-list text-[13px]"
      >
        <h2 className="text-[13px] font-semibold text-foreground">Logins that can work now</h2>
        <PopoverAgents summaries={summaries} now={now} />
        <p className="text-xs leading-normal text-muted-foreground">
          {stale
            ? `Stale — the newest reading is ${ageText(youngest)} old.`
            : `Readings from ${ageText(youngest)} to ${ageText(oldest)} old.`}{' '}
          xezar shows these limits and never acts on them.
          {hosted ? ' This page reads them again when the server reports a change, and every 15 minutes while it is open.' : ''}
        </p>
        <RouterLink
          to="/settings/global/accounts#limits"
          data-action="agent-quota-open-accounts"
          onClick={() => setOpen(false)}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-full')}
        >
          Open agent accounts
        </RouterLink>
      </PopoverContent>
    </Popover>
  )

  if (variant === 'phone') return chip
  return (
    <div data-slot="agent-quota-band" className="pb-row">
      {chip}
    </div>
  )
}

/**
 * The Popover's per-agent lines. Mounted only while the Popover is open, so the account listing it
 * reads for names is asked for then and not on every page; hosted mode answers that listing empty,
 * and the names fall back to the answer's ids (`quotaLoginName`).
 */
function PopoverAgents({ summaries, now }: { summaries: QuotaAgentSummary[]; now: number }) {
  const profiles = useAgentProfiles().data?.profiles
  return summaries.map((summary) => (
    <PopoverAgent
      key={summary.runner}
      summary={summary}
      now={now}
      nameOf={(accountId) => quotaLoginName(profiles, summary.runner, accountId)}
    />
  ))
}

function PopoverAgent({
  summary,
  now,
  nameOf,
}: {
  summary: QuotaAgentSummary
  now: number
  nameOf: (accountId: string) => string
}) {
  return (
    <div data-slot="agent-quota-popover-agent" data-runner={summary.runner} className="flex flex-col gap-1">
      <p className="flex items-baseline gap-2 text-foreground">
        <StatusDot tone={summary.tone} className="mt-1.75 self-start" aria-hidden="true" />
        <span>{summary.text}</span>
      </p>
      {summary.out.length + summary.unknown.length > 0 ? (
        <ul className="flex flex-col gap-0.5 pl-3.75 text-xs text-muted-foreground">
          {summary.out.map((row) => (
            <li key={row.accountId}>
              {nameOf(row.accountId)} — out until {row.status === 'out' ? formatQuotaTime(row.resetsAt, now) : ''}
            </li>
          ))}
          {summary.unknown.map((row) => (
            <li key={row.accountId}>{nameOf(row.accountId)} — limits unknown</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
