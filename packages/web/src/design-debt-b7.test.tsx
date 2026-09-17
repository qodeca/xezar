import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodeEditor } from '@/components/code-editor'
import { ProviderBanner } from '@/components/provider-banner'
import { SkillDetailBody } from '@/components/skill-detail'
import type { Skill } from '@qodeca/xezar-api-client'

import spacingAllowlist from './design-guardian-spacing-allowlist.json'

/**
 * Design-debt batch B7 — the remaining routes and feature panels (#453, AC-7 / T-7, and #447 OD-1:
 * GitHub, Compare and Automations on the #424 rhythm). The rendered STATE cases live beside their
 * routes (`github.test.tsx`, `automations.test.tsx`, `workflows.test.tsx`, `skills.test.tsx`,
 * `new-task.test.tsx`); this file pins the batch-wide contracts in jsdom: no hand-typed spacing,
 * the shrunken allowlist, guarded motion, the page rhythm, the danger confirms, honest clipboard
 * and the copy rules. jsdom has no layout: the 44 px geometry at every density, the shared gutter
 * and composited contrast are measured in `packages/web/e2e/design-debt-b7.e2e.ts`.
 */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const SRC = resolve(import.meta.dirname)
const source = (rel: string) => readFileSync(join(SRC, rel), 'utf8')
/** The source with comment-only lines dropped, so a comment quoting an old spelling is not a hit. */
const code = (rel: string) =>
  source(rel)
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
    .join('\n')
const classes = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/)

/** Every source file § B7 owns. */
const B7_FILES = [
  'routes/automations/automations.tsx',
  'components/code-editor.tsx',
  'routes/compare-loading.tsx',
  'routes/compare-variants.tsx',
  'routes/github/github.tsx',
  'routes/github/hand-to-agent.tsx',
  'routes/inbox.tsx',
  'routes/new-task.tsx',
  'routes/not-found.tsx',
  'routes/plan-review.tsx',
  'components/provider-banner.tsx',
  'components/skill-detail.tsx',
  'components/skills-import-panel.tsx',
  'routes/skills-loading.tsx',
  'routes/skills.tsx',
  'routes/unknown-project.tsx',
  'routes/workflows/workflows.tsx',
]

describe('C1 / AC-7 spacing lives on the scale', () => {
  it('no B7 file spells a hand-typed spacing length (the guardian’s own pattern)', () => {
    const pattern =
      /(?<![\w-])(?:[a-z]+:)*-?(?:p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y|h|min-h|size|top|-top)-\[\d+(?:\.\d+)?(?:px|rem|em)\]/g
    const offenders = B7_FILES.flatMap((rel) => [...code(rel).matchAll(pattern)].map((m) => `${rel}: ${m[0]}`))
    expect(offenders).toEqual([])
  })

  it('the allowlist is down to the two 24 px chip floors, each with its reason (#445)', () => {
    const rows = Object.entries(spacingAllowlist as Record<string, { count: number; reason: string }>)
    expect(rows.map(([key]) => key).sort()).toEqual([
      'src/components/picker-pill.tsx|min-h-[24px]',
      'src/components/reference-chip.tsx|min-h-[24px]',
    ])
    for (const [, row] of rows) expect(row.reason).toMatch(/WCAG 2\.2 SC 2\.5\.8 floor/)
    expect(rows.some(([key]) => B7_FILES.some((rel) => key.startsWith(`src/${rel}|`)))).toBe(false)
  })
})

describe('C2 / T-7 motion is guarded', () => {
  it('no bare spin or pulse, and no chevron turns under reduced motion', () => {
    const offenders = B7_FILES.flatMap((rel) =>
      [...code(rel).matchAll(/(?<![\w:-])(?:animate-spin|animate-pulse|transition-transform)\b/g)].map((m) => `${rel}: ${m[0]}`),
    )
    expect(offenders).toEqual([])
  })
})

describe('C3 / OD-1 GitHub, Compare and Automations on the #424 rhythm', () => {
  it('GitHub: the Git page’s header spacing and the canonical title', () => {
    const github = code('routes/github/github.tsx')
    expect(github).toMatch(/data-slot="gh-header" className="[^"]*\bpx-4 pt-stack md:px-section md:pt-group\b/)
    expect(github).toMatch(/<h1 className="sr-only text-base font-semibold md:not-sr-only">GitHub<\/h1>/)
    expect(github).toMatch(/data-slot="gh-detail-inner" className="min-w-0 p-4 md:p-section"/)
  })

  it('Compare and Automations use the shared PageHeader over the canonical page body', () => {
    for (const rel of ['routes/compare-variants.tsx', 'routes/automations/automations.tsx']) {
      const text = code(rel)
      expect(text, rel).toMatch(/import \{ CenteredState, PageHeader \} from '@\/components\/centered-state'/)
      expect(text, rel).toMatch(/<PageHeader title=\{title\}/)
      expect(text, rel).toMatch(/p-4 pb-\[calc\(90px\+env\(safe-area-inset-bottom\)\)\] md:p-section md:pb-section/)
    }
  })

  it('no B7 page keeps a retired header or gutter spelling', () => {
    const retired = /(?<![\w:-])(?:md:px-6|md:px-7|md:py-5|backdrop-blur|bg-background\/95|rounded-xl|text-2xl font-semibold">\{title)(?![\w-])/g
    const offenders = B7_FILES.flatMap((rel) => [...code(rel).matchAll(retired)].map((m) => `${rel}: ${m[0]}`))
    expect(offenders).toEqual([])
  })
})

describe('C4 / G-10 irreversible confirms wear the danger button', () => {
  it('the workflow overwrite and delete confirms use the danger variant, never a copied string', () => {
    const workflows = code('routes/workflows/workflows.tsx')
    const actions = [...workflows.matchAll(/<AlertDialogAction[\s\S]*?>/g)].map((m) => m[0])
    expect(actions).toHaveLength(2)
    for (const action of actions) expect(action).toContain("className={buttonVariants({ variant: 'danger' })}")
    expect(workflows).not.toContain('hover:brightness-[0.96]')
    expect(workflows).not.toContain('Keep the file')
  })
})

describe('C5 honest clipboard and copy rules', () => {
  it('B7 copies only through the shared helper', () => {
    expect(B7_FILES.filter((rel) => /navigator\.clipboard/.test(code(rel)))).toEqual([])
  })

  it('house copy: “Could not”, curly quotes, “Nothing matches.”, the danger ink', () => {
    const minority = /Couldn’t|Couldn't|&ldquo;|&rdquo;|&apos;|\(no skills match\)|No skills match\.|text-destructive|bg-destructive|size-\[9px\]|Team skills refreshed\./g
    const offenders = B7_FILES.flatMap((rel) => [...code(rel).matchAll(minority)].map((m) => `${rel}: ${m[0]}`))
    expect(offenders).toEqual([])
  })

  it('the hand-off pickers’ search placeholders are sentence case (G-15)', () => {
    const hand = code('routes/github/hand-to-agent.tsx')
    expect(hand).toContain('placeholder="Search workflows…"')
    expect(hand).toContain('placeholder="Search skills…"')
  })
})

describe('C6 rendered targets and focus', () => {
  const INCIDENT = {
    providers: [
      { provider: 'claude' as const, status: 'disconnected' as const, enabled: true, authFailureId: 'claude-1' },
      { provider: 'codex' as const, status: 'connected' as const, enabled: true },
    ],
  }

  it('the provider banner: danger tint, a phone-sized link and dismiss, the cockpit focus ring', () => {
    render(
      <MemoryRouter>
        <ProviderBanner status={INCIDENT} pending={false} error={false} dismissals={{}} onDismissAuthFailures={vi.fn()} />
      </MemoryRouter>,
    )
    const banner = document.querySelector('[data-slot="provider-banner"]')
    expect(classes(banner)).toEqual(expect.arrayContaining(['bg-danger/10', 'px-4', 'md:px-section']))
    for (const target of [screen.getByRole('link', { name: 'Open agent settings' }), screen.getByRole('button', { name: 'Dismiss provider authentication alert' })]) {
      expect(classes(target)).toEqual(expect.arrayContaining(['min-h-tap', 'md:min-h-0', 'focus-visible:ring-[3px]', 'focus-visible:ring-ring/50']))
    }
    expect(classes(screen.getByRole('button', { name: 'Dismiss provider authentication alert' }))).toContain('min-w-tap')
  })

  it('the code editor’s frame shows keyboard focus for its transparent textarea', () => {
    render(<CodeEditor value={'{}'} language="json" aria-label="Settings file" />)
    const frame = document.querySelector('[data-slot="code-editor"]')
    expect(classes(frame)).toEqual(expect.arrayContaining(['focus-within:border-ring', 'focus-within:ring-[3px]', 'focus-within:ring-ring/50']))
    expect(screen.getByRole('textbox', { name: 'Settings file' })).toBeTruthy()
  })

  it('the skill detail sits on the rhythm', () => {
    const skill = { name: 'xez-fix', path: '.xezar/skills/xez-fix.md', source: 'project', description: 'Fix things.', body: '# Fix' } as Skill
    render(
      <MemoryRouter>
        <SkillDetailBody skill={skill} usedBy={[]} />
      </MemoryRouter>,
    )
    expect(classes(document.querySelector('[data-slot="skill-description"]'))).toContain('mt-stack')
    expect(classes(document.querySelector('[data-slot="skill-used-by"]'))).toContain('mt-group')
  })
})
