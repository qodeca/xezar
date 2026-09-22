import { randomUUID } from 'node:crypto';
import type { McpPushCapability } from '@qodeca/xezar-contract';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import type { z } from 'zod';
import { assertXezarHomeWriteIsSandboxed } from '../paths.ts';
import { projectDataDir } from '../project-data-paths.ts';
import { cockpitLinks } from './cockpit-address.ts';
import { ProjectOwnership, sessionExpiredError } from '../workspace/project-owner.ts';
import {
  IPC_PROTOCOL_VERSION,
  LEADER_PUSH_TIMEOUT_MS,
  LineFramer,
  encodeFrame,
  ipcRequestSchema,
  ipcResponseSchema,
  mcpSocketDir,
  mcpSocketLocation,
  sessionOpenParamsSchema,
  toolCallParamsSchema,
  type HealthResult,
  type IpcResponse,
} from './ipc.ts';
import { acceptedKeysSentence, errorResult, schemaKeys, type McpTool, type McpToolContext, type McpToolResult } from './tool.ts';

/**
 * The service half of the IPC leg (D-01 § 1.2–1.5): the running xezar opens one
 * Unix socket for a project and answers the bridge on it.
 *
 * Project binding lives HERE, not in any frame: the socket was opened for exactly
 * one project, a request has no project field to name another, and `ctx.project`
 * is the project this socket belongs to (§ 1.5, F-01, N-09). There is no loopback
 * HTTP leg, so § 8's "equivalent enforcement for a loopback HTTP alternative" does
 * not arise; the same-user boundary is the directory's 0700 and the socket's 0600
 * (D-01 E7).
 *
 * ## One connection is one MCP session (#302, D-02)
 *
 * The bridge keeps ONE connection for the life of its `xez mcp` process. The session key is minted
 * here, per connection — never read from a frame, so no client can name or borrow another's
 * session. `session/open` makes that session the project's owner through `ProjectOwnership`
 * (D-02.2) or answers project-occupied; `health` and `tools/call` need the session to still own the
 * project, and every mutating call is fenced on its token right before it runs (D-02.3).
 *
 * Who ends a session, and nothing else does (D-02.4):
 * - the connection closing — the bridge exited, was killed, or its client went away. That is the
 *   "confirmed termination" signal, observed in milliseconds (D-02 X2);
 * - the owner's lease lapsing, which only a frozen service can cause, because the renewal timer
 *   runs in this process and needs no request and no model turn. MODEL SILENCE IS NOT SESSION
 *   DEATH: an idle connection keeps its project for as long as it stays open;
 * - the service stopping (`close()`), which ends every session (D-02 § 5).
 * One request finishing, failing or timing out ends nothing.
 *
 * Ending a session touches the owner claim and nothing else (N-05). A tool call still running
 * when its connection closes runs to completion — its answer is simply not sent — and no path
 * here reaches a run: a disconnect never cancels a task.
 */

export interface McpServiceOptions {
  readonly project: McpToolContext['project'];
  readonly version: string;
  readonly tools: readonly McpTool[];
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /**
   * Extra context every tool call gets — the running app's in-process entry (`service`) in
   * production. It can never replace `project` or `xezarVersion`: the binding is this socket's.
   */
  readonly context?: Readonly<Record<string, unknown>>;
  /** The MCP door: wraps every tool call whose arguments parsed (see `startMcpService`). */
  readonly door?: McpDoor;
  /** Where the owner claims live (D-02.8). Defaults to the project's own `.local/xezar`. */
  readonly dataDir?: string;
  /** The owner slot to enforce. Absent: one is built per socket. */
  readonly ownership?: ProjectOwnership;
  /** Told when a session becomes the owner and when its connection closes — push delivery (#309). */
  readonly sessions?: McpSessionObserver;
}

/**
 * The two session edges push delivery (#309) follows: `opened` once `session/open` made the session
 * the project's owner, `closed` when its connection closes (before the claim is released). Neither
 * may fail a session: a throw is one warning and the session carries on (N-07).
 *
 * `opened` also hands over the session's TRANSPORT (#374): a way to push a `leader/push` down this
 * exact connection, plus what the bridge announced about itself — its client's name and whether it
 * understands `leader/push`. It is optional so a caller that predates channels ignores it. An older
 * BRIDGE announces neither field, which is how the delivery seam tells a channel-capable Claude Code
 * bridge from one too old to deliver.
 */
export interface McpSessionObserver {
  opened(sessionKey: string, transport?: McpSessionTransport): void;
  closed(sessionKey: string): void;
  codexAnnounced?(sessionKey: string, announcement: { threadId: string }): void;
  /** #450: whether xezar can push to this session's client, answered in `session/open`. */
  pushCapability?(sessionKey: string, transport: McpSessionTransport): McpPushCapability;
  /**
   * #886: the session called a known tool, and which one. The one activity signal the delivery seam
   * has for a client that confirms nothing (Claude Code): an active session that never acknowledges
   * pushed rows is the plain evidence they are not reaching it. The tool and its `action` travel with
   * it because a `leader_events` read, status or ack is the leader RECOVERING events, not evidence of
   * missing them (#890 review, finding 1). Optional, and like the other edges it may never fail a call.
   */
  called?(sessionKey: string, call: McpToolCallActivity): void;
  /**
   * #886: the same call, told again only once its arguments validated and it answered without an error
   * (#890 re-check). `called` fires on arrival, before validation, so it is the fail-safe activity
   * signal; only this edge may be read as the leader HAVING done something — a recovery read that
   * returned events. `calledAt` is when it arrived, so a push made while it ran is not counted as read.
   */
  succeeded?(sessionKey: string, call: McpToolCallActivity, calledAt: number): void;
}

/** #886: which tool a session called, and its `action` argument when it passed a string one. Never the arguments. */
export interface McpToolCallActivity {
  readonly tool: string;
  readonly action?: string;
}

/** No observer, or one that cannot say: no journal, so no delivery (#450). */
const DELIVERY_UNAVAILABLE: McpPushCapability = {
  canPush: false,
  pushUnavailable: {
    code: 'delivery-unavailable',
    message: 'xezar has no event delivery for this project (its event journal did not open or cannot be written), so no leader can be attached.',
  },
};

/** How the delivery seam reaches ONE owner session's bridge, and what that bridge said about itself (#374). */
export interface McpSessionTransport {
  /** Send a channel event down this connection and resolve when the bridge confirms the write. */
  readonly push: (content: string, meta?: Record<string, string>) => Promise<void>;
  /** The client's own name from `initialize` (`claude-code` for a Claude Code bridge), when announced. */
  clientName?: string;
  /** True when the bridge announced it understands `leader/push`; absent for a bridge too old to deliver. */
  leaderPush?: boolean;
  /** #450: whether this bridge's handshake registered `claude/channel`; absent on its first open. */
  channelAdvertised?: boolean;
}

/**
 * Runs around one validated tool call. `invoke` is the tool itself; a throw from either reaches
 * the same handler a tool's own throw does, so nothing secret reaches the response (F-15).
 */
export type McpDoor = (
  call: { readonly tool: McpTool; readonly args: Record<string, unknown>; readonly ctx: McpToolContext },
  invoke: () => Promise<McpToolResult>,
) => Promise<McpToolResult>;

export interface McpServiceHandle {
  readonly path: string;
  /** Stop answering and remove the socket. Synchronous, so a shutdown handler can call it. */
  close(): void;
}

/**
 * Open the project's socket. Throws a one-line, readable error when it cannot —
 * whether that is fatal is the CALLER's policy, and the cockpit's policy is that
 * it never is (N-07): see `startMcpService` in ./index.ts.
 */
export async function listenMcpSocket(opts: McpServiceOptions): Promise<McpServiceHandle> {
  const location = mcpSocketLocation(opts.project, opts.env, opts.platform);
  if (location.kind === 'unavailable') throw new Error(location.reason);
  const dir = mcpSocketDir(opts.env);
  assertXezarHomeWriteIsSandboxed(dir, opts.env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's mode alone; this one is ours alone.
  await chmod(dir, 0o700);
  await clearStaleSocket(location.path);

  // Built only once the socket path is ours: it writes nothing until a session opens.
  const ownership =
    opts.ownership ??
    new ProjectOwnership({ dataDir: opts.dataDir ?? projectDataDir(opts.project.root), projectId: opts.project.id });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    serveConnection(socket, opts, ownership);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(location.path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // Node creates the socket at the umask default (755 observed, D-01 E7). The 0700
  // directory already fences it off during this gap.
  try {
    await chmod(location.path, 0o600);
  } catch (err) {
    server.close();
    throw err;
  }
  server.on('error', (err) => console.warn(`[xez] MCP socket error: ${err.message}`));

  return {
    path: location.path,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      // D-02 § 5: a service that stops ends every session, and its claim goes with it.
      ownership.dispose();
    },
  };
}

/**
 * A socket file left by a xezar that died without closing is removed; a LIVE one
 * belongs to another cockpit serving the same project and is never stolen; any
 * other file at that path is not ours and is left alone.
 */
async function clearStaleSocket(path: string): Promise<void> {
  let isSocket: boolean;
  try {
    isSocket = (await lstat(path)).isSocket();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!isSocket) throw new Error(`${path} exists and is not a socket — leaving it alone`);
  if (await socketIsLive(path)) {
    throw new Error('another xezar is already serving this project over MCP');
  }
  await unlink(path);
}

function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

function serveConnection(socket: Socket, opts: McpServiceOptions, ownership: ProjectOwnership): void {
  // Minted here, per connection. Nothing a client sends can choose it.
  const sessionKey = randomUUID();
  socket.on('error', () => {
    // A bridge that vanished mid-answer is not the cockpit's problem.
  });
  const send = (response: IpcResponse): void => {
    if (!socket.destroyed) socket.write(encodeFrame(response));
  };
  // #374: the service→bridge push, correlated by a service-minted id. It is the reverse of every
  // other IPC frame — the service is the requester here — so it keeps its OWN pending map, separate
  // from the request/response the bridge drives. `send` writes the frame; the bridge answers with a
  // `leader/push` RESPONSE routed back here by `handleFrame`.
  const pushPending = new Map<number, (response: IpcResponse) => void>();
  let nextPushId = 1;
  const push = (content: string, meta?: Record<string, string>): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (socket.destroyed) {
        reject(new Error('the Claude Code bridge connection is closed'));
        return;
      }
      const id = nextPushId++;
      const timer = setTimeout(() => {
        if (pushPending.delete(id)) reject(new Error('the Claude Code bridge did not confirm the channel write in time'));
      }, LEADER_PUSH_TIMEOUT_MS);
      timer.unref?.();
      pushPending.set(id, (response) => {
        clearTimeout(timer);
        if (response.ok) resolve();
        else reject(new Error(response.error.message));
      });
      socket.write(encodeFrame({ v: IPC_PROTOCOL_VERSION, id, method: 'leader/push', params: meta === undefined ? { content } : { content, meta } }));
    });
  const transport: McpSessionTransport = { push };
  // Confirmed termination (D-02.4 signal 1): the connection is the session, so its close frees the
  // project at once. `release` touches the owner claim and nothing else — calls still running go
  // on running, and no run is touched (N-05).
  socket.once('close', () => {
    // Any push still waiting on this connection cannot be confirmed now: reject it, so the adapter
    // reports the leader unreachable rather than hanging until the backstop timer.
    for (const settle of [...pushPending.values()]) settle(failure(null, 'internal', 'the Claude Code bridge connection closed before it confirmed the channel write'));
    pushPending.clear();
    // The session's event controller ends with its connection, before the claim goes (#309).
    observe(opts, 'closed', sessionKey);
    ownership.release(sessionKey);
  });
  const framer = new LineFramer(
    (line) => {
      void handleFrame(line, opts, ownership, sessionKey, transport, pushPending).then((response) => {
        if (response !== undefined) send(response);
      });
    },
    () => send(failure(null, 'bad-frame', 'frame too large')),
  );
  socket.on('data', (chunk: Buffer) => framer.push(chunk));
}

/**
 * One inbound frame. A `leader/push` RESPONSE from the bridge (`ok` present, no `method`, an id this
 * connection is waiting on) settles that push and is answered with nothing; everything else is a
 * bridge→service REQUEST and goes to `answer`. Splitting them here keeps `answer` a pure
 * request→response function and keeps the two id-spaces from ever colliding.
 */
async function handleFrame(
  line: string,
  opts: McpServiceOptions,
  ownership: ProjectOwnership,
  sessionKey: string,
  transport: McpSessionTransport,
  pushPending: Map<number, (response: IpcResponse) => void>,
): Promise<IpcResponse | undefined> {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return failure(null, 'bad-frame', 'frame is not JSON');
  }
  const asResponse = ipcResponseSchema.safeParse(json);
  if (asResponse.success && typeof asResponse.data.id === 'number' && pushPending.has(asResponse.data.id)) {
    const settle = pushPending.get(asResponse.data.id)!;
    pushPending.delete(asResponse.data.id);
    settle(asResponse.data);
    return undefined;
  }
  return answer(json, opts, ownership, sessionKey, transport);
}

async function answer(
  json: unknown,
  opts: McpServiceOptions,
  ownership: ProjectOwnership,
  sessionKey: string,
  transport: McpSessionTransport,
): Promise<IpcResponse> {
  const parsed = ipcRequestSchema.safeParse(json);
  if (!parsed.success) return failure(null, 'bad-frame', 'frame is not a request');
  const request = parsed.data;
  if (request.v !== IPC_PROTOCOL_VERSION) {
    return {
      ...failure(request.id, 'version-mismatch', `this xezar speaks bridge protocol ${IPC_PROTOCOL_VERSION}, the bridge sent ${request.v}`),
      serviceVersion: opts.version,
    };
  }
  // #450: the session key rides the context so a tool can act for THIS connection's session only.
  const ctx: McpToolContext = { ...opts.context, project: opts.project, xezarVersion: opts.version, sessionKey };
  switch (request.method) {
    case 'session/open': {
      const opened = await openSession(request.id, ownership, sessionKey, opts.project.id);
      // Push delivery starts for the owner at once — on by default, no flag (#309). #374: carry what
      // the bridge announced (its client name and that it understands `leader/push`) so the delivery
      // seam can tell a channel-capable Claude Code bridge from one too old to deliver.
      if (opened.ok) {
        const announced = sessionOpenParamsSchema.safeParse(request.params);
        if (announced.success) {
          if (announced.data.clientName !== undefined) transport.clientName = announced.data.clientName;
          if (announced.data.leaderPush !== undefined) transport.leaderPush = announced.data.leaderPush;
          if (announced.data.channelAdvertised !== undefined) transport.channelAdvertised = announced.data.channelAdvertised;
        }
        observe(opts, 'opened', sessionKey, transport);
        // #450: tell the bridge whether xezar can push to this client, so it registers the Claude Code
        // channel only when a push could ever arrive. Additive: an older bridge strips both fields.
        return { ...opened, result: { owner: true, ...pushCapabilityOf(opts, sessionKey, transport) } };
      }
      return opened;
    }
    case 'health': {
      if (ownership.sessionToken(sessionKey) === undefined) return expired(request.id, opts.project.id);
      // #819 item 8: the address the person opens, only when this process recorded a real one —
      // through the one accessor that also applies the hosted check (#838 F).
      const cockpitUrl = cockpitLinks(opts.project.id)?.url;
      const result: HealthResult = {
        ipcVersion: IPC_PROTOCOL_VERSION,
        xezarVersion: opts.version,
        project: { id: opts.project.id, name: opts.project.name },
        ...(cockpitUrl === undefined ? {} : { cockpitUrl }),
      };
      return { v: IPC_PROTOCOL_VERSION, id: request.id, ok: true, result };
    }
    case 'tools/call': {
      // The token this request is bound to, taken as it arrives; the fence below compares it again.
      const token = ownership.sessionToken(sessionKey);
      if (token === undefined) return expired(request.id, opts.project.id);
      const params = toolCallParamsSchema.safeParse(request.params);
      if (!params.success) return failure(request.id, 'invalid-params', 'tools/call needs a tool name');
      const announcement = codexAnnouncement(params.data._meta);
      if (announcement) opts.sessions?.codexAnnounced?.(sessionKey, announcement);
      const tool = opts.tools.find((t) => t.name === params.data.name);
      if (!tool) return failure(request.id, 'unknown-tool', `unknown tool: ${params.data.name}`);
      const activity = toolCallActivity(tool.name, params.data.arguments);
      const calledAt = Date.now();
      noteCall(opts, sessionKey, activity);
      const outcome = await callTool(tool, params.data.arguments, ctx, opts.door, () => ownership.checkMutation(token).ok);
      if (outcome === 'fenced') return expired(request.id, opts.project.id);
      if (outcome.isError !== true) noteSuccess(opts, sessionKey, activity, calledAt);
      return { v: IPC_PROTOCOL_VERSION, id: request.id, ok: true, result: outcome };
    }
    default:
      return failure(request.id, 'unknown-method', `unknown method: ${request.method}`);
  }
}

/** The owning bridge's Codex thread id, and only that: where the app-server listens is the service's to find. */
function codexAnnouncement(meta: Record<string, unknown> | undefined): { threadId: string } | undefined {
  if (meta === undefined) return undefined;
  const codex = meta.codex;
  if (typeof codex !== 'object' || codex === null) return undefined;
  const threadId = (codex as Record<string, unknown>).threadId;
  return typeof threadId === 'string' && threadId.length > 0 && threadId.length <= 200 ? { threadId } : undefined;
}

function observe(opts: McpServiceOptions, edge: 'opened' | 'closed', sessionKey: string, transport?: McpSessionTransport): void {
  try {
    if (edge === 'opened') opts.sessions?.opened(sessionKey, transport);
    else opts.sessions?.closed(sessionKey);
  } catch (err) {
    console.warn(`[xez] MCP event delivery hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** #886: the tool's name and a bounded string `action`, nothing else of what the caller sent. */
function toolCallActivity(tool: string, args: Record<string, unknown> | undefined): McpToolCallActivity {
  const action = args?.action;
  return typeof action === 'string' && action.length > 0 && action.length <= 64 ? { tool, action } : { tool };
}

/** #886: tell the delivery seam this session is active. A throw is one warning and the call carries on (N-07). */
function noteCall(opts: McpServiceOptions, sessionKey: string, call: McpToolCallActivity): void {
  try {
    opts.sessions?.called?.(sessionKey, call);
  } catch (err) {
    console.warn(`[xez] MCP event delivery hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** #886: the call validated and answered without an error. Guarded the same way (N-07). */
function noteSuccess(opts: McpServiceOptions, sessionKey: string, call: McpToolCallActivity, calledAt: number): void {
  try {
    opts.sessions?.succeeded?.(sessionKey, call, calledAt);
  } catch (err) {
    console.warn(`[xez] MCP event delivery hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The observer's answer, or "no delivery" when there is none or it throws (N-07: never fails the open). */
function pushCapabilityOf(opts: McpServiceOptions, sessionKey: string, transport: McpSessionTransport): McpPushCapability {
  try {
    return opts.sessions?.pushCapability?.(sessionKey, transport) ?? DELIVERY_UNAVAILABLE;
  } catch (err) {
    console.warn(`[xez] MCP push capability check failed: ${err instanceof Error ? err.message : String(err)}`);
    return DELIVERY_UNAVAILABLE;
  }
}

/** Make this connection's session the project's owner, or say why not (D-02.2, § 4). */
async function openSession(id: number, ownership: ProjectOwnership, sessionKey: string, projectId: string): Promise<IpcResponse> {
  let acquired;
  try {
    acquired = await ownership.acquire(sessionKey);
  } catch (err) {
    // The claim could not be written (a read-only data directory, a full disk). Fail closed: no
    // session, so no call runs. The path stays in the cockpit's log, never in a response (F-15).
    console.warn(`[xez] MCP owner claim failed: ${err instanceof Error ? err.message : String(err)}`);
    return failure(id, 'internal', 'xezar could not record which MCP client owns this project; the cockpit log has the details');
  }
  switch (acquired.outcome) {
    case 'owner':
      return { v: IPC_PROTOCOL_VERSION, id, ok: true, result: { owner: true } };
    case 'occupied':
      return { ...failure(id, 'project-occupied', acquired.error.message), rpcError: acquired.error };
    case 'closed':
      // The connection is gone; nobody reads this answer.
      return expired(id, projectId);
  }
}

async function callTool(
  tool: McpTool,
  args: unknown,
  ctx: McpToolContext,
  door: McpDoor | undefined,
  stillOwner: () => boolean,
): Promise<McpToolResult | 'fenced'> {
  const raw = args ?? {};
  const parsed = tool.inputSchema.safeParse(raw);
  // An argument error is a tool result, not a protocol error, so the model can
  // correct itself (MCP 2025-11-25, "Error Handling").
  if (!parsed.success) {
    // #819 item 6: a refusal outranks an argument error. A refused action that also carries a key
    // the schema does not know answers the refusal — which dispatches nothing, names no approval
    // route and echoes no argument — instead of a schema complaint that sends the leader round the
    // loop for an action it can never take. It is answered here, outside the door, exactly as an
    // argument error always was: nothing ran, so there is nothing to receipt or audit. A refused
    // call whose arguments DO validate still reaches the tool through the door below, which gives
    // the same answer from the same code and records it as a refusal, as it always has.
    // The hook is guarded like `tool.call` below, for the same reason (F-15): it runs before the
    // door's try/catch, `callTool` is async, and an unguarded synchronous throw would become a
    // rejected promise that `answer()` awaits with no `catch` and `serveConnection` sends with no
    // `.catch` — an unhandled rejection that takes the whole cockpit process down (one door per
    // registered project, all in it). A throwing `preflight` therefore degrades to the argument
    // error it stands in for, which is what the call answered before the hook existed.
    let refusal: McpToolResult | undefined;
    try {
      refusal = tool.preflight?.(raw, ctx);
    } catch (err) {
      // The exception text stays in the cockpit's own log, never in a tool response (F-15).
      console.warn(`[xez] MCP tool ${tool.name} preflight failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (refusal) return refusal;
    return errorResult(invalidArgumentsText(tool, raw, parsed.error.issues));
  }
  // The fence (D-02.3): equality with the live owner's token, immediately before anything that can
  // change state. A read changes nothing, so it only needed the session check on arrival.
  if (tool.annotations?.readOnlyHint !== true && !stillOwner()) return 'fenced';
  try {
    const invoke = (): Promise<McpToolResult> => tool.call(parsed.data, ctx);
    return await (door ? door({ tool, args: parsed.data as Record<string, unknown>, ctx }, invoke) : invoke());
  } catch (err) {
    // The exception text stays in the cockpit's own log: it can quote a command
    // line or a file, and nothing secret may reach a tool response (F-15).
    console.warn(`[xez] MCP tool ${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    return errorResult(`${tool.name} failed inside xezar; the cockpit's log has the details.`);
  }
}

const issueLine = (issue: z.core.$ZodIssue): string => `${issue.path.join('.') || '(arguments)'}: ${issue.message}`;

/**
 * `Invalid arguments for <tool>: <path>: <message>; …`, and — when a TOP-LEVEL key is unknown —
 * what the call was missing besides, and which keys it takes (#819 item 6).
 *
 * zod stops at an unknown key: the object check aborts before any refinement runs, so the
 * `set_provider_enabled needs provider` a leader most needs is exactly what it never saw. The
 * missing messages are recovered by parsing a copy with the unknown keys left out, against the same
 * schema. That copy is ONLY read for its messages and never dispatched, so `.strict()` keeps
 * refusing the call: a typo'd key is still an error, never silently dropped. (The alternative, a
 * `continue: true` on the strict check, is not available: the unknown-key issue is raised by the
 * object parser itself, not by a check that carries an abort flag.)
 *
 * A nested unknown key (`uiState.appearance.theme`) keeps the plain text: the hint names top-level
 * keys, and a nested object's keys are its own schema's to describe.
 */
function invalidArgumentsText(tool: McpTool, raw: unknown, issues: readonly z.core.$ZodIssue[]): string {
  const lines = issues.map(issueLine);
  const unknownKey = issues.some((issue) => issue.code === 'unrecognized_keys' && issue.path.length === 0);
  if (!unknownKey) return `Invalid arguments for ${tool.name}: ${lines.join('; ')}`;
  // A top-level unknown key is only ever reported for an object, so `raw` is one here.
  const known = Object.keys(tool.inputSchema.shape);
  const stripped = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([key]) => known.includes(key)));
  const again = tool.inputSchema.safeParse(stripped);
  if (!again.success) {
    for (const line of again.error.issues.map(issueLine)) if (!lines.includes(line)) lines.push(line);
  }
  const accepted = tool.acceptedKeys ? tool.acceptedKeys(raw) : schemaKeys(tool);
  return `Invalid arguments for ${tool.name}: ${lines.join('; ')}${accepted ? `. ${acceptedKeysSentence(accepted)}` : ''}`;
}

function expired(id: number, projectId: string): IpcResponse {
  const rpcError = sessionExpiredError(projectId);
  return { ...failure(id, 'session-expired', rpcError.message), rpcError };
}

function failure(
  id: number | null,
  code: Extract<IpcResponse, { ok: false }>['error']['code'],
  message: string,
): Extract<IpcResponse, { ok: false }> {
  return { v: IPC_PROTOCOL_VERSION, id, ok: false, error: { code, message } };
}
