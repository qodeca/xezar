// @ts-check
/**
 * Refresh the shard planner's measured-minutes snapshot from one nightly run's `timing.json` files
 * (#443) — `npm run test:mutation:mcp:weights`.
 *
 *   gh run download <run-id> --repo qodeca/xezar --pattern 'mutation-report-*' --dir .local/mutation/shards
 *   npm run --silent test:mutation:mcp:weights -- --reports .local/mutation/shards \
 *     --run <run-id> --revision <sha> --date <yyyy-mm-dd>
 *
 * Every shard uploads its `timing.json` (`timing-reporter.mjs`), a shard killed at the job ceiling
 * included, so one night is enough to re-measure every file it reached. A file a shard finished
 * gets its measured minutes; a file a killed shard was part-way through gets its minutes so far
 * scaled by how many of its mutants were left, and is listed under `estimatedPaths`; a file no
 * shard reached keeps the snapshot's previous value, also listed. Files no longer in the mutation
 * scope are dropped. Commit the result in its own pull request, so the diff shows what moved.
 *
 * Its suite is `src/mutation-timing.test.ts`.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { WEIGHTS_FILE, mutateGlobs, repoRoot, scopeFiles } from './shards.mjs'
import { TIMING_FILE } from './timing-reporter.mjs'

/**
 * @typedef {{ planned: number, tested: number, seconds: number }} FileTiming
 * @typedef {{ files?: Record<string, FileTiming> }} Timing
 * @typedef {{ minutes: number, partial: boolean }} Measured
 */

/**
 * Minutes per file across a run's timing files. A file with nothing to test measures zero; a file
 * with mutants left untested is scaled up to all of them and marked partial; a file no result
 * reached is absent.
 * @param {Timing[]} timings
 * @returns {Map<string, Measured>}
 */
export function measuredMinutes(timings) {
  /** @type {Map<string, Measured>} */
  const out = new Map()
  for (const timing of timings) {
    for (const [path, t] of Object.entries(timing.files ?? {})) {
      if (t.planned === 0) out.set(path, { minutes: 0, partial: false })
      else if (t.tested > 0) out.set(path, { minutes: (t.seconds / 60) * (t.planned / t.tested), partial: t.tested < t.planned })
    }
  }
  return out
}

/**
 * The next snapshot: measured where this run measured, the previous value otherwise, only for
 * files still in scope.
 * @param {{ weights?: Record<string, number> }} previous
 * @param {Map<string, Measured>} measured
 * @param {string[]} scope repository-relative paths the gate mutates today
 * @param {{ run: string, revision: string, date: string }} source
 */
export function nextSnapshot(previous, measured, scope, source) {
  /** @type {Record<string, number>} */
  const weights = {}
  /** @type {string[]} */
  const estimated = []
  for (const path of [...scope].sort()) {
    const fresh = measured.get(path)
    if (fresh) {
      weights[path] = Math.round(fresh.minutes * 10) / 10
      if (fresh.partial) estimated.push(path)
    } else if (typeof previous.weights?.[path] === 'number') {
      weights[path] = previous.weights[path]
      estimated.push(path)
    } else {
      // Neither measured nor known: leave it out, and the planner gives it a same-unit estimate.
      estimated.push(path)
    }
  }
  return {
    schema: 2,
    unit: 'minutes',
    source: {
      note: 'Measured CI minutes per file of the nightly MCP mutation gate, from each shard\'s timing.json (packages/xezar/mutation/timing-reporter.mjs): the wall time of the mutation phase on a GitHub-hosted runner at the concurrency it ran, split by file. packages/xezar/mutation/shards.mjs packs shards on these numbers and holds every multi-file shard to its minute budget. See docs/testing/coverage-gaps.md § 10.8.',
      measuredRun: Number(source.run),
      measuredDate: source.date,
      measuredRevision: source.revision,
      refresh: 'npm run --silent test:mutation:mcp:weights -- --reports <dir> --run <id> --revision <sha> --date <yyyy-mm-dd>, after downloading every mutation-report-* artifact of one nightly run (see packages/xezar/mutation/weights.mjs).',
    },
    estimatedPaths: {
      note: 'Not measured in full by the run above: a file a killed shard was part-way through (scaled up to all its mutants), or a file no shard reached (the previous snapshot\'s value, or none). Refresh these first.',
      paths: estimated,
    },
    weights,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  /** @param {string} name */
  const arg = (name) => {
    const at = args.indexOf(name)
    const value = at === -1 ? undefined : args[at + 1]
    if (!value) throw new Error(`missing ${name} <value>`)
    return value
  }
  const reports = join(repoRoot, arg('--reports'))
  const timings = readdirSync(reports)
    .filter((name) => name.startsWith('mutation-report-'))
    .map((name) => join(reports, name, TIMING_FILE))
    .filter((path) => existsSync(path))
    .map((path) => /** @type {Timing} */ (JSON.parse(readFileSync(path, 'utf8'))))
  if (timings.length === 0) throw new Error(`no ${TIMING_FILE} under ${reports}/mutation-report-* — nothing to refresh from`)
  const previous = JSON.parse(readFileSync(join(repoRoot, WEIGHTS_FILE), 'utf8'))
  const scope = scopeFiles(await mutateGlobs()).map((file) => file.path)
  const snapshot = nextSnapshot(previous, measuredMinutes(timings), scope, {
    run: arg('--run'),
    revision: arg('--revision'),
    date: arg('--date'),
  })
  writeFileSync(join(repoRoot, WEIGHTS_FILE), `${JSON.stringify(snapshot, null, 2)}\n`)
  process.stdout.write(
    `${WEIGHTS_FILE}: ${Object.keys(snapshot.weights).length} files from ${timings.length} timing files, ${snapshot.estimatedPaths.paths.length} not measured in full\n`,
  )
}
