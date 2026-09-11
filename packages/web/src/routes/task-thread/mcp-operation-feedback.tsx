import { RefreshCwIcon, TriangleAlertIcon, CircleCheckIcon, CircleXIcon, CircleIcon } from 'lucide-react'

/**
 * MCP operation-outcome feedback (issue #113, Phase 7 of epic #67).
 *
 * The MCP leader connection performs project actions through the same shared services the cockpit
 * uses (N-02), so an MCP mutation emits the same store events and reaches an open task view through
 * the existing SSE stream (`global-events.tsx`). What the cockpit must ALSO say, plainly, is what a
 * conflict or a retry DID — U-M05 is the sharpest copy requirement in the MCP contract, and U-M07
 * supplies the short labels.
 *
 * What this component renders, and the requirements it enforces:
 *
 * - **U-M07 labels.** `Accepted`, `Running`, `Completed`, `Failed`, `Conflict — not applied`,
 *   `Outcome being verified`. Two things inside U-M07 are NOT proposals and are enforced here:
 *   (1) an acknowledgement (`accepted`) is NEVER labelled `Completed` — `accepted` means "the
 *   operation was accepted and is being processed", not "done"; (2) operation context (the
 *   operation id and action) is preserved on a transient error.
 *
 * - **U-M05 distinguishes rejection from failure after execution.** A `conflict` (a stale-write
 *   rejection, N-03) is labelled "Conflict — not applied" and says the resource changed after the
 *   leader read it, that NOTHING was overwritten, and that the leader must re-read the current
 *   state before deciding again. A `failed` operation was ACCEPTED and RAN but failed after
 *   execution — a different thing, and never called "not applied".
 *
 * - **U-M05 retry.** A retried operation reports the ORIGINAL or CURRENT outcome and keeps its
 *   operation identity. This component NEVER generates a new operation id: the only retry affordance
 *   it offers calls `onRetry` with the SAME `operationId` that is already shown, and D-06 makes a
 *   same-id retry a replay of the stored outcome — no second effect. A deliberately new identical
 *   action is a NEW operation id, which this component never invents; it is the leader's own
 *   decision, and the copy says so.
 *
 * - **N-03 / N-10.** No blind repeat with a new key. The conflict copy names re-reading current
 *   state; the unverified copy names "a new operation id is a new action".
 *
 * - **U-M04 last-known data.** `lastKnown` renders a visible badge ("Last known state — connection
 *   reconnecting") so pending or last-known data is never presented as newly confirmed.
 *
 * This is a presentational component: it takes the operation outcome as a prop and renders the
 * label and copy. It performs no mutation, starts no subscription, and does not know how the
 * operation status reached the cockpit — the caller composes it and owns the data source. It is
 * mounted into the MCP connection settings section by issue #114.
 */

/** The U-M07 status set. `conflict` is the N-03 stale-write rejection; `failed` is a genuine
 *  failure AFTER the operation was accepted and ran. They are deliberately different labels. */
export type McpOperationStatus =
  | 'accepted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'conflict'
  | 'unverified'

/** One MCP operation's outcome, as the cockpit has it. */
export interface McpOperation {
  /** The durable operation identity (D-06 § 5.2). Shown, never re-generated, so a retry is a
   *  replay of this exact operation and not a new one. */
  operationId: string
  /** The project action, e.g. `runs.create`. */
  action: string
  /** The U-M07 status. `conflict` is the N-03 stale-write / not-applied rejection; `failed` is a
   *  genuine failure AFTER the operation was accepted and ran. They are deliberately different. */
  status: McpOperationStatus
  /** True when this reports a RETRIED operation — the identity shown is the ORIGINAL one. */
  retried?: boolean
  /** True when the shown data is last-known (the connection is reconnecting / reconciling) and so
   *  must NOT be presented as newly confirmed (U-M04). */
  lastKnown?: boolean
}

export interface McpOperationFeedbackProps {
  operation: McpOperation
  /**
   * A retry affordance. Called with the SAME `operation.operationId` — this component never
   * generates a fresh identity. Omitting it renders no retry control.
   */
  onRetry?: (operationId: string) => void
}

/** The U-M07 short label for each status. An acknowledgement (`accepted`) is NEVER "Completed". */
export const MCP_OPERATION_LABELS: Record<McpOperationStatus, string> = {
  accepted: 'Accepted',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  conflict: 'Conflict — not applied',
  unverified: 'Outcome being verified',
}

/** The statuses for which a retry of the SAME operation identity is a safe, meaningful recovery. */
const RETRYABLE_STATUSES: ReadonlySet<McpOperationStatus> = new Set(['conflict', 'unverified', 'failed'])

function StatusIcon({ status }: { status: McpOperationStatus }) {
  switch (status) {
    case 'completed':
      return <CircleCheckIcon aria-hidden="true" className="size-4 shrink-0 text-primary" />
    case 'failed':
    case 'conflict':
      return <CircleXIcon aria-hidden="true" className="size-4 shrink-0 text-danger" />
    case 'unverified':
      return <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />
    default:
      return <CircleIcon aria-hidden="true" className="size-4 shrink-0 text-soft-foreground" />
  }
}

/** The U-M05 copy. Kept as data so the sharp distinctions cannot drift between the label and the
 *  explanation, and so a test can pin each one. */
function copyFor(operation: McpOperation): string {
  switch (operation.status) {
    case 'accepted':
      return 'The operation was accepted and is being processed. This is an acknowledgement, not a completion — the result is not known yet.'
    case 'running':
      return 'The operation is running.'
    case 'completed':
      return 'The operation completed.'
    case 'failed':
      // U-M05: a failure AFTER execution is distinct from a rejection. The operation WAS accepted
      // and ran; it failed part-way. The leader must still re-read current state before deciding.
      return 'The operation was accepted and ran, but failed after execution. Re-read the current state before deciding again — the operation was applied, so treat it as applied, not as never attempted.'
    case 'conflict':
      // U-M05 / N-03: a stale-write rejection. NOT APPLIED, nothing was overwritten, and the
      // leader must re-read current state. Never confused with a failure after execution.
      return 'The operation was NOT applied — the resource changed after it was read. Nothing was overwritten. Re-read the current state before deciding again.'
    case 'unverified':
      // D-06 § 9: the effect may have happened and nothing has established which. Not applied and
      // not failed: the outcome is uncertain. A NEW operation id is a new action, never a blind repeat.
      return 'The outcome is uncertain and is being verified. Read the current state to determine what happened; a new operation id is a new action.'
  }
}

/** Is this a rejection (refused before any effect) rather than a failure after execution? The
 *  `conflict` status is the N-03 stale-write / not-applied rejection; `failed` is a failure after
 *  execution. Keeping them apart is exactly the sharp U-M05 distinction. */
function isRejection(operation: McpOperation): boolean {
  return operation.status === 'conflict'
}

/**
 * One MCP operation's outcome feedback: the U-M07 label, the operation identity, and the U-M05
 * copy that says plainly what a conflict or a retry did.
 */
export function McpOperationFeedback({ operation, onRetry }: McpOperationFeedbackProps) {
  const label = MCP_OPERATION_LABELS[operation.status]
  const copy = copyFor(operation)
  const rejection = isRejection(operation)
  const retryable = onRetry !== undefined && RETRYABLE_STATUSES.has(operation.status)

  return (
    <div data-testid="mcp-operation-feedback" className="rounded-md border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusIcon status={operation.status} />
          <span data-testid="mcp-operation-label" className="text-sm font-medium text-foreground">
            {label}
          </span>
        </div>
        {operation.lastKnown ? (
          <span
            data-testid="mcp-operation-last-known"
            className="rounded-sm bg-muted px-2 py-0.5 text-[11px] font-medium text-soft-foreground"
          >
            Last known state — connection reconnecting
          </span>
        ) : null}
      </div>

      {/* Operation identity, always shown — a retry is a replay of THIS identity, never a new one. */}
      <p className="mt-2 font-mono text-[11px] break-all text-soft-foreground">
        {operation.action} · {operation.operationId}
      </p>

      <p data-testid="mcp-operation-copy" className="mt-2 text-[13px] leading-relaxed text-foreground">
        {copy}
      </p>

      {/* A retried operation: the identity is the original one, and the outcome shown is the
          original or current one. This is NOT a fresh action. */}
      {operation.retried ? (
        <p data-testid="mcp-operation-retried" className="mt-2 text-[12px] text-muted-foreground">
          Retried with the same operation identity — this is the original or current outcome, not a
          new action.
        </p>
      ) : null}

      {/* The copy that names re-reading current state, for the two states where that is the only
          legitimate next move (N-03 rejection and D-06 unverified). */}
      {rejection ? (
        <p data-testid="mcp-operation-reread" className="mt-2 text-[12px] text-muted-foreground">
          The leader must re-read the current state before deciding again.
        </p>
      ) : null}

      {operation.status === 'unverified' ? (
        <p data-testid="mcp-operation-new-key" className="mt-2 text-[12px] text-muted-foreground">
          Do not blindly repeat this with a new key — read the current state first.
        </p>
      ) : null}

      {retryable ? (
        <button
          type="button"
          data-testid="mcp-operation-retry"
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] font-medium text-foreground hover:bg-muted"
          // D-06: a same-id retry replays the stored outcome — no second effect. This button
          // NEVER generates a new operation identity; it hands back the one already shown.
          aria-label={`Retry operation ${operation.operationId} — reuses the same operation identity`}
          onClick={() => onRetry?.(operation.operationId)}
        >
          <RefreshCwIcon aria-hidden="true" className="size-3.5" />
          Retry
        </button>
      ) : null}
    </div>
  )
}
