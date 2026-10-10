import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectRaw } from '../../test/helpers/mcp-raw.ts';
import { onWindows, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { acquireFileLock } from '../core/file-lock.ts';
import { launch } from '../platform/process-launch.ts';
import { readProcessTable } from '../platform/process-table.ts';
import { stopChildTree } from '../platform/process-tree.ts';
import { checkPrivateDir } from '../platform/private-dir.ts';
import { mcpSocketDir } from './ipc.ts';
import { newPipeKey, newPipeName, pipeFiles, readPipeEndpoint, readPipeMarker, writePipeFiles } from './pipe-endpoint.ts';
import { listenMcpSocket, MCP_ALREADY_SERVING, type McpServiceHandle } from './service.ts';

/**
 * #963, real Windows: the engine's side of the pipe rendezvous – the private folder, the endpoint
 * and marker, refusing a live engine, replacing a stale one, and removing only its own files.
 */

let home = '';
let env: NodeJS.ProcessEnv;
const project = { id: 'alpha', name: 'Alpha', root: '' };
const handles: McpServiceHandle[] = [];

// win32-skip(#976): the named-pipe rendezvous exists on Windows only; its rules run everywhere in pipe-endpoint/pipe-auth tests
describe.skipIf(!onWindows)('the MCP pipe rendezvous on Windows (#963)', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'xez-pipe-svc-'));
    env = { XEZ_HOME: home };
    project.root = join(home, 'alpha');
    mkdirSync(project.root);
  });
  afterEach(() => {
    for (const handle of handles.splice(0)) handle.close();
    rmSync(home, TEST_DIR_RM_OPTIONS);
  });

  const files = () => pipeFiles(mcpSocketDir(env), project.id);
  const listen = async () => {
    const handle = await listenMcpSocket({ project, version: '1.2.3', tools: [], env });
    handles.push(handle);
    return handle;
  };

  it('listens on a fresh pipe, writes endpoint then marker in a private folder, and answers after the handshake', async () => {
    const handle = await listen();
    const endpoint = readPipeEndpoint(files().endpoint);
    expect(typeof endpoint).toBe('object');
    expect(endpoint).toMatchObject({ v: 1, pipeName: handle.path, pid: process.pid });
    expect(readPipeMarker(files().marker)).toBe(handle.path);
    expect(await checkPrivateDir(files().dir, [files().endpoint, files().marker])).toEqual({ ok: true });
    const socket = await connectRaw(handle.path, { projectId: project.id, env });
    socket.destroy();
  }, 60_000);

  it('a restart names a new pipe; close removes only files that still name its own pipe', async () => {
    const first = await listen();
    handles.splice(0).forEach((h) => h.close());
    await vi.waitFor(() => expect(existsSync(files().marker)).toBe(false), { timeout: 15_000 });
    expect(existsSync(files().endpoint)).toBe(false);
    const second = await listen();
    expect(second.path).not.toBe(first.path);
    // An old handle closing late leaves the new engine's files alone.
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(readPipeMarker(files().marker)).toBe(second.path);
  }, 60_000);

  it('refuses to start while a live engine serves the project, and replaces a stale endpoint', async () => {
    const other = launch(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      let startedAt: number | undefined;
      await vi.waitFor(async () => {
        startedAt = (await readProcessTable())?.rows.find((row) => row.pid === other.pid)?.startedAt;
        expect(startedAt).toBeTypeOf('number');
      }, { timeout: 15_000 });
      mkdirSync(files().dir, { recursive: true });
      writePipeFiles(files(), { v: 1, pipeName: newPipeName(), key: newPipeKey(), pid: other.pid!, processStartTime: startedAt! });
      await expect(listen()).rejects.toThrow(MCP_ALREADY_SERVING);

      // The same pid with another start time is a name an exited engine left: replaced.
      writePipeFiles(files(), { v: 1, pipeName: newPipeName(), key: newPipeKey(), pid: other.pid!, processStartTime: startedAt! + 5_000 });
      const handle = await listen();
      expect(readPipeMarker(files().marker)).toBe(handle.path);
    } finally {
      await stopChildTree(other, 'SIGTERM');
    }
  }, 90_000);

  it('waits for the start/stop lock another engine holds, and refuses to start without it', async () => {
    mkdirSync(files().dir, { recursive: true });
    const held = await acquireFileLock(files().lock);
    expect(held.acquired).toBe(true);
    try {
      await expect(listen()).rejects.toThrow(/another xezar is starting or stopping MCP for this project/);
      expect(existsSync(files().marker)).toBe(false);
    } finally {
      if (held.acquired) await held.release();
    }
  }, 60_000);

  it('two starts at once are serialised: one serves, the other is refused, and the files name the one', async () => {
    const settled = await Promise.allSettled([listen(), listen()]);
    const served = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    const refused = settled.flatMap((s) => (s.status === 'rejected' ? [s.reason as Error] : []));
    expect(served).toHaveLength(1);
    expect(refused.map((e) => e.message)).toEqual([MCP_ALREADY_SERVING]);
    const named = readPipeMarker(files().marker);
    expect(named).toBe(served[0]!.path);
    const endpoint = readPipeEndpoint(files().endpoint);
    expect(typeof endpoint === 'object' && endpoint.pipeName).toBe(named);
    const socket = await connectRaw(named as string, { projectId: project.id, env });
    socket.destroy();
  }, 90_000);
});
