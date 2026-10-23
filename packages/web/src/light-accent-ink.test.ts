import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * G-23, the lime-as-ink half: the accent (`--primary`, lime by default, violet by choice) is about
 * 1.3:1 / 3.1:1 on the light theme's white, so it may colour TEXT or a STATE MARK there only with
 * a light-theme ink override (`light:text-foreground`, the `@custom-variant` in index.css). The
 * dark theme keeps the accent as designed.
 *
 * Every `text-primary` in shipped sources is either overridden or listed below as decorative: an
 * `aria-hidden` icon beside text that already says the same thing, or a tinted icon tile whose
 * title and copy carry the meaning. A new site must take one side or the other on purpose.
 */

const SRC = path.dirname(fileURLToPath(import.meta.url))

/** Decorative accent icons, accepted in light at their designed colour (file → count). */
const DECORATIVE: Record<string, number> = {
  'components/centered-state.tsx': 1, // hero icon tile, `aria-hidden` backdrop tone
  'routes/settings/mcp-connection-state.tsx': 1, // state icon tile, "decorative only" per its own doc
  'components/skills-import-panel.tsx': 1, // icon before the sentence it decorates
  'routes/skills.tsx': 2, // Download / Zap icons beside their labels
  'routes/settings/bookmarklets-section.tsx': 1, // Zap icon beside its label
  'routes/settings/mcp-connection-section.tsx': 1, // ShieldCheck before the sentence it decorates
  'routes/workflows/workflows.tsx': 2, // Sparkles icons beside skill names
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [full] : []
  })
}

/** `text-primary` as a whole class (not `text-primary-foreground`), and whether the same class
 *  string also carries the light-theme ink. */
function accentInk(source: string): { overridden: number; bare: number } {
  let overridden = 0
  let bare = 0
  // Comments quote class names when they explain a choice; only code counts.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
  for (const match of code.matchAll(/(['"`])([^'"`]*?)\1/g)) {
    const classes = match[2]!.split(/\s+/)
    if (!classes.includes('text-primary')) continue
    if (classes.includes('light:text-foreground')) overridden += 1
    else bare += 1
  }
  return { overridden, bare }
}

describe('accent as ink in the light theme (G-23)', () => {
  it('index.css defines the light variant the overrides use', () => {
    const css = readFileSync(path.join(SRC, 'styles', 'index.css'), 'utf8')
    expect(css).toContain('@custom-variant light (&:where(.light, .light *));')
  })

  it('every text-primary is overridden for light, or listed as decorative', () => {
    const offenders: string[] = []
    const seenDecorative: Record<string, number> = {}
    for (const file of sources(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/')
      const { bare } = accentInk(readFileSync(file, 'utf8'))
      if (bare === 0) continue
      seenDecorative[rel] = bare
      if (bare !== DECORATIVE[rel]) offenders.push(`${rel}: ${bare} bare text-primary (allowed ${DECORATIVE[rel] ?? 0})`)
    }
    expect(offenders).toEqual([])
    // A listed site that no longer needs its allowance must drop it.
    expect(seenDecorative).toEqual(DECORATIVE)
  })

  it('the selection check marks and the Workflows drop hint take the ink', () => {
    const read = (rel: string) => accentInk(readFileSync(path.join(SRC, rel), 'utf8')).overridden
    expect(read('routes/new-task.tsx')).toBe(7)
    expect(read('components/command-palette.tsx')).toBe(1)
    expect(read('routes/workflows/workflows.tsx')).toBe(1)
    expect(read('routes/task-thread/mcp-operation-feedback.tsx')).toBe(1)
  })
})
