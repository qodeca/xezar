import { useState } from 'react'

import { useImportGlobalAccounts } from '@/api/queries'
import type { AgentAccountsGlobalImport } from '@qodeca/xezar-api-client'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { AGENT_ACCOUNTS_FILE } from './registry'

/**
 * Whether this project took the accounts of the person's machine-wide xezar setup, and the
 * person-only way to take them now (#819 PR 9, designs/agent-accounts-onboarding § 7, import.html).
 *
 * Single-project mode only, and only when the server SENT `globalImport` — the pane renders nothing
 * for an absent key, which is how the global layout, hosted mode and an older engine all look. A
 * card for the first offer; one line after an answer; a button only when there is something to copy
 * (never "Copy 0 accounts"). The button runs the same merge as `xezar accounts import-global`; it is
 * the only trigger on this page, and nothing here copies on load.
 */
export function AccountsImportBlock({ globalImport }: { globalImport: AgentAccountsGlobalImport }) {
  const copy = useImportGlobalAccounts()
  // What the polite announcer reads after a copy — the new state line, not the first render.
  const [announced, setAnnounced] = useState('')
  const n = globalImport.importable
  const copyLabel = n === 1 ? 'Copy 1 account' : `Copy ${n} accounts`
  const file = <code className="font-mono text-[12px] break-all">{AGENT_ACCOUNTS_FILE}</code>

  const button =
    n > 0 ? (
      <Button
        type="button"
        size="sm"
        data-action="accounts-import"
        disabled={copy.isPending}
        className="w-full md:w-auto"
        onClick={() =>
          copy.mutate(undefined, {
            onSuccess: (result) => {
              const copied = result.added === 1 ? 'Copied 1 account' : `Copied ${result.added} accounts`
              const message =
                result.added === 0
                  ? 'Nothing new to copy — this project already has every account'
                  : result.kept === 0
                    ? copied
                    : `${copied} — ${result.kept} ${result.kept === 1 ? 'was' : 'were'} already in this project`
              toast(message)
              setAnnounced(stateLine(result.globalImport))
            },
            // The server's own words: a 409 names what refused (hosted mode, a symbolic link).
            onError: (error: Error) => toast(error.message, { tone: 'danger' }),
          })
        }
      >
        {copy.isPending ? 'Copying…' : copyLabel}
      </Button>
    ) : null

  const announcer = (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-slot="accounts-import-announcer">
      {announced}
    </div>
  )

  // The first offer: nothing was answered here yet and there is something to copy. The announcer
  // sits OUTSIDE both shapes, so it stays mounted when a copy turns the card into a line.
  const offer = globalImport.state === 'unknown' && n > 0
  return (
    <>
      {offer ? (
        <section
          data-slot="accounts-import"
          data-state={globalImport.state}
          aria-labelledby="accounts-import-title"
          className="flex flex-col gap-stack rounded-lg border border-border bg-card p-inset"
        >
          <h3 id="accounts-import-title" className="text-[13px] font-semibold text-foreground">
            Copy accounts from your personal setup
          </h3>
          <p className="text-[13px] text-muted-foreground">
            {n === 1
              ? '1 account in your personal xezar setup on this machine is not in this project yet.'
              : `${n} accounts in your personal xezar setup on this machine are not in this project yet.`}{' '}
            Copying adds their names and config folders to {file}, which is committed, so everyone who
            clones this project sees them. Sign-ins stay in their own folders and are never copied.
          </p>
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
            {button}
            <span data-slot="accounts-import-cli" className="text-xs text-muted-foreground">
              Or run <code className="font-mono text-[12px]">xezar accounts import-global</code> in a
              terminal in this folder.
            </span>
          </div>
        </section>
      ) : (
        // After an answer, or with nothing to copy: one line, and the button only when n > 0.
        <section
          data-slot="accounts-import"
          data-state={globalImport.state}
          aria-label="Accounts from your personal setup"
          className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3"
        >
          <p data-slot="accounts-import-line" className="text-[13px] text-muted-foreground">
            {globalImport.state === 'declined' && n > 0 ? (
              <>
                You chose not to copy accounts from your personal xezar setup when this project was set
                up. {n} can still be copied into {file}.
              </>
            ) : (
              stateLine(globalImport)
            )}
          </p>
          {button}
        </section>
      )}
      {announcer}
    </>
  )
}

/** The one-line wording of a state, as plain text — what the line shows and the announcer reads. */
function stateLine({ state, importable: n }: AgentAccountsGlobalImport): string {
  if (state === 'done') {
    return n > 0
      ? `Accounts were copied from your personal xezar setup. ${n} more were added there since and can be copied too.`
      : 'Accounts were copied from your personal xezar setup — this project has all of them.'
  }
  if (state === 'declined' && n > 0) {
    return `You chose not to copy accounts from your personal xezar setup when this project was set up. ${n} can still be copied into ${AGENT_ACCOUNTS_FILE}.`
  }
  if (n > 0) {
    return `${n === 1 ? '1 account' : `${n} accounts`} in your personal xezar setup on this machine ${n === 1 ? 'is' : 'are'} not in this project yet.`
  }
  return 'There are no accounts in your personal xezar setup that this project does not already have.'
}
