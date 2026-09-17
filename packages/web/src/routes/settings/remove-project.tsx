import { useLayoutEffect, useRef, type SyntheticEvent } from 'react'

import { useRemoveProject } from '@/api/queries'
import type { ProjectListEntry } from '@qodeca/xezar-api-client'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'

/**
 * Removing a project, said the same way in both places that offer it: the global registry table
 * (Settings → Projects) and the project's own General page.
 *
 * "Remove" next to a project path is exactly the kind of button a user reads as "delete my repo",
 * so the wording is load-bearing and belongs in ONE file — the confirm title, the body, the path
 * it names and the success toast all insist on the same fact: this DEREGISTERS.
 * `DELETE /api/v1/projects/:id` is a registry filter and touches nothing under the root (see the
 * route), and opening the folder again re-registers it with its tasks and worktrees intact.
 *
 * The refusals stay the server's: a project with running tasks and the boot project both answer
 * 409, whose message is toasted verbatim. Callers that can know about the boot project up front
 * (both of them) disable the trigger instead, so the explanation arrives before the click.
 */

/** The deregistration itself, with the wording every caller shares. `onRemoved` runs only after
 *  the server confirmed — the project's own settings page uses it to navigate off a URL that has
 *  just stopped resolving. */
export function useProjectRemoval() {
  const remove = useRemoveProject()
  return {
    isPending: remove.isPending,
    confirm: (project: ProjectListEntry, onRemoved?: () => void) =>
      remove.mutate(project.id, {
        // "Removed from the workspace", not "Deleted": the toast is the last word the user reads
        // about a button they may have pressed nervously.
        onSuccess: () => {
          toast(`${project.name} removed from the workspace — its files are untouched`)
          onRemoved?.()
        },
        onError: (error: Error) => toast(error.message, { tone: 'danger' }),
      }),
  }
}

/**
 * Focus return for a confirmation opened from STATE rather than from a Radix trigger (#453 B3).
 * Radix hands focus back only to its own trigger; these dialogs have none, so a Cancel or Escape
 * dropped keyboard focus on `<body>`. The opener is read in a layout effect — before Radix's
 * focus scope moves focus into the dialog — and restored in `onCloseAutoFocus` while it is still
 * in the document (a removed row's button is not, and then Radix's default applies).
 *
 * `explicitOpener` is for the case `document.activeElement` cannot answer: when the confirm is
 * opened from a row of a Radix MENU, the focused element at that moment is the menu container
 * itself, and the menu unmounts as the dialog opens — so the captured target is disconnected by
 * close time and focus silently lands on `<body>` again (#453 B8 design review B-1). The caller
 * that owns the control which opened the MENU passes it here, and it stays mounted throughout.
 */
export function useReturnFocus(open: boolean, explicitOpener?: HTMLElement | null) {
  const opener = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!open || opener.current !== null) return
    if (explicitOpener) {
      opener.current = explicitOpener
      return
    }
    if (document.activeElement instanceof HTMLElement) {
      opener.current = document.activeElement
    }
  }, [open, explicitOpener])
  return (event: SyntheticEvent | Event) => {
    const target = opener.current
    opener.current = null
    if (target?.isConnected) {
      event.preventDefault()
      target.focus()
    }
  }
}

/** The confirm step. `project` doubles as the open state — `null` while it is closed. */
export function RemoveProjectDialog({
  project,
  onOpenChange,
  onConfirm,
}: {
  project: ProjectListEntry | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const returnFocus = useReturnFocus(project !== null)
  return (
    <AlertDialog open={project !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent onCloseAutoFocus={returnFocus}>
        {/* `min-w-0`: the grid item may shrink, so the truncated path below cannot widen the dialog past a phone screen. */}
        <AlertDialogHeader className="min-w-0">
          <AlertDialogTitle>Remove {project?.name} from the workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            This only unregisters the project — <strong>nothing on disk is deleted</strong>. The
            folder, its git history and its task history all stay exactly where they are, and
            opening it again re-registers it with everything intact.
            <span className="mt-1 block truncate font-mono text-[11px] text-foreground" title={project?.root}>
              {project?.root}
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            data-action="projects-confirm-remove"
            className={buttonVariants({ variant: 'danger' })}
            onClick={onConfirm}
          >
            Remove from list
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
