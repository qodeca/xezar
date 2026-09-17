import type { RunRecord } from '@qodeca/xezar-api-client'

/**
 * How the task list is filtered, sorted and named — the pure half of the Tasks table, the task
 * thread header and the ⌘K palette.
 *
 * Pure on purpose: this is the behavior worth testing, and it is testable as a table because
 * nothing here touches React, the router or the clock.
 *
 * Behavior is ported from the legacy list (`web/app.js` → `sortedRuns`), which is the parity bar
 * for R1: same order, same queue numbers. The sidebar buckets this module also used to build
 * (Pinned / Needs you / Working / Recent) went with the sidebar task list in #546.
 */

/** Active/Archived. One value shared by the per-project and global Tasks pages, as the legacy
 *  UI's single `state.listView` did. */
export type ListView = 'active' | 'archived'

/**
 * Sort weight per status: needs-you first, then the pipeline in the order it will actually
 * happen — running now, resuming next, waiting for a slot — and finally the outcomes. Ties break
 * on recency. The top of the list therefore answers "what is happening, and what happens next?"
 * without reading a single row's detail.
 *
 * Grown from the legacy `STATUS_ORDER` (waiting/review/running/queued, everything else 9): the
 * terminal states are now ranked among themselves, and `scheduled` — a run waiting out a usage
 * limit — sits between running and queued, because it is work with an appointment rather than an
 * outcome (spec 2026-08-03-auto-resume-after-usage-limit).
 */
const STATUS_ORDER: Partial<Record<RunRecord['status'], number>> = {
  waiting: 0,
  review: 1,
  running: 2,
  queued: 4,
  done: 5,
  failed: 6,
  cancelled: 7,
}

/** Not a status of its own: `scheduled` is a `failed` run holding a live resume deadline, which
 *  is the same rule the status pill reads (`lib/attention.ts`). */
const SCHEDULED_WEIGHT = 3

const statusWeight = (run: RunRecord): number =>
  run.status === 'failed' && run.autoResumeAt !== undefined
    ? SCHEDULED_WEIGHT
    : STATUS_ORDER[run.status] ?? 9

/**
 * What every surface calls a run — the R1-marked plug-in point, now wired (R2 Step 2.4).
 *
 * `titleSummary ?? title`, per the server's contract (`api/types.ts`), except (#623) for malformed
 * auto/legacy summaries whose sentence punctuation was persisted without following whitespace.
 * Those fall back to the honest raw title at display time; persisted state is never rewritten.
 * User and marker titles remain byte-for-byte authoritative.
 *
 * `??`, not `||`: the server never stores an empty summary (trimmed, 1–300 chars), so only
 * absence falls back — a falsy-but-present value would be a server bug worth seeing.
 *
 * Takes the three fields it reads rather than a whole `RunRecord`, for the same reason
 * `AttentionInput` does: the ⌘K palette's cross-project index (`RunIndexEntry`) is a slim row,
 * not a record, and it must name a task exactly as every other surface does. Widening the
 * parameter is what makes that a shared function instead of a second title rule.
 */
export type RunTitleInput = Pick<RunRecord, 'title' | 'titleSummary' | 'titleOrigin'>

export function runTitle(run: RunTitleInput): string {
  const summary = run.titleSummary
  if (summary === undefined) return run.title
  const protectedTitle = run.titleOrigin === 'user' || run.titleOrigin === 'marker'
  return !protectedTitle && /[.!?][A-Z]/.test(summary) ? run.title : summary
}

/**
 * A variant's shared title: `"Add autocomplete (A)"` → `"Add autocomplete"`.
 *
 * The suffix is the server's own convention (`startVariants` appends ` (A)`…` (C)`), so this
 * strips exactly that shape — a title that merely ends in "(D)" or "(draft)" is left alone.
 */
export function groupTitle(run: Pick<RunRecord, 'title'>): string {
  return run.title.replace(/ \([A-C]\)$/, '')
}

/**
 * Queue positions: the `#2` a queued row shows instead of an age.
 *
 * Computed over the *active* queued runs by creation order, which is the order the engine will
 * actually start them in — never over the filtered/sorted view, or the number would change as
 * the table re-sorted underneath it. Archived runs are excluded for the same reason: they are
 * not in the queue.
 */
export function queuePositions(runs: readonly RunRecord[]): Map<string, number> {
  const queued = runs
    .filter((run) => !run.archived && run.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return new Map(queued.map((run, index) => [run.id, index + 1]))
}

/**
 * Runs in the view, ordered: status weight first, then whatever "next" means inside that rank.
 *
 * For most ranks that is recency — newest first, the historical rule. For the two ranks that are
 * genuinely a QUEUE it is the order they will actually happen in, because a list sorted by
 * "what happens next" that then shuffles its own waiting rows is only half the promise:
 *
 *  - `scheduled` — soonest appointment on top. A task resuming at 11:14 sits above one resuming
 *    at 11:40, whichever was created first.
 *  - `queued` — oldest first, which is FIFO and therefore exactly the `#1 in queue` position the
 *    row already prints beside itself. Newest-first rendered those positions backwards.
 *
 * ISO-8601 strings compare lexicographically because every timestamp xezar writes is UTC
 * (`toISOString()` → trailing `Z`), the same reason `read-state.ts` compares them directly.
 */
export function sortRuns(runs: readonly RunRecord[], view: ListView): RunRecord[] {
  return runs
    .filter((run) => (view === 'archived' ? run.archived : !run.archived))
    .sort((a, b) => {
      // Pinned first (#935), ahead of every status weight — that IS what a pin asks for. Among
      // the pinned rows the ordinary rules below then apply unchanged.
      //
      // Ignored in the archived view: archiving unpins, so a pin there is a hand-edit, and
      // history has no "what happens next".
      if (view !== 'archived') {
        const pin = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
        if (pin !== 0) return pin
      }
      const weight = statusWeight(a) - statusWeight(b)
      if (weight !== 0) return weight
      // Equal weights, and that weight is the scheduled one — so both sides carry an
      // `autoResumeAt` (nothing else earns the rank), and the appointment is the answer.
      if (statusWeight(a) === SCHEDULED_WEIGHT && a.autoResumeAt && b.autoResumeAt) {
        const order = a.autoResumeAt.localeCompare(b.autoResumeAt)
        if (order !== 0) return order
      }
      if (a.status === 'queued' && b.status === 'queued') {
        return a.createdAt.localeCompare(b.createdAt)
      }
      return b.createdAt.localeCompare(a.createdAt)
    })
}

/** The tab counts. `waiting` drives the Active tab's attention dot — the one thing that makes an
 *  un-selected tab worth looking at. */
export function listCounts(runs: readonly RunRecord[]): {
  active: number
  archived: number
  waiting: number
} {
  let active = 0
  let archived = 0
  let waiting = 0
  for (const run of runs) {
    if (run.archived) {
      archived += 1
      continue
    }
    active += 1
    if (run.status === 'waiting' || run.status === 'review') waiting += 1
  }
  return { active, archived, waiting }
}
