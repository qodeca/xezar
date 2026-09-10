import { createConnection } from 'node:net';
import {
  IPC_PROTOCOL_VERSION,
  IPC_REQUEST_TIMEOUT_MS,
  LineFramer,
  encodeFrame,
  healthResultSchema,
  ipcResponseSchema,
  toolCallParamsSchema,
  toolResultSchema,
  type IpcResponse,
  type McpToolResult,
} from './ipc.ts';
import {
  JSONRPC_ERRORS,
  SERVER_CAPABILITIES,
  incomingMessageSchema,
  initializeParamsSchema,
  negotiateProtocolVersion,
  type RequestId,
} from './protocol.ts';
import { errorResult, textResult, toolListing, type McpTool } from './tool.ts';

/**
 * `xez mcp`: the stdio MCP endpoint a coding agent spawns (D-01 § 1.1, § 1.7). A
 * transport adapter with two legs — MCP on stdin/stdout facing the client, the
 * project's Unix socket facing the running service — and nothing else: no store,
 * no queue, no server, no port.
 *
 * N-07 / D-01 § 5: the handshake and `tools/list` never touch the service, so the
 * client always sees a healthy server. Each tool call connects at call time and
 * fails fast with a readable result when xezar is not running; the next call is
 * the next attempt, so a cockpit started later is picked up without a restart.
 */

export type ServiceTarget =
  | { readonly kind: 'socket'; readonly path: string; readonly project: { readonly id: string; readonly name: string } }
  | { readonly kind: 'unavailable'; readonly status: 'not-registered' | 'unsupported'; readonly message: string };

export interface BridgeOptions {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly version: string;
  /** The registry (`./tools/index.ts`). Listed here, executed in the service. */
  readonly tools: readonly McpTool[];
  /** Re-resolved on every call, so registering or starting the project later just works. */
  resolveTarget(): Promise<ServiceTarget>;
  readonly requestTimeoutMs?: number;
}

/** Built into the bridge rather than the registry: it is how a client learns the service is down. */
export const HEALTH_TOOL = {
  name: 'health',
  title: 'xezar health',
  description:
    'Report whether the xezar cockpit is running for the project this session was started in, and which project that is.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
} as const;

const INSTRUCTIONS =
  'xezar controls coding-agent tasks for the one project this session was started in. ' +
  'Call `health` to check that the xezar cockpit is running for it.';

/** Serve MCP until `input` ends. Resolves then; in-flight service calls are abandoned. */
export function runBridge(opts: BridgeOptions): Promise<void> {
  const inflight = new Set<AbortController>();
  const write = (message: unknown): void => {
    opts.output.write(encodeFrame(message));
  };
  const respond = (id: RequestId, result: unknown): void => write({ jsonrpc: '2.0', id, result });
  const fail = (id: RequestId | null, code: number, message: string): void =>
    write({ jsonrpc: '2.0', id, error: { code, message } });

  const framer = new LineFramer(
    (line) => handle(line),
    () => fail(null, JSONRPC_ERRORS.invalidRequest, 'message too large'),
  );

  function handle(line: string): void {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      fail(null, JSONRPC_ERRORS.parseError, 'parse error');
      return;
    }
    const parsed = incomingMessageSchema.safeParse(json);
    if (!parsed.success) {
      // Batches were removed in 2025-06-18; neither supported revision has them.
      fail(null, JSONRPC_ERRORS.invalidRequest, 'invalid request');
      return;
    }
    const { id, method, params } = parsed.data;
    // A notification (no id) or a response to us (no method): nothing to answer.
    // `notifications/cancelled` lands here too — a call whose answer is already on
    // its way is not unwound (D-05 § 3.1).
    if (id === undefined || method === undefined) return;
    switch (method) {
      case 'initialize': {
        const init = initializeParamsSchema.safeParse(params);
        if (!init.success) {
          fail(id, JSONRPC_ERRORS.invalidParams, 'initialize needs a protocolVersion');
          return;
        }
        respond(id, {
          protocolVersion: negotiateProtocolVersion(init.data.protocolVersion),
          capabilities: SERVER_CAPABILITIES,
          serverInfo: { name: 'xezar', title: 'xezar', version: opts.version },
          instructions: INSTRUCTIONS,
        });
        return;
      }
      case 'ping':
        respond(id, {});
        return;
      case 'tools/list':
        respond(id, { tools: [HEALTH_TOOL, ...opts.tools.map(toolListing)] });
        return;
      case 'tools/call': {
        const call = toolCallParamsSchema.safeParse(params);
        if (!call.success) {
          fail(id, JSONRPC_ERRORS.invalidParams, 'tools/call needs a tool name');
          return;
        }
        const { name } = call.data;
        if (name !== HEALTH_TOOL.name && !opts.tools.some((t) => t.name === name)) {
          fail(id, JSONRPC_ERRORS.invalidParams, `Unknown tool: ${name}`);
          return;
        }
        const abort = new AbortController();
        inflight.add(abort);
        void callTool(call.data, abort.signal)
          .then((result) => {
            if (!abort.signal.aborted) respond(id, result);
          })
          .finally(() => inflight.delete(abort));
        return;
      }
      default:
        fail(id, JSONRPC_ERRORS.methodNotFound, `Method not found: ${method}`);
    }
  }

  async function callTool(
    call: { name: string; arguments?: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<McpToolResult> {
    const target = await opts.resolveTarget();
    if (target.kind === 'unavailable') return errorResult(target.message, { status: target.status });
    const health = call.name === HEALTH_TOOL.name;
    const outcome = await ipcRequest(
      target.path,
      {
        v: IPC_PROTOCOL_VERSION,
        id: 1,
        bridgeVersion: opts.version,
        method: health ? 'health' : 'tools/call',
        ...(health ? {} : { params: call }),
      },
      opts.requestTimeoutMs ?? IPC_REQUEST_TIMEOUT_MS,
      signal,
    );
    if (outcome.kind !== 'response') return unreachable(outcome, target.project, opts.version);
    const response = outcome.response;
    if (!response.ok) return refused(response, opts.version);
    if (health) {
      const h = healthResultSchema.safeParse(response.result);
      if (!h.success) return errorResult('xezar answered health with an unexpected shape.');
      return textResult(
        `xezar ${h.data.xezarVersion} is running for project ${h.data.project.name} (${h.data.project.id}).`,
        { status: 'running', ...h.data },
      );
    }
    const result = toolResultSchema.safeParse(response.result);
    return result.success ? result.data : errorResult(`xezar answered ${call.name} with an unexpected shape.`);
  }

  return new Promise((resolve) => {
    const finish = (): void => {
      for (const abort of inflight) abort.abort();
      resolve();
    };
    opts.input.on('data', (chunk: Buffer | string) => framer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    opts.input.once('end', finish);
    opts.input.once('close', finish);
    // The client went away mid-write: there is nobody left to answer.
    opts.output.on('error', finish);
  });
}

// ---- the IPC client --------------------------------------------------------------

type IpcOutcome =
  | { kind: 'response'; response: IpcResponse }
  | { kind: 'error'; code: string | undefined }
  | { kind: 'timeout' }
  | { kind: 'closed' }
  | { kind: 'bad-response' }
  | { kind: 'aborted' };

/** One request, one answer, one connection. Settles exactly once, never hangs past the timeout. */
function ipcRequest(path: string, request: unknown, timeoutMs: number, signal: AbortSignal): Promise<IpcOutcome> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (outcome: IpcOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(outcome);
    };
    const onAbort = (): void => finish({ kind: 'aborted' });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    signal.addEventListener('abort', onAbort);
    const framer = new LineFramer(
      (line) => {
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          finish({ kind: 'bad-response' });
          return;
        }
        const parsed = ipcResponseSchema.safeParse(json);
        finish(parsed.success ? { kind: 'response', response: parsed.data } : { kind: 'bad-response' });
      },
      () => finish({ kind: 'bad-response' }),
    );
    socket.on('connect', () => socket.write(encodeFrame(request)));
    socket.on('data', (chunk: Buffer) => framer.push(chunk));
    socket.on('error', (err: NodeJS.ErrnoException) => finish({ kind: 'error', code: err.code }));
    socket.on('close', () => finish({ kind: 'closed' }));
  });
}

// ---- readable failures -------------------------------------------------------------

function unreachable(
  outcome: Exclude<IpcOutcome, { kind: 'response' }>,
  project: { id: string; name: string },
  version: string,
): McpToolResult {
  const label = `${project.name} (${project.id})`;
  switch (outcome.kind) {
    case 'error':
      if (outcome.code === 'ENOENT' || outcome.code === 'ECONNREFUSED') {
        return errorResult(
          `xezar is not running for project ${label}. Start the cockpit in the project's directory with \`xez\` (or \`npx @qodeca/xezar\`), then call this tool again.`,
          { status: 'not-running' },
        );
      }
      if (outcome.code === 'EACCES' || outcome.code === 'EPERM') {
        return errorResult(
          `xezar's socket for project ${label} refused this user (permission denied). The bridge must run as the same user as the cockpit.`,
          { status: 'refused' },
        );
      }
      return errorResult(`Could not reach xezar for project ${label} (${outcome.code ?? 'unknown error'}).`, {
        status: 'unreachable',
      });
    case 'timeout':
      return errorResult(
        `xezar for project ${label} did not answer in time. It may be busy; the request was not cancelled in xezar. Call again to check.`,
        { status: 'timeout' },
      );
    case 'closed':
      return errorResult(
        `xezar for project ${label} closed the connection before answering — it may have stopped. Call again to check.`,
        { status: 'unreachable' },
      );
    case 'bad-response':
      return errorResult(
        `xezar for project ${label} answered in a format this bridge (xezar ${version}) does not understand. Run the bridge and the cockpit from the same xezar version.`,
        { status: 'version-mismatch' },
      );
    case 'aborted':
      return errorResult('The MCP session ended before xezar answered.', { status: 'aborted' });
  }
}

function refused(response: Extract<IpcResponse, { ok: false }>, version: string): McpToolResult {
  if (response.error.code === 'version-mismatch') {
    return errorResult(
      `The running xezar (${response.serviceVersion ?? 'unknown version'}) and this bridge (xezar ${version}) speak different bridge protocols. Run both from the same xezar version.`,
      { status: 'version-mismatch' },
    );
  }
  return errorResult(`xezar refused the request: ${response.error.message}`, { status: 'refused' });
}
