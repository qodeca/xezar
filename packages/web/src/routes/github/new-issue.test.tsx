import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import { setApiScope } from '@qodeca/xezar-api-client'
import type {
  ApiRun,
  GithubData,
  GithubItem,
  HealthResponse,
  ProjectsResponse,
  ProviderStatusResponse,
  Runner,
  Skill,
} from '@qodeca/xezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { GithubRoute } from './github'
import { IssueDraftStrip, newIssueCopy } from './new-issue-dialog'
import { findIssueCreateSkill, newIssueRunBody } from './new-issue-task'

/**
 * "New issue" in the GitHub tab (#468, PR 5) — the acceptance criteria of
 * `designs/issue-filing/README.md` § 12, and IF-14 of the owner's spec:
 *
 *   "If the optional UI is accepted, New issue starts the scoped skill task and preserves the
 *    brief; it does not directly file an issue."
 *
 * Its four falsifiers each have a case here: the wrong skill (AC-3), the wrong project (AC-5), a
 * lost draft (AC-6), a missing unavailable-skill explanation (AC-7), and a direct issue mutation
 * (AC-4). Every one was shown red against a named break before it was accepted — the breaks are
 * listed in the pull request body.
 */

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  localStorage.clear()
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  setApiScope(null)
  vi.unstubAllGlobals()
})

// ---- fixtures ----------------------------------------------------------------------------------

const ISSUE: GithubItem = {
  kind: 'issue',
  number: 142,
  title: 'Login form drops session on refresh',
  author: 'ada',
  createdAt: '2026-07-09T08:00:00.000Z',
  labels: ['bug'],
  body: 'Repro: log in, hit reload.',
  url: 'https://github.com/acme/demo/issues/142',
  comments: 0,
}

const PR: GithubItem = {
  kind: 'pr',
  number: 137,
  title: 'Stream tokens over SSE',
  author: 'grace',
  createdAt: '2026-07-11T08:00:00.000Z',
  labels: [],
  body: '',
  url: 'https://github.com/acme/demo/pull/137',
  comments: 0,
}

const GITHUB: GithubData = {
  available: true,
  repo: 'acme/demo',
  syncedAt: '2026-07-15T08:00:00.000Z',
  issues: [ISSUE],
  prs: [PR],
}

/** The shared procedure as the default collection ships it, plus a project wrapper over it —
 *  the nearest copy is the one the control must run. */
const SHARED_SKILL: Skill = {
  name: 'xez-issue-create',
  description: 'file one issue',
  body: '',
  path: '/team/xez-issue-create.md',
  source: 'team',
}
const PROJECT_SKILL: Skill = {
  name: 'demo-issue-create',
  description: 'file one issue here',
  body: 'the project policy',
  path: '/repo/.ai/skills/demo-issue-create.md',
  source: 'ai',
}
const UNRELATED_SKILL: Skill = {
  name: 'demo-review',
  description: 'review',
  body: '',
  path: '/repo/.ai/skills/demo-review.md',
  source: 'ai',
}

const SKILLS: Skill[] = [SHARED_SKILL, PROJECT_SKILL, UNRELATED_SKILL]

const PROVIDERS: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'not-installed', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
  ],
}

const PROJECTS: ProjectsResponse = {
  projects: [
    {
      id: 'demo',
      name: 'Demo',
      root: '/repo',
      addedAt: '2026-07-01T08:00:00.000Z',
      lastOpenedAt: '2026-07-01T08:00:00.000Z',
      source: 'local',
      status: 'ok',
    },
  ],
  bootProject: 'demo',
  projectsDir: '/projects',
}

const health = (backends: readonly Runner[], localHandoff = true): HealthResponse => ({
  version: '0.0.0-test',
  channel: 'release',
  projects: [],
  bootProject: 'demo',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' },
  checks: backends.map((name) => ({ name, available: true })),
  defaultRunner: backends[0] ?? 'claude',
  forge: null,
  capabilities: {
    localHandoff,
    tokenMetrics: true,
    tokenUsageMetrics: true,
    costMetrics: true,
    followups: true,
    singleProject: false,
    automations: false,
  },
})

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The house-style fetch stub: records requests, serves the fixtures, and lets a test override
 *  specific `METHOD path` keys. Paths are matched by their route SUFFIX so the same overrides
 *  work under an active project scope. */
function stubFetch(overrides: Record<string, () => Response | Promise<Response>> = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      const route = path.replace(/^\/api\/v1(?:\/p\/[^/]+)?/, '')
      const suffix = overrides[`${method} ${route}`]
      if (suffix) return suffix()
      if (method === 'GET' && route.startsWith('/github/comments/')) return jsonResponse({ available: true, comments: [] })
      if (method === 'GET' && route.startsWith('/github/checks')) return jsonResponse({ available: true, checks: {} })
      if (method === 'GET' && route.includes('/github/search')) return jsonResponse({ available: true, items: [] })
      if (method === 'GET' && (route === '/github' || route.startsWith('/github?'))) return jsonResponse(GITHUB)
      if (method === 'GET' && route === '/workflows') return jsonResponse({ workflows: [], issues: [] })
      if (method === 'GET' && route === '/skills') return jsonResponse(SKILLS)
      if (method === 'GET' && route === '/providers/status') return jsonResponse(PROVIDERS)
      if (method === 'GET' && route === '/projects') return jsonResponse(PROJECTS)
      if (method === 'GET' && route.startsWith('/models')) {
        return jsonResponse({ runner: 'claude', models: [], source: 'live', stale: false })
      }
      if (method === 'GET' && route === '/health') return jsonResponse(health(['claude']))
      // The strip reads the live record from this list; the global stream patches it in the app.
      if (method === 'GET' && route === '/runs') return jsonResponse([])
      if (method === 'POST' && route === '/runs') {
        return jsonResponse({
          id: 'run-issue-1',
          title: 'queued',
          workflow: 'quick-task',
          task: 't',
          status: 'queued',
          createdAt: '2026-07-15T08:00:00.000Z',
          tokensUsed: 0,
          archived: false,
          steps: [],
        })
      }
      return jsonResponse({})
    }),
  )
  return sent
}

function renderAt(entry: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/github" element={<GithubRoute view="issues" index />} />
          <Route path="/github/prs" element={<GithubRoute view="prs" />} />
          <Route path="/github/issues/:n" element={<GithubRoute view="issues" />} />
          <Route path="/p/:projectId/github" element={<GithubRoute view="issues" index />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const newIssueButton = () => document.querySelector<HTMLButtonElement>('[data-action="gh-new-issue"]')
const startButton = () => document.querySelector<HTMLButtonElement>('[data-action="gh-new-issue-start"]')
const briefField = () => document.querySelector<HTMLTextAreaElement>('[data-slot="gh-new-issue-brief"]')!
const postedRun = (sent: readonly SentRequest[]) =>
  sent.find((request) => request.method === 'POST' && request.path.endsWith('/runs'))

/** Open the tab, then the dialog. */
async function openDialog(entry = '/github') {
  renderAt(entry)
  await waitFor(() => expect(newIssueButton()).not.toBeNull())
  fireEvent.click(newIssueButton()!)
  await waitFor(() => expect(briefField()).not.toBeNull())
}

const type = (text: string) => fireEvent.change(briefField(), { target: { value: text } })

/** Every brief the draft store holds right now, across every project key. Read through
 *  `localStorage` itself rather than through the module, so the assertion is about what survives
 *  a reload and not about what the module would tell us. */
const storedBriefs = () =>
  Object.keys(localStorage)
    .filter((k) => k.startsWith('xez-new-issue-brief:'))
    .sort()
    .map((k) => localStorage.getItem(k))

/** Put words in the list's search box — the source of the dialog's pre-fill (OQ-4). */
const search = (text: string) =>
  fireEvent.change(screen.getByLabelText('Search issues'), { target: { value: text } })

// ---- the control -------------------------------------------------------------------------------

describe('the New issue control', () => {
  it('AC-1 appears on the issues view and on the pull-requests view', async () => {
    stubFetch()
    renderAt('/github')
    await waitFor(() => expect(newIssueButton()).not.toBeNull())
    expect(newIssueButton()!.textContent).toContain(newIssueCopy.button)

    cleanup()
    stubFetch()
    renderAt('/github/prs')
    await waitFor(() => expect(newIssueButton()).not.toBeNull())
  })

  it('AC-10 renders no control at all when GitHub is unavailable', async () => {
    stubFetch({ 'GET /github?limit=1000': () => jsonResponse({ available: false, reason: 'gh is not installed' }) })
    renderAt('/github')
    await waitFor(() => expect(screen.getByText('GitHub is unavailable here')).not.toBeNull())
    expect(newIssueButton()).toBeNull()
    expect(document.querySelector('[data-action="gh-new-issue-empty"]')).toBeNull()
  })

  it('AC-11 renders no control while the tab is loading, nor when it errored', async () => {
    stubFetch({ 'GET /github?limit=1000': () => new Promise<Response>(() => {}) })
    renderAt('/github')
    await waitFor(() => expect(document.querySelector('[data-slot="gh-loading"], [data-route="github"]')).not.toBeNull())
    expect(newIssueButton()).toBeNull()

    cleanup()
    // A 4xx, not a 5xx: the client retries a 500 once, and the retry's backoff outlives this
    // assertion's window. The branch under test is `list.isError`, which both reach.
    stubFetch({ 'GET /github?limit=1000': () => jsonResponse({ error: 'boom' }, 400) })
    renderAt('/github')
    await waitFor(() => expect(screen.getByText('Could not load GitHub')).not.toBeNull())
    expect(newIssueButton()).toBeNull()
  })

  it('offers a second entry under an empty list, and pre-fills the search words', async () => {
    stubFetch({ 'GET /github?limit=1000': () => jsonResponse({ ...GITHUB, issues: [] }) })
    renderAt('/github')
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-empty-new-issue"]')?.textContent).toContain(
        newIssueCopy.emptyListLead,
      ),
    )
    // Search first, then wait for the entry to come back: while a forge search is in flight the
    // honest thing on screen is the spinner, so the entry is deliberately absent.
    fireEvent.change(screen.getByLabelText('Search issues'), { target: { value: 'worktree lease' } })
    const empty = await waitFor(
      () => {
        const button = document.querySelector<HTMLButtonElement>('[data-action="gh-new-issue-empty"]')
        expect(button).not.toBeNull()
        return button!
      },
      { timeout: 3000 },
    )
    fireEvent.click(empty)
    await waitFor(() => expect(briefField().value).toBe('worktree lease'))
  })
})

// ---- what starting does ---------------------------------------------------------------------------

describe('starting an issue draft', () => {
  it('AC-2 names the destination repository and the project', async () => {
    stubFetch()
    await openDialog()
    const destination = document.querySelector('[data-slot="gh-new-issue-destination"]')!
    expect(destination.textContent).toContain('acme/demo')
    expect(destination.textContent).toContain('Demo')
  })

  it('AC-3/AC-4 posts exactly one run with the skill step, the typed brief and no autonomous flag', async () => {
    const sent = stubFetch()
    await openDialog()
    type('The session is dropped on reload.')
    await waitFor(() => expect(startButton()!.disabled).toBe(false))
    fireEvent.click(startButton()!)

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    const posted = postedRun(sent)!
    expect(posted.body).toEqual({
      task: 'The session is dropped on reload.',
      steps: [
        { id: 'task', name: 'demo-issue-create', skill: 'demo-issue-create', prompt: '{{task}}' },
      ],
      runner: 'claude',
    })
    // IF-14: the control files nothing itself. Only the ordinary task API is touched — no issue
    // route, no forge write, no mutation of any kind.
    const mutations = sent.filter((request) => request.method !== 'GET')
    expect(mutations.map((request) => `${request.method} ${request.path}`)).toEqual(['POST /api/v1/runs'])
  })

  it('AC-5 creates the task in the project the route is scoped to', async () => {
    const sent = stubFetch()
    setApiScope('other-project')
    await openDialog('/p/other-project/github')
    type('Something else entirely.')
    await waitFor(() => expect(startButton()!.disabled).toBe(false))
    fireEvent.click(startButton()!)

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)!.path).toBe('/api/v1/p/other-project/runs')
  })

  it('AC-6 keeps the brief across a close, a reload and a failed start', async () => {
    stubFetch({ 'POST /runs': () => jsonResponse({ error: 'the queue is full' }, 409) })
    await openDialog()
    type('Two sentences of context.')

    fireEvent.click(screen.getByRole('button', { name: newIssueCopy.cancel }))
    await waitFor(() => expect(document.querySelector('[data-slot="gh-new-issue-brief"]')).toBeNull())
    fireEvent.click(newIssueButton()!)
    await waitFor(() => expect(briefField().value).toBe('Two sentences of context.'))

    // A RELOAD, not just a close: the whole tab is unmounted and mounted again. Component state
    // survives a close on its own — only the store survives this, which is what the criterion is
    // actually about, and what a `useState`-only dialog would lose.
    cleanup()
    stubFetch({ 'POST /runs': () => jsonResponse({ error: 'the queue is full' }, 409) })
    await openDialog()
    expect(briefField().value).toBe('Two sentences of context.')

    fireEvent.click(startButton()!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-new-issue-error"]')?.textContent).toContain(
        'Your text is still here.',
      ),
    )
    expect(briefField().value).toBe('Two sentences of context.')
    expect(document.querySelector('[data-slot="gh-new-issue-error"]')?.getAttribute('role')).toBe('alert')
  })

  it('AC-9 keeps working in hosted mode and says whose login files the issue', async () => {
    stubFetch({ 'GET /health': () => jsonResponse(health(['claude'], false)) })
    await openDialog()
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-new-issue-hosted"]')?.textContent).toBe(
        newIssueCopy.hosted,
      ),
    )
    type('Filed from a hosted cockpit.')
    await waitFor(() => expect(startButton()!.disabled).toBe(false))
  })

  it('names WHICH issue-filing skill it resolved, not just that there is one', async () => {
    stubFetch()
    await openDialog()
    const link = document.querySelector('[data-slot="gh-new-issue-view-skill"]')!
    expect(link.textContent).toContain(newIssueCopy.viewSkill)
    // The project's own wrapper, the copy the lookup actually picked — three sources can supply a
    // `*-issue-create` and the label alone would not say which procedure is about to run.
    expect(link.textContent).toContain('demo-issue-create')
  })

  it('names the reason the disabled start is disabled, and links it to the button', async () => {
    stubFetch()
    await openDialog()
    expect(startButton()!.disabled).toBe(true)
    const reasonId = startButton()!.getAttribute('aria-describedby')!
    expect(document.getElementById(reasonId)?.textContent).toBe(newIssueCopy.emptyBriefHint)
  })
})

// ---- the pre-fill and the draft store ---------------------------------------------------------------

/**
 * OQ-4's second sentence, which AC-6 alone does not cover:
 *
 *   "The draft store must treat a pre-fill as untouched, so it is not persisted as a draft for a
 *    dialog the person closed without typing." (`designs/issue-filing/open-questions.md:83-84`)
 *
 * AC-6 above asserts that a brief SURVIVES, and passes whether or not the pre-fill is persisted.
 * These three cases split the two halves apart, so neither can pass for the other's reason:
 * seeding alone must never write, editing must always write, and a stored draft must outrank the
 * seed AND survive being outranked.
 */
describe('the pre-fill and the draft store (OQ-4)', () => {
  it('leaves no draft behind when a pre-filled dialog is closed untouched', async () => {
    stubFetch()
    renderAt('/github')
    await waitFor(() => expect(newIssueButton()).not.toBeNull())
    search('worktree lease')
    fireEvent.click(newIssueButton()!)
    await waitFor(() => expect(briefField().value).toBe('worktree lease'))

    // Cancel without typing a character. The words were OFFERED; nothing was authored.
    fireEvent.click(screen.getByRole('button', { name: newIssueCopy.cancel }))
    await waitFor(() => expect(document.querySelector('[data-slot="gh-new-issue-brief"]')).toBeNull())
    expect(storedBriefs()).toEqual([])
  })

  it('persists the brief as a draft as soon as the person edits the pre-fill', async () => {
    stubFetch()
    renderAt('/github')
    await waitFor(() => expect(newIssueButton()).not.toBeNull())
    search('worktree lease')
    fireEvent.click(newIssueButton()!)
    await waitFor(() => expect(briefField().value).toBe('worktree lease'))

    // Editing it is authoring it — and the pre-fill stays editable, which is the other half of
    // OQ-4's decision ("offered, as the first line, editable").
    type('worktree lease is dropped when the run is reclaimed')
    await waitFor(() =>
      expect(storedBriefs()).toEqual(['worktree lease is dropped when the run is reclaimed']),
    )
    fireEvent.click(screen.getByRole('button', { name: newIssueCopy.cancel }))
    await waitFor(() => expect(document.querySelector('[data-slot="gh-new-issue-brief"]')).toBeNull())
    expect(storedBriefs()).toEqual(['worktree lease is dropped when the run is reclaimed'])
  })

  it('lets a stored draft win over the pre-fill, and never deletes it', async () => {
    localStorage.setItem('xez-new-issue-brief:default', 'The brief I started yesterday.')
    stubFetch()
    renderAt('/github')
    await waitFor(() => expect(newIssueButton()).not.toBeNull())
    search('worktree lease')
    fireEvent.click(newIssueButton()!)
    await waitFor(() => expect(briefField()).not.toBeNull())

    expect(briefField().value).toBe('The brief I started yesterday.')
    // A guard that keyed off "untouched" alone would read the restored draft as a seed and wipe
    // it on the very next effect — the failure mode the correction has to avoid.
    expect(storedBriefs()).toEqual(['The brief I started yesterday.'])
  })
})

// ---- the skill is not installed --------------------------------------------------------------------

describe('when no issue-filing skill is installed', () => {
  const noSkills = () => stubFetch({ 'GET /skills': () => jsonResponse([UNRELATED_SKILL]) })

  it('AC-7 still opens, explains what is lost, keeps the brief and disables Start drafting', async () => {
    noSkills()
    await openDialog()
    type('A brief that must survive.')
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-new-issue-skill-missing"]')?.textContent).toContain(
        newIssueCopy.skillMissing,
      ),
    )
    expect(startButton()!.disabled).toBe(true)
    expect(briefField().value).toBe('A brief that must survive.')
    expect(document.querySelector('[data-action="gh-new-issue-plain"]')).not.toBeNull()
    expect(screen.getByRole('link', { name: newIssueCopy.skillMissingManage }).getAttribute('href')).toBe('/skills')
  })

  it('AC-8 the ordinary-task fallback posts the same brief with no skill', async () => {
    const sent = noSkills()
    await openDialog()
    type('A brief that must survive.')
    const plain = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-action="gh-new-issue-plain"]')!
      expect(button.disabled).toBe(false)
      return button
    })
    fireEvent.click(plain)

    await waitFor(() => expect(postedRun(sent)).toBeDefined())
    expect(postedRun(sent)!.body).toEqual({
      task: 'A brief that must survive.',
      workflow: 'quick-task',
      runner: 'claude',
    })
  })
})

// ---- the strip -------------------------------------------------------------------------------------

describe('the draft strip', () => {
  const run = (over: Partial<ApiRun>): ApiRun =>
    ({
      id: 'run-issue-1',
      title: 'issue draft',
      workflow: 'quick-task',
      task: 'draft it',
      status: 'running',
      createdAt: '2026-07-15T08:00:00.000Z',
      tokensUsed: 0,
      archived: false,
      steps: [],
      ...over,
    }) as ApiRun

  const mountStrip = (record: ApiRun | null) => {
    const client = createQueryClient()
    if (record) client.setQueryData(queryKeys.runs.list(), [record])
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <IssueDraftStrip runId={record ? record.id : null} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('AC-12 announces the running draft politely and changes its sentence when it asks', () => {
    mountStrip(run({ status: 'running' }))
    const strip = screen.getByRole('status')
    expect(strip.textContent).toContain('Drafting an issue')
    expect(screen.getByRole('link').textContent).toContain('View task →')

    cleanup()
    mountStrip(run({ status: 'waiting' }))
    expect(screen.getByRole('status').textContent).toContain('Create or Revise')
    expect(screen.getByRole('link').textContent).toContain('Answer →')
  })

  it('shows nothing before a draft exists, and nothing once it has finished', () => {
    mountStrip(null)
    expect(screen.queryByRole('status')).toBeNull()

    cleanup()
    mountStrip(run({ status: 'done' }))
    expect(screen.queryByRole('status')).toBeNull()
  })
})

// ---- the pure rules --------------------------------------------------------------------------------

describe('the skill lookup and the run body', () => {
  it('prefers the project’s own wrapper over the shared collection, and answers null for neither', () => {
    expect(findIssueCreateSkill(SKILLS)?.name).toBe('demo-issue-create')
    expect(findIssueCreateSkill([SHARED_SKILL])?.name).toBe('xez-issue-create')
    expect(findIssueCreateSkill([UNRELATED_SKILL])).toBeNull()
    // A suffix, not a substring: a skill that merely mentions the words is not the procedure.
    expect(findIssueCreateSkill([{ ...UNRELATED_SKILL, name: 'issue-create-helper' }])).toBeNull()
  })

  it('breaks a tie between two equally near copies by the catalog’s own order', () => {
    // `ai`, `xezar` and `agents` all rank 0, so two repository-local copies are separated only by
    // the order the catalog hands them over. The sort is stable, so that order is the answer — and
    // this pins it, because the rank cases above pass whichever copy wins a tie.
    const inAi: Skill = { ...PROJECT_SKILL, name: 'alpha-issue-create', source: 'ai' }
    const inXezar: Skill = { ...PROJECT_SKILL, name: 'beta-issue-create', source: 'xezar' }
    expect(findIssueCreateSkill([inAi, inXezar])?.name).toBe('alpha-issue-create')
    expect(findIssueCreateSkill([inXezar, inAi])?.name).toBe('beta-issue-create')
  })

  it('never sends an autonomous flag, and never a worktree override', () => {
    const body = newIssueRunBody('a brief', 'demo-issue-create', {
      runner: 'claude',
      runnerExplicit: false,
      defaultRunner: 'claude',
      model: '',
      account: null,
    })
    expect(body.autonomous).toBeUndefined()
    expect(body.worktree).toBeUndefined()
    expect(body.steps).toEqual([
      { id: 'task', name: 'demo-issue-create', skill: 'demo-issue-create', prompt: '{{task}}' },
    ])
  })
})
