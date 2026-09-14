import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import { type HealthResponse, mcpLeaderActionInputSchema, type ProjectsResponse } from '@qodeca/xezar-api-client'
import { EventJournal } from '../../../../xezar/src/mcp/event-journal.ts'
import { LeaderDelivery } from '../../../../xezar/src/mcp/leader-delivery.ts'
import { McpConnectionSection } from './mcp-connection-section'

/**
 * #404 merge review, major 1: an attachment RETAINED across an owner change. Attach Claude Code, let
 * its session close, then let a Codex session take the project and announce its thread. The delivery
 * keeps the Claude Code attachment (a compatible Claude reconnect must keep working), so its status
 * is owner `codex`, leader `claude-code`, blocker `claude-code-not-owner` — and the control used to
 * take the attach client from that stale leader, hide the selector, and post `claude-code` again,
 * which the server refuses again. There was no cockpit path to attach the new owner.
 *
 * This drives the transition THROUGH the control against the REAL delivery class — the fetch mock is
 * a thin `GET → status()` / `POST → act()` shim, never a hand-written status — so the state the
 * control is judged on is the one `LeaderDelivery` really answers. The reach into `packages/xezar/src`
 * is test-only and ugly on purpose (AGENTS.md § Repository layout): the two halves are proven apart
 * everywhere else, and this is the one case that is about their composition.
 */

const fetchMock = vi.fn<typeof fetch>()

const HEALTH: HealthResponse = {
  version: '0.1.5',
  projects: [],
  bootProject: 'alpha',
  repoRoot: '/home/me/Projects/alpha',
  repo: { root: '/home/me/Projects/alpha', branch: 'main' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false },
}

const REGISTRY: ProjectsResponse = {
  projects: [{ id: 'alpha', name: 'alpha', root: '/home/me/Projects/alpha', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok' }],
  bootProject: 'alpha',
  projectsDir: '~/xezar/projects',
}

const PROJECT = 'alpha'
const dirs: string[] = []
const journals: EventJournal[] = []
const deliveries: LeaderDelivery[] = []

type Connect = NonNullable<NonNullable<ConstructorParameters<typeof LeaderDelivery>[0]['codexLeader']>['connect']>

/** An app-server link for one loaded, idle thread: what a real Codex TUI session looks like to xezar. */
function codexLink(threadId: string) {
  let closed = false
  const link = {
    get closed() {
      return closed
    },
    subscribe: () => () => {},
    async request(method: string): Promise<Record<string, unknown>> {
      if (method === 'thread/loaded/list') return { data: [threadId] }
      if (method === 'thread/resume') return { thread: { id: threadId, status: { type: 'idle' } } }
      if (method === 'thread/turns/list') return { data: [] }
      return {}
    },
    close: () => {
      closed = true
    },
  }
  return link
}

/** The real delivery over a real journal; only the owner slot and the Codex dial are stubs. */
function realDelivery() {
  const dataDir = realpathSync(mkdtempSync('/tmp/xz-owner-switch-'))
  dirs.push(dataDir)
  const journal = EventJournal.open({ dataDir, projectId: PROJECT, secretValues: [], warn: () => {} })
  journals.push(journal)
  const dialed: string[] = []
  const connect: Connect = async (announcement) => {
    dialed.push(announcement.threadId)
    return { threadId: announcement.threadId, link: codexLink(announcement.threadId), state: { waiting: false } }
  }
  const made = new LeaderDelivery({
    projectId: PROJECT,
    projectRoot: dataDir,
    journal,
    ownership: { projectId: PROJECT, sessionToken: () => 'token', state: () => 'owned' },
    guard: undefined,
    warn: () => {},
    heartbeatMs: 60_000,
    codexLeader: { home: () => dataDir, connect },
  })
  deliveries.push(made)
  return { made, dialed }
}

/** The section over the real delivery: GET reads `status()`, POST runs `act()`, as the route does. */
function mount(made: LeaderDelivery) {
  const posted: unknown[] = []
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input)
    const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } })
    if (path === '/api/v1/health') return json(HEALTH)
    if (path === '/api/v1/projects') return json(REGISTRY)
    if (path === '/api/v1/mcp/leader' && (init?.method ?? 'GET') === 'POST') {
      const body = mcpLeaderActionInputSchema.parse(JSON.parse(String(init?.body)))
      posted.push(body)
      const out = await made.act(body)
      return out.ok ? json(out.status) : json({ error: out.error }, 409)
    }
    if (path === '/api/v1/mcp/leader') return json(made.status())
    return json({ error: 'not found' }, 404)
  })
  const view = render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/p/alpha/settings/mcp-connection']}>
        <ProjectScopeProvider projectId={null}>
          <McpConnectionSection />
        </ProjectScopeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const control = async (): Promise<Element> => {
    await waitFor(() => expect(view.container.querySelector('[data-slot="mcp-leader"]')).toBeTruthy())
    return view.container.querySelector('[data-slot="mcp-leader"]')!
  }
  return { ...view, posted, control }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
  for (const delivery of deliveries.splice(0)) delivery.close()
  for (const journal of journals.splice(0)) journal.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the leader control when the owner changed under a retained attachment (#404 merge review, major 1)', () => {
  it('shows the selector defaulting to the new owner, and Attach leader replaces the stale Claude Code attachment with the Codex owner', async () => {
    // RED against: `derived = status.leader?.client ?? status.owner?.client` — the stale leader wins,
    // the selector is hidden, and the only Attach posts `claude-code`, refused again by the server.
    const { made, dialed } = realDelivery()
    made.sessionOpened('claude', { push: async () => {}, clientName: 'claude-code', leaderPush: true })
    expect((await made.act({ action: 'attach', client: 'claude-code' })).ok).toBe(true)
    made.sessionClosed('claude')
    made.sessionOpened('codex', { push: async () => {}, clientName: 'codex-cli', leaderPush: false })
    made.codexAnnounced('codex', { threadId: 'thread-codex' })
    // The real state the control is judged on — read from the class, not written by this test.
    expect(made.status()).toMatchObject({ owner: { client: 'codex' }, leader: { client: 'claude-code', state: 'attached' }, blocker: { code: 'claude-code-not-owner' } })

    const view = mount(made)
    const control = await view.control()
    expect(control.getAttribute('data-state')).toBe('blocked')
    expect(control.querySelector('[data-slot="mcp-leader-owner"]')?.textContent).toBe('Codex')
    expect(control.querySelector('[data-slot="mcp-leader-attached"]')?.textContent).toBe('Claude Code, attached')
    expect(control.querySelector('[data-slot="mcp-leader-blocker"]')?.getAttribute('data-code')).toBe('claude-code-not-owner')
    // The selector is back, and it defaults to the client that owns the project now.
    const selector = control.querySelector('[role="radiogroup"]')
    expect(selector).toBeTruthy()
    expect(selector?.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute('data-value')).toBe('codex')
    expect(control.querySelector('[data-slot="mcp-leader-note"]')?.textContent).toContain('shared local app-server')
    // The person is told this is a replacement, before they choose it.
    expect(control.querySelector('[data-slot="mcp-leader-replace"]')?.textContent).toContain('replaces the attached Claude Code')

    fireEvent.click(control.querySelector<HTMLButtonElement>('[data-slot="mcp-leader-attach-button"]')!)
    await waitFor(() => expect(view.container.querySelector('[data-slot="mcp-leader"]')?.getAttribute('data-state')).toBe('delivering'))
    expect(view.posted).toEqual([{ action: 'attach', client: 'codex' }])
    // The real class dialled the announced thread and now holds the Codex leader; the stale one is gone.
    expect(dialed).toEqual(['thread-codex'])
    expect(made.status()).toMatchObject({ owner: { client: 'codex' }, leader: { client: 'codex', state: 'attached' }, blocker: null })
    const after = view.container.querySelector('[data-slot="mcp-leader"]')!
    expect(after.querySelector('[data-slot="mcp-leader-summary"]')?.textContent).toBe('Codex connected. Project events can start a turn in your current session.')
    expect(after.querySelector('[data-slot="mcp-leader-attached"]')?.textContent).toBe('Codex, attached')
    expect(after.querySelector('[role="radiogroup"]')).toBeNull()
  })

  it('keeps the person’s own pick over the default: Claude Code can be chosen again, and the server’s refusal is shown in its words', async () => {
    // RED against: the selector defaulting to the owner but not offering the other clients — a
    // person who restarted Claude Code with the flag must still be able to say so.
    const { made } = realDelivery()
    made.sessionOpened('claude', { push: async () => {}, clientName: 'claude-code', leaderPush: true })
    expect((await made.act({ action: 'attach', client: 'claude-code' })).ok).toBe(true)
    made.sessionClosed('claude')
    made.sessionOpened('codex', { push: async () => {}, clientName: 'codex-cli', leaderPush: false })
    made.codexAnnounced('codex', { threadId: 'thread-codex' })

    const view = mount(made)
    const control = await view.control()
    fireEvent.click(control.querySelector('[role="radio"][data-value="claude-code"]')!)
    expect(control.querySelector('[role="radio"][data-value="claude-code"]')?.getAttribute('aria-checked')).toBe('true')
    expect(control.querySelector('[data-slot="mcp-leader-note"]')?.textContent).toContain('--dangerously-load-development-channels server:xezar')
    fireEvent.click(control.querySelector<HTMLButtonElement>('[data-slot="mcp-leader-attach-button"]')!)
    await waitFor(() => expect(view.posted).toHaveLength(1))
    expect(view.posted).toEqual([{ action: 'attach', client: 'claude-code' }])
    // Refused by the real class, in Claude Code's words; the Claude Code attachment is kept, the
    // status still names the blocker, and the refusal (blocker + `fix:` in the server's format) is shown.
    await waitFor(() => expect(view.container.querySelector('[data-slot="mcp-leader-refusal"]')).toBeTruthy())
    expect(view.container.querySelector('[data-slot="mcp-leader-refusal"]')?.textContent).toContain('not a Claude Code session')
    expect(made.status()).toMatchObject({ leader: { client: 'claude-code' }, blocker: { code: 'claude-code-not-owner' } })
    expect(view.container.querySelector('[data-slot="mcp-leader"]')?.getAttribute('data-state')).toBe('blocked')
  })

  it('a compatible Claude Code reconnect keeps the attachment and shows no selector: nothing to replace', async () => {
    // Guard, green before and after: the owner-switch rule must not fire for the owner's own client.
    const { made } = realDelivery()
    made.sessionOpened('claude', { push: async () => {}, clientName: 'claude-code', leaderPush: true })
    expect((await made.act({ action: 'attach', client: 'claude-code' })).ok).toBe(true)
    made.sessionClosed('claude')
    made.sessionOpened('claude-again', { push: async () => {}, clientName: 'claude-code', leaderPush: true })
    expect(made.status()).toMatchObject({ owner: { client: 'claude-code' }, leader: { client: 'claude-code' }, blocker: null })

    const control = await mount(made).control()
    expect(control.getAttribute('data-state')).toBe('delivering')
    expect(control.querySelector('[role="radiogroup"]')).toBeNull()
    expect(control.querySelector('[data-slot="mcp-leader-replace"]')).toBeNull()
  })
})
