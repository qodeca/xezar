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
 * The shard runs themselves never apply the 80 % floor: a slice's score is not the gate's score
 * (§ 10.8 point 1 — the spread per file is wide, `adapters/` is at 64 % today). They report, and
 * `scripts/mutation-aggregate.mjs` sums the four status counts across every shard and applies
 * `thresholds.break` to the whole-scope number, which is the same arithmetic Stryker does.
 *
 * Used by `.github/workflows/mutation.yml` (the `plan` job builds the matrix, the `report` job
 * re-derives the same plan to check nothing is missing) and by `npm run test:mutation:mcp:plan`.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Repository root — this file lives in `<root>/scripts/`. */
export const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** The one Stryker config the gate runs; the shard plan reads its `mutate` and nothing else. */
export const STRYKER_CONFIG = 'packages/xezar/stryker.config.mjs'

/**
 * Six shards. Sized from the measurement above rather than picked: the whole run is roughly
 * 220 min × 4 concurrent ≈ 880 mutant-minutes on Apple silicon, so at concurrency 3 and a
 * generous 2× per-core slowdown a sixth of it is ≈ 100 min of wall clock — comfortably inside
 * the job's 300-minute ceiling, with room for the estimate to be wrong by a factor of two.
 * More shards would shorten each job and add one `npm ci` apiece; fewer would eat the headroom.
 */
export const DEFAULT_SHARDS = 6

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
 * Assign every scope file to one of `count` shards, largest file first into the lightest shard
 * so far. Deterministic: same input, same plan, on any machine.
 *
 * Byte size is the balancing weight because Stryker's cost scales with the number of mutants a
 * file yields, and nothing cheaper than running Stryker knows that number. Size is the closest
 * proxy available before the run. It only has to be roughly right — the aggregate is correct
 * whatever the split, an unlucky split only costs wall clock.
 *
 * @param {{ path: string, size: number }[]} files
 * @param {number} count
 * @returns {{ index: number, files: string[], bytes: number }[]}
 */
export function planShards(files, count = DEFAULT_SHARDS) {
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

  const shards = Array.from({ length: count }, (_, i) => ({ index: i + 1, files: /** @type {string[]} */ ([]), bytes: 0 }))
  const heaviestFirst = [...files].sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : 1))
  for (const file of heaviestFirst) {
    let lightest = shards[0]
    for (const shard of shards) if (shard.bytes < lightest.bytes) lightest = shard
    lightest.files.push(file.path)
    lightest.bytes += file.size
  }
  for (const shard of shards) shard.files.sort()
  return shards
}

/**
 * The whole plan, ready for a GitHub Actions matrix.
 * @param {number} [count]
 * @param {string} [root]
 */
export async function mutationShardPlan(count = DEFAULT_SHARDS, root = repoRoot) {
  const globs = await mutateGlobs(root)
  const files = scopeFiles(globs, root)
  return { globs, files, shards: planShards(files, count) }
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
    process.stdout.write(`${plan.files.length} files, ${total} bytes, ${plan.shards.length} shards\n`)
    for (const shard of plan.shards) {
      process.stdout.write(`  shard ${shard.index}: ${shard.files.length} files, ${shard.bytes} bytes\n`)
      for (const file of shard.files) process.stdout.write(`    ${file}\n`)
    }
  }
}
