// @ts-check
/**
 * Split the MCP mutation scope into N disjoint shards, so the gate fits a GitHub Actions job.
 *
 * WHY THIS EXISTS. `npm run test:mutation:mcp` is one Stryker run over
 * `packages/xezar/src/mcp/**`. Measured on an 18-core macOS laptop at concurrency 4 it takes
 * 3 h 40 min (docs/testing/coverage-gaps.md § 10.8). A GitHub-hosted `ubuntu-latest` runner has
 * 4 cores, so `stryker.config.mjs`'s `min(4, availableParallelism() - 1)` resolves to 3 there,
 * and the cores are slower — the same run does not fit GitHub's hard 6-hour per-job limit. One
 * scheduled job would be killed mid-run for ever. Several jobs, each mutating a slice, do fit,
 * and they cost nothing extra: this repository is public, so standard runners are free.
 *
 * WHAT MAKES A SLICE SAFE. Two properties, and both are tested
 * (`packages/xezar/src/mutation-shards.test.ts`):
 *   - COMPLETE — every file the real `mutate` globs select lands in exactly one shard. A file
 *     that falls out of the partition is a file the gate silently stops measuring.
 *   - DERIVED, not copied — the globs are read from `packages/xezar/stryker.config.mjs` at run
 *     time. There is no second list of what the gate covers, so widening the scope there
 *     widens the shards with no edit here.
 *
 * The shard runs themselves never apply the floor: a slice's score is not the gate's score
 * (§ 10.8 point 1 — the spread per file is wide, `adapters/` is at 64 % today). They report, and
 * `aggregate.mjs` next to this file sums the status counts across every shard and applies
 * `thresholds.break` to the whole-scope number, which is the same arithmetic Stryker does.
 *
 * WHERE THIS LIVES. `packages/xezar/mutation/`, which is outside the package's `files` allowlist,
 * so none of it reaches the npm tarball (`src/release/publishing-surface.test.ts` pins that).
 * Not `packages/xezar/scripts/`, which IS shipped, and not the root `scripts/`, which is kept for
 * tools that span workspaces.
 *
 * Used by `.github/workflows/mutation.yml` (the `plan` job builds the matrix, the `report` job
 * re-derives the same plan to check nothing is missing) and by `npm run test:mutation:mcp:plan`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Repository root — this file lives in `<root>/packages/xezar/mutation/`. */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** The one Stryker config the gate runs; the shard plan reads its `mutate` and nothing else. */
export const STRYKER_CONFIG = 'packages/xezar/stryker.config.mjs'

/**
 * How many minutes of mutation testing one shard may be planned to hold. The weights below are
 * measured CI minutes, so this is a wall-clock budget, and it is deliberately well under the
 * mutants job's 300-minute ceiling in `.github/workflows/mutation.yml`
 * (`src/mutation-shards.test.ts` pins the ratio): the same file measured up to half as slow again
 * on another night's runner (`docs/testing/coverage-gaps.md` § 10.8, third incident), the
 * snapshot is refreshed by hand and goes stale as tests grow, and each job also spends about six
 * minutes on `npm ci`, instrumenting and the dry run.
 */
export const SHARD_BUDGET_MINUTES = 120

/**
 * The most shards the planner will ask for. A public repository's standard runners are free, but
 * every shard is one more concurrent job and one more `npm ci`; reaching this cap is a reason to
 * make the slowest tests cheaper, not to add jobs.
 */
export const MAX_SHARDS = 24

/**
 * The shard count when there is no snapshot to plan in minutes: a byte-size plan cannot be held to
 * a minute budget, so it falls back to the count the last measured plan needed.
 */
export const FALLBACK_SHARDS = 18

/** The committed, periodically-refreshed measured-cost snapshot `loadWeights` reads. */
export const WEIGHTS_FILE = 'docs/testing/mcp-mutation-shard-weights.json'

/**
 * Measured per-file cost, in CI minutes, from the committed snapshot, or `null` if none exists or
 * it does not parse — never a thrown error, because a missing or stale snapshot must degrade to the
 * byte-size balance this file used before it existed, not fail the plan. A file the snapshot has no
 * entry for (new since the snapshot was taken) is simply absent from the returned map;
 * `planShards` gives it an estimate in the same unit (`fallbackWeights`).
 * @param {string} [root]
 * @returns {Map<string, number> | null}
 */
export function loadWeights(root = repoRoot) {
  try {
    const raw = JSON.parse(readFileSync(join(root, WEIGHTS_FILE), 'utf8'))
    if (!raw || typeof raw !== 'object' || !raw.weights || typeof raw.weights !== 'object') return null
    const entries = Object.entries(raw.weights).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    return entries.length > 0 ? new Map(entries) : null
  } catch {
    return null
  }
}

/**
 * Every scope file's packing weight, in ONE unit. A file the snapshot measured keeps its minutes; a
 * file it never saw gets its byte size times the scope's own minutes-per-byte, taken over the files
 * the snapshot did measure. Mixing raw bytes into a minute snapshot — what the planner did until
 * #443's third incident — weighed a new 20 kB file like twenty thousand minutes or, the other way
 * round, a minute snapshot like nothing at all; the scaled estimate is crude, but it is crude in
 * the right unit. With no usable snapshot every file weighs its byte size, the pre-#443 balance.
 * @param {{ path: string, size: number }[]} files
 * @param {Map<string, number> | null} weights
 * @returns {Map<string, number>}
 */
export function fallbackWeights(files, weights) {
  const measured = weights ? files.filter((file) => weights.has(file.path)) : []
  const measuredBytes = measured.reduce((sum, file) => sum + file.size, 0)
  const measuredWeight = measured.reduce((sum, file) => sum + /** @type {number} */ (weights?.get(file.path)), 0)
  const perByte = measuredBytes > 0 && measuredWeight > 0 ? measuredWeight / measuredBytes : null
  return new Map(
    files.map((file) => {
      const known = weights?.get(file.path)
      if (known !== undefined) return [file.path, known]
      return [file.path, perByte === null ? file.size : file.size * perByte]
    }),
  )
}

/**
 * Translate one glob into an anchored regular expression over POSIX-separated relative paths.
 * `**\/` crosses directories, `*` does not, everything else is a literal.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          source += '(?:[^/]+/)*'
          i += 2
        } else {
          source += '.*'
          i += 1
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(/** @type {string} */ (char))) {
      source += `\\${char}`
    } else {
      source += char
    }
  }
  return new RegExp(`^${source}$`)
}

/**
 * The `mutate` entry of the real Stryker config, verbatim.
 * @param {string} [root]
 * @returns {Promise<string[]>}
 */
export async function mutateGlobs(root = repoRoot) {
  const loaded = await import(pathToFileURL(join(root, STRYKER_CONFIG)).href)
  const globs = loaded.default?.mutate
  if (!Array.isArray(globs) || globs.length === 0) {
    throw new Error(`${STRYKER_CONFIG} declares no \`mutate\` globs — the shard plan has nothing to split`)
  }
  return globs.map(String)
}

/**
 * Longest literal directory prefix of a glob, so the walk starts inside the scope instead of at
 * the repository root.
 * @param {string} glob
 * @returns {string}
 */
function literalPrefix(glob) {
  const star = glob.search(/[*?]/)
  const head = star === -1 ? glob : glob.slice(0, star)
  const cut = head.lastIndexOf('/')
  return cut === -1 ? '' : head.slice(0, cut)
}

/**
 * Every regular file below `dir`, as absolute paths. A plain recursion rather than
 * `readdirSync(…, { recursive: true })`, whose `Dirent.parentPath` only exists from Node 20.12
 * and whose predecessor `Dirent.path` is deprecated — kept as a plain recursion; the repository's
 * floor is now Node 22.
 * @param {string} dir
 * @returns {string[]}
 */
function walkFiles(dir) {
  /** @type {string[]} */
  const out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(absolute))
    else if (entry.isFile()) out.push(absolute)
  }
  return out
}

/**
 * Every repository-relative file the config's `mutate` selects, sorted, with its byte size.
 * Negated globs (`!…`) subtract, exactly as Stryker reads them.
 * @param {string[]} globs
 * @param {string} [root]
 * @returns {{ path: string, size: number }[]}
 */
export function scopeFiles(globs, root = repoRoot) {
  const positive = globs.filter((g) => !g.startsWith('!'))
  const negative = globs.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1)))
  /** @type {Map<string, number>} */
  const found = new Map()

  for (const glob of positive) {
    const matcher = globToRegExp(glob)
    // A glob whose literal prefix does not exist contributes nothing. That is not silently
    // fine: an empty result makes `planShards` throw rather than plan an empty gate.
    for (const absolute of walkFiles(join(root, literalPrefix(glob)))) {
      const relative = absolute.slice(root.length).split('\\').join('/').replace(/^\/+/, '')
      if (!matcher.test(relative)) continue
      if (negative.some((re) => re.test(relative))) continue
      found.set(relative, statSync(absolute).size)
    }
  }

  return [...found.entries()]
    .map(([path, size]) => ({ path, size }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * Assign every scope file to one of `count` shards, heaviest weight first into the lightest shard
 * so far. Deterministic: same input, same plan, on any machine.
 *
 * The packing weight is `fallbackWeights`' — measured minutes, or a same-unit estimate for a file
 * the snapshot has never measured — and `bytes` below is always the real byte total regardless of
 * which weight balanced the split. It only has to be roughly right: the aggregate is correct
 * whatever the split, and an unlucky split only costs wall clock.
 *
 * @param {{ path: string, size: number }[]} files
 * @param {number} count
 * @param {Map<string, number> | null} [weights] from `loadWeights` — `null` (or omitted) means
 *   "balance on byte size alone", the pre-#443 behaviour.
 * @returns {{ index: number, files: string[], bytes: number, weight: number }[]}
 */
export function planShards(files, count, weights = null) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`shard count must be a positive integer, got ${count}`)
  }
  if (files.length === 0) {
    throw new Error('the mutation scope resolved to zero files — refusing to plan an empty gate')
  }
  if (files.length < count) {
    throw new Error(`cannot split ${files.length} files into ${count} shards without leaving one empty`)
  }
  // Stryker's `--mutate` is a COMMA-separated list, so a comma in a path would silently split one
  // file into two globs that match nothing — a hole in the gate with no error anywhere.
  const unusable = files.filter((file) => file.path.includes(','))
  if (unusable.length > 0) {
    throw new Error(`a mutated path may not contain a comma (\`--mutate\` splits on it): ${unusable.map((f) => f.path).join(' ')}`)
  }

  const weightOf = fallbackWeights(files, weights)
  const weighted = files.map((file) => ({ ...file, weight: /** @type {number} */ (weightOf.get(file.path)) }))
  const shards = Array.from({ length: count }, (_, i) => ({ index: i + 1, files: /** @type {string[]} */ ([]), bytes: 0, weight: 0 }))
  const heaviestFirst = [...weighted].sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : 1))
  for (const file of heaviestFirst) {
    let lightest = shards[0]
    for (const shard of shards) if (shard.weight < lightest.weight) lightest = shard
    lightest.files.push(file.path)
    lightest.bytes += file.size
    lightest.weight += file.weight
  }
  for (const shard of shards) shard.files.sort()
  return shards
}

/**
 * Whether a plan keeps every shard inside `budget` minutes. A shard holding ONE file is exempt: a
 * file cannot be split across jobs without losing the mutants that straddle the cut (Stryker keeps
 * a mutant only when a `--mutate` range contains it whole), so the slowest file is the floor no
 * shard count can go below — `src/mutation-shards.test.ts` holds that file to the job ceiling.
 * @param {{ files: string[], weight: number }[]} shards
 * @param {number} [budget]
 */
export function withinBudget(shards, budget = SHARD_BUDGET_MINUTES) {
  return shards.every((shard) => shard.files.length === 1 || shard.weight <= budget)
}

/**
 * The fewest shards that keep every multi-file shard inside `SHARD_BUDGET_MINUTES`, never more than
 * `MAX_SHARDS` or the number of files. Derived, not configured: the scope and the measured minutes
 * decide it, so a refreshed snapshot or a new file moves the count with no edit anywhere — a fixed
 * count is what let 9 shards carry about 35 runner-hours (#443, third incident). With no snapshot
 * there are no minutes to budget, and the count is `FALLBACK_SHARDS`.
 * @param {{ path: string, size: number }[]} files
 * @param {Map<string, number> | null} weights
 * @returns {number}
 */
export function shardCount(files, weights) {
  if (files.length === 0) return 1
  const ceiling = Math.min(MAX_SHARDS, files.length)
  if (!weights) return Math.min(FALLBACK_SHARDS, ceiling)
  const total = [...fallbackWeights(files, weights).values()].reduce((sum, weight) => sum + weight, 0)
  for (let count = Math.max(1, Math.ceil(total / SHARD_BUDGET_MINUTES)); count < ceiling; count += 1) {
    if (withinBudget(planShards(files, count, weights))) return count
  }
  return ceiling
}

/**
 * The whole plan, ready for a GitHub Actions matrix. Reads `loadWeights(root)` itself so that the
 * `plan` job (building the matrix) and the `report` job (re-deriving the same plan to check
 * nothing is missing, in `aggregate.mjs`) always balance on the same committed snapshot and
 * derive the same count — never two different weight sources agreeing on shard COUNT but
 * disagreeing on shard CONTENTS.
 * @param {number} [count] omitted: `shardCount`'s answer. Given: that many shards, for a hand run.
 * @param {string} [root]
 */
export async function mutationShardPlan(count = undefined, root = repoRoot) {
  const globs = await mutateGlobs(root)
  const files = scopeFiles(globs, root)
  const weights = loadWeights(root)
  return { globs, files, shards: planShards(files, count ?? shardCount(files, weights), weights) }
}

// CLI wiring. Everything it prints comes from the exported functions above, which is where the
// suite tests it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const countArg = args.indexOf('--shards')
  const plan = await mutationShardPlan(countArg === -1 ? undefined : Number(args[countArg + 1]))

  if (args.includes('--matrix')) {
    // `include:` entries for the matrix. `mutate` is what `--mutate` receives verbatim.
    process.stdout.write(
      `${JSON.stringify({ include: plan.shards.map((s) => ({ shard: s.index, mutate: s.files.join(',') })) })}\n`,
    )
  } else if (args.includes('--count')) {
    process.stdout.write(`${plan.shards.length}\n`)
  } else {
    const total = plan.files.reduce((sum, f) => sum + f.size, 0)
    const weighted = loadWeights() !== null
    const unit = weighted ? 'min' : 'bytes'
    process.stdout.write(
      `${plan.files.length} files, ${total} bytes, ${plan.shards.length} shards, balanced on ${weighted ? `measured CI minutes (budget ${SHARD_BUDGET_MINUTES} min a shard)` : 'byte size'}\n`,
    )
    for (const shard of plan.shards) {
      process.stdout.write(`  shard ${shard.index}: ${shard.files.length} files, ${shard.bytes} bytes, ${Math.round(shard.weight)} ${unit}\n`)
      for (const file of shard.files) process.stdout.write(`    ${file}\n`)
    }
  }
}
