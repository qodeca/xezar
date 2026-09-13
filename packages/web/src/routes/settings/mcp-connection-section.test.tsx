import { focusManager, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import type { HealthResponse, McpLeaderBlocker, McpLeaderStatus, ProjectsResponse } from '@qodeca/xezar-api-client'
import { McpConnectionSection } from './mcp-connection-section'
import { McpLeaderControl } from './mcp-leader-control'
import { SETTINGS_SECTIONS, visibleSettingsSections } from './registry'

/**
 * Issue #111 (Phase 7 of epic #67): the "MCP connection" project settings section.
 *
 * U-M01 is required: from project settings the user identifies the bound project, learns the
 * client and xezar must be on the same machine, sees configuration readiness, and gets one-time
 * setup guidance for Claude Code, Codex, OpenCode and pi — and the automatically generated project
 * file is NOT described as automatically discovered by every client (F-14, U-M01).
 *
 * The status the section shows comes from the SERVER (the project registry and `/api/health`'s
 * `localHandoff` capability), never from the presence of a file — the MCP requirements §8 say
 * file presence or location alone is not a security boundary, and the section must not probe a
 * file or socket on disk to decide status.
 *
 * Hard boundaries asserted here (F-15, U-M02): no rendered string contains a credential-shaped
 * value from the connection configuration, and no copy claims the generated file is discovered
 * automatically.
 */

const fetchMock = vi.fn<typeof fetch>()

const HEALTH: HealthResponse = {
  version: '0.1.5',
  projects: [],
  bootProject: 'xezar',
  repoRoot: '/home/me/Projects/xezar',
  repo: { root: '/home/me/Projects/xezar', branch: 'main' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false },
}

const REGISTRY: ProjectsResponse = {
  projects: [
    {
      id: 'xezar',
      name: 'xezar',
      root: '/home/me/Projects/xezar',
      addedAt: '',
      lastOpenedAt: '',
      source: 'local',
      status: 'ok',
    },
  ],
  bootProject: 'xezar',
  projectsDir: '~/xezar/projects',
}

/** The server's no-leader blocker, abridged: what it says and the Codex remedy it gives. */
const NO_LEADER: McpLeaderBlocker = {
  code: 'no-leader-session',
  message:
    'No leader session is attached to this project, so events are kept in the journal, not pushed. A Claude Code session, or a pi without xezar’s leader extension, reads its events with the leader_events tool.',
  fix: 'Keep using leader_events from your own leader, or attach one. For Codex: run it on Codex’s shared local app-server (`codex app-server --listen unix://`), let the session call a xezar tool once, then attach it.',
}

/** A `GET /api/v1/mcp/leader` answer; nothing attached and no owner unless the case says so. */
function leaderStatus(over: Partial<Extract<McpLeaderStatus, { available: true }>> = {}): McpLeaderStatus {
  return { available: true, owner: null, leader: null, delivery: null, blocker: NO_LEADER, ...over }
}

function serve(routes: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (input) => {
    const path = String(input)
    if (!(path in routes)) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    return new Response(JSON.stringify(routes[path]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function renderSection(overrides: { health?: HealthResponse; registry?: ProjectsResponse } = {}) {
  const health = overrides.health ?? HEALTH
  const registry = overrides.registry ?? REGISTRY
  serve({ '/api/v1/health': health, '/api/v1/projects': registry, '/api/v1/mcp/leader': leaderStatus() })
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/p/xezar/settings/mcp-connection']}>
        <ProjectScopeProvider projectId={null}>
          <McpConnectionSection />
        </ProjectScopeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

describe('MCP connection section registry (issue #111)', () => {
  it('registers a project-scoped section that appears in the project settings nav', () => {
    const section = SETTINGS_SECTIONS.find((entry) => entry.id === 'mcp-connection')
    expect(section).toBeDefined()
    expect(section?.scope).toBe('project')
    expect(section?.title).toBe('MCP connection')
    // The nav (desktop left rail and mobile pills) is driven by visibleSettingsSections(scope),
    // so the section appearing here is exactly what makes it show up in the project settings nav.
    const inProjectNav = visibleSettingsSections('project').some((entry) => entry.id === 'mcp-connection')
    expect(inProjectNav).toBe(true)
    // It is NOT a global section: it must not surface under /settings/global.
    const inGlobalNav = visibleSettingsSections('global').some((entry) => entry.id === 'mcp-connection')
    expect(inGlobalNav).toBe(false)
  })
})

describe('MCP connection section content (issue #111)', () => {
  it('names the bound project and states the same-machine requirement', async () => {
    const { container } = renderSection()
    await waitFor(() => expect(container.textContent).toContain('xezar'))
    const text = container.textContent ?? ''

    // Bound project identity — the project name and root, from the server registry.
    expect(text).toContain('Bound project')
    expect(text).toContain('xezar')
    expect(text).toContain('/home/me/Projects/xezar')
    // Local-only scope — the same-machine requirement, from the server's localHandoff capability.
    expect(text).toContain('same machine')
    expect(text).toContain('Local-only scope')
  })

  it('renders one-time setup guidance for each of the four clients', async () => {
    const { container } = renderSection()
    await waitFor(() => expect(container.querySelector('[data-slot="mcp-client-claude-code"]')).toBeTruthy())

    expect(container.querySelector('[data-slot="mcp-client-claude-code"]')?.textContent).toContain('Claude Code')
    expect(container.querySelector('[data-slot="mcp-client-codex"]')?.textContent).toContain('Codex')
    expect(container.querySelector('[data-slot="mcp-client-opencode"]')?.textContent).toContain('OpenCode')
    expect(container.querySelector('[data-slot="mcp-client-pi"] h3')?.textContent).toBe('pi')

    // Each card carries the one-time user command / file block, and a plainly-stated NOT-automatic line.
    const text = container.textContent ?? ''
    expect(text).toContain('claude mcp add --scope local')
    expect(text).toContain('mcp_servers.xezar')
    expect(text).toContain('opencode.json')
    expect(text).toContain('pi install npm:pi-mcp-adapter')
    expect(text).toContain('One-time')
  })

  it('reports configuration readiness from the server (local mode = available)', async () => {
    const { container } = renderSection()
    await waitFor(() => expect(container.textContent).toContain('Configuration readiness'))
    const text = container.textContent ?? ''
    expect(text).toContain('writes this project')
    expect(text).toContain('.local/xezar/')
  })

  it('reports the connection as unavailable when the server is not in local mode', async () => {
    const { container } = renderSection({
      health: { ...HEALTH, capabilities: { ...HEALTH.capabilities, localHandoff: false } },
    })
    await waitFor(() => expect(container.textContent).toContain('not available'))
    const text = container.textContent ?? ''
    expect(text).toContain('same machine')
    expect(text).toContain('not running in local mode')
  })
})

describe('MCP connection section hard boundaries (F-15, U-M02, U-M01)', () => {
  it('never renders a credential-shaped value from the connection configuration', async () => {
    const { container } = renderSection()
    await waitFor(() => expect(container.querySelector('[data-slot="mcp-connection-section"]')).toBeTruthy())
    const text = container.textContent ?? ''

    // The section renders a command and a non-secret file location only. A connection token,
    // a secret, or a UUID-shaped value must never appear anywhere.
    expect(text).not.toContain('token')
    expect(text).not.toContain('Bearer ')
    expect(text).not.toContain('authorization')
    // No UUID-shaped value (the connection token is a v4 UUID per D-04).
    expect(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)).toBe(false)
  })

  it('never says the generated file is discovered automatically by any client', async () => {
    const { container } = renderSection()
    await waitFor(() => expect(container.textContent).toContain('Claude Code'))
    const text = container.textContent ?? ''

    // U-M01 / F-14: the copy must NOT claim the file IS auto-discovered. It says the opposite —
    // each client does NOT discover it, and the user configures by hand. Check the AFFIRMATIVE
    // claim only: a "not discovered automatically" negation contains the substring "discovered
    // automatically", so a naive substring check would flag the correct copy.
    expect(text).not.toContain('automatically discovered')
    expect(text).not.toContain('is discovered automatically')
    expect(text).not.toContain('auto-discovered')
    expect(text).not.toContain('automatically discovers')
    expect(text).not.toContain('discovers it automatically')
    expect(text).not.toContain('automatically detects')
    // …and it must state the negation plainly for each client.
    expect(text).toContain('does not discover')
    expect(container.querySelectorAll('[data-slot="mcp-client-not-automatic"]')).toHaveLength(4)
    for (const line of container.querySelectorAll('[data-slot="mcp-client-not-automatic"]')) {
      expect(line.textContent).toMatch(/^Not automatic: .+ does not discover \.local\/xezar\/mcp-connection\.json/)
    }
    // No unprocessed unicode escape ("\u2014") may leak into rendered text — a JSX attribute
    // string does not process \u escapes, so a copy edit that reaches for one shows up here.
    expect(text).not.toContain('\\u')
  })
})

describe('MCP connection section copy (#301, the design pass on #296)', () => {
  it('renders backticked names as code, never as literal backticks (C1)', async () => {
    const { container } = renderSection()
    await waitFor(() => expect(container.textContent).toContain('Claude Code'))
    expect(container.textContent).not.toContain('`')
    const codes = [...container.querySelectorAll('[data-slot="mcp-connection-section"] code')].map((el) => el.textContent)
    expect(codes).toContain('.local/xezar/mcp-connection.json')
    expect(codes).toContain('opencode.json')
  })

  it('speaks to the user, not in the requirement document’s or the code’s voice (C2, C4, C7)', async () => {
    const { container } = renderSection()
    await waitFor(() => expect(container.textContent).toContain('Claude Code'))
    const text = container.textContent ?? ''
    expect(text).not.toContain('stated plainly')
    expect(text).not.toContain('NOT automatic')
    expect(text).not.toContain('Nothing here reads that file')
    // The one-line "cannot tell" fallback is gone: the server reports the leader connection now, and
    // the Connection status area shows it (design review NB-2 on #403).
    expect(container.querySelector('[data-slot="mcp-connection-status-unreported"]')).toBeNull()
    expect(text).not.toContain('This page cannot tell whether a client is connected')
  })

  it('leaves out a section no route can fill, instead of showing it empty (C3)', async () => {
    const { container } = renderSection()
    await waitFor(() => expect(container.textContent).toContain('Claude Code'))
    expect(container.textContent).not.toContain('Operation outcomes')
    expect(container.querySelector('[data-slot="mcp-operations"]')).toBeNull()
  })

  it('puts the one-time setup right after the binding and the scope, and the status after the setup (C4, C5)', async () => {
    const { container } = renderSection()
    await waitFor(() => expect(container.textContent).toContain('Claude Code'))
    const slots = ['mcp-project', 'mcp-local-only', 'mcp-readiness', 'mcp-client-claude-code', 'mcp-connection-status', 'mcp-capabilities']
    const order = slots.map((slot) => container.querySelector(`[data-slot="${slot}"]`))
    for (const [i, el] of order.entries()) expect(el, slots[i]).toBeTruthy()
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, slots[i]).toBeTruthy()
    }
  })

  it('has one capability section, and keeps the way to the MCP API reference (C8)', async () => {
    const { container } = renderSection()
    await waitFor(() => expect(container.textContent).toContain('Claude Code'))
    expect(container.textContent).not.toContain('Capabilities and limitations')
    expect(container.querySelector('[data-slot="mcp-api-link"]')?.getAttribute('href')).toContain('/settings/mcp-api')
    // The one fact the dropped bullets held that no other section said.
    expect(container.textContent).toContain('one client may own it at a time')
  })
})

describe('MCP connection section — the pi card (#341, WP3 of #330)', () => {
  /** The pi card, once the section has rendered; fails loudly if it never appears. */
  async function piCard(): Promise<Element> {
    const { container } = renderSection()
    await waitFor(() => expect(container.querySelector('[data-slot="mcp-client-pi"]')).toBeTruthy())
    return container.querySelector('[data-slot="mcp-client-pi"]')!
  }

  it('says pi adds MCP through an extension by design and puts the extension install before the entry', async () => {
    const card = await piCard()
    const user = card.querySelector('[data-slot="mcp-client-user"]')!
    // A choice pi made, not a lack (design review on #343).
    expect(user.textContent).toContain('pi adds MCP through an extension, by design, so its setup has two steps, both required')
    expect(user.textContent).toContain('third-party extension (source on GitHub, MIT licence)')
    const blocks = [...user.querySelectorAll('pre')].map((pre) => pre.textContent?.trim() ?? '')
    expect(blocks).toHaveLength(2)
    // The install comes first, pinned to the version the evidence record ran (PI-5).
    expect(blocks[0]).toBe('pi install npm:pi-mcp-adapter@2.32.1')
    expect(blocks[1]).toContain('mcpServers')
    const steps = [...user.querySelectorAll('ol > li')]
    expect(steps).toHaveLength(2)
    expect(steps[0]!.textContent).toContain('pi-mcp-adapter')
    expect(steps[1]!.textContent).toContain('.pi/mcp.json')
  })

  it('gives an entry that is valid JSON and carries the two keys the evidence measured as needed', async () => {
    const card = await piCard()
    const entry = JSON.parse(card.querySelectorAll('[data-slot="mcp-client-user"] pre')[1]!.textContent ?? '') as {
      settings?: { directTools?: unknown }
      mcpServers?: Record<string, { command?: unknown; args?: unknown; lifecycle?: unknown }>
    }
    expect(entry.settings?.directTools).toBe(true)
    expect(entry.mcpServers?.xezar).toEqual({ command: 'npx', args: ['-y', '@qodeca/xezar', 'mcp'], lifecycle: 'keep-alive' })
    // What each key is for, in the user's words: without keep-alive an idle pi gives up the project.
    const user = card.querySelector('[data-slot="mcp-client-user"]')!.textContent ?? ''
    expect(user).toContain('without it, pi gives the project up after 10 idle minutes')
  })

  it('states what keep-alive costs: a pi started here holds the project and other clients are refused (#343 review)', async () => {
    const card = await piCard()
    // D-04 § 3.4 run `root`: pi in the project root held the project from start, with no prompt,
    // and a second client got project-occupied until pi exited. The card must say so, not only the upside.
    expect(card.querySelector('[data-slot="mcp-client-pi-leader"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'So any pi started in this folder, including a pi task xezar runs here with Worktree off, becomes this project’s leader client, and every other client, Claude Code included, is refused until that pi exits. Start pi in another folder for other work.',
    )
    // Whether to commit the file, and what committing it does.
    const user = card.querySelector('[data-slot="mcp-client-user"]')!.textContent ?? ''
    expect(user).toContain('The file holds no secret, so it is safe to commit.')
    expect(user).toContain('A committed entry does the same for everyone who starts pi in this project.')
  })

  it('tells the reader to leave xezar’s tools out of approveTools, and what happens if they do not (#369)', async () => {
    const card = await piCard()
    const line = card.querySelector('[data-slot="mcp-client-pi-approve-tools"]')
    expect(line).toBeTruthy()
    const text = line!.textContent!.replace(/\s+/g, ' ').trim()
    // The workaround comes FIRST: a reader who stops after one sentence still knows what to do.
    expect(text).toMatch(/^Leave xezar’s tools out of the extension’s approveTools setting/)
    // The consequence, in the measured terms of #330 WP5's QA — killed at two minutes, not "hangs
    // for ever", which is what a reader would wrongly take from the mechanism alone.
    expect(text).toContain('nothing in xezar answers')
    expect(text).toContain('waits there until it is killed')
    expect(text).toContain('measured at two minutes')
    expect(text).toContain('xezar_health')
    // The OTHER unattended case, and it ends differently. This is the leader setup card, so a reader
    // who runs no pi tasks must not read the killed-at-two-minutes case as the only one: a leader
    // turn has nothing to end its wait at all. Naming only the task understated it (QA on #371).
    expect(text).toContain('a leader turn nobody is watching waits for ever')
    // The limit that keeps this sentence true. The same QA measured an ordinary pi task finishing in
    // 2.8 s with the gate on, because the runner's default tool allowlist offers no xezar tool. A card
    // that dropped this would overstate the limit — the mistake this release already shipped.
    expect(text).toContain('A pi that is never offered a xezar tool is unaffected')
    // Never claim the fix is in: 369 is deliberately not in this release.
    expect(text).toContain('which is not in this release')
    const issue = card.querySelector('[data-slot="mcp-client-pi-approve-tools-issue"]')!
    // The link text says "issue 369", never a bare hash: the design guardian's no-raw-hex-colors
    // rule reads a three-digit "#369" as a colour, and that rule is not to be weakened for copy.
    expect(issue.textContent).toBe('issue 369')
    expect(issue.getAttribute('href')).toBe('https://github.com/qodeca/xezar/issues/369')
    expect(issue.getAttribute('target')).toBe('_blank')
    expect(issue.getAttribute('rel')).toBe('noreferrer')
  })

  it('links the third-party extension to its source, in a new tab', async () => {
    const card = await piCard()
    const link = card.querySelector('[data-slot="mcp-client-pi-adapter-link"]')!
    expect(link.getAttribute('href')).toBe('https://github.com/nicobailon/pi-mcp-adapter')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
    expect(link.textContent).toBe('source on GitHub')
  })

  it('says a missing extension shows nothing, how to check it is there, and that pi does not discover the generated file', async () => {
    const card = await piCard()
    expect(card.querySelector('[data-slot="mcp-client-not-automatic"]')?.textContent).toBe(
      'Not automatic: pi does not discover .local/xezar/mcp-connection.json. Without the extension, pi does not read the entry above at all: it shows no xezar tool, and no error says why. To check: pi list shows npm:pi-mcp-adapter, and pi says MCP: 1 servers connected when it starts here (a higher number if you have other MCP servers).',
    )
  })

  it('leads the config-file caveat with which entry wins, then the .mcp.json shared with Claude Code, then the user-level files', async () => {
    const card = await piCard()
    const caveat = card.querySelector('[data-slot="mcp-client-caveat"]')!
    expect([...caveat.querySelectorAll('code')].map((code) => code.textContent)).toEqual([
      'xezar',
      '.pi/mcp.json',
      '.mcp.json',
      '~/.config/mcp/mcp.json',
      '~/.agents/mcp.json',
      '~/.agents/mcp/mcp.json',
      '~/.pi/agent/mcp.json',
    ])
    expect(caveat.textContent).toMatch(/^If another file also has a xezar entry, yours in \.pi\/mcp\.json wins: it is the last of the six files/)
    expect(caveat.textContent).toContain('which Claude Code reads too, so an entry there reaches both clients')
    expect(caveat.textContent).toContain('The other four apply in every folder pi starts in')
  })

  it('tells the Claude Code reader that pi reads the project .mcp.json too', async () => {
    const { container } = renderSection()
    await waitFor(() => expect(container.querySelector('[data-slot="mcp-client-claude-code"]')).toBeTruthy())
    expect(container.querySelector('[data-slot="mcp-client-claude-code"] [data-slot="mcp-client-caveat"]')?.textContent).toContain(
      'writes a tracked .mcp.json, which pi reads too,',
    )
  })
})

/**
 * Round 4 on #403: the QA FAIL ("a person cannot attach from the cockpit") and design review NB-1…NB-4.
 * The Connection status area is ONE generic leader control driven by `GET /api/v1/mcp/leader`, and its
 * Attach leader action POSTs the same route with the client derived from that status. Every state it
 * can be in is reached here through the real section, with only `fetch` stubbed.
 */
describe('MCP connection section — the leader control (#374, round 4 on #403)', () => {
  const DELIVERY = { state: 'idle', deliveredSeq: 1, ackedSeq: 0, reactedSeq: 1, latestSeq: 1 } as const

  /** Serve the section with `status` for GET and `answer` for POST; every POST body is recorded. */
  function renderLeader(status: McpLeaderStatus, answer?: (body: unknown) => { status: number; body: unknown; then?: McpLeaderStatus }) {
    let current = status
    const posted: unknown[] = []
    const leaderReads = { count: 0 }
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input)
      const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } })
      if (path === '/api/v1/health') return json(HEALTH)
      if (path === '/api/v1/projects') return json(REGISTRY)
      if (path === '/api/v1/mcp/leader' && (init?.method ?? 'GET') === 'POST') {
        const body = JSON.parse(String(init?.body))
        posted.push(body)
        const out = answer?.(body) ?? { status: 200, body: current }
        if (out.then) current = out.then
        return json(out.body, out.status)
      }
      if (path === '/api/v1/mcp/leader') {
        leaderReads.count += 1
        return json(current)
      }
      return json({ error: 'not found' }, 404)
    })
    const view = render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/p/xezar/settings/mcp-connection']}>
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
    return { ...view, posted, leaderReads, control }
  }

  const codes = (el: Element) => [...el.querySelectorAll('code')].map((code) => code.textContent)
  const attachButton = (el: Element) => el.querySelector<HTMLButtonElement>('[data-slot="mcp-leader-attach-button"]')

  it('no owner and no leader: says so, shows the server’s no-leader blocker and fix, and offers the client picker', async () => {
    const control = await renderLeader(leaderStatus()).control()
    expect(control.getAttribute('data-state')).toBe('no-owner')
    expect(control.querySelector('[data-slot="mcp-leader-owner"]')?.textContent).toBe('None')
    expect(control.querySelector('[data-slot="mcp-leader-attached"]')?.textContent).toBe('None attached')
    expect(control.querySelector('[data-slot="mcp-leader-summary"]')?.textContent).toContain('No leader client is connected to this project.')
    const blocker = control.querySelector('[data-slot="mcp-leader-blocker"]')!
    expect(blocker.getAttribute('data-code')).toBe('no-leader-session')
    expect(blocker.textContent).toContain('Fix: Keep using leader_events')
    // NB-3: leader_events and app-server render as code, even where the server's copy is plain text.
    expect(codes(blocker)).toEqual(expect.arrayContaining(['leader_events', 'app-server', 'codex app-server --listen unix://']))
    const radios = [...control.querySelectorAll('[role="radiogroup"] [role="radio"]')].map((radio) => radio.textContent)
    expect(radios).toEqual(['Codex', 'OpenCode', 'pi', 'Claude Code'])
    expect(attachButton(control)?.textContent).toBe('Attach leader')
  })

  it('attached pull-only: an unidentified owner reads with leader_events, and picking Claude Code explains there is nothing to attach', async () => {
    const control = await renderLeader(leaderStatus({ owner: { client: null }, delivery: DELIVERY })).control()
    expect(control.getAttribute('data-state')).toBe('owner')
    expect(control.querySelector('[data-slot="mcp-leader-owner"]')?.textContent).toBe('Not identified')
    // Self-review nit: xezar does not know WHICH client this is, so the sentence does not claim how it reads.
    expect(control.querySelector('[data-slot="mcp-leader-summary"]')?.textContent).toBe(
      'A client owns this project, but xezar has not identified which one. Nothing is attached, so events start no turn in it; a leader can read them with leader_events.',
    )
    fireEvent.click(control.querySelector('[role="radio"][data-value="claude-code"]')!)
    expect(control.querySelector('[role="radio"][data-value="claude-code"]')?.getAttribute('aria-checked')).toBe('true')
    expect(control.querySelector('[data-slot="mcp-leader-note"]')?.textContent).toContain('There is nothing to attach')
    expect(attachButton(control)).toBeNull()
    // pi: the button stays, and the note says what it takes.
    fireEvent.click(control.querySelector('[role="radio"][data-value="pi"]')!)
    expect(control.querySelector('[data-slot="mcp-leader-note"]')?.textContent).toContain('Works when this pi runs xezar’s leader extension')
    expect(attachButton(control)).toBeTruthy()
  })

  it('a Codex owner: Attach leader posts {action: "attach", client: "codex"} with no address, and the answer shows Codex connected', async () => {
    const attached = leaderStatus({ owner: { client: 'codex' }, leader: { client: 'codex', state: 'attached' }, delivery: DELIVERY, blocker: null })
    const view = renderLeader(leaderStatus({ owner: { client: 'codex' }, delivery: DELIVERY }), () => ({ status: 200, body: attached, then: attached }))
    const control = await view.control()
    expect(control.querySelector('[data-slot="mcp-leader-owner"]')?.textContent).toBe('Codex')
    // Derived from the status: no picker, no address fields.
    expect(control.querySelector('[role="radiogroup"]')).toBeNull()
    expect(control.querySelector('input')).toBeNull()
    fireEvent.click(attachButton(control)!)
    await waitFor(() => expect(view.container.querySelector('[data-slot="mcp-leader"]')?.getAttribute('data-state')).toBe('delivering'))
    expect(view.posted).toEqual([{ action: 'attach', client: 'codex' }])
    const after = view.container.querySelector('[data-slot="mcp-leader"]')!
    expect(after.querySelector('[data-slot="mcp-leader-summary"]')?.textContent).toBe('Codex connected. Project events can start a turn in your current session.')
    expect(after.querySelector('[data-slot="mcp-leader-attached"]')?.textContent).toBe('Codex, attached')
  })

  it('attached and delivering: the connected sentence, no blocker, and nothing to click but the status itself', async () => {
    const control = await renderLeader(leaderStatus({ owner: { client: 'codex' }, leader: { client: 'codex', state: 'attached' }, delivery: DELIVERY, blocker: null })).control()
    expect(control.getAttribute('data-state')).toBe('delivering')
    expect(control.querySelector('[data-slot="mcp-leader-blocker"]')).toBeNull()
    expect(attachButton(control)).toBeNull()
    expect(control.querySelector('[data-slot="mcp-leader-attach"]')).toBeNull()
  })

  // NB-1: each recoverable refusal is named with its own fix, from the status — not one generic sentence.
  const CANNOT_REACH =
    'xezar cannot reach this running Codex session for project-event delivery. Your events are saved. Use leader_events in Codex to read them; retry connecting when this session is available on Codex’s local app-server.'
  const BLOCKERS: Array<[string, McpLeaderStatus, string]> = [
    ['codex-session-not-targetable', leaderStatus({ owner: { client: 'codex' }, delivery: DELIVERY, blocker: { code: 'codex-session-not-targetable', message: CANNOT_REACH, fix: 'Your Codex session has not called a xezar tool yet, so xezar does not know which session it is. Let it call one once (for example leader_events), then attach it again.' } }), 'has not called a xezar tool yet'],
    ['codex-app-server-unreachable', leaderStatus({ owner: { client: 'codex' }, delivery: DELIVERY, blocker: { code: 'codex-app-server-unreachable', message: CANNOT_REACH, fix: 'No shared Codex app-server answered in the Codex home xezar uses. Run Codex’s shared local app-server there (`codex app-server --listen unix://`), open your session in the Codex TUI, then attach again.' } }), 'No shared Codex app-server answered'],
    ['codex-home-mismatch', leaderStatus({ owner: { client: 'codex' }, delivery: DELIVERY, blocker: { code: 'codex-home-mismatch', message: CANNOT_REACH, fix: 'The Codex app-server xezar found runs under a different Codex home than the one xezar uses. Start `xezar serve` and Codex with the same CODEX_HOME, then attach again.' } }), 'same CODEX_HOME'],
    ['codex-thread-not-loaded', leaderStatus({ owner: { client: 'codex' }, leader: { client: 'codex', state: 'attached' }, delivery: DELIVERY, blocker: { code: 'codex-thread-not-loaded', message: CANNOT_REACH, fix: 'This Codex session is not loaded on the app-server. Open the session in your Codex TUI again, let it call a xezar tool once, then attach again.' } }), 'Open the session in your Codex TUI again'],
    ['codex-thread-state-unknown', leaderStatus({ owner: { client: 'codex' }, leader: { client: 'codex', state: 'attached' }, delivery: DELIVERY, blocker: { code: 'codex-thread-state-unknown', message: 'xezar could not read the state of this Codex session, so it holds events rather than risk interrupting an approval or a question.', fix: 'Nothing is needed once Codex reports the session’s state again. Meanwhile, use leader_events in Codex.' } }), 'reports the session’s state again'],
    ['no-owner-session', leaderStatus({ leader: { client: 'codex', state: 'attached' }, blocker: { code: 'no-owner-session', message: 'A Codex leader is attached, but no MCP session owns this project yet, so nothing follows the event journal and nothing is delivered.', fix: 'Let the attached Codex session call a xezar tool once (for example leader_events), so its MCP connection opens.' } }), 'call a xezar tool once'],
  ]
  for (const [code, status, fix] of BLOCKERS) {
    it(`names the ${code} blocker from the status with its own Fix, and offers the attach again`, async () => {
      const control = await renderLeader(status).control()
      const blocker = control.querySelector('[data-slot="mcp-leader-blocker"]')!
      expect(blocker.getAttribute('data-code')).toBe(code)
      expect(blocker.querySelectorAll('p')[1]?.textContent).toMatch(/^Fix: /)
      expect(blocker.textContent).toContain(fix)
      expect(codes(blocker)).toContain('leader_events')
      if (status.available && status.leader) {
        expect(control.getAttribute('data-state')).toBe('blocked')
        expect(control.querySelector('[data-slot="mcp-leader-summary"]')?.textContent).toBe('Codex is attached, but events are waiting.')
      }
      expect(attachButton(control)).toBeTruthy()
    })
  }

  it('a refusal the status explains is not said twice; one it does not explain is shown in the server’s words', async () => {
    const refusedByHome = leaderStatus({ owner: { client: 'codex' }, delivery: DELIVERY, blocker: BLOCKERS[2]![1].available ? (BLOCKERS[2]![1] as { blocker: McpLeaderBlocker }).blocker : NO_LEADER })
    // The server's 409 is the verbatim message followed by the refusal's fix: the same words the status now shows.
    const homeBlocker = (refusedByHome as { blocker: McpLeaderBlocker }).blocker
    const codex = renderLeader(leaderStatus({ owner: { client: 'codex' }, delivery: DELIVERY }), () => ({ status: 409, body: { error: `${homeBlocker.message} ${homeBlocker.fix}` }, then: refusedByHome }))
    fireEvent.click(attachButton(await codex.control())!)
    await waitFor(() => expect(codex.container.querySelector('[data-slot="mcp-leader-blocker"]')?.getAttribute('data-code')).toBe('codex-home-mismatch'))
    expect(codex.container.querySelector('[data-slot="mcp-leader-refusal"]')).toBeNull()
    cleanup()

    const piRefusal = 'xezar has no live link to a pi leader for this project. Events stay in the project journal and nothing is lost.'
    const pi = renderLeader(leaderStatus(), () => ({ status: 409, body: { error: piRefusal } }))
    const control = await pi.control()
    fireEvent.click(control.querySelector('[role="radio"][data-value="pi"]')!)
    fireEvent.click(attachButton(control)!)
    await waitFor(() => expect(pi.container.querySelector('[data-slot="mcp-leader-refusal"]')?.textContent).toBe(piRefusal))
    expect(pi.container.querySelector('[data-slot="mcp-leader-refusal"]')?.getAttribute('role')).toBe('alert')
    expect(pi.posted).toEqual([{ action: 'attach', client: 'pi' }])
  })

  it('OpenCode keeps its address fields: Attach waits for both, then posts them trimmed', async () => {
    const view = renderLeader(leaderStatus())
    const control = await view.control()
    fireEvent.click(control.querySelector('[role="radio"][data-value="opencode"]')!)
    expect(attachButton(control)?.disabled).toBe(true)
    fireEvent.change(view.getByLabelText('Server address'), { target: { value: ' http://127.0.0.1:4096 ' } })
    expect(attachButton(control)?.disabled).toBe(true)
    fireEvent.change(view.getByLabelText('Session id'), { target: { value: 'ses_1 ' } })
    expect(attachButton(control)?.disabled).toBe(false)
    fireEvent.click(attachButton(control)!)
    await waitFor(() => expect(view.posted).toHaveLength(1))
    expect(view.posted[0]).toEqual({ action: 'attach', client: 'opencode', baseUrl: 'http://127.0.0.1:4096', sessionId: 'ses_1' })
  })

  it('Refresh re-reads the status, so a session that just called a tool shows up without a reload', async () => {
    const view = renderLeader(leaderStatus({ owner: { client: null }, delivery: DELIVERY }))
    const control = await view.control()
    const before = view.leaderReads.count
    fireEvent.click(control.querySelector('[data-slot="mcp-leader-refresh"]')!)
    await waitFor(() => expect(view.leaderReads.count).toBeGreaterThan(before))
  })

  it('the MCP service not running: shows the server’s reason, no attach, and Refresh (NB-5)', async () => {
    const view = renderLeader({ available: false, reason: 'The MCP service is not running for this project, so there is no event delivery to report.' })
    const control = await view.control()
    expect(control.getAttribute('data-state')).toBe('unavailable')
    expect(control.querySelector('[data-slot="mcp-leader-reason"]')?.textContent).toBe('The MCP service is not running for this project, so there is no event delivery to report.')
    expect(attachButton(control)).toBeNull()
    const before = view.leaderReads.count
    fireEvent.click(control.querySelector('[data-slot="mcp-leader-refresh"]')!)
    await waitFor(() => expect(view.leaderReads.count).toBeGreaterThan(before))
  })

  it('hosted mode shows the state card and no leader control: nothing local can be attached from there', async () => {
    const { container } = renderSection({ health: { ...HEALTH, capabilities: { ...HEALTH.capabilities, localHandoff: false } } })
    await waitFor(() => expect(container.querySelector('[data-slot="mcp-connection-state"]')).toBeTruthy())
    expect(container.querySelector('[data-slot="mcp-leader"]')).toBeNull()
    expect(container.querySelector('[data-slot="mcp-leader-attach-button"]')).toBeNull()
  })

  it('puts the Codex attach guidance in a card-body block, not the footnote (NB-4), with app-server and leader_events as code (NB-3)', async () => {
    const { container } = renderSection()
    await waitFor(() => expect(container.querySelector('[data-slot="mcp-client-codex"]')).toBeTruthy())
    const card = container.querySelector('[data-slot="mcp-client-codex"]')!
    const wake = card.querySelector('[data-slot="mcp-client-wake"]')!
    expect(wake).toBeTruthy()
    expect(wake.className).not.toContain('text-soft-foreground')
    expect(wake.querySelector('pre')?.textContent?.trim()).toBe('codex app-server --listen unix://')
    expect(wake.textContent).toContain('choose Attach leader under Connection status below')
    expect(wake.textContent).toContain('never asks for a socket path or port')
    expect(codes(wake)).toEqual(expect.arrayContaining(['app-server', 'CODEX_HOME', 'leader_events']))
    // The footnote keeps only its own caveat: no attach, status or blocker copy in 12 px soft text.
    const caveat = card.querySelector('[data-slot="mcp-client-caveat"]')!
    expect(caveat.textContent).toBe('Do not use codex mcp add — it has no scope flag and writes a machine-scope entry that would apply in every project.')
  })
})

/** Self-review of round 4: the leader control must stay readable and refreshable in every state. */
describe('MCP connection section — the leader control after self-review (round 4 on #403)', () => {
  const DELIVERY = { state: 'idle', deliveredSeq: 1, ackedSeq: 0, reactedSeq: 1, latestSeq: 1 } as const
  const CANNOT_REACH =
    'xezar cannot reach this running Codex session for project-event delivery. Your events are saved. Use leader_events in Codex to read them; retry connecting when this session is available on Codex’s local app-server.'
  const attachedCodex = { owner: { client: 'codex' as const }, leader: { client: 'codex' as const, state: 'attached' as const }, delivery: DELIVERY }

  function mount(reply: (path: string, init?: RequestInit) => Response | undefined) {
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input)
      const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } })
      const custom = reply(path, init)
      if (custom) return custom
      if (path === '/api/v1/health') return json(HEALTH)
      if (path === '/api/v1/projects') return json(REGISTRY)
      return json({ error: 'not found' }, 404)
    })
    return render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/p/xezar/settings/mcp-connection']}>
          <ProjectScopeProvider projectId={null}>
            <McpConnectionSection />
          </ProjectScopeProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }
  const ok = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } })

  it('offers Refresh while delivering too, so a stale “connected” can be re-read (finding 1)', async () => {
    const view = mount((path) => (path === '/api/v1/mcp/leader' ? ok(leaderStatus({ ...attachedCodex, blocker: null })) : undefined))
    await waitFor(() => expect(view.container.querySelector('[data-slot="mcp-leader"]')?.getAttribute('data-state')).toBe('delivering'))
    expect(view.container.querySelector('[data-slot="mcp-leader-refresh"]')).toBeTruthy()
  })

  it('shows a refused re-attach while an attached leader is blocked for another reason (finding 2)', async () => {
    const blocked = leaderStatus({ ...attachedCodex, blocker: { code: 'codex-thread-not-loaded', message: CANNOT_REACH, fix: 'This Codex session is not loaded on the app-server. Open the session in your Codex TUI again, then attach again.' } })
    const refusal = `${CANNOT_REACH} The Codex app-server xezar found runs under a different Codex home than the one xezar uses. Start xezar serve and Codex with the same CODEX_HOME, then attach again.`
    const view = mount((path, init) => (path === '/api/v1/mcp/leader' ? (init?.method === 'POST' ? ok({ error: refusal }, 409) : ok(blocked)) : undefined))
    await waitFor(() => expect(view.container.querySelector('[data-slot="mcp-leader-attach-button"]')).toBeTruthy())
    fireEvent.click(view.container.querySelector('[data-slot="mcp-leader-attach-button"]')!)
    await waitFor(() => expect(view.container.querySelector('[data-slot="mcp-leader-refusal"]')?.textContent).toBe(refusal))
  })

  it('announces only the status words: the control has its own polite region, the controls sit outside it (finding 7)', async () => {
    const view = mount((path) => (path === '/api/v1/mcp/leader' ? ok(leaderStatus()) : undefined))
    await waitFor(() => expect(view.container.querySelector('[data-slot="mcp-leader"]')).toBeTruthy())
    expect(view.container.querySelector('[data-slot="mcp-connection-status"]')?.getAttribute('aria-live')).toBeNull()
    const live = view.container.querySelector('[data-slot="mcp-leader-live"]')!
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.querySelector('[data-slot="mcp-leader-summary"]')).toBeTruthy()
    expect(live.querySelector('[data-slot="mcp-leader-blocker"]')).toBeTruthy()
    expect(live.querySelector('button, input, [role="radio"]')).toBeNull()
  })

  it('says so when Refresh fails, and keeps the last status labelled as such (finding 8)', async () => {
    let reads = 0
    const view = mount((path) => {
      if (path !== '/api/v1/mcp/leader') return undefined
      reads += 1
      return reads === 1 ? ok(leaderStatus()) : ok({ error: 'the server stopped answering' }, 500)
    })
    await waitFor(() => expect(view.container.querySelector('[data-slot="mcp-leader-refresh"]')).toBeTruthy())
    fireEvent.click(view.container.querySelector('[data-slot="mcp-leader-refresh"]')!)
    await waitFor(() => expect(view.container.querySelector('[data-slot="mcp-leader-stale"]')?.textContent).toContain('Could not refresh'), { timeout: 4000 })
    expect(view.container.querySelector('[data-slot="mcp-leader-stale"]')?.textContent).toContain('the server stopped answering')
    expect(view.container.querySelector('[data-slot="mcp-leader-summary"]')).toBeTruthy()
  })
})

/** A `WebSocket` stand-in for the cockpit's one topic socket (`api/ws.ts`); jsdom has none. */
class FakeTopicSocket {
  /** Made during the current case (reset per case). */
  static instances: FakeTopicSocket[] = []
  /** Every one ever made: the app's one socket is shared and outlives a case by its idle grace. */
  static all: FakeTopicSocket[] = []
  readyState = 0
  sent: string[] = []
  private handlers = new Map<string, Set<(event: unknown) => void>>()
  constructor(_url: string) {
    FakeTopicSocket.instances.push(this)
    FakeTopicSocket.all.push(this)
  }
  addEventListener(name: string, handler: (event: unknown) => void): void {
    const set = this.handlers.get(name) ?? new Set()
    set.add(handler)
    this.handlers.set(name, set)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
    this.fire('close', {})
  }
  open(): void {
    this.readyState = 1
    this.fire('open', {})
  }
  message(frame: unknown): void {
    this.fire('message', { data: JSON.stringify(frame) })
  }
  frames(): unknown[] {
    return this.sent.map((raw) => JSON.parse(raw))
  }
  private fire(name: string, event: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) handler(event)
  }
}

/**
 * Round 5 on #403 (review major 2, design NB-5 and NB-6): the leader status is live. In local mode
 * the control holds the `mcp-leader` topic while it is on screen and patches the cached status from
 * each frame; remote mode opens no socket and keeps the HTTP read. A focus regain re-reads it, and
 * every state — the first read failing included — has Refresh.
 */
describe('MCP connection section — the leader status, live (round 5 on #403)', () => {
  const ok = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } })

  function mount(leader: () => Response, health: HealthResponse = HEALTH, only?: 'control') {
    const reads = { count: 0 }
    fetchMock.mockImplementation(async (input) => {
      const path = String(input)
      if (path === '/api/v1/health') return ok(health)
      if (path === '/api/v1/projects') return ok(REGISTRY)
      if (path === '/api/v1/mcp/leader') {
        reads.count += 1
        return leader()
      }
      return ok({ error: 'not found' }, 404)
    })
    const view = render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/p/xezar/settings/mcp-connection']}>
          <ProjectScopeProvider projectId={null}>{only === 'control' ? <McpLeaderControl /> : <McpConnectionSection />}</ProjectScopeProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const state = () => view.container.querySelector('[data-slot="mcp-leader"]')?.getAttribute('data-state')
    return { ...view, reads, state }
  }

  beforeEach(() => {
    FakeTopicSocket.instances = []
  })
  afterEach(() => {
    focusManager.setFocused(undefined)
  })

  it('holds the mcp-leader topic while on screen, patches this project’s status from a frame, and lets go on unmount', async () => {
    vi.stubGlobal('WebSocket', FakeTopicSocket)
    const view = mount(() => ok(leaderStatus({ owner: { client: 'codex' } })))
    await waitFor(() => expect(view.state()).toBe('owner'))
    const socket = FakeTopicSocket.instances.find((ws) => ws.readyState === 0) ?? FakeTopicSocket.instances.at(-1)
    if (!socket) throw new Error('the leader control never opened the topic socket')
    act(() => socket.open())
    expect(socket.frames()).toContainEqual({ type: 'subscribe', topic: 'mcp-leader' })
    const readsBefore = view.reads.count

    // Another project's status and a malformed frame change nothing here.
    // (The server lists every running project in every frame, so this one is listed, unchanged.)
    act(() => socket.message({ type: 'event', topic: 'mcp-leader', data: { projects: { other: leaderStatus({ leader: { client: 'pi', state: 'attached' }, blocker: null }), xezar: leaderStatus({ owner: { client: 'codex' } }) } } }))
    act(() => socket.message({ type: 'event', topic: 'mcp-leader', data: { projects: { xezar: { available: 'yes' } } } }))
    // Let the cache's batched notify and the re-render land before reading: a check made earlier
    // passes whatever the frame did.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(view.state()).toBe('owner')
    expect(view.container.querySelector('[data-slot="mcp-leader-owner"]')?.textContent).toBe('Codex')

    // The daemon went away while the page stayed open: the pushed status replaces "Codex connected".
    const attached = { owner: { client: 'codex' as const }, leader: { client: 'codex' as const, state: 'attached' as const }, delivery: { state: 'idle' as const, deliveredSeq: 1, ackedSeq: 0, reactedSeq: 1, latestSeq: 1 } }
    act(() => socket.message({ type: 'event', topic: 'mcp-leader', data: { projects: { xezar: leaderStatus({ ...attached, blocker: null }) } } }))
    await waitFor(() => expect(view.state()).toBe('delivering'))
    act(() => socket.message({ type: 'event', topic: 'mcp-leader', data: { projects: { xezar: leaderStatus({ ...attached, blocker: { code: 'codex-app-server-unreachable', message: 'xezar cannot reach this running Codex session.', fix: 'Run the app-server again.' } }) } } }))
    await waitFor(() => expect(view.state()).toBe('blocked'))
    expect(view.container.querySelector('[data-slot="mcp-leader-blocker"]')?.getAttribute('data-code')).toBe('codex-app-server-unreachable')
    // Pushed, not read: no GET was needed for either change.
    expect(view.reads.count).toBe(readsBefore)

    view.unmount()
    expect(socket.frames()).toContainEqual({ type: 'unsubscribe', topic: 'mcp-leader' })
  })

  /** Local mode with the socket open and subscribed; `leader` answers each GET in turn. */
  async function live(leader: () => Response | Promise<Response>) {
    vi.stubGlobal('WebSocket', FakeTopicSocket)
    const view = mount(leader as () => Response)
    await waitFor(() => expect(view.state()).toBeTruthy())
    const socket = FakeTopicSocket.instances.at(-1) ?? FakeTopicSocket.all.at(-1)
    if (!socket) throw new Error('the leader control never opened the topic socket')
    if (socket.readyState !== 1) act(() => socket.open())
    const push = (projects: Record<string, unknown>) => act(() => socket.message({ type: 'event', topic: 'mcp-leader', data: { projects } }))
    return { ...view, socket, push }
  }
  const settleRender = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))
  const DELIVERING_FIELDS: Partial<Extract<McpLeaderStatus, { available: true }>> = {
    owner: { client: 'codex' },
    leader: { client: 'codex', state: 'attached' },
    delivery: { state: 'idle', deliveredSeq: 1, ackedSeq: 0, reactedSeq: 1, latestSeq: 1 },
    blocker: null,
  }
  const DELIVERING = leaderStatus(DELIVERING_FIELDS)

  // Review minor 2: a read that left before a change and answers after its frame must not win.
  it('a pushed status is not overwritten by an older read that answers after it', async () => {
    let reads = 0
    let answerLate: (response: Response) => void = () => {}
    const view = await live(() => {
      reads += 1
      if (reads === 1) return ok(DELIVERING)
      return new Promise<Response>((resolve) => {
        answerLate = resolve
      })
    })
    await waitFor(() => expect(view.state()).toBe('delivering'))
    // A focus re-read leaves while Codex is still connected…
    act(() => focusManager.setFocused(false))
    act(() => focusManager.setFocused(true))
    await waitFor(() => expect(reads).toBe(2))
    // …the daemon goes, and its frame arrives first…
    view.push({ xezar: leaderStatus({ ...DELIVERING_FIELDS, blocker: { code: 'codex-app-server-unreachable', message: 'xezar cannot reach this running Codex session.', fix: 'Run the app-server again.' } }) })
    await waitFor(() => expect(view.state()).toBe('blocked'))
    // …then the old answer lands. The page keeps the newer truth.
    answerLate(ok(DELIVERING))
    await settleRender()
    expect(view.state()).toBe('blocked')
  })

  // Review minor 4: every running project is in every frame, so one missing while the page shows it
  // running means its service stopped (a socket-only reconnect's snapshot lists running ones only).
  it('a frame that no longer lists this project re-reads it when the page still shows it running, and not otherwise', async () => {
    let answer: McpLeaderStatus = leaderStatus({ owner: { client: 'codex' } })
    const view = await live(() => ok(answer))
    await waitFor(() => expect(view.state()).toBe('owner'))
    const readsBefore = view.reads.count
    answer = { available: false, reason: 'The MCP service is not running for this project, so there is no event delivery to report.' }
    view.push({ other: leaderStatus() })
    await waitFor(() => expect(view.state()).toBe('unavailable'))
    expect(view.reads.count).toBe(readsBefore + 1)
    // Already shown as not running: another frame without it asks nothing.
    view.push({ other: leaderStatus({ owner: { client: null } }) })
    await settleRender()
    expect(view.reads.count).toBe(readsBefore + 1)
  })

  it('remote mode opens no WebSocket and sends no subscribe: the status is read over HTTP only', async () => {
    vi.stubGlobal('WebSocket', FakeTopicSocket)
    // Counted across EVERY socket: the shared one can still be open from the case before.
    const subscribes = () =>
      FakeTopicSocket.all.flatMap((ws) => ws.frames()).filter((frame) => (frame as { type?: string; topic?: string }).type === 'subscribe' && (frame as { topic?: string }).topic === 'mcp-leader').length
    const before = subscribes()
    const remote = { ...HEALTH, capabilities: { ...HEALTH.capabilities, localHandoff: false } }
    const view = mount(() => ok(leaderStatus()), remote, 'control')
    await waitFor(() => expect(view.state()).toBe('no-owner'))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(view.reads.count).toBe(1)
    expect(FakeTopicSocket.instances).toHaveLength(0)
    expect(subscribes()).toBe(before)
  })

  it('re-reads the status when the window regains focus, even right after the first read', async () => {
    const view = mount(() => ok(leaderStatus()))
    await waitFor(() => expect(view.state()).toBe('no-owner'))
    expect(view.reads.count).toBe(1)
    act(() => focusManager.setFocused(false))
    act(() => focusManager.setFocused(true))
    await waitFor(() => expect(view.reads.count).toBe(2))
  })

  it('the first read failing still offers Refresh, and a Refresh that succeeds shows the status (NB-5)', async () => {
    let fail = true
    const view = mount(() => (fail ? ok({ error: 'the server stopped answering' }, 500) : ok(leaderStatus())))
    await waitFor(() => expect(view.container.querySelector('[data-slot="mcp-leader-error"]')).toBeTruthy(), { timeout: 4000 })
    expect(view.container.querySelector('[data-slot="mcp-leader-error"]')?.textContent).toContain('the server stopped answering')
    fail = false
    fireEvent.click(view.container.querySelector('[data-slot="mcp-leader-error"] [data-slot="mcp-leader-refresh"]')!)
    await waitFor(() => expect(view.state()).toBe('no-owner'))
  })

  it('the primary Attach leader action is a 44 px touch target that relaxes at md; Refresh stays small (NB-6)', async () => {
    const view = mount(() => ok(leaderStatus({ owner: { client: 'codex' } })))
    await waitFor(() => expect(view.state()).toBe('owner'))
    const attach = view.container.querySelector('[data-slot="mcp-leader-attach-button"]')!
    expect(attach.className.split(' ')).toEqual(expect.arrayContaining(['h-11', 'md:h-9']))
    expect(attach.className.split(' ')).not.toContain('h-[30px]')
    expect(view.container.querySelector('[data-slot="mcp-leader-refresh"]')!.className.split(' ')).toContain('h-[30px]')
  })
})
