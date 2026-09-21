import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import {
  unavailableAgentAccountRefusal,
  type AgentProfile,
  type AgentProfilesResponse,
} from '@qodeca/xezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'
import { agentPickerRows } from '@/components/default-agent-picker'

/**
 * Global settings → Agent accounts.
 *
 * What this pins, in order of how easy each is to break:
 *
 * - the DISCOVERED account carries no Rename/Remove — it is a fact, not a setting;
 * - a folder the CLI has not created yet is listed honestly, not refused;
 * - Remove says out loud that nothing on disk is deleted, because "Remove" next to a path reads
 *   as "delete my folder";
 * - hosted mode shows no paths at all.
 */

const profile = (over: Partial<AgentProfile> & Pick<AgentProfile, 'id'>): AgentProfile => ({
  provider: 'claude',
  label: over.id,
  configDir: `~/.claude-${over.id}`,
  path: `/home/u/.claude-${over.id}`,
  exists: true,
  looksValid: true,
  isDefault: false,
  status: { provider: 'claude', status: 'connected' },
  files: [],
  ...over,
})

const DEFAULTS: AgentProfile[] = [
  profile({ id: 'default', label: 'Default', configDir: '/home/u/.claude', path: '/home/u/.claude', isDefault: true }),
  profile({
    id: 'default',
    provider: 'codex',
    label: 'Default',
    configDir: '/home/u/.codex',
    path: '/home/u/.codex',
    isDefault: true,
    status: { provider: 'codex', status: 'disconnected' },
    files: [],
  }),
]

/** pi's discovered account — kept out of `DEFAULTS` so the existing two-provider cases are untouched. */
const PI_DEFAULT: AgentProfile = profile({
  id: 'default',
  provider: 'pi',
  label: 'Default',
  configDir: '/home/u/.pi/agent',
  path: '/home/u/.pi/agent',
  isDefault: true,
  status: { provider: 'pi', status: 'disconnected' },
  files: [],
})

let requests: Array<{ method: string; url: string; body?: unknown }> = []
/** Every `…/details` GET — used to prove none happens until the row is expanded. */
let detailReads: string[] = []
/** Every `…/status` GET — the listing must never carry auth, so each row asks for its own. */
let statusReads: string[] = []

function serve(
  response: AgentProfilesResponse,
  options: {
    deleteStatus?: number
    deleteError?: string
    createStatus?: number
    createError?: string
    details?: unknown
    openStatus?: number
    openError?: string
    targets?: unknown
    status?: unknown
    importStatus?: number
    importError?: string
    importResult?: { added: number; kept: number; globalImport: { state: 'done' | 'declined' | 'unknown'; importable: number } }
  } = {},
) {
  requests = []
  detailReads = []
  statusReads = []
  let state = response
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/workspace/agent-profiles' && method === 'GET') return json(state)
      if (url.startsWith('/api/v1/workspace/agent-profiles/') && method === 'DELETE') {
        if (options.deleteStatus) return json({ error: options.deleteError }, options.deleteStatus)
        const id = url.split('/').pop()!
        state = { ...state, profiles: state.profiles.filter((p) => p.isDefault || p.id !== id) }
        return json({ removed: true, id })
      }
      if (url.startsWith('/api/v1/workspace/agent-profiles/') && method === 'PATCH') {
        const id = url.split('/').pop()!
        state = {
          ...state,
          profiles: state.profiles.map((p) =>
            !p.isDefault && p.id === id ? { ...p, label: String(body?.label ?? p.label) } : p,
          ),
        }
        return json({ profile: state.profiles.find((p) => !p.isDefault && p.id === id) })
      }
      if (url === '/api/v1/workspace/agent-profiles' && method === 'POST') {
        if (options.createStatus) return json({ error: options.createError }, options.createStatus)
        const created = profile({
          id: 'added',
          label: String(body?.label ?? 'added'),
          configDir: String(body?.configDir),
          path: String(body?.configDir).replace('~', '/home/u'),
          provider: body?.provider as AgentProfile['provider'],
        })
        state = { ...state, profiles: [...state.profiles, created] }
        return json({ profile: created }, 201)
      }
      if (url.includes('/agent-profiles/') && url.endsWith('/details') && method === 'GET') {
        detailReads.push(url)
        return json(options.details ?? { available: true, fields: [
          { label: 'Email', value: 'me@example.com' },
          { label: 'Organization', value: "me@example.com's Organization" },
        ] })
      }
      if (url.includes('/agent-profiles/') && url.endsWith('/open') && method === 'POST') {
        if (options.openStatus) return json({ error: options.openError }, options.openStatus)
        return json({ opened: true, path: '/home/u/.claude/settings.json' })
      }
      if (url.includes('/agent-profiles/') && url.includes('/status') && method === 'GET') {
        statusReads.push(url)
        return json({ status: options.status ?? { provider: 'claude', status: 'connected' } })
      }
      if (url.endsWith('/open-targets') && method === 'GET') {
        return json({ targets: options.targets ?? [
          { id: 'finder', label: 'Finder', icon: 'folder' },
          { id: 'terminal', label: 'Terminal', icon: 'terminal' },
          { id: 'vscode', label: 'VS Code', icon: 'vscode' },
          { id: 'cli:claude', label: 'Claude CLI', icon: 'claude' },
        ] })
      }
      if (url.startsWith('/api/v1/fs/browse') && method === 'GET') {
        return json({
          path: '/home/u',
          parent: null,
          dirs: [{ name: '.claude-second', path: '/home/u/.claude-second', isRepo: false }],
          truncated: false,
        })
      }
      if (url === '/api/v1/workspace/agent-profiles/import-global' && method === 'POST') {
        if (options.importStatus) return json({ error: options.importError }, options.importStatus)
        const answer = options.importResult ?? { added: 0, kept: 0, globalImport: { state: 'done', importable: 0 } }
        state = { ...state, globalImport: answer.globalImport }
        return json(answer)
      }
      if (url === '/api/v1/workspace/agent-profiles/selection' && method === 'PUT') {
        // The server recomputes `problems` after a write; clearing a choice fixes its problem.
        state = {
          ...state,
          problems: (state.problems ?? []).filter((p) => p.provider !== body?.provider),
        }
        return json({ selections: {}, defaults: {} })
      }
      if (url === '/api/v1/projects' && method === 'GET') {
        return json({ projects: [], bootProject: 'boot', projectsDir: '~/xezar/projects' })
      }
      return new Promise<never>(() => {})
    }),
  )
}

function renderAccounts({ singleProjectRoot = false }: { singleProjectRoot?: boolean } = {}) {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } })
  client.setQueryData(queryKeys.health, {
    bootProject: 'boot',
    ...(singleProjectRoot ? { capabilities: { singleProjectRoot: true } } : {}),
    // The install/version rows come from the health probe — the one place a version can honestly
    // come from. Codex is present but UNAVAILABLE, which is "not installed"; an agent missing
    // from `checks` entirely is a different state ("Checking…") and must not be conflated.
    checks: [
      { name: 'claude', available: true, version: '2.1.220' },
      { name: 'codex', available: false, hint: 'optional: install the Codex CLI' },
    ],
  })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/xezar/projects',
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/global/accounts']}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const rows = () => [...document.querySelectorAll('[data-slot="account-row"]')]
/** One agent's group — every agent is on the page at once since #819 PR 9 (no tabs). */
const groupFor = async (provider: string) =>
  waitFor(() => {
    const group = document.querySelector(`[data-slot="accounts-provider"][data-provider="${provider}"]`)
    expect(group).not.toBeNull()
    return group!
  })
const rowFor = (id: string) => document.querySelector(`[data-slot="account-row"][data-account="${id}"]`)

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

/**
 * Rename and Remove live inside "Show details", not on the collapsed row: a row is a reading
 * surface, and a destructive action on it sits one stray click away from a list you scan. So every
 * management assertion below opens the panel first — and the guards that those controls are ABSENT
 * check them with the panel open, or they would pass for the wrong reason.
 */
const openDetails = async (id: string) => {
  const row = await waitFor(() => {
    expect(rowFor(id)).not.toBeNull()
    return rowFor(id)!
  })
  fireEvent.click(row.querySelector('[data-action="account-details-toggle"]')!)
  await waitFor(() => expect(row.querySelector('[data-slot="account-details"]')).not.toBeNull())
  return row
}

describe('the agent accounts section', () => {
  it('lists the discovered account with no edit controls at all', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()

    // Every agent's rows are on the page at once: Claude's and Codex's built-in logins.
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rowFor('default')?.querySelector('[data-slot="account-name"]')?.textContent).toBe('Built-in login')
    // The discovered profile is what xezar found — a Rename or Remove would imply a setting. Checked
    // with the panel OPEN, since that is now the only place either could appear.
    const row = await openDetails('default')
    expect(row.querySelector('[data-slot="account-manage"]')).toBeNull()
    expect(document.querySelector('[data-action="account-rename"]')).toBeNull()
    expect(document.querySelector('[data-action="account-remove"]')).toBeNull()
  })

  it('shows an extra account with its folder as the user wrote it', async () => {
    serve({
      defaults: {},
      editable: true,
      profileCapableProviders: ['claude', 'codex'],
      selections: {},
      profiles: [...DEFAULTS, profile({ id: 'klaudiusz', label: 'Klaudiusz' })],
    })
    renderAccounts()

    await waitFor(() => expect(rowFor('klaudiusz')).not.toBeNull())
    const row = rowFor('klaudiusz')!
    // Stored spelling in the text, the expanded absolute path only in the tooltip.
    expect(row.querySelector('[data-slot="account-path"]')?.textContent).toBe('~/.claude-klaudiusz')
    expect(row.querySelector('[data-slot="account-path"]')?.getAttribute('title')).toBe(
      '/home/u/.claude-klaudiusz',
    )
  })

  it('says a not-yet-created folder is fine, rather than showing it as broken', async () => {
    serve({
      defaults: {},
      editable: true,
      profileCapableProviders: ['claude', 'codex'],
      selections: {},
      profiles: [...DEFAULTS, profile({ id: 'later', exists: false, looksValid: false })],
    })
    renderAccounts()

    await waitFor(() => expect(rowFor('later')).not.toBeNull())
    const row = rowFor('later')!
    expect(row.querySelector('[data-slot="account-missing"]')?.textContent).toContain(
      'Connect will make it',
    )
  })

  // #600 SP-5.5 / DP-5 — in single-project mode the accounts are committed project state, so a
  // folder this machine lacks is a clone naming a login it does not have. The row says
  // "Unavailable" with the path, and the task refusal the engine raises is THIS sentence with the
  // account's name in front (`workspace/agent-profiles.test.ts` pins the engine half against the
  // same contract helper) — one string, two surfaces.
  it('shows a committed account whose folder is missing as Unavailable, with the refusal\'s own sentence', async () => {
    serve({
      defaults: {},
      editable: true,
      profileCapableProviders: ['claude', 'codex'],
      selections: {},
      profiles: [
        ...DEFAULTS,
        profile({ id: 'work', label: 'Work account', configDir: '~/.claude-work', exists: false, looksValid: false }),
      ],
    })
    renderAccounts({ singleProjectRoot: true })

    await waitFor(() => expect(rowFor('work')).not.toBeNull())
    const row = rowFor('work')!
    expect(row.querySelector('[data-slot="account-status"]')?.textContent).toBe('Unavailable')
    const sentence = row.querySelector('[data-slot="account-unavailable"]')?.textContent ?? ''
    expect(sentence).toBe(
      '— this account\'s folder does not exist on this machine: ~/.claude-work. Connect signs in and creates it, or pick another account for the task.',
    )
    expect(unavailableAgentAccountRefusal('Work account', '~/.claude-work')).toBe(
      `Agent account “Work account” is unavailable ${sentence}`,
    )
    // The path inside the sentence is in the mono face, as the #604 mockup draws it (#612 m3, NB-1).
    const path = row.querySelector('[data-slot="account-unavailable-path"]')
    expect(path?.textContent).toBe('~/.claude-work')
    expect(path?.className).toContain('font-mono')
    // Global mode's "Connect will make it" would contradict the refusal, so it is not shown too.
    expect(row.querySelector('[data-slot="account-missing"]')).toBeNull()
    // The discovered account is never unavailable — it is what this machine has.
    expect(rowFor('default')?.querySelector('[data-slot="account-unavailable"]')).toBeNull()
  })

  it('flags an unrecognised folder without refusing it', async () => {
    serve({
      defaults: {},
      editable: true,
      profileCapableProviders: ['claude', 'codex'],
      selections: {},
      profiles: [...DEFAULTS, profile({ id: 'odd', exists: true, looksValid: false })],
    })
    renderAccounts()

    await waitFor(() => expect(rowFor('odd')).not.toBeNull())
    expect(rowFor('odd')!.querySelector('[data-slot="account-unrecognised"]')).not.toBeNull()
    // Still fully usable — the flow is add → Connect → the CLI writes the folder.
    const row = await openDetails('odd')
    expect(row.querySelector('[data-action="account-remove"]')).not.toBeNull()
  })

  /**
   * How a user actually signs a second account in. This is the gap that let the whole affordance
   * ship missing: the pane was thoroughly tested for rename, remove, details, open and selection,
   * and never asked how anyone logs in — while three separate strings told them to press Connect.
   */
  describe('signing an account in', () => {
    it('offers Connect on an account that is not signed in, aimed at THAT account', async () => {
      serve({
        editable: true,
        profileCapableProviders: ['claude', 'codex'],
        selections: {},
        defaults: {},
        profiles: [...DEFAULTS, profile({
          id: 'klaudiusz',
          label: 'Klaudiusz',
          status: { provider: 'claude', status: 'disconnected' },
        })],
      })
      renderAccounts()

      const row = await waitFor(() => {
        expect(rowFor('klaudiusz')).not.toBeNull()
        return rowFor('klaudiusz')!
      })
      fireEvent.click(row.querySelector('[data-action="account-connect"]')!)

      await waitFor(() => expect(requests.some((r) => r.url === '/api/v1/providers/connect')).toBe(true))
      // `profileId` is the whole point: without it the server signs the user into the DISCOVERED
      // account and reports success, which is the failure that made this a merge blocker.
      expect(requests.find((r) => r.url === '/api/v1/providers/connect')?.body).toEqual({
        provider: 'claude',
        profileId: 'klaudiusz',
      })
    })

    it('sends no profileId for the discovered account — it has no stored id', async () => {
      serve({
        editable: true,
        profileCapableProviders: ['claude', 'codex'],
        selections: {},
        defaults: {},
        profiles: [profile({
          id: 'default',
          label: 'Default',
          isDefault: true,
          status: { provider: 'claude', status: 'disconnected' },
        })],
      })
      renderAccounts()

      const row = await waitFor(() => {
        expect(rowFor('default')).not.toBeNull()
        return rowFor('default')!
      })
      fireEvent.click(row.querySelector('[data-action="account-connect"]')!)

      await waitFor(() => expect(requests.some((r) => r.url === '/api/v1/providers/connect')).toBe(true))
      expect(requests.find((r) => r.url === '/api/v1/providers/connect')?.body).toEqual({
        provider: 'claude',
      })
    })

    it('hides Connect once the account IS signed in, but keeps Check again', async () => {
      serve({
        editable: true,
        profileCapableProviders: ['claude', 'codex'],
        selections: {},
        defaults: {},
        profiles: [...DEFAULTS, profile({
          id: 'klaudiusz',
          status: { provider: 'claude', status: 'connected' },
        })],
      })
      renderAccounts()

      const row = await waitFor(() => {
        expect(rowFor('klaudiusz')).not.toBeNull()
        return rowFor('klaudiusz')!
      })
      await waitFor(() => expect(row.querySelector('[data-action="account-connect"]')).toBeNull())
      // A connected account can still have been logged out elsewhere, and the listing serves a
      // cached answer for minutes — so the re-check is what makes that recoverable.
      expect(row.querySelector('[data-action="account-recheck"]')).not.toBeNull()
    })

    it('re-checks ONE account for real, with refresh=1', async () => {
      serve({
        editable: true,
        profileCapableProviders: ['claude', 'codex'],
        selections: {},
        defaults: {},
        profiles: [...DEFAULTS, profile({ id: 'klaudiusz' })],
      })
      renderAccounts()

      const row = await waitFor(() => {
        expect(rowFor('klaudiusz')).not.toBeNull()
        return rowFor('klaudiusz')!
      })
      fireEvent.click(row.querySelector('[data-action="account-recheck"]')!)

      await waitFor(() =>
        expect(requests.some((r) => r.url.includes('/status?refresh=1'))).toBe(true))
    })
  })

  it('keeps Rename and Remove off the collapsed row, behind Show details', async () => {
    serve({
      defaults: {},
      editable: true,
      profileCapableProviders: ['claude', 'codex'],
      selections: {},
      profiles: [...DEFAULTS, profile({ id: 'klaudiusz', label: 'Klaudiusz' })],
    })
    renderAccounts()

    // Scanning the list must not put a destructive action under the cursor.
    const row = await waitFor(() => {
      expect(rowFor('klaudiusz')).not.toBeNull()
      return rowFor('klaudiusz')!
    })
    expect(row.querySelector('[data-action="account-remove"]')).toBeNull()
    expect(row.querySelector('[data-action="account-rename"]')).toBeNull()
    expect(row.querySelector('[data-slot="account-manage"]')).toBeNull()

    await openDetails('klaudiusz')
    expect(row.querySelector('[data-action="account-remove"]')).not.toBeNull()
    expect(row.querySelector('[data-action="account-rename"]')).not.toBeNull()

    // …and folding it away takes them with it.
    fireEvent.click(row.querySelector('[data-action="account-details-toggle"]')!)
    await waitFor(() => expect(row.querySelector('[data-slot="account-manage"]')).toBeNull())
  })

  it('renames without touching the folder', async () => {
    serve({
      defaults: {},
      editable: true,
      profileCapableProviders: ['claude', 'codex'],
      selections: {},
      profiles: [...DEFAULTS, profile({ id: 'klaudiusz', label: 'Klaudiusz' })],
    })
    renderAccounts()

    const row = await openDetails('klaudiusz')
    fireEvent.click(row.querySelector('[data-action="account-rename"]')!)
    fireEvent.change(screen.getByLabelText('Name for Klaudiusz'), { target: { value: 'Client A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(requests.some((r) => r.method === 'PATCH')).toBe(true))
    expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ label: 'Client A' })
  })

  it('confirms a removal by saying what is NOT deleted', async () => {
    serve({
      defaults: {},
      editable: true,
      profileCapableProviders: ['claude', 'codex'],
      selections: {},
      profiles: [...DEFAULTS, profile({ id: 'klaudiusz', label: 'Klaudiusz' })],
    })
    renderAccounts()

    const row = await openDetails('klaudiusz')
    fireEvent.click(row.querySelector('[data-action="account-remove"]')!)

    const confirm = await waitFor(() => document.querySelector('[data-slot="accounts-remove-confirm"]')!)
    expect(confirm.textContent).toContain('~/.claude-klaudiusz')
    expect(confirm.textContent).toContain('is deleted')
    expect(confirm.textContent).toContain('fall back to the default account')

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(requests.some((r) => r.method === 'DELETE')).toBe(true))
    await waitFor(() => expect(rowFor('klaudiusz')).toBeNull())
  })

  it("surfaces a refused removal in the server's own words", async () => {
    serve(
      {
        defaults: {},
        editable: true,
        profileCapableProviders: ['claude', 'codex'],
      selections: {},
        profiles: [...DEFAULTS, profile({ id: 'klaudiusz', label: 'Klaudiusz' })],
      },
      { deleteStatus: 409, deleteError: 'a task is still running on this account' },
    )
    renderAccounts()

    const row = await openDetails('klaudiusz')
    fireEvent.click(row.querySelector('[data-action="account-remove"]')!)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(document.querySelector('[data-slot="toast"]')?.textContent).toContain(
        'a task is still running on this account',
      ),
    )
    // The row did not lie: it stayed, because the server refused.
    expect(rowFor('klaudiusz')).not.toBeNull()
  })

  describe('auth status arrives per row (perf split)', () => {
    it('renders immediately with Checking…, then fills each dot in', async () => {
      // The listing deliberately carries no `status`: probing it cost a CLI spawn per provider and
      // per account, ~2.5s on a real machine. The row says "Checking…" until its own answer lands,
      // which is a distinct state from any probe RESULT — `unknown` would claim a check that never ran.
      serve({
        editable: true,
        profileCapableProviders: ['claude', 'codex'],
        selections: {},
        profiles: [profile({ id: 'default', label: 'Default', isDefault: true, status: undefined })],
      } as never)
      renderAccounts()

      await waitFor(() => expect(rows()).toHaveLength(1))
      await waitFor(() =>
        expect(document.querySelector('[data-slot="account-status"]')?.textContent).toBe('Connected'),
      )
      expect(statusReads).toHaveLength(1)
      expect(statusReads[0]).toContain('default%3Aclaude')
    })

    it('uses a status the listing DID carry, without asking again', async () => {
      // A server whose probe cache was already warm answers inline; re-asking would be a request
      // for something we already have.
      serve({
        editable: true,
        profileCapableProviders: ['claude', 'codex'],
        selections: {},
        profiles: [profile({
          id: 'default',
          label: 'Default',
          isDefault: true,
          status: { provider: 'claude', status: 'disconnected' },
        })],
      } as never)
      renderAccounts()

      await waitFor(() =>
        expect(document.querySelector('[data-slot="account-status"]')?.textContent).toBe('Not connected'),
      )
    })
  })

  describe('Show details', () => {
    const CLAUDE_FILES = [
      { id: 'claude.user.settings', label: 'settings.json', path: '/home/u/.claude/settings.json', exists: true },
      { id: 'claude.user.memory', label: 'CLAUDE.md', path: '/home/u/.claude/CLAUDE.md', exists: false },
    ]
    const withFiles = () => ({
      editable: true as const,
      profileCapableProviders: ['claude', 'codex'] as const,
      selections: {},
      profiles: [profile({ id: 'default', label: 'Default', isDefault: true, files: CLAUDE_FILES })],
    })
    const toggle = () => document.querySelector<HTMLButtonElement>('[data-action="account-details-toggle"]')!

    it('fetches NOTHING until asked — hidden means absent, not merely unrendered', async () => {
      serve(withFiles() as never)
      renderAccounts()

      await waitFor(() => expect(rows()).toHaveLength(1))
      expect(detailReads).toEqual([])
      expect(document.querySelector('[data-slot="account-details"]')).toBeNull()
      // …and the listing itself never carried an identity to leak.
      expect(JSON.stringify(withFiles())).not.toContain('@example.com')
    })

    it('reveals the identity on demand, and hides it again', async () => {
      serve(withFiles() as never)
      renderAccounts()
      await waitFor(() => expect(rows()).toHaveLength(1))

      fireEvent.click(toggle())
      await waitFor(() =>
        expect(document.querySelector('[data-slot="account-identity"]')?.textContent).toContain(
          'me@example.com',
        ),
      )
      expect(detailReads).toHaveLength(1)
      // Addressed as `default:<provider>`, since every discovered account shares `id: "default"`.
      expect(detailReads[0]).toContain('default%3Aclaude')

      fireEvent.click(toggle())
      await waitFor(() => expect(document.querySelector('[data-slot="account-details"]')).toBeNull())
    })

    it('says WHY there is nothing rather than showing an empty panel', async () => {
      serve(withFiles() as never, {
        details: { available: false, reason: 'Not signed in on this account yet — use Connect.', fields: [] },
      })
      renderAccounts()
      await waitFor(() => expect(rows()).toHaveLength(1))

      fireEvent.click(toggle())
      await waitFor(() =>
        expect(
          document.querySelector('[data-slot="account-identity-unavailable"]')?.textContent,
        ).toContain('Not signed in'),
      )
    })

    const fileMenus = () => [...document.querySelectorAll('[data-slot="account-open-file"]')]
    /** Radix opens on pointerdown; then pick an item by its target id. */
    const pickFrom = async (trigger: Element, target: string) => {
      fireEvent.pointerDown(trigger)
      await waitFor(() => expect(document.querySelector(`[data-target="${target}"]`)).not.toBeNull())
      fireEvent.click(document.querySelector(`[data-target="${target}"]`)!)
    }
    const openBody = () => requests.find((r) => r.url.endsWith('/open'))?.body

    it('offers each of the account\'s own config files, and its folder', async () => {
      serve(withFiles() as never)
      renderAccounts()
      await waitFor(() => expect(rows()).toHaveLength(1))
      fireEvent.click(toggle())

      await waitFor(() => expect(fileMenus()).toHaveLength(2))
      expect(fileMenus().map((b) => b.textContent)).toEqual(['settings.json', 'CLAUDE.md'])
      // A file the agent has not written yet is still offered, and says so on hover.
      expect(fileMenus()[1]?.getAttribute('title')).toContain('not created yet')
      expect(document.querySelector('[data-slot="account-open-folder"]')).not.toBeNull()
    })

    it('opens with the system default by ID — never by a path the client composed', async () => {
      serve(withFiles() as never)
      renderAccounts()
      await waitFor(() => expect(rows()).toHaveLength(1))
      fireEvent.click(toggle())
      await waitFor(() => expect(fileMenus()).toHaveLength(2))

      await pickFrom(fileMenus()[0]!, 'system')
      await waitFor(() => expect(openBody()).toBeDefined())
      // No `target` at all is what "system default" means on the wire.
      expect(openBody()).toEqual({ file: 'claude.user.settings' })
      // The path is the server's to resolve; nothing path-shaped is sent.
      expect(JSON.stringify(openBody())).not.toContain('/')
    })

    it('lets you pick a detected editor instead of the system default', async () => {
      serve(withFiles() as never)
      renderAccounts()
      await waitFor(() => expect(rows()).toHaveLength(1))
      fireEvent.click(toggle())
      await waitFor(() => expect(fileMenus()).toHaveLength(2))

      await pickFrom(fileMenus()[0]!, 'vscode')
      await waitFor(() => expect(openBody()).toBeDefined())
      expect(openBody()).toEqual({ file: 'claude.user.settings', target: 'vscode' })
    })

    it('never offers a target that cannot act on a FILE', async () => {
      serve(withFiles() as never)
      renderAccounts()
      await waitFor(() => expect(rows()).toHaveLength(1))
      fireEvent.click(toggle())
      await waitFor(() => expect(fileMenus()).toHaveLength(2))

      fireEvent.pointerDown(fileMenus()[0]!)
      await waitFor(() => expect(document.querySelector('[data-target="vscode"]')).not.toBeNull())
      // `terminal` would `cd` into the file; a `cli:` handoff would start an agent session in the
      // config folder. The route refuses both — the menu must not offer them either.
      expect(document.querySelector('[data-target="terminal"]')).toBeNull()
      expect(document.querySelector('[data-target="cli:claude"]')).toBeNull()
      expect(document.querySelector('[data-target="finder"]')).toBeNull()
    })

    it('does offer the file manager and a terminal for the FOLDER', async () => {
      serve(withFiles() as never)
      renderAccounts()
      await waitFor(() => expect(rows()).toHaveLength(1))
      fireEvent.click(toggle())
      await waitFor(() =>
        expect(document.querySelector('[data-slot="account-open-folder"]')).not.toBeNull(),
      )

      fireEvent.pointerDown(document.querySelector('[data-slot="account-open-folder"]')!)
      await waitFor(() => expect(document.querySelector('[data-target="finder"]')).not.toBeNull())
      expect(document.querySelector('[data-target="terminal"]')).not.toBeNull()
      // Still never an agent CLI: that opens a task worktree, not a config folder.
      expect(document.querySelector('[data-target="cli:claude"]')).toBeNull()
    })

    it("surfaces the server's refusal when a file is not there yet", async () => {
      serve(withFiles() as never, {
        openStatus: 409,
        openError: 'this account has no CLAUDE.md yet',
      })
      renderAccounts()
      await waitFor(() => expect(rows()).toHaveLength(1))
      fireEvent.click(toggle())
      await waitFor(() => expect(fileMenus()).toHaveLength(2))

      await pickFrom(fileMenus()[1]!, 'system')
      await waitFor(() =>
        expect(document.querySelector('[data-slot="toast"]')?.textContent).toContain(
          'no CLAUDE.md yet',
        ),
      )
    })
  })

  /**
   * A cockpit newer than the server it is talking to — routine in development, where Vite serves
   * this bundle while `dist/` or a separate process serves the API. An additive field the server
   * has never heard of must degrade, not crash: `account.files.map` of undefined took the whole
   * pane down with a white screen.
   */
  it('survives a server that answers without the additive collections', async () => {
    serve({
      editable: true,
      profiles: [{
        id: 'default',
        provider: 'claude',
        label: 'Default',
        configDir: '/home/u/.claude',
        path: '/home/u/.claude',
        exists: true,
        looksValid: true,
        isDefault: true,
        status: { provider: 'claude', status: 'connected' },
        // No `files` — the field this pane crashed on.
      }],
      // No `profileCapableProviders`, no `selections` either.
    } as never)
    renderAccounts()

    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.click(document.querySelector('[data-action="account-details-toggle"]')!)

    // The panel renders, with no file buttons and the folder action still usable.
    await waitFor(() => expect(document.querySelector('[data-slot="account-details"]')).not.toBeNull())
    expect([...document.querySelectorAll('[data-slot="account-open-file"]')]).toHaveLength(0)
    expect(document.querySelector('[data-slot="account-open-folder"]')).not.toBeNull()
    // …and no Add button, because the server never said which providers can carry one.
    expect(document.querySelector('[data-action="accounts-add"]')).toBeNull()
  })

  it('withholds every path in hosted mode', async () => {
    serve({ editable: false, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: [] })
    renderAccounts()

    await waitFor(() =>
      expect(document.querySelector('[data-slot="accounts-hosted"]')?.textContent).toContain(
        'hosted mode',
      ),
    )
    expect(rows()).toHaveLength(0)
    expect(document.querySelector('[data-action="accounts-add"]')).toBeNull()
  })

  it('gives every agent a group, including one that cannot carry a second account', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()

    await waitFor(() => expect(rows()).toHaveLength(2))
    // OpenCode and pi get a group too: it is where "is this agent installed?" is answered, and
    // hiding the ones that cannot carry a second login would only move that question elsewhere.
    expect(
      [...document.querySelectorAll('[data-slot="accounts-provider"]')].map((el) =>
        el.getAttribute('data-provider'),
      ),
    ).toEqual(['claude', 'codex', 'opencode', 'pi'])
  })

  it('offers no Add on an agent that cannot carry a second account, and says why', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()

    const group = await groupFor('opencode')
    expect(group.querySelector('[data-action="accounts-add"]')).toBeNull()
    expect(group.querySelector('[data-slot="accounts-single-only"]')?.textContent).toContain(
      'credentials outside its config folder',
    )
  })

  it('reports what the MACHINE has for the active agent, not per account', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()

    // A version and an install belong to the BINARY: every login of one CLI shares them.
    const group = await groupFor('claude')
    await waitFor(() =>
      expect(group.querySelector('[data-slot="agent-version"]')?.textContent).toBe(' · 2.1.220'),
    )
    expect(group.querySelector('[data-slot="agent-installed"]')?.textContent).toBe('Installed')
    // One heading line per agent: installed, version, and how many logins it has.
    expect(group.querySelector('[data-slot="agent-facts"]')?.textContent).toBe('Installed · 2.1.220 · 1 account')
  })

  it('names the install command for an agent that is not on this machine', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()

    const codex = await groupFor('codex')
    expect(codex.querySelector('[data-slot="agent-installed"]')?.textContent).toBe('Not installed')
    // No version at all when there is nothing installed to have one.
    expect(codex.querySelector('[data-slot="agent-version"]')).toBeNull()
  })

  it('gives an agent with no login at all its own words, naming the install when it is missing', async () => {
    // Codex is not installed (the health fixture) and this listing carries no Codex row.
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: [DEFAULTS[0]!] })
    renderAccounts()

    const codex = await groupFor('codex')
    expect(codex.querySelector('[data-slot="agent-facts"]')?.textContent).toBe('Not installed · no accounts')
    expect(codex.querySelector('[data-slot="accounts-provider-empty"]')?.textContent).toContain(
      'No Codex accounts yet',
    )
    expect(codex.querySelector('[data-slot="accounts-provider-empty"]')?.textContent).toContain(
      'npm i -g @openai/codex',
    )
    // An empty frame is not a tile per agent: no CenteredState is rendered for it.
    expect(codex.querySelector('[data-slot="centered-state"]')).toBeNull()
  })
})

/**
 * "Add agent account". The folder is a TYPED field, not a browse-only selection, and that is the
 * whole point: every agent config folder is hidden, and the documented flow adds one that does
 * not exist yet — neither is reachable through a picker that only lists visible directories.
 */
describe('the add-account dialog', () => {
  const openDialog = async (provider = 'claude') => {
    await groupFor(provider)
    await waitFor(() => expect(document.querySelector('[data-action="accounts-add"]')).not.toBeNull())
    fireEvent.click(document.querySelector(`[data-action="accounts-add"][data-provider="${provider}"]`)!)
    await waitFor(() => expect(document.querySelector('[data-slot="add-account-dialog"]')).not.toBeNull())
  }
  const dirField = () => screen.getByLabelText<HTMLInputElement>('Config folder')
  const confirmButton = () => document.querySelector<HTMLButtonElement>('[data-slot="add-account-confirm"]')!

  it('accepts a hand-typed `~` folder that does not exist yet', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()
    await openDialog()

    // Nothing browsed, nothing selected — just typed, which is the fast path.
    expect(confirmButton().disabled).toBe(true)
    fireEvent.change(dirField(), { target: { value: '~/.claude-second' } })
    expect(confirmButton().disabled).toBe(false)
    fireEvent.click(confirmButton())

    await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true))
    // Sent as WRITTEN: the `~` is the server's to expand, and it stores the user's spelling.
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
      provider: 'claude',
      configDir: '~/.claude-second',
    })
  })

  // #453 B3 design review NB-4: the dialog is mounted only while open, so Escape unmounted it and
  // dropped keyboard focus on <body> instead of the "Add account" button that opened it.
  it('Escape hands keyboard focus back to the Add account button', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()
    await waitFor(() => expect(document.querySelector('[data-action="accounts-add"]')).not.toBeNull())
    const opener = document.querySelector<HTMLButtonElement>('[data-action="accounts-add"][data-provider="claude"]')!
    opener.focus()
    fireEvent.click(opener)
    const dialog = await waitFor(() => {
      const element = document.querySelector('[data-slot="add-account-dialog"]')
      expect(element?.contains(document.activeElement)).toBe(true)
      return element!
    })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[data-slot="add-account-dialog"]')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  // #453 B3 design review NB-5: the Agent select names products, not backend ids.
  it('the Agent select shows product names and keeps the ids as values', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()
    await openDialog()
    const options = [...document.querySelectorAll<HTMLOptionElement>('[data-slot="add-account-provider"] option')]
    expect(options.map((o) => [o.value, o.textContent])).toEqual([['claude', 'Claude Code'], ['codex', 'Codex']])
  })

  it('refuses an empty folder without sending anything', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()
    await openDialog()

    fireEvent.change(dirField(), { target: { value: '   ' } })
    expect(confirmButton().disabled).toBe(true)
    expect(requests.some((r) => r.method === 'POST')).toBe(false)
  })

  it('asks the browser for HIDDEN folders — otherwise it lists no candidate at all', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()
    await openDialog()

    // Collapsed by default: typing is the fast path, and no browse request has been made yet.
    expect(requests.some((r) => r.url.startsWith('/api/v1/fs/browse'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))

    await waitFor(() => expect(requests.some((r) => r.url.startsWith('/api/v1/fs/browse'))).toBe(true))
    expect(requests.find((r) => r.url.startsWith('/api/v1/fs/browse'))?.url).toContain('showHidden=1')
    // …and the dotfolder the server returned is actually offered.
    expect(await screen.findByText('.claude-second')).not.toBeNull()
  })

  it('browsing FILLS the folder field rather than replacing it as a hidden selection', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()
    await openDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))

    fireEvent.click(await screen.findByText('.claude-second'))
    // The user can see, and still edit, exactly what will be submitted.
    await waitFor(() => expect(dirField().value).toBe('/home/u/.claude-second'))

    fireEvent.click(confirmButton())
    await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true))
    expect(requests.find((r) => r.method === 'POST')?.body).toMatchObject({
      configDir: '/home/u/.claude-second',
    })
  })

  it('opens on the agent whose own Add button was clicked', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()
    await openDialog('codex')

    expect(screen.getByLabelText<HTMLSelectElement>('Agent').value).toBe('codex')
    // The placeholder follows too, so the example folder is not the wrong agent's. It stays a
    // GENERIC name — this string ships to every xezar user, so it must not carry one person's.
    expect(dirField().placeholder).toBe('~/.codex-second')
  })

  /**
   * pi entered this dropdown the moment it became profile-capable (#329), and the placeholder was
   * a ternary that fell through to `~/.claude-second` for anything that was not codex — so the
   * first thing a pi account was offered was a Claude folder name.
   */
  it('suggests pi\'s OWN folder for a pi account, not Claude\'s', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex', 'pi'],
      defaults: {},
      selections: {}, profiles: [...DEFAULTS, PI_DEFAULT] })
    renderAccounts()
    await openDialog('pi')

    expect(screen.getByLabelText<HTMLSelectElement>('Agent').value).toBe('pi')
    expect(dirField().placeholder).toBe('~/.pi/agent-second')
    expect(dirField().placeholder).not.toContain('claude')
  })

  it("shows the server's refusal verbatim", async () => {
    serve(
      { editable: true, profileCapableProviders: ['claude', 'codex'],
        defaults: {},
      selections: {}, profiles: DEFAULTS },
      { createStatus: 409, createError: "that is already this agent's default folder" },
    )
    renderAccounts()
    await openDialog()

    fireEvent.change(dirField(), { target: { value: '~/.claude' } })
    fireEvent.click(confirmButton())

    await waitFor(() =>
      expect(document.querySelector('[data-slot="add-account-error"]')?.textContent).toBe(
        "that is already this agent's default folder",
      ),
    )
  })
})

/**
 * #819 PR 9 (designs/agent-accounts-onboarding): which login each agent uses, the built-in login
 * named as built-in, the choices that name a missing account, and no identity on a collapsed row.
 * Every marker and problem comes from the SERVER — each case below fails against a pane that drops
 * the field, derives it itself, or prints what it should withhold.
 */
describe('the accounts pane – in use, built-in and problems (#819 PR 9)', () => {
  const inUse = () =>
    [...document.querySelectorAll('[data-slot="account-in-use"]')].map((badge) => ({
      account: badge.closest('[data-slot="account-row"]')?.getAttribute('data-account'),
      provider: badge.closest('[data-slot="accounts-provider"]')?.getAttribute('data-provider'),
      text: badge.textContent,
    }))

  const WORK = profile({ id: 'work', label: 'Work', selected: true })
  const withSelection: AgentProfile[] = [
    { ...DEFAULTS[0]!, selected: false },
    WORK,
    { ...DEFAULTS[1]!, selected: true },
  ]

  // Break: the badge keyed on `isDefault` (or on nothing) instead of the server's `selected`.
  it('marks exactly one account per agent "In use", from the server’s `selected`', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'], defaults: {}, selections: {},
      profiles: withSelection, problems: [] })
    renderAccounts({ singleProjectRoot: true })

    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(inUse()).toEqual([
      { account: 'work', provider: 'claude', text: 'In use' },
      { account: 'default', provider: 'codex', text: 'In use' },
    ])
  })

  // Break: "In use" in the global layout, where `selected` is the machine default and not what
  // every project runs (design OD-3).
  it('says "Default" instead in the global layout', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'], defaults: {}, selections: {},
      profiles: withSelection, problems: [] })
    renderAccounts()

    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(inUse().map((marker) => marker.text)).toEqual(['Default', 'Default'])
  })

  // Break: the built-in row still named "Default" and badged "discovered" (the pre-#819 pane).
  it('names the built-in login in words, with what it is, and never "discovered"', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'], defaults: {}, selections: {},
      profiles: withSelection, problems: [] })
    renderAccounts({ singleProjectRoot: true })

    const row = await waitFor(() => {
      const found = document.querySelector('[data-slot="accounts-provider"][data-provider="claude"] [data-built-in="true"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(row.querySelector('[data-slot="account-name"]')?.textContent).toBe('Built-in login')
    expect(row.querySelector('[data-slot="account-built-in"]')?.textContent).toBe(
      'Found on this machine — xezar does not save it.',
    )
    expect(document.body.textContent).not.toContain('discovered')
  })

  // Break: a dangling project default that the pane never mentions (the #819 item 2 confusion).
  it('names a dangling default, what tasks do instead, and fixes it with the built-in login', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'], defaults: { claude: 'client-a' },
      selections: {}, profiles: DEFAULTS,
      problems: [{ kind: 'unknown-account', where: 'defaults', provider: 'claude', handle: 'client-a' }] })
    renderAccounts({ singleProjectRoot: true })

    const summary = await waitFor(() => {
      const found = document.querySelector('[data-slot="accounts-problems"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(summary.textContent).toBe(
      '1 account choice names an account that is not in this list. Tasks still run, with the built-in login. See Claude Code.',
    )
    expect(summary.getAttribute('aria-live')).toBe('polite')
    const block = document.querySelector('[data-slot="accounts-provider"][data-provider="claude"] [data-slot="account-problem"]')!
    expect(block.getAttribute('data-where')).toBe('defaults')
    expect(block.textContent).toContain(
      'The project default for Claude Code names client-a, which is not in this list. Tasks use the built-in login instead.',
    )
    expect(block.querySelector('[data-slot="account-problem-fix"]')?.textContent).toBe(
      'Fix: choose an account under Defaults for this project, or use the built-in login.',
    )
    expect(document.querySelector('[data-slot="agent-problem-count"]')?.textContent).toBe('1 choice to fix')

    fireEvent.click(block.querySelector('[data-action="account-problem-use-built-in"]')!)
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
        projectId: null,
        provider: 'claude',
        profileId: null,
      }),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-slot="toast"]')?.textContent).toContain(
        'Claude Code now uses the built-in login',
      ),
    )
    // The server recomputes `problems`; the refetch removes the line and the block.
    await waitFor(() => expect(document.querySelector('[data-slot="accounts-problems"]')).toBeNull())
    expect(document.querySelector('[data-slot="account-problem"]')).toBeNull()
  })

  // Break: a selection problem worded as a default, or its fix clearing the machine-wide default.
  it('names a dangling project selection and clears THIS project’s choice', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'], defaults: {},
      selections: { '/repo': { codex: 'work' } }, profiles: DEFAULTS,
      problems: [{ kind: 'unknown-account', where: 'selection', provider: 'codex', handle: 'work' }] })
    renderAccounts({ singleProjectRoot: true })

    const block = await waitFor(() => {
      const found = document.querySelector('[data-slot="accounts-provider"][data-provider="codex"] [data-slot="account-problem"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(block.textContent).toContain(
      'This project’s own choice for Codex names work, which is not in this list. Tasks use the built-in login instead.',
    )
    expect(block.querySelector('[data-action="account-problem-agents-settings"]')?.textContent).toBe('Agents settings')
    fireEvent.click(block.querySelector('[data-action="account-problem-use-built-in"]')!)
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
        projectId: 'default',
        provider: 'codex',
        profileId: null,
      }),
    )
  })

  // Break: a missing `problems` key read as "no problems" and a fabricated all-clear, or a line
  // drawn for an empty list.
  it('draws no problem line when the key is absent or empty', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'], defaults: {}, selections: {},
      profiles: DEFAULTS })
    renderAccounts({ singleProjectRoot: true })
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(document.querySelector('[data-slot="accounts-problems"]')).toBeNull()
    expect(document.querySelector('[data-slot="account-problem"]')).toBeNull()
    expect(document.querySelector('[data-slot="agent-problem-count"]')).toBeNull()
  })

  // Break: a jump link that only scrolls, leaving keyboard focus at the top of the pane.
  it('moves focus to the agent’s heading from the summary’s jump link', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'], defaults: {}, selections: {},
      profiles: DEFAULTS,
      problems: [{ kind: 'unknown-account', where: 'defaults', provider: 'codex', handle: 'gone' }] })
    renderAccounts({ singleProjectRoot: true })

    const jump = await waitFor(() => {
      const found = document.querySelector<HTMLAnchorElement>('[data-action="accounts-problem-jump"][data-provider="codex"]')
      expect(found).not.toBeNull()
      return found!
    })
    fireEvent.click(jump)
    expect(document.activeElement?.id).toBe('accounts-agent-codex')
    expect(document.activeElement?.textContent).toBe('Codex')
  })

  // Break: an e-mail-shaped label or handle printed on the collapsed row, the picker, the problem
  // sentence or the Remove confirm (P9-AC5).
  it('never prints an e-mail-shaped label or handle before Show details', async () => {
    const hidden = profile({ id: 'client', label: 'a@b.example', configDir: '~/.claude-client' })
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'], defaults: { claude: 'x@y.example' },
      selections: {}, profiles: [...DEFAULTS, hidden],
      problems: [{ kind: 'unknown-account', where: 'defaults', provider: 'claude', handle: 'x@y.example' }] })
    renderAccounts({ singleProjectRoot: true })

    const row = await waitFor(() => {
      expect(rowFor('client')).not.toBeNull()
      return rowFor('client')!
    })
    expect(row.getAttribute('data-label-hidden')).toBe('true')
    expect(row.querySelector('[data-slot="account-name"]')?.textContent).toBe('Name hidden')
    expect(document.querySelector('[data-slot="account-problem"]')?.textContent).toContain(
      'The project default for Claude Code names an account that is not in this list.',
    )
    expect(document.body.innerHTML).not.toContain('a@b.example')
    expect(document.body.innerHTML).not.toContain('x@y.example')

    // Show details is the one opt-in door; the Remove confirm still withholds it.
    fireEvent.click(row.querySelector('[data-action="account-details-toggle"]')!)
    fireEvent.click(await waitFor(() => {
      const remove = row.querySelector('[data-action="account-remove"]')
      expect(remove).not.toBeNull()
      return remove!
    }))
    await waitFor(() =>
      expect(document.querySelector('[data-slot="accounts-remove-confirm"]')?.textContent).toContain(
        'Remove this account?',
      ),
    )
    expect(document.querySelector('[data-slot="accounts-remove-confirm"]')?.textContent).not.toContain('a@b.example')
  })

  // Break: the fix button rendered in hosted mode (it is a local-machine write).
  it('renders no problem line and no fix in hosted mode', async () => {
    serve({ editable: false, profileCapableProviders: [], defaults: {}, selections: {}, profiles: [],
      problems: [] })
    renderAccounts()
    await waitFor(() => expect(document.querySelector('[data-slot="accounts-hosted"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="accounts-problems"]')).toBeNull()
    expect(document.querySelector('[data-action="account-problem-use-built-in"]')).toBeNull()
  })
})

// Break: the Defaults picker still printing the stored label — "claude · Default" for the built-in
// login, or an e-mail address on a collapsed radio (design § 7).
describe('the Defaults picker rows (#819 PR 9)', () => {
  it('names the built-in login and hides an identity-shaped label', () => {
    const labels = agentPickerRows([
      DEFAULTS[0]!,
      profile({ id: 'work', label: 'Work' }),
      profile({ id: 'client', label: 'a@b.example' }),
    ]).filter((row) => row.runner.id === 'claude').map((row) => row.label)
    expect(labels).toEqual(['claude · Built-in login', 'claude · Work', 'claude · Name hidden'])
  })
})

/**
 * #819 PR 9 — the global-import block (designs/agent-accounts-onboarding § 7, import.html 1–7).
 * Each case names the break it fails against.
 */
describe('the accounts pane – the global-import block (#819 PR 9)', () => {
  const base = { editable: true, profileCapableProviders: ['claude', 'codex'] as AgentProfile['provider'][],
    defaults: {}, selections: {}, profiles: DEFAULTS, problems: [] }
  const block = () => document.querySelector('[data-slot="accounts-import"]')
  const copyButton = () => document.querySelector<HTMLButtonElement>('[data-action="accounts-import"]')
  const renderWith = async (globalImport: AgentProfilesResponse['globalImport'], singleProjectRoot = true, options = {}) => {
    serve({ ...base, ...(globalImport ? { globalImport } : {}) }, options)
    renderAccounts({ singleProjectRoot })
    await waitFor(() => expect(rows()).toHaveLength(2))
  }

  // Break: the first offer drawn as a line (no stated cost), or without the CLI alternative.
  it('offers the first copy as a card that states the cost, with the CLI alternative', async () => {
    await renderWith({ state: 'unknown', importable: 3 })
    expect(block()?.querySelector('h3')?.textContent).toBe('Copy accounts from your personal setup')
    expect(block()?.textContent).toContain(
      '3 accounts in your personal xezar setup on this machine are not in this project yet. Copying adds their names and config folders to .xezar/agent-accounts.json, which is committed, so everyone who clones this project sees them. Sign-ins stay in their own folders and are never copied.',
    )
    expect(copyButton()?.textContent).toBe('Copy 3 accounts')
    expect(block()?.querySelector('[data-slot="accounts-import-cli"]')?.textContent).toBe(
      'Or run xezar accounts import-global in a terminal in this folder.',
    )
  })

  it('says "1 account … is" and "Copy 1 account" for one', async () => {
    await renderWith({ state: 'unknown', importable: 1 })
    expect(block()?.textContent).toContain('1 account in your personal xezar setup on this machine is not in this project yet.')
    expect(copyButton()?.textContent).toBe('Copy 1 account')
  })

  // Break: a "Copy 0 accounts" button, or a card offering nothing.
  it('shows one line and NO button when there is nothing to copy', async () => {
    await renderWith({ state: 'unknown', importable: 0 })
    expect(block()?.querySelector('[data-slot="accounts-import-line"]')?.textContent).toBe(
      'There are no accounts in your personal xezar setup that this project does not already have.',
    )
    expect(copyButton()).toBeNull()
  })

  it('reminds a person who declined, with the button while something is left', async () => {
    await renderWith({ state: 'declined', importable: 2 })
    expect(block()?.querySelector('[data-slot="accounts-import-line"]')?.textContent).toBe(
      'You chose not to copy accounts from your personal xezar setup when this project was set up. 2 can still be copied into .xezar/agent-accounts.json.',
    )
    expect(copyButton()?.textContent).toBe('Copy 2 accounts')
  })

  it('says done — and offers the rest when more were added since', async () => {
    await renderWith({ state: 'done', importable: 0 })
    expect(block()?.textContent).toContain('Accounts were copied from your personal xezar setup — this project has all of them.')
    expect(copyButton()).toBeNull()
    cleanup()
    await renderWith({ state: 'done', importable: 2 })
    expect(block()?.textContent).toContain(
      'Accounts were copied from your personal xezar setup. 2 more were added there since and can be copied too.',
    )
    expect(copyButton()?.textContent).toBe('Copy 2 accounts')
  })

  // Break: an absent key read as "unknown" (a fabricated offer), or the block in the global layout.
  it('draws nothing when the key is absent, and nothing in the global layout', async () => {
    await renderWith(undefined)
    expect(block()).toBeNull()
    cleanup()
    await renderWith({ state: 'unknown', importable: 3 }, false)
    expect(block()).toBeNull()
  })

  // P9-AC3. Break: a click that runs anything but the import route, or never refetches.
  it('copies on a click only — posting the import once, toasting the counts, announcing the new state', async () => {
    await renderWith({ state: 'unknown', importable: 3 }, true, {
      importResult: { added: 2, kept: 1, globalImport: { state: 'done', importable: 0 } },
    })
    // Nothing is posted on load.
    expect(requests.some((r) => r.url.endsWith('/import-global'))).toBe(false)
    fireEvent.click(copyButton()!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="toast"]')?.textContent).toContain(
        'Copied 2 accounts — 1 was already in this project',
      ),
    )
    expect(requests.filter((r) => r.url === '/api/v1/workspace/agent-profiles/import-global')).toEqual([
      { method: 'POST', url: '/api/v1/workspace/agent-profiles/import-global', body: undefined },
    ])
    await waitFor(() =>
      expect(document.querySelector('[data-slot="accounts-import-announcer"]')?.textContent).toBe(
        'Accounts were copied from your personal xezar setup — this project has all of them.',
      ),
    )
    // The listing refetch turns the card into the done line.
    await waitFor(() => expect(block()?.getAttribute('data-state')).toBe('done'))
    expect(copyButton()).toBeNull()
  })

  it("shows a refused copy in the server's own words", async () => {
    await renderWith({ state: 'unknown', importable: 3 }, true, {
      importStatus: 409, importError: 'could not read the agent accounts — nothing was copied',
    })
    fireEvent.click(copyButton()!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="toast"]')?.textContent).toContain(
        'could not read the agent accounts — nothing was copied',
      ),
    )
  })

  // Break: the import block or its button rendered in hosted mode (absent, not disabled).
  it('renders no import block, button or CLI line in hosted mode', async () => {
    serve({ editable: false, profileCapableProviders: [], defaults: {}, selections: {}, profiles: [],
      problems: [], globalImport: { state: 'unknown', importable: 3 } })
    renderAccounts({ singleProjectRoot: true })
    await waitFor(() => expect(document.querySelector('[data-slot="accounts-hosted"]')).not.toBeNull())
    expect(block()).toBeNull()
    expect(copyButton()).toBeNull()
    expect(document.body.textContent).not.toContain('import-global')
  })
})
