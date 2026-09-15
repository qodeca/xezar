// @ts-check
/**
 * Keep ONE GitHub issue in step with the nightly MCP mutation gate (#377).
 *
 * A red scheduled check alone reaches nobody: GitHub mails whoever last touched the cron line, and
 * nobody else. So the `report` job of `.github/workflows/mutation.yml` hands its verdict here, and
 * this script files, updates, reopens or closes a single tracking issue:
 *
 *   | verdict | no tracking issue | open issue          | closed issue        |
 *   |---------|-------------------|---------------------|---------------------|
 *   | red     | create it         | comment             | reopen, comment     |
 *   | green   | nothing           | comment, then close | nothing             |
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
/** @typedef {{ action: 'skip' | 'none' | 'create' | 'comment' | 'reopen' | 'close', number?: number, reason: string }} Decision */

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
 * @param {{ verdict: unknown, ref: string | undefined, issues: unknown }} input
 * @returns {Decision}
 */
export function decide({ verdict, ref, issues }) {
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
  if (issue && open) return { action: 'close', number: issue.number, reason: `green, so open #${issue.number} is closed` }
  return { action: 'none', reason: 'green, and no tracking issue is open' }
}

/**
 * The `gh` argument lists that carry a decision out, in order.
 * @param {Decision} decision
 * @param {string} summary the run's Markdown summary
 * @returns {string[][]}
 */
export function ghCommands(decision, summary) {
  const n = String(decision.number)
  switch (decision.action) {
    case 'create':
      return [['issue', 'create', '--title', TITLE, '--label', LABEL, '--body', `${MARKER}\n\n${summary}`]]
    case 'comment':
      return [['issue', 'comment', n, '--body', summary]]
    case 'reopen':
      return [['issue', 'reopen', n], ['issue', 'comment', n, '--body', summary]]
    case 'close':
      return [['issue', 'comment', n, '--body', summary], ['issue', 'close', n]]
    default:
      return []
  }
}

/**
 * The whole path: make sure the label exists, list, decide, act.
 * @param {{ verdict: unknown, ref: string | undefined, summary: string, gh: (args: string[]) => string }} options
 * @returns {Decision}
 */
export function syncTrackingIssue({ verdict, ref, summary, gh }) {
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
  const decision = decide({ verdict, ref, issues })
  for (const args of ghCommands(decision, summary)) gh(args)
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
    process.stderr.write('usage: tracking-issue.mjs --verdict green|red --summary <file> [--ref <ref>]\n')
    process.exit(2)
  }
  const decision = syncTrackingIssue({
    verdict: arg('--verdict'),
    ref: arg('--ref') ?? process.env.GITHUB_REF,
    summary: readFileSync(summaryPath, 'utf8'),
    gh: (ghArgs) => execFileSync('gh', ghArgs, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
  })
  process.stdout.write(`${decision.action}${decision.number ? ` #${decision.number}` : ''}: ${decision.reason}\n`)
}
