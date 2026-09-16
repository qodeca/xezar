import { useId, useState } from 'react'

import type { McpLeaderActionInput, McpLeaderStatus } from '@qodeca/xezar-api-client'
import { useHealth, useMcpLeader, useMcpLeaderAction, useMcpLeaderSubscription } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActiveProjectId } from '@/lib/project-router'
import { RUNNER_LABEL } from '@/lib/runner-label'
import { cn } from '@/lib/utils'
import { withCode } from './mcp-copy'

/**
 * The ONE leader control of Settings → MCP connection (#374, round 4 on #403: the QA FAIL "a person
 * cannot attach from the cockpit" and design review NB-2). It reads `GET /api/v1/mcp/leader` and says
 * who owns the project, whether a leader is attached, and — when events are waiting — the server's
 * recoverable blocker with its `Fix:`. Its one action, Attach leader, POSTs the SAME route with the
 * client derived from that status: the attached leader's client when there is one, the owner's when
 * the owning session identified itself (Codex through its announced thread, Claude Code through its
 * bridge's client name — #404), and otherwise the client the person picks. One exception (#404
 * merge review): a leader the server retained across an owner change — another client owns the
 * project now, so re-attaching it is refused — brings the picker back, defaulting to the owner, and
 * Attach leader is then the person's explicit replacement of that stale attachment.
 *
 * Generic on purpose, so every client's leg reuses it rather than adding a control of its own: a
 * client is one row in `LEADER_CLIENTS`, and the contract union makes the body type-check. Typed
 * `Record<LeaderClient, …>`, so a new attachable client in the contract is a compile error here
 * until it has its words.
 *
 * Hard boundaries kept from the section (U-M02, U-M03): no path, port, token or session identifier
 * of another client is shown; there is no "disconnect other client" or takeover; attaching is the
 * person's opt-in and nothing attaches by itself.
 */

type AttachClient = Extract<McpLeaderActionInput, { action: 'attach' }>['client']
/** Every client a person can ask about here: since #404 all four can be attached. */
type LeaderClient = AttachClient

interface LeaderClientCopy {
  /** The product name, from `lib/runner-label.ts`. */
  readonly name: string
  /** `direct` posts `{action, client}`; `opencode` adds its session's address. */
  readonly attach: 'direct' | 'opencode'
  /** What attaching this client takes. `backticked` names render as code. */
  readonly note: string
  /** The attached-and-delivering sentence. Codex's is the decision record's § 5 copy, verbatim. */
  readonly connected: string
}

const LEADER_CLIENTS: Record<LeaderClient, LeaderClientCopy> = {
  codex: {
    name: RUNNER_LABEL.codex,
    attach: 'direct',
    note: 'xezar finds the Codex session you already run on Codex’s shared local `app-server`, in the Codex home xezar uses, and never asks for a socket path or port. Let the session call a xezar tool once first, for example `leader_events`.',
    connected: 'Codex connected. Project events can start a turn in your current session.',
  },
  opencode: {
    name: RUNNER_LABEL.opencode,
    attach: 'opencode',
    note: 'The `opencode serve` session events should start in: the address it listens on and its session id.',
    connected: 'OpenCode connected. Project events can start a turn in that session.',
  },
  pi: {
    name: RUNNER_LABEL.pi,
    attach: 'direct',
    note: 'Works when this pi runs xezar’s leader extension. Without it, pi reads its events with `leader_events` and there is nothing to attach.',
    connected: 'pi connected. Project events can start a turn in your current session.',
  },
  'claude-code': {
    name: RUNNER_LABEL.claude,
    attach: 'direct',
    // #404: the owner session itself is the target, woken over Claude Code Channels. The flag is the
    // person's per-launch opt-in; without it Claude Code keeps reading with `leader_events`.
    note: 'Works when this Claude Code was started with `--dangerously-load-development-channels server:xezar` and has called a xezar tool once. Without the flag, Claude Code reads its events with `leader_events`.',
    connected: 'Claude Code connected. Project events can start a turn in your current session.',
  },
}

/** The order the picker offers them in. */
const CHOICES: readonly LeaderClient[] = ['codex', 'opencode', 'pi', 'claude-code']

/** Names the server's copy mentions without backticks, rendered as code all the same (NB-3). */
const CODE_WORDS = ['leader_events', 'app-server'] as const

/** Which of the reachable states the control is in; `data-state` carries it for tests and review. */
export type McpLeaderViewState = 'unavailable' | 'no-owner' | 'owner' | 'blocked' | 'delivering'

export function leaderViewState(status: McpLeaderStatus): McpLeaderViewState {
  if (!status.available) return 'unavailable'
  if (status.leader) return status.blocker ? 'blocked' : 'delivering'
  return status.owner ? 'owner' : 'no-owner'
}

/**
 * The control as the section mounts it: the query, the live topic, the action, and the loading and
 * error lines. The status is live while the control is on screen (round 5 on #403): in local mode it
 * holds the `mcp-leader` topic and the server pushes each change; in remote mode it has the HTTP read,
 * focus and the stream's reconcile. The project is the section's own: the URL's, else the boot one.
 */
export function McpLeaderControl() {
  const health = useHealth()
  const projectId = useActiveProjectId() ?? health.data?.bootProject ?? null
  useMcpLeaderSubscription(projectId, health.data?.capabilities?.localHandoff === true)
  const leader = useMcpLeader()
  const action = useMcpLeaderAction()
  const refresh = { refreshing: leader.isFetching, onRefresh: () => void leader.refetch() }

  if (leader.isPending) {
    return (
      <p data-slot="mcp-leader-loading" role="status" className="text-[13px] text-muted-foreground">
        Loading the leader connection…
      </p>
    )
  }
  if (leader.isError && !leader.data) {
    return (
      <div data-slot="mcp-leader-error" className="flex flex-col gap-3 rounded-md border border-border bg-card p-3">
        <p className="text-[13px] leading-relaxed text-foreground">
          <span className="font-medium">Could not load the leader connection.</span> {leader.error.message}
        </p>
        <RefreshButton {...refresh} />
      </div>
    )
  }
  return (
    <McpLeaderPanel
      status={leader.data}
      attaching={action.isPending}
      error={action.error?.message ?? null}
      onAttach={(input) => action.mutate(input)}
      {...refresh}
      staleError={leader.isError ? leader.error.message : null}
    />
  )
}

/**
 * Refresh, in every state (NB-5 on #403): the first read failing, the MCP service not running, and
 * each state of the panel. The topic keeps a local status live; this re-reads it on demand anywhere.
 */
function RefreshButton({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return (
    <Button size="sm" variant="outline" className="w-fit" data-slot="mcp-leader-refresh" disabled={refreshing} onClick={onRefresh}>
      {refreshing ? 'Refreshing…' : 'Refresh'}
    </Button>
  )
}

/** Presentational: every state renders from `status` alone, so each one can be checked as it is. */
export function McpLeaderPanel({
  status,
  attaching,
  error,
  onAttach,
  refreshing,
  onRefresh,
  staleError = null,
}: {
  status: McpLeaderStatus
  attaching: boolean
  /** The last attach's refusal, in the server's own words. */
  error: string | null
  onAttach: (input: McpLeaderActionInput) => void
  refreshing: boolean
  onRefresh: () => void
  /** Set when the last re-read failed: `status` is then the last one read, and says so. */
  staleError?: string | null
}) {
  const state = leaderViewState(status)
  // `null` until the person picks: the selector's default then follows the status (the owner's
  // client when a stale attachment must be replaced), instead of a pick frozen at first render.
  const [picked, setPicked] = useState<LeaderClient | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [sessionId, setSessionId] = useState('')
  const ids = useId()

  if (!status.available) {
    return (
      <div data-slot="mcp-leader" data-state={state} className="flex flex-col gap-3 rounded-md border border-border bg-card p-3">
        <p data-slot="mcp-leader-reason" className="text-[13px] leading-relaxed text-foreground">
          {status.reason}
        </p>
        <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />
      </div>
    )
  }

  const blocker = status.blocker
  const ownerClient: LeaderClient | null = status.owner?.client ?? null
  const leaderClient: LeaderClient | null = status.leader?.client ?? null
  // An attachment the server RETAINED across an owner change (#404 merge review, major 1): the
  // leader is another client than the one that owns the project now — the server says so as a
  // `*-not-owner` blocker, or the two identified clients simply differ — so attaching it again is
  // refused again. The selector then comes back, defaulting to the owner, and Attach leader is the
  // explicit replacement: the person chooses it, and the server's opt-in and ownership checks still
  // decide whether the chosen client can be attached at all.
  const stale = leaderClient !== null && ((blocker !== null && blocker.code.endsWith('-not-owner')) || (ownerClient !== null && ownerClient !== leaderClient))
  // The client to attach, derived from the status: the attached leader's own (to attach it again)
  // unless it is stale, the owner's when the owning session identified itself, and otherwise the
  // person's pick — which, when there is something to replace, defaults to the owner.
  const derived: LeaderClient | null = stale ? null : (leaderClient ?? ownerClient)
  const client = derived ?? picked ?? ownerClient ?? 'codex'
  const copy = LEADER_CLIENTS[client]
  // The server answers a refused attach with the refusal's own message and fix; when the status shows
  // that same blocker it is not said twice. Any other refusal is shown, whatever the status blocker is.
  const refusal = error !== null && !(blocker !== null && error === `${blocker.message} ${blocker.fix}`) ? error : null
  const canSubmit = copy.attach === 'direct' || (copy.attach === 'opencode' && baseUrl.trim() !== '' && sessionId.trim() !== '')

  const attach = (): void => {
    onAttach(
      client === 'opencode'
        ? { action: 'attach', client, baseUrl: baseUrl.trim(), sessionId: sessionId.trim() }
        : { action: 'attach', client: client as Exclude<AttachClient, 'opencode'> },
    )
  }

  return (
    <div data-slot="mcp-leader" data-state={state} className="flex flex-col gap-3 rounded-md border border-border bg-card p-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-muted-foreground">Owning client</dt>
        <dd data-slot="mcp-leader-owner" className="text-foreground">
          {status.owner === null ? 'None' : status.owner.client === null ? 'Not identified' : LEADER_CLIENTS[status.owner.client].name}
        </dd>
        <dt className="text-muted-foreground">Leader</dt>
        <dd data-slot="mcp-leader-attached" className="text-foreground">
          {status.leader ? `${LEADER_CLIENTS[status.leader.client].name}, attached` : 'None attached'}
        </dd>
      </dl>

      {/* Only the status words are announced; the controls below stay outside the live region. */}
      <div data-slot="mcp-leader-live" aria-live="polite" className="flex flex-col gap-3">
        <p data-slot="mcp-leader-summary" className="text-[13px] leading-relaxed text-foreground">
          {withCode(summary(status), CODE_WORDS)}
        </p>

        {blocker ? (
          <div data-slot="mcp-leader-blocker" data-code={blocker.code} className="rounded-md bg-muted p-2 text-[13px] leading-relaxed text-muted-foreground">
            <p className="text-foreground">{withCode(blocker.message, CODE_WORDS)}</p>
            <p className="mt-1">
              <span className="font-medium text-foreground">Fix:</span> {withCode(blocker.fix, CODE_WORDS)}
            </p>
          </div>
        ) : null}

        {staleError !== null ? (
          <p data-slot="mcp-leader-stale" className="rounded-md bg-muted p-2 text-[13px] leading-relaxed text-foreground">
            <span className="font-medium">Could not refresh — showing the last status.</span> {staleError}
          </p>
        ) : null}
      </div>

      {state === 'delivering' ? null : (
        <div data-slot="mcp-leader-attach" className="flex flex-col gap-2">
          {derived === null ? (
            <div
              role="radiogroup"
              aria-label="Leader client"
              data-slot="mcp-leader-client"
              className="inline-flex w-fit flex-wrap gap-0.5 rounded-md border border-border bg-card p-0.5"
            >
              {CHOICES.map((choice) => {
                const checked = choice === client
                return (
                  <button
                    key={choice}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    data-value={choice}
                    onClick={() => setPicked(choice)}
                    className={cn(
                      'inline-flex min-h-tap min-w-tap items-center justify-center rounded-sm px-3 py-1.5 text-[13px] font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-0 md:min-w-0',
                      checked ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {LEADER_CLIENTS[choice].name}
                  </button>
                )
              })}
            </div>
          ) : null}

          {stale && leaderClient !== null ? (
            <p data-slot="mcp-leader-replace" className="text-[13px] leading-relaxed text-muted-foreground">
              Attaching a client here replaces the attached {LEADER_CLIENTS[leaderClient].name}. Events stay in the journal until the new leader is attached.
            </p>
          ) : null}

          <p data-slot="mcp-leader-note" className="text-[13px] leading-relaxed text-muted-foreground">
            {withCode(copy.note, CODE_WORDS)}
          </p>

          {copy.attach === 'opencode' ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${ids}-url`}>Server address</Label>
                <Input id={`${ids}-url`} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://127.0.0.1:4096" autoComplete="off" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${ids}-session`}>Session id</Label>
                <Input id={`${ids}-session`} value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="ses_…" autoComplete="off" />
              </div>
            </div>
          ) : null}

          {/* The surface's primary action: a 44 px touch target on a phone that relaxes to the default 36 px at md (foundations.md § 12; NB-6 on #403). */}
          <Button className="h-11 w-fit md:h-9" data-slot="mcp-leader-attach-button" disabled={attaching || !canSubmit} onClick={attach}>
            {attaching ? 'Attaching…' : 'Attach leader'}
          </Button>
        </div>
      )}

      {refusal ? (
        <p data-slot="mcp-leader-refusal" role="alert" className="rounded-md bg-muted p-2 text-[13px] leading-relaxed text-foreground">
          {withCode(refusal, CODE_WORDS)}
        </p>
      ) : null}

      <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />
    </div>
  )
}

/** The one sentence that says where this project's events go right now. */
function summary(status: Extract<McpLeaderStatus, { available: true }>): string {
  if (status.leader) {
    const words = LEADER_CLIENTS[status.leader.client]
    return status.blocker ? `${words.name} is attached, but events are waiting.` : words.connected
  }
  if (status.owner === null) {
    return 'No leader client is connected to this project. Start your leader client here: it can read its events with `leader_events`, and a Claude Code, Codex, OpenCode or pi session can be attached below.'
  }
  if (status.owner.client === 'codex') {
    return 'Your Codex session owns this project. Nothing is attached yet, so events are kept for `leader_events` and start no turn.'
  }
  if (status.owner.client === 'claude-code') {
    return 'Your Claude Code session owns this project. Nothing is attached yet, so events are kept for `leader_events` and start no turn.'
  }
  return 'A client owns this project, but xezar has not identified which one. Nothing is attached, so events start no turn in it; a leader can read them with `leader_events`.'
}
