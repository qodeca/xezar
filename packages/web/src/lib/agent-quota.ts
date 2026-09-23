import { looksLikeAccountIdentity } from '@qodeca/xezar-api-client'
import type {
  AgentProfile,
  AgentQuotaAccount,
  AgentQuotaModelWindow,
  AgentQuotaResponse,
  AgentQuotaRunner,
  AgentQuotaWindow,
  BackendCheck,
} from '@qodeca/xezar-api-client'

import type { StatusDotTone } from '@/components/status-dot'
import { shortAge } from '@/lib/format'
import { RUNNER_LABEL } from '@/lib/runner-label'

/**
 * The words and numbers the cockpit prints for one agent-quota answer (#867 S5).
 *
 * Everything here FORMATS the answer; nothing re-decides it. `status`, every percentage and every
 * reset come verbatim from `GET /api/v1/workspace/agent-quota` (D1, D37: the cockpit shows what the
 * MCP returns). Since #888 (S3) the answer also carries `stale`, `refreshing`, `nextCheckAt`,
 * `statusReason`, `warnings`, `toolVersion`/`minimumVersion` and `unavailableReason`, and those are
 * read as sent. They are additive (optional on the reader schema), so an OLDER answer without them
 * still renders: only then does a helper below fall back to a value derived from the row itself.
 * What stays derived either way:
 *
 * - the per-agent summary line (D30) counts the rows' `status` — the answer has no `summaries[]`;
 * - times are shown in the reader's zone with its abbreviation and offset, because the contract's
 *   times are UTC and it names no server zone (D32 asked for the server's zone).
 *
 * The answer's `source` and `statusReason` are open strings on the reader side: a value this
 * cockpit does not know renders as unknown, and the row is then read by its `status` alone —
 * `unknown` never means budget.
 */

/** Past this age a reading is marked stale (#867 D16: the background re-check threshold). */
export const QUOTA_STALE_SECONDS = 15 * 60

/** The minimum gap between two checks of one login (#867 FR-7, D23). */
export const QUOTA_CHECK_GAP_MS = 5 * 60_000

/** How often a hosted cockpit re-reads the answer while its tab is visible (#867 FR-11). */
export const QUOTA_HOSTED_REFETCH_MS = 15 * 60_000

export const QUOTA_RUNNERS: readonly AgentQuotaRunner[] = ['claude', 'codex']

/** The answer's rows for one agent, in the answer's own order (the server's FR-1 order). */
export function accountsOf(answer: AgentQuotaResponse, runner: AgentQuotaRunner): AgentQuotaAccount[] {
  return answer.accounts.filter((account) => account.runner === runner)
}

/** The row for one login, matched the way the settings pane names it (`default` = built-in). */
export function findQuotaAccount(
  answer: AgentQuotaResponse | undefined,
  runner: AgentQuotaRunner,
  accountId: string,
): AgentQuotaAccount | undefined {
  return answer?.accounts.find((account) => account.runner === runner && account.accountId === accountId)
}

/**
 * What a login is called on screen: the pane's own account name when the account listing has it
 * (`Built-in login`, or the label — never one that reads as an e-mail address), otherwise the
 * answer's id under the same two rules. Hosted mode has no listing, so it always takes the second
 * branch; the answer itself carries no folder, e-mail or organisation (#867 FR-9).
 */
export function quotaLoginName(
  profiles: readonly Pick<AgentProfile, 'provider' | 'id' | 'isDefault' | 'label'>[] | undefined,
  runner: AgentQuotaRunner,
  accountId: string,
): string {
  const match = profiles?.find((profile) => profile.provider === runner && profile.id === accountId)
  if (match?.isDefault || (!match && accountId === 'default')) return 'Built-in login'
  const name = match ? match.label : accountId
  return looksLikeAccountIdentity(name) ? 'Name hidden' : name
}

// ---- time and age --------------------------------------------------------------------------

function zoneParts(date: Date, timeZone: string | undefined): { abbreviation: string; offset: string } {
  const part = (locale: string, style: 'short' | 'longOffset'): string =>
    new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: style })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName')?.value ?? ''
  // en-US knows the North American abbreviations, en-GB the European ones; both fall back to a
  // "GMT+2"-style name, which says nothing the offset beside it does not, so it is dropped.
  const named = [part('en-US', 'short'), part('en-GB', 'short')].find((name) => name !== '' && !/^GMT[+-]/.test(name))
  const long = part('en-US', 'longOffset')
  const offset = long === 'GMT' || long === '' ? '+00:00' : long.replace(/^GMT/, '')
  return { abbreviation: named ?? '', offset }
}

function dayKey(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/**
 * `17:10 CEST (+02:00)` today, `Sep 28, 19:00 CEST (+02:00)` on another day (#867 D32, the
 * mockup's copy deck § 7). Always the zone name AND the offset, so a reader elsewhere is never
 * misled; the zone is the reader's (see the module note). Returns '' for an unparseable value.
 */
export function formatQuotaTime(iso: string, now: number = Date.now(), timeZone?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
  const sameDay = dayKey(date, timeZone) === dayKey(new Date(now), timeZone)
  const day = sameDay
    ? ''
    : `${new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(date)}, `
  const { abbreviation, offset } = zoneParts(date, timeZone)
  return `${day}${clock} ${abbreviation ? `${abbreviation} ` : ''}(${offset})`
}

/**
 * The row's age now, in seconds: the answer's own `ageSeconds` plus the time since the answer was
 * built. At the instant the answer arrives this IS `ageSeconds`; afterwards it keeps counting, so a
 * page left open does not claim a reading is younger than it is.
 */
export function quotaAgeSeconds(account: AgentQuotaAccount, generatedAt: string, now: number): number {
  const built = Date.parse(generatedAt)
  const since = Number.isNaN(built) ? 0 : Math.max(0, Math.floor((now - built) / 1000))
  return account.ageSeconds + since
}

/** `4m` — the cockpit's one age grammar (`shortAge`, lib/format.ts). */
export function ageText(seconds: number): string {
  return shortAge(new Date(0).toISOString(), seconds * 1000)
}

export function isQuotaStale(ageSeconds: number): boolean {
  return ageSeconds > QUOTA_STALE_SECONDS
}

/** Is this row stale? The server's `stale` when it sends one; the age rule for an older answer. */
export function accountIsStale(account: AgentQuotaAccount, ageSeconds: number): boolean {
  return typeof account.stale === 'boolean' ? account.stale : isQuotaStale(ageSeconds)
}

/** The sources that are a limit check (the direct request, or its /usage text fallback). */
const CHECK_SOURCES = new Set(['check', 'check-text'])

/**
 * When the next check of this login is allowed, or null when nothing holds it back. The server's
 * `nextCheckAt` decides whenever the answer carries the key — `null` there means it holds nothing
 * back, even right after a check. Only an older answer without the key falls back to `checkedAt` +
 * 5 minutes for a reading that came from a check; a live reading or a failed task says nothing
 * about when the last check ran.
 */
export function nextCheckAllowedAt(account: AgentQuotaAccount): number | null {
  if (account.nextCheckAt !== undefined) {
    if (account.nextCheckAt === null) return null
    const next = Date.parse(account.nextCheckAt)
    return Number.isNaN(next) ? null : next
  }
  if (!CHECK_SOURCES.has(account.source)) return null
  const checked = Date.parse(account.checkedAt)
  return Number.isNaN(checked) ? null : checked + QUOTA_CHECK_GAP_MS
}

/** The `statusReason` values a new check cannot change: the tool must be installed or updated,
 *  or the login is an API key. Refresh is not offered for them (the mockup's AQ-4). */
const UNCHECKABLE_REASONS = new Set(['version-too-old', 'not-installed', 'api-key'])

/** Can a check of this login tell anything new? Only an `unknown` row carries a reason. */
export function quotaCanRefresh(account: AgentQuotaAccount): boolean {
  return !(account.status === 'unknown' && account.statusReason && UNCHECKABLE_REASONS.has(account.statusReason))
}

/** The server's warnings, minus one that only repeats the row's `unavailableReason` (which the
 *  status sentence already words and the details panel quotes). */
export function quotaWarnings(account: AgentQuotaAccount): string[] {
  return (account.warnings ?? []).filter((warning) => warning !== account.unavailableReason)
}

// ---- windows -------------------------------------------------------------------------------

function lengthLabel(minutes: number): string {
  if (minutes === 300) return '5-hour window'
  if (minutes === 10_080) return 'Weekly'
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`
  return `${minutes}-minute window`
}

export type QuotaWindowLine = {
  key: string
  label: string
  usedPercent: number
  resetsAt: string
}

/** One line per window the answer carries, in the answer's order: short, weekly, then per model. */
export function quotaWindowLines(account: AgentQuotaAccount): QuotaWindowLine[] {
  const lines: QuotaWindowLine[] = []
  const add = (key: string, label: string, window: AgentQuotaWindow | AgentQuotaModelWindow) =>
    lines.push({ key, label, usedPercent: window.usedPercent, resetsAt: window.resetsAt })
  if (account.shortWindow) add('short', lengthLabel(account.shortWindow.windowMinutes), account.shortWindow)
  if (account.weeklyWindow) {
    const base = lengthLabel(account.weeklyWindow.windowMinutes)
    // Claude Code's weekly window covers every model and it also reports per-model ones, so the
    // plain word would be ambiguous there. Codex's per-model limits are separate metered buckets and
    // Codex never says its ordinary one covers every model, so its weekly window keeps the plain word.
    add('weekly', account.runner === 'claude' && base === 'Weekly' ? 'Weekly, all models' : base, account.weeklyWindow)
  }
  for (const [index, window] of (account.modelWindows ?? []).entries()) {
    add(`model-${index}`, `${lengthLabel(window.windowMinutes)}, ${window.model}`, window)
  }
  return lines
}

// ---- status --------------------------------------------------------------------------------

const KNOWN_FACTS = ['shortWindow', 'weeklyWindow', 'modelWindows', 'credits', 'planType'] as const

/** Did this row report anything about a plan at all — a window, credits or a plan name? */
export function reportsAnyPlanFact(account: AgentQuotaAccount): boolean {
  return KNOWN_FACTS.some((field) => account[field] !== null)
}

/** `5-hour window` → `5-hour limit`, `Weekly, all models` → `weekly limit`, `Weekly, Fable` →
 *  `weekly Fable limit`: the window's label as the name of the limit it enforces. */
function limitPhrase(label: string): string {
  const [base = label, model] = label.split(', ')
  const length = base.replace(/ window$/, '')
  const scoped = model && model !== 'all models' ? ` ${model}` : ''
  return `${length.charAt(0).toLowerCase()}${length.slice(1)}${scoped} limit`
}

export type QuotaStatusSentence ={ tone: StatusDotTone; word: string; reason: string | null; note: string | null }

/** The bold status word and its muted reason, from `status` alone plus the row's own facts. */
export function quotaStatusSentence(account: AgentQuotaAccount, ageSeconds: number, now: number): QuotaStatusSentence {
  const agent = RUNNER_LABEL[account.runner]
  const unknown = (reason: string, note: string | null = null): QuotaStatusSentence => ({
    tone: 'neutral',
    word: 'Limits unknown',
    reason: `— ${reason}`,
    note,
  })
  if (account.status === 'ok') return { tone: 'success', word: 'Can work', reason: null, note: null }
  if (account.status === 'out') {
    const spent = quotaWindowLines(account).find((line) => line.usedPercent >= 100)
    const reason =
      account.source === 'failedRun'
        ? `— a task under this login stopped on the usage limit ${ageText(ageSeconds)} ago.`
        : spent
          ? `— the ${limitPhrase(spent.label)} is used up.`
          : '— a plan limit is used up.'
    return { tone: 'danger', word: `Out until ${formatQuotaTime(account.resetsAt, now)}`, reason, note: null }
  }
  // `unknown` from here on. A reason names why; one this cockpit does not know is not guessed at.
  const version = account.toolVersion ? ` ${account.toolVersion}` : ''
  switch (account.statusReason) {
    case 'api-key':
      return { tone: 'neutral', word: 'Limits not reported', reason: '— API-key logins do not report plan limits.', note: null }
    case 'version-too-old':
      return unknown(
        `update ${agent} to at least ${account.minimumVersion ?? 'a newer version'} to report limits.`,
        account.toolVersion ? `${agent} ${account.toolVersion} is installed.` : null,
      )
    case 'not-installed':
      return unknown(`${agent} is not installed on this machine.`)
    case 'format-changed':
      return unknown(`${agent}${version} changed how it reports usage, so xezar cannot read it.`)
    case 'check-failed':
      return unknown('the last check failed.')
  }
  if (account.source === 'none') {
    return account.refreshing
      ? { tone: 'neutral', word: 'Checking the limits…', reason: null, note: null }
      : unknown('this login has not been checked yet.')
  }
  if (account.statusReason || !KNOWN_SOURCES.has(account.source)) {
    return unknown(`${agent} did not say whether this login can work.`)
  }
  if (!reportsAnyPlanFact(account)) {
    return {
      tone: 'neutral',
      word: 'Limits unknown',
      reason: `— ${agent} reported no limits for this login.`,
      note: 'Its answer had no session or weekly lines, so xezar cannot say how much is left. Tasks can still start under this login.',
    }
  }
  return { tone: 'neutral', word: 'Limits unknown', reason: `— ${agent} did not say whether this login can work.`, note: null }
}

// ---- credits, source, not reported ---------------------------------------------------------

/** Codex's credits line; null when the answer carries no credits object. */
export function creditsText(account: AgentQuotaAccount): string | null {
  const credits = account.credits
  if (!credits) return null
  if (credits.unlimited) return 'unlimited.'
  if (credits.hasCredits) return `${credits.balance} available.`
  return `none — balance ${credits.balance}.`
}

/** Every `source` this cockpit has words for; any other value is shown as an unknown source. */
const KNOWN_SOURCES = new Set(['live', 'failedRun', 'check', 'check-text', 'none'])

/** A check that ran and got no reading back: its time is when it was TRIED, not when it read. */
function triedOnly(account: AgentQuotaAccount): boolean {
  return account.status === 'unknown' && !!account.statusReason && !reportsAnyPlanFact(account)
}

/** Where the reading came from, with its age: the meta line's words. */
export function sourceText(account: AgentQuotaAccount, ageSeconds: number): string {
  const age = ageText(ageSeconds)
  switch (account.source) {
    case 'live':
      return `seen ${age} ago in a running task`
    case 'failedRun':
      return `from a failed task ${age} ago`
    case 'none':
      return 'Not checked yet'
    case 'check':
    case 'check-text':
      return triedOnly(account) ? `tried ${age} ago` : `checked ${age} ago`
    default:
      return `read ${age} ago, from a source this cockpit does not know`
  }
}

/** The details panel's longer sentence for the same fact. */
export function sourceDetail(account: AgentQuotaAccount, ageSeconds: number): string {
  const age = ageText(ageSeconds)
  switch (account.source) {
    case 'live':
      return `A running task under this login, ${age} ago.`
    case 'failedRun':
      return `A task under this login that stopped on the usage limit, ${age} ago.`
    case 'none':
      return 'No check has run for this login yet.'
    case 'check':
      return triedOnly(account)
        ? `A limit check tried ${age} ago, with no reading back.`
        : `A limit check, ${age} ago. It uses no model tokens.`
    case 'check-text':
      return `A limit check, ${age} ago, read from the tool's /usage text. It uses no model tokens.`
    default:
      return `A source this version of the cockpit does not know (“${account.source}”), ${age} ago.`
  }
}

/** `Codex 0.160.0 (limits need 0.155.1 or later)`; null when the answer read no version. */
export function toolVersionText(account: AgentQuotaAccount): string | null {
  if (!account.toolVersion) return null
  const installed = `${RUNNER_LABEL[account.runner]} ${account.toolVersion}`
  return account.minimumVersion ? `${installed} (limits need ${account.minimumVersion} or later)` : installed
}

const NOT_REPORTED_WORDS: Record<string, string> = {
  shortWindow: 'short window',
  weeklyWindow: 'weekly window',
  modelWindows: 'per-model windows',
  credits: 'credits',
  planType: 'plan',
}

/** Every `notReported` name in words; a name this cockpit does not know yet is shown as sent. */
export function notReportedWords(account: AgentQuotaAccount): string[] {
  return account.notReported.map((field) => NOT_REPORTED_WORDS[field] ?? field)
}

// ---- per-agent summary and the chip --------------------------------------------------------

export type QuotaAgentSummary = {
  runner: AgentQuotaRunner
  total: number
  canWork: number
  out: AgentQuotaAccount[]
  unknown: AgentQuotaAccount[]
  /** The earliest reset among the logins that are out, when none can work. */
  firstFreeAt: string | null
  tone: StatusDotTone
  text: string
}

/**
 * One agent's D30 line, e.g. `Claude Code: 1 of 3 logins can work.` The counts are the rows'
 * `status`, nothing more: `ok` can work, `out` cannot, `unknown` is neither.
 */
export function summarizeAgent(answer: AgentQuotaResponse, runner: AgentQuotaRunner, now: number): QuotaAgentSummary | null {
  const rows = accountsOf(answer, runner)
  if (rows.length === 0) return null
  const canWork = rows.filter((row) => row.status === 'ok').length
  const out = rows.filter((row) => row.status === 'out')
  const unknown = rows.filter((row) => row.status === 'unknown')
  const firstFree =
    canWork === 0 && out.length > 0
      ? out.map((row) => (row.status === 'out' ? row.resetsAt : '')).sort()[0] ?? null
      : null
  const tone: StatusDotTone =
    canWork === rows.length ? 'success' : canWork === 0 && out.length > 0 ? 'danger' : canWork > 0 ? 'pending' : 'neutral'
  const noun = rows.length === 1 ? 'login' : 'logins'
  const text = `${RUNNER_LABEL[runner]}: ${canWork} of ${rows.length} ${noun} can work${
    firstFree ? `; first free at ${formatQuotaTime(firstFree, now)}` : ''
  }.`
  return { runner, total: rows.length, canWork, out, unknown, firstFreeAt: firstFree, tone, text }
}

/**
 * Which agents the chip shows (#867 D38): installed, and with at least one login that reported a
 * plan — a window, credits or a plan name, or a definite `out`. The contract carries no login kind,
 * so an API-key login and a subscription login that reported nothing look the same; an agent whose
 * every login reported nothing is left out rather than shown as "0 of n".
 */
export function chipSummaries(
  answer: AgentQuotaResponse | undefined,
  checks: readonly BackendCheck[] | undefined,
  now: number,
): QuotaAgentSummary[] {
  if (!answer || !checks) return []
  return QUOTA_RUNNERS.flatMap((runner) => {
    const installed = checks.some((check) => check.name === runner && check.available === true)
    if (!installed) return []
    const rows = accountsOf(answer, runner)
    if (!rows.some((row) => row.status === 'out' || reportsAnyPlanFact(row))) return []
    const summary = summarizeAgent(answer, runner, now)
    return summary ? [summary] : []
  })
}

/** The worst of several tones, for the phone chip's single combined dot. */
export function worstTone(tones: readonly StatusDotTone[]): StatusDotTone {
  for (const tone of ['danger', 'pending', 'success'] as const) if (tones.includes(tone)) return tone
  return 'neutral'
}
