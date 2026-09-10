import { createHash } from 'node:crypto';
import {
  MCP_EXECUTION_FAILED_GUIDANCE,
  MCP_STALE_VERSION_GUIDANCE,
  MCP_VERSION_TOKEN_TAG,
  type ExecutionFailed,
  type McpVersionedResourceRef,
  type StaleVersionRejection,
  type VersionedMutationDone,
} from '@qodeca/xezar-contract';
import type { RunRecord, RunStore } from '../runs/store.ts';

/**
 * Stale-write rejection for leader mutations (#100) — the mechanism D-06 chose for N-03
 * (`docs/features/mcp-server/mcp-d06-versioning-idempotency-audit-decision.md` § 4). N-03 is an
 * agreed outcome and nothing here makes it optional: a leader mutation based on state a human has
 * changed since is REFUSED, before any effect. It is never merged, never retried with the fresh
 * token, and never offered to anyone for approval (§ 4.4 rule 3). There is no switch that turns
 * the check off, and there must never be one.
 *
 * Two pieces, deliberately tool-agnostic — this is infrastructure a tool calls, not a tool:
 *
 *  - `versionToken` computes `rev1:<kind>:<id>:<seq>:<digest12>` (§ 4.2) from a resource's
 *    DECISION PROJECTION (§ 4.3): the fields the server reads to judge a mutation plus the fields
 *    it writes, and nothing that moves on its own. A token that included a token counter would go
 *    stale within seconds of an agent emitting anything, and a check that always fails is an outage
 *    people learn to switch off.
 *  - `guardedMutation` is the compare-and-swap (§ 4.5). It reads the current token, compares, and
 *    applies — all in ONE synchronous stretch. Node runs one stretch of synchronous code at a time,
 *    and `ownProjectData` (`runs/project-writer.ts`) keeps a project's state to one writing process,
 *    so no other write can land between the check and the effect. That is also why `apply` must
 *    not be async: an `await` inside it would open exactly the gap the check exists to close.
 *
 * N-02: the effect `apply` performs is the SAME store call the cockpit's route makes — this module
 * wraps the shared service, it never writes JSON or NDJSON itself. The cockpit keeps calling those
 * methods exactly as it does today — requiring a token there would break every existing client —
 * and the leader's write reaches the very same methods, behind this check.
 *
 * U-M05: the result tells the three endings apart — `done`, `conflict` (rejected, NOTHING applied)
 * and `failed` (the effect ran and failed, so the state may have moved). See
 * `packages/contract/src/mcp-versioning.ts` for the shapes.
 */

/** One resource, as the check sees it. Build it from live state on every call — never cache one. */
export interface VersionedSnapshot {
  readonly ref: McpVersionedResourceRef;
  /**
   * For a run-scoped resource, its highest event `seq`; absent for a resource with no event stream
   * (a config file, an automation). This half catches A→B→A — a human who changes something and
   * changes it back leaves the projection byte-identical, but not the event counter, because `seq`
   * is monotonic and never reused, even across a restart (`RunStore.rehydrateSeq`).
   */
  readonly seq?: number;
  /** The decision projection. Canonicalized and digested; its content never leaves this module. */
  readonly projection: unknown;
}

/**
 * JSON with object keys sorted by UTF-16 code unit at every level, arrays kept in order, no
 * whitespace, and `undefined`-valued keys dropped — D-06 § 5.4 step 4, so a token does not depend
 * on the order in which a record's keys happened to be assigned.
 *
 * Serialized by hand rather than by rebuilding an object for `JSON.stringify`: an engine iterates
 * integer-like keys (`"10"`, `"9"`) numerically whatever order they were inserted in, which is not
 * code-unit order.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The token a read hands out and a mutation must echo back. Opaque to every client. */
export function versionToken(snapshot: VersionedSnapshot): string {
  const digest = createHash('sha256').update(canonicalJson(snapshot.projection)).digest('hex').slice(0, 12);
  const seq = snapshot.seq === undefined ? '-' : String(snapshot.seq);
  return `${MCP_VERSION_TOKEN_TAG}:${snapshot.ref.kind}:${snapshot.ref.id}:${seq}:${digest}`;
}

/** What `guardedMutation` answers when the change went through: the contract shape plus the value
 *  `apply` returned, for the calling tool to project onto its own result. */
export type GuardedMutationDone<T> = VersionedMutationDone & { readonly value: T };

export type GuardedMutationResult<T> = GuardedMutationDone<T> | StaleVersionRejection | ExecutionFailed;

/**
 * `apply` has to finish inside the critical section, so an async one is a compile error — this
 * rest parameter demands an impossible extra argument when `apply` returns a promise — and, for a
 * caller that got past the types, a `failed` result at run time.
 */
type SyncOnly<T> = [T] extends [never]
  ? [] // an `apply` that always throws returns `never`, which is assignable to a promise type too
  : [T] extends [PromiseLike<unknown>]
    ? [asyncApplyIsNotAllowed: never]
    : [];

export interface GuardedMutationInput<T> {
  readonly resource: McpVersionedResourceRef;
  /**
   * The token the leader read. A missing one is REFUSED, never waved through: "no token" and "token
   * matches" must not share a branch (D-06 § 4.4 rule 4). The tool schema already requires it; this
   * is the same guarantee for a caller that bypassed the schema.
   */
  readonly expectedVersion: string | undefined;
  /** Reads the resource as it is NOW; `undefined` when it no longer exists. */
  readonly read: () => VersionedSnapshot | undefined;
  /** The effect: the shared store call. Synchronous — see `SyncOnly`. */
  readonly apply: () => T;
}

/**
 * Check the leader's token against the resource's current one and apply the effect only on a match.
 *
 * Never throws for a stale token or a failed effect — both are ANSWERS the leader must reason
 * about, which is why D-05 returns them as ordinary results rather than tool errors.
 */
export function guardedMutation<T>(input: GuardedMutationInput<T>, ..._sync: SyncOnly<T>): GuardedMutationResult<T> {
  const before = input.read();
  const currentVersion = before ? versionToken(before) : undefined;
  // Verbatim comparison is the whole rule, and it covers D-06 § 4.4 rule 5 without parsing: an
  // unparseable, foreign or unknown-tag token can never equal a token this server just minted.
  if (!input.expectedVersion || currentVersion === undefined || input.expectedVersion !== currentVersion) {
    return staleVersionRejection(input.resource, currentVersion);
  }

  let value: T;
  try {
    value = input.apply();
  } catch (error) {
    return executionFailed(input.resource, error);
  }
  if (isThenable(value)) {
    // The effect escaped the critical section. Swallow a later rejection so it cannot crash the
    // process as an unhandled one, and report what is actually known: it ran, and it is not done.
    value.then(undefined, () => undefined);
    return executionFailed(input.resource, new Error('apply returned a promise; a guarded mutation must be synchronous'));
  }

  const after = input.read();
  return {
    status: 'done',
    resource: input.resource,
    ...(after ? { version: versionToken(after) } : {}),
    value,
  };
}

function staleVersionRejection(resource: McpVersionedResourceRef, currentVersion: string | undefined): StaleVersionRejection {
  return {
    status: 'conflict',
    applied: false,
    error: 'stale_version',
    resource,
    // Spread, not `currentVersion: undefined` — a key that is always present in the type but
    // dropped by `JSON.stringify` is exactly the drift the contract-parity rule warns about.
    ...(currentVersion === undefined ? {} : { currentVersion }),
    changedSince: true,
    guidance: MCP_STALE_VERSION_GUIDANCE,
  };
}

function executionFailed(resource: McpVersionedResourceRef, error: unknown): ExecutionFailed {
  // The message stays in the cockpit's own log: it can quote a path or a command line, and nothing
  // secret may reach a tool response (F-15).
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[xez] MCP mutation of ${resource.kind} ${resource.id} failed after execution: ${message}`);
  return {
    status: 'failed',
    executed: true,
    error: 'execution_failed',
    resource,
    guidance: MCP_EXECUTION_FAILED_GUIDANCE,
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

// ---- runs -------------------------------------------------------------------------------------

export const RUN_RESOURCE_KIND = 'run';

/**
 * A run's decision projection (D-06 § 4.3).
 *
 * D-06 proposed `status`, `archived`, `pinned`, `title`, `titleOrigin`, `autoResumeAt`,
 * `queuedMessages[].id`, `steps[].id`/`steps[].status`, `branch` and `workflow`, and left the list
 * to be reviewed against `runRecordSchema`. Reviewed against it, two additions follow from the
 * rule itself — every field a leader mutation of a run WRITES:
 *
 *  - `task`: a queued run's brief stays editable until the scheduler picks it up, and a human
 *    editing it is the "edits its brief" case § 4.1 names;
 *  - `queuedMessages[].text`, not only the id: a queued follow-up is editable in the same way.
 *
 * Left out on purpose: telemetry (`tokensUsed`, `inputTokens`, `outputTokens`, `costUsd`,
 * `peakRssBytes`, `peakProcCount`, `diffStat`, the per-step counters), presentation (`seenAt`, and
 * the `archivedAt`/`pinnedAt` stamps whose flags ARE covered), and everything derived by the server
 * for display (`titleSummary`, the referenced PR/issue tiers).
 */
export function runDecisionProjection(run: RunRecord): unknown {
  return {
    status: run.status,
    archived: run.archived,
    pinned: run.pinned,
    title: run.title,
    titleOrigin: run.titleOrigin,
    autoResumeAt: run.autoResumeAt,
    task: run.task,
    queuedMessages: run.queuedMessages?.map((message) => ({ id: message.id, text: message.text })),
    steps: run.steps.map((step) => ({ id: step.id, status: step.status })),
    branch: run.branch,
    workflow: run.workflow,
  };
}

/**
 * The run's highest event `seq` on disk.
 *
 * D-06 names the highest ALLOCATED seq. The allocation counter is private to the store, so this
 * reads the persisted one: it moves on every persisted event and never goes backwards, which is the
 * property the token needs. The only allocations it cannot see are `emitEphemeral`'s, which are
 * presentation-only and never persisted — § 4.3 would exclude them anyway.
 */
function highestEventSeq(store: RunStore, runId: string): number {
  let max = 0;
  for (const event of store.readEvents(runId)) {
    if (typeof event.seq === 'number' && event.seq > max) max = event.seq;
  }
  return max;
}

/** A run as the check sees it right now, or `undefined` when there is no such run. */
export function runVersionSnapshot(store: RunStore, runId: string): VersionedSnapshot | undefined {
  const run = store.getRun(runId);
  if (!run) return undefined;
  return {
    ref: { kind: RUN_RESOURCE_KIND, id: runId },
    seq: highestEventSeq(store, runId),
    projection: runDecisionProjection(run),
  };
}

/** The `version` a read of this run hands the leader, or `undefined` when there is no such run. */
export function runVersion(store: RunStore, runId: string): string | undefined {
  const snapshot = runVersionSnapshot(store, runId);
  return snapshot ? versionToken(snapshot) : undefined;
}

/**
 * `guardedMutation` for one run: `apply` receives the CURRENT record and performs the shared store
 * call on it (`setPinned`, `updateRun`, …). It is never called when the token is stale.
 */
export function guardedRunMutation<T>(
  store: RunStore,
  runId: string,
  expectedVersion: string | undefined,
  apply: (run: RunRecord) => T,
  ..._sync: SyncOnly<T>
): GuardedMutationResult<T> {
  return guardedMutation<T>({
    resource: { kind: RUN_RESOURCE_KIND, id: runId },
    expectedVersion,
    read: () => runVersionSnapshot(store, runId),
    apply: () => {
      const run = store.getRun(runId);
      // Unreachable after a passing check — the read above found it in this same synchronous
      // stretch — but a missing run must fail loudly rather than hand `apply` an undefined.
      if (!run) throw new Error(`run ${runId} vanished inside the critical section`);
      return apply(run);
    },
  }, ..._sync);
}
