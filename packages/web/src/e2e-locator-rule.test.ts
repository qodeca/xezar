import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The browser-test package's locator rule, enforced on source (#549 AC-4).
 *
 * AC-4 says locators use roles, labels or text only. The package follows it in practice — the 15
 * `guide-*.e2e.ts` files and `screenshot-states.e2e.ts` route every interaction through
 * `guide-browser.ts`'s semantic locator and contain no CSS or attribute locator outside prose —
 * but nothing committed enforced it, so the rule survived on review attention alone. This guard
 * reads the package's own source and fails on `querySelector`, `getElementById`, `data-testid` or
 * a `data-slot` string outside a comment, and on a CSS-selector-shaped string handed to one of
 * `AgentBrowser`'s selector methods — the four tokens alone let `#id`, `.class`, `[aria-label=…]`,
 * `[data-state=…]` and `:nth-child(…)` through.
 *
 * Scope, stated rather than implied: the 16 files #549's rule governs — `guide-*.e2e.ts` and
 * `screenshot-states.e2e.ts`. The suite's 50 pre-existing specs predate the rule and are not
 * scanned; they use CSS selectors by design and retrofitting them is not this package's work.
 * Those three counts are asserted against `readdirSync` in the suite below rather than restated
 * here, the same rule the runtime-ceiling guard applies to the suite's 66 files.
 *
 * A comment is told from code by `codeOnly` below, which blanks `//` and block comments and keeps
 * everything else — string literals included, because a CSS selector is almost always a string,
 * and template-literal `${…}` interpolation, because the suite's own specs build selectors there.
 * Four limits are honest and stated: a locator assembled at runtime from pieces no single line
 * contains is invisible to any source scan; a `data-slot` reached through an imported helper is
 * out of reach; a selector handed to a method this guard does not know (`evaluate`, a helper) is
 * not seen; and a regex literal whose trailing `//` is read as a comment start blinds the rest of
 * its own line. `capture/scenario-state.ts` is the imported-helper case, and it is an explicit,
 * reason-carrying entry in `EXCLUSIONS` with an upper bound on its `data-slot` count rather than a
 * silent skip.
 *
 * The empty-input branch is pinned: a glob that matches no files FAILS the test instead of passing
 * vacuously (AGENTS.md, "A fail-open helper needs a populated-input guarantee, or it lies"). So is
 * a glob narrowed to a single file.
 *
 * Lives in `src/` for the same reason as `e2e-file-parallelism.test.ts`: the web unit project
 * collects `src/**` only, so this runs on the fast gate (`npm test`) and never in `ui-e2e` —
 * 0 s of browser time.
 */

const repoRoot = resolve(import.meta.dirname, '../../..')
const e2eDir = resolve(repoRoot, 'packages/web/e2e')
const AGENT_BROWSER = resolve(repoRoot, 'docs/testing/agent-browser.md')

/** The browser-test package's own files: the rule's scope, and nothing wider. */
export function packageSpecFiles(dir: string = e2eDir): string[] {
  return readdirSync(dir)
    .filter((name) => name === 'screenshot-states.e2e.ts' || /^guide-.*\.e2e\.ts$/.test(name))
    .sort()
}

/** Every `*.e2e.ts` in the suite, the wider set this package's rule does not cover. */
export function suiteSpecFiles(dir: string = e2eDir): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.e2e.ts'))
    .sort()
}

/** The `guide-*.e2e.ts` files, the package's bulk. */
export function guideSpecFiles(dir: string = e2eDir): string[] {
  return readdirSync(dir)
    .filter((name) => /^guide-.*\.e2e\.ts$/.test(name))
    .sort()
}

export interface Exclusion {
  /** Path relative to `packages/web/e2e/`. */
  file: string
  /** Why this file may name markup the rule forbids everywhere else. */
  reason: string
  /**
   * The most `data-slot` occurrences this file may carry. Without it the exclusion is open-ended
   * and a NEW locator added to an excluded file is invisible; with it, one more occurrence than
   * this fails the suite.
   */
  maxDataSlots: number
}

/**
 * Files the rule knowingly does not cover, each with its reason. One entry today; it is a list so
 * a future exclusion has to be written down beside this one instead of being added by widening a
 * glob.
 */
export const EXCLUSIONS: readonly Exclusion[] = [
  {
    file: 'capture/scenario-state.ts',
    maxDataSlots: 62,
    reason:
      'The pre-existing `data-slot` waits/clicks the screenshot scenarios run are the DOM-ready ' +
      'steps the 0.15.0 capture plan has always used to know a page settled — relocated, not ' +
      'redesigned — and are not new locators the package adds (disclosed at ' +
      'screenshot-states.e2e.ts:26-29). One genuinely new occurrence: settings-appearance-roomy ' +
      'shipped one 0.18.0 screenshot with a half-loaded sidebar (#842 review round 1); a semantic ' +
      'role+name wait for the sidebar timed out in the real capture flow even though the element ' +
      'does render, so the fix follows this file\'s own established DOM-wait idiom instead.',
  },
]

/** The forbidden locator forms, named so a failure says which rule broke. */
export const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'querySelector', pattern: /querySelector/ },
  { name: 'getElementById', pattern: /getElementById/ },
  { name: 'data-testid', pattern: /data-testid/ },
  { name: 'data-slot', pattern: /data-slot/ },
]

/**
 * The second net: a CSS-selector-shaped string handed to one of `AgentBrowser`'s selector-taking
 * methods (`click`, `fill`, `hover`, `text`, `isVisible`, `count`). The four tokens above miss
 * every selector that is not one of them — `#id`, `.class`, `[aria-label=…]`, `[data-state=…]` and
 * `:nth-child(…)` all pass — so this closes a hole in the rule rather than widening it.
 */
export const CSS_METHOD_CALL =
  /\.(?:text|isVisible|count|fill|click|hover)\s*\(\s*['"`]\s*(?:#|\.|\[|:[\w-]+\()/

/**
 * Blank out every comment, keep everything else. Comments are `//` to end of line and `/* … *​/`;
 * string literals and template-literal `${…}` interpolation are KEPT, because a selector written
 * as a string is still a selector and the suite builds some of them inside template literals.
 *
 * The state is a stack, not a single flag: `` ` `` pushes a template frame, `${` inside it pushes
 * a code frame, and the matching `}` pops back. An escape (`\\`) is copied verbatim so `\\'` and
 * `\\`` never end a string early.
 *
 * Known limit: a `}` that closes an object literal inside `${…}` pops the frame one step early, so
 * the tail of that interpolation is read as template text. Text is emitted either way, so a
 * forbidden locator is still seen; only a `//` inside such a tail could be misread as a comment.
 */
export function codeOnly(source: string): string {
  const stack: Array<'code' | 'template'> = ['code']
  let out = ''
  let i = 0
  while (i < source.length) {
    const mode = stack[stack.length - 1]
    const ch = source[i]
    const next = source[i + 1]

    if (mode === 'template') {
      if (ch === '\\') {
        out += source.slice(i, i + 2)
        i += 2
        continue
      }
      if (ch === '`') {
        stack.pop()
        out += ch
        i += 1
        continue
      }
      if (ch === '$' && next === '{') {
        stack.push('code')
        out += '${'
        i += 2
        continue
      }
      out += ch
      i += 1
      continue
    }

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      out += ' '
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      out += ch
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') {
          out += source.slice(i, i + 2)
          i += 2
          continue
        }
        out += source[i]
        if (source[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (ch === '`') {
      stack.push('template')
      out += ch
      i += 1
      continue
    }
    if (ch === '}' && stack.length > 1) {
      stack.pop()
      out += ch
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** The forbidden forms a source file uses outside a comment, each with its occurrence count. */
export function violationsIn(source: string): string[] {
  const code = codeOnly(source)
  const found: string[] = []
  for (const { name, pattern } of FORBIDDEN) {
    const matches = code.match(new RegExp(pattern.source, 'g'))
    if (matches && matches.length > 0) found.push(`${name} ×${matches.length}`)
  }
  const cssCalls = code.match(new RegExp(CSS_METHOD_CALL.source, 'g'))
  if (cssCalls && cssCalls.length > 0) found.push(`css-selector method call ×${cssCalls.length}`)
  return found
}

/**
 * Throw unless every scanned file is clean. Exported with injectable inputs so the empty-input and
 * violation branches are pinned directly rather than only through the tree.
 */
export function assertLocatorRule(files: ReadonlyArray<{ rel: string; source: string }>): void {
  if (files.length === 0) {
    throw new Error('e2e-locator-rule: the glob matched no *.e2e.ts files — refusing to pass vacuously')
  }
  const problems: string[] = []
  for (const file of files) {
    const hits = violationsIn(file.source)
    if (hits.length > 0) problems.push(`  ${file.rel}: ${hits.join(', ')}`)
  }
  if (problems.length > 0) {
    throw new Error(
      `e2e-locator-rule: CSS/attribute locators outside a comment — use a role, label or text:\n${problems.join('\n')}`,
    )
  }
}

describe('the browser-test package uses semantic locators only', () => {
  it('scans a non-empty package, so the clean result below is not vacuous', () => {
    // A floor, not `> 0`: a glob narrowed to a single file is the same fail-open shape as an empty
    // one, and would leave the clean result below vacuous.
    expect(packageSpecFiles().length).toBeGreaterThan(1)
  })

  it('states the package and out-of-scope counts the directory actually holds', () => {
    const guides = guideSpecFiles().length
    const pkg = packageSpecFiles().length
    const outside = suiteSpecFiles().length - pkg
    const doc = readFileSync(AGENT_BROWSER, 'utf8')

    // Derived from `readdirSync`, never restated: a narrowed `packageSpecFiles()` glob changes
    // `pkg` and fails the middle assertion rather than silently shrinking the scan.
    expect(doc).toMatch(new RegExp(`the ${guides} \`guide-\\*\\.e2e\\.ts\` files`))
    expect(doc).toMatch(new RegExp(`scans the package's ${pkg} files`))
    expect(doc).toMatch(new RegExp(`The ${outside} pre-existing specs`))
  })

  it('no package spec names a CSS or attribute locator outside a comment', () => {
    const files = packageSpecFiles().map((name) => ({
      rel: name,
      source: readFileSync(resolve(e2eDir, name), 'utf8'),
    }))

    expect(() => assertLocatorRule(files)).not.toThrow()
  })

  it('fails on empty input instead of passing vacuously', () => {
    expect(() => assertLocatorRule([])).toThrow(/matched no \*\.e2e\.ts files/)
  })

  it('goes red when a guide spec gains a data-slot click', () => {
    expect(() =>
      assertLocatorRule([
        {
          rel: 'guide-01-getting-started.e2e.ts',
          source: "  await browser.click('[data-slot=\"composer-submit\"]')\n",
        },
      ]),
    ).toThrow(/guide-01-getting-started\.e2e\.ts: data-slot ×1/)
  })

  it('goes red on a CSS selector the four tokens miss', () => {
    // `#id`, `.class`, `[aria-label=…]`, `[data-state=…]` and `:nth-child(…)` are all selectors,
    // and none of them contains `querySelector`, `getElementById`, `data-testid` or `data-slot`.
    expect(violationsIn("  await browser.click('#composer')\n")).toEqual([
      'css-selector method call ×1',
    ])
    expect(violationsIn("  await browser.isVisible('.composer')\n")).toEqual([
      'css-selector method call ×1',
    ])
    expect(violationsIn("  await browser.fill('[aria-label=\"Prompt\"]', 'x')\n")).toEqual([
      'css-selector method call ×1',
    ])
    expect(violationsIn("  await browser.click('[data-state=\"open\"]')\n")).toEqual([
      'css-selector method call ×1',
    ])
    expect(violationsIn("  await browser.hover(':nth-child(2)')\n")).toEqual([
      'css-selector method call ×1',
    ])
    // A semantic locator on the same method is not a selector.
    expect(violationsIn("  await browser.click('Composer')\n")).toEqual([])
  })

  it('tells a comment from code', () => {
    // A comment is not a locator.
    expect(violationsIn('// [data-slot="x"]\n')).toEqual([])
    expect(violationsIn('/* [data-slot="x"] */\n')).toEqual([])
    expect(violationsIn('/*\n * `data-slot` waits are DOM-ready steps\n */\n')).toEqual([])
    // A string literal is code, and so is a template literal's interpolation.
    expect(violationsIn("const a = '[data-slot=\"x\"]'\n")).toEqual(['data-slot ×1'])
    expect(violationsIn('const a = `${b ? \'[data-slot="x"]\' : ""}`\n')).toEqual(['data-slot ×1'])
    expect(violationsIn('document.querySelector("#x")\n')).toEqual(['querySelector ×1'])
    expect(violationsIn('document.getElementById("root")\n')).toEqual(['getElementById ×1'])
    expect(violationsIn("const a = '[data-testid=\"x\"]'\n")).toEqual(['data-testid ×1'])
    // A `//` inside a string never starts a comment, so code after it stays visible.
    expect(violationsIn("const url = 'https://x' // [data-slot=\"y\"]\n")).toEqual([])
    expect(violationsIn("const url = 'https://x' ; const a = '[data-slot=\"y\"]'\n")).toEqual([
      'data-slot ×1',
    ])
    // An escape does not end the string early.
    expect(violationsIn("const a = 'it\\'s' + '[data-slot=\"y\"]'\n")).toEqual(['data-slot ×1'])
  })

  it('keeps every exclusion auditable: the file exists and the reason is written', () => {
    expect(EXCLUSIONS.length).toBeGreaterThan(0)
    for (const exclusion of EXCLUSIONS) {
      expect(existsSync(resolve(e2eDir, exclusion.file)), exclusion.file).toBe(true)
      expect(exclusion.reason.length, exclusion.file).toBeGreaterThan(80)
    }
  })

  it('bounds every exclusion, so a new locator there is visible', () => {
    for (const exclusion of EXCLUSIONS) {
      const source = readFileSync(resolve(e2eDir, exclusion.file), 'utf8')
      const dataSlots = (source.match(/data-slot/g) ?? []).length
      expect(dataSlots, `${exclusion.file}: data-slot occurrences`).toBeLessThanOrEqual(
        exclusion.maxDataSlots,
      )
    }
  })

  it('does not silently scan an excluded file', () => {
    for (const exclusion of EXCLUSIONS) {
      expect(packageSpecFiles()).not.toContain(exclusion.file)
    }
  })
})
