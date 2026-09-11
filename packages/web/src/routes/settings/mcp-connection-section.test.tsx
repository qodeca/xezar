import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import type { HealthResponse, ProjectsResponse } from '@qodeca/xezar-api-client'
import { McpConnectionSection } from './mcp-connection-section'
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
  serve({ '/api/v1/health': health, '/api/v1/projects': registry })
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
    expect(container.querySelector('[data-slot="mcp-connection-status-unreported"]')?.textContent).toBe(
      'This page cannot tell whether a client is connected. Your leader client shows it.',
    )
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
