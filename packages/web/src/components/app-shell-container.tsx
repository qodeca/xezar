import type { ReactNode } from 'react'
import { useLocation } from 'react-router'

import { useHealth, useProjectRuns, useProjects, useRuns, useSkillsUpdate, useTodos } from '@/api/queries'
import type { HealthResponse, SkillsUpdateState } from '@qodeca/xezar-api-client'
import { AppShell, type RepoChip } from '@/components/app-shell'
import { CommandPalette } from '@/components/command-palette'
import { ListViewProvider } from '@/components/list-view'
import { OnboardingOfferContainer } from '@/components/onboarding-offer-container'
import { ProviderBannerContainer } from '@/components/provider-banner-container'
import { ProjectGroups } from '@/components/project-groups'
import { ToolsMenu } from '@/components/tools-menu'
import { useDocumentTitle } from '@/lib/use-document-title'
import { useActiveProjectId } from '@/lib/project-router'
import { inSingleProjectRoot, projectsLocked } from '@/lib/project-mode'
import { unreadDoneCount } from '@/lib/read-state'
import { runTitle } from '@/lib/task-groups'
import { pageTitleContext } from '@/routes'

/**
 * Derive the sidebar's repo chip from `/api/health`.
 *
 * Null — the chip renders nothing — whenever there is nothing true to say: health hasn't
 * answered yet, or xezar is running outside a git repository (`repo: null`), which is a
 * supported way to run it. An empty chip is honest; "loading…" or a guessed folder name is not.
 *
 * The name is the repo root's basename: `/home/me/Projects/xezar` → `xezar`. Both separators,
 * because the server sends whatever path git gave it, and a trailing one is stripped first so
 * `/repo/` doesn't chip as an empty string.
 */
export function repoChipOf(health: HealthResponse | undefined): RepoChip | null {
  const repo = health?.repo
  if (!repo) return null
  const name = repo.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  if (!name) return null
  return { name, branch: repo.branch }
}

/** Only a checked, still-actionable result earns chrome. An update failure may retain a proven
 * available scope, so keep that signal; all unknown/transient/degraded states stay quiet. */
export function skillsUpdateMarkerOf(state: SkillsUpdateState | undefined): boolean {
  return state?.available === true && (state.status === 'available' || state.status === 'error')
}

/**
 * The app shell, wired to live data.
 *
 * AppShell itself stays presentational — it takes repo/version/inboxCount and renders them, or
 * renders nothing. This is the seam where those become real: `useHealth()` for the repo and
 * version chips, `useTodos()` for the inbox badge.
 *
 * Nothing here caches boot-time values (#369: the legacy UI read the branch once at startup and
 * then showed a stale branch forever). The chips read whatever is currently in the health query,
 * so keeping them live is `useHealth`'s job — its poll plus Step 3.2's reconnect/visibility
 * reconcile — not a change here.
 */
export function AppShellContainer({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const projectId = useActiveProjectId()
  const health = useHealth()
  // The global inbox is opt-in (#471). With the capability off there is no Inbox nav item to
  // badge and the endpoint can only answer [], so the query parks rather than polls.
  const inboxAvailable = health.data?.capabilities.followups === true
  // GitHub automations are opt-in too (#801) — same honesty rule: without the server's word for
  // it the nav must not offer a tab whose every request would 409.
  const automationsAvailable = health.data?.capabilities.automations === true
  const todos = useTodos(inboxAvailable)
  // One query in the shell feeds every rendering of the active project's navigation (desktop,
  // mobile drawer, and grouped sidebar). Routes reuse this TanStack Query cache entry.
  const skillsUpdate = useSkillsUpdate(projectId ?? '', projectId !== null)
  const skillsUpdateAvailable = skillsUpdateMarkerOf(skillsUpdate.data)
  // Unread done items (#unread-done-items) for the Tasks badge. Reads the same active-scope run
  // list the Tasks table already holds — one cache entry, no extra fetch.
  const runs = useRuns()
  const registry = useProjects().data
  const titleContext = pageTitleContext(pathname)
  const bootProjectId = registry?.bootProject ?? health.data?.bootProject ?? null
  const isBootProject = projectId !== null && projectId === bootProjectId
  const activeProject = registry?.projects.find((project) => project.id === projectId)
  const titleRuns = useProjectRuns(
    projectId ?? '',
    // Wait for the registry to identify the project before choosing the boot/non-boot cache
    // key. Health can arrive first; fetching then would briefly populate a project-scoped key
    // for the boot project before switching to the authoritative `default` key.
    activeProject !== undefined && titleContext.taskId !== null,
    registry?.bootProject === projectId,
  ).data

  // Global settings intentionally has no selected project. Everywhere else the URL id selects
  // the authoritative registry entry; health may name only the CONFIRMED boot project while
  // the registry is unavailable, never a non-boot project whose root health does not describe.
  const globalSettings = pathname === '/settings/global' || pathname.startsWith('/settings/global/')
  const projectName = globalSettings
    ? null
    : (activeProject?.name ??
      (isBootProject ? (repoChipOf(health.data)?.name ?? null) : null))
  const titleRun = titleContext.taskId
    ? titleRuns?.find((run) => run.id === titleContext.taskId)
    : undefined
  const pageLabel = titleRun ? runTitle(titleRun) : titleContext.pageLabel

  useDocumentTitle({ projectName, pageLabel })

  // Multi-project sidebar only from the SECOND project on (multi-project spec, "Sidebar").
  // With one registered project — or with the registry still loading, or unreachable — the
  // group header would say nothing the repo chip does not already say, so the shell keeps the
  // flat nav it has always had. That degenerate case is the upgrade path:
  // an existing user boots the new version in their usual repo and sees no difference.
  // A narrowed workspace (`XEZ_SINGLE_PROJECT=1` or single-project mode, #600) never shows them,
  // whatever the registry holds: that is a capability, and a registry that happens to list two
  // rows must not bring the switcher back.
  const capabilities = health.data?.capabilities
  const projects =
    !projectsLocked(capabilities) && registry && registry.projects.length > 1 ? registry : null
  // Destructured rather than read as a member: the audit-door guard
  // (packages/xezar/src/mcp/audit-origin-wiring.test.ts) scans every workspace source tree and
  // counts a property access spelled like the audit-trail method as a possible door.
  const { channel } = health.data ?? { channel: null }

  return (
    // The Active/Archived filter shared by the per-project Tasks table (Step 3.4) and the global
    // Tasks page, both of which render in `children`. It sits above the routes so the choice
    // survives moving between them; the sidebar no longer reads it (#546).
    <ListViewProvider>
      <AppShell
        repo={repoChipOf(health.data)}
        version={health.data?.version ?? null}
        latestVersion={health.data?.latestVersion ?? null}
        channel={channel}
        // `?? null` rather than `?? 0`: no badge while the inbox is unknown, and no badge when it
        // is known to be empty — AppShell renders neither for a falsy count.
        inboxCount={todos.data?.length ?? null}
        // Same `?? null` honesty: no badge while the list is unknown; a loaded list with none
        // unread is 0, which AppShell also renders as no badge.
        unreadCount={runs.data ? unreadDoneCount(runs.data) : null}
        skillsUpdateAvailable={skillsUpdateAvailable}
        // Hidden until health confirms the forge driver (R6 Step 1.1) — same honesty rule as
        // the chips: the nav must not claim a GitHub tab it cannot back. The Tools menu's
        // forge note says why it is absent.
        forgeAvailable={health.data?.forge?.available === true}
        // Hidden unless health reports the opt-in inbox (#471) — same honesty rule as above:
        // the nav must not offer an Inbox this server will never fill.
        inboxAvailable={inboxAvailable}
        // Hidden unless health reports the opt-in automations capability (#801).
        automationsAvailable={automationsAvailable}
        // Two rows in the one banner slot. The provider banner keeps its place and its meaning;
        // the onboarding offer (#464 P2) sits under it in the status tone, and renders nothing
        // whenever there is no pending offer — which is almost always.
        banner={
          <>
            <ProviderBannerContainer />
            <OnboardingOfferContainer />
          </>
        }
        singleProject={projectsLocked(capabilities)}
        // The mode badge (#600) renders only on the server's definite word — `false` while health
        // is unknown, so it never appears and then disappears.
        singleProjectRoot={inSingleProjectRoot(capabilities)}
        // Present only in a multi-project workspace; `AppShell` renders the flat nav whenever this
        // slot is absent.
        projectGroups={
          projects ? (
            <ProjectGroups
              projects={projects.projects}
              bootProjectId={projects.bootProject}
              // No forge prop: each group gates its own GitHub tab on its registry entry's
              // `forge` field (#698) — the boot folder's health-level answer says nothing
              // about the other projects in the workspace.
              inboxAvailable={inboxAvailable}
              automationsAvailable={automationsAvailable}
              inboxCount={todos.data?.length ?? null}
              skillsUpdateAvailable={skillsUpdateAvailable}
            />
          ) : undefined
        }
        toolsMenu={<ToolsMenu health={health.data} />}
      >
        {children}
      </AppShell>
      {/* Global chrome, not a route: ⌘K must work on every URL. Mounted here (not in AppShell)
          because it needs the query client and router this container already assumes. */}
      <CommandPalette />
    </ListViewProvider>
  )
}
