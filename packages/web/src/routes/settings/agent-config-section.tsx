import { FileCogIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { ApiError } from '@/api/client'
import { useAgentConfig, useAgentConfigFile, useHealth, usePutAgentConfigFile } from '@/api/queries'
import type { AgentConfigFile, AgentConfigListing, Runner } from '@qodeca/xezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { CodeEditor } from '@/components/code-editor'
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
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { availableRunners } from '@/routes/new-task-form'
import { useLeaveGuard } from '@/lib/use-leave-guard'
import { cn } from '@/lib/utils'
import { useReturnFocus } from './remove-project'
import { AGENT_DESCRIPTORS, descriptorFor, type AgentDescriptor } from './agent-descriptors'

/**
 * Settings → Agent config (spec #404, regrouped per
 * 2026-07-17-agent-config-by-agent): read and edit the coding agents' OWN config
 * files — raw, per scope, highlighted — grouped BY AGENT. An agent selector
 * first; the selected agent's pane holds its Settings, MCP and Memory files
 * together, driven by the per-agent descriptor table. xezar never re-serializes;
 * it shows each scope's file and the vendor's own documented precedence, and
 * never claims a merge it does not perform. Writing is a local-machine
 * capability: in hosted mode the whole section is read-only (the server refuses
 * every write regardless).
 */

/** What this file actually governs for a run — the honest label the spec insists on. */
function effectLabel(file: AgentConfigFile): string {
  if (file.seeded) return 'Copied into each run’s worktree — takes effect on your next run.'
  if (file.tracked === 'tracked') return 'Runs read the committed copy — this edit applies after you commit it.'
  if (file.tracked === 'outside-repo') return 'Applies to every session on this machine.'
  return 'Personal, git-ignored.'
}

export function AgentConfigSection() {
  const listing = useAgentConfig()
  const health = useHealth()
  const installed = useMemo<Runner[]>(
    () => (health.data ? availableRunners(health.data.checks) : AGENT_DESCRIPTORS.map((d) => d.id)),
    [health.data],
  )

  if (listing.isPending) {
    return (
      <p data-slot="agent-config-loading" className="p-list text-[13px] text-soft-foreground md:p-group">
        Loading agent config…
      </p>
    )
  }
  if (listing.isError) {
    return (
      <CenteredState
        icon={<FileCogIcon />}
        tone="danger"
        title="Could not load agent config"
        subtitle={listing.error.message}
        heading="h2"
      />
    )
  }
  return <AgentConfigView listing={listing.data} installed={installed} />
}

function AgentConfigView({ listing, installed }: { listing: AgentConfigListing; installed: Runner[] }) {
  const [agentId, setAgentId] = useState<Runner>('claude')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const agent = descriptorFor(agentId)
  const selected = listing.files.find((f) => f.id === selectedId) ?? null
  // The open editor's unsaved edits. Switching file or agent unmounts that editor, and leaving
  // the page unmounts the whole section, so each of those asks first while this is true.
  const [dirty, setDirty] = useState(false)
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)
  const guarded = (action: () => void) => {
    if (dirty) setPendingLeave(() => action)
    else action()
  }
  useLeaveGuard(dirty, (proceed) => setPendingLeave(() => proceed))

  const pickAgent = (id: Runner) => {
    if (id === agentId) return
    guarded(() => {
      setAgentId(id)
      setSelectedId(null) // a file selection never survives an agent switch
    })
  }
  const pickFile = (id: string) => {
    if (id === selectedId) return
    guarded(() => setSelectedId(id))
  }

  return (
    <div data-slot="agent-config" className="flex flex-col gap-list p-list md:p-group">
      {!listing.editable && (
        <div
          data-slot="agent-config-readonly"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px] text-soft-foreground"
        >
          Read-only: agent config is edited from the machine that owns the checkout (this cockpit runs in hosted
          mode). You can still see every file and which one wins.
        </div>
      )}

      <div data-slot="agent-config-agents" role="tablist" className="flex flex-wrap gap-1 rounded-md bg-muted/40 p-1">
        {AGENT_DESCRIPTORS.map((d) => (
          <button
            key={d.id}
            type="button"
            role="tab"
            aria-selected={d.id === agent.id}
            data-slot="agent-config-agent"
            data-agent={d.id}
            data-selected={d.id === agent.id}
            onClick={() => pickAgent(d.id)}
            className={cn(
              'flex min-h-tap min-w-tap items-center justify-center gap-2 rounded-md px-3 py-1.5 text-[13px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-0 md:min-w-0',
              d.id === agent.id ? 'bg-background font-semibold shadow-sm' : 'hover:bg-muted/60',
            )}
          >
            {d.label}
            {!installed.includes(d.id) && (
              <Badge variant="outline" className="min-h-chip text-[10px] text-soft-foreground">
                not installed
              </Badge>
            )}
          </button>
        ))}
      </div>

      {agent.note && (
        <p data-slot="agent-config-agent-note" className="text-[12px] text-soft-foreground">
          {agent.note}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <nav data-slot="agent-config-nav" className="flex flex-col gap-5">
          <AgentPane
            agent={agent}
            listing={listing}
            selectedId={selectedId}
            onSelect={pickFile}
          />
        </nav>

        <div data-slot="agent-config-editor-pane">
          {selected ? (
            <FileEditor key={selected.id} file={selected} onDirtyChange={setDirty} />
          ) : (
            <div className="flex h-full min-h-40 items-center justify-center rounded-md border border-dashed border-border text-[13px] text-soft-foreground">
              Select a config file to view or edit it.
            </div>
          )}
        </div>
      </div>

      <DiscardEditsDialog
        open={pendingLeave !== null}
        fileLabel={selected?.label}
        onKeep={() => setPendingLeave(null)}
        onDiscard={() => {
          const proceed = pendingLeave
          setPendingLeave(null)
          // The editor that held the edits unmounts on the way out; drop its flag first so the
          // leave guard is not still armed for the navigation it is about to allow.
          setDirty(false)
          proceed?.()
        }}
      />
    </div>
  )
}

/**
 * The destructive confirm (patterns.md § 7) in front of anything that throws away the open
 * file's unsaved edits: reloading it from disk, opening another file or agent, or leaving the
 * page. Focus returns to whatever opened it.
 *
 * @param props.open - Whether the confirm is showing.
 * @param props.fileLabel - The file whose edits are at stake, named in the title.
 * @param props.onKeep - Dismiss and keep editing.
 * @param props.onDiscard - Throw the edits away and carry on.
 * @returns The alert dialog.
 */
export function DiscardEditsDialog({
  open,
  fileLabel,
  onKeep,
  onDiscard,
}: {
  open: boolean
  fileLabel: string | undefined
  onKeep: () => void
  onDiscard: () => void
}) {
  const returnFocus = useReturnFocus(open)
  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onKeep())}>
      <AlertDialogContent onCloseAutoFocus={returnFocus}>
        <AlertDialogHeader className="min-w-0">
          <AlertDialogTitle className="break-words">
            Discard your edits to {fileLabel ?? 'this file'}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Your unsaved changes to this file are lost. There is no undo.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction className={buttonVariants({ variant: 'danger' })} onClick={onDiscard}>
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function AgentPane({
  agent,
  listing,
  selectedId,
  onSelect,
}: {
  agent: AgentDescriptor
  listing: AgentConfigListing
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <>
      {agent.groups.map((g) => {
        const files = listing.files.filter(g.files)
        const isClaudeMcp = agent.id === 'claude' && g.id === 'mcp'
        if (files.length === 0 && !(isClaudeMcp && listing.userMcp)) return null
        return (
          <section key={g.id} data-slot="agent-config-group" data-group={g.id} data-agent={agent.id}>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-soft-foreground">
              {g.label}
            </p>
            {g.note && <p className="mb-2 text-[12px] text-soft-foreground">{g.note}</p>}
            <ul className="flex flex-col gap-1">
              {files.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    data-slot="agent-config-file"
                    data-selected={file.id === selectedId}
                    onClick={() => onSelect(file.id)}
                    className={cn(
                      'flex min-h-tap w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-0',
                      file.id === selectedId ? 'bg-primary/15 text-foreground' : 'hover:bg-muted/60',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{file.label}</span>
                    {file.seeded && (
                      <Badge variant="outline" className="min-h-chip shrink-0 text-[10px]">
                        seeded
                      </Badge>
                    )}
                    {!file.exists && <span className="shrink-0 text-[11px] text-soft-foreground">absent</span>}
                  </button>
                </li>
              ))}
            </ul>
            {isClaudeMcp && listing.userMcp && <UserMcpBlock userMcp={listing.userMcp} />}
          </section>
        )
      })}
    </>
  )
}

/** Claude's user/local MCP scopes live in ~/.claude.json (Claude's own state
 *  file) — listed read-only; xezar never edits it. */
function UserMcpBlock({ userMcp }: { userMcp: NonNullable<AgentConfigListing['userMcp']> }) {
  return (
    <div data-slot="agent-config-user-mcp" className="mt-3">
      <h4 className="mb-1 text-[12px] font-semibold">User &amp; local scopes</h4>
      <p className="mb-2 text-[12px] text-soft-foreground">
        Managed by <code className="font-mono">claude mcp add</code> in {userMcp.path} — xezar does not edit
        Claude’s state file.
      </p>
      {userMcp.readable ? (
        userMcp.servers.length > 0 ? (
          <ul className="flex flex-wrap gap-1">
            {userMcp.servers.map((name) => (
              <li key={name}>
                <Badge variant="outline" className="min-h-chip font-mono text-[11px]">
                  {name}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-soft-foreground">No user-scoped MCP servers.</p>
        )
      ) : (
        <p className="text-[12px] text-soft-foreground">Could not read the file.</p>
      )}
    </div>
  )
}

/**
 * One agent config file: the raw editor, Save / Revert, and the conflict recovery.
 *
 * The draft is pinned to the server copy it started from (`base`). While there are unsaved edits
 * a newer copy from a background refetch replaces neither the draft nor the version Save sends,
 * so a file changed on disk meanwhile surfaces as the 409 conflict instead of being overwritten
 * or silently swapped in. "Reload from disk" with unsaved edits asks first.
 *
 * @param props.file - The listing entry for the file.
 * @param props.onDirtyChange - Told whenever "has unsaved edits" flips, and `false` on unmount.
 * @returns The editor block.
 */
export function FileEditor({
  file,
  onDirtyChange,
}: {
  file: AgentConfigFile
  onDirtyChange?: (dirty: boolean) => void
}) {
  const fileQuery = useAgentConfigFile(file.id)
  const put = usePutAgentConfigFile(file.id)
  const [base, setBase] = useState<{ content: string; version: string | null } | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [formatError, setFormatError] = useState<string | null>(null)
  const [confirmReload, setConfirmReload] = useState(false)

  const data = fileQuery.data
  const dirty = base !== null && draft !== null && draft !== base.content
  // Adopt a new server copy only while nothing is being edited – adjusted during render rather
  // than in an effect, so the editor never paints one frame of the stale copy.
  if (data && !dirty && (base === null || base.version !== data.version || base.content !== data.content)) {
    setBase({ content: data.content, version: data.version })
    setDraft(null)
    setConflict(false)
    setFormatError(null)
  }

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  const content = draft ?? base?.content ?? data?.content ?? ''
  const canWrite = file.writable

  const reloadFromDisk = async () => {
    const fresh = await fileQuery.refetch()
    if (!fresh.data) return
    setBase({ content: fresh.data.content, version: fresh.data.version })
    setDraft(null)
    setConflict(false)
    setFormatError(null)
  }

  const save = () => {
    setFormatError(null)
    setConflict(false)
    put.mutate(
      { content, version: base?.version ?? null },
      {
        onSuccess: (result) => {
          setBase({ content: result.content, version: result.version })
          setDraft(null)
          toast(`${file.exists ? 'Saved' : 'Created'} ${file.label}`)
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) setConflict(true)
          else if (err instanceof ApiError && err.status === 400) setFormatError(err.message)
          else toast((err as Error).message, { tone: 'danger' })
        },
      },
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px]">{file.label}</span>
        <Badge variant="outline" className="min-h-chip text-[10px] uppercase">
          {file.format}
        </Badge>
        <a
          href={file.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-tap min-w-tap items-center justify-center rounded-sm text-[12px] text-soft-foreground underline outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-0 md:min-w-0"
        >
          docs
        </a>
      </div>

      <p data-slot="agent-config-precedence" className="text-[12px] text-soft-foreground">
        {file.precedence}
      </p>
      <p data-slot="agent-config-effect" className="text-[12px] text-foreground/80">
        {effectLabel(file)}
        {file.hotReload ? ` ${file.hotReload}` : ''}
      </p>

      {fileQuery.isPending ? (
        <p className="text-[13px] text-soft-foreground">Loading file…</p>
      ) : fileQuery.isError ? (
        <p className="text-[13px] text-danger">{fileQuery.error.message}</p>
      ) : (
        <CodeEditor
          value={content}
          language={file.format}
          readOnly={!canWrite}
          onChange={setDraft}
          aria-label={`${file.label} contents`}
          className="h-104"
        />
      )}

      {formatError && (
        <p data-slot="agent-config-format-error" className="text-[12px] text-danger">
          {formatError}
        </p>
      )}
      {conflict && (
        <div
          data-slot="agent-config-conflict"
          className="flex items-center justify-between gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px]"
        >
          <span>The file changed on disk since you opened it.</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => (dirty ? setConfirmReload(true) : void reloadFromDisk())}
          >
            Reload from disk
          </Button>
        </div>
      )}

      {canWrite && (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={!dirty || put.isPending}>
            {file.exists ? 'Save' : 'Create'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDraft(null)}
            disabled={!dirty || put.isPending}
          >
            Revert
          </Button>
          {dirty && <span className="text-[12px] text-soft-foreground">Unsaved changes</span>}
        </div>
      )}

      <DiscardEditsDialog
        open={confirmReload}
        fileLabel={file.label}
        onKeep={() => setConfirmReload(false)}
        onDiscard={() => {
          setConfirmReload(false)
          void reloadFromDisk()
        }}
      />
    </div>
  )
}
