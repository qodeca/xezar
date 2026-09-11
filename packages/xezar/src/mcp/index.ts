import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  operationIdSchema,
  type AuditResource,
  type OperationAnswer,
  type OperationResultRef,
  type ProviderStatus,
} from '@qodeca/xezar-contract';
import { collectSecretValues } from '../core/secret-redaction.ts';
import { projectDataDir } from '../project-data-paths.ts';
import type { RunStore } from '../runs/store.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { ProjectOwnership } from '../workspace/project-owner.ts';
import { AuditTrail, type AuditChannel } from './audit-trail.ts';
import { runBridge, type ServiceTarget } from './bridge.ts';
import { writeMcpConnectionFile } from './connection-file.ts';
import { EchoGuard } from './echo-guard.ts';
import { EventCatalog, withEventOrigin, type WorkspaceEventSource } from './event-catalog.ts';
import { EventJournal } from './event-journal.ts';
import { mcpSocketLocation } from './ipc.ts';
import { LeaderDelivery } from './leader-delivery.ts';
import { OperationReceiptStore, runByKeyReconciler, type EffectOutcome } from './operation-receipts.ts';
import { registerProjectCatalog } from './project-catalogs.ts';
import { registerProjectLeader } from './project-leaders.ts';
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
  /**
   * Test seams for the leader session xezar starts (#309): how it starts `xez mcp`, which `claude`
   * and `codex` it runs, and the controller's heartbeat. Production uses this process's own CLI
   * and resolves both binaries exactly as the runners do.
   */
  readonly leader?: {
    readonly bridge?: { readonly command: string; readonly args: readonly string[] };
    readonly claudeBin?: string;
    readonly codexBin?: string;
    readonly heartbeatMs?: number;
  };
}

/**
 * How THIS installation starts `xez mcp` (D-01 § 1.7): the same node, loader flags and CLI entry
 * that are serving now, so a leader xezar starts talks to this very xezar, whatever the version on
 * PATH. Debugger flags are dropped: a second process must not fight for the inspector port.
 *
 * A loader named by a bare package name (`--import tsx`, the dev server) is resolved to its file
 * HERE: Node resolves it from the working directory, and the leader runs in the PROJECT's, where
 * `tsx` does not exist — observed, the leader then started with no xezar tools at all. The built
 * CLI has no loader flag, so this only ever changes a dev run.
 */
function ownBridgeCommand(): { command: string; args: string[] } {
  const entry = process.argv[1];
  if (entry === undefined) return { command: 'xez', args: ['mcp'] };
  const flags = process.execArgv.filter((flag) => !flag.startsWith('--inspect'));
  const loaders = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader']);
  const args = flags.map((flag, i) => {
    const [name, inline] = flag.includes('=') ? [flag.slice(0, flag.indexOf('=')), flag.slice(flag.indexOf('=') + 1)] : [flag, undefined];
    if (inline !== undefined) return loaders.has(name) ? `${name}=${resolveLoader(inline)}` : flag;
    return i > 0 && loaders.has(flags[i - 1]!) ? resolveLoader(flag) : flag;
  });
  return { command: process.execPath, args: [...args, entry, 'mcp'] };
}

/** A bare loader name → the file it resolves to from here; anything else, or a failure, unchanged. */
function resolveLoader(specifier: string): string {
  if (/^(\.|\/|[a-z]+:)/i.test(specifier)) return specifier;
  try {
    return import.meta.resolve(specifier);
  } catch {
    return specifier;
  }
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
  const project = (await loadWorkspaceConfig()).projects.find((p) => p.id === opts.projectId);
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
        bridge: opts.leader?.bridge ?? ownBridgeCommand(),
        warn,
        ...(opts.leader?.claudeBin === undefined ? {} : { claudeBin: opts.leader.claudeBin }),
        ...(opts.leader?.codexBin === undefined ? {} : { codexBin: opts.leader.codexBin }),
        ...(opts.leader?.heartbeatMs === undefined ? {} : { heartbeatMs: opts.leader.heartbeatMs }),
        ...(opts.env ? { env: opts.env } : {}),
      })
    : undefined;
  const unregisterLeader = delivery ? registerProjectLeader(project.id, delivery) : undefined;
  // Controllers and any leader first, while the journal they read is still open.
  const closeDelivery = (): void => {
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
      },
      door: parts.door,
      // The owner claims live beside the store the cockpit writes (D-02.8).
      dataDir,
      ownership,
      ...(delivery ? { sessions: { opened: (key: string) => delivery.sessionOpened(key), closed: (key: string) => delivery.sessionClosed(key) } } : {}),
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
 * - the audit trail (#102), stamped `mcp` because this is the MCP door (D-06 § 10.4 rule 1).
 *
 * Read-only tools pass straight through: a read has no effect to deduplicate, attribute or audit.
 *
 * Two more parts face outward rather than wrapping a call:
 * - the catalog is registered as the project's E-05 reporter (#252), so the cockpit's own config,
 *   workflow and agent-config write routes can report a human change to it;
 * - the leader's persisted cursors (#105) and the `leader_events` port over them (#251), handed to
 *   the tools as context — the leader's pull read of its journal on reconnect.
 */
function composeDoor(input: DoorInput): {
  door: McpDoor;
  leaderEvents: LeaderEventsPort | undefined;
  /** For push delivery (#309): the rows it follows, and the guard that knows the leader's own operations. */
  journal: EventJournal | undefined;
  guard: EchoGuard | undefined;
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
  const audit = attempt('audit trail', () => new AuditTrail({ projectId, dataDir }, { warn }).channel('mcp'));

  const door: McpDoor = async ({ tool, args }, invoke) => {
    if (tool.annotations?.readOnlyHint === true) return invoke();
    const operationId = operationIdOf(args);
    const action = actionId(tool.name, args.action);
    const target = targetOf(args);
    // The origin is the door's, never the client's (D-05 § 6.3): every mutation through here is the
    // leader's. A tool without an `operationId` field still needs one for the catalog and the echo
    // guard, so the door mints it; it never reaches a receipt, which only a client key may create.
    const causedBy = operationId ?? `mcp-door.${randomUUID()}`;
    const marked = (): Promise<McpToolResult> =>
      withEventOrigin({ origin: 'leader', causedBy, ...(target ? { runId: target.id } : {}) }, invoke);
    const issued = guard ? () => guard.issue(causedBy, marked) : marked;
    const op = {
      action,
      payload: args,
      ...(operationId === undefined ? {} : { operationId }),
      ...(target ? { resource: target } : {}),
      // The version the leader's decision was based on (#250); the trail keeps it only in `rev1` shape.
      ...(typeof args.expectedVersion === 'string' ? { expectedVersion: args.expectedVersion } : {}),
    };
    let result: McpToolResult;
    try {
      result =
        operationId !== undefined && receipts
          ? await idempotent(receipts, { projectId, operationId, action, args, toolName: tool.name, issued, warn })
          : await issued();
    } catch (err) {
      audit?.record(op, { outcome: 'unverified', errorCode: 'effect_failed' });
      throw err;
    }
    // An error result may come from a refusal or from a failure after the effect started; the door
    // cannot tell which, so it never claims `rejected` (nothing happened) on the tool's behalf. The
    // one exception is the stale-version rejection (#250): the ROUTE refused it before any effect
    // and says so (`applied: false`), so recording it as `ok` would put a write that never happened
    // into the trail (D-06 § 4.4 rule 6).
    const resource = resourceOf(result);
    const stale = staleRejectionOf(result);
    audit?.record(
      op,
      stale
        ? { outcome: 'rejected', errorCode: 'stale_version', resource: stale.resource }
        : result.isError
          ? { outcome: 'unverified', errorCode: 'tool_error' }
          : { outcome: 'ok', ...(resource ? { resource } : {}) },
    );
    return result;
  };

  let closed = false;
  return {
    door,
    leaderEvents,
    journal,
    guard,
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
): Promise<McpToolResult> {
  let fresh: McpToolResult | undefined;
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
        call.warn(`[xez] MCP tool ${call.toolName} failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      if (fresh.isError) return { outcome: 'rejected', errorCode: 'tool refused' };
      const ref = resourceOf(fresh);
      return { outcome: 'ok', resultRef: ref ? { kind: ref.kind, id: ref.id } : { kind: 'operation', id: call.operationId } };
    },
  });
  if (fresh !== undefined) return fresh;
  return answerResult(answer);
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

/** `task_create` + `start_from_inbox` → `taskCreate.startFromInbox`: the audit's dotted action id. */
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
export async function runMcpCommand(opts: { repoRoot: string; version: string }): Promise<void> {
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
  });
}

/**
 * The cwd only FINDS the socket; it never becomes the authority (D-01 § 4). A read of
 * the registry: the bridge registers nothing, so a directory xezar has never served
 * finds no project and answers with how to fix that.
 */
export async function resolveMcpTarget(repoRoot: string): Promise<ServiceTarget> {
  const root = await realpath(repoRoot).catch(() => resolve(repoRoot));
  const project = (await loadWorkspaceConfig()).projects.find((p) => p.root === root);
  if (!project) {
    return {
      kind: 'unavailable',
      status: 'not-registered',
      message:
        'This directory is not a xezar project yet. Start the cockpit here once with `xez` (or `npx @qodeca/xezar`) so it is registered, then call this tool again.',
    };
  }
  const location = mcpSocketLocation(project);
  if (location.kind === 'unavailable') return { kind: 'unavailable', status: 'unsupported', message: location.reason };
  return { kind: 'socket', path: location.path, project: { id: project.id, name: projectName(project) } };
}

function projectName(project: { name: string; root: string }): string {
  return project.name || basename(project.root);
}
