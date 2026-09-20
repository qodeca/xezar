import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The browser suite's runtime ceilings and every documented `*.e2e.ts` file count (#549 AC-1).
 *
 * AC-1 asks for a whole-suite ceiling and a per-file ceiling recorded in the tracked tree. Both
 * live in `docs/testing/agent-browser.md` § Runtime ceilings, anchored to one measured run — CI
 * 35512713688, 996.22 s at 66 files — rather than to a target. The CI job's own 30-minute bound
 * (`ci.yml`) stays as it is.
 *
 * Three separate documents had drifted to three different spec counts (35, 35, 39 against a real
 * 66) because nothing read the directory. So this guard does two jobs:
 *
 *   1. it pins the two ceiling lines, with the measured numbers in them, so deleting or renumbering
 *      a ceiling is a red test rather than a silent doc edit;
 *   2. it asserts that EVERY count a document states equals `readdirSync` over
 *      `packages/web/e2e/*.e2e.ts`, and it FAILS on an empty directory instead of passing
 *      vacuously — the fail-open shape AGENTS.md warns about, where "the glob matched nothing" and
 *      "no violations" are the same branch.
 *
 * Lives in `src/` for the same reason as `e2e-file-parallelism.test.ts`: the web unit project
 * collects `src/**` only, so this runs on the fast gate (`npm test`) and never in `ui-e2e` —
 * 0 s of browser time.
 */

const repoRoot = resolve(import.meta.dirname, '../../..')
const e2eDir = resolve(repoRoot, 'packages/web/e2e')

const AGENT_BROWSER = resolve(repoRoot, 'docs/testing/agent-browser.md')
const CI = resolve(repoRoot, '.github/workflows/ci.yml')
const COVERAGE_GAPS = resolve(repoRoot, 'docs/testing/coverage-gaps.md')

export interface CountSite {
  /** Document that states a count. */
  path: string
  /** The sentence shape that carries it; group 1 is the number. */
  pattern: RegExp
}

/** Every place a document states how many `*.e2e.ts` files the browser suite holds. */
export const COUNT_SITES: readonly CountSite[] = [
  { path: AGENT_BROWSER, pattern: /(\d+)\s+`\*\.e2e\.ts` files/g },
  { path: CI, pattern: /(\d+)\s+`\*\.e2e\.ts` specs/g },
  { path: COVERAGE_GAPS, pattern: /(\d+) files, `packages\/web\/e2e\/`/g },
]

/** The browser suite's spec files, as the directory actually holds them. */
export function e2eSpecFiles(dir: string = e2eDir): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.e2e.ts'))
    .sort()
}

/** Every number a document claims, in document order. */
export function documentedCounts(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(pattern)].map((match) => Number(match[1]))
}

/**
 * One top-level job's block in `ci.yml`: from its own `\n  <job>:\n` key to the next top-level job
 * key, and nothing past it. The CI bound is asserted INSIDE this slice and nowhere else.
 *
 * The assertion this replaced — `ci.toMatch(/ui-e2e:[\s\S]*?timeout-minutes: 30/)` — was lazy and
 * unanchored to the job. `ui-e2e` sits at `ci.yml:163`; the NEXT job (`xezar-infra-fixtures`)
 * carries its own `timeout-minutes: 30`. Widening `ui-e2e`'s own bound to 45 on line 174 therefore
 * stayed green: the regex spilled into its neighbour and found the neighbour's 30. The test named
 * the one thing the suite's stability rule forbids and gave false assurance it was held.
 */
export function ciJobBlock(ci: string, job: string): string {
  const key = `\n  ${job}:\n`
  const start = ci.indexOf(key)
  if (start === -1) {
    throw new Error(`e2e-runtime-ceiling: ci.yml has no top-level "${job}:" job`)
  }
  const body = ci.slice(start + 1)
  const next = body.search(/\n  [a-z][\w-]*:\n/)
  return next === -1 ? body : body.slice(0, next)
}

/**
 * Throw unless every documented count equals the real one. Exported with injectable inputs so the
 * empty-input and stale-count branches are pinned directly rather than through the tree.
 */
export function assertCountsAgree(
  files: readonly string[],
  sites: readonly CountSite[] = COUNT_SITES,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): void {
  if (files.length === 0) {
    throw new Error(
      'e2e-runtime-ceiling: the glob matched no *.e2e.ts files — refusing to pass vacuously',
    )
  }
  for (const site of sites) {
    const counts = documentedCounts(read(site.path), site.pattern)
    if (counts.length === 0) {
      throw new Error(`e2e-runtime-ceiling: ${site.path} documents no *.e2e.ts file count`)
    }
    for (const count of counts) {
      if (count !== files.length) {
        throw new Error(
          `e2e-runtime-ceiling: ${site.path} says ${count} *.e2e.ts files, the directory holds ${files.length}`,
        )
      }
    }
  }
}

describe('the browser suite records its runtime ceilings', () => {
  it('scans a non-empty suite, so nothing below passes vacuously', () => {
    expect(e2eSpecFiles().length).toBeGreaterThan(0)
  })

  it('states the whole-suite ceiling with its measured anchor', () => {
    const doc = readFileSync(AGENT_BROWSER, 'utf8')

    expect(doc).toMatch(/Whole suite: 1 200 s/)
    // The derivation, not just the number: 996.22 s measured + 20 %.
    expect(doc).toMatch(/996\.22 s/)
    expect(doc).toMatch(/20 %/)
  })

  it('states the per-file ceiling with the worst real file', () => {
    const doc = readFileSync(AGENT_BROWSER, 'utf8')

    expect(doc).toMatch(/Any single `\*\.e2e\.ts` file: 60 s/)
    expect(doc).toMatch(/30\.9 s/)
  })

  it("leaves the CI job's 30-minute bound in place", () => {
    const ci = readFileSync(CI, 'utf8')

    expect(ciJobBlock(ci, 'ui-e2e')).toMatch(/timeout-minutes: 30/)
  })

  it('slices one job only, so a neighbouring job cannot satisfy the bound', () => {
    const synthetic =
      'jobs:\n  ui-e2e:\n    timeout-minutes: 30\n  xezar-infra-fixtures:\n    timeout-minutes: 45\n'

    expect(ciJobBlock(synthetic, 'ui-e2e')).toMatch(/timeout-minutes: 30/)
    expect(ciJobBlock(synthetic, 'ui-e2e')).not.toMatch(/timeout-minutes: 45/)
    expect(() => ciJobBlock(synthetic, 'no-such-job')).toThrow(/no top-level "no-such-job:" job/)
  })

  it('states the amended stability rule', () => {
    const doc = readFileSync(AGENT_BROWSER, 'utf8')

    expect(doc).toMatch(/Never a retry, a `\.retry`, a\s+sleep, a widened timeout, or a register/)
  })

  it('every documented file count equals the directory', () => {
    expect(() => assertCountsAgree(e2eSpecFiles())).not.toThrow()
  })

  it('fails on empty input instead of passing vacuously', () => {
    expect(() => assertCountsAgree([])).toThrow(/matched no \*\.e2e\.ts files/)
  })

  it('fails when a document states a stale count', () => {
    expect(() =>
      assertCountsAgree(
        ['a.e2e.ts'],
        [{ path: 'fake.md', pattern: /(\d+) files, `packages\/web\/e2e\/`/g }],
        () => '39 files, `packages/web/e2e/`',
      ),
    ).toThrow(/says 39 \*\.e2e\.ts files, the directory holds 1/)
  })

  it('fails when a document stops stating a count at all', () => {
    expect(() =>
      assertCountsAgree(
        ['a.e2e.ts'],
        [{ path: 'fake.md', pattern: /(\d+) files, `packages\/web\/e2e\/`/g }],
        () => 'no count here',
      ),
    ).toThrow(/documents no \*\.e2e\.ts file count/)
  })
})
