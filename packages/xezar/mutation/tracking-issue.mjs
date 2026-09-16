// @ts-check
/**
 * Keep ONE GitHub issue in step with the nightly MCP mutation gate (#377).
 *
 * A red scheduled check alone reaches nobody: GitHub mails whoever last touched the cron line, and
 * nobody else. So the `report` job of `.github/workflows/mutation.yml` hands its verdict here, and
 * this script files, updates, reopens or closes a single tracking issue:
 *
 *   | verdict               | no tracking issue | open issue          | closed issue        |
 *   |-----------------------|-------------------|---------------------|---------------------|
 *   | red                   | create it         | comment             | reopen, comment     |
 *   | green                 | nothing           | comment, then close | nothing             |
 *   | green, new survivors  | create, close     | comment, then close | comment (the note)  |
 *
 * THE EARLY NOTE (owner decision, 2026-09-15). New survivors on a night that still clears the floor
 * leave the run green, and the tracking issue gets a comment listing them (`survivors.mjs` puts that
 * list into the summary). A closed issue is commented on, not reopened: the gate is not red. A
 * survivor grouping that could not run at all counts as a note too — a note that says so is how a
 * broken grouping reaches somebody instead of reading as "nothing new".
 *
 * ONE COMMENT PER RUN. Every body this script posts carries `runMarker(runId)`. Before commenting it
 * reads the issue's body and comments, and posts nothing if that run already did — re-running the
 * `report` job of one run changes the issue's state if it must, and never adds a second comment.
 *
 * WHICH ISSUE. The one carrying BOTH the `mutation-nightly` label and the hidden body marker below;
 * the newest if there are several. It is found with `gh issue list --label … --state all`, which
 * reads the issues API directly. Search (`--search`) goes through GitHub's search index, which lags
 * behind an issue created minutes ago, and that lag is how a second red night files a duplicate.
 * The label alone is not enough either: anybody can put a label on an unrelated issue.
 *
 * ONLY ON `main`. A `workflow_dispatch` on a feature branch measures that branch, and a green
 * branch must not close the issue that tracks `main`. The workflow guards the step with
 * `github.ref == 'refs/heads/main'`; `decide` refuses any other ref as well, so the rule holds even
 * if that guard is edited away.
 *
 * FAIL CLOSED. Anything other than an explicit `green` verdict is red — a verdict that got lost on
 * the way here is not a pass. And a `gh issue list` answer that is not a JSON array throws rather
 * than reading as "no issue yet", because against a broken answer "we never loaded the list" and
 * "there is none" are the same branch, and taking it files a duplicate every night.
 *
 * Lives in `packages/xezar/mutation/`, outside the npm tarball. Its suite is
 * `packages/xezar/src/mutation-tracking-issue.test.ts`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const LABEL = 'mutation-nightly'
export const MARKER = '<!-- xezar:mutation-nightly -->'
export const MAIN_REF = 'refs/heads/main'
export const TITLE = 'Nightly MCP mutation gate is red on main'

/** @typedef {{ number: number, state: string, body?: string | null }} Issue */
/** @typedef {{ action: 'skip' | 'none' | 'create' | 'comment' | 'reopen' | 'close' | 'note' | 'create-closed', number?: number, reason: string }} Decision */

/**
 * The hidden line that ties a posted body to one workflow run.
 * @param {string | number} runId
 */
export const runMarker = (runId) => `<!-- xezar:mutation-nightly run=${runId} -->`

/**
 * What the survivor grouping said about new survivors: a count, `null` when the grouping could not
 * run, or `undefined` when nobody passed a count (a caller from before the grouping existed).
 * @param {unknown} value
 * @returns {number | null | undefined}
 */
export function parseNewSurvivors(value) {
  if (value === undefined) return undefined
  const text = String(value).trim()
  return /^\d+$/.test(text) ? Number(text) : null
}

/**
 * Only an explicit `green` is green.
 * @param {unknown} value
 * @returns {'green' | 'red'}
 */
export function normaliseVerdict(value) {
  return value === 'green' ? 'green' : 'red'
}

/**
 * The tracking issue among a `gh issue list --label mutation-nightly --state all` answer.
 * @param {unknown} issues
 * @returns {Issue | undefined}
 */
export function findTrackingIssue(issues) {
  if (!Array.isArray(issues)) {
    throw new Error('the issue list is not an array — refusing to treat an unreadable answer as "no tracking issue"')
  }
  return /** @type {Issue[]} */ (issues)
    .filter((issue) => typeof issue?.number === 'number' && typeof issue.body === 'string' && issue.body.includes(MARKER))
    .sort((a, b) => b.number - a.number)[0]
}

/**
 * What to do with the tracking issue for one run.
 * @param {{ verdict: unknown, ref: string | undefined, issues: unknown, newSurvivors?: number | null }} input
 *   `newSurvivors`: see `parseNewSurvivors`. Only a green run reads it; a red run comments anyway.
 * @returns {Decision}
 */
export function decide({ verdict, ref, issues, newSurvivors }) {
  if (ref !== MAIN_REF) {
    return { action: 'skip', reason: `ref ${ref ?? '(unset)'} is not ${MAIN_REF}; the tracking issue follows main only` }
  }
  const red = normaliseVerdict(verdict) === 'red'
  const issue = findTrackingIssue(issues)
  const open = issue ? issue.state.toUpperCase() === 'OPEN' : false

  if (red) {
    if (!issue) return { action: 'create', reason: 'red, and no tracking issue exists yet' }
    if (open) return { action: 'comment', number: issue.number, reason: `red, and #${issue.number} is already open` }
    return { action: 'reopen', number: issue.number, reason: `red again, so closed #${issue.number} is reopened` }
  }
  const note = newSurvivors === null ? 'the survivor grouping did not run' : (newSurvivors ?? 0) > 0 ? `${newSurvivors} new survivor(s)` : null
  if (issue && open) return { action: 'close', number: issue.number, reason: `green, so open #${issue.number} is closed${note ? ` (${note})` : ''}` }
  if (note && issue) return { action: 'note', number: issue.number, reason: `green with ${note}, so closed #${issue.number} gets a note` }
  if (note) return { action: 'create-closed', reason: `green with ${note}, and no tracking issue exists to note it on` }
  return { action: 'none', reason: 'green, and no tracking issue is open' }
}

/**
 * The `gh` argument lists that carry a decision out, in order.
 * @param {Decision} decision
 * @param {string} summary the run's Markdown summary
 * @param {string | number} [runId] stamped into every body, so a re-run can see it already posted
 * @returns {string[][]}
 */
export function ghCommands(decision, summary, runId) {
  const n = String(decision.number)
  const body = runId === undefined ? summary : `${runMarker(runId)}\n${summary}`
  switch (decision.action) {
    case 'create':
      return [['issue', 'create', '--title', TITLE, '--label', LABEL, '--body', `${MARKER}\n\n${body}`]]
    case 'create-closed':
      // `gh issue create` prints the new issue's URL; `syncTrackingIssue` closes that issue.
      return [['issue', 'create', '--title', TITLE, '--label', LABEL, '--body', `${MARKER}\n\n${body}`]]
    case 'comment':
    case 'note':
      return [['issue', 'comment', n, '--body', body]]
    case 'reopen':
      return [['issue', 'reopen', n], ['issue', 'comment', n, '--body', body]]
    case 'close':
      return [['issue', 'comment', n, '--body', body], ['issue', 'close', n]]
    default:
      return []
  }
}

/**
 * Has this run already posted to the issue? Reads the body and every comment.
 * @param {{ body?: string | null }} issue
 * @param {unknown} comments `gh issue view --json comments` → `.comments`
 * @param {string | number} runId
 */
export function alreadyPosted(issue, comments, runId) {
  if (!Array.isArray(comments)) {
    throw new Error('the comment list is not an array — refusing to treat an unreadable answer as "not posted yet"')
  }
  const marker = runMarker(runId)
  return (issue.body ?? '').includes(marker) || comments.some((comment) => typeof comment?.body === 'string' && comment.body.includes(marker))
}

/**
 * The whole path: make sure the label exists, list, decide, act — at most one comment per run.
 * @param {{ verdict: unknown, ref: string | undefined, summary: string, gh: (args: string[]) => string, runId?: string | number, newSurvivors?: number | null }} options
 * @returns {Decision}
 */
export function syncTrackingIssue({ verdict, ref, summary, gh, runId, newSurvivors }) {
  if (ref !== MAIN_REF) return decide({ verdict, ref, issues: [] })
  // `--force` makes this idempotent: it creates the label once and is a no-op update after that.
  gh(['label', 'create', LABEL, '--color', 'B60205', '--description', 'Tracks the nightly MCP mutation gate (#377)', '--force'])
  const listed = gh(['issue', 'list', '--label', LABEL, '--state', 'all', '--limit', '100', '--json', 'number,state,body'])
  /** @type {unknown} */
  let issues
  try {
    issues = JSON.parse(listed)
  } catch {
    throw new Error(`gh issue list did not answer JSON: ${listed.slice(0, 200)}`)
  }
  const decision = decide({ verdict, ref, issues, newSurvivors })
  let commands = ghCommands(decision, summary, runId)
  if (runId !== undefined && decision.number !== undefined && commands.some((args) => args[1] === 'comment')) {
    const issue = findTrackingIssue(issues) ?? {}
    const viewed = gh(['issue', 'view', String(decision.number), '--json', 'comments'])
    /** @type {unknown} */
    let comments
    try {
      comments = /** @type {{ comments?: unknown }} */ (JSON.parse(viewed)).comments
    } catch {
      throw new Error(`gh issue view did not answer JSON: ${viewed.slice(0, 200)}`)
    }
    if (alreadyPosted(issue, comments, runId)) commands = commands.filter((args) => args[1] !== 'comment')
  }
  for (const args of commands) {
    const answer = gh(args)
    if (decision.action === 'create-closed' && args[1] === 'create') {
      const created = /\/issues\/(\d+)\s*$/.exec(answer)
      if (!created) throw new Error(`gh issue create did not print the new issue's URL: ${answer.slice(0, 200)}`)
      gh(['issue', 'close', created[1]])
    }
  }
  return decision
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  /** @param {string} name */
  const arg = (name) => {
    const at = args.indexOf(name)
    return at === -1 ? undefined : args[at + 1]
  }
  const summaryPath = arg('--summary')
  if (!summaryPath) {
    process.stderr.write('usage: tracking-issue.mjs --verdict green|red --summary <file> [--ref <ref>] [--run-id <id>] [--new-survivors <count>|unknown]\n')
    process.exit(2)
  }
  const decision = syncTrackingIssue({
    verdict: arg('--verdict'),
    ref: arg('--ref') ?? process.env.GITHUB_REF,
    summary: readFileSync(summaryPath, 'utf8'),
    runId: arg('--run-id') ?? process.env.GITHUB_RUN_ID,
    newSurvivors: parseNewSurvivors(arg('--new-survivors')),
    gh: (ghArgs) => execFileSync('gh', ghArgs, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
  })
  process.stdout.write(`${decision.action}${decision.number ? ` #${decision.number}` : ''}: ${decision.reason}\n`)
}
