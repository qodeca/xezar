import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { __clearRememberedStatusesForTests } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { AgentPickerRow } from '@/components/default-agent-picker'
import { DefaultAgentPicker } from '@/components/default-agent-picker'
import { TitleEditInput, type TitleEditor } from '@/components/editable-title'
import { FacetFilter, SegmentedControl, ToggleChip } from '@/components/facet-filter'
import { ListViewProvider } from '@/components/list-view'
import { PickerPill, chipClass } from '@/components/picker-pill'
import { PinToggle } from '@/components/pin-toggle'
import { PromptTemplateMenu } from '@/components/prompt-template-menu'
import { ReferenceChip } from '@/components/reference-chip'
import { TabLink } from '@/components/tab-link'
import { resetToasts } from '@/components/ui/toaster'
import { copyText } from '@/lib/clipboard-result'
import { TASK_COLUMNS, TASK_TD_CLASS, TASK_TH_CLASS } from '@/lib/task-columns'
import { formatBytes, formatMem, USAGE_CELL_CLASS } from '@/lib/tasks-table'
import type { ProjectListEntry, RunIndexEntry, RunRecord } from '@qodeca/xezar-api-client'
import { GlobalTasksRoute } from '@/routes/global-tasks'
import { formatFileSize } from '@/routes/task-git/worktree-files'
import { TasksOverview } from '@/routes/tasks-overview'
import { RUNNERS } from '@/routes/new-task-form'

/**
 * Design-debt batch B4 — task lists, pins, chips and pills (#453, AC-4 / T-4). The class and copy
 * contracts, row navigation versus nested controls, the clipboard helper and the byte formatter,
 * in jsdom. jsdom has no layout: the 44 px / 24 px geometry at every density is measured in
 * `packages/web/e2e/design-debt-b4.e2e.ts`.
 */

const classes = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/)
const PHONE_TARGET = ['min-h-tap', 'min-w-tap', 'md:min-h-0', 'md:min-w-0']

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
  __clearRememberedStatusesForTests()
})

/** jsdom has no `matchMedia`, which `useIsDesktop` reads as desktop; a phone must say so. */
function stubPhone() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

function LocationProbe() {
  const { pathname } = useLocation()
  return <output data-testid="location">{pathname}</output>
}
const location = () => screen.getByTestId('location').textContent

let seq = 0
function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'default',
    task: `task ${seq}`,
    status: 'done',
    createdAt: '2026-07-14T11:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

function inRouter(node: ReactNode) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/']}>
        <LocationProbe />
        <Routes>
          <Route path="/" element={node} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('A-03 pins and chips are 44 px phone targets, separate from the 24 px chip floor', () => {
  it('the pin is a 44 px box below md and on any device that cannot hover', () => {
    render(<PinToggle pinned={false} onToggle={() => {}} />)
    const pin = screen.getByRole('button', { name: 'Pin task' })
    for (const token of [...PHONE_TARGET, 'no-hover:min-h-tap', 'no-hover:min-w-tap', 'size-5']) {
      expect(classes(pin), token).toContain(token)
    }
  })

  it('the composer chip keeps its unprefixed 24 px floor and grows to 44 px below md', () => {
    const tokens = chipClass.split(' ')
    for (const token of ['h-7', 'min-h-[24px]', 'max-md:min-h-tap', 'max-md:min-w-tap', 'disabled:opacity-55', 'focus-visible:ring-[3px]']) {
      expect(tokens, token).toContain(token)
    }
    render(<PickerPill slot="model-pill" ariaLabel="Model" label="opus" value="opus" options={[{ value: 'opus', label: 'opus' }]} onPick={() => {}} />)
    expect(classes(screen.getByRole('button', { name: 'Model' }))).toEqual(expect.arrayContaining(tokens))
  })

  it('a link reference chip keeps its 24 px look and owns a 44 px phone hit area', () => {
    render(<ReferenceChip reference={{ kind: 'PR', number: 42, url: 'https://github.com/o/r/pull/42' }} taskTitle="t" />)
    const chip = screen.getByRole('link', { name: /pull request for t/ })
    for (const token of ['min-h-[24px]', 'relative', 'before:absolute', 'before:h-tap', 'before:min-w-tap', 'before:w-full', 'md:before:hidden']) {
      expect(classes(chip), token).toContain(token)
    }
  })

  it('an inert reference chip is not a target and gets no hit area', () => {
    render(<ReferenceChip reference={{ kind: 'Issue', number: 7 }} taskTitle="t" />)
    const chip = document.querySelector('[data-slot="issue-chip"]')
    expect(chip?.tagName).toBe('SPAN')
    expect(classes(chip)).not.toContain('before:h-tap')
  })
})

describe('G-03 filter chips and the template trigger follow the chip contract', () => {
  it('the facet trigger and a toggle chip hold the 24 px desktop floor and a 44 px phone target', () => {
    render(
      <>
        <FacetFilter slot="status" label="Status" options={[]} selected={[]} onToggle={() => {}} onClear={() => {}} />
        <ToggleChip slot="tag-filter" label="storefront" selected={false} onToggle={() => {}} />
      </>,
    )
    for (const element of [screen.getByRole('button', { name: 'Filter by status' }), screen.getByRole('button', { name: 'storefront' })]) {
      for (const token of ['h-7', 'md:min-h-chip', 'min-h-tap', 'min-w-tap', 'md:min-w-0']) {
        expect(classes(element), token).toContain(token)
      }
    }
  })

  it('a segmented control is 44 px per segment on a phone, on the density lever inside', () => {
    render(<SegmentedControl slot="group-by" label="Group" value="tag" options={[{ value: 'tag', label: 'Tag' }]} onChange={() => {}} />)
    expect(classes(screen.getByRole('group'))).toContain('p-0.75')
    expect(classes(screen.getByRole('button', { name: 'Tag' }))).toEqual(expect.arrayContaining(PHONE_TARGET))
  })

  it('the template trigger IS the composer chip, disabled look included, and says Search', () => {
    render(
      <MemoryRouter>
        <PromptTemplateMenu templates={[{ id: 't', label: 'Tests', text: 'run the tests' }]} onInsert={() => {}} disabled iconOnly />
      </MemoryRouter>,
    )
    const trigger = screen.getByRole('button', { name: 'Insert a prompt template' })
    expect(classes(trigger)).toEqual(expect.arrayContaining(['disabled:opacity-55', 'min-h-[24px]', 'max-md:min-h-tap', 'w-7', 'min-w-chip']))
    expect(trigger.getAttribute('class')).not.toMatch(/h-\[26px\]|opacity-50/)
  })
})

describe('Q06 / Q09 / Q24 phone targets on the remaining list controls', () => {
  it('every default-agent radio is a 44 px phone target (G-29)', () => {
    const rows: AgentPickerRow[] = RUNNERS.map((runner) => ({ runner, account: null, label: runner.label, desc: runner.desc, missing: false }))
    render(
      <DefaultAgentPicker
        rows={rows}
        runner="claude"
        accountFor={() => null}
        providerStatus={{ isPending: false, isError: false }}
        onPick={() => {}}
      />,
    )
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(RUNNERS.length)
    for (const radio of radios) expect(classes(radio)).toEqual(expect.arrayContaining(PHONE_TARGET))
  })

  it('the tab link and the rename field are 44 px on a phone', () => {
    const editor: TitleEditor = { editing: true, draft: 'x', setDraft: () => {}, begin: () => {}, commit: () => {}, cancel: () => {} }
    render(
      <MemoryRouter>
        <TabLink to="/changes">Changes</TabLink>
        <TitleEditInput editor={editor} />
      </MemoryRouter>,
    )
    expect(classes(screen.getByRole('link', { name: 'Changes' }))).toEqual(expect.arrayContaining(PHONE_TARGET))
    expect(classes(screen.getByRole('textbox', { name: 'Task title' }))).toEqual(expect.arrayContaining(['min-h-tap', 'md:min-h-0']))
  })
})

describe('G-21 the rename pencil is reachable without hover', () => {
  it('reveals on a device that cannot hover, as a 44 px target', () => {
    inRouter(<TasksOverview runs={[run({ id: 'p1' })]} view="active" onViewChange={() => {}} onArchiveFinished={() => {}} onMarkAllRead={() => {}} onRename={() => {}} />)
    const pencil = document.querySelector('[data-slot="task-table-row"] [data-slot="row-rename"]')
    expect(classes(pencil)).toEqual(expect.arrayContaining(['no-hover:opacity-100', 'no-hover:min-h-tap', 'no-hover:min-w-tap']))
  })
})

describe('T-4 nested controls never navigate the row', () => {
  function renderProject(onTogglePin = vi.fn(), onRename = vi.fn()) {
    const pr = run({ id: 'n1', title: 'Nested controls', pullRequestUrl: 'https://github.com/o/r/pull/5' })
    inRouter(
      <TasksOverview
        runs={[pr]}
        view="active"
        onViewChange={() => {}}
        onArchiveFinished={() => {}}
        onMarkAllRead={() => {}}
        onRename={onRename}
        onTogglePin={onTogglePin}
      />,
    )
    return { onTogglePin, onRename }
  }

  it('the project table row: pin, rename and the reference chip keep the row where it is', () => {
    const { onTogglePin } = renderProject()
    const row = document.querySelector('[data-slot="task-table-row"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Pin task' }))
    expect(onTogglePin).toHaveBeenCalledTimes(1)
    fireEvent.click(within(row).getByRole('link', { name: /pull request for Nested controls/ }))
    fireEvent.click(within(row).getByRole('button', { name: 'Rename task' }))
    expect(location()).toBe('/')
    // …and the row itself still navigates.
    fireEvent.click(row.querySelector('[data-column-id="workflow"]')!)
    expect(location()).toBe('/tasks/n1')
  })

  it('the project phone card: pin and the reference chip keep the card where it is', () => {
    const { onTogglePin } = renderProject()
    const card = document.querySelector('[data-slot="task-card"]') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'Pin task' }))
    fireEvent.click(within(card).getByRole('link', { name: /pull request for Nested controls/ }))
    expect(onTogglePin).toHaveBeenCalledTimes(1)
    expect(location()).toBe('/')
    fireEvent.click(card)
    expect(location()).toBe('/tasks/n1')
  })

  it('the global phone card: read, archive, project and references keep the card where it is', async () => {
    stubPhone()
    stubGlobalIndex()
    renderGlobal()
    const card = (await waitFor(() => {
      const found = document.querySelector('[data-slot="global-task-card"][data-run-id="g1"]')
      expect(found).not.toBeNull()
      return found
    })) as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: /^Mark .* read$/ }))
    fireEvent.click(within(card).getByRole('button', { name: /^Archive / }))
    fireEvent.click(within(card).getByRole('button', { name: /Show all 2 references/ }))
    expect(screen.getByTestId('location').textContent).toBe('/tasks')
    // The open list is a portal: its DOM is outside the card, but React bubbles its clicks
    // through the card. A tap on the list's own text must not open the task behind it.
    const list = await waitFor(() => {
      const found = document.querySelector('[data-slot="reference-overflow-list"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    fireEvent.click(within(list).getByText('References'))
    expect(screen.getByTestId('location').textContent).toBe('/tasks')
    fireEvent.click(within(card).getByRole('link', { name: 'API' }))
    expect(screen.getByTestId('location').textContent).toBe('/p/api/')
  })

  it('a click on the global card itself opens the task in its own project', async () => {
    stubPhone()
    stubGlobalIndex()
    renderGlobal()
    const card = (await waitFor(() => {
      const found = document.querySelector('[data-slot="global-task-card"][data-run-id="g1"]')
      expect(found).not.toBeNull()
      return found
    })) as HTMLElement
    fireEvent.click(card)
    expect(screen.getByTestId('location').textContent).toBe('/p/api/tasks/g1')
  })
})

const PROJECTS: ProjectListEntry[] = [
  {
    id: 'api',
    name: 'API',
    root: '/repos/api',
    addedAt: '2026-07-01T10:00:00Z',
    lastOpenedAt: '2026-07-01T10:00:00Z',
    source: 'local',
    status: 'ok',
    tags: ['storefront'],
    repoUrl: 'https://github.com/acme/api',
  },
]
const INDEX: RunIndexEntry[] = [
  {
    projectId: 'api',
    id: 'g1',
    title: 'Global card fixture',
    status: 'done',
    createdAt: '2026-07-14T10:00:00Z',
    finishedAt: '2026-07-14T10:30:00Z',
    archived: false,
    workflow: 'quick-task',
    runner: 'codex',
    model: 'gpt-5.6-sol',
    costUsd: 1.25,
    peakRssBytes: 612 * 1024 ** 2,
    pullRequestUrl: 'https://github.com/acme/api/pull/42',
    referencedIssueUrl: 'https://github.com/acme/api/issues/12',
  },
]

function stubGlobalIndex() {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/health') return json({ capabilities: { costMetrics: true, tokenUsageMetrics: true } })
      if (path === '/api/v1/projects') return json({ projects: PROJECTS, bootProject: 'api', projectsDir: '/repos' })
      if (path === '/api/v1/workspace/runs-index') return json({ runs: INDEX, perProjectLimit: 200, truncated: [], referenceStatuses: {} })
      if (path.includes('/github/ref-status')) return json({ available: false, reason: 'gh CLI not found', recheckAfterMs: 300_000 })
      return json({ ok: true })
    }),
  )
}

function GlobalLocation() {
  const { pathname } = useLocation()
  return <output data-testid="location">{pathname}</output>
}

function renderGlobal() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/tasks']}>
        <ListViewProvider>
          <GlobalLocation />
          <Routes>
            <Route path="/tasks" element={<GlobalTasksRoute />} />
            <Route path="*" element={null} />
          </Routes>
        </ListViewProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('G-17 the global page keeps its information and actions on a phone', () => {
  it('renders cards, not a table, with project, tags, workflow, tool, model, cost and memory', async () => {
    stubPhone()
    stubGlobalIndex()
    renderGlobal()
    const card = (await waitFor(() => {
      const found = document.querySelector('[data-slot="global-task-card"]')
      expect(found).not.toBeNull()
      return found
    })) as HTMLElement
    expect(document.querySelector('[data-slot="global-tasks-table"]')).toBeNull()
    const text = card.textContent ?? ''
    for (const fact of ['Global card fixture', 'API', 'storefront', 'quick-task', 'Codex', 'gpt-5.6-sol', '$1.25', 'Mem peak 612 MB']) {
      expect(text, fact).toContain(fact)
    }
    expect(within(card).getByRole('link', { name: 'Global card fixture' }).getAttribute('href')).toBe('/p/api/tasks/g1')
    for (const action of within(card).getAllByRole('button')) expect(classes(action)).toEqual(expect.arrayContaining(PHONE_TARGET))
  })

  it('offers the Active/Archived tabs, the count and the search on a phone', async () => {
    stubPhone()
    stubGlobalIndex()
    renderGlobal()
    const toolbar = await waitFor(() => {
      const found = document.querySelector('[data-slot="global-tasks-phone-toolbar"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(within(toolbar).getByRole('button', { name: 'Archived' })).not.toBeNull()
    expect(within(toolbar).getByRole('textbox', { name: 'Search tasks across projects' }).getAttribute('data-slot')).toBe('input')
    await waitFor(() => expect(within(toolbar).getByText('1 of 1')).not.toBeNull())
  })

  it('a desktop page mounts no phone toolbar and no cards', async () => {
    stubGlobalIndex()
    renderGlobal()
    await waitFor(() => expect(document.querySelector('[data-slot="global-task-row"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="global-tasks-phone-toolbar"]')).toBeNull()
    expect(document.querySelector('[data-slot="global-task-card"]')).toBeNull()
  })

  it('the project page offers its tabs, actions and search on a phone', () => {
    stubPhone()
    inRouter(
      <TasksOverview
        runs={[run({ status: 'done', finishedAt: '2026-07-14T11:30:00.000Z' })]}
        view="active"
        onViewChange={() => {}}
        onArchiveFinished={() => {}}
        onMarkAllRead={() => {}}
        onRename={() => {}}
      />,
    )
    const toolbar = document.querySelector('[data-slot="tasks-phone-toolbar"]') as HTMLElement
    expect(within(toolbar).getByRole('button', { name: /^Archived/ })).not.toBeNull()
    expect(within(toolbar).getByRole('button', { name: /Archive finished/ })).not.toBeNull()
    expect(within(toolbar).getByRole('button', { name: /Mark all read/ })).not.toBeNull()
    expect(within(toolbar).getByRole('textbox', { name: 'Search tasks' }).getAttribute('data-slot')).toBe('input')
  })

  it('both tables share one header and cell grammar', () => {
    stubGlobalIndex()
    renderGlobal()
    inRouter(<TasksOverview runs={[run()]} view="active" onViewChange={() => {}} onArchiveFinished={() => {}} onMarkAllRead={() => {}} onRename={() => {}} />)
    return waitFor(() => {
      const headers = [...document.querySelectorAll('th')]
      expect(headers.length).toBeGreaterThan(TASK_COLUMNS.length)
      // Alignment and a folded column's padding are per cell; the rest of the grammar is shared.
      const shared = (all: string, per: RegExp) => all.split(' ').filter((token) => !per.test(token))
      const thTokens = shared(TASK_TH_CLASS, /^(text-left|px-3|first:pl-4|last:pr-4)$/)
      const tdTokens = shared(TASK_TD_CLASS, /^(px-3|first:pl-4|last:pr-4)$/)
      for (const th of headers) expect(classes(th)).toEqual(expect.arrayContaining(thTokens))
      const cells = document.querySelectorAll('[data-slot="global-task-row"] > td, [data-slot="task-table-row"] > td')
      expect(cells.length).toBeGreaterThan(0)
      for (const td of cells) expect(classes(td)).toEqual(expect.arrayContaining(tdTokens))
      for (const usage of document.querySelectorAll('td[data-usage-kind]')) {
        const kind = usage.getAttribute('data-usage-kind') as keyof typeof USAGE_CELL_CLASS
        expect(usage.getAttribute('class')).toContain(USAGE_CELL_CLASS[kind])
      }
    })
  })

  it('column and error copy follow the house wording', async () => {
    expect(TASK_COLUMNS.find((column) => column.id === 'tool')?.label).toBe('Tool name')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'workspace unreadable' }), { status: 500, headers: { 'content-type': 'application/json' } })))
    renderGlobal()
    expect(await screen.findByText('Could not load tasks across projects', {}, { timeout: 5000 })).not.toBeNull()
  })
})

describe('T-4 a failed clipboard write is reported as failed', () => {
  it('answers ok only when the write resolved', async () => {
    const writeText = vi.fn(async () => {})
    expect(await copyText('npm test', { writeText })).toEqual({ ok: true })
    expect(writeText).toHaveBeenCalledWith('npm test')
  })

  it('a refused write answers not ok, with the browser’s reason', async () => {
    const result = await copyText('npm test', { writeText: async () => Promise.reject(new Error('Document is not focused.')) })
    expect(result).toEqual({ ok: false, reason: 'Document is not focused.' })
  })

  it('a refusal without a message still answers not ok, and never throws', async () => {
    const result = await copyText('npm test', { writeText: async () => Promise.reject('denied') })
    expect(result.ok).toBe(false)
  })

  it('no clipboard API at all answers not ok', async () => {
    expect((await copyText('npm test', undefined)).ok).toBe(false)
    expect((await copyText('npm test', {} as never)).ok).toBe(false)
  })
})

describe('G-18 one byte formatter, both precision contracts', () => {
  it('memory keeps whole kB and MB, one decimal for GB, and nothing for no sample', () => {
    expect(formatMem(undefined)).toBe('')
    expect(formatMem(0)).toBe('')
    expect(formatMem(300)).toBe('0 kB')
    expect(formatMem(1536)).toBe('2 kB')
    expect(formatMem(612.4 * 1024 ** 2)).toBe('612 MB')
    expect(formatMem(1.26 * 1024 ** 3)).toBe('1.3 GB')
    expect(formatBytes(5 * 1024 ** 2 + 700 * 1024, 'memory')).toBe('6 MB')
  })

  it('file keeps real bytes and one decimal, with no GB step', () => {
    expect(formatBytes(0, 'file')).toBe('0 B')
    expect(formatBytes(312, 'file')).toBe('312 B')
    expect(formatBytes(4.6 * 1024, 'file')).toBe('4.6 kB')
    expect(formatBytes(1536, 'file')).toBe('1.5 kB')
    expect(formatBytes(1.24 * 1024 ** 2, 'file')).toBe('1.2 MB')
    expect(formatBytes(2 * 1024 ** 3, 'file')).toBe('2048.0 MB')
  })

  it('file precision is exactly what the Files tab prints today', () => {
    for (const bytes of [0, 1, 312, 1023, 1024, 1025, 4711, 99_999, 1024 ** 2 - 1, 1024 ** 2, 7_654_321, 3 * 1024 ** 3]) {
      expect(formatBytes(bytes, 'file'), String(bytes)).toBe(formatFileSize(bytes))
    }
  })
})
