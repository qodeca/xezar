import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { assertXezarHomeWriteIsSandboxed } from '../paths.ts';
import {
  IPC_PROTOCOL_VERSION,
  LineFramer,
  encodeFrame,
  ipcRequestSchema,
  mcpSocketDir,
  mcpSocketLocation,
  toolCallParamsSchema,
  type HealthResult,
  type IpcResponse,
} from './ipc.ts';
import { errorResult, type McpTool, type McpToolContext, type McpToolResult } from './tool.ts';

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

  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    serveConnection(socket, opts);
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

function serveConnection(socket: Socket, opts: McpServiceOptions): void {
  socket.on('error', () => {
    // A bridge that vanished mid-answer is not the cockpit's problem.
  });
  const send = (response: IpcResponse): void => {
    if (!socket.destroyed) socket.write(encodeFrame(response));
  };
  const framer = new LineFramer(
    (line) => {
      void answer(line, opts).then(send);
    },
    () => send(failure(null, 'bad-frame', 'frame too large')),
  );
  socket.on('data', (chunk: Buffer) => framer.push(chunk));
}

async function answer(line: string, opts: McpServiceOptions): Promise<IpcResponse> {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return failure(null, 'bad-frame', 'frame is not JSON');
  }
  const parsed = ipcRequestSchema.safeParse(json);
  if (!parsed.success) return failure(null, 'bad-frame', 'frame is not a request');
  const request = parsed.data;
  if (request.v !== IPC_PROTOCOL_VERSION) {
    return {
      ...failure(request.id, 'version-mismatch', `this xezar speaks bridge protocol ${IPC_PROTOCOL_VERSION}, the bridge sent ${request.v}`),
      serviceVersion: opts.version,
    };
  }
  const ctx: McpToolContext = { ...opts.context, project: opts.project, xezarVersion: opts.version };
  switch (request.method) {
    case 'health': {
      const result: HealthResult = {
        ipcVersion: IPC_PROTOCOL_VERSION,
        xezarVersion: opts.version,
        project: { id: opts.project.id, name: opts.project.name },
      };
      return { v: IPC_PROTOCOL_VERSION, id: request.id, ok: true, result };
    }
    case 'tools/call': {
      const params = toolCallParamsSchema.safeParse(request.params);
      if (!params.success) return failure(request.id, 'invalid-params', 'tools/call needs a tool name');
      const tool = opts.tools.find((t) => t.name === params.data.name);
      if (!tool) return failure(request.id, 'unknown-tool', `unknown tool: ${params.data.name}`);
      return { v: IPC_PROTOCOL_VERSION, id: request.id, ok: true, result: await callTool(tool, params.data.arguments, ctx, opts.door) };
    }
    default:
      return failure(request.id, 'unknown-method', `unknown method: ${request.method}`);
  }
}

async function callTool(tool: McpTool, args: unknown, ctx: McpToolContext, door?: McpDoor): Promise<McpToolResult> {
  const parsed = tool.inputSchema.safeParse(args ?? {});
  // An argument error is a tool result, not a protocol error, so the model can
  // correct itself (MCP 2025-11-25, "Error Handling").
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`);
    return errorResult(`Invalid arguments for ${tool.name}: ${issues.join('; ')}`);
  }
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

function failure(
  id: number | null,
  code: Extract<IpcResponse, { ok: false }>['error']['code'],
  message: string,
): Extract<IpcResponse, { ok: false }> {
  return { v: IPC_PROTOCOL_VERSION, id, ok: false, error: { code, message } };
}
