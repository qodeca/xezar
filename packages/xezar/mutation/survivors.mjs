// @ts-check
/**
 * Sort the nightly MCP mutation gate's survivors into NEW, ALREADY SEEN and KNOWN (#377, PR 2).
 *
 * A score says the gate is above or below its floor. It cannot say whether tonight's survivors are
 * the ones #338 and #353 already track, or a test that got weaker today. That second question is
 * the one somebody can act on, so the `report` job answers it with three groups:
 *
 *   - KNOWN        — in the STARTING LIST, the survivors of the first complete nightly run on `main`
 *                    (run 34999068325 on `fe33541`), committed at `docs/testing/mcp-mutation-survivors.json`.
 *                    An entry there may carry the issue that tracks it (#338, #353); the tag stays.
 *   - ALREADY SEEN — not in the starting list, but a survivor of the PREVIOUS complete main run too.
 *   - NEW          — in neither. These are what the early note on the tracking issue lists.
 *
 * Both halves are the owner's decisions of 2026-09-15, recorded on #377.
 *
 * WHAT "THE SAME SURVIVOR" MEANS. Not a line number: any edit above a mutant moves it, and every
 * survivor below that edit would read as new. The key is the file, the mutator, a hash of the
 * source text the mutant replaces and of its replacement, and — for the same text mutated the same
 * way twice in one file — its position among those twins. Moving code keeps the key; changing the
 * mutated text itself makes a new one, which is right: it is a different mutant.
 *
 * WHICH STATUSES. `Survived` and `NoCoverage`, the two halves of Stryker's "undetected". A new
 * function nobody tests produces no-coverage mutants, not survivors, and leaving those out would
 * hide exactly the regression this list exists to show.
 *
 * WHERE "PREVIOUS" COMES FROM. Each complete run uploads its own list as the `mutation-survivors`
 * artifact; the next run downloads the newest one from another `main` run. Never runtime state in
 * the repository, and never an incomplete run's list: a run with a missing shard uploads nothing,
 * so a survivor of that shard is not forgotten by the night after. When no previous list can be
 * found, the report SAYS so — "we could not compare" and "nothing was seen before" are different
 * answers and must not read the same.
 *
 * Used by `.github/workflows/mutation.yml` through `npm run test:mutation:mcp:survivors`. Its suite
 * is `packages/xezar/src/mutation-survivors.test.ts`. How the starting list is refreshed is in
 * docs/testing/coverage-gaps.md § 10.8.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { normaliseFileKey, shardArtifact } from './aggregate.mjs'
import { DEFAULT_SHARDS, mutationShardPlan, repoRoot } from './shards.mjs'

/** The committed starting list. */
export const BASELINE = 'docs/testing/mcp-mutation-survivors.json'
/** The artifact each complete run uploads, and the next run reads back. */
export const ARTIFACT = 'mutation-survivors'
/** Stryker statuses that count as a survivor here. */
export const SURVIVOR_STATUSES = ['Survived', 'NoCoverage']
/** How many rows of a group a Markdown report lists before it says "and N more". */
export const LIST_LIMIT = 100

/** @typedef {{ key: string, file: string, line: number, mutator: string, status: string, tracked?: number[] }} Survivor */
/** @typedef {{ schema: 1, source?: Record<string, unknown>, tracked?: Record<string, string>, survivors: Survivor[] }} SurvivorList */

/**
 * The source text a Stryker location covers. Lines and columns are 1-based in its JSON report.
 * @param {string} source
 * @param {{ start: { line: number, column: number }, end: { line: number, column: number } }} location
 */
export function originalText(source, location) {
  const lines = source.split('\n')
  const { start, end } = location
  if (start.line === end.line) return (lines[start.line - 1] ?? '').slice(start.column - 1, end.column - 1)
  const middle = lines.slice(start.line, end.line - 1)
  return [(lines[start.line - 1] ?? '').slice(start.column - 1), ...middle, (lines[end.line - 1] ?? '').slice(0, end.column - 1)].join('\n')
}

/**
 * Every survivor in one parsed Stryker JSON report, with a key that does not depend on its line.
 * The key is unique within its file; `identity` makes it unique across the scope.
 * @param {unknown} report
 * @param {string} [root]
 * @returns {Survivor[]}
 */
export function survivorsFromReport(report, root = repoRoot) {
  const files = /** @type {Record<string, { source?: string, mutants?: any[] }> | undefined} */ (
    /** @type {{ files?: unknown }} */ (report ?? {}).files
  )
  if (!files || typeof files !== 'object') throw new Error('not a Stryker JSON report: no `files` object')
  /** @type {Survivor[]} */
  const out = []
  for (const [rawKey, value] of Object.entries(files)) {
    const file = normaliseFileKey(rawKey, root)
    const source = typeof value?.source === 'string' ? value.source : null
    if (source === null) throw new Error(`${file}: the report carries no source text, so its survivors cannot be keyed`)
    const found = (value.mutants ?? [])
      .filter((mutant) => SURVIVOR_STATUSES.includes(mutant?.status))
      .sort((a, b) => a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column)
    /** @type {Map<string, number>} */
    const twins = new Map()
    for (const mutant of found) {
      const hash = createHash('sha256')
        .update(String(mutant.mutatorName))
        .update('\0')
        .update(originalText(source, mutant.location))
        .update('\0')
        .update(String(mutant.replacement ?? ''))
        .digest('hex')
        .slice(0, 16)
      const nth = twins.get(hash) ?? 0
      twins.set(hash, nth + 1)
      out.push({ key: `${hash}#${nth}`, file, line: mutant.location.start.line, mutator: mutant.mutatorName, status: mutant.status })
    }
  }
  return out
}

/**
 * One survivor's identity across the whole scope: its file and its in-file key.
 * @param {{ file: string, key: string }} survivor
 */
export const identity = (survivor) => `${survivor.file}#${survivor.key}`

/**
 * Parse and check a survivor list — the committed starting list or a downloaded previous one.
 * @param {unknown} value
 * @returns {SurvivorList}
 */
export function parseSurvivorList(value) {
  const list = /** @type {Partial<SurvivorList> | null} */ (value)
  if (!list || list.schema !== 1 || !Array.isArray(list.survivors)) {
    throw new Error('not a survivor list: expected `{ "schema": 1, "survivors": [...] }`')
  }
  for (const entry of list.survivors) {
    if (typeof entry?.key !== 'string' || typeof entry.file !== 'string') throw new Error('a survivor list entry has no `key` or `file`')
  }
  return /** @type {SurvivorList} */ (list)
}

/**
 * The three groups.
 * @param {{ current: Survivor[], baseline: SurvivorList, previous: SurvivorList | null }} input
 *   `previous: null` means no previous list could be found — NOT that it was empty.
 */
export function groupSurvivors({ current, baseline, previous }) {
  /** @type {Map<string, Survivor>} */
  const known = new Map(baseline.survivors.map((entry) => [identity(entry), entry]))
  const seen = new Set((previous?.survivors ?? []).map(identity))
  /** @type {{ new: Survivor[], seen: Survivor[], known: Survivor[], previousAvailable: boolean }} */
  const groups = { new: [], seen: [], known: [], previousAvailable: previous !== null }
  for (const survivor of current) {
    const starting = known.get(identity(survivor))
    if (starting) groups.known.push(starting.tracked?.length ? { ...survivor, tracked: starting.tracked } : survivor)
    else if (seen.has(identity(survivor))) groups.seen.push(survivor)
    else groups.new.push(survivor)
  }
  return groups
}

/**
 * Carry the issue tags of an old list onto a new one, by key. Used when the starting list is refreshed.
 * @param {Survivor[]} survivors
 * @param {SurvivorList | null} old
 * @param {{ issue: number, file: string, line: number, mutator?: string }[]} [extra] tags to add by file and
 *   line, and by mutator when the issue names one
 * @returns {Survivor[]}
 */
export function carryTags(survivors, old, extra = []) {
  /** @type {Map<string, number[]>} */
  const byKey = new Map((old?.survivors ?? []).filter((entry) => entry.tracked?.length).map((entry) => [identity(entry), /** @type {number[]} */ (entry.tracked)]))
  return survivors.map((survivor) => {
    const tags = new Set(byKey.get(identity(survivor)) ?? [])
    for (const tag of extra) {
      if (tag.file === survivor.file && tag.line === survivor.line && (!tag.mutator || tag.mutator === survivor.mutator)) tags.add(tag.issue)
    }
    const { tracked: _drop, ...rest } = survivor
    return tags.size ? { ...rest, tracked: [...tags].sort((a, b) => a - b) } : rest
  })
}

/**
 * Serialise a list one entry per line, so a refresh reads as a diff of survivors.
 * @param {SurvivorList} list
 */
export function formatSurvivorList(list) {
  const head = JSON.stringify({ schema: 1, source: list.source ?? {}, tracked: list.tracked ?? {} }, null, 2).replace(/\n}$/, '')
  const rows = list.survivors.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n')
  return `${head},\n  "survivors": [\n${rows}\n  ]\n}\n`
}

/**
 * @param {Survivor} survivor
 */
const row = (survivor) =>
  `| \`${survivor.file.replace('packages/xezar/src/mcp/', '')}:${survivor.line}\` | ${survivor.mutator} | ${survivor.status === 'NoCoverage' ? 'no coverage' : 'survived'} | ${(survivor.tracked ?? []).map((n) => `#${n}`).join(' ')} |`

/**
 * @param {string} title
 * @param {Survivor[]} survivors
 * @param {number} limit
 */
function table(title, survivors, limit) {
  if (survivors.length === 0) return []
  const lines = [title, '', '| Where | Mutator | Status | Tracked in |', '|---|---|---|---|', ...survivors.slice(0, limit).map(row)]
  if (survivors.length > limit) lines.push('', `…and ${survivors.length - limit} more — the \`${ARTIFACT}\` artifact of the run has all of them.`)
  lines.push('')
  return lines
}

/**
 * The Markdown the `report` job appends to its summary, and so to the tracking issue.
 * @param {ReturnType<typeof groupSurvivors>} groups
 * @param {{ missingShards?: number[], repoUrl?: string, limit?: number }} [context]
 */
export function renderSurvivorMarkdown(groups, context = {}) {
  const limit = context.limit ?? LIST_LIMIT
  const baselineLink = context.repoUrl ? `[the starting list](${context.repoUrl}/blob/main/${BASELINE})` : `the starting list (\`${BASELINE}\`)`
  const tracked = groups.known.filter((s) => s.tracked?.length)
  const lines = [
    '### Survivors: new, already seen, known',
    '',
    '| Group | Count |',
    '|---|---:|',
    `| **New** — in neither ${groups.previousAvailable ? 'the starting list nor the previous main run' : 'the starting list (no previous run to compare)'} | ${groups.new.length} |`,
    `| Already seen — in the previous main run | ${groups.previousAvailable ? groups.seen.length : 'n/a'} |`,
    `| Known — in ${baselineLink} | ${groups.known.length} |`,
    '',
  ]
  if (!groups.previousAvailable) {
    lines.push('No survivor list from a previous complete run on `main` was found, so "already seen" could not be checked: every survivor outside the starting list is listed as new.', '')
  }
  if (context.missingShards?.length) {
    lines.push(`Shard${context.missingShards.length > 1 ? 's' : ''} ${context.missingShards.join(', ')} reported nothing, so ${context.missingShards.length > 1 ? 'their' : 'its'} survivors are missing from every group, and this run uploads no survivor list.`, '')
  }
  lines.push(...table('#### New', groups.new, limit))
  lines.push(...table('#### Already seen', groups.seen, limit))
  lines.push(...table('#### Known and tracked', tracked, limit))
  return lines.join('\n')
}

/**
 * The newest `mutation-survivors` artifact from another `main` run, from the answer of
 * `GET /repos/{repo}/actions/artifacts?name=mutation-survivors` (newest first).
 * @param {unknown} answer
 * @param {string | number} runId this run, which must not pick itself
 * @returns {number | null}
 */
export function pickPreviousRun(answer, runId) {
  const artifacts = /** @type {{ artifacts?: unknown }} */ (answer ?? {}).artifacts
  if (!Array.isArray(artifacts)) throw new Error('the artifact list is not an array — refusing to read an unreadable answer as "no previous run"')
  const found = artifacts
    .filter((a) => a?.name === ARTIFACT && a.expired !== true && a.workflow_run?.head_branch === 'main' && String(a.workflow_run?.id) !== String(runId))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
  return found ? Number(found.workflow_run.id) : null
}

/**
 * Read every shard's report and collect its survivors.
 * @param {{ readReport: (shard: number) => unknown, shards?: number, root?: string }} options
 */
export async function collectSurvivors({ readReport, shards = DEFAULT_SHARDS, root = repoRoot }) {
  const plan = await mutationShardPlan(shards, root)
  /** @type {Survivor[]} */
  const survivors = []
  /** @type {number[]} */
  const missingShards = []
  for (const shard of plan.shards) {
    let report
    try {
      report = readReport(shard.index)
    } catch {
      missingShards.push(shard.index)
      continue
    }
    survivors.push(...survivorsFromReport(report, root))
  }
  survivors.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)))
  return { survivors, missingShards }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2)
  /** @param {string} name */
  const arg = (name) => {
    const at = args.indexOf(name)
    return at === -1 ? undefined : args[at + 1]
  }
  /** @param {string} name */
  const all = (name) => args.flatMap((value, at) => (args[at - 1] === name ? [value] : []))
  const readJson = (/** @type {string} */ path) => JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'))
  const reportsDir = arg('--reports') ?? '.local/mutation/shards'
  const shards = Number(arg('--shards') ?? DEFAULT_SHARDS)
  const readReport = (/** @type {number} */ shard) => readJson(join(reportsDir, shardArtifact(shard), 'report.json'))

  if (command === 'group') {
    // Writes the Markdown, this run's own list when every shard reported, and two step outputs:
    // `new=<count>` and `complete=true|false`.
    const { survivors, missingShards } = await collectSurvivors({ readReport, shards })
    const baseline = parseSurvivorList(readJson(arg('--baseline') ?? BASELINE))
    const previousPath = arg('--previous')
    const previous = previousPath && existsSync(resolve(repoRoot, previousPath)) ? parseSurvivorList(readJson(previousPath)) : null
    const groups = groupSurvivors({ current: survivors, baseline, previous })
    const repoUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}` : undefined
    const markdown = renderSurvivorMarkdown(groups, { missingShards, repoUrl })
    process.stdout.write(`${markdown}\n`)
    const outMd = arg('--out-md')
    if (outMd) appendFileSync(resolve(repoRoot, outMd), `\n${markdown}`)
    const complete = missingShards.length === 0
    const outJson = arg('--out-json')
    if (outJson && complete) {
      const source = { run: process.env.GITHUB_RUN_ID ?? null, revision: process.env.GITHUB_SHA ?? null }
      writeFileSync(resolve(repoRoot, outJson), formatSurvivorList({ schema: 1, source, survivors: carryTags(survivors, baseline) }))
    }
    const outputs = arg('--outputs')
    if (outputs) appendFileSync(outputs, `new=${groups.new.length}\ncomplete=${complete}\n`)
  } else if (command === 'previous') {
    // Downloads the newest other main run's list into `--out`, or leaves it absent and says why.
    const runId = arg('--run-id') ?? process.env.GITHUB_RUN_ID ?? ''
    const repo = arg('--repo') ?? process.env.GITHUB_REPOSITORY
    const out = arg('--out') ?? '.local/mutation/previous'
    const gh = (/** @type {string[]} */ ghArgs) => execFileSync('gh', ghArgs, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    const previousRun = pickPreviousRun(JSON.parse(gh(['api', `repos/${repo}/actions/artifacts?name=${ARTIFACT}&per_page=100`])), runId)
    if (previousRun === null) {
      process.stdout.write('no previous main run uploaded a survivor list\n')
    } else {
      mkdirSync(resolve(repoRoot, out), { recursive: true })
      gh(['run', 'download', String(previousRun), '--repo', String(repo), '--name', ARTIFACT, '--dir', resolve(repoRoot, out)])
      process.stdout.write(`previous survivor list: run ${previousRun}\n`)
    }
  } else if (command === 'baseline') {
    // Refresh the starting list from a complete run's reports, keeping every tag it already had.
    // `--tag <issue>=<file>:<line>[:<mutator>]` adds one (file relative to the repository root).
    const { survivors, missingShards } = await collectSurvivors({ readReport, shards })
    if (missingShards.length) throw new Error(`shards ${missingShards.join(', ')} have no report — a starting list must come from a complete run`)
    const outPath = arg('--out') ?? BASELINE
    const old = existsSync(resolve(repoRoot, outPath)) ? parseSurvivorList(readJson(outPath)) : null
    const extra = all('--tag').map((spec) => {
      const match = /^(\d+)=([^:]+):(\d+)(?::(\w+))?$/.exec(spec)
      if (!match) throw new Error(`--tag ${spec}: expected <issue>=<file>:<line>[:<mutator>]`)
      return { issue: Number(match[1]), file: match[2], line: Number(match[3]), ...(match[4] ? { mutator: match[4] } : {}) }
    })
    const source = { run: arg('--run') ?? null, revision: arg('--revision') ?? null, date: arg('--date') ?? null }
    const tracked = { ...(old?.tracked ?? {}), ...Object.fromEntries(all('--issue').map((spec) => spec.split(/=(.*)/s).slice(0, 2))) }
    writeFileSync(resolve(repoRoot, outPath), formatSurvivorList({ schema: 1, source, tracked, survivors: carryTags(survivors, old, extra) }))
    process.stdout.write(`${survivors.length} survivors written to ${outPath}\n`)
  } else {
    process.stderr.write('usage: survivors.mjs group|previous|baseline [options] — see the header of this file\n')
    process.exit(2)
  }
}
