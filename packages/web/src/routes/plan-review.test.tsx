import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { WorkflowStepDef } from '@qodeca/xezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import type { PendingPlan } from './new-task-plan'
import { PlanReview, type PlanReviewProps } from './plan-review'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  // Radix's Dialog/AlertDialog measure the viewport and lock the scrollbar; jsdom has neither.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})

const plan: PendingPlan = {
  task: 'Review provider gating',
  steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
  rationale: '',
  fallback: false,
  images: [],
}

const THREE_STEPS: WorkflowStepDef[] = [
  { id: 'plan', name: 'Plan it', prompt: 'plan {{task}}' },
  { id: 'build', name: 'Build it', skill: 'om-implement', prompt: 'do it' },
  { id: 'verify', name: 'Verify it', command: 'npm test' },
]

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface SentRequest {
  path: string
  method: string
  body: unknown
}

/** Records every request and lets a test decide what `POST …/workflows` answers. The route is
 *  matched by suffix rather than by a full path, because the client scopes it to the active
 *  project (`/api/v1/p/<id>/workflows`) and this component knows nothing about that. */
function stubFetch(onSaveAttempt: (attempt: number) => Response = () => savedAs('fix-and-verify-v2')): SentRequest[] {
  const sent: SentRequest[] = []
  let attempts = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
      if (method === 'POST' && path.endsWith('/workflows')) {
        attempts += 1
        return onSaveAttempt(attempts)
      }
      return jsonResponse({})
    })
  )
  return sent
}

const savedAs = (name: string) => jsonResponse({ name, path: `.xezar/workflows/${name}.yaml` })
const ALREADY_EXISTS = () =>
  jsonResponse({ error: 'a chain with this name exists', exists: true }, 409)

function renderPlan(over: Partial<PlanReviewProps> = {}) {
  const props: PlanReviewProps = {
    plan,
    starting: false,
    startAvailable: true,
    onStepsChange: vi.fn(),
    onStart: vi.fn(),
    onDiscard: vi.fn(),
    ...over,
  }
  render(
    <QueryClientProvider client={createQueryClient()}>
      <PlanReview {...props} />
      <Toaster />
    </QueryClientProvider>
  )
  return props
}

const steps = () => [...document.querySelectorAll('[data-slot="plan-step"]')] as HTMLElement[]
const startButton = () => screen.getByRole<HTMLButtonElement>('button', { name: /^Start/ })

describe('PlanReview provider availability', () => {
  it('disables Start and exposes accessible setup guidance when starting is unavailable', () => {
    renderPlan({
      startAvailable: false,
      startUnavailableReason: 'Connect an agent provider before starting this plan.',
      startUnavailableAction: <a href="/settings/agents#providers">Configure providers</a>,
    })

    const start = startButton()
    expect(start.disabled).toBe(true)
    expect(start.getAttribute('aria-describedby')).toBe('plan-start-guidance')
    expect(screen.getByText('Connect an agent provider before starting this plan.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Configure providers' }).getAttribute('href')).toBe(
      '/settings/agents#providers'
    )
  })

  it('says nothing at all when there is no reason to give', () => {
    // `startAvailable: false` with no reason must not leave a dangling aria-describedby pointing
    // at an element that was never rendered.
    renderPlan({ startAvailable: false })

    expect(document.getElementById('plan-start-guidance')).toBeNull()
    expect(startButton().getAttribute('aria-describedby')).toBeNull()
    expect(startButton().disabled).toBe(true)
  })

  it('starts once, through the parent', () => {
    const props = renderPlan()

    fireEvent.click(startButton())
    expect(props.onStart).toHaveBeenCalledTimes(1)
  })

  it('says Starting… and refuses a second click while the POST is in flight', () => {
    const props = renderPlan({ starting: true })

    expect(startButton().textContent).toContain('Starting…')
    expect(startButton().disabled).toBe(true)
    fireEvent.click(startButton())
    expect(props.onStart).not.toHaveBeenCalled()
  })
})

describe('PlanReview header', () => {
  it('shows the task line with the full task as its tooltip', () => {
    renderPlan()

    const task = document.querySelector('[data-slot="plan-task"]') as HTMLElement
    expect(task.getAttribute('title')).toBe('Review provider gating')
  })

  it('says the planner was unavailable rather than pretending the plan was reasoned', () => {
    renderPlan({ plan: { ...plan, fallback: true, rationale: 'this must not be shown' } })

    expect(document.querySelector('[data-slot="plan-fallback"]')?.textContent).toContain(
      'planner unavailable'
    )
    // The fallback wins: a rationale from a failed planner would be a lie about why these steps.
    expect(document.querySelector('[data-slot="plan-rationale"]')).toBeNull()
  })

  it("shows the planner's rationale when it produced one", () => {
    renderPlan({ plan: { ...plan, rationale: 'one step is enough here' } })

    expect(document.querySelector('[data-slot="plan-rationale"]')?.textContent).toBe(
      'one step is enough here'
    )
    expect(document.querySelector('[data-slot="plan-fallback"]')).toBeNull()
  })

  it('shows neither line when the planner had nothing to say', () => {
    renderPlan()

    expect(document.querySelector('[data-slot="plan-rationale"]')).toBeNull()
    expect(document.querySelector('[data-slot="plan-fallback"]')).toBeNull()
  })
})

describe('PlanReview step cards', () => {
  it('numbers the steps and badges skills and checks', () => {
    renderPlan({ plan: { ...plan, steps: THREE_STEPS } })

    expect(steps()).toHaveLength(3)
    expect(steps()[0]!.textContent).toContain('01')
    expect(steps()[2]!.textContent).toContain('03')
    expect(steps()[1]!.querySelector('[data-slot="plan-badge-skill"]')?.textContent).toBe(
      'om-implement'
    )
    expect(steps()[2]!.querySelector('[data-slot="plan-badge-check"]')?.textContent).toBe('check')
    // A plain prompt step wears neither badge.
    expect(steps()[0]!.querySelector('[data-slot="plan-badge-skill"]')).toBeNull()
    expect(steps()[0]!.querySelector('[data-slot="plan-badge-check"]')).toBeNull()
  })

  it('offers an empty state and disables both actions once every step is removed', () => {
    renderPlan({ plan: { ...plan, steps: [] } })

    expect(steps()).toHaveLength(0)
    expect(screen.getByText('(no steps left — discard and plan again)')).toBeTruthy()
    expect(startButton().disabled).toBe(true)
    expect(
      (document.querySelector('[data-slot="plan-save"]') as HTMLButtonElement).disabled
    ).toBe(true)
  })
})

describe('PlanReview reordering', () => {
  it('moves a step up and down through the touch-honest buttons', () => {
    const props = renderPlan({ plan: { ...plan, steps: THREE_STEPS } })

    fireEvent.click(screen.getByRole('button', { name: 'Move step 2 up' }))
    expect(props.onStepsChange).toHaveBeenLastCalledWith([
      THREE_STEPS[1],
      THREE_STEPS[0],
      THREE_STEPS[2],
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Move step 1 down' }))
    expect(props.onStepsChange).toHaveBeenLastCalledWith([
      THREE_STEPS[1],
      THREE_STEPS[0],
      THREE_STEPS[2],
    ])
  })

  it('disables the move that would fall off the end', () => {
    renderPlan({ plan: { ...plan, steps: THREE_STEPS } })

    expect(
      (screen.getByRole('button', { name: 'Move step 1 up' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Move step 3 down' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Move step 2 up' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it('removes a step through the parent rather than locally', () => {
    const props = renderPlan({ plan: { ...plan, steps: THREE_STEPS } })

    fireEvent.click(screen.getByRole('button', { name: 'Remove step 2' }))

    // The plan is the parent's draft; this surface only ever proposes the next value.
    expect(props.onStepsChange).toHaveBeenCalledWith([THREE_STEPS[0], THREE_STEPS[2]])
    expect(steps()).toHaveLength(3)
  })

  describe('HTML5 drag and drop', () => {
    it('reorders on a drop onto another card', () => {
      const props = renderPlan({ plan: { ...plan, steps: THREE_STEPS } })

      fireEvent.dragStart(steps()[2]!)
      fireEvent.dragOver(steps()[0]!)
      fireEvent.drop(steps()[0]!)

      expect(props.onStepsChange).toHaveBeenCalledWith([
        THREE_STEPS[2],
        THREE_STEPS[0],
        THREE_STEPS[1],
      ])
    })

    it('dims the dragged card and rings the one it is over', () => {
      renderPlan({ plan: { ...plan, steps: THREE_STEPS } })

      fireEvent.dragStart(steps()[0]!)
      fireEvent.dragOver(steps()[1]!)

      expect(steps()[0]!.className).toContain('opacity-50')
      expect(steps()[1]!.className).toContain('border-ring')

      // Leaving the card it was over drops the ring again.
      fireEvent.dragLeave(steps()[1]!)
      expect(steps()[1]!.className).not.toContain('border-ring')
    })

    it('never rings the card being dragged itself', () => {
      renderPlan({ plan: { ...plan, steps: THREE_STEPS } })

      fireEvent.dragStart(steps()[1]!)
      fireEvent.dragOver(steps()[1]!)

      expect(steps()[1]!.className).not.toContain('border-ring')
    })

    it('changes nothing when a card is dropped on itself', () => {
      const props = renderPlan({ plan: { ...plan, steps: THREE_STEPS } })

      fireEvent.dragStart(steps()[1]!)
      fireEvent.drop(steps()[1]!)

      expect(props.onStepsChange).not.toHaveBeenCalled()
    })

    it('clears the drag state when the drag ends without a drop', () => {
      renderPlan({ plan: { ...plan, steps: THREE_STEPS } })

      fireEvent.dragStart(steps()[0]!)
      fireEvent.dragOver(steps()[1]!)
      fireEvent.dragEnd(steps()[0]!)

      expect(steps()[0]!.className).not.toContain('opacity-50')
      expect(steps()[1]!.className).not.toContain('border-ring')
    })
  })
})

describe('PlanReview discard', () => {
  it('fires from the ✕, the Discard button and Escape — the draft survives either way', () => {
    const props = renderPlan()

    fireEvent.click(screen.getByRole('button', { name: 'Discard the plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(props.onDiscard).toHaveBeenCalledTimes(3)
  })
})

describe('PlanReview — Save as chain', () => {
  const openSaveDialog = () => {
    fireEvent.click(document.querySelector('[data-slot="plan-save"]')!)
    return screen.findByLabelText('Chain name')
  }
  const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: /^Sav/ })

  it('refuses an empty name rather than saving an unnamed chain', async () => {
    const sent = stubFetch()
    renderPlan({ plan: { ...plan, steps: THREE_STEPS } })
    const input = await openSaveDialog()

    expect(saveButton().disabled).toBe(true)
    // Whitespace is not a name either.
    fireEvent.change(input, { target: { value: '   ' } })
    expect(saveButton().disabled).toBe(true)
    fireEvent.submit(input.closest('form')!)
    expect(sent.some((r) => r.method === 'POST')).toBe(false)
  })

  it('POSTs the steps under the trimmed name and toasts the file it wrote', async () => {
    const sent = stubFetch()
    renderPlan({ plan: { ...plan, steps: THREE_STEPS } })
    const input = await openSaveDialog()

    fireEvent.change(input, { target: { value: '  fix-and-verify-v2  ' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      const post = sent.find((r) => r.method === 'POST')
      expect(post?.body).toEqual({ name: 'fix-and-verify-v2', steps: THREE_STEPS })
    })
    // The basename, not the whole path — the toast is a confirmation, not a file browser.
    await waitFor(() => expect(document.body.textContent).toContain('Saved — fix-and-verify-v2.yaml'))
    // The review stays open: saving and starting are independent decisions.
    await waitFor(() => expect(screen.queryByLabelText('Chain name')).toBeNull())
    expect(document.querySelector('[data-slot="plan-review"]')).not.toBeNull()
  })

  it('asks before overwriting an existing chain, then retries with overwrite', async () => {
    const sent = stubFetch((attempt) => (attempt === 1 ? ALREADY_EXISTS() : savedAs('taken')))
    renderPlan({ plan: { ...plan, steps: THREE_STEPS } })
    const input = await openSaveDialog()

    fireEvent.change(input, { target: { value: 'taken' } })
    fireEvent.submit(input.closest('form')!)

    // A 409 is a question, not a failure — nothing is overwritten without an answer.
    const confirm = await screen.findByText('Overwrite “taken”?')
    expect(confirm).toBeTruthy()
    expect(sent.filter((r) => r.method === 'POST')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }))

    await waitFor(() => {
      const second = sent.filter((r) => r.method === 'POST')[1]
      expect(second?.body).toEqual({ name: 'taken', steps: THREE_STEPS, overwrite: true })
    })
    await waitFor(() => expect(document.body.textContent).toContain('Saved — taken.yaml'))
  })

  it('keeps the existing chain when the overwrite is declined', async () => {
    const sent = stubFetch(ALREADY_EXISTS)
    renderPlan({ plan: { ...plan, steps: THREE_STEPS } })
    const input = await openSaveDialog()
    fireEvent.change(input, { target: { value: 'taken' } })
    fireEvent.submit(input.closest('form')!)
    await screen.findByText('Overwrite “taken”?')

    fireEvent.click(screen.getByRole('button', { name: 'Keep the existing chain' }))

    await waitFor(() => expect(screen.queryByText('Overwrite “taken”?')).toBeNull())
    expect(sent.filter((r) => r.method === 'POST')).toHaveLength(1)
  })

  it('surfaces any other save failure as a danger toast, keeping the name box open', async () => {
    stubFetch(() => jsonResponse({ error: 'workflows dir is read-only' }, 500))
    renderPlan({ plan: { ...plan, steps: THREE_STEPS } })
    const input = await openSaveDialog()

    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => expect(document.body.textContent).toContain('workflows dir is read-only'))
    // Not the overwrite question — a 500 is not a name collision.
    expect(screen.queryByText('Overwrite “nope”?')).toBeNull()
    expect(screen.queryByLabelText('Chain name')).not.toBeNull()
  })

  it('closes the name box on Cancel without saving', async () => {
    const sent = stubFetch()
    renderPlan({ plan: { ...plan, steps: THREE_STEPS } })
    const input = await openSaveDialog()
    fireEvent.change(input, { target: { value: 'never-saved' } })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByLabelText('Chain name')).toBeNull())
    expect(sent.some((r) => r.method === 'POST')).toBe(false)
  })
})
