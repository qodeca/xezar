import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Design guardian — a static scan enforcing the spec's design-system rules over the cockpit
 * sources (ported from the original cockpit's guardian). It runs inside `npm test`, so a violation fails
 * the validation gate with the exact file, line, and offending token.
 *
 * Scope:
 *  - "style" rules scan shipped UI sources (`src/**` minus `*.test.*`) — tests legitimately
 *    quote forbidden tokens when asserting user-visible copy (a PR chip's `#402`) or when
 *    asserting a rule holds (`expect(...).not.toContain('h-screen')`).
 *  - "code" rules (native dialogs) scan everything that executes: `src/**` and `e2e/**`,
 *    tests included.
 *  - Comments are stripped before matching (issue references like `#377` share the hex-color
 *    grammar), with string awareness so a `//` inside a URL literal is not treated as one.
 */

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = path.basename(fileURLToPath(import.meta.url))

interface SourceFile {
  /** Path relative to packages/web, always with `/` separators (allowlists match on it). */
  rel: string
  ext: string
  isTest: boolean
  isE2e: boolean
  /** Comment-stripped source; stripping preserves line numbers and column positions. */
  lines: string[]
}

interface Rule {
  name: string
  why: string
  pattern: RegExp
  applies: (file: SourceFile) => boolean
  /** Files where the token is legitimate (the token definition site, primitives). */
  allowed?: (rel: string) => boolean
  /** When set, a pattern match is a violation only if this returns true (a lookup the regex
   *  grammar cannot express, such as "the captured name is not a declared token"). */
  violates?: (match: RegExpMatchArray) => boolean
}

/** Shipped UI code and stylesheets — where the design tokens are the only color vocabulary. */
const styleSources = (f: SourceFile) => !f.isTest && !f.isE2e
/** Everything that executes in or against the app, tests and e2e drivers included. */
const codeSources = (f: SourceFile) => f.ext !== '.css'
/** Shipped React sources only — the files that spell Tailwind class strings. */
const classSources = (f: SourceFile) => styleSources(f) && f.ext !== '.css'

const INDEX_CSS = 'src/styles/index.css'

/**
 * The colour names Tailwind knows in this app: every `--color-<name>` declared in the
 * `@theme inline` block of index.css. Read at load, so a token added there is known here in the
 * same commit and a class naming anything else (`text-warning`, `bg-red-500`) is a class Tailwind
 * emits nothing for — the element silently inherits its parent's colour (known-gaps G-24, now
 * closed). Parsing mirrors design-system-drift.test.ts: strip comments, take the top-level block
 * whose selector is `@theme inline`, collect its custom properties.
 */
function knownColorNames(): Set<string> {
  const css = readFileSync(path.join(APP_ROOT, INDEX_CSS), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const names = new Set<string>()
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
        const raw = css.slice(selectorStart, bodyStart - 1)
        const selector = raw.slice(raw.lastIndexOf(';') + 1).replace(/\s+/g, ' ').trim()
        if (selector === '@theme inline') {
          for (const m of css.slice(bodyStart, i).matchAll(/--color-([\w-]+)\s*:/g)) names.add(m[1]!)
        }
        selectorStart = i + 1
      }
    }
  }
  return names
}

const KNOWN_COLORS = knownColorNames()

/**
 * Names the colour-prefixed utilities carry that are NOT colours — sizes, alignment, shape,
 * keywords Tailwind resolves without a palette entry. Explicit and derived from what the scan
 * finds, so a typo in a new one surfaces as a violation rather than vanishing into a wildcard.
 * Colours never go here: an unknown colour is fixed at the site or declared in index.css.
 */
const NON_COLOR = new Set([
  // text-* sizes, alignment and wrapping
  'xs', 'sm', 'base', 'lg', 'xl',
  'left', 'center', 'right', 'justify', 'start', 'end',
  'balance', 'pretty', 'wrap', 'nowrap', 'clip', 'ellipsis',
  // keywords every colour utility accepts
  'transparent', 'current', 'inherit',
  // border-*/divide-*/outline-* sides (bare), widths (after a side is stripped) and styles
  't', 'b', 'l', 'r', 'x', 'y', 's', 'e', '0', '2',
  'dashed', 'dotted', 'solid', 'none', 'hidden', 'collapse',
  // ring-* / outline-* geometry
  'inset', 'offset-2', 'offset-background',
  // bg-* gradient direction
  'gradient-to-b',
  // shadow-* elevations: Tailwind's `md`, and `--shadow-modal`, a shadow token in `@theme static`
  'md', 'modal',
])

/**
 * Names owned by another rule in this file: `black`/`white` are what `no-raw-black-white`
 * polices, with its own primitive-scrim exemptions. Listing them here keeps that rule the single
 * owner of the exemption rather than duplicating the allowlist.
 */
const OWNED_ELSEWHERE = new Set(['black', 'white'])

const RULES: Rule[] = [
  {
    name: 'no-raw-hex-colors',
    why: 'colors go through the design tokens in src/styles/index.css, never raw hex',
    // 3/4/6/8-digit hex only (the CSS color grammar); the lookarounds reject HTML entities
    // (`&#8203;`) and longer hashes, and comment stripping removes issue refs like `#402`.
    pattern: /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g,
    applies: styleSources,
    allowed: (rel) => rel === INDEX_CSS,
  },
  // The next two rules follow Vercel's design-guideline principle: anything a machine can check
  // becomes lint, so a review never has to catch it by eye.
  {
    name: 'no-color-functions',
    why: 'colour values are declared once in src/styles/index.css; a component spelling rgb()/hsl()/oklch()/color-mix() invents a colour the token sheet cannot theme',
    pattern: /\b(?:rgba?|hsla?|oklch|oklab|color-mix)\(/g,
    applies: styleSources,
    // github-filter.ts blends a GitHub LABEL colour (data from the API, not a design token) toward
    // `--foreground` so the chip text reads in both themes — the only site where the colour is
    // runtime input rather than a design decision.
    allowed: (rel) => rel === INDEX_CSS || rel === 'src/routes/github/github-filter.ts',
  },
  {
    name: 'unknown-color-token',
    why: 'a colour utility must name a --color-* token from the @theme inline block of src/styles/index.css — Tailwind emits nothing for an undeclared name and the element silently inherits its parent colour',
    // A colour-carrying utility prefix, then the name (lazy, so an optional `/opacity` suffix
    // and the class-string boundary end it). Arbitrary values (`text-[11px]`) and numeric
    // sizes (`text-2xl`, `ring-2`) start with `[` or a digit and never match.
    // The lookbehind keeps hyphenated identifiers out (`scroll-to-latest`, `slide-in-from-top-2`,
    // `var(--accent-lime)`); the lookahead ends at a class-string boundary and never at `:`, so a
    // CSS property spelled in a string (`border-color: `) is not a class.
    pattern: /(?<![\w-])(?:text|bg|border|ring|fill|stroke|from|via|to|outline|divide|placeholder|caret|accent|decoration|shadow)-([a-z][a-z0-9-]*?)(?:\/\d+)?(?=[\s"'`}\])]|$)/g,
    applies: classSources,
    violates: (match) => {
      // `border-l-2`, `border-t-transparent`: the side is geometry, the rest is what to check.
      const name = match[1]!.replace(/^(?:[tblrxyse])-(?=.)/, '')
      return !KNOWN_COLORS.has(name) && !NON_COLOR.has(name) && !OWNED_ELSEWHERE.has(name)
    },
  },
  {
    name: 'no-amber-text',
    why: 'amber ink goes through --pending-strong, the per-theme readable token; --pending itself is a dot & spinner FILL and fails contrast as text on the light theme (token sheet rule)',
    // `text-pending-strong` is excluded by the lookahead — it is the sanctioned spelling, and it
    // is a different token, not a loophole: `--pending` is amber-400 in both themes, while
    // `--pending-strong` darkens to amber-700 on light. Everything else amber stays banned.
    pattern: /\btext-(?:pending(?!-strong)|amber(?:-\d+)?)\b/g,
    applies: styleSources,
  },
  {
    name: 'no-raw-black-white',
    why: 'use surface/foreground tokens so both themes work; bg/text-white/black bypass them',
    pattern: /\b(?:bg|text)-(?:white|black)\b/g,
    applies: styleSources,
    // The shadcn overlay scrims (dialog, sheet) and the image lightbox scrim are deliberately
    // bg-black/xx in both themes — a dark backdrop is theme-agnostic by design.
    allowed: (rel) =>
      rel.startsWith('src/components/ui/') || rel === 'src/components/zoomable-image.tsx',
  },
  {
    name: 'no-native-dialogs',
    why: 'native confirm()/alert()/prompt() block the event loop and ignore the design system',
    // Bare or window./globalThis.-qualified calls; `foo.confirm(` (someone's API) stays legal.
    pattern: /(?<![\w$.])(?:window\.|globalThis\.)?(?:confirm|alert|prompt)\s*\(/g,
    applies: codeSources,
    // The bookmarklet generator's `alert(` lives inside the javascript: PROGRAM STRING it
    // emits (spec 011, ported verbatim from web/app.js). That program runs on github.com,
    // where the cockpit's toaster does not exist — alert() is its only honest surface. The
    // cockpit's own code in that file never calls a native dialog.
    allowed: (rel) => rel === 'src/lib/bookmarklet.ts',
  },
  {
    name: 'no-dark-variant',
    why: 'theming keys off the [data-theme] tokens, not prefers-color-scheme dark: variants',
    // `dark:` immediately followed by a utility (letter, `[`, `!`, `-`, `/`) — an object
    // literal's `dark: value` key has whitespace after the colon and stays legal.
    pattern: /\bdark:(?=[a-z![/-])/g,
    applies: styleSources,
  },
  {
    name: 'fixture-serve-must-pin-xez-home',
    why: "a spec-owned `xezar serve` takes its env from fixtureServeEnv(dataRoot) — a hand-rolled { XEZ_DRY_RUN } leaves XEZ_HOME at the developer's real ~/.xezar, so every run appends a dead /tmp fixture to their project registry",
    // Line-level: a XEZ_DRY_RUN that is not accompanied by a XEZ_HOME on the same line. Both
    // fixtureServeEnv() and the specs that spell the pair inline satisfy it.
    pattern: /^(?![^\n]*XEZ_HOME)[^\n]*\bXEZ_DRY_RUN\b/g,
    applies: (f) => f.isE2e,
  },
  {
    name: 'no-100vh',
    why: 'viewport height is 100dvh/h-dvh — 100vh ignores mobile browser chrome (iOS rule)',
    pattern: /\b(?:(?:h|min-h|max-h)-screen|100vh)\b/g,
    applies: styleSources,
  },
]

/**
 * Blanks out comments while preserving the file's shape (every non-newline comment char
 * becomes a space). Tracks string state so comment openers inside literals are ignored.
 * Known limitation: regex literals are not lexed, so `/` pairs inside one can eat the rest
 * of a line — acceptable for a guardian (it can only under-report on that one line).
 */
function stripComments(source: string, lineComments: boolean): string {
  let out = ''
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
  let i = 0
  while (i < source.length) {
    const c = source[i]!
    const n = source[i + 1]
    if (mode === 'code') {
      if (lineComments && c === '/' && n === '/') {
        mode = 'line'
        out += '  '
        i += 2
        continue
      }
      if (c === '/' && n === '*') {
        mode = 'block'
        out += '  '
        i += 2
        continue
      }
      if (c === "'") mode = 'single'
      else if (c === '"') mode = 'double'
      else if (c === '`') mode = 'template'
      out += c
      i += 1
      continue
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code'
        out += c
      } else {
        out += ' '
      }
      i += 1
      continue
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code'
        out += '  '
        i += 2
        continue
      }
      out += c === '\n' ? c : ' '
      i += 1
      continue
    }
    // String modes: honor escapes, close on the matching quote (or, for ' and ", a newline —
    // an unterminated string must not swallow the rest of the file).
    if (c === '\\') {
      out += c + (n ?? '')
      i += 2
      continue
    }
    if (
      (mode === 'single' && (c === "'" || c === '\n')) ||
      (mode === 'double' && (c === '"' || c === '\n')) ||
      (mode === 'template' && c === '`')
    ) {
      mode = 'code'
    }
    out += c
    i += 1
    continue
  }
  return out
}

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.css'])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

function loadSources(): SourceFile[] {
  const files: SourceFile[] = []
  for (const root of ['src', 'e2e']) {
    for (const abs of walk(path.join(APP_ROOT, root))) {
      const rel = path.relative(APP_ROOT, abs).split(path.sep).join('/')
      // This file defines the forbidden patterns as literals; scanning it would be circular.
      if (path.basename(rel) === SELF) continue
      const ext = path.extname(rel)
      const stripped = stripComments(readFileSync(abs, 'utf8'), ext !== '.css')
      files.push({
        rel,
        ext,
        isTest: /\.test\.(?:ts|tsx)$/.test(rel),
        isE2e: rel.startsWith('e2e/'),
        lines: stripped.split('\n'),
      })
    }
  }
  return files
}

const sources = loadSources()

/**
 * Runs one rule over a set of files and returns every violation as `packages/web/<rel>:<line>  <token>`.
 * Pure, so the real per-rule test and the fixture tests below run the SAME code path — a self-test
 * that re-implemented this loop would only test a copy of it.
 */
function scan(rule: Rule, files: readonly SourceFile[]): string[] {
  const violations: string[] = []
  for (const file of files) {
    if (!rule.applies(file)) continue
    if (rule.allowed?.(file.rel)) continue
    file.lines.forEach((line, index) => {
      for (const match of line.matchAll(rule.pattern)) {
        if (rule.violates && !rule.violates(match)) continue
        violations.push(`packages/web/${file.rel}:${index + 1}  ${match[0].trim()}`)
      }
    })
  }
  return violations
}

/** A one-file fixture classified the way `loadSources` classifies a real file. */
function fixture(rel: string, ...lines: string[]): SourceFile {
  const ext = path.extname(rel)
  return {
    rel,
    ext,
    isTest: /\.test\.(?:ts|tsx)$/.test(rel),
    isE2e: rel.startsWith('e2e/'),
    lines: stripComments(lines.join('\n'), ext !== '.css').split('\n'),
  }
}

function ruleNamed(name: string): Rule {
  const rule = RULES.find((r) => r.name === name)
  if (!rule) throw new Error(`no guardian rule named ${name}`)
  return rule
}

/**
 * Fixture verdicts for every rule: one spelling each rule must flag and one it must not, plus the
 * file exemptions. These are GUARD tests that pass both before and after a change to `scan()` or
 * `Rule` — on the real tree every rule reports nothing, so "the tree is still clean" alone could not
 * notice a rule that quietly stopped reporting.
 */
const VERDICTS: { rule: string; flag: SourceFile[]; pass: SourceFile[] }[] = [
  {
    rule: 'no-raw-hex-colors',
    flag: [fixture('src/x.tsx', 'const c = "#fff"')],
    pass: [fixture('src/x.tsx', 'const zwsp = "&#8203;"'), fixture(INDEX_CSS, '--x: #fff;')],
  },
  {
    rule: 'no-color-functions',
    flag: [fixture('src/x.tsx', 'const c = "rgb(0 0 0)"')],
    pass: [fixture('src/routes/github/github-filter.ts', 'const c = `rgb(${r} ${g} ${b})`')],
  },
  {
    rule: 'unknown-color-token',
    flag: [fixture('src/x.tsx', '<p className="text-warning" />')],
    pass: [fixture('src/x.tsx', '<p className="text-foreground border-l-2 text-[11px] bg-black/50" />')],
  },
  {
    rule: 'no-amber-text',
    flag: [fixture('src/x.tsx', '<p className="text-pending" />'), fixture('src/x.tsx', '<p className="text-amber-400" />')],
    pass: [fixture('src/x.tsx', '<p className="text-pending-strong" />')],
  },
  {
    rule: 'no-raw-black-white',
    flag: [fixture('src/routes/x.tsx', '<div className="bg-black/50" />')],
    pass: [
      fixture('src/components/ui/x.tsx', '<div className="bg-black/50" />'),
      fixture('src/components/zoomable-image.tsx', '<div className="bg-black/50" />'),
    ],
  },
  {
    rule: 'no-native-dialogs',
    flag: [
      fixture('src/x.tsx', 'if (confirm("sure?")) go()'),
      fixture('src/x.tsx', 'window.alert("hi")'),
      fixture('src/x.test.ts', 'confirm("sure?")'),
    ],
    pass: [fixture('src/x.tsx', 'foo.confirm("sure?")'), fixture('src/lib/bookmarklet.ts', 'alert("hi")')],
  },
  {
    rule: 'no-dark-variant',
    flag: [fixture('src/x.tsx', '<div className="dark:bg-card" />')],
    pass: [fixture('src/x.tsx', 'const theme = { dark: value }')],
  },
  {
    rule: 'fixture-serve-must-pin-xez-home',
    flag: [fixture('e2e/x.e2e.ts', 'const env = { XEZ_DRY_RUN: "1" }')],
    pass: [
      fixture('e2e/x.e2e.ts', 'const env = { XEZ_DRY_RUN: "1", XEZ_HOME: home }'),
      fixture('src/x.tsx', 'const env = { XEZ_DRY_RUN: "1" }'),
    ],
  },
  {
    rule: 'no-100vh',
    flag: [fixture('src/x.tsx', '<div className="h-screen" />'), fixture('src/x.css', '.x { height: 100vh; }')],
    pass: [fixture('src/x.tsx', '<div className="h-dvh" />')],
  },
]

describe('design guardian', () => {
  it('actually scans the codebase (guards against a broken walker)', () => {
    const rels = new Set(sources.map((f) => f.rel))
    expect(rels.has('src/app.tsx')).toBe(true)
    expect(rels.has('src/styles/index.css')).toBe(true)
    expect(rels.has('e2e/smoke.e2e.ts')).toBe(true)
    expect(sources.length).toBeGreaterThan(40)
    // The token parse read the real `@theme inline` block, not an empty set that would flag
    // every colour class (loud, but for the wrong reason).
    expect(KNOWN_COLORS.has('foreground')).toBe(true)
    expect(KNOWN_COLORS.has('conflict')).toBe(true)
  })

  for (const rule of RULES) {
    it(`${rule.name}: ${rule.why}`, () => {
      expect(scan(rule, sources), `${rule.name} — ${rule.why}`).toEqual([])
    })
  }

  describe('rule verdicts on fixtures (guard: pass before and after a scan() change)', () => {
    it('covers every rule', () => {
      expect(new Set(VERDICTS.map((v) => v.rule))).toEqual(new Set(RULES.map((r) => r.name)))
    })
    for (const verdict of VERDICTS) {
      it(`${verdict.rule} flags its fixtures and passes the legal spellings`, () => {
        const rule = ruleNamed(verdict.rule)
        for (const file of verdict.flag) expect(scan(rule, [file]), `${file.rel}: ${file.lines.join(' / ')}`).toHaveLength(1)
        for (const file of verdict.pass) expect(scan(rule, [file]), `${file.rel}: ${file.lines.join(' / ')}`).toEqual([])
      })
    }
  })
})
