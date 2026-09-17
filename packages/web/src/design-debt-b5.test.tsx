import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ComponentProps } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { Composer } from '@/components/composer/composer'
import { RunDiff } from '@/components/run-diff'
import { ToolsMenu } from '@/components/tools-menu'
import { resetToasts, Toaster } from '@/components/ui/toaster'
import type { ApiRun, HealthResponse, StepState } from '@qodeca/xezar-api-client'
import { AgentsDock } from '@/routes/task-thread/agents-dock'
import { AskCard } from '@/routes/task-thread/ask-card'
import { PlanDock } from '@/routes/task-thread/plan-dock'
import { RunHeader } from '@/routes/task-thread/run-header'
import { WorkflowSteps } from '@/routes/task-thread/step-rail'
import type { ThreadAsk } from '@/routes/task-thread/thread-state'
import { JumpToLatestPill } from '@/routes/task-thread/thread-scroller'
import { ContextGroup, ToolStreak, UserBubble } from '@/routes/task-thread/thread-items'

/**
 * Design-debt batch B5 — thread, composer and launch menus (#453, AC-5 / T-5). The class and copy
 * contracts, the no-hover reveals, the reduced-motion guards, honest clipboard feedback and the
 * single-delivery answer, in jsdom. jsdom has no layout: the 44 px geometry at every density is
 * measured in `packages/web/e2e/design-debt-b5.e2e.ts`.
 */

const classes = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/)
const PHONE_ROW = ['min-h-tap', 'md:min-h-0']
const PHONE_TARGET = ['min-h-tap', 'min-w-tap', 'md:min-h-0', 'md:min-w-0']
const NO_HOVER_TARGET = [...PHONE_TARGET, 'no-hover:min-h-tap', 'no-hover:min-w-tap']

// The answer seam is mocked for the AskCard case only; the rest of the queries module stays real.
const sendMessage = vi.fn()
vi.mock('@/api/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/queries')>()),
  useSendMessage: () => ({ mutateAsync: sendMessage, isPending: false }),
}))

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
  sendMessage.mockReset()
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/runs') return json([])
      if (path === '/api/v1/providers/status') {
        return json({ providers: [{ provider: 'claude', status: 'connected', enabled: true }] })
      }
      return json({})
    }),
  )
}

const step = (extra: Partial<StepState> = {}): StepState => ({
  id: 'task',
  name: 'Do the task',
  kind: 'agent',
  status: 'done',
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

const run = (extra: Partial<ApiRun> = {}): ApiRun => ({
  id: 'r1',
  title: 'Batch five',
  workflow: 'quick-task',
  task: 'Batch five',
  status: 'done',
  createdAt: '2026-09-17T12:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  runner: 'claude',
  worktreePath: '/tmp/wt',
  steps: [step({ sessionId: 'sess-1' })],
  ...extra,
})

function renderHeader(record: ApiRun) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/tasks/${record.id}`]}>
        <Routes>
          <Route path="/tasks/:id" element={<RunHeader run={record} />} />
          <Route path="*" element={null} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Q05 / G-21 the composer', () => {
  it('its textarea keeps a 44 px phone floor and the desktop minimum on the density lever', () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <Composer onSubmit={async () => ({})} />
      </QueryClientProvider>,
    )
    const field = screen.getByRole('textbox', { name: 'Reply to the agent' })
    expect(classes(field)).toEqual(expect.arrayContaining(['min-h-tap', 'md:min-h-13.5']))
    expect(screen.getByRole('button', { name: 'Attach files' }).querySelector('svg')?.getAttribute('class')).toContain('size-4')
  })

  it('shows an attachment’s remove mark on a device that cannot hover, without covering the image', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})))
    render(
      <QueryClientProvider client={createQueryClient()}>
        <Composer onSubmit={async () => ({})} />
      </QueryClientProvider>,
    )
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
    fireEvent.paste(screen.getByRole('textbox', { name: 'Reply to the agent' }), {
      clipboardData: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] },
    })
    const remove = await screen.findByRole('button', { name: 'Remove shot.png' })
    const mark = remove.querySelector('svg')?.parentElement ?? null
    // Hover and keyboard focus reveal it; a touch device has neither, so it is always shown there.
    expect(classes(mark)).toEqual(expect.arrayContaining(['hidden', 'group-hover:flex', 'group-focus-visible:flex', 'no-hover:flex', 'no-hover:inset-auto']))
  })
})

describe('Q27 / S26 / S27 / G-34 the Tools menu', () => {
  const HEALTH = {
    version: '0.16.0',
    defaultRunner: 'claude',
    checks: [
      { name: 'claude', available: true, version: '2.0.44' },
      { name: 'codex', available: false, hint: 'optional: install the Codex CLI' },
    ],
    forge: null,
  } as unknown as HealthResponse

  it('the trigger is a 44 px phone target with a focus ring, and the chevron is on the scale', () => {
    render(
      <MemoryRouter>
        <ToolsMenu health={HEALTH} />
      </MemoryRouter>,
    )
    const trigger = screen.getByRole('button', { name: /Tools/ })
    expect(classes(trigger)).toEqual(expect.arrayContaining([...PHONE_ROW, 'focus-visible:ring-[3px]']))
    expect(trigger.querySelector('svg')?.getAttribute('class')).toContain('size-3')
  })
})

describe('Q74 / Q78 / Q81 docks and the step rail', () => {
  it('the Agents and Plan dock headers and an agent row are 44 px on a phone', () => {
    render(
      <>
        <AgentsDock runId="b5-agents" agents={[{ id: 'a1', title: 'Review the store', status: 'running', toolCalls: 2 }]} onSelect={() => {}} />
        <PlanDock runId="b5-plan" entries={[{ content: 'Convert the docks', status: 'in_progress' }]} />
      </>,
    )
    for (const name of [/^Agents/, /^Plan/]) {
      expect(classes(screen.getByRole('button', { name })), String(name)).toEqual(expect.arrayContaining(PHONE_ROW))
    }
    const agents = screen.getByRole('button', { name: /^Agents/ })
    if (agents.getAttribute('aria-expanded') !== 'true') fireEvent.click(agents)
    expect(classes(screen.getByRole('button', { name: /Review the store/ }))).toEqual(expect.arrayContaining(['min-h-tap', 'md:min-h-5']))
  })

  it('the workflow summary is a 44 px phone row and 7.5 units on a desktop', () => {
    render(<WorkflowSteps runId="b5-steps" steps={[step({ status: 'running' })]} />)
    expect(classes(screen.getByRole('button', { name: /^Workflow:/ }))).toEqual(expect.arrayContaining(['min-h-tap', 'md:min-h-7.5']))
  })
})

describe('Q83 / Q84 thread items and the jump pill', () => {
  it('message actions show without hover and are 44 px targets', () => {
    render(<UserBubble text="hello" onEdit={async () => {}} onRemove={async () => {}} />)
    const edit = screen.getByRole('button', { name: 'Edit message' })
    const remove = screen.getByRole('button', { name: 'Remove message' })
    for (const action of [edit, remove]) expect(classes(action)).toEqual(expect.arrayContaining(NO_HOVER_TARGET))
    expect(classes(edit.parentElement)).toEqual(expect.arrayContaining(['opacity-0', 'group-hover:opacity-100', 'no-hover:opacity-100']))
  })

  it('the editing bubble’s Cancel and Save are 44 px targets', () => {
    render(<UserBubble text="hello" onEdit={async () => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
    for (const name of ['Cancel', 'Save']) expect(classes(screen.getByRole('button', { name })), name).toEqual(expect.arrayContaining(PHONE_TARGET))
  })

  it('a context group, a tool streak and the jump pill are 44 px rows on a phone', () => {
    render(
      <>
        <ContextGroup group={{ kind: 'ctx-group', id: 'g', label: 'Explored 2 files', tools: [] } as never} />
        <ToolStreak count={3}>{null}</ToolStreak>
        <JumpToLatestPill onJump={() => {}} />
      </>,
    )
    expect(classes(screen.getByRole('button', { name: 'Explored 2 files' }))).toEqual(expect.arrayContaining(['h-9', ...PHONE_ROW]))
    expect(classes(screen.getByRole('button', { name: /3 earlier tool calls/ }))).toEqual(expect.arrayContaining(PHONE_ROW))
    expect(classes(screen.getAllByRole('button').at(-1)!)).toEqual(expect.arrayContaining(['min-h-tap', 'md:min-h-8']))
  })
})

describe('Q80 / G-21 / G-10 / G-16 the run header', () => {
  it('the rename pencil shows without hover as a 44 px target', () => {
    stubFetch()
    renderHeader(run())
    const pencil = screen.getByRole('button', { name: 'Rename task' })
    expect(classes(pencil)).toEqual(expect.arrayContaining(['opacity-0', 'no-hover:opacity-100', ...NO_HOVER_TARGET]))
  })

  it('the delete confirm is the danger button and cancels with “Keep it”', async () => {
    stubFetch()
    renderHeader(run({ status: 'failed' }))
    fireEvent.click(within(document.querySelector('[data-slot="run-actions"]') as HTMLElement).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    const confirm = within(dialog).getByRole('button', { name: 'Delete' })
    expect(classes(confirm)).toEqual(expect.arrayContaining(['bg-danger', 'text-danger-foreground', ...PHONE_TARGET]))
    expect(within(dialog).getByRole('button', { name: 'Keep it' })).toBeTruthy()
  })

  it('a copied resume command says so, as a fragment', async () => {
    stubFetch()
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    renderHeader(run())
    const hint = screen.getByRole('button', { name: /take over interactively/ })
    expect(classes(hint)).toEqual(expect.arrayContaining(PHONE_ROW))
    fireEvent.click(hint)
    expect((await screen.findByRole('status')).textContent).toBe('Command copied')
  })

  it('a refused clipboard never reports success: the toast carries the command instead', async () => {
    stubFetch()
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('Document is not focused.')) } })
    renderHeader(run())
    fireEvent.click(screen.getByRole('button', { name: /take over interactively/ }))
    const toast = await screen.findByRole('status')
    expect(toast.textContent).toMatch(/^Run manually: /)
    expect(toast.textContent).not.toContain('copied')
  })
})

describe('Q75 the ask card delivers one answer', () => {
  const ask: ThreadAsk = {
    kind: 'ask',
    id: 'ask_b5',
    resolved: false,
    questions: [
      { header: 'Library', question: 'Which date library?', options: [{ label: 'date-fns' }, { label: 'Luxon' }] },
    ],
  } as ThreadAsk

  it('an option is a 44 px phone target, and a repeated tap while delivering sends once', async () => {
    stubFetch()
    let finish: (value: unknown) => void = () => {}
    sendMessage.mockImplementation(() => new Promise((done) => { finish = done }))
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <AskCard ask={ask} run={run({ status: 'waiting' })} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const option = await screen.findByRole('button', { name: 'date-fns' })
    expect(classes(option)).toEqual(expect.arrayContaining(PHONE_ROW))
    await waitFor(() => expect((option as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(option)
    fireEvent.click(option)
    fireEvent.click(screen.getByRole('button', { name: 'Luxon' }))
    expect(sendMessage).toHaveBeenCalledTimes(1)
    await act(async () => finish({}))
  })
})

// Lexical guards over the batch's own files: jsdom cannot tell a guarded animation from a bare one.
const B5_FILES = [
  'components/composer/composer.tsx',
  'components/open-in-menu.tsx',
  'components/tools-menu.tsx',
  ...['agents-dock', 'ask-card', 'auto-resume-hint', 'mcp-operation-feedback', 'plan-dock', 'review-panel', 'run-header', 'step-rail', 'task-thread', 'thread-items', 'thread-scroller'].map(
    (name) => `routes/task-thread/${name}.tsx`,
  ),
]
const source = (rel: string) => readFileSync(resolve(import.meta.dirname, rel), 'utf8')

describe('G-08 / G-15 / G-16 motion, copy and clipboard across the batch', () => {
  it('every spin and pulse is motion-safe or stops under reduced motion', () => {
    const bare: string[] = []
    for (const rel of B5_FILES) {
      for (const [n, line] of source(rel).split('\n').entries()) {
        for (const match of line.matchAll(/(?<![\w:-])animate-(?:spin|pulse)\b/g)) {
          if (!/motion-reduce:animate-none/.test(line)) bare.push(`${rel}:${n + 1} ${match[0]}`)
        }
      }
    }
    expect(bare).toEqual([])
  })

  it('no hand-rolled pulsing dot is left in the composer', () => {
    expect(source('components/composer/composer.tsx')).not.toMatch(/rounded-full bg-danger/)
  })

  it('negatives read “could not”, and success toasts are fragments without a period', () => {
    const offenders = B5_FILES.flatMap((rel) => {
      const text = source(rel)
      return [
        ...(/[Cc]ouldn[’']t/.test(text) ? [`${rel}: couldn’t`] : []),
        ...[...text.matchAll(/toast\('([^']*copied[^']*)'\)/g)].filter((m) => m[1]!.endsWith('.')).map((m) => `${rel}: ${m[1]}`),
      ]
    })
    expect(offenders).toEqual([])
  })

  it('the batch copies only through the shared helper', () => {
    const direct = B5_FILES.filter((rel) => /navigator\.clipboard/.test(source(rel)))
    expect(direct).toEqual([])
  })
})

describe('C4 RunDiff keeps its public API (Batch 6 replaces its internals)', () => {
  it('is still a component taking exactly a run id', () => {
    const props: ComponentProps<typeof RunDiff> = { runId: 'r1' }
    expect(Object.keys(props)).toEqual(['runId'])
    expect(typeof RunDiff).toBe('function')
    expect(RunDiff.length).toBeLessThanOrEqual(1)
  })
})
