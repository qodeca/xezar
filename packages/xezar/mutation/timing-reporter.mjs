// @ts-check
/**
 * A Stryker reporter that records how long each mutated file took to test, and writes it next to
 * the run's JSON report as `timing.json` (#443).
 *
 * WHY IT EXISTS. `shards.mjs` packs the nightly gate's files into jobs by measured minutes
 * (`docs/testing/mcp-mutation-shard-weights.json`). Stryker's own report says nothing about time,
 * and the proxy the snapshot used before — how many tests each mutant reruns — stopped predicting
 * it: a file whose tests start servers and Git repositories costs many times what its test count
 * says. Worse, the only shards that never produced a report were the slow ones, so the files that
 * most needed re-measuring were exactly the ones nobody could measure, and the snapshot stayed
 * stale for a month while two to four shards a night hit the job ceiling.
 *
 * WHAT IT RECORDS. Mutants reach `onMutantTested` roughly in plan order, one file after another,
 * so the wall time between two results is charged to the file of the second. Summed, that is the
 * job's mutation wall time split by file at the concurrency the job really ran — the unit the
 * planner's budget is in. Results Stryker decides without a test run (no coverage, ignored as
 * static) cost nothing and are not charged. `planned` is how many of a file's mutants go to the
 * test runner, so a partial count extrapolates.
 *
 * WHY IT FLUSHES. A shard that reaches the job ceiling is killed, and Stryker writes no report for
 * it; the upload step still runs (`if: always()`). Writing the file once a minute means even a
 * killed shard leaves its timing behind — the measurement a stale snapshot needs most.
 *
 * It never changes a verdict: it reads results, writes one file, and a write that fails is logged
 * once, never thrown into Stryker's run.
 *
 * It declares its plugin as a plain object rather than through `@stryker-mutator/api`, which is a
 * dependency of Stryker's, not of this package. Loaded by `stryker.config.mjs`; its suite is
 * `src/mutation-timing.test.ts`. `weights.mjs` turns a run's timing files into a new snapshot.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'

export const TIMING_FILE = 'timing.json'
export const REPORTER_NAME = 'xezar-timing'
export const FLUSH_EVERY_MS = 60_000

/** Statuses Stryker reports without running a test: no runner time to charge. */
const DECIDED_WITHOUT_A_RUN = new Set(['NoCoverage', 'Ignored', 'Pending'])

/**
 * @typedef {{ planned: number, tested: number, seconds: number }} FileTiming
 * @typedef {{ now?: () => number, write?: (path: string, text: string) => void, cwd?: string, warn?: (message: string) => void }} TimingIo
 */

export class TimingReporter {
  static inject = /** @type {const} */ (['options'])

  /**
   * @param {{ jsonReporter?: { fileName?: string }, concurrency?: number }} options Stryker's options.
   * @param {TimingIo} [io] seams for the suite; Stryker passes none.
   */
  constructor(options, io = {}) {
    this.out = join(dirname(options.jsonReporter?.fileName ?? 'reports/mutation/mutation.json'), TIMING_FILE)
    this.concurrency = options.concurrency ?? null
    this.now = io.now ?? Date.now
    this.write = io.write ?? ((path, text) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    })
    this.cwd = io.cwd ?? process.cwd()
    this.warn = io.warn ?? ((message) => console.warn(message))
    /** @type {Map<string, FileTiming>} */
    this.files = new Map()
    /** @type {number | null} */
    this.started = null
    /** @type {number | null} */
    this.last = null
    this.flushedAt = 0
    this.warned = false
  }

  /** @param {{ mutantPlans: readonly { plan: string, mutant: { fileName: string }, runOptions?: { testFilter?: readonly string[] } }[] }} event */
  onMutationTestingPlanReady({ mutantPlans }) {
    for (const plan of mutantPlans) {
      const entry = this.entry(plan.mutant.fileName)
      const filter = plan.runOptions?.testFilter
      if (plan.plan === 'Run' && (filter === undefined || filter.length > 0)) entry.planned += 1
    }
    this.started = this.last = this.now()
    this.flush(false)
  }

  /** @param {{ fileName: string, status: string }} result */
  onMutantTested(result) {
    if (this.last === null || DECIDED_WITHOUT_A_RUN.has(result.status)) return
    const now = this.now()
    const entry = this.entry(result.fileName)
    entry.tested += 1
    entry.seconds += (now - this.last) / 1000
    this.last = now
    if (now - this.flushedAt >= FLUSH_EVERY_MS) this.flush(false)
  }

  onMutationTestReportReady() {
    this.flush(true)
  }

  /** @param {string} fileName */
  entry(fileName) {
    const key = (isAbsolute(fileName) ? relative(this.cwd, fileName) : fileName).split('\\').join('/').replace(/^\.\//, '')
    let entry = this.files.get(key)
    if (!entry) {
      entry = { planned: 0, tested: 0, seconds: 0 }
      this.files.set(key, entry)
    }
    return entry
  }

  /** @param {boolean} complete */
  flush(complete) {
    const now = this.now()
    this.flushedAt = now
    const files = Object.fromEntries(
      [...this.files.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, t]) => [path, { planned: t.planned, tested: t.tested, seconds: Math.round(t.seconds * 10) / 10 }]),
    )
    const body = {
      schema: 1,
      complete,
      concurrency: this.concurrency,
      wallSeconds: this.started === null ? 0 : Math.round((now - this.started) / 100) / 10,
      files,
    }
    try {
      this.write(this.out, `${JSON.stringify(body, null, 2)}\n`)
    } catch (error) {
      if (!this.warned) this.warn(`${REPORTER_NAME}: could not write ${this.out}: ${error instanceof Error ? error.message : String(error)}`)
      this.warned = true
    }
  }
}

export const strykerPlugins = [{ kind: 'Reporter', name: REPORTER_NAME, injectableClass: TimingReporter }]
