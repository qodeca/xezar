import { describe, expect, it } from 'vitest'

import {
  canonicalLang,
  ensureLang,
  highlight,
  highlightSync,
  isPlainLang,
  langForPath,
  resetHighlighterForTests,
  supportedLanguages,
} from './highlighter'

/**
 * The Shiki singleton, exercised for real: the JS regex engine is pure JS, so jsdom runs the
 * actual highlighter — no stubbing. The first `highlight` call cold-boots the core through the
 * same dynamic imports the browser uses.
 *
 * Every test that asserts FULL tokenization passes `tokenizeTimeLimit: 0`: Shiki's per-line
 * budget is wall-clock (default 500ms), and under full-suite parallelism the cold TS grammar's
 * lazy regex compilation can exceed it on a contended CPU — Shiki then stops mid-line and the
 * tail comes back plain, failing the color assertions on a machine-load coin flip. Disabling
 * the budget makes deterministic input → deterministic output; the app path keeps the default
 * on purpose (degrading a pathological line beats wedging the main thread).
 */
const NO_BUDGET = { tokenizeTimeLimit: 0 }

describe('highlighter singleton', () => {
  it('maps fence aliases onto the grammar allowlist, and unknown infos onto null', () => {
    expect(canonicalLang('ts')).toBe('typescript')
    expect(canonicalLang('TS')).toBe('typescript')
    expect(canonicalLang('bash')).toBe('shellscript')
    expect(canonicalLang('sh')).toBe('shellscript')
    expect(canonicalLang('python')).toBe('python')
    expect(canonicalLang('toml')).toBe('toml') // agent config files (Codex config.toml)
    expect(canonicalLang('wat-is-this')).toBeNull()
    expect(isPlainLang('')).toBe(true)
    expect(isPlainLang('plaintext')).toBe(true)
    expect(isPlainLang('ts')).toBe(false)
  })

  it('answers unknown fence languages synchronously with plaintext — never a crash', () => {
    const result = highlightSync('hello <world>', 'not-a-language')
    expect(result).toEqual({
      tokens: [[{ content: 'hello <world>' }]],
      fg: 'var(--syn-var)',
      bg: 'transparent',
    })
  })

  it('highlights TypeScript through the CSS-variable theme — colors are var(--syn-*), never hex', async () => {
    const result = await highlight('const x = "hi" // note', 'ts', NO_BUDGET)
    const tokens = result.tokens[0]!
    const colors = new Set(tokens.map((t) => t.color))
    expect(colors.has('var(--syn-key)')).toBe(true) // const
    expect(colors.has('var(--syn-str)')).toBe(true) // "hi"
    expect(colors.has('var(--syn-com)')).toBe(true) // the comment
    for (const color of colors) {
      expect(color).toMatch(/^var\(--syn-[a-z]+\)$/)
    }
    expect(result.bg).toBe('transparent')
  })

  it('is resident after the first load: the same language then highlights synchronously', async () => {
    await highlight('let a = 1', 'ts', NO_BUDGET)
    const sync = highlightSync('let b = 2', 'typescript', NO_BUDGET)
    expect(sync).not.toBeNull()
    expect(sync!.tokens[0]!.some((t) => t.color === 'var(--syn-key)')).toBe(true)
  })

  it('multi-line code keeps its line structure (heights are predictable pre-highlight)', async () => {
    const result = await highlight('const a = 1\nconst b = 2\n', 'ts', NO_BUDGET)
    expect(result.tokens).toHaveLength(3) // two lines + the trailing empty one
  })

  it('an exhausted per-line budget degrades to plain tokens — the valve reaches the engine', async () => {
    // A negative budget is already exceeded at the tokenizer's first wall-clock check
    // (vscode-textmate: `elapsedTime > timeLimit` with elapsed 0), so the line comes back
    // untokenized — deterministically, without actually burning 500ms. This is exactly what a
    // contended CPU does to real code, proven here so the degrade path is a fact, not a guess.
    const result = await highlight('const x = 1', 'ts', { tokenizeTimeLimit: -1 })
    const colors = new Set(result.tokens[0]!.map((t) => t.color))
    expect(colors.has('var(--syn-key)')).toBe(false) // `const` lost its keyword scope — plain
  })

  it('names every supported spelling exactly once each', () => {
    const langs = supportedLanguages()
    expect(langs).toContain('ts')
    expect(langs).toContain('typescript')
    expect(langs).toContain('plaintext')
    expect(new Set(langs).size).toBe(langs.length)
  })
})

describe('langForPath (R5 — diff tokens and the Files preview share this)', () => {
  it.each([
    ['src/app.ts', 'typescript'],
    ['src/app.TSX', 'tsx'],
    ['scripts/dev.mjs', 'javascript'],
    ['packages/web/src/api/ws.tsx', 'tsx'],
    ['vitest.config.mts', 'typescript'],
    ['legacy/thing.cts', 'typescript'],
    ['public/index.htm', 'html'],
    ['public/index.html', 'html'],
    ['.xezar/config.json', 'json'],
    ['AGENTS.md', 'markdown'],
    ['Cargo.toml', 'toml'],
    ['scripts/e2e.sh', 'shellscript'],
  ])('%s → %s', (path, lang) => {
    expect(langForPath(path)).toBe(lang)
  })

  it.each([
    // No extension at all — a Makefile is not a grammar we carry.
    'Makefile',
    'scripts/test-env-up',
    // A dotfile is all extension and no name; `dot <= 0` is what stops `.gitignore` reading as
    // a "gitignore" grammar.
    '.gitignore',
    '.env.example.unknownext',
    // A directory in the path may carry a dot without the file doing so.
    'some.dir/README',
    // A real extension we deliberately do not ship a grammar for.
    'assets/logo.svg',
    'notes.docx',
  ])('has no grammar for %s', (path) => {
    expect(langForPath(path)).toBeNull()
  })

  it('reads the extension off the basename, not the whole path', () => {
    expect(langForPath('/a.py/b.ts')).toBe('typescript')
  })
})

describe('plain languages never touch Shiki', () => {
  it.each(['', 'plaintext', 'text', 'txt', 'plain', '  TXT  '])(
    'answers %j synchronously with one plain token per line',
    (lang) => {
      expect(highlightSync('a\nb', lang)).toEqual({
        tokens: [[{ content: 'a' }], [{ content: 'b' }]],
        fg: 'var(--syn-var)',
        bg: 'transparent',
      })
    },
  )

  it('loads no grammar for a language it does not carry', async () => {
    // Resolves rather than rejects: an unknown fence info costs highlighting, never a crash.
    await expect(ensureLang('brainfuck')).resolves.toBeUndefined()
    await expect(ensureLang('plaintext')).resolves.toBeUndefined()
  })

  it('highlight() returns plaintext for an unknown fence without awaiting a load', async () => {
    await expect(highlight('x = 1', 'not-a-language')).resolves.toEqual({
      tokens: [[{ content: 'x = 1' }]],
      fg: 'var(--syn-var)',
      bg: 'transparent',
    })
  })
})

/**
 * The allowlist is 17 hand-written `import('@shikijs/langs/<id>')` arrows, and `ensureLang`
 * SWALLOWS a failed load by design (an unfetchable grammar means plaintext, not a crash). Those
 * two together mean a renamed or dropped grammar export degrades every fence of that language to
 * plaintext forever, silently, with no error anywhere. Loading each one for real is the only
 * thing that catches it.
 */
describe('every allowlisted grammar actually loads', () => {
  /** One line per grammar that is guaranteed to carry at least one non-plain scope. */
  const SAMPLES: Record<string, string> = {
    typescript: 'const x: number = 1',
    tsx: 'const A = () => <b>hi</b>',
    javascript: 'const x = 1',
    jsx: 'const A = () => <b>hi</b>',
    json: '{"a": 1}',
    jsonc: '{"a": 1} // note',
    shellscript: 'echo "hi" # note',
    python: 'x = "hi"  # note',
    markdown: '# Title',
    css: 'a { color: red; }',
    html: '<b>hi</b>',
    diff: '+added',
    yaml: 'a: 1',
    toml: 'a = 1',
    go: 'package main',
    rust: 'fn main() {}',
    sql: 'select 1',
  }

  it.each(Object.keys(SAMPLES))('%s', async (lang) => {
    await ensureLang(lang)

    // Non-null means the grammar is resident: `highlightSync` returns null for a language whose
    // grammar never loaded, which is exactly what a broken loader arrow leaves behind.
    const result = highlightSync(SAMPLES[lang]!, lang, NO_BUDGET)
    expect(result).not.toBeNull()
    // And it tokenized rather than handing back the line as one plain run.
    expect(result!.tokens[0]!.some((token) => token.color !== undefined)).toBe(true)
  })

  it('covers every id the allowlist advertises, so a new grammar cannot skip this', () => {
    // `supportedLanguages()` is canonical ids + aliases + plaintext spellings; the canonical ids
    // are the ones with a loader, and each needs a sample above.
    for (const id of Object.keys(SAMPLES)) expect(supportedLanguages()).toContain(id)
    expect(Object.keys(SAMPLES)).toHaveLength(17)
  })
})

/**
 * Kept last in the file: `resetHighlighterForTests` drops the module-level singleton every test
 * above shares, and vitest runs a file's tests in order. A reset in the middle would make the
 * "is resident after the first load" case depend on where it ran.
 */
describe('resetHighlighterForTests (the cold-boot seam)', () => {
  it('drops the resident core and grammars, and the next load rebuilds them', async () => {
    await highlight('let a = 1', 'ts', NO_BUDGET)
    expect(highlightSync('let b = 2', 'ts', NO_BUDGET)).not.toBeNull()

    resetHighlighterForTests()

    // Cold again: sync highlighting is unavailable until something loads the grammar back.
    expect(highlightSync('let c = 3', 'ts', NO_BUDGET)).toBeNull()
    // ...and the async path rebuilds core + grammar rather than staying broken.
    const result = await highlight('const d = 4', 'ts', NO_BUDGET)
    expect(result.tokens[0]!.some((t) => t.color === 'var(--syn-key)')).toBe(true)
    expect(highlightSync('let e = 5', 'ts', NO_BUDGET)).not.toBeNull()
  })

  it('leaves the pure lookups alone — they hold no state to reset', () => {
    resetHighlighterForTests()
    expect(canonicalLang('ts')).toBe('typescript')
    expect(langForPath('a.ts')).toBe('typescript')
    expect(supportedLanguages()).toContain('typescript')
  })
})
