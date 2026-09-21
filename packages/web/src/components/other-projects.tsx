import { CopyIcon, FolderIcon } from 'lucide-react'

import type { ProjectListEntry } from '@qodeca/xezar-api-client'
import { MissingProjectBadge, useSidebarNavigate } from '@/components/app-shell'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { copyText } from '@/lib/clipboard-result'
import { cn } from '@/lib/utils'

/**
 * The sidebar's "Other projects" group — `--instance project` only (#467, PR 4;
 * `designs/cli-terminal/multi-instance.md` § 6).
 *
 * In this mode one xezar process serves the project it started in, so the other registered
 * projects are not reachable HERE: a scoped request for one answers 409 by design. They are still
 * listed, because the registry is how a person with several projects finds them and hiding them
 * would be `XEZ_SINGLE_PROJECT`, which already exists. Each row is therefore a way ACROSS rather
 * than a way in: a link to that project's own cockpit, on its own port, when it is running, and an
 * honest state word when it is not.
 *
 * Nothing here probes anything. The row state is `ProjectListEntry.instance`, which the server
 * derived for this request (PR 3) — a page that scans localhost ports is the wrong habit to build,
 * and only the server can also read a project's writer claim.
 *
 * Nothing here re-asks, either, and that is deliberate: the answer is kept current by the
 * `project-instances` topic the app shell holds while this band is on screen
 * (`useProjectInstancesSubscription`, #796), which folds each frame into the registry cache these
 * rows read. This component stays a pure function of what it is handed.
 */

/** The state text shown beside the name, and what the row can do about it. */
export interface OtherProjectRow {
  /** The contract's five `instance.state` answers, plus the registry's `missing` status and the
   *  one `unknown` case: `instance` omitted, which is exactly hosted mode. */
  state:
    | 'this'
    | 'running'
    | 'running-unknown-address'
    | 'stopped'
    | 'checking'
    | 'missing'
    | 'unknown'
  /** The word beside the name. `null` ONLY for `unknown`: this cockpit did not look, so it has
   *  nothing to say — "not running" there would be a claim the server never made. */
  label: string | null
  /** An ABSOLUTE url to that project's OWN cockpit, `http://<host>:<port>/p/<id>/`. Only a proven
   *  `running` row has one, and it is never a same-origin `/p/<id>/` path: the data belongs to
   *  another process, and opening it here is the writer refusal this whole mode exists to stop. */
  href: string | null
  /** The command that starts it, offered as Copy. `stopped` in LOCAL mode only — a hosted cockpit
   *  runs on a machine whose terminal the reader does not have. */
  command: string | null
  /** One line under the row where there is something useful to say. */
  hint: string | null
}

/**
 * One registry entry → one row, as a pure function so the sidebar and the ⌘K palette answer
 * identically. `localHandoff` is `capabilities.localHandoff`: false means hosted.
 */
export function otherProjectRow(
  project: ProjectListEntry,
  { localHandoff }: { localHandoff: boolean },
): OtherProjectRow {
  const blank = { label: null, href: null, command: null, hint: null }
  // A gone folder outranks every liveness answer: there is nothing to start and nothing to open.
  if (project.status === 'missing') {
    return { ...blank, state: 'missing', label: 'folder missing' }
  }
  const instance = project.instance
  if (instance === undefined) return { ...blank, state: 'unknown' }
  switch (instance.state) {
    case 'this':
      return { ...blank, state: 'this', label: 'current' }
    case 'running':
      // `url` is optional on the wire and present only with `running`. Absent is degraded to the
      // honest neighbouring state rather than to a link this row cannot build: "running, and this
      // cockpit cannot address it" is exactly what `running-unknown-address` means.
      return instance.url === undefined
        ? {
            ...blank,
            state: 'running-unknown-address',
            label: 'running — address not known',
            hint: 'Find the terminal that runs it.',
          }
        : { ...blank, state: 'running', label: 'running', href: instance.url }
    case 'running-unknown-address':
      return {
        ...blank,
        state: 'running-unknown-address',
        label: 'running — address not known',
        hint: 'Find the terminal that runs it.',
      }
    case 'stopped':
      return {
        ...blank,
        state: 'stopped',
        label: 'not running',
        command: localHandoff ? startCommand(project.root) : null,
      }
    case 'checking':
      return { ...blank, state: 'checking', label: 'checking…' }
  }
}

/** The one spelling of "start xezar in that folder", so the row and its toast agree. */
export function startCommand(root: string): string {
  return `xez --repo ${root}`
}

/** Copy that survives a denied or absent clipboard: the fallback toast shows the command itself,
 *  which is the payload — the same rule `run-header.tsx` follows for its worktree commands. */
function copyCommand(command: string): void {
  void copyText(command).then((result) =>
    toast(result.ok ? 'Command copied' : `Run manually: ${command}`),
  )
}

export function OtherProjects({
  projects,
  bootProjectId,
  localHandoff,
}: {
  /** The whole registry. The boot project is dropped here rather than by the caller, so
   *  "which one am I in" is answered once. */
  projects: ProjectListEntry[]
  bootProjectId: string
  /** `capabilities.localHandoff`. False (hosted) drops every Copy command: that terminal is on a
   *  machine this reader does not have. */
  localHandoff: boolean
}) {
  // Closes the phone drawer on a row click, exactly as the grouped sidebar's rows do. Undefined
  // on desktop, where there is nothing to close.
  const onNavigate = useSidebarNavigate()
  // Most-recently-opened first, the order the grouped sidebar already sorts by — and sorted here
  // rather than trusted from the wire, for the same reason it gives.
  const ordered = [...projects]
    .filter((project) => project.id !== bootProjectId)
    .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
  if (ordered.length === 0) return null

  return (
    <div data-slot="other-projects" className="shrink-0 border-t border-border px-1.5 pt-1.5 pb-2">
      <div
        data-slot="other-projects-header"
        className="flex min-h-tap w-full items-center gap-2 rounded-lg px-2 text-[13px] font-semibold md:h-9 md:min-h-0"
      >
        Other projects
      </div>
      {ordered.map((project) => (
        <OtherProjectRowView
          key={project.id}
          project={project}
          row={otherProjectRow(project, { localHandoff })}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  )
}

/** The nav-row spelling the grouped sidebar uses for its own items, so a row that links out reads
 *  as a peer of one that navigates — the only visible difference is where it goes. */
const ROW =
  'flex min-h-tap w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground md:h-8 md:min-h-0'

function OtherProjectRowView({
  project,
  row,
  onNavigate,
}: {
  project: ProjectListEntry
  row: OtherProjectRow
  onNavigate?: () => void
}) {
  const command = row.command
  const name = (
    <>
      <FolderIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{project.name}</span>
      {row.state === 'missing' ? (
        <MissingProjectBadge />
      ) : row.label === null ? null : (
        <span data-slot="other-project-state" className="shrink-0 text-[11px] text-soft-foreground">
          {row.label}
        </span>
      )}
    </>
  )

  return (
    <div data-slot="other-project" data-project-id={project.id} data-state={row.state}>
      {row.href === null ? (
        <div className={ROW}>{name}</div>
      ) : (
        // A plain anchor, never the router `Link`: this address is another ORIGIN (its own port),
        // and a router navigation would stay on this one and land on a 409.
        <a
          href={row.href}
          data-slot="other-project-link"
          onClick={onNavigate}
          title={`Open ${project.name} in its own cockpit (${row.href})`}
          className={cn(ROW, 'transition-colors hover:bg-muted hover:text-foreground')}
        >
          {name}
        </a>
      )}
      {row.hint === null ? null : (
        <p data-slot="other-project-hint" className="px-2.5 pb-1 text-[11px] text-soft-foreground">
          {row.hint}
        </p>
      )}
      {command === null ? null : (
        <div className="px-2.5 pb-1">
          <Button
            variant="ghost"
            size="sm"
            data-action="other-project-copy-command"
            title={`Copy ${command}`}
            onClick={() => copyCommand(command)}
          >
            <CopyIcon aria-hidden="true" />
            Copy command
          </Button>
        </div>
      )}
    </div>
  )
}
