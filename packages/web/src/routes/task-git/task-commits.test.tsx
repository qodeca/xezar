import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type {
  ApiRun,
  HealthResponse,
  RepoCommitPayload,
  RepoResponse,
  RunCommitsResponse,
} from '@qodeca/xezar-api-client'

import { TaskCommitsRoute } from './task-commits'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

const RUN: ApiRun = {
  id: 'r1',
  title: 'do the thing plz',
  titleSummary: 'Do the thing',
  workflow: 'quick-task',
  task: 'Summarize what this project does.',
  status: 'review',
  createdAt: '2026-07-15T08:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  worktreePath: '/tmp/wt/r1',
  branch: 'xez/abc12345',
  baseBranch: 'main',
  steps: [
    { id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 's-1' },
  ],
}

const HEALTH: HealthResponse = {
  version: '0.0.0-test',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main', remote: 'git@github.com:acme/demo.git' },
  checks: [],
  defaultRunner: 'claude',
  forge: { kind: 'github', available: true },
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false },
}

const REPO: RepoResponse = {
  info: { root: '/repo', branch: 'main', remote: 'git@github.com:acme/demo.git' },
  status: [],
  log: [],
  branches: ['main'],
  baseBranch: null,
}

const SHA_ONE = '1111111111111111111111111111111111111111'
const SHA_TWO = '2222222222222222222222222222222222222222'

const COMMITS: RunCommitsResponse = {
  commits: [
    { sha: SHA_ONE, subject: 'feat: add the notes file', author: 'agent', when: '2 minutes ago' },
    { sha: SHA_TWO, subject: 'chore: autosave', author: 'agent', when: '9 minutes ago' },
  ],
}

const COMMIT_ONE: RepoCommitPayload = {
  sha: SHA_ONE,
  subject: 'feat: add the notes file',
  author: 'agent',
  when: '2 minutes ago',
  files: [
    {
      path: 'notes.md',
      status: 'added',
      adds: 2,
      dels: 0,
      binary: false,
      patch: 'diff --git a/notes.md b/notes.md\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+one\n+two\n',
    },
  ],
  stat: { adds: 2, dels: 0, files: 1 },
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the sibling's house style (task-changes.test.tsx): serves the run, health,
 *  repo and commit fixtures, and lets a test override specific `METHOD path` keys. */
function stubFetch(overrides: Record<string, () => Response | Promise<Response>> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === '/api/v1/runs/r1') return jsonResponse(RUN)
      if (method === 'GET' && path === '/api/v1/runs/r1/commits') return jsonResponse(COMMITS)
      if (method === 'GET' && path === `/api/v1/runs/r1/commit/${SHA_ONE}`) return jsonResponse(COMMIT_ONE)
      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(HEALTH)
      if (method === 'GET' && path === '/api/v1/repo') return jsonResponse(REPO)
      if (method === 'GET' && path === '/api/v1/runs') return jsonResponse([])
      return jsonResponse({})
    }),
  )
}

/** The address bar, readable from assertions — MemoryRouter keeps its location internal. */
function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location" data-pathname={location.pathname} />
}

/** Both commits URLs mounted on the SAME component, exactly as routes.tsx registers them, so a
 *  row click really navigates from the list to the one-commit view. */
function renderCommitsRoute(entry = '/tasks/r1/commits') {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/tasks/:id/commits" element={<TaskCommitsRoute />} />
          <Route path="/tasks/:id/commits/:sha" element={<TaskCommitsRoute />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const currentPathname = () => screen.getByTestId('location').getAttribute('data-pathname')

const commitRows = () => [...document.querySelectorAll('[data-slot="commit-row"]')] as HTMLAnchorElement[]

// ---- the route -------------------------------------------------------------------------------

describe('the Commits tab route', () => {
  it('renders the run header with the Commits tab active and one row per commit', async () => {
    stubFetch()
    renderCommitsRoute()

    await waitFor(() => expect(document.querySelector('[data-slot="run-header"]')).not.toBeNull())
    expect(document.querySelector('[data-route="task-commits"]')).not.toBeNull()

    const tabs = [...document.querySelectorAll('[data-slot="run-tabs"] a')].map((a) => ({
      text: a.textContent,
      href: a.getAttribute('href'),
      current: a.getAttribute('aria-current'),
    }))
    expect(tabs).toEqual([
      { text: 'Session', href: '/tasks/r1', current: null },
      { text: 'Changes', href: '/tasks/r1/changes', current: null },
      { text: 'Commits', href: '/tasks/r1/commits', current: 'page' },
      { text: 'Files', href: '/tasks/r1/files', current: null },
    ])

    await waitFor(() => expect(commitRows()).toHaveLength(2))
    // The row carries the full sha but shows the abbreviation, and deep-links to this run's
    // commit URL — that mapping is the route's own work, not the list component's.
    expect(commitRows().map((a) => a.getAttribute('data-sha'))).toEqual([SHA_ONE, SHA_TWO])
    expect(commitRows()[0]!.getAttribute('href')).toBe(`/tasks/r1/commits/${SHA_ONE}`)
    expect(commitRows()[0]!.textContent).toContain(SHA_ONE.slice(0, 8))
    expect(commitRows()[0]!.textContent).toContain('feat: add the notes file')
    expect(commitRows()[1]!.textContent).toContain('chore: autosave')
  })

  it('opens the selected commit at /commits/:sha and renders its diff', async () => {
    stubFetch()
    renderCommitsRoute()

    await waitFor(() => expect(commitRows()).toHaveLength(2))
    fireEvent.click(commitRows()[0]!)

    await waitFor(() => expect(currentPathname()).toBe(`/tasks/r1/commits/${SHA_ONE}`))
    await waitFor(() =>
      expect(document.querySelector('[data-slot="task-commit"]')?.getAttribute('data-sha')).toBe(SHA_ONE),
    )
    // The commit's own metadata, then its structured diff through the shared facade (the engine
    // chunk is lazy — wait for it).
    await waitFor(() =>
      expect(document.querySelector('[data-slot="commit-meta"]')?.textContent).toContain(
        'feat: add the notes file',
      ),
    )
    expect(document.querySelector('[data-slot="commit-meta"]')?.textContent).toContain(SHA_ONE)
    await waitFor(() => expect(document.querySelectorAll('[data-slot="diff-file"]')).toHaveLength(1))
    // The header stays, and the way back to the list is a real link.
    expect(document.querySelector('[data-slot="run-header"]')).not.toBeNull()
    expect(
      document.querySelector('[data-slot="commit-back"]')?.getAttribute('href'),
    ).toBe('/tasks/r1/commits')
  })

  // The named 409 test: a task that ran without a worktree has no branch to log, and the server
  // says so with a 409. That is a real answer, not a failure — it must read as an explanation
  // rather than as a blank panel or a red error.
  it('a 409 ("no worktree") renders the server reason as a neutral explanation', async () => {
    stubFetch({
      'GET /api/v1/runs/r1/commits': () =>
        jsonResponse({ error: 'no worktree — this task ran directly in the repo working tree' }, 409),
    })
    renderCommitsRoute()

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'No commits to show' })).toBeTruthy(),
    )
    const state = document.querySelector('[data-slot="centered-state"]')
    expect(state?.textContent).toContain('no worktree — this task ran directly in the repo working tree')
    // Neutral, not danger — the panel is an explanation, and it is not empty.
    expect(state?.getAttribute('data-tone')).toBe('neutral')
    expect(commitRows()).toHaveLength(0)
  })

  it('any other commit-list failure reads as an error, not as "no commits"', async () => {
    stubFetch({
      'GET /api/v1/runs/r1/commits': () => jsonResponse({ error: 'git exploded' }, 500),
    })
    renderCommitsRoute()

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Could not load the commits' })).toBeTruthy(),
    )
    expect(document.querySelector('[data-slot="centered-state"]')?.getAttribute('data-tone')).toBe('danger')
  })

  it('renders the loading line until the commit list answers', async () => {
    stubFetch({ 'GET /api/v1/runs/r1/commits': () => new Promise<Response>(() => {}) })
    renderCommitsRoute()

    await waitFor(() => expect(document.querySelector('[data-slot="commits-loading"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="commits-loading"]')?.textContent).toContain('Loading commits…')
    // Honestly loading: no rows, and no empty state claiming there is nothing to show.
    expect(commitRows()).toHaveLength(0)
    expect(screen.queryByRole('heading', { level: 2, name: 'No commits yet' })).toBeNull()
  })

  it('a run that committed nothing renders the empty state', async () => {
    stubFetch({ 'GET /api/v1/runs/r1/commits': () => jsonResponse({ commits: [] }) })
    renderCommitsRoute()

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'No commits yet' })).toBeTruthy(),
    )
    expect(document.querySelector('[data-slot="centered-state"]')?.textContent).toContain(
      'Autosave commits and any the agent makes appear here.',
    )
  })

  it('a deep link to a commit the run does not have says so instead of showing an empty diff', async () => {
    stubFetch({
      [`GET /api/v1/runs/r1/commit/${SHA_TWO}`]: () => jsonResponse({ error: 'unknown commit' }, 409),
    })
    renderCommitsRoute(`/tasks/r1/commits/${SHA_TWO}`)

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'Commit not found' })).toBeTruthy(),
    )
    expect(document.querySelector('[data-slot="centered-state"]')?.getAttribute('data-tone')).toBe('neutral')
  })

  it('a commit that carries no diff of its own explains itself', async () => {
    stubFetch({
      [`GET /api/v1/runs/r1/commit/${SHA_ONE}`]: () =>
        jsonResponse({ ...COMMIT_ONE, files: [], stat: { adds: 0, dels: 0, files: 0 } }),
    })
    renderCommitsRoute(`/tasks/r1/commits/${SHA_ONE}`)

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: 'No file changes' })).toBeTruthy(),
    )
    expect(document.querySelectorAll('[data-slot="diff-file"]')).toHaveLength(0)
  })

  it('holds the loading line while one commit is still in flight', async () => {
    stubFetch({ [`GET /api/v1/runs/r1/commit/${SHA_ONE}`]: () => new Promise<Response>(() => {}) })
    renderCommitsRoute(`/tasks/r1/commits/${SHA_ONE}`)

    await waitFor(() => expect(document.querySelector('[data-slot="commit-loading"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="commit-loading"]')?.textContent).toContain('Loading commit…')
  })

  it('a dead task id renders the run-level error, not an empty commits tab', async () => {
    stubFetch({ 'GET /api/v1/runs/r1': () => jsonResponse({ error: 'not found' }, 404) })
    renderCommitsRoute()

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Task not found' })).toBeTruthy())
    expect(document.querySelector('[data-route="task-commits"]')).toBeNull()
  })
})
