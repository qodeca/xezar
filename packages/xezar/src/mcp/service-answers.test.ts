import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ProjectOwnership, sessionExpiredError } from '../workspace/project-owner.ts';
import { startMcpService } from './index.ts';
import { IPC_PROTOCOL_VERSION, LineFramer, encodeFrame, type IpcResponse } from './ipc.ts';
import { listenMcpSocket } from './service.ts';
import { defineTool, textResult, type McpTool } from './tool.ts';

/**
 * The service's answers to frames the bridge never sends on its good path (#333): a frame that is
 * JSON but not a request, `health` and `tools/call` before the session owns the project, a
 * `tools/call` with no tool name, the mutation fence, and an owner claim that cannot be written.
 * Driven over the real socket with raw frames, because the bridge validates before it sends and
 * so cannot produce most of these. `bridge.test.ts` covers the same loop through the real bridge.
 */

// A short home under /tmp, never the per-worker sandbox: the sandbox sits under the task's
// TMPDIR, which is already past the 104-byte socket limit on macOS (D-01 E5, § 9.5).
let home: string;
let env: NodeJS.ProcessEnv;
let project: { id: string; name: string; root: string };
const closers: Array<() => void> = [];

beforeEach(() => {
  home = mkdtempSync('/tmp/xzs-');
  env = { XEZ_HOME: home };
  project = { id: 'alpha', name: 'Alpha', root: join(home, 'alpha') };
  mkdirSync(project.root);
});
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

let writes = 0;
const write = defineTool({
  name: 'write_thing',
  description: 'A mutating tool: counts its runs.',
  inputSchema: z.object({}),
  async call() {
    writes++;
    return textResult('written');
  },
});
let reads = 0;
const read = defineTool({
  name: 'read_thing',
  description: 'A read-only tool: counts its runs.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true },
  async call() {
    reads++;
    return textResult('read');
  },
});
beforeEach(() => {
  writes = 0;
  reads = 0;
});

/** One raw connection to the socket; `send` writes a frame and resolves with the answer to its id. */
async function connect(opts: { tools?: readonly McpTool[]; ownership?: ProjectOwnership; dataDir?: string } = {}) {
  const handle = await listenMcpSocket({ project, version: '1.2.3', tools: opts.tools ?? [write, read], env, ...opts });
  closers.push(() => handle.close());
  const socket: Socket = createConnection(handle.path);
  closers.push(() => socket.destroy());
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const waiting = new Map<number | null, (r: IpcResponse) => void>();
  const framer = new LineFramer(
    (line) => {
      const response = JSON.parse(line) as IpcResponse;
      waiting.get(response.id)?.(response);
      waiting.delete(response.id);
    },
    () => undefined,
  );
  socket.on('data', (chunk: Buffer) => framer.push(chunk));
  /** Resolves with the answer, or with `undefined` when none comes in time. */
  const send = (frame: unknown, id: number | null): Promise<IpcResponse | undefined> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve(undefined);
      }, 2_000);
      waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      socket.write(typeof frame === 'string' ? frame : encodeFrame(frame));
    });
  const request = (id: number, method: string, params?: unknown) =>
    send({ v: IPC_PROTOCOL_VERSION, id, method, ...(params === undefined ? {} : { params }) }, id);
  return { send, request };
}

describe('the MCP service answers what the bridge never sends (#333)', () => {
  it('refuses a frame that is JSON but not a request, with bad-frame', async () => {
    const c = await connect();
    const answer = await c.send(encodeFrame({ hello: 'there' }), null);
    expect(answer).toEqual({ v: IPC_PROTOCOL_VERSION, id: null, ok: false, error: { code: 'bad-frame', message: 'frame is not a request' } });
  });

  it('answers health with session-expired until session/open has made this connection the owner', async () => {
    const c = await connect();
    const before = await c.request(1, 'health');
    expect(before).toMatchObject({ id: 1, ok: false, error: { code: 'session-expired' } });
    expect((before as { rpcError?: unknown }).rpcError).toEqual(sessionExpiredError(project.id));

    expect(await c.request(2, 'session/open')).toMatchObject({ id: 2, ok: true, result: { owner: true } });
    expect(await c.request(3, 'health')).toMatchObject({
      id: 3,
      ok: true,
      result: { ipcVersion: IPC_PROTOCOL_VERSION, xezarVersion: '1.2.3', project: { id: 'alpha', name: 'Alpha' } },
    });
  });

  it('refuses a tools/call with no tool name as invalid-params, and runs nothing', async () => {
    const c = await connect();
    await c.request(1, 'session/open');
    expect(await c.request(2, 'tools/call', { arguments: {} })).toMatchObject({
      id: 2,
      ok: false,
      error: { code: 'invalid-params', message: 'tools/call needs a tool name' },
    });
    expect(writes).toBe(0);
  });

  it('fences a mutating call whose session lost the project after it arrived; a read still runs (D-02.3)', async () => {
    // The live-owner check at arrival and the fence right before the tool are two readings of the
    // same slot. This slot answers the first "yes, you own it" and the fence "no" – what a lease
    // lapsing between the two looks like – so the fence is the only thing that can stop the write.
    const ownership = {
      acquire: async () => ({ outcome: 'owner' as const, token: 't-1' }),
      sessionToken: () => 't-1',
      checkMutation: () => ({ ok: false as const, error: sessionExpiredError(project.id) }),
      release: () => undefined,
      dispose: () => undefined,
    } as unknown as ProjectOwnership;
    const c = await connect({ ownership });
    await c.request(1, 'session/open');

    const fenced = await c.request(2, 'tools/call', { name: 'write_thing', arguments: {} });
    expect(fenced).toMatchObject({ id: 2, ok: false, error: { code: 'session-expired' } });
    expect(writes).toBe(0);

    // A read changes nothing, so it only needed the session check on arrival.
    expect(await c.request(3, 'tools/call', { name: 'read_thing', arguments: {} })).toMatchObject({ id: 3, ok: true });
    expect(reads).toBe(1);
  });

  it('fails closed when the owner claim cannot be written, and keeps the path out of the answer (F-15)', async () => {
    // The data directory sits under a regular FILE, so the claim's mkdir fails with ENOTDIR –
    // a stand-in for the read-only directory or full disk the service is written for.
    const blocker = join(home, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const dataDir = join(blocker, 'data');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const c = await connect({ dataDir });

    const opened = await c.request(1, 'session/open');
    expect(opened).toMatchObject({ id: 1, ok: false, error: { code: 'internal' } });
    expect(JSON.stringify(opened)).not.toContain(blocker);
    // No session, so no call runs.
    expect(await c.request(2, 'tools/call', { name: 'write_thing', arguments: {} })).toMatchObject({ ok: false, error: { code: 'session-expired' } });
    expect(writes).toBe(0);
    // The details are in the cockpit's own log.
    expect(warn.mock.calls.flat().join('\n')).toContain(blocker);
  });
});

describe('startMcpService, for a project the registry does not know (#333)', () => {
  it('refuses with a readable error and opens no socket', async () => {
    // The cockpit's boot treats this throw as a warning (N-07); what must not happen is a socket
    // served for a project with no registry entry, so the check comes before anything is opened.
    await expect(startMcpService({ projectId: 'not-registered-anywhere', version: '1.2.3', env })).rejects.toThrow(
      'project not-registered-anywhere is not in the workspace registry',
    );
    expect(existsSync(join(home, 'ipc'))).toBe(false);
  });
});
