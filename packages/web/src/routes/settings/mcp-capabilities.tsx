import { CircleCheckIcon, CircleXIcon, LockIcon, TriangleAlertIcon } from 'lucide-react'

import type {
  ApiRun,
  ConfigResponse,
  HealthResponse,
  WorkspaceConfigResponse,
} from '@qodeca/xezar-api-client'
import { useConfig, useHealth, useProjects, useRuns, useWorkspaceConfig } from '@/api/queries'
import { Link, useActiveProjectId } from '@/lib/project-router'
import { SettingsField } from './settings-field'

/**
 * Project settings → MCP connection → capabilities and limits (issue #114, Phase 7 of epic #67).
 *
 * What the MCP leader CAN and CANNOT do in THIS project, in the three forms U-M06 requires:
 *  - a usable project function (`available`);
 *  - an unavailable dependency, always with a named reason AND the next legitimate action
 *    (UX-M05) — a person-facing sentence, never raw CLI output, which can name an account;
 *  - a read-only shared constraint: the workspace `resources.*` the semaphore enforces for every
 *    project, and the `composerDefaults` that apply when the leader omits a field.
 *
 * The facts are the ones the leader's own `discover_project` tool (#90,
 * `packages/xezar/src/mcp/tools/discovery.ts`) reads — `/health` capabilities, the repository,
 * the forge, `modelsLocked`, the workspace limits — derived here from the cockpit's existing
 * queries, because the discovery result itself is an MCP tool answer with no HTTP route. The
 * wording mirrors discovery's reasons so a person and the leader are told the same thing.
 *
 * Hard boundaries (U-M06, F-12, F-22, UX-M05):
 *  - AUTHORITY IS NOT CONFIGURABLE HERE. Full project authority includes delete and merge; there
 *    is no role toggle, no permission checklist, and no control of any kind on a capability row.
 *    The only interactive elements in this view are links that open a task with a failing check.
 *  - No global edit control: the shared limits are text, never a link or a field. Changing them
 *    is a person's job in Global settings, and the copy says exactly that.
 *  - A failing quality check stays visible and has no dismiss, accept-exception or override
 *    affordance. Mandatory checks are never weakened, including by approval.
 *  - Only safe effective values: no secret, no account identity (email, organisation, plan), no
 *    other project's name or limits. The step error text is NOT rendered — a check's output can
 *    carry anything.
 */

/** One project capability, in exactly one of the three U-M06 forms. */
export type McpCapability =
  | { id: string; label: string; status: 'available'; detail?: string }
  | { id: string; label: string; status: 'unavailable'; reason: string; next: string }
  | { id: string; label: string; status: 'read-only'; reason: string; next: string }

/** One read-only shared constraint and its effective value. */
export interface SharedConstraint {
  id: string
  label: string
  value: string
}

/** One task whose mandatory quality check is failing right now. */
export interface FailingCheck {
  runId: string
  title: string
  step: string
}

export interface CapabilityFacts {
  health: Pick<HealthResponse, 'repo' | 'checks' | 'forge' | 'capabilities'>
  modelsLocked: boolean
}

const STATUS_TEXT: Record<McpCapability['status'], string> = {
  available: 'Available',
  unavailable: 'Unavailable',
  'read-only': 'Read-only',
}

const RUNNER_CHECKS = new Set(['claude', 'codex', 'opencode', 'pi'])

/** Why the GitHub area is closed, or null when it is open — discovery's classification. */
function githubGap(health: CapabilityFacts['health']): { reason: string; next: string } | null {
  if (!health.repo) {
    return {
      reason: 'This project is not a git repository, so it has no GitHub remote.',
      next: 'A person can run the project from a git clone of a GitHub repository.',
    }
  }
  if (!health.forge) {
    return {
      reason: 'This repository has no GitHub remote.',
      next: 'A person can add a github.com remote to the repository.',
    }
  }
  if (health.forge.available === true) return null
  if (health.forge.available === undefined) {
    return {
      reason: 'GitHub availability has not been checked yet.',
      next: 'Wait a few seconds; this page updates when the check finishes.',
    }
  }
  return {
    reason: 'The GitHub CLI (gh) cannot reach this repository on GitHub.',
    next: 'A person can install gh and run `gh auth login` on this machine.',
  }
}

function available(id: string, label: string, detail?: string): McpCapability {
  return detail ? { id, label, status: 'available', detail } : { id, label, status: 'available' }
}

function gate(id: string, label: string, gap: { reason: string; next: string } | null, detail?: string): McpCapability {
  return gap ? { id, label, status: 'unavailable', ...gap } : available(id, label, detail)
}

const HOSTED = {
  reason: 'This xezar is not running in local mode, so actions on the host machine are refused.',
  next: 'A person can run the cockpit locally on this machine.',
}

const NO_GIT = {
  reason: 'This project is not a git repository, so tasks run in place, one at a time.',
  next: 'A person can run the project from a git repository.',
}

/**
 * The project capabilities, derived from server facts only (§8: never from the presence of a
 * file). Pure, so every one of the three forms can be pinned by a test.
 */
export function deriveProjectCapabilities({ health, modelsLocked }: CapabilityFacts): McpCapability[] {
  const caps = health.capabilities
  const git = health.repo !== null
  const runners = health.checks.filter((check) => RUNNER_CHECKS.has(check.name))
  const noAgent = runners.length > 0 && !runners.some((check) => check.available)
  const github = githubGap(health)

  return [
    gate(
      'create_task',
      'Start, continue and cancel tasks',
      noAgent
        ? {
            reason: 'No coding agent CLI is installed on this machine.',
            next: 'A person can install Claude Code, Codex, OpenCode or pi. The Tools menu shows what xezar found.',
          }
        : null,
    ),
    available(
      'delete_task',
      'Delete a task, its worktree and its branch',
      'Destructive and irreversible. Part of full project authority, with no extra confirmation step.',
    ),
    gate('parallel_variants', 'Run a task as parallel variants', git ? null : NO_GIT),
    gate('worktree_choice', 'Choose a worktree or in-place for a task', git ? null : NO_GIT),
    gate('git_handoff', 'Commit and push a task’s branch', git ? null : NO_GIT),
    gate(
      'github',
      'GitHub issues, pull requests, draft PRs and merging',
      github,
      'Merging is part of full project authority. Every branch, review and check rule still applies.',
    ),
    gate(
      'automations',
      'GitHub automations',
      !caps.automations
        ? {
            reason: 'GitHub automations are off on this xezar.',
            next: 'A person can start xezar with XEZ_AUTOMATIONS=1 to turn them on.',
          }
        : github,
    ),
    gate(
      'inbox',
      'Follow-up inbox',
      caps.followups
        ? null
        : {
            reason: 'The follow-up inbox is off for this workspace.',
            next: 'A person can turn it on in Global settings, or start xezar with XEZ_FOLLOWUPS=1.',
          },
    ),
    modelsLocked
      ? {
          id: 'model_selection',
          label: 'Choose a task model',
          status: 'read-only',
          reason: 'Models are locked: each coding agent uses the model from its own settings.',
          next: 'Only a person can change that, with XEZ_AGENT_MODELS_LOCKED or modelsLocked in xezar’s config.',
        }
      : available('model_selection', 'Choose a task model'),
    gate('open_in_app', 'Open the project or a task in a desktop app', caps.localHandoff ? null : HOSTED),
    gate(
      'agent_config_write',
      'Edit the coding agents’ config files',
      caps.localHandoff
        ? null
        : { ...HOSTED, reason: `${HOSTED.reason} Agent config files can define hooks and commands.` },
    ),
    available('project_settings', 'Change this project’s settings'),
  ]
}

function minutes(value: number): string {
  return value === 1 ? '1 minute' : `${value} minutes`
}

function onOff(value: boolean): string {
  return value ? 'On' : 'Off'
}

/**
 * The read-only shared constraints: the workspace limits the semaphore enforces, and the composer
 * defaults applied when the leader omits a field. `projectMaxParallel` / `projectMemoryLimitMb`
 * are THIS project's own overrides (more specific wins, like the semaphore); no other project's
 * value is ever read.
 */
export function deriveSharedConstraints(
  workspace: WorkspaceConfigResponse,
  project: { maxParallel?: number; memoryLimitMb?: number | null } = {},
): SharedConstraint[] {
  const r = workspace.resources
  const memory =
    typeof project.memoryLimitMb === 'number' && project.memoryLimitMb > 0
      ? `${project.memoryLimitMb} MiB (this project)`
      : r.memoryLimitMb && r.memoryLimitMb > 0
        ? `${r.memoryLimitMb} MiB`
        : 'No limit'
  const autonomous = workspace.composerDefaults.autonomous ?? workspace.composerDefaults.inheritedAutonomous
  const worktree = workspace.composerDefaults.worktree ?? workspace.composerDefaults.inheritedWorktree
  return [
    {
      id: 'max_parallel',
      label: 'Tasks running at once',
      value:
        project.maxParallel !== undefined
          ? `${project.maxParallel} (this project; ${r.maxParallel} across all projects)`
          : `${r.maxParallel} across all projects`,
    },
    { id: 'memory_limit', label: 'Memory per task', value: memory },
    { id: 'monitoring_sessions', label: 'Background monitoring sessions', value: String(r.maxMonitoringSessions) },
    {
      id: 'monitoring_wake',
      label: 'Wake a parked session',
      value: r.monitoringWakeIntervalMinutes === null ? 'Never — a parked session stays parked' : `Every ${minutes(r.monitoringWakeIntervalMinutes)}`,
    },
    { id: 'auto_resume', label: 'Resume after a usage limit', value: onOff(r.autoResumeOnUsageLimit) },
    {
      id: 'idle_timeout',
      label: 'Close an idle session',
      value: r.idleTimeoutMinutes === null ? 'Never' : `After ${minutes(r.idleTimeoutMinutes)}`,
    },
    {
      id: 'default_autonomous',
      label: 'Autonomous, when the leader does not say',
      value: autonomous === 'source-dependent' ? 'Depends on how the task is started' : onOff(autonomous),
    },
    { id: 'default_worktree', label: 'Worktree, when the leader does not say', value: onOff(worktree) },
  ]
}

/** Tasks whose mandatory check step is failing now. Archived tasks are out of view by choice. */
export function failingQualityChecks(runs: readonly Pick<ApiRun, 'id' | 'title' | 'archived' | 'steps'>[]): FailingCheck[] {
  const out: FailingCheck[] = []
  for (const run of runs) {
    if (run.archived) continue
    for (const step of run.steps) {
      if (step.kind === 'check' && step.status === 'failed') out.push({ runId: run.id, title: run.title, step: step.name })
    }
  }
  return out
}

function CapabilityIcon({ status }: { status: McpCapability['status'] }) {
  if (status === 'available') return <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
  if (status === 'read-only') return <LockIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-soft-foreground" />
  return <CircleXIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
}

/** The status in WORDS, beside the icon: colour is never the only carrier (U-M08). */
function StatusText({ children }: { children: string }) {
  return (
    <span
      data-slot="mcp-capability-status"
      className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground"
    >
      {children}
    </span>
  )
}

function CapabilityRow({ capability }: { capability: McpCapability }) {
  return (
    <li
      data-slot="mcp-capability"
      data-capability={capability.id}
      data-status={capability.status}
      className="flex min-w-0 items-start gap-2.5 px-3 py-2.5"
    >
      <CapabilityIcon status={capability.status} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-medium break-words text-foreground">{capability.label}</span>
          <StatusText>{STATUS_TEXT[capability.status]}</StatusText>
        </div>
        {capability.status === 'available' ? (
          capability.detail ? <p className="mt-1 text-[12px] leading-relaxed break-words text-muted-foreground">{capability.detail}</p> : null
        ) : (
          <>
            <p data-slot="mcp-capability-reason" className="mt-1 text-[12px] leading-relaxed break-words text-foreground">
              <span className="font-medium">Why: </span>
              {capability.reason}
            </p>
            <p data-slot="mcp-capability-next" className="mt-0.5 text-[12px] leading-relaxed break-words text-muted-foreground">
              <span className="font-medium text-foreground">Next: </span>
              {capability.next}
            </p>
          </>
        )}
      </div>
    </li>
  )
}

export interface McpCapabilitiesViewProps {
  capabilities: readonly McpCapability[] | null
  /** `null` while unknown — the rows are withheld, never guessed (§13 "Loading"). */
  constraints: readonly SharedConstraint[] | null
  failingChecks: readonly FailingCheck[] | null
  /** A readable error per source that failed; the rest of the view still renders (N-07). */
  errors?: { capabilities?: string; constraints?: string; checks?: string }
}

/**
 * The presentational view. It renders no toggle, checkbox, switch, input or button — the only
 * interactive elements are the "Open task" links for a failing check.
 */
export function McpCapabilitiesView({ capabilities, constraints, failingChecks, errors = {} }: McpCapabilitiesViewProps) {
  return (
    <div data-slot="mcp-capabilities" className="flex min-w-0 flex-col gap-7">
      <SettingsField
        title="What the leader can do"
        hint="Full authority over this project, including deleting tasks and merging. There are no roles or per-action permissions to set."
      >
        {errors.capabilities ? (
          <ReadableError>{errors.capabilities}</ReadableError>
        ) : capabilities === null ? (
          <Pending>Checking what this project supports…</Pending>
        ) : (
          <ul
            data-slot="mcp-capability-list"
            aria-label="Project capabilities"
            className="divide-y divide-border rounded-md border border-border bg-card"
          >
            {capabilities.map((capability) => (
              <CapabilityRow key={capability.id} capability={capability} />
            ))}
          </ul>
        )}
      </SettingsField>

      <SettingsField
        title="Shared limits"
        hint="Read-only. These are shared with every project on this machine. The leader works inside them and cannot change them; a person changes them in Global settings."
      >
        {errors.constraints ? (
          <ReadableError>{errors.constraints}</ReadableError>
        ) : constraints === null ? (
          <Pending>Loading the shared limits…</Pending>
        ) : (
          <dl data-slot="mcp-constraint-list" className="divide-y divide-border rounded-md border border-border bg-card">
            {constraints.map((constraint) => (
              <div
                key={constraint.id}
                data-slot="mcp-constraint"
                data-constraint={constraint.id}
                className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1 px-3 py-2.5"
              >
                <dt className="flex min-w-0 items-center gap-2 text-[13px] text-foreground">
                  <LockIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
                  <span className="break-words">{constraint.label}</span>
                  <StatusText>Read-only</StatusText>
                </dt>
                <dd className="min-w-0 text-[13px] font-medium break-words text-foreground">{constraint.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </SettingsField>

      <SettingsField
        title="Quality checks"
        hint="Mandatory checks always run. A failing check stays visible until the task passes it. It cannot be dismissed, waived or accepted as an exception — not by the leader, and not by approval."
      >
        {/* A polite live region: a check that starts or stops failing is announced without
            stealing focus (U-M08). */}
        <div data-slot="mcp-quality" aria-live="polite" className="min-w-0">
          {errors.checks ? (
            <ReadableError>{errors.checks}</ReadableError>
          ) : failingChecks === null ? (
            <Pending>Checking this project’s tasks…</Pending>
          ) : failingChecks.length === 0 ? (
            <p data-slot="mcp-quality-clear" className="rounded-md border border-border bg-card p-3 text-[13px] text-foreground">
              <span className="font-medium">No failing checks.</span> No open task in this project has a failing quality check right now.
            </p>
          ) : (
            <ul data-slot="mcp-quality-failing" aria-label="Failing quality checks" className="flex flex-col gap-2">
              {failingChecks.map((check) => (
                <li
                  key={`${check.runId}:${check.step}`}
                  data-slot="mcp-quality-failure"
                  className="rounded-md border border-danger/40 bg-card p-3"
                >
                  <p className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-foreground">
                    <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-danger" />
                    <span className="font-semibold">Check failed:</span>
                    <span className="min-w-0 font-mono text-[12px] break-all">{check.step}</span>
                  </p>
                  <p className="mt-1 text-[13px] break-words text-foreground">Task: {check.title}</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                    <span className="font-medium text-foreground">Next: </span>
                    fix the cause in the task and let the check run again. The task is not complete until it passes.
                  </p>
                  <Link
                    to={`/tasks/${check.runId}`}
                    data-slot="mcp-quality-open"
                    className="mt-2 inline-flex rounded-sm text-[12px] font-medium text-foreground underline underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    Open task: {check.title}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsField>
    </div>
  )
}

function Pending({ children }: { children: string }) {
  return (
    <p role="status" className="rounded-md border border-border bg-card p-3 text-[13px] text-soft-foreground">
      {children}
    </p>
  )
}

function ReadableError({ children }: { children: string }) {
  return (
    <p data-slot="mcp-capabilities-error" role="alert" className="rounded-md border border-danger/40 bg-card p-3 text-[13px] break-words text-foreground">
      <span className="font-medium">Could not load this part.</span> {children}
    </p>
  )
}

/** The wired view: the cockpit's existing queries, patched live by the one global stream. */
export function McpCapabilities() {
  const health = useHealth()
  const config = useConfig()
  const workspace = useWorkspaceConfig()
  const projects = useProjects()
  const runs = useRuns()
  const projectId = useActiveProjectId() ?? health.data?.bootProject ?? null
  const entry = projects.data?.projects.find((p) => p.id === projectId)

  const capabilities =
    health.data && config.data
      ? deriveProjectCapabilities({ health: health.data, modelsLocked: config.data.modelsLocked })
      : null
  const constraints = workspace.data
    ? deriveSharedConstraints(workspace.data, {
        ...(entry?.maxParallel !== undefined ? { maxParallel: entry.maxParallel } : {}),
        memoryLimitMb: (config.data as ConfigResponse | undefined)?.memoryLimitMb ?? null,
      })
    : null

  return (
    <McpCapabilitiesView
      capabilities={capabilities}
      constraints={constraints}
      failingChecks={runs.data ? failingQualityChecks(runs.data) : null}
      errors={{
        ...(config.isError ? { capabilities: config.error.message } : health.isError ? { capabilities: health.error.message } : {}),
        ...(workspace.isError ? { constraints: workspace.error.message } : {}),
        ...(runs.isError ? { checks: runs.error.message } : {}),
      }}
    />
  )
}
