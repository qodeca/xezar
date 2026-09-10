import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { Skill, WorkflowDef, WorkflowsResponse } from '@qodeca/xezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { WorkflowsRoute } from './workflows'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures ----------------------------------------------------------------------------------

const SKILLS: Skill[] = [
  { name: 'om-fix', description: 'Fix the thing', body: '', path: '.ai/skills/om-fix.md', source: 'ai' },
  { name: 'om-review', description: 'Review it', body: '', path: '~/.xez/skills/om-review.md', source: 'global' },
]

const QUICK: WorkflowDef = {
  name: 'quick-task',
  description: 'One agent run on your task — no ceremony.',
  source: 'built-in',
  steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
}

/** The repo's first saved (file) workflow — what a cold /workflows visit must open. */
const SHIP: WorkflowDef = {
  name: 'ship-it',
  description: 'Fix then review.',
  source: 'file',
  path: '.xezar/workflows/ship-it.yaml',
  steps: [
    { id: 'om-fix', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' },
    { id: 'om-review', name: 'om-review', skill: 'om-review', prompt: '{{task}}' },
  ],
}

/** Already at the server's save/run cap. */
const FULL: WorkflowDef = {
  name: 'crowded',
  source: 'file',
  path: '.xezar/workflows/crowded.yaml',
  steps: Array.from({ length: 8 }, (_, i) => ({
    id: `s${i + 1}`,
    name: 'om-fix',
    skill: 'om-fix',
    prompt: '{{task}}',
  })),
}

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style (inbox.test.tsx): records requests (bodies included), serves
 *  the fixtures, and lets a test override specific `METHOD path` keys — per call, so a 409
 *  can turn into a 201 on the retry. */
function stubFetch(
  overrides: Record<string, Array<() => Response>> = {},
  workflows: WorkflowDef[] = [QUICK, SHIP],
): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined })
      const queue = overrides[`${method} ${path}`]
      const next = queue?.shift()
      if (next) return next()
      if (method === 'GET' && path === '/api/v1/workflows') {
        return jsonResponse({ workflows, issues: [] } satisfies WorkflowsResponse)
      }
      if (method === 'GET' && path === '/api/v1/skills') return jsonResponse(SKILLS)
      if (method === 'GET' && path === '/api/v1/ui-state') return jsonResponse({})
      return jsonResponse({ error: 'not found' }, 404)
    }),
  )
  return sent
}

function renderAt(entry: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/workflows" element={<WorkflowsRoute />} />
          <Route path="/workflows/:name" element={<WorkflowsRoute />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const stepCards = () => [...document.querySelectorAll<HTMLElement>('[data-slot="wb-step"]')]
const stepIds = () => stepCards().map((card) => card.dataset.id)
const yamlText = () => document.querySelector('[data-slot="wb-yaml"]')?.textContent ?? ''
const nameInput = () => screen.getByLabelText('Workflow name') as HTMLInputElement
const addButton = (skill: string) =>
  document.querySelector<HTMLButtonElement>(`[data-slot="wb-skill"][data-skill="${skill}"] [data-slot="wb-skill-add"]`)!

// ---- seeding -----------------------------------------------------------------------------------

describe('canvas seeding', () => {
  it('a cold /workflows opens the repo’s first saved workflow (built-ins skipped)', async () => {
    stubFetch()
    renderAt('/workflows')

    await waitFor(() => expect(stepIds()).toEqual(['om-fix', 'om-review']))
    expect(nameInput().value).toBe('ship-it')
    // Its chip reads active; the compact YAML preview reflects the pure stack.
    expect(
      document.querySelector('[data-slot="wb-load-chip"][data-name="ship-it"]')?.getAttribute('aria-pressed'),
    ).toBe('true')
    expect(yamlText()).toContain('skills:')
    expect(yamlText()).toContain('- om-fix')
    expect(screen.getByText('2 skills')).toBeTruthy()
  })

  it('/workflows/:name deep-links that workflow into the canvas', async () => {
    stubFetch({}, [QUICK, SHIP, FULL])
    renderAt('/workflows/crowded')

    await waitFor(() => expect(stepCards()).toHaveLength(8))
    expect(nameInput().value).toBe('crowded')
  })

  it('no saved workflows → an empty canvas with the drop hint', async () => {
    stubFetch({}, [QUICK])
    renderAt('/workflows')

    await screen.findByText('Drop a skill here — or Import a workflow.yaml')
    expect(stepCards()).toHaveLength(0)
    expect(nameInput().value).toBe('my-workflow')
  })
})

// ---- palette → canvas, remove, limit -----------------------------------------------------------

describe('palette add / remove / the 8-step limit', () => {
  it('the palette add appends a step, dedupes ids, and updates count + YAML', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(addButton('om-fix'))
    expect(stepIds()).toEqual(['om-fix', 'om-review', 'om-fix-2'])
    expect(screen.getByText('3 skills')).toBeTruthy()
    expect(yamlText().match(/- om-fix/g)).toHaveLength(2)
  })

  it('remove drops exactly that card', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(screen.getByLabelText('Remove step 1: om-fix'))
    expect(stepIds()).toEqual(['om-review'])
    expect(screen.getByText('1 skill')).toBeTruthy()
  })

  it('the 9th step is refused with the legacy message', async () => {
    stubFetch({}, [FULL])
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(8))

    fireEvent.click(addButton('om-review'))
    expect(stepCards()).toHaveLength(8)
    await screen.findByText('A workflow holds at most 8 steps.')
  })

  // #374: the palette's empty state must mention the same discovery dirs as the Skills tab's,
  // not just `.ai/skills/`.
  it('an empty skill catalog explains every discovery dir, not just .ai/skills/', async () => {
    stubFetch({ 'GET /api/v1/skills': [() => jsonResponse([])] })
    renderAt('/workflows')

    const hint = await screen.findByText(/No skills yet/)
    expect(hint.textContent).toContain('.ai/skills/')
    expect(hint.textContent).toContain('.xezar/skills/')
    expect(hint.textContent).toContain('.agents/skills/')
  })
})

// ---- import ------------------------------------------------------------------------------------

describe('YAML import', () => {
  it('a valid paste replaces the canvas with the server-normalized steps', async () => {
    const sent = stubFetch({
      'POST /api/v1/workflows/parse': [
        () =>
          jsonResponse({
            name: 'imported-flow',
            steps: [{ id: 'om-review', name: 'om-review', skill: 'om-review', prompt: '{{task}}' }],
          }),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-import"]')!)
    fireEvent.change(screen.getByLabelText('Workflow YAML to import'), {
      target: { value: 'name: imported-flow\nskills:\n  - om-review\n' },
    })
    fireEvent.click(document.querySelector('[data-slot="wb-import-run"]')!)

    await waitFor(() => expect(stepIds()).toEqual(['om-review']))
    expect(nameInput().value).toBe('imported-flow')
    // The server owns YAML parsing — the paste went to /parse verbatim.
    expect(sent.find((r) => r.path === '/api/v1/workflows/parse')?.body).toEqual({
      yaml: 'name: imported-flow\nskills:\n  - om-review',
    })
    await screen.findByText('Imported "imported-flow" — review, then Save.')
  })

  it('a bad paste surfaces the server’s own error and keeps the canvas', async () => {
    stubFetch({
      'POST /api/v1/workflows/parse': [
        () => jsonResponse({ error: 'a workflow lists either "steps" or "skills", not both' }, 400),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-import"]')!)
    fireEvent.change(screen.getByLabelText('Workflow YAML to import'), { target: { value: 'nope: 1' } })
    fireEvent.click(document.querySelector('[data-slot="wb-import-run"]')!)

    await waitFor(() =>
      expect(document.querySelector('[data-slot="wb-import-error"]')?.textContent).toBe(
        'a workflow lists either "steps" or "skills", not both',
      ),
    )
    expect(stepIds()).toEqual(['om-fix', 'om-review'])
  })
})

// ---- auto chain creator (#414) -----------------------------------------------------------------

describe('auto chain creator', () => {
  it('a built plan lands its title + steps on the canvas', async () => {
    const sent = stubFetch({
      'POST /api/v1/plan': [
        () =>
          jsonResponse({
            name: 'fix-and-review',
            steps: [
              { id: 'implement', name: 'Implement', prompt: '{{task}}' },
              { id: 'verify', name: 'Verify', command: 'npm test' },
            ],
            rationale: 'implement then verify',
            fallback: false,
          }),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-auto"]')!)
    fireEvent.change(screen.getByLabelText('Describe the chain to build'), {
      target: { value: 'Fix the bug and review it' },
    })
    fireEvent.click(document.querySelector('[data-slot="wb-auto-run"]')!)

    await waitFor(() => expect(stepIds()).toEqual(['implement', 'verify']))
    expect(nameInput().value).toBe('fix-and-review')
    expect(sent.find((r) => r.path === '/api/v1/plan')?.body).toEqual({ task: 'Fix the bug and review it' })
    await screen.findByText('Built "fix-and-review" — review, tweak, then Save.')
  })

  it('a degraded (fallback) plan keeps the current name and warns', async () => {
    stubFetch({
      'POST /api/v1/plan': [
        () =>
          jsonResponse({
            steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
            rationale: 'planner unavailable',
            fallback: true,
          }),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-auto"]')!)
    fireEvent.change(screen.getByLabelText('Describe the chain to build'), {
      target: { value: 'do something' },
    })
    fireEvent.click(document.querySelector('[data-slot="wb-auto-run"]')!)

    await waitFor(() => expect(stepIds()).toEqual(['task']))
    // No proposed title → the name the canvas already had (the seeded file) survives.
    expect(nameInput().value).toBe('ship-it')
    await screen.findByText('Planner unavailable — added a single step. Edit, then Save.')
  })
})

// ---- save --------------------------------------------------------------------------------------

describe('save', () => {
  it('a pure stack saves in the portable compact form', async () => {
    const sent = stubFetch({
      'POST /api/v1/workflows': [
        () => jsonResponse({ path: '.xezar/workflows/ship-it.yaml', name: 'ship-it' }, 201),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-save"]')!)
    await screen.findByText('Saved — ship-it.yaml')
    expect(sent.find((r) => r.method === 'POST' && r.path === '/api/v1/workflows')?.body).toEqual({
      name: 'ship-it',
      description: 'Fix then review.',
      skills: ['om-fix', 'om-review'],
    })
  })

  it('a 409 opens the overwrite confirm; confirming retries with overwrite: true', async () => {
    const sent = stubFetch({
      'POST /api/v1/workflows': [
        () => jsonResponse({ error: 'workflow file already exists', exists: true }, 409),
        () => jsonResponse({ path: '.xezar/workflows/ship-it.yaml', name: 'ship-it' }, 201),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-save"]')!)
    await screen.findByText('“ship-it” already exists')
    fireEvent.click(document.querySelector('[data-slot="wb-overwrite-confirm"]')!)

    await screen.findByText('Saved — ship-it.yaml')
    const posts = sent.filter((r) => r.method === 'POST' && r.path === '/api/v1/workflows')
    expect(posts).toHaveLength(2)
    expect(posts[0]!.body).not.toHaveProperty('overwrite')
    expect(posts[1]!.body).toMatchObject({ name: 'ship-it', overwrite: true })
  })

  it('an empty canvas refuses to save with the legacy message', async () => {
    const sent = stubFetch({}, [QUICK])
    renderAt('/workflows')
    await screen.findByText('Drop a skill here — or Import a workflow.yaml')

    fireEvent.click(document.querySelector('[data-slot="wb-save"]')!)
    await screen.findByText('Add at least one step first.')
    expect(sent.some((r) => r.method === 'POST')).toBe(false)
  })
})

// ---- delete / new ------------------------------------------------------------------------------

describe('delete and “+ new”', () => {
  it('Delete exists only for saved files, confirms, DELETEs and resets the canvas', async () => {
    const sent = stubFetch({
      'DELETE /api/v1/workflows/ship-it': [
        () => jsonResponse({ ok: true, path: '.xezar/workflows/ship-it.yaml' }),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-delete"]')!)
    await screen.findByText('Delete workflow “ship-it”?')
    fireEvent.click(document.querySelector('[data-slot="wb-delete-confirm"]')!)

    await screen.findByText('Deleted "ship-it".')
    expect(sent.some((r) => r.method === 'DELETE' && r.path === '/api/v1/workflows/ship-it')).toBe(true)
    await waitFor(() => expect(stepCards()).toHaveLength(0))
    expect(nameInput().value).toBe('my-workflow')
  })

  it('a built-in (or unsaved) name shows no Delete button', async () => {
    stubFetch({}, [QUICK])
    renderAt('/workflows')
    await screen.findByText('Drop a skill here — or Import a workflow.yaml')
    expect(document.querySelector('[data-slot="wb-delete"]')).toBeNull()
  })

  it('“+ new” resets to the empty draft', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-new"]')!)
    expect(stepCards()).toHaveLength(0)
    expect(nameInput().value).toBe('my-workflow')
    await screen.findByText('Drop a skill here — or Import a workflow.yaml')
  })
})

describe('the workflows list failing to load', () => {
  it('says so instead of rendering an empty builder that cannot save', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === '/api/v1/workflows'
          ? jsonResponse({ error: 'workflows dir is unreadable' }, 500)
          : jsonResponse([]),
      ),
    )
    renderAt('/workflows')

    // A 5xx is retried once (query-client.ts), so this outlives waitFor's 1s default.
    await waitFor(
      () => expect(screen.getByRole('heading', { name: 'Could not load workflows' })).toBeTruthy(),
      { timeout: 5_000 },
    )
    // The server's own words: the operator needs to know WHICH failure this was.
    expect(document.body.textContent).toContain('workflows dir is unreadable')
    // No canvas at all — a builder seeded from a failed list would save over nothing.
    expect(document.querySelector('[data-slot="wb-main"]')).toBeNull()
  })
})

describe('the toolbar guards', () => {
  const clickSlot = (slot: string) =>
    fireEvent.click(document.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!)

  it('an unnamed workflow focuses the name box rather than POSTing', async () => {
    const sent = stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards().length).toBeGreaterThan(0))
    fireEvent.change(nameInput(), { target: { value: '   ' } })

    clickSlot('wb-save')

    // A name is the file's identity — there is nothing to write without one.
    expect(document.activeElement).toBe(nameInput())
    expect(sent.some((r) => r.method === 'POST' && r.path.endsWith('/workflows'))).toBe(false)
  })

  it('an empty paste does not reach the parser', async () => {
    const sent = stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards().length).toBeGreaterThan(0))

    clickSlot('wb-import')
    await waitFor(() => expect(document.querySelector('[data-slot="wb-import-panel"]')).not.toBeNull())
    fireEvent.change(document.querySelector('[data-slot="wb-import-text"]')!, { target: { value: '  \n ' } })
    clickSlot('wb-import-run')

    expect(sent.some((r) => r.path.includes('workflows/parse'))).toBe(false)
  })

  it('an empty brief does not reach the planner', async () => {
    const sent = stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards().length).toBeGreaterThan(0))

    clickSlot('wb-auto')
    await waitFor(() => expect(document.querySelector('[data-slot="wb-auto-panel"]')).not.toBeNull())
    fireEvent.change(document.querySelector('[data-slot="wb-auto-text"]')!, { target: { value: '   ' } })
    clickSlot('wb-auto-run')

    expect(sent.some((r) => r.method === 'POST' && r.path.includes('plan'))).toBe(false)
  })
})

describe('export', () => {
  it('downloads the canvas YAML under the workflow’s slug, and releases the blob URL', async () => {
    vi.useFakeTimers()
    try {
      const createObjectURL = vi.fn(() => 'blob:workflow')
      const revokeObjectURL = vi.fn()
      vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
      const clicked: HTMLAnchorElement[] = []
      const realClick = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
        clicked.push(this)
      }
      try {
        stubFetch()
        renderAt('/workflows')
        await vi.waitFor(() => expect(stepCards().length).toBeGreaterThan(0))

        fireEvent.click(document.querySelector<HTMLElement>('[data-slot="wb-export"]')!)

        expect(clicked).toHaveLength(1)
        expect(clicked[0]?.getAttribute('href')).toBe('blob:workflow')
        // The slug, not the raw name — the file has to be a legal filename.
        expect(clicked[0]?.getAttribute('download')).toBe('ship-it.yaml')
        // The anchor is a throwaway: leaving it in the document would stack one per export.
        expect(document.querySelector('a[download]')).toBeNull()

        // Revoked on a delay rather than immediately — a same-tick revoke races the download.
        expect(revokeObjectURL).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1_000)
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:workflow')
      } finally {
        HTMLAnchorElement.prototype.click = realClick
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the panels and the palette filter', () => {
  const clickSlot = (slot: string) =>
    fireEvent.click(document.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!)

  it('Cancel closes each panel and forgets what was typed in it', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards().length).toBeGreaterThan(0))

    clickSlot('wb-import')
    await waitFor(() => expect(document.querySelector('[data-slot="wb-import-panel"]')).not.toBeNull())
    fireEvent.change(document.querySelector('[data-slot="wb-import-text"]')!, { target: { value: 'steps: []' } })
    clickSlot('wb-import-cancel')
    expect(document.querySelector('[data-slot="wb-import-panel"]')).toBeNull()

    clickSlot('wb-auto')
    await waitFor(() => expect(document.querySelector('[data-slot="wb-auto-panel"]')).not.toBeNull())
    fireEvent.change(document.querySelector('[data-slot="wb-auto-text"]')!, { target: { value: 'ship it' } })
    clickSlot('wb-auto-cancel')
    expect(document.querySelector('[data-slot="wb-auto-panel"]')).toBeNull()

    // Reopening must not resurrect the abandoned draft.
    clickSlot('wb-import')
    await waitFor(() => expect(document.querySelector('[data-slot="wb-import-panel"]')).not.toBeNull())
    expect(document.querySelector<HTMLTextAreaElement>('[data-slot="wb-import-text"]')?.value).toBe('')
  })

  it('a saved-workflow chip loads that chain onto the canvas', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards().length).toBe(2))

    const quickChip = document.querySelector<HTMLElement>('[data-slot="wb-load-chip"][data-name="quick-task"]')!
    expect(quickChip.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(quickChip)

    await waitFor(() => expect(nameInput().value).toBe('quick-task'))
    expect(stepIds()).toEqual(['task'])
    expect(
      document.querySelector('[data-slot="wb-load-chip"][data-name="quick-task"]')?.getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('the palette filter narrows the skills without touching the canvas', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(document.querySelectorAll('[data-slot="wb-skill"]').length).toBe(2))

    fireEvent.change(screen.getByLabelText('Filter skills'), { target: { value: 'review' } })

    await waitFor(() => expect(document.querySelectorAll('[data-slot="wb-skill"]').length).toBe(1))
    expect(document.querySelector('[data-slot="wb-skill"]')?.getAttribute('data-skill')).toBe('om-review')
    expect(stepIds()).toEqual(['om-fix', 'om-review'])
  })
})
