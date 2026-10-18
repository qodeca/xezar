import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { AgentConfigFile, AgentConfigListing } from '@qodeca/xezar-api-client'
import { Toaster } from '@/components/ui/toaster'
import { AgentConfigSection } from './agent-config-section'

/**
 * Settings → Agent config (#404, per-agent regrouping per spec
 * 2026-07-17-agent-config-by-agent): the SURFACE honoring the API contract
 * (pinned server-side in src/server/agent-config-api.test.ts). Covers the agent
 * selector, per-agent grouping (incl. shared files under every reader and the
 * MCP subsection with Claude's read-only user scopes), the vendor precedence
 * string, the read-only hosted render, and a save round-trip.
 */

function fileOf(over: Partial<AgentConfigFile> & Pick<AgentConfigFile, 'id' | 'label'>): AgentConfigFile {
  return {
    runners: ['claude'],
    kind: 'settings',
    scope: 'project',
    format: 'json',
    tracked: 'tracked',
    seeded: false,
    holdsMcp: false,
    precedence: 'Overrides user settings key by key.',
    docsUrl: 'https://code.claude.com/docs/en/settings',
    path: `/repo/${over.label}`,
    exists: true,
    size: 10,
    version: 'v1',
    writable: true,
    ...over,
  }
}

const HEALTH = {
  version: '0.0.0',
  repoRoot: '/repo',
  repo: null,
  checks: [{ name: 'claude', available: true }],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true },
}

function serve(listing: AgentConfigListing, fileContent = '{"a":1}') {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/api/v1/health')) return json(HEALTH)
      if (url.endsWith('/api/v1/agent-config')) return json(listing)
      if (url.includes('/api/v1/agent-config/') && method === 'GET') {
        return json({ id: 'x', path: '/repo/x', exists: true, content: fileContent, version: 'v1' })
      }
      if (url.includes('/api/v1/agent-config/') && method === 'PUT') {
        return json({ id: 'x', path: '/repo/x', exists: true, content: '{"a":2}', version: 'v2' })
      }
      return json({ error: 'unexpected' }, 500)
    }),
  )
}

function renderSection(client = createQueryClient()) {
  // Under a router, as in the app: the section's leave guard navigates.
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/agent-config']}>
        <Routes>
          <Route
            path="/settings/agent-config"
            element={
              <>
                <Link to="/settings/appearance">Appearance</Link>
                <AgentConfigSection />
              </>
            }
          />
          <Route path="/settings/appearance" element={<p>Appearance page</p>} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  )
}

function agentTab(agent: string): HTMLElement {
  const el = document.querySelector(`[data-slot="agent-config-agent"][data-agent="${agent}"]`)
  expect(el).toBeTruthy()
  return el as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AgentConfigSection', () => {
  it('renders the agent selector with a not-installed badge from health', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' })],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(agentTab('claude')).toBeTruthy())
    expect(agentTab('claude').getAttribute('data-selected')).toBe('true')
    // health only reports claude available — the others carry the badge
    await waitFor(() => expect(agentTab('codex').textContent).toContain('not installed'))
    expect(agentTab('qwen').textContent).toContain('not installed')
    expect(agentTab('claude').textContent).not.toContain('not installed')
  })

  it('shows only the selected agent’s files and swaps panes on switch', async () => {
    serve({
      editable: true,
      files: [
        fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' }),
        fileOf({ id: 'codex.project.config', label: '.codex/config.toml', runners: ['codex'], format: 'toml', holdsMcp: true }),
      ],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('.claude/settings.json')).toBeTruthy())
    expect(screen.queryByText('.codex/config.toml')).toBeNull()

    fireEvent.click(agentTab('codex'))
    await waitFor(() => expect(screen.getAllByText('.codex/config.toml').length).toBeGreaterThan(0))
    expect(screen.queryByText('.claude/settings.json')).toBeNull()
    // the config.toml holds Codex's MCP servers — it must appear under Settings AND MCP
    const groups = [...document.querySelectorAll('[data-slot="agent-config-group"]')].map((el) =>
      el.getAttribute('data-group'),
    )
    expect(groups).toContain('settings')
    expect(groups).toContain('mcp')
    expect(screen.getAllByText('.codex/config.toml').length).toBe(2)
  })

  it('a file read by several agents appears under every one of them (runners[], not runners[0])', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'project.agents', label: 'AGENTS.md', runners: ['codex', 'qwen'], kind: 'memory', format: 'markdown' })],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(agentTab('codex')).toBeTruthy())
    fireEvent.click(agentTab('codex'))
    await waitFor(() => expect(screen.getByText('AGENTS.md')).toBeTruthy())
    fireEvent.click(agentTab('qwen'))
    await waitFor(() => expect(screen.getByText('AGENTS.md')).toBeTruthy())
  })

  it('Claude’s MCP group lists the user/local scopes read-only', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.project.mcp', label: '.mcp.json', kind: 'mcp', holdsMcp: true })],
      userMcp: { path: '~/.claude.json', servers: ['github', 'sentry'], readable: true },
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('.mcp.json')).toBeTruthy())
    const block = document.querySelector('[data-slot="agent-config-user-mcp"]')!
    expect(block).toBeTruthy()
    expect(block.textContent).toContain('github')
    expect(block.textContent).toContain('sentry')
    expect(block.textContent).toContain('xezar does not edit')
    // the block belongs to Claude's pane only
    fireEvent.click(agentTab('codex'))
    await waitFor(() => expect(document.querySelector('[data-slot="agent-config-user-mcp"]')).toBeNull())
  })

  it('a file selection never survives an agent switch', async () => {
    serve({
      editable: true,
      files: [
        fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' }),
        fileOf({ id: 'qwen.project.settings', label: '.qwen/settings.json', runners: ['qwen'], format: 'jsonc', holdsMcp: true }),
      ],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('.claude/settings.json')).toBeTruthy())
    fireEvent.click(screen.getByText('.claude/settings.json'))
    await waitFor(() => expect(screen.getByLabelText('.claude/settings.json contents')).toBeTruthy())
    fireEvent.click(agentTab('qwen'))
    await waitFor(() => expect(screen.queryByLabelText('.claude/settings.json contents')).toBeNull())
    expect(screen.getByText('Select a config file to view or edit it.')).toBeTruthy()
  })

  it('shows the vendor precedence when a file is selected', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' })],
      userMcp: { path: '~/.claude.json', servers: [], readable: true },
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('.claude/settings.json')).toBeTruthy())
    fireEvent.click(screen.getByText('.claude/settings.json'))
    await waitFor(() => expect(screen.getByText(/Overrides user settings key by key/)).toBeTruthy())
  })

  it('renders read-only in hosted mode — no Save button', async () => {
    serve({
      editable: false,
      files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json', writable: false })],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(screen.getByText(/Read-only/)).toBeTruthy())
    fireEvent.click(screen.getByText('.claude/settings.json'))
    await waitFor(() => expect(screen.getByLabelText('.claude/settings.json contents')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('saves an edited file', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' })],
      userMcp: { path: '~/.claude.json', servers: [], readable: true },
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('.claude/settings.json')).toBeTruthy())
    fireEvent.click(screen.getByText('.claude/settings.json'))
    const editor = (await screen.findByLabelText('.claude/settings.json contents')) as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '{"a":2}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText(/Saved/)).toBeTruthy())
  })
})

describe('AgentConfigSection — unsaved edits are never discarded silently', () => {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  const LISTING: AgentConfigListing = {
    editable: true,
    files: [
      fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' }),
      fileOf({ id: 'claude.local.settings', label: '.claude/settings.local.json', scope: 'local' }),
    ],
    userMcp: null,
  }
  /** Disk holds `disk`; a PUT answers 409 whenever its version is not the disk's. */
  function serveDisk(disk: { content: string; version: string }) {
    const puts: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.endsWith('/api/v1/health')) return json(HEALTH)
        if (url.endsWith('/api/v1/agent-config')) return json(LISTING)
        if (url.includes('/api/v1/agent-config/') && method === 'GET') {
          return json({ id: 'x', path: '/repo/x', exists: true, ...disk })
        }
        if (url.includes('/api/v1/agent-config/') && method === 'PUT') {
          const body = JSON.parse(String(init?.body)) as { version: string }
          puts.push(body)
          if (body.version !== disk.version) return json({ error: 'changed on disk' }, 409)
          return json({ id: 'x', path: '/repo/x', exists: true, content: '{"saved":1}', version: 'v9' })
        }
        return json({ error: 'unexpected' }, 500)
      }),
    )
    return puts
  }
  const openEditor = async (label = '.claude/settings.json') => {
    fireEvent.click(await screen.findByText(label))
    return (await screen.findByLabelText(`${label} contents`)) as HTMLTextAreaElement
  }

  it('Reload from disk asks before replacing the draft; Keep it keeps it, Discard reloads', async () => {
    const disk = { content: '{"a":1}', version: 'v1' }
    serveDisk(disk)
    renderSection()
    const editor = await openEditor()
    fireEvent.change(editor, { target: { value: '{"mine":1}' } })
    disk.content = '{"theirs":1}'
    disk.version = 'v2'
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Reload from disk' }))

    let dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Discard your edits to .claude/settings.json?')).toBeTruthy()
    expect(within(dialog).getByText(/There is no undo\./)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect((screen.getByLabelText('.claude/settings.json contents') as HTMLTextAreaElement).value).toBe('{"mine":1}')

    fireEvent.click(screen.getByRole('button', { name: 'Reload from disk' }))
    dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }))
    await waitFor(() =>
      expect((screen.getByLabelText('.claude/settings.json contents') as HTMLTextAreaElement).value).toBe('{"theirs":1}'),
    )
    expect(document.querySelector('[data-slot="agent-config-conflict"]')).toBeNull()
  })

  it('Reload from disk with nothing edited reloads at once, no confirm', async () => {
    const disk = { content: '{"a":1}', version: 'v1' }
    serveDisk(disk)
    renderSection()
    const editor = await openEditor()
    // Edit, provoke the conflict, then put the text back: nothing left to lose.
    fireEvent.change(editor, { target: { value: '{"mine":1}' } })
    disk.version = 'v2'
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('button', { name: 'Reload from disk' })
    fireEvent.change(editor, { target: { value: '{"a":1}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reload from disk' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('a background refetch with a newer copy neither replaces the draft nor lends Save its version', async () => {
    const disk = { content: '{"a":1}', version: 'v1' }
    const puts = serveDisk(disk)
    const client = createQueryClient()
    renderSection(client)
    const editor = await openEditor()
    fireEvent.change(editor, { target: { value: '{"mine":1}' } })
    disk.content = '{"theirs":1}'
    disk.version = 'v2'
    await act(async () => {
      await client.refetchQueries({ type: 'active' })
      // Let the refetched copy render (and any effect it triggers run) before asserting.
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(editor.value).toBe('{"mine":1}')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    // Saved against the version the edits started from, so the server reports the conflict.
    await screen.findByRole('button', { name: 'Reload from disk' })
    expect(puts).toEqual([{ content: '{"mine":1}', version: 'v1' }])
  })

  it('opening another file with unsaved edits asks first', async () => {
    serveDisk({ content: '{"a":1}', version: 'v1' })
    renderSection()
    const editor = await openEditor()
    fireEvent.change(editor, { target: { value: '{"mine":1}' } })
    fireEvent.click(screen.getByText('.claude/settings.local.json'))
    let dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect((screen.getByLabelText('.claude/settings.json contents') as HTMLTextAreaElement).value).toBe('{"mine":1}')

    fireEvent.click(agentTab('qwen'))
    dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    fireEvent.click(screen.getByText('.claude/settings.local.json'))
    dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }))
    expect(await screen.findByLabelText('.claude/settings.local.json contents')).toBeTruthy()
  })

  it('leaving the page through a link with unsaved edits asks first, and Discard goes there', async () => {
    serveDisk({ content: '{"a":1}', version: 'v1' })
    renderSection()
    const editor = await openEditor()
    fireEvent.change(editor, { target: { value: '{"mine":1}' } })
    fireEvent.click(screen.getByRole('link', { name: 'Appearance' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(screen.queryByText('Appearance page')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }))
    expect(await screen.findByText('Appearance page')).toBeTruthy()
  })

  it('without edits a link leaves at once, and closing the tab is not held up', async () => {
    serveDisk({ content: '{"a":1}', version: 'v1' })
    renderSection()
    await openEditor()
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(false)
    fireEvent.click(screen.getByRole('link', { name: 'Appearance' }))
    expect(await screen.findByText('Appearance page')).toBeTruthy()
  })

  it('closing the tab with unsaved edits asks the browser to confirm', async () => {
    serveDisk({ content: '{"a":1}', version: 'v1' })
    renderSection()
    const editor = await openEditor()
    fireEvent.change(editor, { target: { value: '{"mine":1}' } })
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
  })
})
