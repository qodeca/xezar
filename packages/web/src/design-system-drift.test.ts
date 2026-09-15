// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Design-system drift — keeps `docs/design-system/` honest against the cockpit sources.
 *
 * Four checks, each a static scan (no network, no DOM):
 *  0. Every top-level block in `src/styles/index.css` that declares a custom property is one
 *     the test knows (a theme block, an appearance block, `@theme static` or `@theme inline`),
 *     so a token added in a new block cannot slip past checks 1 and 3.
 *  1. Every CSS custom property declared in `src/styles/index.css` (the theme blocks, the
 *     appearance blocks, `@theme static` and the `@theme inline` mapping) is named in
 *     `foundations.md` or `theming.md` as `` `--name` `` (the two files that own tokens; a
 *     mention in known-gaps.md alone is not documentation).
 *  2. Every primitive (`src/components/ui/*.tsx`) and every shared component (a non-test `.ts`
 *     or `.tsx` file directly in `src/components/` or in `src/components/composer/` or
 *     `src/components/diff/`) has a row in `docs/design-system/coverage.md` naming its path,
 *     and every component path coverage.md names is a file that exists (no stale rows).
 *  3. The shared specimen stylesheet `docs/design-system/cockpit.css` carries every token of
 *     every theme block with an identical value, and declares no token index.css does not.
 *     The `@theme inline` mapping (`--color-*`, `--font-*`, `--radius-md`) is Tailwind wiring and
 *     is exempt from the stylesheet check; check 1 still requires it to be documented.
 *
 * The definition of "shared component" lives in docs/design-system/components.md; change both.
 */

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(WEB_ROOT, '..', '..')
const DS_ROOT = path.join(REPO_ROOT, 'docs', 'design-system')
const INDEX_CSS = path.join(WEB_ROOT, 'src', 'styles', 'index.css')
const COCKPIT_CSS = path.join(DS_ROOT, 'cockpit.css')
const COVERAGE_MD = path.join(DS_ROOT, 'coverage.md')

/** The index.css blocks whose custom properties are design tokens. `@theme static` folds into
 *  `:root` for the stylesheet comparison because a plain stylesheet has no `@theme`. */
const THEME_SELECTORS = [
  ':root',
  '.light',
  ":root[data-accent='violet']",
  ":root[data-density='roomy']",
  ":root[data-density='compact']",
  ":root[data-density='ultra']",
  ":root[data-width='wide']",
]
const FOLDED_INTO_ROOT = ['@theme static']
const MAPPING_SELECTORS = ['@theme inline']

interface Block {
  selector: string
  body: string
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** The text before a block may carry statement-level rules (`@import …;`); only the last
 *  `;`-separated segment is the selector. */
function normalizeSelector(selector: string): string {
  const last = selector.slice(selector.lastIndexOf(';') + 1)
  return last.replace(/\s+/g, ' ').replace(/"/g, "'").trim()
}

/** Top-level blocks only. `@media`/`@layer` wrappers are skipped (their inner blocks are depth 2). */
function topLevelBlocks(css: string): Block[] {
  const out: Block[] = []
  let depth = 0
  let selectorStart = 0
  let bodyStart = 0
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i]
    if (c === '{') {
      if (depth === 0) bodyStart = i + 1
      depth += 1
    } else if (c === '}') {
      depth -= 1
      if (depth === 0) {
        const selector = normalizeSelector(css.slice(selectorStart, bodyStart - 1))
        out.push({ selector, body: css.slice(bodyStart, i) })
        selectorStart = i + 1
      }
    }
  }
  return out
}

function customProps(body: string): Map<string, string> {
  const props = new Map<string, string>()
  // A declaration may be the last in its block and carry no `;`.
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)(?=[;}])/g)) {
    const name = match[1]!
    if (name.includes('*')) continue
    props.set(name, match[2]!.replace(/\s+/g, ' ').trim())
  }
  return props
}

function tokenBlocks(css: string, selectors: readonly string[]): Map<string, Map<string, string>> {
  const byName = new Map<string, Map<string, string>>()
  for (const block of topLevelBlocks(stripCssComments(css))) {
    if (!selectors.includes(block.selector)) continue
    const merged = byName.get(block.selector) ?? new Map<string, string>()
    for (const [name, value] of customProps(block.body)) merged.set(name, value)
    byName.set(block.selector, merged)
  }
  return byName
}

const indexCss = readFileSync(INDEX_CSS, 'utf8')
const cockpitCss = readFileSync(COCKPIT_CSS, 'utf8')

const indexThemeBlocks = tokenBlocks(indexCss, [...THEME_SELECTORS, ...FOLDED_INTO_ROOT])
const indexMappingBlocks = tokenBlocks(indexCss, MAPPING_SELECTORS)
const cockpitThemeBlocks = tokenBlocks(cockpitCss, THEME_SELECTORS)

/** index.css tokens per selector, with `@theme static` folded into `:root`. */
function indexTokensFor(selector: string): Map<string, string> {
  const out = new Map(indexThemeBlocks.get(selector) ?? [])
  if (selector === ':root') {
    for (const folded of FOLDED_INTO_ROOT) {
      for (const [name, value] of indexThemeBlocks.get(folded) ?? []) out.set(name, value)
    }
  }
  return out
}

/** The documents that own token entries. */
const TOKEN_DOCS = ['foundations.md', 'theming.md']

function tokenDocs(): string {
  return TOKEN_DOCS.map((name) => readFileSync(path.join(DS_ROOT, name), 'utf8')).join('\n')
}

function isSourceFile(name: string): boolean {
  return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isSourceFile(entry.name))
    .map((entry) => entry.name)
    .sort()
}

/** Repo-relative paths, `/`-separated, exactly as coverage.md spells them. */
function inventoryPaths(): { primitives: string[]; shared: string[] } {
  const componentsDir = path.join(WEB_ROOT, 'src', 'components')
  const rel = (...parts: string[]) => ['packages', 'web', 'src', 'components', ...parts].join('/')
  const primitives = listFiles(path.join(componentsDir, 'ui'))
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => rel('ui', name))
  const shared = [
    ...listFiles(componentsDir).map((name) => rel(name)),
    ...listFiles(path.join(componentsDir, 'composer')).map((name) => rel('composer', name)),
    ...listFiles(path.join(componentsDir, 'diff')).map((name) => rel('diff', name)),
  ]
  return { primitives, shared }
}

describe('design-system drift', () => {
  it('actually parsed the token sheet (guards against a broken parser)', () => {
    const root = indexTokensFor(':root')
    expect(root.get('--background')).toBe('#0d0d0d')
    expect(root.get('--radius')).toBe('10px')
    expect(indexTokensFor('.light').get('--background')).toBe('#ffffff')
    expect(indexMappingBlocks.get('@theme inline')?.has('--color-card')).toBe(true)
    expect(root.size).toBeGreaterThan(40)
  })

  it('every index.css block that declares a custom property is one the test knows', () => {
    const known = [...THEME_SELECTORS, ...FOLDED_INTO_ROOT, ...MAPPING_SELECTORS]
    const unknown = topLevelBlocks(stripCssComments(indexCss))
      .filter((block) => customProps(block.body).size > 0 && !known.includes(block.selector))
      .map((block) => block.selector)
    expect(unknown, 'add the selector to THEME_SELECTORS, FOLDED_INTO_ROOT or MAPPING_SELECTORS').toEqual([])
  })

  it('every custom property in index.css has an entry in foundations.md or theming.md', () => {
    const docs = tokenDocs()
    const names = new Set<string>()
    for (const block of [...indexThemeBlocks.values(), ...indexMappingBlocks.values()]) {
      for (const name of block.keys()) names.add(name)
    }
    const missing = [...names].filter((name) => !docs.includes(`\`${name}\``))
    expect(missing, 'tokens declared in index.css but not documented as `--name` in foundations.md or theming.md').toEqual([])
  })

  it('every primitive and shared component has a row in coverage.md', () => {
    const coverage = readFileSync(COVERAGE_MD, 'utf8')
    const { primitives, shared } = inventoryPaths()
    expect(primitives.length).toBeGreaterThan(15)
    expect(shared.length).toBeGreaterThan(40)
    const missing = [...primitives, ...shared].filter((file) => !coverage.includes(`\`${file}\``))
    expect(missing, 'component files without a coverage row').toEqual([])
    const inventory = new Set([...primitives, ...shared])
    const stale = [...coverage.matchAll(/`(packages\/web\/src\/components\/[^`]+\.tsx?)`/g)]
      .map((match) => match[1]!)
      .filter((file) => !inventory.has(file))
    expect(stale, 'coverage.md rows naming a component file that does not exist').toEqual([])
  })

  it('cockpit.css carries every index.css token with an identical value', () => {
    const problems: string[] = []
    for (const selector of THEME_SELECTORS) {
      const expected = indexTokensFor(selector)
      const actual = cockpitThemeBlocks.get(selector)
      if (!actual) {
        problems.push(`${selector}: block missing from cockpit.css`)
        continue
      }
      for (const [name, value] of expected) {
        const got = actual.get(name)
        if (got === undefined) problems.push(`${selector} ${name}: missing from cockpit.css`)
        else if (got !== value) problems.push(`${selector} ${name}: cockpit.css has "${got}", index.css has "${value}"`)
      }
      for (const name of actual.keys()) {
        if (!expected.has(name)) problems.push(`${selector} ${name}: declared in cockpit.css but not in index.css`)
      }
    }
    expect(problems, 'token drift between cockpit.css and index.css').toEqual([])
  })
})
