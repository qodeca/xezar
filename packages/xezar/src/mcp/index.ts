import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { operationIdSchema, type AuditResource, type OperationAnswer, type OperationResultRef } from '@qodeca/xezar-contract';
import { collectSecretValues } from '../core/secret-redaction.ts';
import { projectDataDir } from '../project-data-paths.ts';
import type { RunStore } from '../runs/store.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { AuditTrail, type AuditChannel } from './audit-trail.ts';
import { runBridge, type ServiceTarget } from './bridge.ts';
import { EchoGuard } from './echo-guard.ts';
import { EventJournal } from './event-journal.ts';
import { mcpSocketLocation } from './ipc.ts';
import { OperationReceiptStore, runByKeyReconciler, type EffectOutcome } from './operation-receipts.ts';
import type { ServiceDispatch } from './service-adapter.ts';
import { listenMcpSocket, type McpDoor, type McpServiceHandle } from './service.ts';
import { errorResult, textResult, type McpToolResult } from './tool.ts';
import { tools } from './tools/index.ts';

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
  /** The project's own store — the one the cockpit writes. Receipts reconcile a run against it. */
  readonly store?: RunStore;
  /** Test seams, as for `listenMcpSocket`. Production uses the process's own. */
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly warn?: (message: string) => void;
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
  const parts = composeDoor({
    projectId: project.id,
    dataDir: opts.store?.dataDir ?? projectDataDir(project.root),
    store: opts.store,
    env: opts.env ?? process.env,
    warn: opts.warn ?? ((message) => console.warn(message)),
  });
  try {
    const socket = await listenMcpSocket({
      project: { id: project.id, name: projectName(project), root: project.root },
      version: opts.version,
      tools,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.platform ? { platform: opts.platform } : {}),
      ...(opts.service ? { context: { service: opts.service } } : {}),
      door: parts.door,
    });
    return {
      path: socket.path,
      close() {
        // The socket first: no call may start while its parts are going away.
        socket.close();
        parts.close();
      },
    };
  } catch (err) {
    parts.close();
    throw err;
  }
}

interface DoorInput {
  projectId: string;
  dataDir: string;
  store: RunStore | undefined;
  env: NodeJS.ProcessEnv;
  warn: (message: string) => void;
}

/**
 * The parts that act on every MCP call, and the door that applies them. Each part is optional in
 * the zero-config sense: one that cannot open is ONE warning and a smaller MCP, never a failed
 * start — the tools keep working, exactly as they did before any part existed.
 *
 * - the project's event journal (#103), opened with this host's real secret list (F-15);
 * - operation receipts (#101) for every call that carries an `operationId`;
 * - the echo guard (#106): the operation is recorded as this leader's own BEFORE it runs;
 * - the audit trail (#102), stamped `mcp` because this is the MCP door (D-06 § 10.4 rule 1).
 *
 * Read-only tools pass straight through: a read has no effect to deduplicate or to audit.
 */
function composeDoor(input: DoorInput): { door: McpDoor; close(): void } {
  const { projectId, dataDir, store, warn } = input;
  const closers: Array<() => void> = [];
  const attempt = <T>(what: string, open: () => T): T | undefined => {
    try {
      return open();
    } catch (err) {
      warn(`[xez] MCP ${what} unavailable (${err instanceof Error ? err.message : String(err)}) — MCP tools keep working without it`);
      return undefined;
    }
  };

  const journal = attempt('event journal', () =>
    EventJournal.open({ dataDir, projectId, secretValues: collectSecretValues(input.env), warn }),
  );
  if (journal) closers.push(() => journal.close());

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
    const issued = operationId !== undefined && guard ? () => guard.issue(operationId, invoke) : invoke;
    const op = {
      action,
      payload: args,
      ...(operationId === undefined ? {} : { operationId }),
      ...(targetOf(args) ? { resource: targetOf(args) } : {}),
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
    // cannot tell which, so it never claims `rejected` (nothing happened) on the tool's behalf.
    const resource = resourceOf(result);
    audit?.record(
      op,
      result.isError ? { outcome: 'unverified', errorCode: 'tool_error' } : { outcome: 'ok', ...(resource ? { resource } : {}) },
    );
    return result;
  };

  let closed = false;
  return {
    door,
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
