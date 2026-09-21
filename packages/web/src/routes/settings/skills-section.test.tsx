import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CATALOG_POLL_ATTEMPTS,
  queryKeys,
  skillsUpdateRefetchMs,
  workspaceQueryKeys,
} from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type {
  SkillsCatalogVersion,
  SkillsUpdateState,
  WorkspaceConfigResponse,
} from '@qodeca/xezar-api-client'
import { AppRoutes } from '@/routes'
import { catalogAnnouncement, catalogExplanation, catalogStateLabel } from './skills-section'
// A test-only reach into the service, the same one `lib/github-task.test.ts` makes for
// `runs/task-refs` (AGENTS.md § Repository layout). One case below renders the entry the REAL
// producer builds for a cache with no successful fetch on record, because a hand-written fixture
// of that shape is what let #752's M1 through: it can only be written by someone who already
// believes what the server sends.
import { bareDirFor, skillsCatalogVersions } from '../../../../xezar/src/skills-remote'
import { projectStateLayout, setActiveStateLayout } from '../../../../xezar/src/state-layout'

/** Fixture git, never the developer's own config: `tag.gpgSign` and friends turn a plain `git tag`
 *  into a signed one and the fixture then fails on one machine and not another. */
function gitFixture(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  })
}

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function serve(
  overrides: Partial<WorkspaceConfigResponse> = {},
  updateOverrides: Partial<SkillsUpdateState> = {},
  updateMode: 'ok' | 'pending' | 'error' = 'ok',
) {
  requests = []
  const config: WorkspaceConfigResponse = {
    browseRoot: '~/',
    projectsDir: '~/xezar/projects',
    skillsAutoUpdate: null,
    effectiveSkillsAutoUpdate: true,
    followups: null,
    effectiveFollowups: false,
    agentEnvPassthrough: null,
    effectiveAgentEnvPassthrough: [],
    composerDefaults: {
      autonomous: null,
      worktree: null,
      inheritedAutonomous: 'source-dependent',
      inheritedWorktree: false,
    },
    resources: {
      maxParallel: 2,
      maxMonitoringSessions: 2,
      monitoringWakeIntervalMinutes: null,
      idleTimeoutMinutes: 15,
      memoryLimitDefaultMb: 4096,
      autoResumeOnUsageLimit: true,
      memoryLimitMb: null,
      worktreeRetentionDefault: 10,
    },
    agentDefaults: {},
    ...overrides,
  }
  const update: SkillsUpdateState = {
    status: 'current',
    available: false,
    autoUpdateEnabled: true,
    inherited: true,
    checkedAt: null,
    updatedAt: null,
    needsUpgradeNotes: false,
    catalog: [],
    scopes: [
      {
        scope: 'project',
        status: 'current',
        available: false,
        skills: [],
        checkedAt: null,
        updatedAt: null,
        reason: 'installation is not tracked',
      },
      {
        scope: 'global',
        status: 'current',
        available: false,
        skills: [],
        checkedAt: null,
        updatedAt: null,
        reason: 'installation is not tracked',
      },
    ],
    ...updateOverrides,
  }
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(config)
      if (url === '/api/v1/workspace/config' && method === 'PUT') {
        if (body && 'skillsAutoUpdate' in body) {
          config.skillsAutoUpdate = body.skillsAutoUpdate as boolean | null
          config.effectiveSkillsAutoUpdate = config.skillsAutoUpdate ?? true
        }
        return json(config)
      }
      if (url === '/api/v1/workspace/skills-update?projectId=boot') {
        if (updateMode === 'pending') return new Promise<never>(() => {})
        if (updateMode === 'error')
          return new Response(JSON.stringify({ error: 'nope' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        return json(update)
      }
      return new Promise<never>(() => {})
    }),
  )
}

function renderSkills() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/xezar/projects',
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/global/skills']}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const puts = () => requests.filter((request) => request.method === 'PUT')

describe('Global settings → Skills', () => {
  it('renders the inherited default and quiet no-installation state', async () => {
    serve()
    renderSkills()
    const toggle = await screen.findByRole('switch', {
      name: 'Update xezar-skills automatically',
    })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('On (default)')).toBeTruthy()
    expect(screen.getByText(/XEZ_SKILLS_AUTO_UPDATE supplies/)).toBeTruthy()
    expect(await screen.findByText('No tracked xezar-skills installation found.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Use default' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('surfaces the reason a current scope was left alone (skills from another source)', async () => {
    const reason = 'Installed skills come from another source; xezar does not update them'
    serve(
      {},
      {
        scopes: [
          { scope: 'project', status: 'current', available: false, skills: [], checkedAt: null, updatedAt: null, reason },
          { scope: 'global', status: 'current', available: false, skills: [], checkedAt: null, updatedAt: null, reason: 'installation is not tracked' },
        ],
      },
    )
    renderSkills()
    expect(await screen.findByText(reason)).toBeTruthy()
    expect(screen.queryByText('No tracked xezar-skills installation found.')).toBeNull()
  })

  it('writes an explicit boolean, then can clear it back to the inherited default', async () => {
    serve()
    renderSkills()
    const toggle = await screen.findByRole('switch', {
      name: 'Update xezar-skills automatically',
    })
    fireEvent.click(toggle)
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({ skillsAutoUpdate: false }))
    const reset = screen.getByRole('button', { name: 'Use default' })
    await waitFor(() => expect((reset as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(reset)
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({ skillsAutoUpdate: null }))
  })

  // ---- the skill catalog version block (#744) ----

  const INSTALLED = { commit: 'c'.repeat(40), shortCommit: 'c30432d', date: '2026-09-19', tag: 'v1.0.0' }
  const AVAILABLE = { commit: 'd'.repeat(40), shortCommit: 'de525c6', date: '2026-09-20', tag: 'v1.1.0' }
  /** The same `Intl` options the block uses (`writing.md` §12) — the assertion that matters beside
   *  it is that the raw `YYYY-MM-DD` never reaches the screen. */
  const readable = (date: string) =>
    new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })

  it('shows the served catalog version, the version last seen upstream and the state', async () => {
    serve(
      {},
      {
        catalog: [
          {
            repo: 'qodeca/xezar-skills',
            ref: 'main',
            state: 'update-available',
            installed: INSTALLED,
            available: AVAILABLE,
            fetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          },
        ],
      },
    )
    renderSkills()
    expect(await screen.findByText('Skill catalog')).toBeTruthy()
    expect(screen.getByText(`v1.0.0 (c30432d, ${readable('2026-09-19')})`)).toBeTruthy()
    expect(screen.getByText(`v1.1.0 (de525c6, ${readable('2026-09-20')})`)).toBeTruthy()
    expect(screen.getByText('Update available')).toBeTruthy()
    // B-2: the state carries its own sentence, and that sentence names the next step.
    expect(
      screen.getByText(
        'Tracking qodeca/xezar-skills main — last checked 2h ago. Use Refresh on the Skills page to start serving the newer version.',
      ),
    ).toBeTruthy()
    // B-2: the hint says in one clause that the switch below is about something else.
    expect(screen.getByText(/the automatic-update switch below does not apply to it/)).toBeTruthy()
    // NB-3: the ISO date is a git detail, never what the page prints.
    expect(screen.queryByText(/2026-09-19/)).toBeNull()
  })

  it('names the CHECK, not the version, when the last upstream check has gone stale (B-1)', async () => {
    serve(
      {},
      {
        catalog: [
          {
            repo: 'qodeca/xezar-skills',
            ref: 'main',
            state: 'stale-check',
            installed: AVAILABLE,
            available: AVAILABLE,
            fetchedAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
          },
        ],
      },
    )
    renderSkills()
    expect(await screen.findByText('Check is stale')).toBeTruthy()
    // The contradiction the design review found: "Version unknown" over two printed versions.
    expect(screen.queryByText('Version unknown')).toBeNull()
    expect(
      screen.getByText(
        'Tracking qodeca/xezar-skills main — the last upstream check is older than six hours (13h ago), so the versions above are as of then. Use Refresh on the Skills page to re-check upstream.',
      ),
    ).toBeTruthy()
    expect(screen.getAllByText(`v1.1.0 (de525c6, ${readable('2026-09-20')})`).length).toBe(2)
  })

  it('says the comparison is unknown — never the version — when two versions share no history', async () => {
    serve(
      {},
      {
        catalog: [
          {
            repo: 'qodeca/xezar-skills',
            ref: 'main',
            state: 'unknown',
            installed: INSTALLED,
            available: AVAILABLE,
            fetchedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
          },
        ],
      },
    )
    renderSkills()
    expect(await screen.findByText('Comparison unknown')).toBeTruthy()
    expect(screen.queryByText('Version unknown')).toBeNull()
    expect(screen.getByText(/share no history, so they cannot be compared/)).toBeTruthy()
  })

  /**
   * #752, code review M1 / design review B-1 — the REAL shape, not a hand-picked fixture.
   *
   * The fixture above is two genuinely different commits, which is the case "share no history"
   * was written for. The case this PR made reachable is the opposite one: an existing, healthy
   * clone whose head resolves, with NO successful fetch on record — every cache cloned before
   * `.last-fetch` existed, and any cache whose origin is unreachable after a restart. Both halves
   * are then populated and IDENTICAL, and the old `unknown` branch told the reader that a commit
   * shares no history with itself.
   *
   * So the entry rendered here is the one `skillsCatalogVersions` really produces for that
   * scenario, built from a real bare clone of a real origin — a synthetic fixture is exactly what
   * let the defect through, because it could only be written by someone who already believed the
   * shape. BREAK-752-SAME-COMMIT-NO-FETCH: return `unknown` from `compareState` for this case, or
   * drop the same-commit split in `catalogExplanation`, and this test reads the false sentence.
   */
  it('never claims one commit shares no history with itself, on the shape the server really sends (#752, M1/B-1)', async () => {
    const project = mkdtempSync(join(tmpdir(), 'xez-catalog-web-project-'))
    const origin = mkdtempSync(join(tmpdir(), 'xez-catalog-web-origin-'))
    try {
      // A real origin, a real bare clone, and deliberately NO `.last-fetch` marker beside it.
      mkdirSync(join(origin, 'demo'), { recursive: true })
      gitFixture(['init', '-b', 'main'], origin)
      writeFileSync(join(origin, 'demo', 'SKILL.md'), '# demo\n', 'utf8')
      gitFixture(['add', '-A'], origin)
      gitFixture(['commit', '-m', 'fixture'], origin)
      gitFixture(['tag', 'v1.0.0'], origin)
      setActiveStateLayout(projectStateLayout(project))
      mkdirSync(join(project, '.xezar'), { recursive: true })
      writeFileSync(
        join(project, '.xezar', 'config.json'),
        JSON.stringify({ skillsRepos: [{ repo: origin, ref: 'main' }] }),
        'utf8',
      )
      const bare = bareDirFor(origin)
      mkdirSync(dirname(bare), { recursive: true })
      gitFixture(['clone', '--bare', origin, bare], tmpdir())

      const catalog = await skillsCatalogVersions(project)
      // The shape itself, asserted before it is rendered: this is what makes the render below a
      // proof about the product rather than about a fixture someone wrote by hand.
      expect(catalog[0]?.fetchedAt).toBeNull()
      expect(catalog[0]?.installed?.commit).toBe(catalog[0]?.available?.commit)

      serve({}, { catalog })
      renderSkills()

      expect(await screen.findByText('Not checked yet')).toBeTruthy()
      expect(
        screen.getByText(
          `Tracking ${origin} main — this machine has not checked upstream yet, so it cannot say whether these versions are current. Use Refresh on the Skills page to check.`,
        ),
      ).toBeTruthy()
      // The three sentences and badges this case must never render.
      expect(screen.queryByText(/share no history/)).toBeNull()
      expect(screen.queryByText(/only one of the two versions could be read/)).toBeNull()
      expect(screen.queryByText('Comparison unknown')).toBeNull()
      expect(screen.queryByText('Version unknown')).toBeNull()
      // Both versions ARE printed, which is why neither badge above may say otherwise.
      expect(screen.getAllByText(new RegExp(`^v1\\.0\\.0 \\(`)).length).toBe(2)
      // Last, so the break above is proven on the RENDERED text first: the state is the mechanism,
      // the sentence is the defect.
      expect(catalog[0]?.state).toBe('never-checked')
    } finally {
      setActiveStateLayout(null)
      rmSync(project, { recursive: true, force: true })
      rmSync(origin, { recursive: true, force: true })
    }
  })

  it('does not claim two versions share no history when only one of them was read', async () => {
    serve(
      {},
      {
        catalog: [
          {
            repo: 'qodeca/xezar-skills',
            ref: 'main',
            state: 'unknown',
            available: AVAILABLE,
            fetchedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
          },
        ],
      },
    )
    renderSkills()
    expect(await screen.findByText('Comparison unknown')).toBeTruthy()
    expect(screen.getByText(/only one of the two versions could be read/)).toBeTruthy()
    expect(screen.queryByText(/share no history/)).toBeNull()
    // The missing half still reads as an em dash, never as "undefined".
    expect(screen.getAllByText('—').length).toBe(1)
  })

  it('spells a non-exact tag out in words rather than printing git describe (NB-1, NB-2)', async () => {
    const nearest = {
      commit: 'f'.repeat(40),
      shortCommit: '769ebc7',
      date: '2026-09-20',
      tag: 'v1.1.0',
      commitsSinceTag: 1,
    }
    serve(
      {},
      {
        catalog: [
          {
            repo: 'qodeca/xezar-skills',
            ref: 'main',
            state: 'up-to-date',
            installed: nearest,
            available: nearest,
            fetchedAt: new Date(Date.now() - 60 * 1000).toISOString(),
          },
        ],
      },
    )
    renderSkills()
    await screen.findByText('Up to date')
    const [installed] = screen.getAllByText(
      `1 commit after v1.1.0 (769ebc7, ${readable('2026-09-20')})`,
    )
    // NB-1: no `-1-g…` suffix, and the hash appears once.
    expect(screen.queryByText(/v1\.1\.0-1-g769ebc7/)).toBeNull()
    // NB-2: ids and versions are set in mono.
    expect(installed?.className).toContain('font-mono')
    expect(
      (document.querySelector('[data-slot="skills-catalog-source"] span') as HTMLElement).className,
    ).toContain('font-mono')
  })

  it('keeps its place on the page while the check is in flight, and when it fails (NB-5, NB-6)', async () => {
    serve({}, {}, 'pending')
    renderSkills()
    expect(await screen.findByText('Skill catalog')).toBeTruthy()
    expect(screen.getByText('Checking…')).toBeTruthy()
    // #752, L-1: the polite region is the sr-only announcer, not the whole body.
    const live = document.querySelector('[data-slot="skills-catalog-announcement"]') as HTMLElement
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(
      (document.querySelector('[data-slot="skills-catalog-version"]') as HTMLElement).getAttribute(
        'aria-live',
      ),
    ).toBeNull()
    // #752, L-3: the pending body reserves about one card's height, on the spacing scale, so the
    // automatic-update switch below it does not jump when the answer lands.
    expect(
      (document.querySelector('[data-slot="skills-catalog-pending"]') as HTMLElement).className,
    ).toContain('min-h-28')
    cleanup()

    serve({}, {}, 'error')
    renderSkills()
    expect(await screen.findByText('The skill catalog version is unavailable right now.')).toBeTruthy()
    // The heading is still there: nothing below it moves when the request settles either way.
    expect(screen.getByText('Skill catalog')).toBeTruthy()
  })

  it('renders the block through the shared SettingsField chassis (B-3)', async () => {
    serve()
    renderSkills()
    const heading = await screen.findByText('Skill catalog')
    const section = heading.closest('section') as HTMLElement
    // `SettingsField`'s own rhythm token — a private copy used `gap-3`.
    expect(section.className).toContain('gap-stack')
  })

  it('reads up to date when both halves name the same commit, and drops an absent tag', async () => {
    const untagged = { commit: 'e'.repeat(40), shortCommit: 'e1e1e1e', date: '2026-09-20' }
    serve(
      {},
      {
        catalog: [
          {
            repo: 'qodeca/xezar-skills',
            ref: 'main',
            state: 'up-to-date',
            installed: untagged,
            available: untagged,
            fetchedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
          },
        ],
      },
    )
    renderSkills()
    expect(await screen.findByText('Up to date')).toBeTruthy()
    // No tag: the sha carries the version on its own, never an empty pair of brackets.
    expect(screen.getAllByText(`e1e1e1e (${readable('2026-09-20')})`).length).toBe(2)
  })

  it('renders the cold-cache unknown state quietly, and leaves the npx status line untouched', async () => {
    serve(
      {},
      {
        catalog: [{ repo: 'qodeca/xezar-skills', ref: 'main', state: 'unknown', fetchedAt: null }],
      },
    )
    renderSkills()
    // B-1: "Version unknown" survives for exactly this case — no local copy, no version to print.
    expect(await screen.findByText('Version unknown')).toBeTruthy()
    // NB-4: plain words, a named subject, and no arrival this page cannot promise.
    expect(
      screen.getByText(
        'xezar has not read qodeca/xezar-skills yet, so there is no version to show — it fills in the first time these skills load, and stays here while the source cannot be reached.',
      ),
    ).toBeTruthy()
    // Both missing halves read as an em dash, never as "undefined".
    expect(screen.getAllByText('—').length).toBe(2)
    // Not an error: the danger empty state belongs to a failed config load only.
    expect(screen.queryByText('Could not load skill settings')).toBeNull()
    // Guard (passes with and without the change): the existing line keeps its exact words.
    expect(screen.getByText('No tracked xezar-skills installation found.')).toBeTruthy()
  })

  it('announces the state word only — never the ticking age (#752, L-1)', async () => {
    serve(
      {},
      {
        catalog: [
          {
            repo: 'qodeca/xezar-skills',
            ref: 'main',
            state: 'up-to-date',
            installed: INSTALLED,
            available: INSTALLED,
            fetchedAt: new Date(Date.now() - 61 * 60 * 1000).toISOString(),
          },
        ],
      },
    )
    renderSkills()
    await screen.findByText('Up to date')
    const live = document.querySelector('[data-slot="skills-catalog-announcement"]') as HTMLElement
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.className).toContain('sr-only')
    expect(live.textContent).toBe('qodeca/xezar-skills: Up to date.')
    // The defect: the sentence `useNow` re-renders every 30 s used to live inside the region, so
    // a screen reader re-read "last checked 1h ago" once a minute. It is still on screen…
    expect(screen.getByText(/last checked 1h ago/)).toBeTruthy()
    // …and no longer inside anything polite.
    expect(live.textContent).not.toMatch(/ago/)
    expect(
      document.querySelector('[data-slot="skills-catalog-version"] [aria-live]:not([data-slot="skills-catalog-announcement"])'),
    ).toBeNull()
  })

  it('keeps every announcement free of an age, in every state (#752, L-1)', () => {
    const fresh = { repo: 'a/b', ref: 'main', fetchedAt: new Date().toISOString() } as const
    const announcements = [
      catalogAnnouncement(undefined, null),
      catalogAnnouncement(undefined, new Error('nope')),
      catalogAnnouncement([], null),
      catalogAnnouncement([{ ...fresh, state: 'up-to-date', installed: INSTALLED, available: INSTALLED }], null),
      catalogAnnouncement([{ ...fresh, state: 'stale-check', installed: INSTALLED, available: INSTALLED }], null),
      catalogAnnouncement([{ ...fresh, state: 'unknown', fetchedAt: null }], null),
    ]
    // No age, no clock, in any of them: the region's text changes only when a STATE does.
    for (const text of announcements) expect(text).not.toMatch(/\bago\b|\d+[smhd]\b/)
    expect(announcements[3]).toBe('a/b: Up to date.')
    expect(announcements[4]).toBe('a/b: Check is stale.')
    expect(announcements[5]).toBe('a/b: Version unknown.')
    // A failed background refetch that still has an answer keeps announcing the answer.
    expect(
      catalogAnnouncement([{ ...fresh, state: 'up-to-date', installed: INSTALLED, available: INSTALLED }], new Error('nope')),
    ).toBe('a/b: Up to date.')
  })

  it('says so when no team skill source is configured', async () => {
    serve()
    renderSkills()
    expect(await screen.findByText('No team skill source is configured.')).toBeTruthy()
  })

  it('stops the catalog poll once a version is known, and bounds it when one never arrives (NB-7)', () => {
    const cold: SkillsUpdateState = {
      status: 'current',
      available: false,
      autoUpdateEnabled: true,
      inherited: true,
      checkedAt: null,
      updatedAt: null,
      needsUpgradeNotes: false,
      scopes: [],
      catalog: [{ repo: 'qodeca/xezar-skills', ref: 'main', state: 'unknown', fetchedAt: null }],
    }
    const warm: SkillsUpdateState = {
      ...cold,
      catalog: [
        {
          repo: 'qodeca/xezar-skills',
          ref: 'main',
          state: 'stale-check',
          installed: AVAILABLE,
          available: AVAILABLE,
          fetchedAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
        },
      ],
    }
    // The cold-boot race OQ-2 added the cadence for: it still polls.
    expect(skillsUpdateRefetchMs(cold, 0)).toBe(60_000)
    expect(skillsUpdateRefetchMs(cold, CATALOG_POLL_ATTEMPTS - 1)).toBe(60_000)
    // The bound: a source that can never resolve does not keep a timer alive for the page's life.
    expect(skillsUpdateRefetchMs(cold, CATALOG_POLL_ATTEMPTS)).toBe(false)
    expect(skillsUpdateRefetchMs(cold, CATALOG_POLL_ATTEMPTS + 10)).toBe(false)
    // A known version stops it at once, stale check or not.
    expect(skillsUpdateRefetchMs(warm, 0)).toBe(false)
    // Guard (passes with and without the change): a transient status still converges, unbounded.
    expect(skillsUpdateRefetchMs({ ...warm, status: 'checking' }, 99)).toBe(60_000)
    expect(skillsUpdateRefetchMs(undefined, 99)).toBe(60_000)
  })

  it('degrades to an unavailable status without disabling the preference', async () => {
    serve(
      {},
      {
        status: 'unavailable',
        scopes: [
          {
            scope: 'project',
            status: 'unavailable',
            available: false,
            skills: [],
            checkedAt: null,
            updatedAt: null,
            reason: 'npx is unavailable',
          },
        ],
      },
    )
    renderSkills()
    expect(await screen.findByText('npx is unavailable')).toBeTruthy()
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false)
  })

  it('reads the badge and the sentence the same way on `unknown` with two identical commits (#772, NB-2)', () => {
    const entry: SkillsCatalogVersion = {
      repo: 'qodeca/xezar-skills',
      ref: 'main',
      state: 'unknown',
      installed: INSTALLED,
      available: INSTALLED,
      fetchedAt: null,
    }
    // The badge no longer says the COMPARISON is unknown under a sentence saying the CHECK is what
    // is missing. `compareState` cannot send this today; both halves hold it whatever a future
    // server sends.
    expect(catalogStateLabel(entry)).toBe('Not checked yet')
    expect(catalogExplanation(entry)).toContain('this machine has not checked upstream yet')
    // Guard (passes with and without the change): `unknown` with two versions that really differ
    // still reads as an unknown comparison, so the fix narrowed nothing else.
    expect(catalogStateLabel({ ...entry, available: AVAILABLE })).toBe('Comparison unknown')
  })
})
