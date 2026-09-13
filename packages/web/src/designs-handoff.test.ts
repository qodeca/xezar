// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Designs handoff lint — keeps every `designs/<feature>/` folder in the shape
 * `designs/README.md` and `docs/design-system/new-designs.md` promise, so a developer opening a
 * handoff finds the same sections in the same order every time and a mockup never drifts off the
 * shared stylesheet. A static scan, like design-system-drift.test.ts (no DOM, no network).
 *
 * Per design folder (any directory under `designs/` that holds at least one `*.html`):
 *  1. every `*.html` links `../../docs/design-system/cockpit.css`, and that link comes before any
 *     other `<link rel="stylesheet">` — the feature's own `styles.css` may only refine the cockpit
 *     rules, never precede them;
 *  2. `index.html` exists (the entry point `designs/README.md` tells a reader to start with);
 *  3. `README.md` carries every required handoff section as a `## [n.] <name>` heading;
 *  4. `designs/README.md` names the folder, as `` `<folder>/` `` or as a table row linking it.
 *
 * A folder with no `*.html` is skipped: it is not a design yet (or is a shared asset dir).
 */

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(WEB_ROOT, '..', '..')
const DESIGNS_ROOT = path.join(REPO_ROOT, 'designs')
const COCKPIT_CSS_HREF = 'href="../../docs/design-system/cockpit.css"'

/** The handoff sections a developer relies on, in the order designs/README.md lists them. A
 *  heading matches as `## <name>` or `## <n>. <name>`, case-insensitive, and the name may be
 *  followed by more words (`## 3. Users and jobs` satisfies `Users`). */
const REQUIRED_SECTIONS = [
  'Summary',
  'Problem evidence',
  'Users',
  'Goals',
  'Screens',
  'States',
  'Copy deck',
  'Developer notes',
  'Accessibility',
  'Responsive',
  'Acceptance criteria',
  'Open decisions',
  'Risks',
  'References',
  'Design review',
] as const

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasHeading(markdown: string, name: string): boolean {
  return new RegExp(`^## \\d*\\.?\\s*${escapeRegExp(name)}`, 'im').test(markdown)
}

interface DesignFolder {
  name: string
  dir: string
  htmlFiles: string[]
}

function designFolders(): DesignFolder[] {
  if (!existsSync(DESIGNS_ROOT)) return []
  const out: DesignFolder[] = []
  for (const entry of readdirSync(DESIGNS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(DESIGNS_ROOT, entry.name)
    const htmlFiles = readdirSync(dir)
      .filter((f) => f.endsWith('.html'))
      .sort()
    if (htmlFiles.length === 0) continue
    out.push({ name: entry.name, dir, htmlFiles })
  }
  return out
}

const folders = designFolders()

describe('designs handoff', () => {
  it('finds the designs folder and at least one design (guards against a broken walker)', () => {
    expect(existsSync(DESIGNS_ROOT)).toBe(true)
    expect(existsSync(path.join(DESIGNS_ROOT, 'README.md'))).toBe(true)
    expect(folders.map((f) => f.name)).toContain('quality-checks')
  })

  for (const folder of folders) {
    describe(`designs/${folder.name}`, () => {
      it('every page links the shared cockpit stylesheet before any other stylesheet', () => {
        const problems: string[] = []
        for (const file of folder.htmlFiles) {
          const html = readFileSync(path.join(folder.dir, file), 'utf8')
          const cockpitAt = html.indexOf(COCKPIT_CSS_HREF)
          if (cockpitAt === -1) {
            problems.push(`${file}: no ${COCKPIT_CSS_HREF} link`)
            continue
          }
          const firstStylesheet = html.search(/<link\b[^>]*\brel=["']stylesheet["']/i)
          const firstStylesheetEnd = html.indexOf('>', firstStylesheet)
          if (firstStylesheet === -1 || cockpitAt < firstStylesheet || cockpitAt > firstStylesheetEnd) {
            problems.push(`${file}: cockpit.css is not the first <link rel="stylesheet">`)
          }
        }
        expect(problems).toEqual([])
      })

      it('has an index.html entry point', () => {
        expect(folder.htmlFiles).toContain('index.html')
      })

      it('README.md carries every required handoff section', () => {
        const readmePath = path.join(folder.dir, 'README.md')
        expect(existsSync(readmePath), `designs/${folder.name}/README.md is missing`).toBe(true)
        const readme = readFileSync(readmePath, 'utf8')
        const missing = REQUIRED_SECTIONS.filter((name) => !hasHeading(readme, name))
        expect(missing, `designs/${folder.name}/README.md lacks a "## <name>" heading for`).toEqual([])
      })

      it('is listed in designs/README.md', () => {
        const index = readFileSync(path.join(DESIGNS_ROOT, 'README.md'), 'utf8')
        const named =
          index.includes(`\`${folder.name}/\``) ||
          new RegExp(`^\\|[^\\n]*\\b${escapeRegExp(folder.name)}\\b[^\\n]*\\|`, 'm').test(index)
        expect(named, `designs/README.md does not name ${folder.name}`).toBe(true)
      })
    })
  }
})
