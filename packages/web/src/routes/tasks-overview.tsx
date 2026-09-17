import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveIcon,
  BotIcon,
  CheckCheckIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  Clock3Icon,
  CoinsIcon,
  CompassIcon,
  CpuIcon,
  DollarSignIcon,
  FileDiffIcon,
  GitBranchIcon,
  ListChecksIcon,
  LinkIcon,
  MemoryStickIcon,
  PencilIcon,
  PlusIcon,
  ScaleIcon,
  SearchIcon,
  SearchXIcon,
  SparklesIcon,
  WorkflowIcon,
} from 'lucide-react'
import * as React from 'react'
import { Link, useNavigate } from '@/lib/project-router'

import { archiveFinished, markAllRunsSeen, patchRun } from '@/api/client'
import { useRunUsage } from '@/api/global-events'
import {
  queryKeys,
  useConfig,
  useHealth,
  useOnboarding,
  usePinRun,
  useReferenceProjectId,
  useRuns,
  useSetupStart,
} from '@/api/queries'
import type { RunRecord, Runner } from '@qodeca/xezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { DiffStatLabel } from '@/components/diff-stat'
import { DirectionalUsage } from '@/components/directional-usage'
import { TitleEditInput, useTitleEditor } from '@/components/editable-title'
import { useListView } from '@/components/list-view'
import { Pill } from '@/components/pill'
import { PinToggle } from '@/components/pin-toggle'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ModelNameCell, ToolNameCell } from '@/components/task-agent'
import { SETUP_HERO_SENTENCE } from '@/lib/onboarding'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import { isReadDoneItem, isUnread, unreadDoneCount, type ReadStateInput } from '@/lib/read-state'
import {
  TASK_TD_CLASS,
  TASK_TH_CLASS,
  isColumnExpanded,
  normalizeExpandedColumns,
  taskColumnsForCapabilities,
  type NormalizedExpandedColumns,
  type TaskColumnDefinition,
  type TaskColumnIcon,
  type TaskColumnId,
} from '@/lib/task-columns'
import { modelLabel, runnerLabel, stepBackendCount, taskRunner } from '@/lib/runner-label'
import { listCounts, queuePositions, runTitle, sortRuns, type ListView } from '@/lib/task-groups'
import {
  compareGroups,
  filterRuns,
  finishedRunCount,
  formatCost,
  scheduledResume,
  taskReference,
  USAGE_CELL_CLASS,
  usageCells,
  workflowLabel,
  type UsageCell,
} from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useTaskTableColumns } from '@/lib/use-task-table-columns'
import { useIsDesktop } from '@/lib/use-desktop'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/**
 * The Tasks overview — the table that IS the home at `/` (spec, "Task list & table", per PR
 * #392: the Tasks nav always lands here, there is no list/table presentation toggle, and the
 * Active/Archived tabs in this header are the *same state* as the global Tasks page's view).
 *
 * Presentational: sorting, search, queue numbers, usage-cell decisions and the compare strip
 * all come from the pure modules (`lib/task-groups.ts`, `lib/tasks-table.ts`,
 * `lib/attention.ts`). What lives here is markup, the router, and the local search text.
 *
 * Below `md` the table becomes a stacked card list plus a New-task FAB — same rows, same order,
 * same data, only the framing changes (mockup `tasks-home.html`, mobile section).
 */
export function TasksOverview({
  runs,
  view,
  onViewChange,
  onArchiveFinished,
  onMarkAllRead,
  onRename,
  onTogglePin,
  now = Date.now(),
  showTokens = true,
  showCost = true,
  defaultRunner,
  expandedColumns = normalizeExpandedColumns(undefined),
  onToggleColumn = () => undefined,
  columnsPending = false,
}: {
  /** Undefined while `/api/runs` has not answered: the header renders, the body stays empty —
   *  an empty state before we know there are no runs would be a lie. */
  runs: RunRecord[] | undefined
  view: ListView
  onViewChange: (view: ListView) => void
  onArchiveFinished: () => void
  /** "Mark all read" (#unread-done-items) — stamps every unread finished run. */
  onMarkAllRead: () => void
  /** Inline rename from the table's Task cell (spec step 15) — the route wires this to
   *  `PATCH /api/runs/:id`, the same flow as the run header's pencil. */
  onRename: (id: string, title: string) => void
  /** Pin/unpin one task (#935). Pinned rows sort to the top of the table — `sortRuns` does that
   *  for every surface at once — so the row's own control is also the only thing on this page
   *  that explains why one is up there. */
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
  /** Injected so the ages are not racing the clock in tests. */
  now?: number
  /** Presentation capability; defaults visible for older health responses and direct renders. */
  showTokens?: boolean
  showCost?: boolean
  /** This project's `defaultRunner` — what a task that chose no runner actually ran as. Undefined
   *  only while `GET /config` is in flight; the Tool cell then falls back exactly as the run
   *  header's `AgentBadge` does. */
  defaultRunner?: Runner
  /** Workspace-global desktop column choices; absent ids use registry defaults. */
  expandedColumns?: NormalizedExpandedColumns
  onToggleColumn?: (id: TaskColumnId) => void
  /** Prevent a shallow write before the authoritative workspace state can preserve siblings. */
  columnsPending?: boolean
}) {
  const [query, setQuery] = React.useState('')
  const all = runs ?? []
  const counts = listCounts(all)
  const visible = sortRuns(filterRuns(all, query), view)
  // Positions come from the full list, never the filtered one: a search must not renumber the
  // queue the engine is actually going to drain.
  const positions = queuePositions(all)
  const strips = compareGroups(filterRuns(all, query), view)
  const finished = finishedRunCount(all)
  const columns = taskColumnsForCapabilities({ tokens: showTokens, cost: showCost })
  const unread = unreadDoneCount(all)
  // The archived view withholds the pin, the same call `runActionFlags` makes for the thread
  // header (`pin: !run.archived`): `sortRuns` skips the pin comparator there and `bucketOf`
  // answers `Archived` before it ever reads `run.pinned`, so the button would be an action with
  // nowhere to show its result — and one that outlives the view, since un-archiving would then
  // drop the task at the top of the active list by a click that looked like it did nothing.
  const pinToggle = view === 'archived' ? undefined : onTogglePin
  const desktop = useIsDesktop()

  const tabs = (
    <ListViewTabs
      view={view}
      onSelect={onViewChange}
      counts={{ active: counts.active, archived: counts.archived }}
    />
  )
  const actions = (
    <>
      {/* Count-gated, like the broom beside it: offered only while there is unread history to
          clear (#unread-done-items). Archived runs are never unread, so this only ever lights
          on the Active tab in practice — no need to also gate on `view`. */}
      {unread > 0 ? (
        <Button type="button" variant="ghost" size="sm" data-slot="mark-all-read" onClick={onMarkAllRead}>
          <CheckCheckIcon className="size-3.5" aria-hidden="true" />
          Mark all read
        </Button>
      ) : null}
      {/* Only when there is something to sweep, like the legacy header's count-gated broom. */}
      {view === 'active' && finished > 0 ? (
        <Button type="button" variant="ghost" size="sm" data-slot="archive-finished" onClick={onArchiveFinished}>
          <ArchiveIcon className="size-3.5" aria-hidden="true" />
          Archive finished
        </Button>
      ) : null}
    </>
  )

  return (
    <div data-route="tasks" className="flex min-h-full flex-col">
      {/* Desktop header. Below `md` the shell's top bar already says "Tasks", and the drawer
          carries the shared Active/Archived tabs — repeating them here would be a third copy. */}
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background md:flex md:px-section">
        <h1 className="text-base font-semibold">Tasks</h1>
        {tabs}
        <div className="flex-1" />
        {actions}
        <SearchField value={query} onChange={setQuery} placeholder="Search tasks…" label="Search tasks" className="w-60" />
      </header>

      <div className="flex flex-1 flex-col p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-section md:pb-section">
        {/* Below `md` the header is hidden, so its tabs, actions and search ride here (#453 G-17):
            a phone keeps every action the desktop header offers. Mounted on a phone only, so a
            desktop page has one of each control rather than a hidden twin. No `md:hidden` as well: that
            is a rem query and the hook a px one, so with a non-default font size the two could
            disagree and hide the only copy. */}
        {desktop ? null : (
          <div data-slot="tasks-phone-toolbar" className="mb-list flex flex-col gap-stack">
            <div className="flex flex-wrap items-center gap-row">
              {tabs}
              {actions}
            </div>
            <SearchField value={query} onChange={setQuery} placeholder="Search tasks…" label="Search tasks" />
          </div>
        )}
        {runs === undefined ? null : visible.length === 0 ? (
          <TasksEmptyState view={view} query={query} />
        ) : (
          <>
            {/* ≥md: the table. */}
            <div
              data-slot="tasks-table"
              className="hidden overflow-x-auto rounded-lg border border-border bg-card shadow-xs md:block"
            >
              <TooltipProvider>
                <table className="w-full border-collapse">
                  <colgroup>
                    {columns.map((column) => {
                      const expanded = isColumnExpanded(column.id, expandedColumns)
                      return (
                        <col
                          key={column.id}
                          data-column-id={column.id}
                          data-expanded={expanded}
                          style={{ width: expanded ? column.width : '42px' }}
                        />
                      )
                    })}
                  </colgroup>
                  <thead>
                    <tr>
                      {columns.map((column) => (
                        <TaskColumnHeader
                          key={column.id}
                          column={column}
                          expanded={isColumnExpanded(column.id, expandedColumns)}
                          onToggle={onToggleColumn}
                          disabled={columnsPending}
                        />
                      ))}
                    </tr>
                  </thead>
                  <tbody className="[&>tr:last-child>td]:border-b-0">
                    {visible.map((run) => (
                      <TableRow
                        key={run.id}
                        run={run}
                        queuePosition={run.status === 'queued' ? (positions.get(run.id) ?? null) : null}
                        onRename={onRename}
                        onTogglePin={pinToggle}
                        now={now}
                        columns={columns}
                        expandedColumns={expandedColumns}
                        defaultRunner={defaultRunner}
                      />
                    ))}
                  </tbody>
                </table>
              </TooltipProvider>
            </div>

            {/* <md: the same runs as stacked cards. */}
            <div data-slot="task-cards" className="flex flex-col gap-list md:hidden">
              {visible.map((run) => (
                <TaskCard
                  key={run.id}
                  run={run}
                  queuePosition={run.status === 'queued' ? (positions.get(run.id) ?? null) : null}
                  now={now}
                  showTokens={showTokens}
                  showCost={showCost}
                  defaultRunner={defaultRunner}
                  onTogglePin={pinToggle}
                />
              ))}
            </div>
          </>
        )}

        {strips.map((group) => (
          <div
            key={group.groupId}
            data-slot="compare-strip"
            data-group-id={group.groupId}
            className="mt-list flex flex-wrap items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 py-2.5 text-[12.5px] text-muted-foreground shadow-xs"
          >
            <ScaleIcon className="size-4 shrink-0 text-soft-foreground" aria-hidden="true" />
            <span>
              <strong className="font-semibold text-foreground">{group.title}</strong> — {group.count} variants
              finished
            </span>
            <Button asChild variant="outline" size="sm" className="md:ml-auto">
              <Link to={`/compare/${group.groupId}`}>Compare</Link>
            </Button>
          </div>
        ))}
      </div>

      {/* The mobile New-task FAB. The desktop CTA lives in the sidebar. A router Link since
          R4 step 1.3 re-pointed /new at the React composer — no full page load needed. */}
      <Link
        to="/new"
        data-slot="new-task-fab"
        aria-label="New task"
        // `min-h-tap min-w-tap`: `size-14` rides the density lever and is 42 px at Compact for real.
        className="fixed right-4 bottom-[calc(16px+env(safe-area-inset-bottom))] z-20 inline-flex size-14 min-h-tap min-w-tap items-center justify-center rounded-full bg-primary text-primary-foreground shadow-modal outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:hidden"
      >
        <PlusIcon className="size-5.5" aria-hidden="true" />
      </Link>
    </div>
  )
}

/**
 * What an empty list honestly means, given how it got empty — as a CenteredState, one variant
 * per cause. Only the no-tasks-at-all state is a hero moment and gets the twinkle backdrop
 * (spec: textures on hero/empty surfaces only); a missed search or an unswept archive is just
 * a fact, so those stay flat. `heading="h2"` because the page's h1 is the header's "Tasks".
 */
function TasksEmptyState({ view, query }: { view: ListView; query: string }) {
  const needle = query.trim()
  const kind = needle ? 'search-miss' : view === 'archived' ? 'archive' : 'no-tasks'
  return (
    <div data-slot="tasks-empty" data-empty-kind={kind} className="flex flex-1 flex-col">
      {kind === 'search-miss' ? (
        <CenteredState
          heading="h2"
          icon={<SearchXIcon />}
          tone="neutral"
          title="No matching tasks"
          subtitle={`No tasks match “${needle}”.`}
        />
      ) : kind === 'archive' ? (
        <CenteredState
          heading="h2"
          icon={<ArchiveIcon />}
          tone="neutral"
          title="Nothing archived yet"
          subtitle="Finished tasks you archive land here."
        />
      ) : (
        <CenteredState
          heading="h2"
          icon={<ListChecksIcon />}
          tone="primary"
          backdrop
          title="No tasks yet"
          subtitle="Describe a task to get started."
          actions={
            <Button asChild>
              <Link to="/new">
                <PlusIcon aria-hidden="true" />
                New task
              </Link>
            </Button>
          }
        >
          <SetupAside />
        </CenteredState>
      )}
    </div>
  )
}

/**
 * The Active/Archived toggle of both task tables (#453 G-17) — the project table passes counts,
 * the global one does not. Toggle buttons rather than a tablist: these filter one list in place,
 * they do not switch panels, so `aria-pressed` is what they are.
 */
export function ListViewTabs({
  view,
  onSelect,
  counts,
}: {
  view: ListView
  onSelect: (view: ListView) => void
  /** No "0": an empty view says so by being empty. Omit to show no counts at all. */
  counts?: Record<ListView, number>
}) {
  return (
    <div className="inline-flex gap-0.5 rounded-md bg-muted p-0.75">
      {(['active', 'archived'] as const).map((option) => {
        const isActive = option === view
        const count = counts?.[option] ?? 0
        return (
          <button
            key={option}
            type="button"
            data-slot="overview-tab"
            data-view={option}
            aria-pressed={isActive}
            onClick={() => onSelect(option)}
            // `min-h-tap … md:min-h-0`: a 44 px phone target at every density (#453 Q85).
            className={cn(
              'flex h-7 min-h-tap items-center justify-center gap-1.5 rounded-[7px] px-3 text-[12.5px] font-medium text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-0',
              isActive && 'bg-card font-semibold text-foreground shadow-xs',
            )}
          >
            {option === 'active' ? 'Active' : 'Archived'}
            {count > 0 ? <span className="font-mono text-[11px] tabular-nums">{count}</span> : null}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The search box of both task tables (#453 G-12): the `Input` primitive with a leading icon, so
 * its phone target, focus ring and iOS text size are the primitive's. The caller owns the value
 * and the width.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  className,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** The accessible name — a placeholder is not a label. */
  label: string
  className?: string
}) {
  return (
    <div className={cn('relative w-full', className)}>
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-soft-foreground"
        aria-hidden="true"
      />
      <Input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="pl-8 md:text-[13px]"
      />
    </div>
  )
}

/** A task-table header cell — the one look both tables use (`TASK_TH_CLASS`). */
export function TaskTh({
  children,
  right = false,
  columnId,
  folded = false,
  className,
}: {
  children: React.ReactNode
  right?: boolean
  columnId?: TaskColumnId
  folded?: boolean
  className?: string
}) {
  return (
    <th
      scope="col"
      data-column-id={columnId}
      data-folded={folded || undefined}
      className={cn(TASK_TH_CLASS, right && 'text-right', folded && 'px-0 first:pl-0 last:pr-0', className)}
    >
      {children}
    </th>
  )
}

function TaskColumnHeader({
  column,
  expanded,
  onToggle,
  disabled,
}: {
  column: TaskColumnDefinition
  expanded: boolean
  onToggle: (id: TaskColumnId) => void
  disabled: boolean
}) {
  if (!column.canFold) {
    return (
      <TaskTh columnId={column.id} right={column.align === 'right'}>
        {column.label}
      </TaskTh>
    )
  }

  const action = expanded ? 'Fold' : 'Expand'
  return (
    <TaskTh columnId={column.id} right={column.align === 'right'} folded={!expanded}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`${action} ${column.label} column`}
            aria-pressed={expanded}
            disabled={disabled}
            onClick={() => onToggle(column.id)}
            className={cn(
              'inline-flex h-8 w-full items-center gap-1 rounded-sm px-0.5 text-inherit outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-60',
              column.align === 'right' ? 'justify-end' : 'justify-start',
              !expanded && 'justify-center px-0',
            )}
          >
            {expanded ? (
              <>
                <span>{column.label}</span>
                <ChevronsLeftIcon className="size-3 opacity-55" aria-hidden="true" />
              </>
            ) : (
              <>
                <TaskColumnIconView icon={column.icon} />
                <ChevronsRightIcon className="size-3 opacity-70" aria-hidden="true" />
              </>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{column.label} · {action} column</TooltipContent>
      </Tooltip>
    </TaskTh>
  )
}

function TaskColumnIconView({ icon }: { icon?: TaskColumnIcon }) {
  const className = 'size-3.5'
  switch (icon) {
    case 'workflow':
      return <WorkflowIcon className={className} aria-hidden="true" />
    case 'tool':
      return <BotIcon className={className} aria-hidden="true" />
    case 'model':
      return <SparklesIcon className={className} aria-hidden="true" />
    case 'branch':
      return <GitBranchIcon className={className} aria-hidden="true" />
    case 'diff':
      return <FileDiffIcon className={className} aria-hidden="true" />
    case 'reference':
      return <LinkIcon className={className} aria-hidden="true" />
    case 'tokens':
      return <CoinsIcon className={className} aria-hidden="true" />
    case 'cost':
      return <DollarSignIcon className={className} aria-hidden="true" />
    case 'cpu':
      return <CpuIcon className={className} aria-hidden="true" />
    case 'memory':
      return <MemoryStickIcon className={className} aria-hidden="true" />
    case 'started':
      return <Clock3Icon className={className} aria-hidden="true" />
    default:
      return null
  }
}

const TD_BASE = TASK_TD_CLASS

/**
 * One run, one row.
 *
 * The whole row is a click target for `/tasks/:id` — but a click that lands on any anchor,
 * button or input inside it (the PR chip, the title's real link, the rename pencil and its
 * input) belongs to that control and is not hijacked. The title is a true `<Link>` so the
 * row's destination exists for keyboards and middle-clicks too.
 */
function TableRow({
  run,
  queuePosition,
  onRename,
  onTogglePin,
  now,
  columns,
  expandedColumns,
  defaultRunner,
}: {
  run: RunRecord
  queuePosition: number | null
  onRename: (id: string, title: string) => void
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
  now: number
  columns: readonly TaskColumnDefinition[]
  expandedColumns: NormalizedExpandedColumns
  defaultRunner?: Runner
}) {
  const navigate = useNavigate()
  const attention = deriveAttention(run)
  const scheduled = scheduledResume(run)
  const to = `/tasks/${run.id}`
  const cost = formatCost(run.costUsd)
  const reference = taskReference(run)
  const runner = taskRunner(run.runner, run.steps, defaultRunner)
  const backends = stepBackendCount(run.steps)

  return (
    <tr
      data-slot="task-table-row"
      data-run-id={run.id}
      onClick={(event) => {
        if (isOwnClick(event, 'a, button, input')) navigate(to)
      }}
      className="group/row cursor-pointer hover:bg-muted"
    >
      {columns.map((column) => {
        if (column.id === 'memory') return null
        if (column.id === 'cpu') {
          return queuePosition !== null ? (
            <td
              key={column.id}
              data-slot="queue-note"
              data-column-id="cpu-memory"
              colSpan={2}
              className={cn(TD_BASE, 'text-right font-mono text-[11.5px] text-soft-foreground')}
            >
              #{queuePosition} in queue
            </td>
          ) : (
            <UsageTds
              key={column.id}
              run={run}
              cpuExpanded={isColumnExpanded('cpu', expandedColumns)}
              memoryExpanded={isColumnExpanded('memory', expandedColumns)}
            />
          )
        }
        return (
          <TaskTableCell
            key={column.id}
            column={column}
            expanded={isColumnExpanded(column.id, expandedColumns)}
            run={run}
            attention={attention}
            scheduled={scheduled}
            reference={reference}
            cost={cost}
            runner={runner}
            backends={backends}
            to={to}
            onRename={onRename}
            onTogglePin={onTogglePin}
            now={now}
          />
        )
      })}
    </tr>
  )
}

function TaskTableCell({
  column,
  expanded,
  run,
  attention,
  scheduled,
  reference,
  cost,
  runner,
  backends,
  to,
  onRename,
  onTogglePin,
  now,
}: {
  column: TaskColumnDefinition
  expanded: boolean
  run: RunRecord
  attention: ReturnType<typeof deriveAttention>
  scheduled: ReturnType<typeof scheduledResume>
  reference: ReturnType<typeof taskReference>
  cost: string
  runner: ReturnType<typeof taskRunner>
  backends: number
  to: string
  onRename: (id: string, title: string) => void
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
  now: number
}) {
  if (!expanded) return <FoldedTd column={column.id} />

  switch (column.id) {
    case 'status':
      return (
        <td data-column-id={column.id} className={TD_BASE}>
          {/* A scheduled run wears its appointment in the pill, the way a queued one wears its
              queue position — the row's whole answer to "what is this waiting for?". */}
          <Pill dot={attention.tone} pulse={attention.pulse} title={scheduled?.title}>
            {attention.label}
            {scheduled ? <span className="tabular-nums">{scheduled.label}</span> : null}
          </Pill>
        </td>
      )
    case 'task':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'min-w-[220px] max-w-0')}>
          <TitleCell run={run} to={to} onRename={onRename} onTogglePin={onTogglePin} />
        </td>
      )
    case 'workflow':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'text-[12.5px] text-muted-foreground')}>
          {workflowLabel(run)}
        </td>
      )
    case 'tool':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'max-w-0')}>
          <ToolNameCell runner={runner.runner} inherited={runner.inherited} backends={backends} />
        </td>
      )
    case 'model':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'max-w-0')}>
          <ModelNameCell model={run.model} />
        </td>
      )
    case 'branch':
      return (
        <td data-column-id={column.id} className={TD_BASE}>
          {run.branch ? <BranchChip branch={run.branch} /> : <Dash />}
        </td>
      )
    case 'diff':
      return (
        <td data-column-id={column.id} className={TD_BASE}>
          {run.diffStat ? <DiffStatLabel stat={run.diffStat} /> : <Dash />}
        </td>
      )
    case 'reference':
      return (
        <td data-column-id={column.id} className={TD_BASE}>
          {reference ? <TaskReferenceChip run={run} reference={reference} /> : <Dash />}
        </td>
      )
    case 'tokens':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'text-right text-xs text-muted-foreground')}>
          <DirectionalUsage
            inputTokens={run.inputTokens}
            outputTokens={run.outputTokens}
            totalTokens={run.tokensUsed || undefined}
            variant="table"
            omitWhenUnknown={false}
          />
        </td>
      )
    case 'cost':
      return (
        <td
          data-column-id={column.id}
          className={cn(TD_BASE, 'text-right font-mono text-xs text-muted-foreground tabular-nums')}
        >
          {cost || <Dash />}
        </td>
      )
    case 'started':
      return (
        <td data-column-id={column.id} className={cn(TD_BASE, 'text-right text-xs text-soft-foreground tabular-nums')}>
          {shortAge(run.startedAt ?? run.createdAt, now)}
        </td>
      )
    case 'cpu':
    case 'memory':
      return null
  }
}

function FoldedTd({ column }: { column: TaskColumnId }) {
  return (
    <td
      role="presentation"
      aria-hidden="true"
      data-column-id={column}
      data-folded="true"
      className={cn(TD_BASE, 'px-0 first:pl-0 last:pr-0')}
    />
  )
}

/**
 * The Task cell: the title as a real link, with the mockup's hover pencil (`tasks-home.html`
 * `.task-title .pencil`) flipping it into the shared inline-rename input. Same machine as the
 * run header's title — one edit, one PATCH.
 */
function TitleCell({
  run,
  to,
  onRename,
  onTogglePin,
}: {
  run: RunRecord
  to: string
  onRename: (id: string, title: string) => void
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
}) {
  const title = runTitle(run)
  const editor = useTitleEditor(title, (next) => onRename(run.id, next))
  // Read/unread (#unread-done-items, "Option B"): promote an unread done item (bright + semibold)
  // and dim a read one, matching the sidebar row exactly so the two surfaces read as one grammar.
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)

  if (editor.editing) {
    return <TitleEditInput editor={editor} className="text-[13px] font-medium" />
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Link
        to={to}
        title={title}
        className={cn(
          'min-w-0 truncate text-[13px]',
          unread ? 'font-semibold text-foreground' : readDone ? 'font-medium text-muted-foreground' : 'font-medium'
        )}
      >
        {title}
      </Link>
      {/* The unread marker — same trailing violet dot as the sidebar row. */}
      {unread ? (
        <StatusDot
          tone="violet"
          role="img"
          aria-label="unread"
          title="Unread — not opened since it finished"
          className="shrink-0"
        />
      ) : null}
      {/* Revealed like the pin (#453 G-21): hover, keyboard focus, and always on a device that
          cannot hover — where it is also the 44 px touch target the pin is. */}
      <button
        type="button"
        data-slot="row-rename"
        aria-label="Rename task"
        onClick={editor.begin}
        className="inline-flex shrink-0 items-center justify-center rounded-sm p-0.5 text-soft-foreground opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none no-hover:min-h-tap no-hover:min-w-tap no-hover:opacity-100"
      >
        <PencilIcon className="size-3" aria-hidden="true" />
      </button>
      {/* The pin (#935), beside the pencil and revealed the same way — except when the row IS
          pinned, where it stays lit: this table has no `Pinned` header, so the filled pin is the
          whole explanation for why the row sorted to the top.

          `no-hover:` covers the device this table still reaches without a pointer: it is hidden
          below `md`, where the cards take over, but a tablet in landscape is ≥md and cannot
          hover, so without it the pin would be invisible AND unreachable there. */}
      {onTogglePin ? (
        <PinToggle
          pinned={Boolean(run.pinned)}
          onToggle={(pinned) => onTogglePin(run, pinned)}
          className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 no-hover:opacity-100 data-[pinned=true]:opacity-100"
        />
      ) : null}
    </span>
  )
}

/**
 * The live CPU/Mem pair, read from the global usage stream (`useRunUsage`, never `run.usage` —
 * the REST snapshot goes stale between refetches; the stream ticks every ~2s). Selected per run,
 * so a tick that says nothing about this run re-renders nothing.
 */
function UsageTds({
  run,
  cpuExpanded,
  memoryExpanded,
}: {
  run: RunRecord
  cpuExpanded: boolean
  memoryExpanded: boolean
}) {
  const sample = useRunUsage(run.id)
  const cells = usageCells(run, sample)
  return (
    <>
      {cpuExpanded ? <UsageTd column="cpu" cell={cells.cpu} /> : <FoldedTd column="cpu" />}
      {memoryExpanded ? <UsageTd column="memory" cell={cells.mem} /> : <FoldedTd column="memory" />}
    </>
  )
}

/** One CPU or Mem cell — the grammar both task tables share (#453 G-17). */
export function UsageTd({
  column,
  cell,
  className,
}: {
  column: 'cpu' | 'memory'
  cell: UsageCell
  className?: string
}) {
  return (
    <td
      data-usage={column === 'memory' ? 'mem' : column}
      data-column-id={column}
      data-usage-kind={cell.kind}
      title={cell.title}
      className={cn(TD_BASE, 'text-right font-mono tabular-nums', USAGE_CELL_CLASS[cell.kind], className)}
    >
      {cell.text || '—'}
    </td>
  )
}

/** One run, one card — the `<md` framing of the same row. */
function TaskCard({
  run,
  queuePosition,
  now,
  showTokens,
  showCost,
  defaultRunner,
  onTogglePin,
}: {
  run: RunRecord
  queuePosition: number | null
  now: number
  showTokens: boolean
  showCost: boolean
  defaultRunner?: Runner
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
}) {
  const navigate = useNavigate()
  const attention = deriveAttention(run)
  const scheduled = scheduledResume(run)
  const to = `/tasks/${run.id}`
  const reference = taskReference(run)
  // Read/unread (#unread-done-items) — the same promote-unread / dim-read treatment as the row.
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)
  const cost = formatCost(run.costUsd)
  const hasDirectionalUsage = run.inputTokens !== undefined || run.outputTokens !== undefined
  // The table is hidden below `md`, so the card's meta line is the ONLY place tool and model can
  // be read on a phone. They sit right after the workflow, in the table's own column order.
  const runner = taskRunner(run.runner, run.steps, defaultRunner)
  // Through the SAME pure rules the desktop cell uses. Spelling `+N` and `auto` out a second time
  // here is what let the card and the table disagree about an empty-string model.
  const tool = runnerLabel(runner.runner, stepBackendCount(run.steps))
  const model = modelLabel(run.model)

  return (
    <div
      data-slot="task-card"
      data-run-id={run.id}
      onClick={(event) => {
        // `button` as well as `a` since the card grew the pin (#935): a control inside the card
        // owns its own click, exactly as the desktop row has always had it.
        if (isOwnClick(event)) navigate(to)
      }}
      className="cursor-pointer rounded-lg border border-border bg-card p-inset shadow-xs"
    >
      <div className="flex items-start gap-2.5">
        <Pill dot={attention.tone} pulse={attention.pulse} className="mt-px shrink-0" title={scheduled?.title}>
          {attention.label}
          {scheduled ? <span className="tabular-nums">{scheduled.label}</span> : null}
        </Pill>
        <Link
          to={to}
          className={cn(CARD_TITLE_CLASS, cardTitleWeight(run))}
        >
          {runTitle(run)}
        </Link>
        {/* The unread marker — trailing violet dot, as on the desktop row. */}
        {unread ? (
          <StatusDot
            tone="violet"
            role="img"
            aria-label="unread"
            title="Unread — not opened since it finished"
            className="mt-1.5 shrink-0"
          />
        ) : null}
        <span className="mt-0.5 shrink-0 text-[11.5px] text-soft-foreground tabular-nums">
          {shortAge(run.finishedAt ?? run.createdAt, now)}
        </span>
        {/* Always visible here, not hover-revealed: a card has no hover to speak of on the
            device it exists for, and it is the only place a pin can be set or seen on mobile. */}
        {/* A 44 px box on the device cards exist for (#453 A-03); the negative margins keep the
            icon where it was and let the box reach into the card's own padding, not the text. */}
        {onTogglePin ? (
          <PinToggle
            pinned={Boolean(run.pinned)}
            onToggle={(pinned) => onTogglePin(run, pinned)}
            className="-mt-2.5 -mr-3"
          />
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[11.5px] font-medium text-muted-foreground tabular-nums">
        <span>{workflowLabel(run)}</span>
        <Sep />
        <span
          data-slot="task-card-tool"
          data-inherited={runner.inherited || undefined}
          className={cn(runner.inherited && 'text-soft-foreground')}
        >
          {tool}
        </span>
        <Sep />
        <span
          data-slot="task-card-model"
          data-inherited={model.auto || undefined}
          className={cn(model.auto && 'text-soft-foreground')}
        >
          {model.text}
        </span>
        {queuePosition !== null ? (
          <>
            <Sep />
            <span data-slot="queue-note">#{queuePosition} in queue</span>
          </>
        ) : (
          <>
            {run.branch ? (
              <>
                <Sep />
                <span>{run.branch}</span>
              </>
            ) : null}
            {/* Branch · ±diff · IN/OUT · cost — the compact card's meta order. */}
            {run.diffStat ? (
              <>
                <Sep />
                <DiffStatLabel stat={run.diffStat} className="text-[11.5px]" />
              </>
            ) : null}
            {showTokens && hasDirectionalUsage ? (
              <>
                <Sep />
                <DirectionalUsage inputTokens={run.inputTokens} outputTokens={run.outputTokens} />
              </>
            ) : null}
            {showCost && cost ? (
              <>
                <Sep />
                <span>{cost}</span>
              </>
            ) : null}
          </>
        )}
        {reference ? (
          <span className={CHIP_SLOT}>
            <TaskReferenceChip run={run} reference={reference} className="h-5" />
          </span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Whether a click on a task row or card is the row's own (#453 T-4): not on a nested control, and
 * not from a portal. A reference card or the `+N` list renders in a portal, and React bubbles its
 * events through the row that owns it even though the DOM does not — so a tap on the empty part
 * of an open popover would otherwise open the task behind it.
 */
export function isOwnClick(event: React.MouseEvent<HTMLElement>, controls = 'a, button'): boolean {
  const target = event.target as Element
  return event.currentTarget.contains(target) && target.closest(controls) === null
}

/**
 * The line a reference chip sits on in a phone card (#453 A-03). The chip keeps its small look
 * and owns a 44 px hit area; this slot makes the line at least that tall, so the hit area never
 * reaches a neighbouring line's controls when the meta line wraps.
 */
export const CHIP_SLOT = 'inline-flex min-h-tap items-center md:min-h-0'

/**
 * A phone card's title link (#453 G-17): at least the 44 px target, reaching `2.5` up into the
 * card's padding so the first line still starts level with the status pill.
 */
export const CARD_TITLE_CLASS = '-mt-2.5 block min-h-tap min-w-0 flex-1 pt-2.5 text-[13.5px] leading-[1.35]'

/** Read/unread weight — promote an unread done item, dim a read one (#unread-done-items). */
export function cardTitleWeight(run: ReadStateInput): string {
  return isUnread(run) ? 'font-semibold text-foreground' : isReadDoneItem(run) ? 'font-medium text-muted-foreground' : 'font-medium'
}

/** An honest em dash: this cell has nothing true to show. */
export function Dash() {
  return <span className="text-xs text-soft-foreground">—</span>
}

export function Sep() {
  return (
    <span className="text-soft-foreground" aria-hidden="true">
      ·
    </span>
  )
}

function BranchChip({ branch }: { branch: string }) {
  return (
    <span className="rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-[11.5px] font-medium text-muted-foreground">
      {branch}
    </span>
  )
}

/**
 * The overview wired to live data: `useRuns()` (kept fresh by the global SSE stream), the shared
 * Active/Archived context (the sidebar's tabs and these are one state), and the archive-finished
 * mutation. The invalidate on success is the authoritative half of the doctrine — the stream will
 * likely have patched each archived run already, but the endpoint's answer is the truth.
 */
export function TasksOverviewRoute() {
  const runs = useRuns()
  const health = useHealth()
  // The project this page is scoped to, not the boot project: `/api/health` describes the latter
  // and would name the wrong runner on a scoped route. Same read as the run header's AgentBadge.
  const config = useConfig()
  const metricVisibility = usageMetricVisibility(health.data)
  const [view, setView] = useListView()
  const queryClient = useQueryClient()
  const archive = useMutation({
    mutationFn: archiveFinished,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })
  // "Mark all read" (#unread-done-items): one call stamps every unread finished run; the
  // invalidate is the authoritative half — each stamped run also rides the `run` SSE.
  const markAllRead = useMutation({
    mutationFn: markAllRunsSeen,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  // The table's inline rename — `usePatchRun` is per-run, so the any-row variant carries the id
  // in its variables. Same endpoint, same invalidation, same danger toast as the run header.
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => patchRun(id, { title }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  // Pinning (#935) — this page is the scoped project's own table, so no explicit project id.
  const pin = usePinRun()
  const now = useNow(30_000)
  const taskTableColumns = useTaskTableColumns()
  // Chip statuses are hydrated HERE rather than inside `TasksOverview`, which is a pure
  // presentational component rendered directly (and without a query client) by its tests. The
  // provider wraps it instead, so the chips deep in the table and the cards read their status
  // from context and nothing in between has to relay it.
  const projectId = useReferenceProjectId()
  const referenceRequests = React.useMemo(
    () =>
      // `taskReference`, singular: this table paints exactly one chip per row (the strongest
      // reference), so asking about the others would be a request for something never shown.
      projectId === undefined
        ? []
        : (runs.data ?? []).flatMap((run) => {
            const reference = taskReference(run)
            return reference ? [{ projectId, kind: reference.kind, number: reference.number }] : []
          }),
    [runs.data, projectId],
  )

  return (
    <ReferenceStatusProvider projectId={projectId} requests={referenceRequests}>
      <TasksOverview
        runs={runs.data}
        view={view}
        onViewChange={setView}
        onArchiveFinished={() => archive.mutate()}
        onMarkAllRead={() => markAllRead.mutate()}
        onRename={(id, title) => rename.mutate({ id, title })}
        onTogglePin={(run, pinned) =>
          pin.mutate(
            { id: run.id, pinned },
            { onError: (error: Error) => toast(error.message, { tone: 'danger' }) },
          )
        }
        now={now}
        showTokens={metricVisibility.tokens}
        showCost={metricVisibility.cost}
        defaultRunner={config.data?.defaultRunner}
        expandedColumns={taskTableColumns.expandedColumns}
        onToggleColumn={taskTableColumns.toggleColumn}
        columnsPending={taskTableColumns.isPending}
      />
    </ReferenceStatusProvider>
  )
}

/**
 * The setup entry on a fresh project (#464 P2) — a quieter second block under the hero's own rule.
 *
 * The ranking is the whole point. The composer below is still the primary path and still focused;
 * this sits under a separator, in muted text, behind an `outline` button, and says setup is
 * optional. Typing a task and sending it must keep working with no setup, no network and no
 * configuration.
 *
 * It renders nothing at all when the entry does not apply — no agent backend, a project that has
 * already been checked, or a check already running — so the hero never offers a dead action.
 */
function SetupAside() {
  const onboarding = useOnboarding()
  const navigate = useNavigate()
  const start = useSetupStart()
  const status = onboarding.data
  if (!status || !status.available) return null
  if (status.state !== 'never' && status.state !== 'unknown') return null

  return (
    <div
      data-slot="tasks-setup-aside"
      className="flex flex-col items-center gap-stack border-t border-border pt-list text-center"
    >
      <p className="text-[13px] leading-relaxed text-muted-foreground">{SETUP_HERO_SENTENCE}</p>
      <Button
        variant="outline"
        data-action="start-setup"
        // `max-md:h-11` is the phone touch target `foundations.md` § 12 asks for. The offer row and
        // the Settings card already carried it; this button sat at 36 px because `CenteredState`
        // actions do (design review of #497, NB-2).
        className="max-md:h-11"
        disabled={start.pending}
        onClick={() => {
          start.mutate('setup', {
            onSuccess: (run) => {
              if ('id' in run) navigate(`/tasks/${run.id}`)
            },
            onError: (error: Error) => toast(error.message, { tone: 'danger' }),
          })
        }}
      >
        <CompassIcon aria-hidden="true" />
        {start.pending ? 'Starting…' : 'Set up this project'}
      </Button>
    </div>
  )
}
