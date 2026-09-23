import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  mcpJournalCursorRejectionSchema,
  operationIdSchema,
  type AuditResource,
  type OperationAnswer,
  type OperationResultRef,
  type McpJournalRow,
  type ProviderStatus,
} from '@qodeca/xezar-contract';
import { collectSecretValues } from '../core/secret-redaction.ts';
import { projectDataDir } from '../project-data-paths.ts';
import type { RunStore } from '../runs/store.ts';
import { activeStateLayout, resolveStateLayout, type StateLayout } from '../state-layout.ts';
import { ProjectOwnership } from '../workspace/project-owner.ts';
import { findRegistryProject } from '../workspace/projects.ts';
import { codexControlHome } from './adapters/codex-link.ts';
import { answerRefusal, classifyMcpCall } from './audit-inventory.ts';
import { conflictRefusalOf, failedAnswerOf, handoffGitRefusalOf } from './audit-answer-refusals.ts';
import { notFoundRefusalOf } from './audit-not-found.ts';
import { AuditTrail, type AuditChannel } from './audit-trail.ts';
import { runBridge, type BridgeOptions, type ServiceTarget } from './bridge.ts';
import { writeMcpConnectionFile } from './connection-file.ts';
import { EchoGuard, operationNotApplied } from './echo-guard.ts';
import { EventCatalog, withEventOrigin, type WorkspaceEventSource } from './event-catalog.ts';
import { EventJournal } from './event-journal.ts';
import { mcpSocketLocation } from './ipc.ts';
import { LeaderDelivery } from './leader-delivery.ts';
import { OperationReceiptStore, runByKeyReconciler, type EffectOutcome } from './operation-receipts.ts';
import { registerProjectCatalog } from './project-catalogs.ts';
import { projectLeaderChanged, registerProjectLeader } from './project-leaders.ts';
import { LeaderCursors, runStateReader } from './reconnect.ts';
import type { ServiceDispatch } from './service-adapter.ts';
import { listenMcpSocket, type McpDoor, type McpServiceHandle } from './service.ts';
import { staleRejectionIn } from './stale-write.ts';
import { errorResult, textResult, type McpToolResult } from './tool.ts';
import { tools } from './tools/index.ts';
import type { LeaderEventsPort } from './tools/leader-events.ts';

/**
 * The MCP module's public surface (#86, D-01). `packages/xezar/src/index.ts` imports
 * it LAZILY from both sides, so an ordinary `serve` that never meets an MCP client
 * pays nothing for it and cannot be broken by it (N-07).
 */

export { runBridge, HEALTH_TOOL, type BridgeOptions, type ServiceTarget } from './bridge.ts';
export { listenMcpSocket, type McpDoor, type McpServiceHandle, type McpServiceOptions } from './service.ts';
export { mcpSocketLocation, IPC_PROTOCOL_VERSION } from './ipc.ts';
export { SUPPORTED_PROTOCOL_VERSIONS, SERVER_CAPABILITIES, negotiateProtocolVersion } from './protocol.ts';
export { defineTool, textResult, errorResult, type McpTool, type McpToolContext, type McpToolResult } from './tool.ts';

export interface StartMcpServiceOptions {
  readonly projectId: string;
  readonly version: string;
  /** The running app's in-process entry: every tool dispatches into the cockpit's own routes (N-02). */
  readonly service?: ServiceDispatch;
  /** The project's own store — the one the cockpit writes. The catalog listens to it, and
   *  receipts reconcile a run against it. */
  readonly store?: RunStore;
  /** The host-wide workspace bus: the catalog's E-06 source (`provider-status`). */
  readonly workspaceEvents?: WorkspaceEventSource;
  /** Provider rows as they are now — the catalog's E-06 baseline. A failure means "no baseline". */
  readonly providerBaseline?: () => Promise<readonly ProviderStatus[]>;
  /** Test seams, as for `listenMcpSocket`. Production uses the process's own. */
  readonly ownership?: ProjectOwnership;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly warn?: (message: string) => void;
  /** Test seam: the event controller's heartbeat (#309). Production uses its 30 s. */
  readonly leader?: { readonly heartbeatMs?: number; readonly pushNotSeenMs?: number };
  readonly localHandoff?: () => boolean;
  /**
   * Every journal row as it is durably appended — the terminal's activity lines (#467). Live rows
   * only, never a replay; released with the service. A listener's throw never reaches the journal.
   */
  readonly onEventRow?: (row: McpJournalRow) => void;
}

/**
 * Service side: compose the MCP service for a registered project and open its socket (#243).
 * Throws a one-line error when the socket cannot open; the cockpit turns that into one warning
 * and keeps booting (N-07). Everything composed here is released by the handle's `close()`, and
 * by the throw itself when the socket fails — nothing outlives either.
 *
 * The composition lives HERE, once, because the stdio bridge (`runMcpCommand`) executes nothing:
 * it forwards every call to this socket, so both doors get exactly this behaviour.
 */
export async function startMcpService(opts: StartMcpServiceOptions): Promise<McpServiceHandle> {
  const project = await findRegistryProject({ id: opts.projectId });
  if (!project) throw new Error(`project ${opts.projectId} is not in the workspace registry`);
  const providerBaseline = await opts.providerBaseline?.().catch(() => undefined);
  const dataDir = opts.store?.dataDir ?? projectDataDir(project.root);
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const parts = composeDoor({
    projectId: project.id,
    dataDir,
    store: opts.store,
    workspaceEvents: opts.workspaceEvents,
    providerBaseline,
    env: opts.env ?? process.env,
    warn,
  });
  const stopRows = parts.journal && opts.onEventRow ? parts.journal.subscribe(opts.onEventRow) : undefined;
  // Built here rather than by the socket, because push delivery reads it too (#309). It writes
  // nothing until a session opens.
  const ownership = opts.ownership ?? new ProjectOwnership({ dataDir, projectId: project.id });
  // Push delivery (#309): every owner session gets an event controller, on by default. It needs the
  // journal; without one there is nothing to deliver, and that was already one warning above.
  const delivery = parts.journal
    ? new LeaderDelivery({
        projectId: project.id,
        projectRoot: project.root,
        journal: parts.journal,
        ownership,
        guard: parts.guard,
        // One acknowledgement (#332): the leader's pull record is what push resumes by, filters by and reports.
        ...(parts.cursors ? { leaderRecord: parts.cursors } : {}),
        warn,
        ...(opts.leader?.heartbeatMs === undefined ? {} : { heartbeatMs: opts.leader.heartbeatMs }),
        ...(opts.leader?.pushNotSeenMs === undefined ? {} : { pushNotSeenMs: opts.leader.pushNotSeenMs }),
        ...(opts.localHandoff === undefined ? {} : { localHandoff: opts.localHandoff }),
        // Where a Codex leader's shared app-server is looked for: THIS process's Codex home.
        codexLeader: { home: () => codexControlHome(opts.env ?? process.env) },
        // The cockpit's `mcp-leader` topic re-derives this project's status when it may have changed.
        onStatusChange: () => projectLeaderChanged(project.id),
      })
    : undefined;
  const unregisterLeader = delivery ? registerProjectLeader(project.id, delivery) : undefined;
  // Controllers and any leader first, while the journal they read is still open.
  const closeDelivery = (): void => {
    stopRows?.();
    unregisterLeader?.();
    delivery?.close();
  };
  try {
    const socket = await listenMcpSocket({
      project: { id: project.id, name: projectName(project), root: project.root },
      version: opts.version,
      tools,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.platform ? { platform: opts.platform } : {}),
      context: {
        ...(opts.service ? { service: opts.service } : {}),
        ...(parts.leaderEvents ? { leaderEvents: parts.leaderEvents } : {}),
        // #450: `leader_events` attach, stop and status reach the same delivery path as the route.
        ...(delivery ? { leaderControl: delivery } : {}),
      },
      door: parts.door,
      // The owner claims live beside the store the cockpit writes (D-02.8).
      dataDir,
      ownership,
      ...(delivery
        ? {
            sessions: {
              // #374: the transport lets the delivery seam push a channel event down this owner
              // session's own bridge connection; the Codex announcement is the thread id its tool
              // calls carry.
              opened: (key, transport) => delivery.sessionOpened(key, transport),
              closed: (key) => delivery.sessionClosed(key),
              codexAnnounced: (key, announcement) => delivery.codexAnnounced(key, announcement),
              // #450: answered in `session/open`, so the bridge registers the channel only when a push can arrive.
              pushCapability: (key, transport) => delivery.pushCapability(key, transport),
              // #886: every tool call, with its tool and action, is the owner's activity signal for the push-not-seen blocker.
              called: (key, call) => delivery.sessionCalled(key, call),
              // #886: a read counts only once it validated and answered (#890 re-check), and only for the rows it replayed (round 3).
              succeeded: (key, call, result) => delivery.sessionSucceeded(key, call, result),
            },
          }
        : {}),
    });
    // D-04: written once the socket it names really listens, so the file never points at nothing.
    // A failure is one warning and an MCP the client can still reach by the registry (N-07).
    try {
      writeMcpConnectionFile({ project: { id: project.id, root: project.root }, dataDir, socket: socket.path });
    } catch (err) {
      warn(
        `[xez] MCP connection file not written (${err instanceof Error ? err.message : String(err)}) — MCP tools keep working without it`,
      );
    }
    return {
      path: socket.path,
      close() {
        // The socket first: no call may start while its parts are going away.
        socket.close();
        closeDelivery();
        parts.close();
      },
    };
  } catch (err) {
    closeDelivery();
    // The socket never opened, so nothing else will dispose the owner slot it would have enforced.
    if (!opts.ownership) ownership.dispose();
    parts.close();
    throw err;
  }
}

interface DoorInput {
  projectId: string;
  dataDir: string;
  store: RunStore | undefined;
  workspaceEvents: WorkspaceEventSource | undefined;
  providerBaseline: readonly ProviderStatus[] | undefined;
  env: NodeJS.ProcessEnv;
  warn: (message: string) => void;
}

/**
 * The parts that act on every MCP call, and the door that applies them. Each part is optional in
 * the zero-config sense: one that cannot open is ONE warning and a smaller MCP, never a failed
 * start — the tools keep working, exactly as they did before any part existed.
 *
 * - the project's event journal (#103), opened with this host's real secret list (F-15);
 * - the E-01–E-06 catalog (#104), deriving rows from the SAME store and workspace bus the cockpit
 *   drives (N-02); every MCP mutation runs inside `withEventOrigin`, so a change it causes is
 *   the leader's, with the operation that caused it;
 * - operation receipts (#101) for every call that carries an `operationId`;
 * - the echo guard (#106): the operation is recorded as this leader's own BEFORE it runs;
 * - the audit trail (#102, #306), stamped `mcp` because this is the MCP door (D-06 § 10.4 rule 1),
 *   written to `audit.ndjson` as v2 records. WHICH calls it records, and under which action id, is
 *   the shared inventory's decision (`audit-inventory.ts`, spec § 6), not a tool annotation: a read
 *   action inside a mutating tool writes nothing, and a mutation gets the id the cockpit door uses.
 *
 * Read-only tools pass straight through: a read has no effect to deduplicate, attribute or audit.
 *
 * The audit trail counts OPERATIONS, not calls, so what the door records depends on which of the
 * three `DoorAttempt` shapes this call was (#743).
 *
 * Two more parts face outward rather than wrapping a call:
 * - the catalog is registered as the project's E-05 reporter (#252), so the cockpit's own config,
 *   workflow and agent-config write routes can report a human change to it;
 * - the leader's persisted cursors (#105) and the `leader_events` port over them (#251), handed to
 *   the tools as context — the leader's pull read of its journal on reconnect.
 */
/**
 * What one call through the door actually did (#743): `ran` the tool, ran it and it `failed` under
 * this call, was `refused` by the receipt layer before any effect, or was answered from an existing
 * operation receipt and `replayed` — running nothing.
 *
 * Only `ran` settles the trail with the tool's own outcome. `failed` has no honest v2 outcome (spec
 * § 3.2). `replayed` was already settled by the call that ran the effect, so a second row would
 * over-report one operation. `refused` is the one the first version of this fix got wrong: the
 * receipt layer also answers a FIRST attempt it would not let start — an unwritable operation
 * journal, or the same key reused for different work — and that attempt is unaudited by anyone,
 * so it is the door's to record, as v2's `refused` (spec § 3.2).
 *
 * `refused` carries its own bounded reason rather than leaving it in a second variable beside it:
 * a refusal without a reason is not a state this door can be in, and the one shape says so.
 */
type DoorAttempt = { kind: 'ran' | 'failed' | 'replayed' } | { kind: 'refused'; reason: string };

function composeDoor(input: DoorInput): {
  door: McpDoor;
  leaderEvents: LeaderEventsPort | undefined;
  /** For push delivery (#309): the rows it follows, and the guard that knows the leader's own operations. */
  journal: EventJournal | undefined;
  guard: EchoGuard | undefined;
  /** The leader's pull cursors — whose acknowledgement push delivery honours too (#332). */
  cursors: LeaderCursors | undefined;
  close(): void;
} {
  const { projectId, dataDir, store, workspaceEvents, providerBaseline, warn } = input;
  const closers: Array<() => void> = [];
  const attempt = <T>(what: string, open: () => T): T | undefined => {
    try {
      return open();
    } catch (err) {
      warn(`[xez] MCP ${what} unavailable (${err instanceof Error ? err.message : String(err)}) — MCP tools keep working without it`);
      return undefined;
    }
  };

  const secretValues = collectSecretValues(input.env);
  const journal = attempt('event journal', () => EventJournal.open({ dataDir, projectId, secretValues, warn }));
  if (journal) closers.push(() => journal.close());
  // Pushed after the journal, so it detaches first: no row can reach a closed journal.
  const catalog =
    journal && store
      ? attempt('event catalog', () =>
          EventCatalog.attach({
            journal,
            store,
            ...(workspaceEvents ? { workspaceEvents } : {}),
            ...(providerBaseline ? { providerBaseline } : {}),
            warn,
          }),
        )
      : undefined;
  if (catalog) {
    closers.push(() => catalog.detach());
    // Pushed after the catalog, so the routes stop reaching it before it detaches.
    closers.push(registerProjectCatalog(projectId, catalog));
  }
  const cursors =
    journal && store ? attempt('leader cursors', () => LeaderCursors.open({ dataDir, projectId, journal, warn })) : undefined;
  const leaderEvents: LeaderEventsPort | undefined =
    journal && store && cursors ? { journal, cursors, readState: runStateReader(store, journal), secretValues } : undefined;

  const receipts = attempt('operation receipts', () =>
    OperationReceiptStore.open(dataDir, {
      ...(store
        ? {
            reconcilers: { 'run-by-key': runByKeyReconciler(store) },
            isResultLive: (ref: OperationResultRef) => ref.kind === 'run' && store.getRun(ref.id) !== undefined,
          }
        : {}),
    }),
  );
  if (receipts) {
    // Background, never awaited (D-06 § 9.3 rule 1): until it settles a receipt reads `unverified`.
    void receipts.reconcilePending().catch(() => undefined);
    closers.push(() => receipts.close());
  }
  const guard = attempt('echo guard', () => new EchoGuard({ projectId }));
  // The service's own env secrets are this door's secrets: masked before the digest, like the host's (#306 part 4).
  const audit = attempt('audit trail', () =>
    new AuditTrail({ projectId, dataDir }, { warn, secretValues: () => secretValues }).channel('mcp'),
  );

  const door: McpDoor = async ({ tool, args }, invoke) => {
    if (tool.annotations?.readOnlyHint === true) return invoke();
    const operationId = operationIdOf(args);
    const action = actionId(tool.name, args.action);
    const target = targetOf(args);
    // The origin is the door's, never the client's (D-05 § 6.3): every mutation through here is the
    // leader's. Since #264 every MUTATING action of every tool carries a client `operationId`
    // (D-06 § 5.2), so the mint below is what covers the read actions a mutating tool also has
    // (`organise_work list_queue`, `handoff_git repo`, `leader_events read`, the `project_config`
    // reads and refusals): they still need an origin for the catalog and the echo guard, and they
    // deliberately reach no receipt, because only a client key may create one.
    const causedBy = operationId ?? `mcp-door.${randomUUID()}`;
    const marked = (): Promise<McpToolResult> =>
      withEventOrigin({ origin: 'leader', causedBy, ...(target ? { runId: target.id } : {}) }, invoke);
    const issued = guard ? () => guard.issue(causedBy, marked) : marked;
    // The audit's own classification, from the shared inventory. The receipt keeps `action`, its
    // historical key: changing it would split an idempotency key across versions.
    const audited = classifyMcpCall(tool.name, args);
    const auditFor = audited.kind === 'mutation' ? audit : undefined;
    const op = {
      action,
      payload: args,
      ...(operationId === undefined ? {} : { operationId }),
      ...(target ? { resource: target } : {}),
      // The version the leader's decision was based on (#250); the trail keeps it only in `rev1` shape.
      ...(typeof args.expectedVersion === 'string' ? { expectedVersion: args.expectedVersion } : {}),
    };
    let result: McpToolResult;
    // What THIS call was: did it run the tool, did the tool throw under it, or did the receipt
    // layer answer it without running anything (#743)? Only the first settles the trail.
    let attempt: DoorAttempt = { kind: 'ran' };
    try {
      if (operationId !== undefined && receipts) {
        const run = await idempotent(receipts, { projectId, operationId, action, args, toolName: tool.name, issued, warn });
        result = run.result;
        attempt = run.attempt;
      } else {
        result = await issued();
      }
    } catch (err) {
      // The effect may have started: v2 has no honest outcome for that, so no record (spec § 3.2).
      auditFor?.skip('effect_failed');
      throw err;
    }
    if (audited.kind !== 'mutation' || !auditFor) return result;
    // The same rule as the `catch` above, for a throw the receipt layer swallowed into an
    // `unverified` answer: the effect may have started, so there is no honest outcome (spec § 3.2).
    if (attempt.kind === 'failed') {
      auditFor.skip('effect_failed');
      return result;
    }
    // A first attempt the receipt layer refused BEFORE any effect: the journal could not take its
    // intent (D-06 § 7.5), or the key was reused for different work (§ 6). Nothing ran and no
    // earlier call recorded this one, so it is neither a replay nor unrecordable — it is exactly
    // what v2's `refused` is for, "the door rejected it before any effect" (spec § 3.2). Recording
    // it is also what keeps the audit-gap warning: `record` warns on its own when even this row
    // cannot be written, where `return result` here would leave the whole call unaccounted for and
    // silent. `resolve(undefined)` on purpose — the answer is the receipt layer's, not the tool's.
    if (attempt.kind === 'refused') {
      await auditFor.record({ ...op, action: audited.resolve(undefined) }, { outcome: 'refused', reason: attempt.reason });
      return result;
    }
    // A replay, a duplicate still in flight and an unverified crash leftover are answered from the
    // receipt without re-running the effect (D-06 § 6). The call that DID run the effect is the one
    // that settles the trail, so recording here would put a second `applied` row in the trail for
    // one operation and over-report what happened (#743). It is not `skip` either: nothing is
    // unrecordable, so the trail's one warning would be a lie.
    if (attempt.kind === 'replayed') return result;
    const recorded = { ...op, action: audited.resolve(result) };
    // v2 has two outcomes, `applied` and `refused`, and `refused` promises nothing happened. So an
    // error result is recorded only when the tool itself says, in its structured answer, that it
    // refused before any effect; any other error may have come after the effect started, and the
    // door records nothing rather than guess (spec § 3.2) — one warning per process says so.
    // Two refusals are recognised: the stale-version rejection (#250), which the ROUTE refused
    // before any effect and which is a non-error answer (recording it as `applied` would put a write
    // that never happened into the trail, D-06 § 4.4 rule 6); and a `project_config` boundary
    // refusal (`refused: true` with its `boundary`), which dispatched nothing (spec § 6.2).
    const resource = resourceOf(result);
    const stale = staleRejectionOf(result);
    const boundary =
      boundaryRefusalOf(result) ??
      routeRefusalOf(result) ??
      cursorRefusalOf(result) ??
      notPerformedOf(result) ??
      // A target this project does not have, looked up before any effect (#573).
      notFoundRefusalOf(tool.name, args.action, result) ??
      // An ordinary answer that says nothing was done: a conflict, or a hand-off refused before its effect (#577).
      conflictRefusalOf(result) ??
      handoffGitRefusalOf(tool.name, result) ??
      (result.isError ? undefined : answerRefusal(recorded.action, result.structuredContent?.result));
    // Awaited, so the record is on disk when the leader sees the answer; `record` never rejects and
    // resolves within the lock's 2 s bound, so the answer itself never depends on it.
    if (stale) await auditFor.record(recorded, { outcome: 'refused', reason: 'stale_version', resource: stale.resource });
    else if (boundary) await auditFor.record(recorded, { outcome: 'refused', reason: boundary });
    // A hand-off that failed in a way that may have followed its effect: no honest outcome, no record (#577).
    else if (result.isError || failedAnswerOf(tool.name, result)) auditFor.skip('tool_error');
    else await auditFor.record(recorded, { outcome: 'applied', ...(resource ? { resource } : {}) });
    return result;
  };

  let closed = false;
  return {
    door,
    leaderEvents,
    journal,
    guard,
    cursors,
    close() {
      if (closed) return;
      closed = true;
      for (const close of closers.splice(0).reverse()) {
        try {
          close();
        } catch (err) {
          warn(`[xez] MCP shutdown step failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  };
}

/**
 * Run one call under its operation key (D-06 § 6). The call that runs the tool answers with the
 * tool's own result, unchanged; every other answer — a replay, a duplicate still in flight, an
 * unverified crash leftover, a key reused for different work — is the receipt layer's own shape.
 *
 * `attempt` says which of those this call was, because the audit trail records the call that ran
 * the effect and nothing else (#743). `failed` is the effect that threw: the receipt layer swallows
 * that throw into an `unverified` answer, so without this the door could not tell it from a replay.
 * `refused` is the other answer that is not a replay: the two `error` shapes of `OperationAnswer`
 * are pre-effect refusals of a FIRST attempt (`operation_receipt_unavailable` when the intent
 * cannot be appended, `operation_key_conflict` when the key was reused for different work), and
 * no earlier call recorded them. Calling either a replay drops them out of the trail entirely,
 * which is what the review of #743's first fix found.
 *
 * The three answers that stay row-free are the genuinely already-accounted ones: a settled receipt
 * replayed, a duplicate `in-progress` behind a live first attempt, and an `unverified` uncertain
 * history — none of which is this call's to record.
 */
async function idempotent(
  receipts: OperationReceiptStore,
  call: {
    projectId: string;
    operationId: string;
    action: string;
    args: Record<string, unknown>;
    toolName: string;
    issued: () => Promise<McpToolResult>;
    warn: (message: string) => void;
  },
): Promise<{ result: McpToolResult; attempt: DoorAttempt }> {
  let fresh: McpToolResult | undefined;
  let threw = false;
  const answer = await receipts.execute({
    projectId: call.projectId,
    operationId: call.operationId,
    action: call.action,
    payload: call.args,
    reconcile: { kind: 'none' },
    effect: async (): Promise<EffectOutcome> => {
      try {
        fresh = await call.issued();
      } catch (err) {
        // The receipt layer answers `unverified` and swallows the throw, so the log line the
        // service would have written for it is written here (the text never reaches the client).
        threw = true;
        call.warn(`[xez] MCP tool ${call.toolName} failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      // A structured no-effect refusal is known, even without MCP's isError flag (#536).
      if (fresh.isError || operationNotApplied(fresh)) return { outcome: 'rejected', errorCode: 'tool refused' };
      const ref = resourceOf(fresh);
      return { outcome: 'ok', resultRef: ref ? { kind: ref.kind, id: ref.id } : { kind: 'operation', id: call.operationId } };
    },
  });
  if (fresh !== undefined) return { result: fresh, attempt: { kind: 'ran' } };
  if (threw) return { result: answerResult(answer), attempt: { kind: 'failed' } };
  return { result: answerResult(answer), attempt: receiptAttemptOf(answer) };
}

/**
 * Classify every receipt-layer answer that did not run an effect in this call. The settled
 * answers are row-free only when they are genuine replays; a live duplicate and uncertain
 * history are row-free because another call owns the effect (or nobody can honestly settle it).
 * Every remaining answer is a pre-effect refusal owned by this call.
 *
 * The reasons are the receipt layer's own words, narrowed to `auditReasonSchema`'s shape and
 * prefixed so a reader can tell WHICH layer refused — a `journal_unwritable` in the trail would
 * otherwise read as the audit trail's own journal rather than the operation journal. Both
 * switches deliberately end in `never`: extending `OperationAnswer` must fail compilation until
 * the new answer is explicitly classified, rather than silently becoming a row-free replay.
 */
function receiptAttemptOf(answer: OperationAnswer): DoorAttempt {
  if ('error' in answer) {
    switch (answer.error) {
      case 'operation_receipt_unavailable':
        return { kind: 'refused', reason: `receipt_${answer.reason}` };
      case 'operation_key_conflict':
        return { kind: 'refused', reason: 'receipt_key_conflict' };
      default: {
        const unlisted: never = answer;
        return unlisted;
      }
    }
  }

  switch (answer.status) {
    case 'ok':
    case 'rejected':
    case 'not-applied':
      return answer.replayed ? { kind: 'replayed' } : { kind: 'refused', reason: 'receipt_unexpected_answer' };
    case 'in-progress':
    case 'unverified':
      return { kind: 'replayed' };
    default: {
      const unlisted: never = answer;
      return unlisted;
    }
  }
}

function answerResult(answer: OperationAnswer): McpToolResult {
  const body = answer as unknown as Record<string, unknown>;
  const refused = 'error' in answer || answer.status === 'rejected';
  return refused ? errorResult(JSON.stringify(body), body) : textResult(JSON.stringify(body), body);
}

function operationIdOf(args: Record<string, unknown>): string | undefined {
  const parsed = operationIdSchema.safeParse(args.operationId);
  return parsed.success ? parsed.data : undefined;
}

/**
 * `task_create` + `start_from_inbox` → `taskCreate.startFromInbox`: the operation receipt's action key.
 * The audit trail no longer uses it (#306 part 2): its action id comes from `audit-inventory.ts`.
 */
function actionId(toolName: string, action: unknown): string {
  const camel = (name: string): string => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return `${camel(toolName)}.${typeof action === 'string' ? camel(action) : 'call'}`;
}

/** The task a call names, when it names one — the tools spell it `runId` or `taskId`. */
function targetOf(args: Record<string, unknown>): AuditResource | undefined {
  const id = typeof args.runId === 'string' ? args.runId : typeof args.taskId === 'string' ? args.taskId : undefined;
  return id === undefined ? undefined : { kind: 'run', id };
}

/** The stale-version rejection a tool relayed, if that is what its (non-error) answer is. */
function staleRejectionOf(result: McpToolResult) {
  if (result.isError) return undefined;
  const block = result.content[0];
  if (!block || block.type !== 'text') return undefined;
  try {
    return staleRejectionIn(JSON.parse(block.text));
  } catch {
    return undefined;
  }
}

/**
 * The boundary a `project_config` refusal names (`refused: true`, `boundary: 'workspace-settings'`),
 * as a v2 reason (`workspace_settings`). Such an answer dispatched nothing, so it is a real refusal.
 */
function boundaryRefusalOf(result: McpToolResult): string | undefined {
  if (!result.isError) return undefined;
  const content = result.structuredContent;
  if (content?.refused !== true || typeof content.boundary !== 'string') return undefined;
  return /^[a-z][a-z-]{0,63}$/.test(content.boundary) ? content.boundary.replace(/-/g, '_') : undefined;
}

/**
 * A route's own 4xx that a tool relayed as its structured answer (`project_config` puts the
 * route's `status` there). The routes validate and refuse before any effect, so this is the same
 * refusal the cockpit door records for that route, with the same `http_<status>` reason.
 */
function routeRefusalOf(result: McpToolResult): string | undefined {
  if (!result.isError) return undefined;
  const status = result.structuredContent?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500 ? `http_${status}` : undefined;
}

/**
 * A handoff answer that says, in its structured content, that it did nothing (`performed: false`) —
 * a refusal, an unavailable host capability, or a no-terminal fallback. Such an answer is not an MCP
 * error (D-05: a conflict is something to reason about), so without this it would be recorded as
 * `applied`. The reason is the route's status when it gave one, otherwise the answer's outcome.
 */
function notPerformedOf(result: McpToolResult): string | undefined {
  const content = result.structuredContent;
  if (content?.performed !== false) return undefined;
  const status = content.httpStatus;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500) return `http_${status}`;
  return typeof content.outcome === 'string' && /^[a-z][a-z_-]{0,63}$/.test(content.outcome)
    ? content.outcome.replace(/-/g, '_')
    : 'not_performed';
}

/** A leader cursor the journal refused outright (`invalid_cursor`): nothing was acknowledged. */
function cursorRefusalOf(result: McpToolResult): string | undefined {
  if (!result.isError) return undefined;
  const parsed = mcpJournalCursorRejectionSchema.safeParse(result.structuredContent);
  return parsed.success ? parsed.data.error : undefined;
}

/** The resource a result names: a tool's `subject`, or a receipt's `resultRef`. */
function resourceOf(result: McpToolResult): AuditResource | undefined {
  const content = result.structuredContent;
  const subject = content?.subject as { type?: unknown; id?: unknown } | undefined;
  if (typeof subject?.type === 'string' && typeof subject.id === 'string') return { kind: subject.type, id: subject.id };
  const ref = content?.resultRef as { kind?: unknown; id?: unknown } | undefined;
  if (typeof ref?.kind === 'string' && typeof ref.id === 'string') return { kind: ref.kind, id: ref.id };
  return undefined;
}

/**
 * `xez mcp` — spawned by an MCP client with the session's project as its working
 * directory (D-01 § 4). Serves MCP on stdio until the client closes stdin.
 */
export async function runMcpCommand(opts: {
  repoRoot: string;
  version: string;
  /** Told how the first `session/open` settled — the `cli.mcp` audit record (#306 part 2). */
  onSessionOpen?: BridgeOptions['onSessionOpen'];
}): Promise<void> {
  // stdout carries JSON-RPC and nothing else: one stray log line from any module
  // would corrupt the client's stream. Diagnostics go to stderr, which clients log.
  const toStderr = (...args: unknown[]): void => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  await runBridge({
    input: process.stdin,
    output: process.stdout,
    version: opts.version,
    tools,
    resolveTarget: () => resolveMcpTarget(opts.repoRoot),
    ...(opts.onSessionOpen ? { onSessionOpen: opts.onSessionOpen } : {}),
  });
}

/**
 * The cwd only FINDS the socket; it never becomes the authority (D-01 § 4). A read of
 * the registry: the bridge registers nothing, so a directory xezar has never served
 * finds no project and answers with how to fix that.
 *
 * The state layout is re-resolved here, on every session open, for the bridge's OWN
 * folder (#819 item 5). The process layout was decided once at bridge start, so a
 * client session started before `xezar --single-project` created the folder's
 * `workspace.json` kept reading the global registry and `~/.xezar/ipc` until the client
 * restarted the bridge. `argv` and `env` are the bridge's launch inputs, so an explicit
 * global request still wins exactly as it did at start.
 */
export async function resolveMcpTarget(
  repoRoot: string,
  launch: { argv?: readonly string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<ServiceTarget> {
  const root = await realpath(repoRoot).catch(() => resolve(repoRoot));
  const layout = bridgeLayout(root, launch.argv ?? process.argv.slice(2), launch.env ?? process.env);
  const project = await findRegistryProject({ root }, layout);
  if (!project) {
    return {
      kind: 'unavailable',
      status: 'not-registered',
      message:
        'This directory is not a xezar project yet. Start the cockpit here once with `xez` (or `npx @qodeca/xezar`) so it is registered, then call this tool again.',
    };
  }
  const location = mcpSocketLocation(project, launch.env ?? process.env, process.platform, layout);
  if (location.kind === 'unavailable') return { kind: 'unavailable', status: 'unsupported', message: location.reason };
  return { kind: 'socket', path: location.path, project: { id: project.id, name: projectName(project) } };
}

/**
 * The layout the bridge looks in for this session open. Only global → project ever
 * changes under a running bridge (the marker appears; nothing removes it from under a
 * live engine), so a bridge already in its folder's project layout keeps it. Otherwise
 * the same pure resolver the boot used answers again for the same folder.
 *
 * Deliberately NOT installed with `setActiveStateLayout`: the answer is passed to the
 * two lookups that need it, so the process-wide layout never moves mid-flight (#600
 * DC-1) and the resolution for one folder can never leak into another's.
 */
function bridgeLayout(root: string, argv: readonly string[], env: NodeJS.ProcessEnv): StateLayout {
  const active = activeStateLayout(env);
  return active.mode === 'project' ? active : resolveStateLayout(root, argv, env);
}

function projectName(project: { name: string; root: string }): string {
  return project.name || basename(project.root);
}
