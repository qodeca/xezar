import { useMutation, useQueryClient } from '@tanstack/react-query'
import { InfoIcon, PlusIcon } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { createRun } from '@/api/client'
import { useProjectScope } from '@/api/project-scope-context'
import { queryKeys, useHealth, useProjects, useRuns } from '@/api/queries'
import type { Skill } from '@qodeca/xezar-api-client'
import {
  EnginePills,
  useResolvedEngine,
  type EnginePick,
} from '@/components/engine-pills'
import { SkillPreviewDialog } from '@/components/skill-detail'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { deriveAttention } from '@/lib/attention'
import { Link } from '@/lib/project-router'
import { isSubmitShortcut, submitShortcutHint } from '@/lib/use-submit-shortcut'
import { cn } from '@/lib/utils'

import { readIssueBrief, writeIssueBrief } from './new-issue-draft'
import { findIssueCreateSkill, newIssueRunBody } from './new-issue-task'

/**
 * "New issue" — the GitHub tab's one create affordance (#468, PR 5).
 *
 * It starts an ORDINARY TASK on this project with the issue-filing skill selected, reusing the
 * same `POST /runs` the tab's hand-off panel already calls. There is no issue-mutation route, no
 * forge write and no new server capability: the agent files the issue, after the person has seen
 * the exact text and answered the task's own question.
 *
 * That distinction is the reason this surface exists at all, so it is stated four times in
 * descending prominence — the dialog description, the standing note, the button label
 * ("Start drafting", never "Create"), and the strip while the task runs. No colour, tone or icon
 * carries it.
 *
 * The leader's equivalent is `task_create` with the same skill source and `autonomous: false`
 * (owner rule, 2026-09-16: a capability the cockpit gains is reachable through the MCP);
 * `packages/xezar/src/mcp/tools/task-create.test.ts` holds the two bodies identical.
 */

// ---- copy ---------------------------------------------------------------------------------------

/** One place for the strings, so the two entry points and the tests cannot drift. */
export const newIssueCopy = {
  button: 'New issue',
  title: 'New issue',
  description:
    'An agent drafts the issue, searches open and closed issues for a duplicate and shows you the exact text. Nothing is filed until you approve it.',
  destinationLabel: 'Destination',
  projectLabel: 'Project',
  briefLabel: 'What is the problem or the request?',
  briefPlaceholder: 'Describe what happened, or what you want to change…',
  briefHint:
    'The agent asks for anything it still needs — reproduction, expected behaviour, the version.',
  viewSkill: 'View skill',
  /** Rendered as two spans so the lead can carry the weight; kept whole for the copy deck. */
  noteLead: 'Starting is not filing.',
  noteRest:
    'The agent shows you the exact title, body and labels, then asks you to Create or Revise in the task.',
  start: 'Start drafting',
  startPending: 'Starting…',
  cancel: 'Cancel',
  emptyBriefHint: 'Describe the issue to start',
  keptHint: 'Your text is kept either way',
  skillMissing:
    'No issue-filing skill is installed in this project. An ordinary task can still be started with your text, but without the skill there is no template intake, no duplicate search across closed issues and no Create or Revise step before the issue is filed. xezar installs nothing on its own.',
  skillMissingPlain: 'Start an ordinary task',
  skillMissingManage: 'Manage skills',
  hosted:
    'This cockpit runs in hosted mode. The task runs on the machine hosting xezar and the issue is filed with that machine’s login, not yours. Agent accounts are not offered here.',
  emptyListLead:
    'An agent can draft one, check for duplicates once more and show you the text before it is filed.',
} as const

/** The task is running, and it is not asking anything yet. */
const STRIP_RUNNING = 'Drafting an issue — searching for duplicates.'
/** The task stopped and wants the person: the Create or Revise question of the design. */
const STRIP_WAITING = 'The agent is asking about the issue draft — Create or Revise.'

// ---- the button ----------------------------------------------------------------------------------

/**
 * The control itself. Two of them exist — one at the end of the tab row, one under an empty list
 * — and both open the same dialog, so the label is never icon-only: a bare `+` in a tab row reads
 * as "add a tab".
 */
export function NewIssueButton({
  onOpen,
  className,
  slot = 'gh-new-issue',
}: {
  onOpen: () => void
  className?: string
  /** Distinguishes the two entry points for tests and QA. */
  slot?: string
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-action={slot}
      onClick={onOpen}
      className={cn('min-h-11 gap-1.5', className)}
    >
      <PlusIcon aria-hidden="true" className="size-3.5" />
      {newIssueCopy.button}
    </Button>
  )
}

// ---- the dialog ------------------------------------------------------------------------------------

export function NewIssueDialog({
  open,
  onOpenChange,
  repo,
  prefill,
  skills,
  engine,
  onEngineChange,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The destination the tab already discovered — `owner/repo`, or null when it has no slug. */
  repo: string | null
  /** The list's current search text (OQ-4): the person's own words, offered as the first line. */
  prefill: string
  skills: readonly Skill[]
  /** Shared with the hand-off panel, so a backend chosen in one place holds in the other. */
  engine: EnginePick
  onEngineChange: (engine: EnginePick) => void
  onStarted: (runId: string) => void
}) {
  const { projectId } = useProjectScope()
  const [brief, setBrief] = useState(() => readIssueBrief(projectId))
  const briefRef = useRef<HTMLTextAreaElement>(null)
  const queryClient = useQueryClient()
  const resolved = useResolvedEngine(engine)
  const projects = useProjects()
  const health = useHealth()
  const [previewSkill, setPreviewSkill] = useState<Skill | null>(null)
  const skill = findIssueCreateSkill(skills)
  // Absent capability is fail-closed everywhere else in this tab; here the honest reading of "the
  // server has not spoken yet" is the local default, because the hosted note is an addition and
  // showing it late is better than claiming a hosted cockpit that is not one.
  const hosted = health.data?.capabilities?.localHandoff === false
  const projectName =
    projects.data?.projects?.find((p) => p.id === (projectId ?? projects.data?.bootProject))?.name ??
    projectId ??
    null

  // The pre-fill is offered, never persisted: a dialog opened from an empty search and closed
  // again must leave no draft behind (OQ-4). So it seeds an EMPTY box on open and nothing else.
  useEffect(() => {
    if (!open) return
    setBrief((current) => (current === '' ? prefill : current))
    // `prefill` is read at open time only — the search box keeps moving behind the dialog, and a
    // box that rewrote itself under the person would be worse than not offering the words at all.
  }, [open])

  useEffect(() => {
    writeIssueBrief(projectId, brief)
  }, [projectId, brief])

  const start = useMutation({
    mutationFn: async (withSkill: boolean) => {
      return createRun(
        newIssueRunBody(
          brief,
          withSkill ? (skill?.name ?? null) : null,
          {
            runner: resolved.runner,
            runnerExplicit: resolved.runnerExplicit,
            defaultRunner: resolved.defaultRunner,
            model: resolved.model,
            modelsLocked: resolved.modelsLocked,
            account: resolved.account,
          },
          // Loading or failing, the composer assumes an enabled inbox so its controls do not
          // flicker; the same fallback applies here.
          health.data?.capabilities?.followups !== false,
        ),
      )
    },
    onSuccess: (created) => {
      const run = 'runs' in created ? created.runs[0] : created
      if (run) onStarted(run.id)
      toast('Added to the queue — issue draft')
      // Spent: clear the store AND the state together, or the box would show text that no longer
      // exists anywhere and would lose it on the next mount.
      writeIssueBrief(projectId, '')
      setBrief('')
      onOpenChange(false)
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
    },
    // No toast and no close: the dialog renders the server's own words above its footer and keeps
    // the text, because retyping a brief is the one thing this surface must never ask for.
  })

  const canStart = brief.trim() !== '' && skill !== null && resolved.canRun && !start.isPending
  const disabledReason =
    brief.trim() === ''
      ? newIssueCopy.emptyBriefHint
      : skill === null
        ? newIssueCopy.skillMissingPlain
        : null

  const submitShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const shouldSubmit =
      isSubmitShortcut({
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        repeat: event.repeat,
        isComposing: event.nativeEvent.isComposing,
      }) && (event.metaKey || event.ctrlKey) // multi-line box: bare Enter inserts a newline
    if (!shouldSubmit) return
    event.preventDefault()
    if (canStart) start.mutate(true)
  }

  return (
    <>
      <SkillPreviewDialog skill={previewSkill} onClose={() => setPreviewSkill(null)} />
      <Dialog open={open} onOpenChange={onOpenChange}>
        {/* The shipped width, unchanged: every cockpit dialog that widens or narrows picks a
            Tailwind step rather than an arbitrary bracket value. */}
        <DialogContent data-slot="gh-new-issue-dialog">
          <DialogHeader>
            <DialogTitle>{newIssueCopy.title}</DialogTitle>
            <DialogDescription>{newIssueCopy.description}</DialogDescription>
          </DialogHeader>

          <dl
            data-slot="gh-new-issue-destination"
            className="grid gap-x-row gap-y-1 text-xs sm:grid-cols-[auto_minmax(0,1fr)]"
          >
            <dt className="text-soft-foreground">{newIssueCopy.destinationLabel}</dt>
            <dd className="font-mono break-words [overflow-wrap:anywhere]">
              {repo ?? 'this repository'}
            </dd>
            <dt className="text-soft-foreground">{newIssueCopy.projectLabel}</dt>
            <dd className="break-words [overflow-wrap:anywhere]">{projectName ?? 'this project'}</dd>
          </dl>

          <div className="flex flex-col gap-stack">
            <label htmlFor="gh-new-issue-brief" className="text-[13px] font-medium">
              {newIssueCopy.briefLabel}
            </label>
            <Textarea
              id="gh-new-issue-brief"
              ref={briefRef}
              data-slot="gh-new-issue-brief"
              aria-describedby="gh-new-issue-brief-hint"
              aria-keyshortcuts="Control+Enter Meta+Enter"
              value={brief}
              disabled={start.isPending}
              onChange={(event) => setBrief(event.target.value)}
              onKeyDown={submitShortcut}
              placeholder={newIssueCopy.briefPlaceholder}
              className="min-h-28 text-[13px]"
            />
            <p id="gh-new-issue-brief-hint" className="text-xs text-soft-foreground">
              {newIssueCopy.briefHint}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-row">
            <EnginePills
              pick={engine}
              onChange={onEngineChange}
              disabled={start.isPending || !resolved.canRun}
              accounts
            />
            {skill ? (
              <button
                type="button"
                data-slot="gh-new-issue-view-skill"
                onClick={() => setPreviewSkill(skill)}
                className="rounded-sm font-mono text-[11px] font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                {newIssueCopy.viewSkill}
              </button>
            ) : null}
            {!resolved.providerPending && !resolved.canRun ? (
              <span
                data-slot="gh-new-issue-provider-gate"
                className="inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
              >
                {resolved.providerError
                  ? 'Provider authentication could not be verified.'
                  : 'Connect an agent provider to run this item.'}
                <Link
                  to="/settings/agents#providers"
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  Configure providers
                </Link>
              </span>
            ) : null}
          </div>

          {skill === null ? (
            <div
              data-slot="gh-new-issue-skill-missing"
              className="flex flex-col gap-row rounded-md border border-conflict/40 bg-conflict/5 p-stack text-xs"
            >
              <p>{newIssueCopy.skillMissing}</p>
              <div className="flex flex-wrap items-center gap-row">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-action="gh-new-issue-plain"
                  disabled={brief.trim() === '' || start.isPending || !resolved.canRun}
                  onClick={() => start.mutate(false)}
                  className="min-h-11"
                >
                  {newIssueCopy.skillMissingPlain}
                </Button>
                <Link
                  to="/skills"
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  {newIssueCopy.skillMissingManage}
                </Link>
              </div>
            </div>
          ) : null}

          {hosted ? (
            <p data-slot="gh-new-issue-hosted" className="text-xs text-soft-foreground">
              {newIssueCopy.hosted}
            </p>
          ) : null}

          {start.error ? (
            <p role="alert" data-slot="gh-new-issue-error" className="text-xs text-danger">
              Could not start the task — {start.error.message}. Your text is still here.
            </p>
          ) : null}

          <p
            data-slot="gh-new-issue-note"
            className="flex items-start gap-row rounded-md border border-border bg-card-2 p-stack text-xs text-muted-foreground"
          >
            <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>
              <strong className="font-semibold text-foreground">{newIssueCopy.noteLead}</strong>{' '}
              {newIssueCopy.noteRest}
            </span>
          </p>

          <DialogFooter className="sm:items-center">
            {/* The reason a disabled button is disabled is visible text, linked to the button —
                never a `title` a keyboard or a touch user never sees. */}
            <p
              id="gh-new-issue-start-reason"
              data-slot="gh-new-issue-start-reason"
              className="mr-auto text-xs text-soft-foreground"
            >
              {disabledReason ?? newIssueCopy.keptHint}
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={start.isPending}
              onClick={() => onOpenChange(false)}
              className="min-h-11"
            >
              {newIssueCopy.cancel}
            </Button>
            <Button
              type="button"
              variant="contrast"
              data-action="gh-new-issue-start"
              aria-describedby="gh-new-issue-start-reason"
              disabled={!canStart}
              onClick={() => start.mutate(true)}
              className="min-h-11"
            >
              {start.isPending ? newIssueCopy.startPending : newIssueCopy.start}
            </Button>
            <kbd
              aria-hidden="true"
              className="rounded-[5px] border border-b-2 border-border bg-card px-[5px] py-px font-mono text-[10.5px] font-medium text-muted-foreground"
            >
              {submitShortcutHint()}
            </kbd>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ---- the strip ---------------------------------------------------------------------------------

/**
 * What a started draft looks like from the tab it was started in: one line, never the question
 * itself. The question has one home — the task's own thread, where the `AskCard` shows the exact
 * body being approved, which this tab cannot.
 *
 * It reads the live record from the runs cache the global SSE stream already patches; there is no
 * poll here. Tone and wording come from `deriveAttention`, so the strip and the sidebar's
 * attention dot can never disagree about the same run. Each sentence names its own state, so it
 * still reads correctly with the dot removed.
 */
export function IssueDraftStrip({ runId }: { runId: string | null }) {
  const runs = useRuns()
  const run = runId === null ? undefined : runs.data?.find((r) => r.id === runId)
  if (!run) return null
  const attention = deriveAttention(run)
  if (attention.bucket !== 'running' && attention.bucket !== 'waiting') return null
  const waiting = attention.bucket === 'waiting'
  return (
    <div
      role="status"
      data-slot="gh-issue-draft-strip"
      data-bucket={attention.bucket}
      className="flex flex-wrap items-center gap-row border-b border-border px-4 py-2 text-xs"
    >
      <StatusDot tone={attention.tone} pulse={attention.pulse} />
      <span className={cn('min-w-0', waiting && 'text-pending-strong')}>
        {waiting ? STRIP_WAITING : STRIP_RUNNING}
      </span>
      <Link
        to={`/tasks/${run.id}`}
        data-slot="gh-issue-draft-link"
        className="font-semibold text-violet hover:underline"
      >
        {waiting ? 'Answer →' : 'View task →'}
      </Link>
    </div>
  )
}
