import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import { putConfig } from '@/api/client'
import { queryKeys, useConfig, useProjects, useWorkspaceConfig } from '@/api/queries'
import type { ConfigResponse, ProjectListEntry, SetConfigInput } from '@qodeca/xezar-api-client'
import { projectsLocked, type ProjectModeCapabilities } from '@/lib/project-mode'
import { Button } from '@/components/ui/button'
import { nativeFieldClass } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { useActiveProjectId } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { ProjectFolderField } from './project-location'
import { MaxParallelSelect, STATUS_LABEL } from './projects-section'
import { RemoveProjectDialog, useProjectRemoval } from './remove-project'
import { MEMORY_MIN_MB } from './resources-section'
import { SettingsField } from './settings-field'

/**
 * Project settings → General: what THIS project is, and the few knobs that belong to the project
 * as a whole rather than to agents, worktrees or templates.
 *
 * It exists because every other section answers a narrow question and none of them answered the
 * broad one. Where is this checkout? Is its folder still there? How many of its tasks may run at
 * once? How do I get rid of it? Those last two lived only in the GLOBAL registry table — a row
 * in a list of every project, reached from the other settings area — which is a strange place to
 * go to act on the project you are already inside.
 *
 * Two things are deliberately NOT duplicated here: anything machine-wide (appearance, host
 * resources, accounts — the index's footer links to Global settings for those), and the section
 * list, which is the left nav on desktop and only renders as cards on small screens.
 *
 * Reuse over restatement: the folder row, the concurrency select, and the removal wording+dialog
 * are the same components the registry table uses. Two pages disagreeing about what "Remove"
 * does is exactly the failure this page could otherwise introduce.
 *
 * Split in two halves, because `XEZ_SINGLE_PROJECT=1` treats them differently. DESCRIBING the
 * project (folder, registry facts) stays true in every mode. MANAGING the registry — the
 * concurrency ceiling, Remove — is what single-project mode takes away: `PATCH`/`DELETE
 * /api/v1/projects/:id` both answer 409 there (server.ts), and `visibleSettingsSections` already
 * drops the whole global Projects section for the same reason. Rendering those two fields anyway
 * would offer a knob that can only fail, which is the opposite of what capabilities.ts asks for
 * ("the UI hides what the server says isn't there, and the matching endpoints refuse as defense
 * in depth").
 *
 * The per-task memory limit (#677 C1) is NOT a registry knob, so it stays in every mode: it is
 * the project’s own `.xezar/config.json` `memoryLimitMb`, written through `PUT /config`, which
 * refreshes the workspace semaphore so the next sample enforces it without a restart.
 */

/** `2026-07-20T…` → a full local date. Unlike the registry table's compact `Jul 20`, this page has
 *  the room and is the place someone comes to check WHEN. An unparseable stamp degrades to an em
 *  dash rather than `Invalid Date`. */
function fullDate(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function ProjectGeneral({ capabilities }: { capabilities?: Partial<ProjectModeCapabilities> }) {
  const projectId = useActiveProjectId()
  const projects = useProjects()
  const config = useWorkspaceConfig()

  if (projects.isPending) {
    return (
      <p data-slot="project-general-loading" className="text-[13px] text-soft-foreground">
        Loading project…
      </p>
    )
  }
  // An unreadable registry is SAID, not skipped. Defense in depth rather than a path a user
  // reaches today: `ProjectScopeRoute` keeps a scoped URL on "Loading…" while the registry query
  // is unresolved, so this branch only renders where the gate is not in front of it. It belongs
  // here anyway — on desktop the section cards are `md:hidden` (the left nav already lists them),
  // so a silent `null` would leave the whole pane blank with no hint that anything went wrong.
  if (projects.isError) {
    return (
      <p data-slot="project-general-error" className="text-[13px] text-danger">
        Could not read the project registry — {projects.error.message}
      </p>
    )
  }
  const registry = projects.data
  const project = registry?.projects.find((entry) => entry.id === projectId)
  // No registry entry for this URL (an unscoped mount, or an id the registry does not have):
  // there is nothing true to say about a project that isn't one.
  if (!registry || !project) return null
  // See the header comment: a narrowed workspace (`XEZ_SINGLE_PROJECT=1` or single-project mode,
  // #600) keeps the description, drops the management — the registry doors refuse both.
  const managesRegistry = !projectsLocked(capabilities)

  return (
    <div data-slot="project-general" className="mx-auto flex w-full max-w-2xl flex-col gap-section">
      <ProjectFolderField />
      <ProjectFacts project={project} canRemove={managesRegistry} />
      {managesRegistry ? (
        <>
          <SettingsField
            title="Max parallel tasks"
            hint={
              config.data
                ? `How many of this project’s tasks may run at once. The workspace limit (${config.data.resources.maxParallel}) still applies as an overall ceiling, so a higher value here has no extra effect until that one is raised.`
                : "How many of this project’s tasks may run at once. The workspace limit still applies as an overall ceiling."
            }
          >
            {config.data ? (
              <MaxParallelSelect project={project} workspaceMax={config.data.resources.maxParallel} />
            ) : (
              // The select's "Inherit workspace (N)" option has to name N, and guessing it would be
              // the one thing this control must not do.
              <p className="text-[13px] text-soft-foreground">Loading the workspace limit…</p>
            )}
          </SettingsField>
        </>
      ) : null}
      <ProjectMemoryLimitField projectName={project.name} />
      {managesRegistry ? <RemoveProject project={project} bootProject={registry.bootProject} /> : null}
    </div>
  )
}

/** The schema's upper bound for a per-repo `memoryLimitMb` (`setConfigInputSchema`), so an
 *  over-limit draft is a disabled Save rather than a 400 round-trip. */
const MEMORY_MAX_MB = 1_048_576

/** How the workspace ceiling this project falls back to reads: a number, or "no limit" — which is
 *  an explicit `null` or a stored 0, since enforcement skips any ceiling at or below zero. */
function workspaceLimitLabel(limit: number | null): string {
  return limit === null || limit <= 0 ? 'no limit' : `${limit} MiB`
}

/**
 * This project’s own per-task memory ceiling (#677 C1). More specific wins: a value here replaces
 * the workspace limit for this project’s tasks, lower or higher, and an empty field (or 0) sends
 * `null`, which deletes the key so the project inherits the workspace limit again. The workspace
 * limit is read only to name what "inherit" means here; the field works without it.
 */
function ProjectMemoryLimitField({ projectName }: { projectName: string }) {
  const config = useConfig()
  const workspace = useWorkspaceConfig()
  const inherited = workspace.data ? workspace.data.resources.memoryLimitMb : undefined
  return (
    <SettingsField
      title="Per-task memory limit"
      hint="When one of this project’s tasks crosses this, the engine pauses it with a warning and starts the next queued task. A value here replaces the workspace limit for this project only. Leave empty to use the workspace limit."
    >
      {config.data ? (
        <ProjectMemoryLimitForm config={config.data} projectName={projectName} inherited={inherited} />
      ) : config.isError ? (
        <p data-slot="project-memory-error" className="text-[13px] text-danger">
          Could not load this project’s settings — {config.error.message}
        </p>
      ) : (
        <p data-slot="project-memory-loading" className="text-[13px] text-soft-foreground">
          Loading this project’s limit…
        </p>
      )}
    </SettingsField>
  )
}

function ProjectMemoryLimitForm({
  config,
  projectName,
  inherited,
}: {
  config: ConfigResponse
  projectName: string
  /** The workspace ceiling, `null` for an explicit "no limit", `undefined` while it loads. */
  inherited: number | null | undefined
}) {
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (patch: SetConfigInput) => putConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(queryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const [memory, setMemory] = useState(config.memoryLimitMb ? String(config.memoryLimitMb) : '')
  const memoryNum = memory.trim() === '' ? 0 : Number(memory)
  // 0 is accepted as "clear", the same as empty — the route deletes the key for both.
  const memoryInvalid =
    memoryNum !== 0 && (!Number.isInteger(memoryNum) || memoryNum < MEMORY_MIN_MB || memoryNum > MEMORY_MAX_MB)
  const memorySaved = (config.memoryLimitMb ?? 0) === (memoryInvalid ? -1 : memoryNum)
  const saveMemory = () =>
    save.mutate(
      // `null`, not 0: the per-repo key has no "no limit" of its own, so clearing means "inherit".
      { memoryLimitMb: memoryNum === 0 ? null : memoryNum },
      {
        onSuccess: () => {
          if (memoryNum === 0) {
            setMemory('')
            toast('Memory limit cleared — this project uses the workspace limit again')
          } else {
            toast(`Memory limit for this project set to ${memoryNum} MiB`)
          }
        },
      },
    )

  const inheritedText = inherited === undefined ? 'the workspace limit' : `the workspace limit (${workspaceLimitLabel(inherited)})`

  return (
    <>
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={MEMORY_MIN_MB}
          max={MEMORY_MAX_MB}
          step={1}
          aria-label={`Per-task memory limit for ${projectName} in MiB`}
          data-slot="project-memory-limit"
          value={memory}
          disabled={save.isPending}
          placeholder="Use workspace limit"
          onChange={(event) => setMemory(event.target.value)}
          className={cn(nativeFieldClass, 'block w-32')}
        />
        <span className="text-xs text-soft-foreground">MiB</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-action="project-save-memory"
          disabled={memorySaved || memoryInvalid || save.isPending}
          onClick={saveMemory}
        >
          Save
        </Button>
      </div>
      {memoryInvalid ? (
        <p data-slot="project-memory-invalid" className="text-[11px] text-danger">
          Enter a whole number from {MEMORY_MIN_MB} to {MEMORY_MAX_MB} MiB, or leave empty to use the workspace limit.
        </p>
      ) : (
        <p data-slot="project-memory-effective" className="text-[11px] text-soft-foreground">
          {config.memoryLimitMb
            ? `This project’s tasks pause at ${config.memoryLimitMb} MiB. Clear the field to use ${inheritedText}.`
            : `This project uses ${inheritedText}.`}{' '}
          A change applies straight away, to running tasks too.
        </p>
      )}
    </>
  )
}

/** The registry entry, read out: what xezar probed about this folder the last time it looked.
 *  `canRemove` is whether the Remove field is rendered below — the missing-folder hint points at
 *  it, and must not point at a field single-project mode took away. */
function ProjectFacts({ project, canRemove }: { project: ProjectListEntry; canRemove: boolean }) {
  return (
    <SettingsField
      title="Project"
      hint="The registry entry for this checkout — re-probed every time the project list is read."
    >
      <dl
        data-slot="project-facts"
        className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md border border-border bg-card p-3 text-[13px]"
      >
        <dt className="text-muted-foreground">Name</dt>
        <dd className="min-w-0 truncate text-foreground">{project.name}</dd>

        <dt className="text-muted-foreground">Status</dt>
        <dd data-slot="project-general-status" className={project.status === 'missing' ? 'text-danger' : 'text-foreground'}>
          {STATUS_LABEL[project.status]}
          {/* A registered folder that has been deleted or moved is the one status worth acting
              on, and "folder not found" alone does not say what to do about it. */}
          {project.status === 'missing'
            ? canRemove
              ? ' — remove it below, or restore the folder'
              : ' — restore the folder at the path above'
            : null}
        </dd>

        {/* Omitted rather than dashed when git could not name one (unborn HEAD): an empty row
            invites the reader to wonder which branch is checked out, a missing row does not. */}
        {project.branch !== undefined ? (
          <>
            <dt className="text-muted-foreground">Branch</dt>
            <dd className="min-w-0 truncate font-mono text-xs text-foreground">{project.branch}</dd>
          </>
        ) : null}

        <dt className="text-muted-foreground">Added</dt>
        <dd className="text-foreground">
          {fullDate(project.addedAt)}
          <span className="text-soft-foreground">
            {project.source === 'checkout' ? ' · cloned from GitHub' : ' · opened locally'}
          </span>
        </dd>

        <dt className="text-muted-foreground">Last opened</dt>
        <dd className="text-foreground">{fullDate(project.lastOpenedAt)}</dd>
      </dl>
    </SettingsField>
  )
}

/**
 * Deregister this project — the registry table's per-row Remove, offered where the user already
 * is. Same hook, same dialog, same words (remove-project.tsx).
 *
 * The boot project cannot be removed: xezar is serving it and re-registers it at every start, so
 * the server 409s. Disabling here means the explanation arrives before the click rather than as
 * an error toast after it.
 *
 * On success the URL this page lives at (`/p/<id>/settings`) has just stopped resolving, so the
 * navigation is part of the action, not a nicety. It targets the BOOT project explicitly rather
 * than `/`: the bare root restores the last saved location, and whether the removed project has
 * already left the registry cache when that check runs is a race — this is the one project that
 * is always registered.
 */
function RemoveProject({ project, bootProject }: { project: ProjectListEntry; bootProject: string }) {
  const [confirming, setConfirming] = useState<ProjectListEntry | null>(null)
  const remove = useProjectRemoval()
  const navigate = useNavigate()
  const isBoot = project.id === bootProject

  return (
    <SettingsField
      title="Remove from workspace"
      hint="Unregisters this project so it leaves the sidebar and the project list. Nothing on disk is deleted — the folder, its git history and its task history all stay, and opening it again re-registers it."
    >
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-action="project-general-remove"
          // Leads with the words on the button (WCAG 2.5.3 Label in Name) so speech input can
          // reach it, then says what "Remove" actually does — the row context that makes a bare
          // "Remove" safe-sounding isn't read out with it.
          aria-label={`Remove ${project.name} from the workspace — unregisters it, no files are deleted`}
          title={isBoot ? 'xezar is serving this project — it re-registers itself at every start' : undefined}
          disabled={isBoot || remove.isPending}
          onClick={() => setConfirming(project)}
          // A long project name wraps inside the button instead of pushing it off a phone screen.
          className="h-auto max-w-full py-1.5 text-left whitespace-normal text-danger"
        >
          Remove {project.name}
        </Button>
        {isBoot ? (
          <span data-slot="project-general-remove-boot" className="text-[11px] text-soft-foreground">
            xezar is serving this project — it re-registers itself at every start.
          </span>
        ) : null}
      </div>
      <RemoveProjectDialog
        project={confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        onConfirm={() => {
          setConfirming(null)
          // A 409 (running tasks) leaves the project registered, so the navigation is inside the
          // success path only — `useProjectRemoval` toasts the server's refusal and stays put.
          remove.confirm(project, () => void navigate(`/p/${encodeURIComponent(bootProject)}`))
        }}
      />
    </SettingsField>
  )
}
