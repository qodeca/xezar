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
 * Global settings → Terminal: what `xez` does when a person starts it in a terminal (#467, PR 5).
 *
 * One field today — the instance mode, `cli.instance` in `~/.xezar/config.json` — and the section
 * exists rather than a row inside Resources because this is a START-UP mode, not a concurrency
 * limit: burying "which projects does my cockpit open" under memory ceilings is how a setting
 * becomes unfindable. Its three siblings in the same stored object (`output`, `color`,
 * `logLevel`) are the natural next tenants; they have no write door yet.
 *
 * The one thing this pane must not do is imply a live change. The mode was settled when this
 * process started — the MCP socket was opened, the port was bound and every project context was
 * built under it — so the copy says what happens next instead, and the pane keeps working exactly
 * as it is. And when a narrowing is in force (`XEZ_SINGLE_PROJECT`, or a folder that owns its
 * xezar state), that narrowing BEATS the setting: `cli.inForce` is the server's honest third
 * answer and the reason this pane can say so rather than showing a stored value that is not what
 * the cockpit is doing.
 */

/** The stored tri-state as the select spells it: a mode, or "no stored key". */
type InstanceChoice = 'workspace' | 'project' | 'inherit'

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
  return <TerminalForm config={config.data} />
}

function TerminalForm({ config }: { config: WorkspaceConfigResponse }) {
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  // A server that predates this key answers without `cli`; reading that as `workspace` is the
  // same answer its absence has always meant, and it keeps this pane from crashing on one.
  const cli = config.cli ?? { instance: null, effectiveInstance: 'workspace' as const, inForce: 'workspace' as const }
  const choice: InstanceChoice = cli.instance ?? 'inherit'
  const narrowed = cli.inForce === 'narrowed'

  const saveInstance = (value: InstanceChoice) =>
    save.mutate(
      { cli: { instance: value === 'inherit' ? null : value } },
      {
        onSuccess: () =>
          toast(
            value === 'inherit'
              ? 'Instance mode follows the XEZ_INSTANCE environment variable again'
              : value === 'project'
                ? 'The next xez started in a project will serve that project only'
                : 'The next xez will open every project you have registered',
          ),
      },
    )

  return (
    <div
      data-slot="terminal-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-section p-list pb-[calc(90px+env(safe-area-inset-bottom))] md:p-group md:pb-group"
    >
      <SettingsField
        title="Instance mode"
        hint="Which projects one xezar serves. One cockpit for every project is the default and opens everything you have registered; one cockpit per project serves the project it was started in, and your other projects appear as links to their own cockpit."
      >
        <select
          aria-label="Instance mode"
          data-slot="terminal-instance"
          value={choice}
          disabled={save.isPending}
          onChange={(event) => saveInstance(event.target.value as InstanceChoice)}
          className={cn(nativeFieldClass, 'block w-72')}
        >
          <option value="workspace">One cockpit for every project</option>
          <option value="project">One cockpit per project</option>
          <option value="inherit">Follow XEZ_INSTANCE</option>
        </select>
        {narrowed ? (
          // The line `inForce` exists for. Showing the stored value here would be a true sentence
          // about the file and a false one about this cockpit.
          <p data-slot="terminal-instance-narrowed" className="text-[11px] text-soft-foreground">
            This cockpit already serves one project only, so this setting does not change what it
            does here. It is saved for the next xez you start elsewhere.
          </p>
        ) : (
          <p data-slot="terminal-instance-hint" className="text-[11px] text-soft-foreground">
            Saved. It applies the next time you start xezar in a project — this cockpit keeps
            running as it is. The next start will use{' '}
            <span data-slot="terminal-instance-effective">
              {cli.effectiveInstance === 'project'
                ? 'one cockpit per project'
                : 'one cockpit for every project'}
            </span>
            {cli.instance === null ? ' (from the environment)' : ''}.
          </p>
        )}
      </SettingsField>
    </div>
  )
}
