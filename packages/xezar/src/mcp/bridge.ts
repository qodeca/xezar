import { createConnection, type Socket } from 'node:net';
import { MCP_PROJECT_OCCUPIED_REASON, type McpProjectOccupiedError, type McpSessionExpiredError } from '@qodeca/xezar-contract';
import { projectOccupiedError, sessionExpiredError } from '../workspace/project-owner.ts';
import {
  IPC_PROTOCOL_VERSION,
  IPC_REQUEST_TIMEOUT_MS,
  IPC_SESSION_OPEN_TIMEOUT_MS,
  LineFramer,
  encodeFrame,
  healthResultSchema,
  ipcResponseSchema,
  sessionOpenResultSchema,
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
 * ## One connection, one session (#302, D-02)
 *
 * The bridge keeps ONE connection to the service for its whole life and opens its MCP session on
 * it when the client sends `initialize` — that is where D-02.6 puts acquisition. The service then
 * sees the session open and, when this process exits or its client goes away, sees it close: the
 * owner went away, observably, in milliseconds. That is what makes exclusive ownership enforceable;
 * the one-connection-per-call bridge this replaces gave the service no session to observe.
 *
 * What one-connection-per-call was load-bearing FOR, and how each guarantee is kept:
 *
 * - **N-07 / D-01 § 5 — xezar not running.** Every call re-resolved the target and connected, so a
 *   cockpit started later was picked up on the next call with no client restart and no reconnect
 *   timer. Kept: `initialize` still succeeds with no service, and every call made without a live
 *   session tries to open one — the next call is still the next attempt, with no timer.
 * - **Cockpit restart.** A fresh connection per call simply reached the new service. Now the old
 *   session ends with the old service (D-02 § 5): the FIRST call that reaches the new service is
 *   answered session-expired, so a write made under the old session is fenced rather than silently
 *   replayed, and the bridge has already opened a new session for the next call — no model turn and
 *   no human step.
 * - **Failure containment.** A hung or garbled answer spoiled one call's connection and nothing
 *   else. Now answers are matched by request id on the shared connection: a call that times out
 *   is answered as a timeout and its late answer dropped, and a garbled frame fails the calls in
 *   flight — neither closes the session, so neither costs the project.
 * - **A client that dies mid-call.** Its connections were destroyed and the service carried on
 *   with the operation. Unchanged: the service still runs every call it accepted to completion; the
 *   close now also frees the project, and still cancels no task (N-05).
 * - **Two clients at once.** Both were served — the defect. Now the second is refused.
 *
 * Refusals are D-02 § 4's JSON-RPC errors, passed through as the service built them:
 * `initialize` while another session owns the project answers project-occupied (`-32080`); a call
 * from a session that does not own the project — refused, lost with a restart, or fenced — answers
 * session-expired (`-32081`), and the next call is made on a new session. Nothing here lets one
 * session end another (F-18).
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
  /** Re-resolved whenever a session is opened, so registering or starting the project later just works. */
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

type OwnershipError = McpProjectOccupiedError | McpSessionExpiredError;
type Answer = { result: McpToolResult } | { error: OwnershipError };

/** Serve MCP until `input` ends. Resolves then; the session closes and in-flight answers are dropped. */
export function runBridge(opts: BridgeOptions): Promise<void> {
  const inflight = new Set<AbortController>();
  const session = new ServiceSession(opts);
  let finished = false;
  const write = (message: unknown): void => {
    if (!finished) opts.output.write(encodeFrame(message));
  };
  const respond = (id: RequestId, result: unknown): void => write({ jsonrpc: '2.0', id, result });
  const fail = (id: RequestId | null, code: number, message: string): void =>
    write({ jsonrpc: '2.0', id, error: { code, message } });
  const refuse = (id: RequestId, error: OwnershipError): void => write({ jsonrpc: '2.0', id, error });

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
        // D-02.6: `initialize` is where a session acquires the project. Only a live competing
        // owner turns it into an error; a service that is not running still gets a healthy
        // handshake (N-07), and the first call tries again.
        void session.initialize().then((refused) => {
          if (refused) {
            refuse(id, refused);
            return;
          }
          respond(id, {
            protocolVersion: negotiateProtocolVersion(init.data.protocolVersion),
            capabilities: SERVER_CAPABILITIES,
            serverInfo: { name: 'xezar', title: 'xezar', version: opts.version },
            instructions: INSTRUCTIONS,
          });
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
          .then((answer) => {
            if (abort.signal.aborted) return;
            if ('error' in answer) refuse(id, answer.error);
            else respond(id, answer.result);
          })
          .finally(() => inflight.delete(abort));
        return;
      }
      default:
        fail(id, JSONRPC_ERRORS.methodNotFound, `Method not found: ${method}`);
    }
  }

  async function callTool(call: { name: string; arguments?: Record<string, unknown> }, signal: AbortSignal): Promise<Answer> {
    const health = call.name === HEALTH_TOOL.name;
    const outcome = await session.call(health ? 'health' : 'tools/call', health ? undefined : call, signal);
    if (outcome.kind !== 'response') return outcome.kind === 'error' ? { error: outcome.error } : { result: outcome.result };
    const response = outcome.response;
    if (!response.ok) return { result: refused(response, opts.version) };
    if (health) {
      const h = healthResultSchema.safeParse(response.result);
      if (!h.success) return { result: errorResult('xezar answered health with an unexpected shape.') };
      return {
        result: textResult(`xezar ${h.data.xezarVersion} is running for project ${h.data.project.name} (${h.data.project.id}).`, {
          status: 'running',
          ...h.data,
        }),
      };
    }
    const result = toolResultSchema.safeParse(response.result);
    return { result: result.success ? result.data : errorResult(`xezar answered ${call.name} with an unexpected shape.`) };
  }

  return new Promise((resolve) => {
    const finish = (): void => {
      if (finished) return;
      finished = true;
      for (const abort of inflight) abort.abort();
      // The client went away: closing the connection is how the service learns the session ended.
      session.close();
      resolve();
    };
    opts.input.on('data', (chunk: Buffer | string) => framer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    opts.input.once('end', finish);
    opts.input.once('close', finish);
    // The client went away mid-write: there is nobody left to answer.
    opts.output.on('error', finish);
  });
}

// ---- the session -----------------------------------------------------------------------------

type IpcOutcome =
  | { kind: 'response'; response: IpcResponse }
  | { kind: 'error'; code: string | undefined }
  | { kind: 'timeout' }
  | { kind: 'closed' }
  | { kind: 'bad-response' }
  | { kind: 'aborted' };

type OpenOutcome =
  | { kind: 'owner' }
  | { kind: 'occupied'; error: McpProjectOccupiedError }
  /** No session, for a reason the client reads as an ordinary tool result (N-07). */
  | { kind: 'unavailable'; result: McpToolResult };

type CallOutcome =
  | { kind: 'response'; response: IpcResponse }
  | { kind: 'result'; result: McpToolResult }
  | { kind: 'error'; error: OwnershipError };

/**
 * `idle`: no session yet (never opened, or the service was not reachable). `owner`: the session
 * owns the project on a live connection. `lost`: it did, and its connection closed — the service
 * stopped. `refused`: the service said another session owns the project, or that this one no
 * longer does.
 */
type SessionState = 'idle' | 'owner' | 'lost' | 'refused';

class ServiceSession {
  private state: SessionState = 'idle';
  private connection: IpcConnection | undefined;
  private opening: Promise<OpenOutcome> | undefined;
  private project: { id: string; name: string } | undefined;
  private closed = false;

  constructor(private readonly opts: Pick<BridgeOptions, 'resolveTarget' | 'version' | 'requestTimeoutMs'>) {}

  /** Open the session for `initialize`. Answers the refusal to send, or nothing for a healthy handshake. */
  async initialize(): Promise<McpProjectOccupiedError | undefined> {
    if (this.state === 'owner') return undefined;
    const opened = await this.open();
    return opened.kind === 'occupied' ? opened.error : undefined;
  }

  async call(method: 'health' | 'tools/call', params: unknown, signal: AbortSignal): Promise<CallOutcome> {
    const before = this.state;
    if (before !== 'owner') {
      const opened = await this.open();
      if (opened.kind === 'unavailable') return { kind: 'result', result: opened.result };
      // The call was made under a session that does not own the project: it is answered as expired
      // and never runs. A new session is already open (or refused) for the calls that follow.
      if (before === 'lost' || before === 'refused') return { kind: 'error', error: sessionExpiredError(this.projectId()) };
      if (opened.kind === 'occupied') return { kind: 'error', error: opened.error };
    }
    const connection = this.connection;
    if (!connection) return { kind: 'error', error: sessionExpiredError(this.projectId()) };
    const outcome = await connection.request(
      { method, ...(params === undefined ? {} : { params }) },
      this.opts.requestTimeoutMs ?? IPC_REQUEST_TIMEOUT_MS,
      signal,
    );
    if (outcome.kind !== 'response') return { kind: 'result', result: unreachable(outcome, this.projectLabel(), this.opts.version) };
    const response = outcome.response;
    if (!response.ok && response.error.code === 'session-expired') {
      // Fenced by the service. This session is over; the next call opens a new one.
      this.drop('idle');
      return { kind: 'error', error: response.rpcError ?? sessionExpiredError(this.projectId()) };
    }
    return { kind: 'response', response };
  }

  /** The client is gone. Closing the connection is what releases the project in the service. */
  close(): void {
    this.closed = true;
    this.drop('idle');
  }

  private open(): Promise<OpenOutcome> {
    this.opening ??= this.openOnce().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async openOnce(): Promise<OpenOutcome> {
    this.dropConnection();
    const target = await this.opts.resolveTarget();
    if (target.kind === 'unavailable') return { kind: 'unavailable', result: errorResult(target.message, { status: target.status }) };
    if (this.closed) return { kind: 'unavailable', result: errorResult('The MCP session ended before xezar answered.', { status: 'aborted' }) };
    this.project = target.project;
    const timeoutMs = Math.min(this.opts.requestTimeoutMs ?? IPC_REQUEST_TIMEOUT_MS, IPC_SESSION_OPEN_TIMEOUT_MS);
    const started = Date.now();
    const connected = await IpcConnection.connect(target.path, this.opts.version, timeoutMs, (connection) => this.onClosed(connection));
    if (!(connected instanceof IpcConnection)) {
      return { kind: 'unavailable', result: unreachable(connected, this.projectLabel(), this.opts.version) };
    }
    const answer = await connected.request({ method: 'session/open' }, Math.max(1, timeoutMs - (Date.now() - started)));
    if (this.closed) {
      connected.close();
      return { kind: 'unavailable', result: errorResult('The MCP session ended before xezar answered.', { status: 'aborted' }) };
    }
    if (answer.kind !== 'response') {
      connected.close();
      return { kind: 'unavailable', result: unreachable(answer, this.projectLabel(), this.opts.version) };
    }
    const response = answer.response;
    if (response.ok && sessionOpenResultSchema.safeParse(response.result).success) {
      this.connection = connected;
      this.state = 'owner';
      return { kind: 'owner' };
    }
    connected.close();
    if (!response.ok && response.error.code === 'project-occupied') {
      this.state = 'refused';
      const error = response.rpcError;
      return {
        kind: 'occupied',
        error: error?.data.reason === MCP_PROJECT_OCCUPIED_REASON ? (error as McpProjectOccupiedError) : projectOccupiedError(target.project.id),
      };
    }
    if (response.ok) {
      return { kind: 'unavailable', result: errorResult('xezar answered session/open with an unexpected shape.', { status: 'version-mismatch' }) };
    }
    return { kind: 'unavailable', result: refused(response, this.opts.version) };
  }

  private onClosed(connection: IpcConnection): void {
    if (connection !== this.connection) return;
    this.connection = undefined;
    if (this.state === 'owner') this.state = 'lost';
  }

  private drop(next: SessionState): void {
    this.dropConnection();
    this.state = next;
  }

  private dropConnection(): void {
    const connection = this.connection;
    this.connection = undefined;
    connection?.close();
  }

  private projectId(): string {
    return this.project?.id ?? 'unknown';
  }

  private projectLabel(): { id: string; name: string } {
    return this.project ?? { id: 'unknown', name: 'this project' };
  }
}

// ---- the IPC connection ----------------------------------------------------------------------

/**
 * One kept connection, many requests. Answers are matched by id; every request settles exactly
 * once and never later than its own timeout, and none of that closes the connection — only the
 * service, the OS or `close()` do.
 */
class IpcConnection {
  private readonly pending = new Map<number, (outcome: IpcOutcome) => void>();
  private nextId = 1;
  private ended = false;

  private constructor(
    private readonly socket: Socket,
    private readonly version: string,
  ) {}

  /** Connect, or answer why not. `onClose` fires once, when a connected socket closes for any reason. */
  static connect(
    path: string,
    version: string,
    timeoutMs: number,
    onClose: (connection: IpcConnection) => void,
  ): Promise<IpcConnection | Exclude<IpcOutcome, { kind: 'response' }>> {
    return new Promise((resolve) => {
      const socket = createConnection(path);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ kind: 'timeout' });
      }, timeoutMs);
      socket.once('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve({ kind: 'error', code: err.code });
      });
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const connection = new IpcConnection(socket, version);
        connection.attach(onClose);
        resolve(connection);
      });
    });
  }

  request(body: { method: string; params?: unknown }, timeoutMs: number, signal?: AbortSignal): Promise<IpcOutcome> {
    if (this.ended) return Promise.resolve({ kind: 'closed' });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const settle = (outcome: IpcOutcome): void => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = (): void => settle({ kind: 'aborted' });
      // A slow answer is a timeout for THIS call only; the service was not told to cancel anything.
      const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs);
      this.pending.set(id, settle);
      signal?.addEventListener('abort', onAbort);
      this.socket.write(encodeFrame({ v: IPC_PROTOCOL_VERSION, id, bridgeVersion: this.version, ...body }));
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private attach(onClose: (connection: IpcConnection) => void): void {
    const framer = new LineFramer(
      (line) => this.receive(line),
      () => this.failAll({ kind: 'bad-response' }),
    );
    this.socket.on('data', (chunk: Buffer) => framer.push(chunk));
    this.socket.on('error', () => {
      // Always followed by `close`, which settles everything.
    });
    this.socket.once('close', () => {
      this.ended = true;
      this.failAll({ kind: 'closed' });
      onClose(this);
    });
  }

  private receive(line: string): void {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      this.failAll({ kind: 'bad-response' });
      return;
    }
    const parsed = ipcResponseSchema.safeParse(json);
    // An answer that names no request cannot be matched to one, so every call in flight is told
    // the service answered in a way this bridge does not understand. The session itself stays.
    if (!parsed.success || parsed.data.id === null) {
      this.failAll({ kind: 'bad-response' });
      return;
    }
    this.pending.get(parsed.data.id)?.({ kind: 'response', response: parsed.data });
  }

  private failAll(outcome: IpcOutcome): void {
    for (const settle of [...this.pending.values()]) settle(outcome);
  }
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
