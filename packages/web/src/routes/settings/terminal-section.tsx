import { useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { TerminalIcon } from 'lucide-react'

import { putWorkspaceConfig } from '@/api/client'
import { useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { SetWorkspaceConfigInput, WorkspaceConfigResponse } from '@qodeca/xezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { nativeFieldClass } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'
import { SettingsField } from './settings-field'

/**
 * Global settings → Terminal: what xezar does when a person starts it in a terminal (#467, PR 5).
 *
 * Four fields, all stored in the one `cli` object of the workspace config: the instance mode
 * (`cli.instance`, which projects one cockpit serves) and — by the owner's decision D-5 of
 * 2026-09-20 — the three presentation keys beside it (`output`, `color`, `logLevel`). The section
 * exists rather than rows inside Resources because these are START-UP choices, not concurrency
 * limits: burying "which projects does my cockpit open" under memory ceilings is how a setting
 * becomes unfindable.
 *
 * The one thing this pane must not do is claim something that did not happen (design review B-1
 * on PR #798). Every key was settled when this process started, so the copy says what the NEXT
 * start will use and the pane keeps working exactly as it is; "Saved." appears only after a save
 * in this visit; an environment variable is named only when the server says it really decides.
 * And when a narrowing is in force it BEATS the instance mode: `cli.inForce` and `cli.narrowing`
 * are the server's honest answers about this process, and the reason the pane can say so rather
 * than show a stored value that is not what the cockpit is doing (B-2).
 */

type Cli = WorkspaceConfigResponse['cli']
type CliKey = 'instance' | 'output' | 'color' | 'logLevel'

/** A stored value as its select spells it: a value, or "no stored key". */
const NOT_SET = 'inherit'
const NOT_SET_LABEL = 'Not set — use the default'

const INSTANCE_LABELS = {
  workspace: 'One cockpit for every project',
  project: 'One cockpit per project',
} as const
const OUTPUT_LABELS = {
  auto: 'Automatic',
  rich: 'Live panel',
  lines: 'One line per event',
} as const
const COLOR_LABELS = { auto: 'Automatic', always: 'Always', never: 'Never' } as const
/** How the consequence line finishes "The next start will …" for each value. */
const OUTPUT_NEXT = { auto: 'use the automatic choice', rich: 'use the live panel', lines: 'print one line per event' } as const
const COLOR_NEXT = {
  auto: 'print in colour where the terminal can show it',
  always: 'print in colour',
  never: 'print without colour',
} as const
const LOG_LEVEL_LABELS = {
  debug: 'Everything, for debugging',
  info: 'Activity',
  warn: 'Warnings and errors',
  error: 'Errors only',
} as const

/** The variable each key falls back to when nothing is stored — named only when it decides. */
const ENV_NAMES: Record<CliKey, string> = {
  instance: 'XEZ_INSTANCE',
  output: 'XEZ_OUTPUT',
  color: 'XEZ_COLOR',
  logLevel: 'XEZ_LOG_LEVEL',
}

/** The consequence of a choice is the sentence that matters, so it reads at hint size (NB-2). */
const consequenceClass = 'text-[13px] text-muted-foreground'

export function TerminalSection() {
  const config = useWorkspaceConfig()

  if (config.isPending) {
    return (
      <p
        data-slot="terminal-loading"
        className="mx-auto w-full max-w-2xl p-list text-[13px] text-soft-foreground md:p-group"
      >
        Loading terminal settings…
      </p>
    )
  }
  if (config.isError) {
    return (
      <CenteredState
        icon={<TerminalIcon />}
        tone="danger"
        title="Could not load terminal settings"
        subtitle={config.error.message}
        heading="h2"
      />
    )
  }
  return <TerminalForm cli={config.data.cli} />
}

function TerminalForm({ cli }: { cli: Cli }) {
  const queryClient = useQueryClient()
  // Which field this visit saved last — the only thing that may say "Saved.". A failed save
  // clears it, so the reverted value never sits beside a claim that it was stored.
  const [saved, setSaved] = useState<CliKey | null>(null)
  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.config, result),
    onError: (error: Error) => {
      setSaved(null)
      toast(error.message, { tone: 'danger' })
    },
  })

  const write = (key: CliKey, value: string, message: string) =>
    save.mutate(
      // The select only offers the contract's own values, so the cast names a fact, not a hope.
      { cli: { [key]: value === NOT_SET ? null : value } as NonNullable<SetWorkspaceConfigInput['cli']> },
      {
        onSuccess: () => {
          setSaved(key)
          toast(message)
        },
      },
    )

  /** "Saved. " once this visit stored the key, and nothing before it did. */
  const savedPrefix = (key: CliKey) => (saved === key ? 'Saved. ' : '')
  /** " (from XEZ_…)" only when that variable is what decides the next start. */
  const envNote = (key: CliKey, source: string) => (source === 'env' ? ` (from ${ENV_NAMES[key]})` : '')

  return (
    <div
      data-slot="terminal-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-section p-list pb-[calc(90px+env(safe-area-inset-bottom))] md:p-group md:pb-group"
    >
      <SettingsField
        title="Instance mode"
        hint={
          cli.narrowing === 'project-root'
            ? 'Which projects one cockpit serves.'
            : 'Which projects one cockpit serves. One cockpit for every project is the default and opens everything you have registered; one cockpit per project serves the project it was started in, and your other projects appear as links to their own cockpit. Each cockpit applies its own task limit. Not set follows the XEZ_INSTANCE environment variable when it is set.'
        }
      >
        {cli.narrowing === 'project-root' ? (
          // B-2. A folder that owns its state is narrowed again at every start, here and in a
          // clone, so a stored mode could never take effect anywhere. A control with no honest
          // effect is hidden, not left editable (`patterns.md` § 6).
          <p data-slot="terminal-instance-owned" className={consequenceClass}>
            This project has its own settings, so this cockpit always serves one project.
          </p>
        ) : (
          <>
            <select
              aria-label="Instance mode"
              data-slot="terminal-instance"
              value={cli.instance ?? NOT_SET}
              disabled={save.isPending}
              onChange={(event) => {
                const value = event.target.value
                write(
                  'instance',
                  value,
                  value === NOT_SET
                    ? 'Instance mode is no longer set'
                    : value === 'project'
                      ? 'The next xezar started in a project will serve that project only'
                      : 'The next xezar will open every project you have registered',
                )
              }}
              className={cn(nativeFieldClass, 'block w-72')}
            >
              <option value="workspace">{INSTANCE_LABELS.workspace}</option>
              <option value="project">{INSTANCE_LABELS.project}</option>
              <option value={NOT_SET}>{NOT_SET_LABEL}</option>
            </select>
            {cli.inForce === 'narrowed' ? (
              // The line `inForce` exists for, in the one narrowing where it is true: under
              // `XEZ_SINGLE_PROJECT` the value goes to this machine's settings, and a cockpit
              // started elsewhere reads it.
              <p data-slot="terminal-instance-narrowed" className={consequenceClass}>
                {savedPrefix('instance')}This cockpit already serves one project only, so this
                setting does not change what it does here. A choice is kept for the next cockpit
                you start elsewhere.
              </p>
            ) : (
              <p data-slot="terminal-instance-hint" className={consequenceClass}>
                {savedPrefix('instance')}
                {cli.inForce !== cli.effectiveInstance ? (
                  // Advisory Minor 1: a `--instance` flag decided this process, and nothing
                  // stored says so — without this line the pane describes the next start only.
                  <span data-slot="terminal-instance-in-force">
                    This cockpit was started as {INSTANCE_LABELS[cli.inForce].toLowerCase()}.{' '}
                  </span>
                ) : null}
                It applies the next time you start xezar in a project — this cockpit keeps running
                as it is. The next start will use{' '}
                <span data-slot="terminal-instance-effective">
                  {INSTANCE_LABELS[cli.effectiveInstance].toLowerCase()}
                </span>
                {envNote('instance', cli.instanceSource)}.
              </p>
            )}
          </>
        )}
      </SettingsField>

      <PresentationField
        title="Terminal output"
        hint="How xezar prints its activity in the terminal it was started from. Automatic shows the live panel in a wide terminal and one line per event in a narrow one, and prints plain lines when the output is not a terminal. Not set follows the XEZ_OUTPUT environment variable when it is set."
        slot="terminal-output"
        labels={OUTPUT_LABELS}
        stored={cli.output}
        disabled={save.isPending}
        onChange={(value) =>
          write('output', value, value === NOT_SET ? 'Terminal output is no longer set' : 'Terminal output saved')
        }
      >
        {savedPrefix('output')}It applies the next time you start xezar. The next start will{' '}
        {OUTPUT_NEXT[cli.effectiveOutput]}
        {envNote('output', cli.outputSource)}.
      </PresentationField>

      <PresentationField
        title="Colour"
        hint="Whether the terminal activity uses colour. Automatic uses colour only where the terminal can show it. A NO_COLOR environment variable turns colour off whatever is chosen here. Not set follows the XEZ_COLOR environment variable when it is set."
        slot="terminal-color"
        labels={COLOR_LABELS}
        stored={cli.color}
        disabled={save.isPending}
        onChange={(value) => write('color', value, value === NOT_SET ? 'Colour is no longer set' : 'Colour saved')}
      >
        {savedPrefix('color')}It applies the next time you start xezar. The next start will{' '}
        {COLOR_NEXT[cli.effectiveColor]}
        {cli.colorSource === 'no-color' ? ' (NO_COLOR is set)' : envNote('color', cli.colorSource)}.
      </PresentationField>

      <PresentationField
        title="Log level"
        hint="How much the terminal prints. Not set follows the XEZ_LOG_LEVEL environment variable when it is set."
        slot="terminal-log-level"
        labels={LOG_LEVEL_LABELS}
        stored={cli.logLevel}
        disabled={save.isPending}
        onChange={(value) =>
          write('logLevel', value, value === NOT_SET ? 'Log level is no longer set' : 'Log level saved')
        }
      >
        {savedPrefix('logLevel')}It applies the next time you start xezar. The next start will print{' '}
        {LOG_LEVEL_LABELS[cli.effectiveLogLevel].toLowerCase()}
        {envNote('logLevel', cli.logLevelSource)}.
      </PresentationField>
    </div>
  )
}

/** One presentation key: a select of its values plus "Not set", and its consequence line. */
function PresentationField<V extends string>({
  title,
  hint,
  slot,
  labels,
  stored,
  disabled,
  onChange,
  children,
}: {
  title: string
  hint: string
  slot: string
  labels: Record<V, string>
  stored: V | null
  disabled: boolean
  onChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <SettingsField title={title} hint={hint}>
      <select
        aria-label={title}
        data-slot={slot}
        value={stored ?? NOT_SET}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(nativeFieldClass, 'block w-72')}
      >
        {(Object.keys(labels) as V[]).map((value) => (
          <option key={value} value={value}>
            {labels[value]}
          </option>
        ))}
        <option value={NOT_SET}>{NOT_SET_LABEL}</option>
      </select>
      <p data-slot={`${slot}-hint`} className={consequenceClass}>
        {children}
      </p>
    </SettingsField>
  )
}
