import { RefreshCwIcon } from 'lucide-react'
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'

import { useAgentQuota, useRefreshAgentQuota } from '@/api/queries'
import type { AgentQuotaAccount, AgentQuotaResponse, AgentQuotaRunner } from '@qodeca/xezar-api-client'
import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { UsageBar } from '@/components/usage-bar'
import {
  QUOTA_RUNNERS,
  ageText,
  creditsText,
  findQuotaAccount,
  formatQuotaTime,
  isQuotaStale,
  nextCheckAllowedAt,
  notReportedWords,
  quotaAgeSeconds,
  quotaStatusSentence,
  quotaWindowLines,
  sourceDetail,
  sourceText,
  summarizeAgent,
} from '@/lib/agent-quota'
import { useNow } from '@/lib/use-now'
import { RUNNER_LABEL } from '@/lib/runner-label'
import { cn } from '@/lib/utils'

/**
 * Plan limits in Global settings → Agent accounts (#867 S5, designs/agent-quota § 5.4).
 *
 * Three pieces, one answer: the Plan limits block at the top of the pane, a limits half in every
 * Claude Code / Codex account row, and that half's "Plan limits in detail" inside the row's
 * existing Show details panel. All of them read `useAgentQuota()` — a pure cache read, kept live
 * by the root subscription — and render the answer's fields as sent (D1, D37). What the cockpit
 * derives on top (the summary counts, "Stale", the refresh gap, the reader's zone) is named in
 * `lib/agent-quota.ts`.
 *
 * Nothing here acts on the facts (D2): no login is switched and no task is held back.
 */

/** `Built-in login` for `default`, otherwise the name the pane gives the account (or its id). */
export type QuotaNameOf = (runner: AgentQuotaRunner, accountId: string) => string

/** The id the Plan limits block's jump links scroll to: the row's limits half. */
export const limitsAnchorId = (runner: AgentQuotaRunner, accountId: string) =>
  `limits-${runner}-${accountId.replace(/[^A-Za-z0-9_-]/g, '_')}`

/** The block the chip's "Open agent accounts" lands on (`#limits`). */
export const PLAN_LIMITS_ID = 'limits'

function useRefreshToast(nameOf: QuotaNameOf) {
  const refresh = useRefreshAgentQuota()
  const run = (target?: AgentQuotaAccount) =>
    refresh.mutate(target ? { provider: target.runner, accountId: target.accountId } : {}, {
      onSuccess: (answer) => {
        if (!target) {
          toast('Refreshed the plan limits')
          return
        }
        const name = nameOf(target.runner, target.accountId)
        const fresh = findQuotaAccount(answer, target.runner, target.accountId)
        // A reading that did not move means the server held the check back (FR-7's gap).
        if (fresh && fresh.checkedAt === target.checkedAt) {
          const next = nextCheckAllowedAt(fresh)
          toast(
            `Not checked — ${name} was checked ${ageText(fresh.ageSeconds)} ago.${
              next ? ` The next check is allowed at ${formatQuotaTime(new Date(next).toISOString())}.` : ''
            }`,
          )
          return
        }
        toast(`Refreshed the limits of ${name}`)
      },
      // The server's own words (writing.md §13): a 404 before the refresh route exists says so.
      onError: (error: Error) => toast(error.message, { tone: 'danger' }),
    })
  return { run, pending: refresh.isPending, variables: refresh.variables }
}

/**
 * The Plan limits block (`#limits`): one D30 line per agent, Refresh all, and the promise that
 * xezar shows these facts and never acts on them.
 */
export function PlanLimitsBlock({ nameOf, hosted }: { nameOf: QuotaNameOf; hosted: boolean }) {
  const quota = useAgentQuota()
  const now = useNow(30_000)
  const refresh = useRefreshToast(nameOf)
  const { hash } = useLocation()
  const sectionRef = useRef<HTMLElement>(null)
  // The chip's "Open agent accounts" lands here (`#limits`). A client-side navigation does not
  // scroll to a hash by itself, so the block does — once its answer is in, so the target does not
  // move again under the reader. Focus follows, so a keyboard user continues from here.
  useEffect(() => {
    if (hash !== `#${PLAN_LIMITS_ID}` || quota.isPending) return
    sectionRef.current?.scrollIntoView?.({ block: 'start' })
    sectionRef.current?.focus()
  }, [hash, quota.isPending])

  const frame = (children: ReactNode) => (
    <section
      ref={sectionRef}
      tabIndex={-1}
      id={PLAN_LIMITS_ID}
      data-slot="agent-quota-summary"
      aria-labelledby="agent-quota-summary-title"
      className="flex scroll-mt-16 flex-col gap-stack rounded-lg border border-border bg-card p-inset outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {children}
    </section>
  )

  if (quota.isPending) {
    return frame(
      <p data-slot="agent-quota-loading" className="min-h-16 text-[13px] text-soft-foreground">
        <span id="agent-quota-summary-title">Loading plan limits…</span>
      </p>,
    )
  }
  if (quota.isError) {
    return frame(
      <div data-slot="agent-quota-error" className="flex flex-col gap-row text-[13px]">
        <h3 id="agent-quota-summary-title" className="font-semibold text-foreground">
          Could not load plan limits
        </h3>
        <p className="text-muted-foreground">{quota.error.message}</p>
        <div>
          <Button type="button" variant="outline" size="sm" className="w-full md:w-auto" onClick={() => void quota.refetch()}>
            Retry
          </Button>
        </div>
      </div>,
    )
  }

  const answer = quota.data
  const summaries = QUOTA_RUNNERS.map((runner) => summarizeAgent(answer, runner, now)).filter((s) => s !== null)
  const refreshingAll = refresh.pending && refresh.variables?.accountId === undefined
  const allHeld =
    answer.accounts.length > 0 &&
    answer.accounts.every((row) => {
      const next = nextCheckAllowedAt(row)
      return next !== null && now < next
    })
  const firstAllowed = allHeld
    ? Math.min(...answer.accounts.map((row) => nextCheckAllowedAt(row) ?? Infinity))
    : null

  return frame(
    <>
      <div className="flex flex-wrap items-center gap-x-stack gap-y-row">
        <h3 id="agent-quota-summary-title" className="text-[13px] font-semibold text-foreground">
          Plan limits
        </h3>
        {answer.accounts.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="agent-quota-refresh-all"
            aria-disabled={allHeld || refresh.pending ? true : undefined}
            aria-describedby={allHeld ? 'agent-quota-refresh-all-held' : undefined}
            className="w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-55 md:ml-auto md:w-auto"
            onClick={() => {
              if (allHeld || refresh.pending) return
              refresh.run()
            }}
          >
            <RefreshCwIcon aria-hidden="true" className={cn('size-3.5', refreshingAll && 'motion-safe:animate-spin')} />
            {refreshingAll ? 'Refreshing…' : 'Refresh all'}
          </Button>
        ) : null}
      </div>

      {summaries.length === 0 ? (
        <p data-slot="agent-quota-empty" className="text-[13px] text-muted-foreground">
          <span className="block font-medium text-foreground">No plan limits to show</span>
          No Claude Code or Codex login is known on this machine. Install either one and sign in, and
          its short and weekly limits appear here. Until then the sidebar shows no limits summary.
        </p>
      ) : (
        // The live region is a WRAPPER, never the <ul>: role="status" on the list would drop its
        // list semantics (design review B-1 on #870). A changed count is announced once, politely.
        <div role="status" aria-live="polite" aria-atomic="true">
          <ul data-slot="agent-quota-summary-lines" className="flex flex-col gap-1.5">
            {summaries.map((summary) => (
              <li
                key={summary.runner}
                data-runner={summary.runner}
                className="flex items-baseline gap-2 text-[13px] leading-normal text-foreground"
              >
                <StatusDot tone={summary.tone} className="mt-1.75 self-start" aria-hidden="true" />
                <span>
                  {summary.text}
                  {summary.canWork > 0
                    ? summary.out.map((row) =>
                        row.status === 'out' ? (
                          <Fragment key={row.accountId}>
                            {' '}
                            <a
                              href={`#${limitsAnchorId(row.runner, row.accountId)}`}
                              data-action="agent-quota-jump"
                              className="inline-flex min-h-tap items-center text-foreground underline underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-0"
                            >
                              {nameOf(row.runner, row.accountId)}
                            </a>{' '}
                            is out until {formatQuotaTime(row.resetsAt, now)}.
                          </Fragment>
                        ) : null,
                      )
                    : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs leading-normal text-muted-foreground">
        How much of each login’s short and weekly limits is used, as Claude Code and Codex report it,
        with the age of every reading. xezar only shows these facts — it never switches logins, holds
        a task back or changes auto-resume because of them. Times are in this browser’s zone. OpenCode
        and pi do not report plan limits.
      </p>
      <p id="agent-quota-refresh-all-held" className="text-xs leading-normal text-muted-foreground">
        {allHeld && firstAllowed !== null
          ? `Every login was checked in the last 5 minutes. The next check is allowed at ${formatQuotaTime(new Date(firstAllowed).toISOString(), now)}.`
          : 'Refresh all checks every login last checked 5 or more minutes ago, 2 at a time; the rest wait their turn.'}
      </p>
      {hosted ? (
        <p data-slot="agent-quota-hosted" className="text-xs leading-normal text-muted-foreground">
          This cockpit is not on the machine that runs the agents, so it reads the limits again when the
          server reports a change, and every 15 minutes while this tab is open.
        </p>
      ) : null}
    </>,
  )
}

/**
 * The limits half of one account row (`data-slot="account-limits"`): status sentence, one line per
 * window, credits, then the meta line with its Refresh control. Renders nothing while the answer
 * is loading or has no row for this login — the Plan limits block says why.
 */
export function AccountLimits({
  runner,
  accountId,
  name,
  showDetails,
  nameOf,
}: {
  runner: AgentQuotaRunner
  accountId: string
  name: string
  showDetails: boolean
  nameOf: QuotaNameOf
}) {
  const quota = useAgentQuota()
  const account = findQuotaAccount(quota.data, runner, accountId)
  if (!quota.data || !account) return null
  return (
    <AccountLimitsView
      account={account}
      answer={quota.data}
      name={name}
      showDetails={showDetails}
      nameOf={nameOf}
    />
  )
}

export function AccountLimitsView({
  account,
  answer,
  name,
  showDetails,
  nameOf,
}: {
  account: AgentQuotaAccount
  answer: AgentQuotaResponse
  name: string
  showDetails: boolean
  nameOf: QuotaNameOf
}) {
  const now = useNow(30_000)
  const refresh = useRefreshToast(nameOf)
  const reasonId = useId()
  const agent = RUNNER_LABEL[account.runner]
  const age = quotaAgeSeconds(account, answer.generatedAt, now)
  const stale = isQuotaStale(age)
  const status = quotaStatusSentence(account, age, now)
  const windows = quotaWindowLines(account)
  const credits = creditsText(account)
  const next = nextCheckAllowedAt(account)
  const held = next !== null && now < next
  const refreshing =
    refresh.pending && refresh.variables?.accountId === account.accountId && refresh.variables.provider === account.runner
  const noShortWindow = account.shortWindow === null && account.notReported.includes('shortWindow') && windows.length > 0

  return (
    <div
      id={limitsAnchorId(account.runner, account.accountId)}
      data-slot="account-limits"
      data-quota-status={account.status}
      role="group"
      aria-label={`Plan limits of ${name}, ${agent}`}
      className="flex min-w-0 scroll-mt-16 flex-col gap-row border-t border-dashed border-border/80 pt-stack"
    >
      <p data-slot="limit-status" className="flex items-baseline gap-2 text-[13px] leading-normal text-foreground">
        <StatusDot tone={status.tone} className="mt-1.75 self-start" aria-hidden="true" />
        <span>
          <b className="font-semibold">{status.word}</b>
          {status.reason ? <span className="text-muted-foreground"> {status.reason}</span> : null}
        </span>
      </p>
      {status.note ? <p className="text-xs leading-normal text-muted-foreground">{status.note}</p> : null}

      {windows.length > 0 ? (
        <ul data-slot="limit-windows" className="flex flex-col gap-1.5">
          {windows.map((line) => (
            <li
              key={line.key}
              data-slot="limit-window"
              data-window={line.key}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-row gap-y-1 text-[12.5px] leading-normal text-foreground md:grid-cols-[minmax(7.5rem,9rem)_minmax(4rem,7rem)_5.25rem_minmax(0,1fr)] md:gap-x-stack md:gap-y-0"
            >
              <span data-slot="limit-window-label" className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
                {line.label}
              </span>
              <UsageBar usedPercent={line.usedPercent} className="col-span-2 row-start-2 md:col-span-1 md:row-start-auto" />
              <span data-slot="limit-window-used" className="text-right font-medium tabular-nums md:col-start-3 md:row-start-1 md:text-left">
                {line.usedPercent}% used
              </span>
              <span data-slot="limit-window-reset" className="col-span-2 min-w-0 text-muted-foreground [overflow-wrap:anywhere] md:col-span-1">
                resets {formatQuotaTime(line.resetsAt, now)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {noShortWindow ? (
        <p className="text-xs leading-normal text-muted-foreground">{agent} reported no short window for this login.</p>
      ) : null}

      {credits ? (
        <p data-slot="limit-credits" className="text-[12.5px] leading-normal text-foreground">
          <span className="text-muted-foreground">Credits:</span> {credits}
        </p>
      ) : null}

      <div data-slot="limit-meta" className="flex flex-wrap items-center gap-x-row gap-y-1 text-xs leading-normal text-muted-foreground">
        {stale ? (
          <Badge variant="outline" data-slot="limit-stale">
            Stale
          </Badge>
        ) : null}
        <span id={reasonId} data-slot="limit-meta-text" className="min-w-0 flex-[1_1_14rem]">
          Plan: {account.planType ?? '—'} · {sourceText(account, age)}
          {stale ? ' — the numbers may have moved since' : ''}
          {held && next !== null ? ` · next check allowed at ${formatQuotaTime(new Date(next).toISOString(), now)}` : ''}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-action="agent-quota-refresh"
          aria-label={`Refresh limits of ${name}, ${agent}`}
          aria-disabled={held || refresh.pending ? true : undefined}
          aria-describedby={held ? reasonId : undefined}
          className="w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-55 md:w-auto"
          onClick={() => {
            if (held || refresh.pending) return
            refresh.run(account)
          }}
        >
          <RefreshCwIcon aria-hidden="true" className={cn('size-3.5', refreshing && 'motion-safe:animate-spin')} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {showDetails ? <AccountLimitsDetails account={account} ageSeconds={age} now={now} held={held ? next : null} /> : null}
    </div>
  )
}

/** "Plan limits in detail": where the numbers came from, when, and what the tool never reports. */
function AccountLimitsDetails({
  account,
  ageSeconds,
  now,
  held,
}: {
  account: AgentQuotaAccount
  ageSeconds: number
  now: number
  held: number | null
}) {
  const agent = RUNNER_LABEL[account.runner]
  const missing = notReportedWords(account)
  const rows: Array<[string, string]> = [
    ['Where the numbers came from', sourceDetail(account, ageSeconds)],
    ['Read at', formatQuotaTime(account.checkedAt, now)],
  ]
  if (account.credits) {
    rows.push([
      'Credits',
      `${account.credits.hasCredits ? 'available' : 'none available'} · ${
        account.credits.unlimited ? 'unlimited' : 'not unlimited'
      } · balance ${account.credits.balance}`,
    ])
  }
  if (held !== null) rows.push(['Next check allowed', formatQuotaTime(new Date(held).toISOString(), now)])
  if (missing.length > 0) rows.push([`Not reported by ${agent}`, missing.join(', ')])
  return (
    <div data-slot="account-limits-details" className="flex flex-col gap-row rounded-md bg-muted/40 px-list py-stack">
      <h4 className="text-xs font-semibold text-foreground">Plan limits in detail</h4>
      <dl className="grid grid-cols-1 gap-x-stack gap-y-1.5 text-xs md:grid-cols-[minmax(8rem,11rem)_minmax(0,1fr)]">
        {rows.map(([term, value]) => (
          <Fragment key={term}>
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="mb-row min-w-0 text-foreground [overflow-wrap:anywhere] md:mb-0">{value}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  )
}

/**
 * Hosted mode (#867 FR-9, AQ-8): the account routes refuse, so the rows come from the answer
 * alone — the login's name and its limits, no folder, no e-mail, no Connected line.
 */
export function HostedQuotaRows({ nameOf }: { nameOf: QuotaNameOf }) {
  const quota = useAgentQuota()
  if (!quota.data) return null
  const answer = quota.data
  return (
    <div data-slot="agent-quota-hosted-rows" className="flex flex-col gap-section">
      {QUOTA_RUNNERS.map((runner) => {
        const rows = answer.accounts.filter((row) => row.runner === runner)
        if (rows.length === 0) return null
        return (
          <section key={runner} data-provider={runner} aria-label={RUNNER_LABEL[runner]} className="flex flex-col gap-stack">
            <h3 className="text-[13px] font-semibold text-foreground">{RUNNER_LABEL[runner]}</h3>
            <ul className="divide-y divide-border/60 rounded-md border border-border bg-card">
              {rows.map((row) => (
                <HostedQuotaRow key={row.accountId} account={row} answer={answer} nameOf={nameOf} />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

function HostedQuotaRow({
  account,
  answer,
  nameOf,
}: {
  account: AgentQuotaAccount
  answer: AgentQuotaResponse
  nameOf: QuotaNameOf
}) {
  const [showDetails, setShowDetails] = useState(false)
  const name = nameOf(account.runner, account.accountId)
  return (
    <li data-slot="account-row" data-account={account.accountId} className="flex flex-col gap-2 px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span data-slot="account-name" className="text-[13px] font-medium text-foreground">
          {name}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-action="account-details-toggle"
          aria-expanded={showDetails}
          onClick={() => setShowDetails((on) => !on)}
        >
          {showDetails ? 'Hide details' : 'Show details'}
        </Button>
      </div>
      <AccountLimitsView account={account} answer={answer} name={name} showDetails={showDetails} nameOf={nameOf} />
    </li>
  )
}
