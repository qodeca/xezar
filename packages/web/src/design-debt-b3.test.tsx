import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { ProjectListEntry, WorkspaceConfigResponse } from '@qodeca/xezar-api-client'
import { AppearanceProvider, useAppearance } from '@/components/appearance-provider'
import { resetToasts } from '@/components/ui/toaster'
import { AppearanceSection } from '@/routes/settings/appearance'
import { RemoveProjectDialog } from '@/routes/settings/remove-project'
import { ResourcesSection } from '@/routes/settings/resources-section'

/**
 * Design-debt batch B3 — Settings (#453, AC-3 / T-3). The class and copy contracts, the save
 * contracts and the confirmation behaviour, in jsdom. jsdom has no layout: the 44 px / 24 px
 * geometry at every density is measured in `packages/web/e2e/design-debt-b3.e2e.ts`.
 */

const SETTINGS = join(import.meta.dirname, 'routes/settings')
const sources = readdirSync(SETTINGS)
  .filter((name) => name.endsWith('.tsx') && !name.includes('.test.'))
  .map((name) => ({ name, text: readFileSync(join(SETTINGS, name), 'utf8') }))
const source = (name: string) => sources.find((file) => file.name === name)!.text

const theme = vi.hoisted(() => ({ theme: 'system', setTheme: () => {} }))
vi.mock('@/components/theme-provider', () => ({ useTheme: () => theme }))

function found<T extends Element>(selector: string) {
  return waitFor(() => {
    const element = document.querySelector<T>(selector)
    expect(element, selector).not.toBeNull()
    return element!
  })
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.documentElement.removeAttribute('data-density')
})

describe('G-13 one settings field chassis', () => {
  it.each(['appearance.tsx', 'prompt-templates-section.tsx', 'agents-section.tsx'])(
    '%s renders through SettingsField and declares no private Field',
    (name) => {
      expect(source(name)).not.toMatch(/function Field\(/)
      expect(source(name)).toContain("import { SettingsField } from './settings-field'")
      expect(source(name)).toContain('<SettingsField')
    },
  )
})

describe('G-11 native settings controls share the field class', () => {
  it('no settings source hand-types the raw field look any more', () => {
    const copies = sources.filter((file) => /border border-input bg-card/.test(file.text)).map((file) => file.name)
    expect(copies).toEqual([])
  })

  it.each([
    ['resources-section.tsx', 13],
    ['agents-section.tsx', 6],
    ['projects-section.tsx', 3],
    ['add-account-dialog.tsx', 3],
    ['accounts-section.tsx', 2],
    ['worktrees-section.tsx', 1],
  ] as const)('%s wears nativeFieldClass on every native field (%i)', (name, count) => {
    expect(source(name).match(/nativeFieldClass[,}]/g)?.length ?? 0).toBe(count)
  })
})

describe('A-01 appearance controls', () => {
  function renderAppearance() {
    const client = createQueryClient()
    vi.stubGlobal('fetch', vi.fn(async () => new Promise<never>(() => {})))
    render(
      <QueryClientProvider client={client}>
        <AppearanceProvider>
          <AppearanceSection />
        </AppearanceProvider>
      </QueryClientProvider>,
    )
  }

  it('every segment of all four groups carries the phone floor and a visible focus ring', () => {
    renderAppearance()
    const groups = screen.getAllByRole('radiogroup')
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Theme', 'Accent', 'Density', 'Reading width'])
    const segments = screen.getAllByRole('radio')
    expect(segments).toHaveLength(11)
    for (const segment of segments) {
      for (const token of ['min-h-tap', 'min-w-tap', 'md:min-h-0', 'md:min-w-0', 'focus-visible:ring-[3px]', 'outline-none']) {
        expect(segment.className.split(' '), `${segment.textContent}: ${token}`).toContain(token)
      }
    }
  })

  it('says where accent, density and width are stored: per person, not per repo', () => {
    renderAppearance()
    expect(screen.queryByText(/this repo/i)).toBeNull()
    expect(screen.getByText('The primary action color. Saved for you on this computer and used in every project.')).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Theme', 'Accent', 'Density', 'Reading width'])
  })
})

describe('T-3 refused appearance saves', () => {
  function Probe() {
    const { density, setDensity } = useAppearance()
    return (
      <>
        <output data-testid="density">{density}</output>
        <button onClick={() => setDensity('compact')}>compact</button>
        <button onClick={() => setDensity('ultra')}>ultra</button>
      </>
    )
  }

  it('two rapid refused saves restore the last CONFIRMED density, not the first optimistic click', async () => {
    const client = createQueryClient()
    client.setQueryData(workspaceQueryKeys.uiState, { appearance: { accent: 'lime', density: 'roomy', width: 'narrow' } })
    let release: () => void = () => {}
    const gate = new Promise<void>((done) => { release = done })
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        await gate
        return json({ error: 'Appearance save refused' }, 409)
      }
      return json({ appearance: { accent: 'lime', density: 'roomy', width: 'narrow' } })
    }))
    render(
      <QueryClientProvider client={client}>
        <AppearanceProvider><Probe /></AppearanceProvider>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('density').textContent).toBe('roomy'))
    fireEvent.click(screen.getByText('compact'))
    fireEvent.click(screen.getByText('ultra'))
    expect(screen.getByTestId('density').textContent).toBe('ultra')
    await act(async () => { release(); await gate })
    await waitFor(() => expect(screen.getByTestId('density').textContent).toBe('roomy'))
    expect(document.documentElement.dataset.density).toBe('roomy')
    expect(localStorage.getItem('xez-density')).toBe('roomy')
  })
})

describe('G-22 save contracts stay mixed on purpose', () => {
  function renderResources() {
    const requests: Array<{ method: string; body?: unknown }> = []
    const state = {
      agentDefaults: {}, browseRoot: '~/', projectsDir: '~/p', skillsAutoUpdate: null, effectiveSkillsAutoUpdate: true,
      followups: null, effectiveFollowups: false, agentEnvPassthrough: null, effectiveAgentEnvPassthrough: [],
      composerDefaults: { autonomous: null, worktree: null, inheritedAutonomous: 'source-dependent', inheritedWorktree: true },
      resources: { maxParallel: 2, maxMonitoringSessions: 2, monitoringWakeIntervalMinutes: null, idleTimeoutMinutes: 15, memoryLimitDefaultMb: 4096, autoResumeOnUsageLimit: true, memoryLimitMb: null, worktreeRetentionDefault: 10, gateSlots: 1 },
    } as WorkspaceConfigResponse
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method !== 'GET') requests.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return json(state)
    }))
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter><ResourcesSection /></MemoryRouter>
      </QueryClientProvider>,
    )
    return requests
  }

  it('a select writes on change', async () => {
    const requests = renderResources()
    const select = await found<HTMLSelectElement>('[data-slot="resources-max-parallel"]')
    fireEvent.change(select, { target: { value: '4' } })
    await waitFor(() => expect(requests).toEqual([{ method: 'PUT', body: { resources: { maxParallel: 4 } } }]))
  })

  it('a number field writes nothing until Save, then exactly once', async () => {
    const requests = renderResources()
    const input = await found<HTMLInputElement>('[data-slot="resources-memory-limit"]')
    fireEvent.change(input, { target: { value: '2048' } })
    fireEvent.blur(input)
    fireEvent.keyDown(input, { key: 'Tab' })
    await new Promise((done) => setTimeout(done, 50))
    expect(requests).toEqual([])
    fireEvent.click(document.querySelector('[data-action="resources-save-memory"]')!)
    await waitFor(() => expect(requests).toEqual([{ method: 'PUT', body: { resources: { memoryLimitMb: 2048 } } }]))
  })
})

describe('G-10 irreversible and destructive confirmations', () => {
  const project: ProjectListEntry = {
    id: 'second', name: 'Second', root: '/tmp/second', status: 'ok', addedAt: '2026-09-16T00:00:00.000Z', lastOpenedAt: '2026-09-16T00:00:00.000Z', source: 'local',
  }

  function Harness({ onConfirm }: { onConfirm: () => void }) {
    const [open, setOpen] = useState<ProjectListEntry | null>(null)
    return (
      <>
        <button data-action="opener" onClick={() => setOpen(project)}>Remove Second</button>
        <RemoveProjectDialog project={open} onOpenChange={(next) => !next && setOpen(null)} onConfirm={onConfirm} />
      </>
    )
  }

  it('the confirm wears the shared danger variant and the cancel says "Keep it"', () => {
    render(<Harness onConfirm={() => {}} />)
    fireEvent.click(screen.getByText('Remove Second'))
    const confirm = document.querySelector('[data-action="projects-confirm-remove"]')!
    expect(confirm.className).toContain('bg-danger')
    expect(confirm.className).toContain('text-danger-foreground')
    expect(confirm.className).not.toContain('bg-contrast')
    expect(screen.getByRole('button', { name: 'Keep it' })).toBeTruthy()
  })

  it('cancel writes nothing and hands keyboard focus back to the opener', async () => {
    const onConfirm = vi.fn()
    render(<Harness onConfirm={onConfirm} />)
    const opener = screen.getByText('Remove Second')
    opener.focus()
    fireEvent.click(opener)
    await waitFor(() => expect(document.querySelector('[data-slot="alert-dialog-content"]')!.contains(document.activeElement)).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    await waitFor(() => expect(document.querySelector('[data-slot="alert-dialog-content"]')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it.each([
    ['remove-project.tsx', /className=\{buttonVariants\(\{ variant: 'danger' \}\)\}/],
    ['worktrees-panel.tsx', /buttonVariants\(\{ variant: 'danger' \}\)/],
    ['accounts-section.tsx', /buttonVariants\(\{ variant: 'danger' \}\)/],
  ])('%s uses the danger variant, never a copied danger string', (name, pattern) => {
    expect(source(name)).toMatch(pattern)
    expect(source(name)).not.toContain('bg-danger text-danger-foreground hover:brightness-[0.96]')
    expect(source(name)).toContain('onCloseAutoFocus={returnFocus}')
  })

  it('the per-row worktree delete is a danger-ghost action', () => {
    expect(source('worktrees-panel.tsx')).toMatch(/variant="danger-ghost"\s+size="sm"\s+data-action="worktree-delete"/)
  })
})

describe('G-04 danger text and G-03 settings chips', () => {
  it('agent config uses the danger token, not the destructive alias', () => {
    expect(source('agent-config-section.tsx')).not.toMatch(/(text|border|bg)-destructive/)
    expect(source('agent-config-section.tsx')).toContain('text-danger')
  })

  it('the template skills chip follows the chip contract and the phone floor', () => {
    const text = source('prompt-templates-section.tsx')
    expect(text).not.toContain('h-[26px]')
    expect(text).not.toContain('disabled:opacity-50')
    expect(text).toMatch(/'inline-flex h-7 min-h-tap [^']*disabled:opacity-55 md:min-h-chip'/)
    expect(text).toMatch(/data-slot="prompt-template-skill-chip"[\s\S]*?min-h-tap min-w-tap[\s\S]*?md:min-h-chip md:min-w-0/)
  })

  it('the agent config editor height is on the spacing scale', () => {
    expect(source('agent-config-section.tsx')).not.toContain('h-[26rem]')
    expect(source('agent-config-section.tsx')).toContain('className="h-104"')
  })
})

describe('G-15 settings copy', () => {
  it('load errors say "Could not load …", retries say "Retry", lists say "Filter" and "Nothing matches."', () => {
    const all = sources.map((file) => file.text).join('\n')
    expect(all).not.toMatch(/did not load/)
    expect(all).not.toMatch(/>\s*Try again\s*</)
    expect(all).not.toContain('search skills…')
    expect(all).not.toContain('(no skills match)')
    expect(source('prompt-templates-section.tsx')).toContain('placeholder="Filter skills…"')
  })

  it('uses the em dash, curly apostrophes and no Oxford comma in the listed sites', () => {
    expect(source('mcp-api-section.tsx')).not.toContain('–')
    expect(source('appearance.tsx')).not.toMatch(/[a-z]'s\b/)
    expect(source('project-general.tsx')).not.toContain("project's")
    expect(source('notifications-section.tsx')).not.toContain('review, or fails')
    expect(source('agents-section.tsx')).not.toContain('one per line: owner/name, a git URL, or a local path')
  })
})
