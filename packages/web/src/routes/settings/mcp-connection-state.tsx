import type { ReactNode } from 'react'
import { Link } from 'react-router'
import {
  CableIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleHelpIcon,
  ClockIcon,
  HourglassIcon,
  LoaderCircleIcon,
  PauseIcon,
  PlugIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  UsersIcon,
  WifiOffIcon,
} from 'lucide-react'

import type { ProjectOwnerState } from '@qodeca/xezar-api-client'

/**
 * The MCP connection state inventory, rendered honestly (issue #112, Phase 7 of epic #67).
 *
 * Every state the requirements' "State inventory and recovery" table (§13) lists is a member of
 * `McpConnectionState`, and each one renders its OWN copy — the occupied and expired-owner cases
 * are DISTINCT, the disconnected state says tasks continue (never "task failed"), the restarting
 * state labels its data last-known, and no state renders a countdown, a timeout value or another
 * owner's session identifier.
 *
 * This is a PRESENTATIONAL component. It owns no data and performs no fetch: issue #114 composes
 * it into the MCP connection section and feeds it the current state, which the server reports
 * (§8 — file presence or location alone is never a security boundary). `connectionStateFromOwner`
 * is the bridge from the owner state Phase 4 exposes (`unowned | owned | expired`) to the base
 * states here; the section widens it with the richer signals (loading, connecting, waiting,
 * restarting, disconnected, error, unsupported) that the owner state alone cannot express.
 *
 * Hard boundaries honored here (U-M03, U-M02, F-15, F-12):
 *  - there is NO "Disconnect other client", NO "Force takeover" and NO manual disconnect control;
 *  - the occupied and expired states carry no owner detail — no session id, no token, no pid,
 *    no client name, no "occupied since" — so nothing here can fingerprint another client;
 *  - there is no role toggle and no permission checklist;
 *  - there is no lease countdown and no invented timeout — §13 says exact lease countdowns must
 *    not be designed before timing semantics exist.
 */

/** The outcome of an operation with an uncertain external result, as §13 requires stating clearly. */
export type McpOperationOutcome = 'not-applied' | 'accepted' | 'unverified'

/**
 * The discriminated union over the whole connection state inventory. Every member is a real,
 * distinguishable state the server (or its absence of a confirmed value) can report, with exactly
 * the data needed to render it honestly — and nothing that could leak a secret or another
 * project's identity.
 */
export type McpConnectionState =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'connecting' }
  | { kind: 'active' }
  | { kind: 'occupied' }
  | { kind: 'waiting'; task?: { href: string; title: string } }
  | { kind: 'leader-paused' }
  | { kind: 'server-restarting' }
  | { kind: 'disconnected' }
  | { kind: 'expired' }
  | { kind: 'error'; outcome: McpOperationOutcome }
  | { kind: 'unsupported'; missing: string }

/**
 * Bridge from the owner state Phase 4 exposes to the base connection states. The section uses this
 * as its resting map and then widens it with the richer signals it has: `unowned` -> ready,
 * `owned` -> active, `expired` -> expired.
 */
export function connectionStateFromOwner(owner: ProjectOwnerState): McpConnectionState {
  switch (owner) {
    case 'unowned':
      return { kind: 'ready' }
    case 'owned':
      return { kind: 'active' }
    case 'expired':
      return { kind: 'expired' }
  }
}

/** The icon tile tone for a state. Decorative only — the title and copy carry the meaning. */
type StateTone = 'neutral' | 'primary' | 'danger'

const toneClass: Record<StateTone, string> = {
  neutral: 'border-border bg-card text-foreground',
  primary: 'border-primary/25 bg-primary/15 text-primary',
  danger: 'border-danger/20 bg-danger/15 text-danger',
}

/** A single state card. Kept small so every member renders the same honest rhythm. */
function StateCard({
  icon,
  tone,
  title,
  copy,
  recovery,
  action,
  state,
}: {
  icon: ReactNode
  tone: StateTone
  title: string
  copy: string
  recovery?: string
  action?: ReactNode
  state: string
}) {
  return (
    <div
      data-slot="mcp-connection-state"
      data-state={state}
      className="rounded-md border border-border bg-card p-3"
    >
      <div className="flex items-start gap-3">
        <div
          data-slot="mcp-connection-state-icon"
          className={cnTile(tone, icon)}
          aria-hidden="true"
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p data-slot="mcp-connection-state-copy" className="mt-1 text-[13px] leading-relaxed text-foreground">
            {copy}
          </p>
          {recovery ? (
            <p data-slot="mcp-connection-state-recovery" className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              {recovery}
            </p>
          ) : null}
          {action ? <div className="mt-2">{action}</div> : null}
        </div>
      </div>
    </div>
  )
}

function cnTile(tone: StateTone, icon: ReactNode): string {
  // Inline so this file needs no `cn` dependency for a three-way tone map.
  return `flex size-10 shrink-0 items-center justify-center rounded-[10px] border [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5 ${toneClass[tone]}`
}

/**
 * Renders one member of the connection state inventory, with truthful copy and recovery guidance.
 * The single exported component issue #114 mounts into the MCP connection section.
 */
export function McpConnectionState({ state }: { state: McpConnectionState }) {
  switch (state.kind) {
    case 'empty':
      return (
        <StateCard
          state={state.kind}
          icon={<PlugIcon />}
          tone="neutral"
          title="Configuration not generated yet"
          copy="This project exists, but its MCP connection configuration has not been generated. xezar writes it automatically the first time the connection is used — you never have to invent connection data by hand."
          recovery="Nothing to do here by hand. xezar generates the connection configuration automatically, and the one-time client setup below is the only step you take."
        />
      )
    case 'loading':
      return (
        <StateCard
          state={state.kind}
          icon={<LoaderCircleIcon className="motion-safe:animate-spin" />}
          tone="neutral"
          title="Discovering connection state"
          copy="Checking the connection state for this project. Confirmed capability values appear only once the server reports them — nothing is shown as confirmed before that."
          recovery="This is bounded progress. If it stays here, reconnect the leader client to re-read current state."
        />
      )
    case 'ready':
      return (
        <StateCard
          state={state.kind}
          icon={<CircleCheckIcon />}
          tone="primary"
          title="Ready to connect"
          copy="No active MCP client owns this project right now. No model is running and no session is active yet."
          recovery="Follow the one-time setup below to connect a leader client to this project."
        />
      )
    case 'connecting':
      return (
        <StateCard
          state={state.kind}
          icon={<CableIcon />}
          tone="neutral"
          title="Connecting"
          copy="The leader connection is being established. Establishing a connection is separate from starting a model: connecting does not mean a model is generating yet."
          recovery="Repeated transport requests from the same client are not additional clients — one connection attempt may make several requests before it settles."
        />
      )
    case 'active':
      return (
        <StateCard
          state={state.kind}
          icon={<CircleDotIcon />}
          tone="primary"
          title="Connected"
          copy="An MCP client owns this project and its session is live. “Connected” means the owner and its session are live — not necessarily that the model is generating right now."
          recovery="The cockpit can still mutate project state alongside it. If a task is idle, that does not mean the connection dropped."
        />
      )
    case 'occupied':
      return (
        <StateCard
          state={state.kind}
          icon={<UsersIcon />}
          tone="danger"
          title="This project is occupied"
          copy="Another logical client already owns this project, so this second client was refused. This is not a server failure: the cockpit still works and any running tasks are unaffected."
          recovery="The project becomes available automatically when the current owner disconnects or its session ends. There is no way to disconnect the other client or take over from here — connect again after it is released."
        />
      )
    case 'waiting':
      return (
        <StateCard
          state={state.kind}
          icon={<HourglassIcon />}
          tone="neutral"
          title="Waiting on a decision"
          copy="A task may be waiting on a human decision without the MCP connection being disconnected. Occupancy does not change just because the model has been silent."
          recovery={
            state.task
              ? 'Answer the question on the task to continue.'
              : 'Check the task for a question waiting on you.'
          }
          action={
            state.task ? (
              <Link
                to={state.task.href}
                className="inline-flex items-center gap-1 text-[13px] font-medium text-foreground underline underline-offset-4"
              >
                Open the task
              </Link>
            ) : undefined
          }
        />
      )
    case 'leader-paused':
      return (
        <StateCard
          state={state.kind}
          icon={<PauseIcon />}
          tone="neutral"
          title="Leader paused"
          copy="The leader client is paused. This is a leader state, not an MCP disconnect: pausing the leader does not release the connection."
          recovery="Resume the leader to continue; the connection is still held while it is paused."
        />
      )
    case 'server-restarting':
      return (
        <StateCard
          state={state.kind}
          icon={<RefreshCwIcon className="motion-safe:animate-spin" />}
          tone="neutral"
          title="Server restarting"
          copy="The xezar server is restarting or unavailable. The connection data shown here is last-known, not newly confirmed."
          recovery="Running tasks are not cancelled by the restart. After recovery the actual owner and configuration state are shown."
        />
      )
    case 'disconnected':
      return (
        <StateCard
          state={state.kind}
          icon={<WifiOffIcon />}
          tone="danger"
          title="Disconnected — reconnecting"
          copy="The connection to the leader is interrupted. Started tasks continue to run; their state and results are reconciled after reconnect."
          recovery="This is a connection problem, not a task failure. Reconnect the leader client to resume."
        />
      )
    case 'expired':
      return (
        <StateCard
          state={state.kind}
          icon={<ClockIcon />}
          tone="danger"
          title="Owner session expired"
          copy="The previous owner's session expired, so its connection is no longer valid. The old client must reinitialize to connect again — and a new client may already own the project."
          recovery="Reconnect from the leader client to start a fresh session. If another client took the project meanwhile, it is occupied instead."
        />
      )
    case 'error':
      return <ErrorState outcome={state.outcome} />
    case 'unsupported':
      return (
        <StateCard
          state={state.kind}
          icon={<CircleHelpIcon />}
          tone="neutral"
          title="Capability unavailable"
          copy={`The connection is limited by a missing ${state.missing}.`}
          recovery="This is the missing client, adapter, dependency or read-only boundary — not a secret and not another project's data. The setup guidance on this page says what to do about it."
        />
      )
  }
}

/** The error/conflict/uncertain state, which §13 says must state the outcome clearly. */
function ErrorState({ outcome }: { outcome: McpOperationOutcome }) {
  const detail: Record<McpOperationOutcome, { title: string; copy: string }> = {
    'not-applied': {
      title: 'Operation not applied',
      copy: 'No mutation occurred: the operation was rejected before it changed anything.',
    },
    accepted: {
      title: 'Operation accepted',
      copy: 'The operation was accepted and is in progress. Its outcome may still be running.',
    },
    unverified: {
      title: 'Outcome needs verification',
      copy: 'The operation’s outcome needs verification — it may or may not have taken effect.',
    },
  }
  const { title, copy } = detail[outcome]
  return (
    <StateCard
      state="error"
      icon={<TriangleAlertIcon />}
      tone="danger"
      title={title}
      copy={copy}
      recovery="Re-read current state before deciding again. Do not repeat a blind retry with a new key — preserve the operation identity instead."
    />
  )
}
