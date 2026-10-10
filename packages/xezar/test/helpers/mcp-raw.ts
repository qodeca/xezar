/**
 * A raw connection to a running MCP service for tests that speak IPC frames themselves (#963).
 * POSIX: `createConnection(path)`, exactly as those tests did before. Windows: the service listens
 * on a named pipe that answers nothing before the pipe handshake, so this reads the endpoint the
 * service wrote next to its marker and says `hello` first – the same check the bridge makes.
 */
import { createConnection, type Socket } from 'node:net';
import type { ServiceTarget } from '../../src/mcp/bridge.ts';
import { mcpSocketDir } from '../../src/mcp/ipc.ts';
import { pipeHello } from '../../src/mcp/pipe-auth.ts';
import { PIPE_NAME_PATTERN, pipeFiles, readPipeEndpoint } from '../../src/mcp/pipe-endpoint.ts';

/** Keys already read, by pipe name: a pipe name is fresh at every start, so its key never changes. */
const knownKeys = new Map<string, Buffer>();

/**
 * The service's endpoint key for `pipeName`, from the IPC folder of `env`. Remembered after the
 * first read, so a test that switches the active state layout after starting a service still reaches it.
 */
export function pipeKeyFor(pipeName: string, projectId: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const known = knownKeys.get(pipeName);
  if (known !== undefined) return known;
  const endpoint = readPipeEndpoint(pipeFiles(mcpSocketDir(env), projectId).endpoint);
  if (typeof endpoint === 'string' || endpoint.pipeName !== pipeName) {
    throw new Error(`no endpoint for ${pipeName} (${typeof endpoint === 'string' ? endpoint : 'another pipe'})`);
  }
  const key = Buffer.from(endpoint.key, 'hex');
  knownKeys.set(pipeName, key);
  return key;
}

/**
 * Connect to `path` (a socket path, or on Windows a pipe name) and resolve once frames can be sent.
 * `projectId` and `env` locate the endpoint on Windows; POSIX ignores them.
 */
export async function connectRaw(path: string, opts: { projectId: string; env?: NodeJS.ProcessEnv }): Promise<Socket> {
  const socket = createConnection(path);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  if (!PIPE_NAME_PATTERN.test(path)) return socket;
  const hello = await pipeHello(socket, { key: pipeKeyFor(path, opts.projectId, opts.env), pipeName: path }, 5_000);
  if (!hello.ok) {
    socket.destroy();
    throw new Error(`pipe handshake failed: ${hello.failure}`);
  }
  if (hello.rest.length > 0) setImmediate(() => socket.emit('data', hello.rest));
  return socket;
}

/**
 * The bridge target for a service handle: POSIX `{ kind: 'socket', path }`, as tests built it by
 * hand before #963; Windows `{ kind: 'pipe', files }` in the IPC folder of `env`, which the bridge
 * opens and proves exactly as in production.
 */
export function targetFor(
  handle: { readonly path: string },
  project: { readonly id: string; readonly name: string },
  env: NodeJS.ProcessEnv = process.env,
): ServiceTarget {
  if (!PIPE_NAME_PATTERN.test(handle.path)) return { kind: 'socket', path: handle.path, project };
  return { kind: 'pipe', files: pipeFiles(mcpSocketDir(env), project.id), project };
}
