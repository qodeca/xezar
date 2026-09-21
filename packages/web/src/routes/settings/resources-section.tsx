import { useMutation, useQueryClient } from '@tanstack/react-query'
import { GaugeIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { putWorkspaceConfig } from '@/api/client'
import { useHealth, useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { SetWorkspaceConfigInput, WorkspaceConfigResponse } from '@qodeca/xezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { nativeFieldClass } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { inSingleProjectRoot } from '@/lib/project-mode'
import { cn } from '@/lib/utils'
import { SettingsField } from './settings-field'

/**
 * Global settings → Resources: how hard the MACHINE works. `maxParallel` caps concurrent tasks
 * across every project (the workspace semaphore holds the rest); `memoryLimitMb` is the
 * per-task ceiling the engine enforces by pausing a task that crosses it and letting the queue
 * advance (#memory-guard). `gateSlots` is the third of that kind (#672 G4): how many full gate
 * runs the machine-wide gate lease admits at once, read fresh by `xezar lease gates` on every
 * gate run rather than cached in this process, so it needs no restart and no semaphore refresh.
 *
 * All three are workspace-level since the multi-project split (spec §"Resource governance"): they
 * protect the host, not a repo, so they live in `~/.xezar/config.json` and persist through
 * `PUT /api/workspace/config` — the merged answer lands straight in the workspace config query,
 * and the server refreshes the shared semaphore so a change takes effect without a restart.
 * Leftover per-repo `maxParallel`/`memoryLimitMb` keys were imported once by Migration 001, and
 * this section deliberately no longer writes them. The per-repo `memoryLimitMb` is enforced again
 * since B2, as a project's own override: Project settings → General writes it (#677 C1).
 *
 * Worktree retention stayed behind in the PROJECT settings (worktrees-section.tsx) — it sizes
 * one repo's own worktree pool, which is a property of the repo.
 */

const MAX_PARALLEL_MIN = 1
const MAX_PARALLEL_MAX = 16
const MAX_MONITORING_MAX = 16
const WAKE_INTERVAL_MIN = 1
const WAKE_INTERVAL_MAX = 60
/** Below this a limit would pause almost any real agent immediately — reject it as a footgun. */
export const MEMORY_MIN_MB = 256
/** Idle-timeout bounds, mirroring the workspace schema so an invalid draft is a disabled Save
 *  rather than a 400 round-trip. */
const IDLE_TIMEOUT_MIN = 1
const IDLE_TIMEOUT_MAX = 1440
/** Workspace worktree-retention default bounds (#483), same rule. */
const RETENTION_MIN = 0
const RETENTION_MAX = 1000
/** Gate-slot bounds, mirroring `setWorkspaceConfigInputSchema.resources.gateSlots` (#672 G4). */
const GATE_SLOTS_MIN = 1
const GATE_SLOTS_MAX = 16
/** What an ABSENT `gateSlots` derives — `DEFAULT_GATE_SLOTS` on the server. Named here only to
 *  write the hint; the response always reports the EFFECTIVE number, so the field never has to
 *  guess it. */
const GATE_SLOTS_DEFAULT = 1
/** Env-var NAMES only — the value never comes near this file. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENV_PASSTHROUGH_MAX = 64

export function ResourcesSection() {
  const config = useWorkspaceConfig()

  if (config.isPending) {
    return (
      <p data-slot="resources-loading" className="mx-auto w-full max-w-2xl p-list text-[13px] text-soft-foreground md:p-group">
        Loading resource settings…
      </p>
    )
  }
  if (config.isError) {
    return (
      <CenteredState
        icon={<GaugeIcon />}
        tone="danger"
        title="Could not load resource settings"
        subtitle={config.error.message}
        heading="h2"
      />
    )
  }
  return <ResourcesForm config={config.data} />
}

function ResourcesForm({ config }: { config: WorkspaceConfigResponse }) {
  const queryClient = useQueryClient()
  // Single-project mode (#600): there is one project, so "across every project" would be false.
  const projectRoot = inSingleProjectRoot(useHealth().data?.capabilities)

  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  // Memory edits locally and saves explicitly — an empty field means "no limit".
  const [memory, setMemory] = useState(
    config.resources.memoryLimitMb ? String(config.resources.memoryLimitMb) : '',
  )
  const configuredWake = config.resources.monitoringWakeIntervalMinutes ?? null
  const [wakeMode, setWakeMode] = useState<'park' | 'interval'>(configuredWake === null ? 'park' : 'interval')
  const [wakeInterval, setWakeInterval] = useState(String(configuredWake ?? 5))
  const wakeNum = Number(wakeInterval)
  const wakeInvalid = !Number.isInteger(wakeNum) || wakeNum < WAKE_INTERVAL_MIN || wakeNum > WAKE_INTERVAL_MAX
  const wakeSaved = wakeMode === 'park'
    ? configuredWake === null
    : !wakeInvalid && configuredWake === wakeNum
  const saveWake = () => save.mutate(
    { resources: { monitoringWakeIntervalMinutes: wakeMode === 'park' ? null : wakeNum } },
    { onSuccess: () => toast(wakeMode === 'park' ? 'Monitoring will stay parked' : `Monitoring will re-check every ${wakeNum} minutes`) },
  )
  // Shipped ON: a server that predates the key answers without it, and reading that as "off"
  // would silently disable the feature on the one client that cannot tell the difference.
  const autoResume = config.resources.autoResumeOnUsageLimit ?? true
  const saveAutoResume = (on: boolean) => save.mutate(
    { resources: { autoResumeOnUsageLimit: on } },
    {
      onSuccess: () => toast(
        on
          ? 'Tasks stopped by a usage limit will resume themselves'
          : 'Tasks stopped by a usage limit will stay failed',
      ),
    },
  )
  // A — the idle wall clock. Two modes, like the monitoring wake control above: a duration,
  // or "never" (`null`). The default is 15 minutes and has not moved.
  const configuredIdle = config.resources.idleTimeoutMinutes ?? null
  const [idleMode, setIdleMode] = useState<'never' | 'timeout'>(configuredIdle === null ? 'never' : 'timeout')
  const [idleMinutes, setIdleMinutes] = useState(String(configuredIdle ?? 15))
  const idleNum = Number(idleMinutes)
  const idleInvalid = !Number.isInteger(idleNum) || idleNum < IDLE_TIMEOUT_MIN || idleNum > IDLE_TIMEOUT_MAX
  const idleSaved =
    idleMode === 'never' ? configuredIdle === null : !idleInvalid && configuredIdle === idleNum
  const saveIdle = () =>
    save.mutate(
      { resources: { idleTimeoutMinutes: idleMode === 'never' ? null : idleNum } },
      {
        onSuccess: () =>
          toast(
            idleMode === 'never'
              ? 'Waiting tasks will stay open until you close them'
              : `Waiting tasks close after ${idleNum} minutes`,
          ),
      },
    )

  // E — the workspace worktree-retention default. Honoured by `resolveWorktreeRetention` and
  // accepted by this route since #483, but until now it had no control anywhere.
  const [retention, setRetention] = useState(String(config.resources.worktreeRetentionDefault))
  const retentionNum = Number(retention)
  const retentionInvalid =
    retention.trim() === '' ||
    !Number.isInteger(retentionNum) ||
    retentionNum < RETENTION_MIN ||
    retentionNum > RETENTION_MAX
  const retentionSaved = config.resources.worktreeRetentionDefault === (retentionInvalid ? -1 : retentionNum)
  const saveRetention = () =>
    save.mutate(
      { resources: { worktreeRetentionDefault: retentionNum } },
      {
        onSuccess: () =>
          toast(
            retentionNum === 0
              ? 'New projects keep every finished worktree'
              : `New projects keep the last ${retentionNum} finished worktrees`,
          ),
      },
    )

  // F — the Inbox switch, previously `XEZ_FOLLOWUPS=1` at boot only.
  const saveFollowups = (value: boolean | null) =>
    save.mutate(
      { followups: value },
      {
        onSuccess: () =>
          toast(
            value === null
              ? 'Inbox follows the XEZ_FOLLOWUPS environment variable again'
              : value
                ? 'Inbox on'
                : 'Inbox off',
          ),
      },
    )

  // F — the agent env passthrough list, previously `XEZ_ENV_PASSTHROUGH=A,B,C` at boot only.
  const storedPassthrough = config.agentEnvPassthrough
  const [passthrough, setPassthrough] = useState((storedPassthrough ?? []).join(', '))
  const passthroughNames = passthrough
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  const passthroughInvalid =
    passthroughNames.length > ENV_PASSTHROUGH_MAX || passthroughNames.some((name) => !ENV_NAME_RE.test(name))
  const passthroughSaved =
    !passthroughInvalid &&
    storedPassthrough !== null &&
    storedPassthrough.join(',') === passthroughNames.join(',')
  const savePassthrough = () =>
    save.mutate(
      { agentEnvPassthrough: passthroughNames },
      {
        onSuccess: () =>
          toast(
            passthroughNames.length === 0
              ? 'Agents get no extra variables'
              : `Agents also get ${passthroughNames.join(', ')}`,
          ),
      },
    )
  const clearPassthrough = () =>
    save.mutate(
      { agentEnvPassthrough: null },
      {
        onSuccess: () => {
          setPassthrough('')
          toast('Passthrough follows the XEZ_ENV_PASSTHROUGH environment variable again')
        },
      },
    )

  const memoryNum = memory.trim() === '' ? 0 : Number(memory)
  const memoryInvalid =
    memory.trim() !== '' && (!Number.isInteger(memoryNum) || memoryNum < MEMORY_MIN_MB)
  const memorySaved = (config.resources.memoryLimitMb ?? 0) === (memoryInvalid ? -1 : memoryNum)
  const saveMemory = () =>
    save.mutate(
      // 0, not null: the workspace schema's "no limit" IS 0 (`memoryLimitMb: null` is also
      // accepted, but the route's nullable field means "clear", and clearing to the default
      // would be a different value than the user asked for).
      { resources: { memoryLimitMb: memoryNum === 0 ? null : memoryNum } },
      {
        onSuccess: () =>
          toast(memoryNum === 0 ? 'Memory limit cleared' : `Memory limit set to ${memoryNum} MiB`),
      },
    )
  // G4 — the machine-wide gate-slot count (#672). Edits locally and saves explicitly, like the
  // memory field above, and for the same reason: a number input that saved on every keystroke
  // would write a partial number.
  //
  // The response reports the EFFECTIVE count and never "stored or null" (there is no `null`
  // spelling on disk and an absent key derives 1), so the field starts at whatever is in force
  // and an emptied field means "clear the stored key" rather than "no limit". After a clear the
  // field stays empty until the pane is re-read, which then shows the derived 1 — the same
  // number, which is what makes losing the distinction harmless here. One consequence of not
  // seeing the stored state: Save stays enabled on an emptied field even when nothing is stored,
  // so clearing twice writes the same delete twice. That is the harmless direction — the
  // alternative, disabling Save whenever the effective count is 1, would make an explicitly
  // stored `1` impossible to clear.
  const [gateSlots, setGateSlots] = useState(String(config.resources.gateSlots))
  const gateSlotsCleared = gateSlots.trim() === ''
  const gateSlotsNum = Number(gateSlots)
  const gateSlotsInvalid =
    !gateSlotsCleared &&
    (!Number.isInteger(gateSlotsNum) || gateSlotsNum < GATE_SLOTS_MIN || gateSlotsNum > GATE_SLOTS_MAX)
  const gateSlotsSaved =
    !gateSlotsInvalid && !gateSlotsCleared && config.resources.gateSlots === gateSlotsNum
  const saveGateSlots = () =>
    save.mutate(
      // `null`, never `0`: the contract's 1–16 bound refuses 0, and `null` is the one spelling
      // that DELETES the key so the derived default applies again (#672 G4).
      { resources: { gateSlots: gateSlotsCleared ? null : gateSlotsNum } },
      {
        onSuccess: () =>
          toast(
            gateSlotsCleared
              ? `Gate slots back to the default — ${GATE_SLOTS_DEFAULT} gate run at a time`
              : gateSlotsNum === 1
                ? 'One gate run at a time on this machine'
                : `Up to ${gateSlotsNum} gate runs at a time on this machine`,
          ),
      },
    )

  const composerDefaults = config.composerDefaults ?? {
    autonomous: null,
    worktree: null,
    inheritedAutonomous: 'source-dependent' as const,
    inheritedWorktree: true,
  }
  const saveComposerDefault = (
    key: 'autonomous' | 'worktree',
    value: string,
  ) => save.mutate({
    composerDefaults: { [key]: value === 'inherit' ? null : value === 'on' },
  })

  return (
    <div
      data-slot="resources-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-section p-list pb-[calc(90px+env(safe-area-inset-bottom))] md:p-group md:pb-group"
    >
      <SettingsField
        title="Max parallel tasks"
        hint={`How many tasks run at once ${projectRoot ? 'in this project' : 'across every project'}. The rest wait in the queue. A non-git directory always runs one at a time.`}
      >
        <select
          aria-label="Max parallel tasks"
          data-slot="resources-max-parallel"
          value={config.resources.maxParallel}
          disabled={save.isPending}
          onChange={(event) => save.mutate({ resources: { maxParallel: Number(event.target.value) } })}
          className={cn(nativeFieldClass, 'block w-28')}
        >
          {Array.from({ length: MAX_PARALLEL_MAX - MAX_PARALLEL_MIN + 1 }, (_, i) => i + MAX_PARALLEL_MIN).map(
            (n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ),
          )}
        </select>
        {/* `/settings/global/projects` is not routed in single-project mode (a page-not-found), and
            there is no second project to limit differently — so the link is absent, not dead
            (#600, a #611 review follow-up; whether that page should explain the mode is OD-1). */}
        {projectRoot ? null : (
          <p className="text-[11px] text-soft-foreground">
            Need a different limit for one project?{' '}
            <Link
              to="/settings/global/projects"
              data-slot="resources-project-limits-link"
              className="inline-flex min-h-tap items-center font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground md:min-h-0"
            >
              Configure per-project limits
            </Link>
            .
          </p>
        )}
      </SettingsField>

      <SettingsField
        title="Extra monitoring sessions"
        hint="How many agent sessions may wait on CI, sub-agents, or monitored commands without using an active task slot. Extra sessions stay alive but pause the queue."
      >
        <select
          aria-label="Extra monitoring sessions"
          data-slot="resources-max-monitoring"
          value={config.resources.maxMonitoringSessions ?? 2}
          disabled={save.isPending}
          onChange={(event) => save.mutate({ resources: { maxMonitoringSessions: Number(event.target.value) } })}
          className={cn(nativeFieldClass, 'block w-28')}
        >
          {Array.from({ length: MAX_MONITORING_MAX + 1 }, (_, n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <p className="text-[11px] text-soft-foreground">
          Capacity: {config.resources.maxParallel} active + {config.resources.maxMonitoringSessions ?? 2} monitoring. Set 0 to make monitoring share active slots.
        </p>
      </SettingsField>

      <SettingsField
        title="Monitoring wake-up"
        hint="Park uses no model turns. Re-check sends the same agent a follow-up on this cadence until work completes or the 40-wakeup safety cap is reached."
      >
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Monitoring wake-up"
            data-slot="resources-monitoring-wake-mode"
            value={wakeMode}
            disabled={save.isPending}
            onChange={(event) => setWakeMode(event.target.value as 'park' | 'interval')}
            className={cn(nativeFieldClass, 'w-auto')}
          >
            <option value="park">Park until resumed</option>
            <option value="interval">Re-check on an interval</option>
          </select>
          {wakeMode === 'interval' ? (
            <>
              <input
                type="number"
                min={WAKE_INTERVAL_MIN}
                max={WAKE_INTERVAL_MAX}
                aria-label="Wake interval in minutes"
                data-slot="resources-monitoring-wake-interval"
                value={wakeInterval}
                disabled={save.isPending}
                onChange={(event) => setWakeInterval(event.target.value)}
                className={cn(nativeFieldClass, 'block w-24')}
              />
              <span className="text-xs text-soft-foreground">minutes</span>
            </>
          ) : null}
          <Button type="button" variant="outline" size="sm" data-action="resources-save-monitoring-wake" disabled={wakeSaved || (wakeMode === 'interval' && wakeInvalid) || save.isPending} onClick={saveWake}>Save</Button>
        </div>
        {wakeMode === 'interval' && wakeInvalid ? (
          <p data-slot="resources-monitoring-wake-invalid" className="text-[11px] text-danger">Enter a whole number from 1 to 60 minutes.</p>
        ) : (
          <p className="text-[11px] text-soft-foreground">Applied consistently to Claude, Codex and OpenCode.</p>
        )}
      </SettingsField>

      <SettingsField
        title="Auto-resume after a usage limit"
        hint="When an agent stops because its provider usage limit is reached, xezar waits for the reset the provider named and continues the task 30 seconds later — up to 12 times in a row without you. Off leaves the task failed with its Continue button."
      >
        <select
          aria-label="Auto-resume after a usage limit"
          data-slot="resources-auto-resume"
          value={autoResume ? 'on' : 'off'}
          disabled={save.isPending}
          onChange={(event) => saveAutoResume(event.target.value === 'on')}
          className={cn(nativeFieldClass, 'block w-28')}
        >
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
        <p className="text-[11px] text-soft-foreground">
          Applies to Claude, Codex and OpenCode — whenever the provider says when the limit lifts.
        </p>
      </SettingsField>

      <SettingsField
        title="Waiting tasks close after"
        hint="A task that finishes a turn and waits for you keeps its agent session open. When nothing arrives for this long, xezar closes the session; the task stays where it is and Continue picks it back up."
      >
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Idle session behaviour"
            data-slot="resources-idle-mode"
            value={idleMode}
            disabled={save.isPending}
            onChange={(event) => setIdleMode(event.target.value as 'never' | 'timeout')}
            className={cn(nativeFieldClass, 'block w-40')}
          >
            <option value="timeout">Close after</option>
            <option value="never">Never close</option>
          </select>
          {idleMode === 'timeout' ? (
            <>
              <input
                type="number"
                inputMode="numeric"
                min={IDLE_TIMEOUT_MIN}
                max={IDLE_TIMEOUT_MAX}
                step={5}
                aria-label="Idle timeout in minutes"
                data-slot="resources-idle-timeout"
                value={idleMinutes}
                disabled={save.isPending}
                onChange={(event) => setIdleMinutes(event.target.value)}
                className={cn(nativeFieldClass, 'block w-32')}
              />
              <span className="text-xs text-soft-foreground">minutes</span>
            </>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="resources-save-idle-timeout"
            disabled={idleSaved || (idleMode === 'timeout' && idleInvalid) || save.isPending}
            onClick={saveIdle}
          >
            Save
          </Button>
        </div>
        {idleMode === 'timeout' && idleInvalid ? (
          <p data-slot="resources-idle-invalid" className="text-[11px] text-danger">
            Enter a whole number of minutes from {IDLE_TIMEOUT_MIN} to {IDLE_TIMEOUT_MAX}.
          </p>
        ) : idleMode === 'never' ? (
          <p data-slot="resources-idle-never-warning" className="text-[11px] text-conflict">
            Nothing will reclaim these sessions. A waiting task holds no parallel-task slot, so
            your queue keeps moving, but its agent process stays alive and keeps using memory
            until you send it a message or cancel it. Default: 15 minutes.
          </p>
        ) : (
          <p className="text-[11px] text-soft-foreground">
            Default: 15 minutes. Raise it if your tasks do long stretches of work between turns.
          </p>
        )}
      </SettingsField>

      <SettingsField
        title="Per-task memory limit"
        hint="When a task’s whole process tree crosses this, the engine pauses it with a warning and starts the next queued task. Leave empty for no limit."
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={MEMORY_MIN_MB}
            step={256}
            aria-label="Per-task memory limit in MiB"
            data-slot="resources-memory-limit"
            value={memory}
            disabled={save.isPending}
            placeholder="no limit"
            onChange={(event) => setMemory(event.target.value)}
            className={cn(nativeFieldClass, 'block w-32')}
          />
          <span className="text-xs text-soft-foreground">MiB</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="resources-save-memory"
            disabled={memorySaved || memoryInvalid || save.isPending}
            onClick={saveMemory}
          >
            Save
          </Button>
        </div>
        {memoryInvalid ? (
          <p data-slot="resources-memory-invalid" className="text-[11px] text-danger">
            Enter a whole number of at least {MEMORY_MIN_MB} MiB, or leave empty for no limit.
          </p>
        ) : (
          <p className="text-[11px] text-soft-foreground">
            A change applies straight away, to running tasks too. This machine's default is{' '}
            <span data-slot="resources-memory-default">{config.resources.memoryLimitDefaultMb}</span> MiB,
            sized from its total memory. A project can set its own in its settings, under General
            → Per-task memory limit.
          </p>
        )}
      </SettingsField>

      <SettingsField
        title="Gate slots"
        hint="How many full check runs (gates) may work at once on this machine. A gate run that finds every slot taken waits for one instead of starting and competing with the others. Leave empty for the default."
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={GATE_SLOTS_MIN}
            max={GATE_SLOTS_MAX}
            step={1}
            aria-label="Gate slots"
            data-slot="resources-gate-slots"
            value={gateSlots}
            disabled={save.isPending}
            placeholder={String(GATE_SLOTS_DEFAULT)}
            onChange={(event) => setGateSlots(event.target.value)}
            className={cn(nativeFieldClass, 'block w-32')}
          />
          <span className="text-xs text-soft-foreground">
            {gateSlotsNum === 1 && !gateSlotsCleared ? 'gate run' : 'gate runs'}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="resources-save-gate-slots"
            disabled={gateSlotsSaved || gateSlotsInvalid || save.isPending}
            onClick={saveGateSlots}
          >
            Save
          </Button>
        </div>
        {gateSlotsInvalid ? (
          <p data-slot="resources-gate-slots-invalid" className="text-[11px] text-danger">
            Enter a whole number from {GATE_SLOTS_MIN} to {GATE_SLOTS_MAX}, or leave empty for the
            default.
          </p>
        ) : (
          <p className="text-[11px] text-soft-foreground">
            Default {GATE_SLOTS_DEFAULT}: one full gate run at a time on this machine; a second
            waits. Raising it is what made four or five concurrent runs fail nine times in ten, so
            raise it only on a machine that can take it; {GATE_SLOTS_MAX} effectively never binds.
            A change applies to the next gate run, with no restart — a run already waiting keeps
            the count it started with.
          </p>
        )}
      </SettingsField>

      <SettingsField
        title="Keep last N worktrees, by default"
        hint="What a NEW project keeps on disk when it has not chosen for itself. Each project can override this in its own Worktrees settings; 0 = unlimited."
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={RETENTION_MIN}
            max={RETENTION_MAX}
            step={1}
            aria-label="Default worktrees kept per project"
            data-slot="resources-worktree-retention-default"
            value={retention}
            disabled={save.isPending}
            onChange={(event) => setRetention(event.target.value)}
            className={cn(nativeFieldClass, 'block w-32')}
          />
          <span className="text-xs text-soft-foreground">worktrees</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="resources-save-retention-default"
            disabled={retentionSaved || retentionInvalid || save.isPending}
            onClick={saveRetention}
          >
            Save
          </Button>
        </div>
        {retentionInvalid ? (
          <p data-slot="resources-retention-default-invalid" className="text-[11px] text-danger">
            Enter a whole number from {RETENTION_MIN} to {RETENTION_MAX} (0 = unlimited).
          </p>
        ) : (
          <p className="text-[11px] text-soft-foreground">
            A project that already set its own keep-limit is not affected.
          </p>
        )}
      </SettingsField>

      <SettingsField
        title="Follow-up Inbox"
        hint="When on, agents are asked to leave follow-ups when they finish and the Inbox view appears. Each task’s own Notes journal runs either way."
      >
        <select
          aria-label="Follow-up Inbox"
          data-slot="resources-followups"
          value={config.followups === null ? 'inherit' : config.followups ? 'on' : 'off'}
          disabled={save.isPending}
          onChange={(event) =>
            saveFollowups(event.target.value === 'inherit' ? null : event.target.value === 'on')
          }
          className={cn(nativeFieldClass, 'block w-40')}
        >
          <option value="on">On</option>
          <option value="off">Off</option>
          <option value="inherit">Follow XEZ_FOLLOWUPS</option>
        </select>
        <p className="text-[11px] text-soft-foreground">
          Currently {config.effectiveFollowups ? 'on' : 'off'}
          {config.followups === null ? ' (from the environment)' : ''}. Takes effect for the next
          task with no restart; already-open cockpit tabs pick up live Inbox updates after a
          refresh.
        </p>
      </SettingsField>

      <SettingsField
        title="Extra variables agents receive"
        hint="Agents get a least-privilege environment by default — safe shell and toolchain variables, the backend’s own auth, GITHUB_TOKEN and xezar’s own. Name any others here, comma-separated."
      >
        <div className="flex flex-col gap-2">
          <input
            type="text"
            aria-label="Extra environment variable names for agents"
            data-slot="resources-env-passthrough"
            value={passthrough}
            disabled={save.isPending}
            placeholder="VITEST_MAX_WORKERS, MY_TOOL_DIR"
            onChange={(event) => setPassthrough(event.target.value)}
            className={cn(nativeFieldClass, 'block font-mono')}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-action="resources-save-env-passthrough"
              disabled={passthroughSaved || passthroughInvalid || save.isPending}
              onClick={savePassthrough}
            >
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-action="resources-clear-env-passthrough"
              disabled={config.agentEnvPassthrough === null || save.isPending}
              onClick={clearPassthrough}
            >
              Follow XEZ_ENV_PASSTHROUGH
            </Button>
          </div>
        </div>
        {passthroughInvalid ? (
          <p data-slot="resources-env-passthrough-invalid" className="text-[11px] text-danger">
            Use variable NAMES only (letters, digits and underscores), at most {ENV_PASSTHROUGH_MAX}
            {' '}of them — never their values.
          </p>
        ) : (
          <p className="text-[11px] text-soft-foreground">
            Names only — the values come from this machine's environment and are never stored
            here. Currently forwarding:{' '}
            <span data-slot="resources-env-passthrough-effective">
              {config.effectiveAgentEnvPassthrough.length > 0
                ? config.effectiveAgentEnvPassthrough.join(', ')
                : 'nothing extra'}
            </span>
            {config.agentEnvPassthrough === null ? ' (from the environment)' : ''}. Applies to the
            next task, with no restart.
          </p>
        )}
      </SettingsField>

      <SettingsField
        title="New task defaults"
        hint="Set stable composer defaults across projects. Explicit choices and run-shape constraints still win."
      >
        <div className="grid gap-4 sm:grid-cols-2" data-slot="resources-composer-defaults">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Autonomous by default</span>
            <select
              aria-label="Autonomous by default"
              value={composerDefaults.autonomous === null ? 'inherit' : composerDefaults.autonomous ? 'on' : 'off'}
              disabled={save.isPending}
              onChange={(event) => saveComposerDefault('autonomous', event.target.value)}
              className={nativeFieldClass}
            >
              <option value="inherit">Inherit environment</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
            <span className="text-[11px] text-soft-foreground">
              Inherited: {composerDefaults.inheritedAutonomous === 'source-dependent'
                ? 'Source-dependent — skills on, workflows off'
                : composerDefaults.inheritedAutonomous ? 'On' : 'Off'}
            </span>
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Use a worktree by default</span>
            <select
              aria-label="Use a worktree by default"
              value={composerDefaults.worktree === null ? 'inherit' : composerDefaults.worktree ? 'on' : 'off'}
              disabled={save.isPending}
              onChange={(event) => saveComposerDefault('worktree', event.target.value)}
              className={nativeFieldClass}
            >
              <option value="inherit">Inherit environment</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
            <span className="text-[11px] text-soft-foreground">
              Inherited: {composerDefaults.inheritedWorktree ? 'On' : 'Off'}
            </span>
          </label>
        </div>
        <p className="text-[11px] text-soft-foreground">
          Interactive skills may recommend both off. Multi-step and parallel runs remain isolated.
        </p>
      </SettingsField>
    </div>
  )
}
