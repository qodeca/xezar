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
 * Nine shards. Six was the original estimate; eight is what #443's first fix moved to — measured
 * against real cost on the very next scheduled run, eight was still not enough on its own.
 *
 * WHAT CHANGED (2026-09-17, run 35175010173 on `fdd5b4e`). PRs #533/#539/#541/#542 added many
 * broad "fragile MCP–leader" tests that each exercise several MCP modules together (event
 * journal, leader delivery, the event controller, the bridge). Under `coverageAnalysis: 'perTest'`
 * a mutant's cost is the number of tests Stryker must rerun to check it — `coveredBy.length` in
 * its own JSON report — and those broad tests attached themselves to nearly every file in the
 * scope, not just the ones with new test files of their own: `event-controller.ts` went from a
 * measured 32 003 covering-test-mutant pairs the previous complete night to 178 734 (5.6×) with
 * not one line of `event-controller.ts` or its own test file touched. Byte size — what shards were
 * balanced on — never moved, so the balancer kept shipping the old, now-wrong split: shard 6 was
 * still running when the workflow's 300-minute ceiling cancelled it (07:36:06Z), and two more
 * shards passed 4 hours. See `docs/testing/coverage-gaps.md` § 10.8 for the full measurement.
 *
 * WHAT CHANGED AGAIN (2026-09-17, run 35199363744, the eight-shard proof itself). Two of the seven
 * `estimatedPaths` files (carried-over, never re-measured) turned out to still be badly
 * under-counted: the shard holding `bridge.ts` alongside ~128k of otherwise-ordinary weight ran
 * 4h54m, against ~1h49m–2h55m for every shard with no `estimatedPaths` file in it, and the shard
 * holding `tools/task-create.ts` was still running when the 300-minute ceiling cancelled it. Both
 * are now weighted high enough (see `docs/testing/mcp-mutation-shard-weights.json`'s
 * `estimatedPaths` note) that `planShards`'s own heaviest-first packing puts each alone in its own
 * shard — the same mechanism that already isolates `event-controller.ts` — rather than by any
 * shard-pinning logic added here.
 *
 * THE FIX HAS TWO PARTS AGAIN, because either alone measured short: nine shards instead of eight,
 * and corrected weights for the two worst-offending `estimatedPaths` files plus smaller corrections
 * for the other five, all still back-calculated from the eight-shard run's own wall-clock time
 * (§ 10.8) rather than a real `coveredBy` sum, because neither `bridge.ts`'s nor `task-create.ts`'s
 * shard produced a report to sum from. `loadWeights` below is unchanged: it packs by MEASURED
 * per-file cost when the snapshot has an entry for a file, falling back to byte size only for a
 * file the snapshot has never seen (a genuinely new module). The resulting nine-shard split's
 * heaviest shard is `tools/task-create.ts` alone, an estimated 300 000 weight units — comfortably
 * under the ~482 000 units this run's own timing implies as twice the fair share, and every other
 * shard sits at roughly 227 000–228 000, well inside it too. More shards would shorten each job and
 * add one `npm ci` apiece; fewer would eat the headroom this incident showed is required.
 */
export const DEFAULT_SHARDS = 9

/** The committed, periodically-refreshed measured-cost snapshot `loadWeights` reads. */
export const WEIGHTS_FILE = 'docs/testing/mcp-mutation-shard-weights.json'

/**
 * Real per-file cost from the most recent snapshot, or `null` if none exists or it does not parse
 * — never a thrown error, because a missing or stale snapshot must degrade to the byte-size
 * balance this file used before it existed, not fail the plan. A file the snapshot has no entry
 * for (new since the snapshot was taken) is simply absent from the returned map; `planShards`
 * falls back to that file's own byte size, one file at a time.
 * @param {string} [root]
 * @returns {Map<string, number> | null}
 */
export function loadWeights(root = repoRoot) {
  try {
    const raw = JSON.parse(readFileSync(join(root, WEIGHTS_FILE), 'utf8'))
    if (!raw || typeof raw !== 'object' || !raw.weights || typeof raw.weights !== 'object') return null
    const entries = Object.entries(raw.weights).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    return entries.length > 0 ? new Map(entries) : null
  } catch {
    return null
  }
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
 * and whose predecessor `Dirent.path` is deprecated — the repository's floor is Node 20.
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
 * The packing weight is `weights.get(file.path)` when the snapshot has an entry for that file,
 * byte size otherwise. Byte size alone used to be the whole story; it is still the only signal
 * available for a file the snapshot has never measured, and `bytes` below is always the real byte
 * total regardless of which weight balanced the split. It only has to be roughly right — the
 * aggregate is correct whatever the split, an unlucky split only costs wall clock.
 *
 * @param {{ path: string, size: number }[]} files
 * @param {number} count
 * @param {Map<string, number> | null} [weights] from `loadWeights` — `null` (or omitted) means
 *   "balance on byte size alone", the pre-#443 behaviour.
 * @returns {{ index: number, files: string[], bytes: number, weight: number }[]}
 */
export function planShards(files, count = DEFAULT_SHARDS, weights = null) {
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

  const weighted = files.map((file) => ({ ...file, weight: weights?.get(file.path) ?? file.size }))
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
 * The whole plan, ready for a GitHub Actions matrix. Reads `loadWeights(root)` itself so that the
 * `plan` job (building the matrix) and the `report` job (re-deriving the same plan to check
 * nothing is missing, in `aggregate.mjs`) always balance on the same committed snapshot — never
 * two different weight sources agreeing on shard COUNT but disagreeing on shard CONTENTS.
 * @param {number} [count]
 * @param {string} [root]
 */
export async function mutationShardPlan(count = DEFAULT_SHARDS, root = repoRoot) {
  const globs = await mutateGlobs(root)
  const files = scopeFiles(globs, root)
  return { globs, files, shards: planShards(files, count, loadWeights(root)) }
}

// CLI wiring. Everything it prints comes from the exported functions above, which is where the
// suite tests it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const countArg = args.indexOf('--shards')
  const count = countArg === -1 ? DEFAULT_SHARDS : Number(args[countArg + 1])
  const plan = await mutationShardPlan(count)

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
    process.stdout.write(`${plan.files.length} files, ${total} bytes, ${plan.shards.length} shards, balanced on ${weighted ? 'measured cost' : 'byte size'}\n`)
    for (const shard of plan.shards) {
      process.stdout.write(`  shard ${shard.index}: ${shard.files.length} files, ${shard.bytes} bytes, weight ${shard.weight}\n`)
      for (const file of shard.files) process.stdout.write(`    ${file}\n`)
    }
  }
}
