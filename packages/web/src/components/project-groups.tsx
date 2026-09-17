import { ChevronDownIcon } from 'lucide-react'
import * as React from 'react'
import { useLocation } from 'react-router'

import { useProjectRuns } from '@/api/queries'
import type { ProjectListEntry } from '@qodeca/xezar-api-client'
import { MissingProjectBadge, NavBadge, SkillsUpdateMarker, useSidebarNavigate } from '@/components/app-shell'
import { activeNavPath, visibleNavItems } from '@/components/nav-items'
import { Link, pathnameProjectId, scopeTo, stripProjectPrefix } from '@/lib/project-router'
import { isProjectCollapsed, readStoredCollapsed, writeStoredCollapsed } from '@/lib/sidebar-collapse'
import { listCounts } from '@/lib/task-groups'
import { cn } from '@/lib/utils'

/**
 * The multi-project sidebar (multi-project spec, "Sidebar"): one collapsible group per
 * registered project, each carrying its own nav. Navigation only (#546): a group lists no tasks —
 * its Tasks item is the door to that project's Tasks page.
 *
 * Mounted by `AppShellContainer` only when the registry holds MORE THAN ONE project — the
 * degenerate single-project workspace keeps the flat sidebar it has always had (`AppShell`
 * falls back to it whenever the `projectGroups` slot is absent). That is not a special case
 * bolted on: with one project the group header would only repeat the repo chip, and every nav
 * row would gain a level of indentation to distinguish it from nothing.
 */

/**
 * Read + write of the per-project collapse map (`lib/sidebar-collapse.ts`), which lives in
 * localStorage rather than `~/.xezar/ui-state.json`.
 *
 * Seeded once from storage at mount, so the first paint already carries the user's answer — no
 * request to wait for, and no flash of the active-project default. React state is the live copy
 * and every toggle mirrors the new map straight to storage, which is synchronous, so a reload
 * immediately after a click still finds it. There is no debounce, no optimistic-then-reconcile
 * dance and no failure toast left, because there is no server round trip left to fail.
 */
function useSidebarCollapse(activeProjectId: string | null) {
  const [collapsed, setCollapsed] = React.useState(readStoredCollapsed)
  // The map as of the last toggle, updated synchronously: two clicks inside one render pass must
  // compose, and the second must see the first one's entry rather than the batched-away state.
  const latest = React.useRef(collapsed)

  const toggle = React.useCallback(
    (projectId: string) => {
      const next = {
        ...latest.current,
        [projectId]: !isProjectCollapsed(latest.current, projectId, activeProjectId),
      }
      latest.current = next
      writeStoredCollapsed(next)
      setCollapsed(next)
    },
    [activeProjectId],
  )

  return { collapsed, toggle }
}

export function ProjectGroups({
  projects,
  bootProjectId,
  inboxAvailable = false,
  automationsAvailable = false,
  inboxCount = null,
  skillsUpdateAvailable = false,
}: {
  projects: ProjectListEntry[]
  /** The project a flat, unprefixed URL resolves to — so the boot project is the one that
   *  auto-expands before the user has navigated into any `/p/<id>` scope. */
  bootProjectId: string
  inboxAvailable?: boolean
  /** `capabilities.automations` (#801) — workspace-wide, unlike the per-project forge gate:
   *  the opt-in is one env var on the one server that serves every group. */
  automationsAvailable?: boolean
  inboxCount?: number | null
  skillsUpdateAvailable?: boolean
}) {
  const { pathname } = useLocation()
  // The shell renders outside the routes, so there is no `ProjectScopeProvider` above it — the
  // URL's own prefix is the scope, exactly as `project-router` resolves it for links.
  //
  // `scopedProjectId` is null on the pages that belong to NO project — the global Tasks page and
  // global settings. Nothing may be highlighted there: a `/p/` prefix is the only thing that
  // makes a project the one you are standing in, and painting the boot project as selected while
  // the user reads an all-projects table says the page is about that project when it is not.
  const scopedProjectId = pathnameProjectId(pathname)
  // Collapse defaults are a different question ("which group opens when you have never touched
  // one?") and still want a project, so they keep the boot fallback: landing on a global page
  // must not fold the whole sidebar shut.
  const collapseAnchorId = scopedProjectId ?? bootProjectId
  const { collapsed, toggle } = useSidebarCollapse(collapseAnchorId)

  const activeTo = activeNavPath(stripProjectPrefix(pathname))

  // Most-recently-opened first, per the spec. Sorted here rather than trusted from the wire so
  // the order is a property of the sidebar, not of whichever route last touched the registry.
  const ordered = React.useMemo(
    () => [...projects].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)),
    [projects],
  )

  return (
    <div data-slot="project-group-list">
      {ordered.map((project) => (
        <ProjectGroup
          key={project.id}
          project={project}
          boot={project.id === bootProjectId}
          active={project.id === scopedProjectId}
          collapsed={isProjectCollapsed(collapsed, project.id, collapseAnchorId)}
          onToggle={toggle}
          activeTo={activeTo}
          inboxAvailable={inboxAvailable}
          automationsAvailable={automationsAvailable}
          inboxCount={inboxCount}
          skillsUpdateAvailable={skillsUpdateAvailable}
        />
      ))}
    </div>
  )
}

function ProjectGroup({
  project,
  boot,
  active,
  collapsed,
  onToggle,
  activeTo,
  inboxAvailable,
  automationsAvailable,
  inboxCount,
  skillsUpdateAvailable,
}: {
  project: ProjectListEntry
  /** The boot project's runs cache lives under the `'default'` scope key (it mounts
   *  unscoped) — see `useProjectRuns`' `boot` parameter. */
  boot: boolean
  active: boolean
  collapsed: boolean
  onToggle: (projectId: string) => void
  /** The `to` of the nav item that owns the current URL — applied to the ACTIVE group only. */
  activeTo: string | null
  inboxAvailable: boolean
  automationsAvailable: boolean
  inboxCount: number | null
  skillsUpdateAvailable: boolean
}) {
  const missing = project.status === 'missing'
  // Collapsed (or missing) groups never fetch — a 40-project workspace costs one registry
  // request, not 40 run lists. A collapsed group still READS whatever is cached, which is what
  // keeps its attention badge alive after the user shuts it.
  const runs = useProjectRuns(project.id, !collapsed && !missing, boot)
  const onNavigate = useSidebarNavigate()

  // The header's attention badge: waiting + review, counted by status. Its meaning is unchanged by
  // #546 even though the group no longer lists the tasks it counts (#399 owns any redesign).
  const waiting = runs.data ? listCounts(runs.data).waiting : 0

  // A missing project's panes all 409 (spec, "Registered project folder deleted/moved"), so
  // there is nothing behind the chevron — the row renders greyed and inert rather than
  // pretending to expand into a nav whose every link is a dead end. Unregistering lives in
  // Global settings → Projects; the row says so instead of growing its own destructive button.
  if (missing) {
    return (
      <div data-slot="project-group" data-project={project.id} data-status="missing" className="mb-1">
        <div
          data-slot="project-group-header"
          title={`${project.root} is gone — remove it in Global settings → Projects`}
          className="flex min-h-tap w-full items-center gap-2 rounded-lg px-2 text-[13px] font-semibold md:h-9 md:min-h-0"
        >
          <span className="w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{project.name}</span>
          <MissingProjectBadge />
        </div>
      </div>
    )
  }

  const bodyId = `project-group-${project.id}`

  return (
    <div
      data-slot="project-group"
      data-project={project.id}
      data-status={project.status}
      data-collapsed={collapsed ? '' : undefined}
      // "This is the project the URL names." Absent on the global pages, which name none — see
      // `scopedProjectId` above. An attribute rather than only a class because the highlight is
      // a fact about the group, and a `hover:bg-muted` in the class list makes the class an
      // unreliable way to ask.
      data-active={active ? '' : undefined}
      className="mb-1"
    >
      <button
        type="button"
        onClick={() => onToggle(project.id)}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        data-slot="project-group-header"
        className={cn(
          // 44px touch target in the drawer, the 36px scale row on desktop — the same
          // relaxation the flat nav makes.
          'flex min-h-tap w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] font-semibold transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:h-9 md:min-h-0',
          active && 'bg-muted',
        )}
      >
        <ChevronDownIcon
          className={cn(
            'size-3 shrink-0 text-muted-foreground motion-safe:transition-transform',
            collapsed && '-rotate-90',
          )}
          aria-hidden="true"
        />
        <span className="truncate">{project.name}</span>
        <NavBadge data-slot="project-attention" title={`${project.name}: ${waiting} task${waiting === 1 ? '' : 's'} need${waiting === 1 ? 's' : ''} you`} className="ml-0">{waiting}</NavBadge>
        {project.branch ? (
          <span
            data-slot="project-branch"
            className="ml-auto max-w-[92px] truncate font-mono text-[10.5px] font-medium text-muted-foreground"
          >
            {project.branch}
          </span>
        ) : null}
      </button>

      {collapsed ? null : (
        <div
          id={bodyId}
          data-slot="project-group-body"
          // The gap and the rail are what make the header read as the PARENT of these rows.
          // Without them the active group's `bg-muted` header sits flush against the active nav
          // row's `bg-muted` and the two fuse into one block — the project name then reads as
          // just another menu item. The rail is offset to sit under the chevron, so the whole
          // body hangs off the same vertical the disclosure control is on.
          className="mt-1 ml-3.5 border-l border-border pl-2"
        >
          <nav aria-label={`${project.name} navigation`}>
            {/* Forge-gated per PROJECT (#698): the entry's own remote decides whether THIS
                group offers a GitHub tab — the boot folder's health-level forge answer says
                nothing about the other projects in the workspace. Whether `gh` itself works
                still surfaces inside the tab as its availability hint. */}
            {visibleNavItems({
              forge: project.forge === 'github',
              inbox: inboxAvailable,
              automations: automationsAvailable,
            }).map((item) => {
              // Only the active group can own the current URL: the flat route map is
              // project-agnostic, so `/git` lights Git in exactly one project — the scoped one.
              const isActive = active && item.to === activeTo
              const Icon = item.icon
              // Explicitly scoped (`/p/<id>/…`) rather than left to the wrapper's active-project
              // prefix: a group's whole point is linking into a project that is NOT active.
              return (
                <Link
                  key={item.to}
                  to={scopeTo(project.id, item.to)}
                  onClick={onNavigate}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex min-h-tap w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:h-8 md:min-h-0',
                    isActive && 'bg-muted font-semibold text-foreground',
                  )}
                >
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                  {item.label}
                  {/* `/api/todos` is fetched for the active scope only, so only the active
                      group has a real count to show — a badge on the others would be the active
                      project's number wearing someone else's name. */}
                  {item.badge === 'inbox-count' && active ? (
                    <NavBadge>{inboxCount}</NavBadge>
                  ) : null}
                  {item.badge === 'skills-update' && active ? (
                    <SkillsUpdateMarker available={Boolean(skillsUpdateAvailable)} />
                  ) : null}
                </Link>
              )
            })}
          </nav>
        </div>
      )}
    </div>
  )
}
