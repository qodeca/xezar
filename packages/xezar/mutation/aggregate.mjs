// @ts-check
/**
 * Sum the sharded MCP mutation reports into ONE whole-scope score and apply the gate's floor.
 *
 * `shards.mjs` (next to this file) splits the scope so the run fits a GitHub Actions job. That
 * split must not change what the gate decides, so nothing about the floor lives here:
 *
 *   - The four status counts are summed across shards and put through Stryker's own formula —
 *     `detected / valid`, where `detected = killed + timeout` and
 *     `valid = detected + survived + noCoverage`. Verified against `mutation-testing-metrics`
 *     (`calculateMetrics.js:120-139`) and against the recorded full run in
 *     docs/testing/coverage-gaps.md § 10.8, which this file's suite reproduces exactly.
 *   - `thresholds.break` is READ from `packages/xezar/stryker.config.mjs`. There is no second
 *     copy of the floor anywhere in the scheduled path, so it moves in one place or not at all.
 *
 * THREE WAYS A SHARDED GATE CAN PASS WHILE MEASURING NOTHING, all refused here:
 *   - a shard job that failed, timed out or uploaded nothing — a missing report is a FAILURE,
 *     never an absent contribution;
 *   - a shard that ran and mutated no file — Stryker's own score is `NaN` on zero valid mutants
 *     and `NaN < break` is false, so Stryker would not have broken either;
 *   - a file that fell out of the partition, or landed in two shards and was counted twice —
 *     every reported file must belong to the shard that reported it, and to only one shard.
 *
 * A SECOND SCOPE, ONE VERDICT. The read-only lock scope (`packages/xezar/stryker.lock.config.mjs`,
 * `core/read-only-lock.ts` and `core/qwen-tool-policy.ts`) runs nightly as one job of its own,
 * with its own floor read from its own config. `aggregateLock` holds it to the same refusals — a
 * missing report, a file of its scope unreported, nothing tested, a score under its floor — and
 * the CLI folds it into the night's single verdict, so a red lock scope is a red night and the
 * same tracking issue, never a job somebody has to remember to look at.
 *
 * Used by `.github/workflows/mutation.yml` (the `report` job) and by
 * `npm run test:mutation:mcp:report`. Its suite is `packages/xezar/src/mutation-aggregate.test.ts`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { STRYKER_CONFIG, mutationShardPlan, repoRoot, scopeFiles } from './shards.mjs'

/** The read-only lock scope's own config: its `mutate` and its floor live there and nowhere else. */
export const LOCK_CONFIG = 'packages/xezar/stryker.lock.config.mjs'
/** Where the `report` job puts the lock job's artifact (`mutation-lock-report`). */
export const LOCK_REPORT = '.local/mutation/lock-report/report.json'

/** Stryker's `MutantStatus` values that count as detected. */
export const DETECTED = ['Killed', 'Timeout']
/** …as undetected. Both halves are what `valid` is made of. */
export const UNDETECTED = ['Survived', 'NoCoverage']

/** @typedef {{ Killed: number, Timeout: number, Survived: number, NoCoverage: number, CompileError: number, RuntimeError: number, Ignored: number, Pending: number }} Counts */

/** @returns {Counts} */
export function emptyCounts() {
  return { Killed: 0, Timeout: 0, Survived: 0, NoCoverage: 0, CompileError: 0, RuntimeError: 0, Ignored: 0, Pending: 0 }
}

/**
 * @param {Counts} a
 * @param {Counts} b
 * @returns {Counts}
 */
export function addCounts(a, b) {
  const out = emptyCounts()
  for (const key of /** @type {(keyof Counts)[]} */ (Object.keys(out))) out[key] = a[key] + b[key]
  return out
}

/**
 * Stryker's arithmetic, not an approximation of it.
 * @param {Counts} counts
 * @returns {{ detected: number, undetected: number, valid: number, invalid: number, total: number, score: number | null }}
 */
export function metrics(counts) {
  const detected = counts.Killed + counts.Timeout
  const undetected = counts.Survived + counts.NoCoverage
  const valid = detected + undetected
  const invalid = counts.CompileError + counts.RuntimeError
  return {
    detected,
    undetected,
    valid,
    invalid,
    total: valid + invalid + counts.Ignored + counts.Pending,
    // `null`, never `NaN`. Stryker returns NaN here and `NaN < break` is false, so its own run
    // would pass on an empty scope; a caller that has to handle `null` cannot make that mistake.
    score: valid > 0 ? (detected / valid) * 100 : null,
  }
}

/**
 * Report file keys as repository-relative POSIX paths.
 * @param {string} key
 * @param {string} root
 */
export function normaliseFileKey(key, root = repoRoot) {
  let path = key.split('\\').join('/')
  const rootPrefix = root.split('\\').join('/').replace(/\/+$/, '')
  if (path.startsWith(`${rootPrefix}/`)) path = path.slice(rootPrefix.length + 1)
  return path.replace(/^\.\//, '')
}

/**
 * Per-file status counts from one Stryker JSON report.
 * @param {unknown} report
 * @param {string} [root]
 * @returns {Map<string, Counts>}
 */
export function countReport(report, root = repoRoot) {
  const files = /** @type {Record<string, { mutants?: { status?: string }[] }> | undefined} */ (
    /** @type {{ files?: unknown }} */ (report ?? {}).files
  )
  if (!files || typeof files !== 'object') {
    throw new Error('not a Stryker JSON report: no `files` object')
  }
  /** @type {Map<string, Counts>} */
  const out = new Map()
  for (const [key, value] of Object.entries(files)) {
    const counts = emptyCounts()
    for (const mutant of value?.mutants ?? []) {
      const status = mutant?.status
      if (status && status in counts) counts[/** @type {keyof Counts} */ (status)] += 1
      else throw new Error(`unknown mutant status "${String(status)}" in ${key}`)
    }
    out.set(normaliseFileKey(key, root), counts)
  }
  return out
}

/**
 * The floor a scope breaks below, read from its real config.
 * @param {string} [root]
 * @param {string} [config] the MCP gate's config unless told otherwise
 * @returns {Promise<number>}
 */
export async function breakThreshold(root = repoRoot, config = STRYKER_CONFIG) {
  const loaded = await import(pathToFileURL(join(root, config)).href)
  const value = loaded.default?.thresholds?.break
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    // A config with no floor is not a gate. Refusing here is what stops "the threshold was
    // quietly removed" from reading as "the scheduled run passed".
    throw new Error(`${config} declares no numeric \`thresholds.break\` — there is no floor to apply`)
  }
  return value
}

/**
 * @param {number} shard
 * @returns {string} the artifact directory this run expects for that shard.
 */
export const shardArtifact = (shard) => `mutation-report-${shard}`

/**
 * Combine every shard's report and decide the gate.
 *
 * @param {object} options
 * @param {(shard: number) => unknown} options.readReport reads one shard's parsed report, or
 *   throws when it is missing — the throw is the point, a shard with no report fails the gate.
 * @param {number} [options.shards]
 * @param {string} [options.root]
 * @returns {Promise<{ ok: boolean, problems: string[], threshold: number, counts: Counts, metrics: ReturnType<typeof metrics>, perFile: { path: string, counts: Counts, score: number | null }[], perShard: { shard: number, counts: Counts, metrics: ReturnType<typeof metrics> }[] }>}
 */
export async function aggregate({ readReport, shards = undefined, root = repoRoot }) {
  const plan = await mutationShardPlan(shards, root)
  const threshold = await breakThreshold(root)
  /** @type {string[]} */
  const problems = []
  /** @type {Map<string, Counts>} */
  const perFile = new Map()
  /** @type {Map<string, number>} */
  const reportedBy = new Map()
  const perShard = []
  let total = emptyCounts()

  for (const shard of plan.shards) {
    /** @type {Map<string, Counts>} */
    let counted
    try {
      counted = countReport(readReport(shard.index), root)
    } catch (error) {
      problems.push(`shard ${shard.index}: no usable report (${error instanceof Error ? error.message : String(error)})`)
      continue
    }

    const assigned = new Set(shard.files)
    let shardCounts = emptyCounts()
    for (const [path, counts] of counted) {
      if (!assigned.has(path)) problems.push(`shard ${shard.index} reported ${path}, which is not in its slice`)
      const previous = reportedBy.get(path)
      if (previous !== undefined) problems.push(`${path} was reported by shard ${previous} and shard ${shard.index}`)
      reportedBy.set(path, shard.index)
      perFile.set(path, counts)
      shardCounts = addCounts(shardCounts, counts)
    }

    const shardMetrics = metrics(shardCounts)
    if (shardMetrics.valid === 0) {
      problems.push(`shard ${shard.index} tested no mutants — it covered ${shard.files.length} files and measured none`)
    }
    perShard.push({ shard: shard.index, counts: shardCounts, metrics: shardMetrics })
    total = addCounts(total, shardCounts)
  }

  // A file the plan assigned but no report mentions is a hole in the gate, not an absence.
  // Stryker omits a file only when it yielded no mutant at all, which for this scope means the
  // file was not mutated — the same thing the partition exists to make impossible.
  const unreported = plan.shards.flatMap((shard) => shard.files.filter((path) => !reportedBy.has(path)))
  for (const path of unreported) problems.push(`${path} is in the mutation scope but no shard reported it`)
  if (unreported.length > 0 && unreported.length < plan.files.length && problems.every((p) => !p.includes('no usable report'))) {
    // Every shard reported, yet a file is missing: the likeliest cause is a file with no mutant in
    // it at all, which Stryker leaves out of its report. Say so, once.
    problems.push('a file Stryker yields no mutant for (type declarations only) is left out of its report — exclude such a file in stryker.config.mjs')
  }

  const overall = metrics(total)
  if (overall.score === null) problems.push('no mutants were tested across any shard')
  else if (overall.score < threshold) {
    problems.push(`mutation score ${overall.score.toFixed(2)} % is below the ${threshold} % floor`)
  }

  return {
    ok: problems.length === 0,
    problems,
    threshold,
    counts: total,
    metrics: overall,
    perFile: [...perFile.entries()]
      .map(([path, counts]) => ({ path, counts, score: metrics(counts).score }))
      .sort((a, b) => (a.score ?? -1) - (b.score ?? -1) || (a.path < b.path ? -1 : 1)),
    perShard,
  }
}

/**
 * Score the read-only lock scope against its own floor, with the same refusals as the shards.
 * @param {object} options
 * @param {() => unknown} options.readReport reads the lock job's parsed report, or throws when it
 *   is missing — a missing report fails the night.
 * @param {string} [options.root]
 * @returns {Promise<{ ok: boolean, problems: string[], threshold: number, counts: Counts, metrics: ReturnType<typeof metrics>, perFile: { path: string, counts: Counts, score: number | null }[] }>}
 */
export async function aggregateLock({ readReport, root = repoRoot }) {
  const loaded = await import(pathToFileURL(join(root, LOCK_CONFIG)).href)
  const scope = scopeFiles(loaded.default?.mutate ?? [], root).map((file) => file.path)
  const threshold = await breakThreshold(root, LOCK_CONFIG)
  /** @type {string[]} */
  const problems = []
  if (scope.length === 0) problems.push(`read-only lock: ${LOCK_CONFIG} mutates no file that exists`)
  /** @type {Map<string, Counts> | null} */
  let counted = null
  try {
    counted = countReport(readReport(), root)
  } catch (error) {
    problems.push(`read-only lock: no usable report (${error instanceof Error ? error.message : String(error)})`)
  }
  let total = emptyCounts()
  for (const [path, counts] of counted ?? []) {
    if (!scope.includes(path)) problems.push(`read-only lock: the report names ${path}, which is not in ${LOCK_CONFIG}`)
    total = addCounts(total, counts)
  }
  // Only once a report was read: a missing one is already the problem, and an EMPTY one must not
  // pass as "nothing wrong" — every file of the scope it leaves out is named here.
  if (counted) {
    for (const path of scope) if (!counted.has(path)) problems.push(`read-only lock: ${path} is in its scope but the report does not name it`)
  }
  const overall = metrics(total)
  if (counted && overall.score === null) problems.push('read-only lock: no mutants were tested')
  else if (overall.score !== null && overall.score < threshold) {
    problems.push(`read-only lock: mutation score ${overall.score.toFixed(2)} % is below its ${threshold} % floor`)
  }
  return {
    ok: problems.length === 0,
    problems,
    threshold,
    counts: total,
    metrics: overall,
    perFile: [...(counted ?? new Map()).entries()]
      .map(([path, counts]) => ({ path, counts, score: metrics(counts).score }))
      .sort((a, b) => (a.score ?? -1) - (b.score ?? -1) || (a.path < b.path ? -1 : 1)),
  }
}

/**
 * A Markdown report for `$GITHUB_STEP_SUMMARY` and for the tracking issue. With `lock`, the night's
 * verdict is both scopes': the title says PASSED only when each cleared its own floor.
 * @param {Awaited<ReturnType<typeof aggregate>>} result
 * @param {{ runUrl?: string, ref?: string, sha?: string }} [context]
 * @param {Awaited<ReturnType<typeof aggregateLock>>} [lock]
 */
export function renderMarkdown(result, context = {}, lock = undefined) {
  const m = result.metrics
  const ok = result.ok && (lock?.ok ?? true)
  const lines = [
    `## MCP mutation gate — ${ok ? 'PASSED' : 'FAILED'}`,
    '',
    `**Score ${m.score === null ? 'n/a' : `${m.score.toFixed(2)} %`}** against a floor of ${result.threshold} %`,
    '',
    '| | |',
    '|---|---|',
    `| Killed / timed out | ${result.counts.Killed} / ${result.counts.Timeout} |`,
    `| Survived / no coverage | ${result.counts.Survived} / ${result.counts.NoCoverage} |`,
    `| Ignored (static) | ${result.counts.Ignored} |`,
    `| Compile / runtime errors | ${result.counts.CompileError} / ${result.counts.RuntimeError} |`,
    `| Tested (valid) | ${m.valid} |`,
    `| Generated | ${m.total} |`,
    '',
  ]
  if (context.sha) lines.push(`Revision \`${context.sha}\`${context.ref ? ` on \`${context.ref}\`` : ''}.`, '')
  if (context.runUrl) lines.push(`[The run, with the per-mutant HTML report as an artifact](${context.runUrl})`, '')
  if (!ok) {
    lines.push('### What went wrong', '')
    for (const problem of [...result.problems, ...(lock?.problems ?? [])]) lines.push(`- ${problem}`)
    lines.push(
      '',
      'Known survivors are tracked in #338, and the gate itself in #443 — compare the per-file table below with those before filing a new one.',
      '',
    )
  }
  lines.push(...fileTable('### Per file, weakest first', result.perFile, 'packages/xezar/src/mcp/'))
  if (lock) {
    const lm = lock.metrics
    lines.push(
      '### Read-only lock scope',
      '',
      `**Score ${lm.score === null ? 'n/a' : `${lm.score.toFixed(2)} %`}** against its own floor of ${lock.threshold} % (\`${LOCK_CONFIG}\`), over ${lm.valid} tested mutants.`,
      '',
      ...fileTable('', lock.perFile, 'packages/xezar/src/'),
    )
  }
  return lines.join('\n')
}

/**
 * @param {string} heading
 * @param {{ path: string, counts: Counts, score: number | null }[]} files
 * @param {string} prefix dropped from each path
 */
function fileTable(heading, files, prefix) {
  const lines = heading ? [heading, ''] : []
  lines.push('| File | Score | Killed | Timeout | Survived | No coverage |', '|---|---:|---:|---:|---:|---:|')
  for (const file of files) {
    lines.push(
      `| \`${file.path.replace(prefix, '')}\` | ${file.score === null ? 'n/a' : `${file.score.toFixed(1)} %`} | ${file.counts.Killed} | ${file.counts.Timeout} | ${file.counts.Survived} | ${file.counts.NoCoverage} |`,
    )
  }
  lines.push('')
  return lines
}

/**
 * The CLI: both scopes, one summary, one exit status. Paths resolve from the repository root.
 * @param {string[]} args
 * @param {{ GITHUB_SERVER_URL?: string, GITHUB_REPOSITORY?: string, GITHUB_RUN_ID?: string, GITHUB_REF_NAME?: string, GITHUB_SHA?: string }} [env]
 * @returns {Promise<{ exitCode: number, markdown: string }>}
 */
export async function main(args, env = process.env) {
  /** @param {string} name @param {string} fallback */
  const arg = (name, fallback) => {
    const at = args.indexOf(name)
    return at === -1 ? fallback : args[at + 1] ?? fallback
  }
  const reportsDir = resolve(repoRoot, arg('--reports', '.local/mutation/shards'))
  const shardsArg = arg('--shards', '')
  const lockReport = resolve(repoRoot, arg('--lock-report', LOCK_REPORT))
  const readJson = (/** @type {string} */ path) => JSON.parse(readFileSync(path, 'utf8'))
  const result = await aggregate({
    shards: shardsArg === '' ? undefined : Number(shardsArg),
    readReport: (shard) => readJson(join(reportsDir, shardArtifact(shard), 'report.json')),
  })
  const lock = await aggregateLock({ readReport: () => readJson(lockReport) })
  const markdown = renderMarkdown(
    result,
    {
      runUrl: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : undefined,
      ref: env.GITHUB_REF_NAME,
      sha: env.GITHUB_SHA,
    },
    lock,
  )
  const out = arg('--out', '')
  if (out) writeFileSync(resolve(repoRoot, out), markdown)
  return { exitCode: result.ok && lock.ok ? 0 : 1, markdown }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode, markdown } = await main(process.argv.slice(2))
  process.stdout.write(`${markdown}\n`)
  process.exitCode = exitCode
}
