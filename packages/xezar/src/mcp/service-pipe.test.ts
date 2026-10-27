import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onWindows, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { acquireFileLock, FILE_LOCK_TAKEOVER_GUARD_SUFFIX } from '../core/file-lock.ts';
import type { PrivateDirResult } from '../platform/private-dir.ts';
import { socketTempRoot } from '../platform/socket-dir.ts';
import { mcpSocketDir } from './ipc.ts';
import { pipeHello } from './pipe-auth.ts';
import { ADMIN_FILES_FAILED, newPipeKey, newPipeName, pipeFiles, readPipeEndpoint, readPipeMarker, writePipeFiles, type PipeEndpoint } from './pipe-endpoint.ts';
import { listenMcpSocket, MCP_ALREADY_SERVING, type McpPipeSeams, type McpServiceHandle } from './service.ts';

/**
 * #963, every OS: the engine's side of the Windows pipe rendezvous with its two Windows-only parts
 * replaced – the private-folder check answers from the test, and on Linux and macOS a pipe name
 * listens on a short local socket. The real Windows run is `service-pipe.windows.test.ts`.
 */

const OWN_START = 1_800_000_000_000;
let home = '';
let sockets = '';
let env: NodeJS.ProcessEnv;
const project = { id: 'alpha', name: 'Alpha', root: '' };
const handles: McpServiceHandle[] = [];
const servers: Server[] = [];
/** The start time the folder check reports for an endpoint's pid; null: not running. */
let foreignStart: number | null = null;

const okEnsure = async (dir: string): Promise<PrivateDirResult> => {
  await mkdir(dir, { recursive: true });
  return { ok: true, startedAt: OWN_START };
};
/** #980: the administrators-only folder, injected so the test controls it (no real %ProgramData%). */
const adminIpcFor = () => {
  const leaf = join(home, 'ipc-admin');
  return { dir: leaf, create: [leaf], ancestors: [home] };
};
const adminChain = () => ({ create: adminIpcFor().create, ancestors: adminIpcFor().ancestors });
/** #980: stands in for the script that creates each file owned by Administrators – here, a new empty file. */
const createEmpty = async (paths: readonly string[]): Promise<boolean> => {
  for (const path of paths) writeFileSync(path, '', { flag: 'wx' });
  return true;
};
const seams = (extra: McpPipeSeams = {}): McpPipeSeams => ({
  // A process without administrator rights, whatever the host (#980): the user's own folder.
  elevated: () => false,
  resolveAdmin: () => adminIpcFor(),
  createAdminFiles: createEmpty,
  ensurePrivateDir: okEnsure,
  checkPrivateDir: async () => ({ ok: true, startedAt: foreignStart }),
  ...(onWindows ? {} : { listenAt: (name: string) => join(sockets, `${name.slice(-12)}.sock`) }),
  ...extra,
});
const files = () => pipeFiles(mcpSocketDir(env), project.id);
const listen = async (extra?: McpPipeSeams) => {
  const handle = await listenMcpSocket({ project, version: '1.2.3', tools: [], env, platform: 'win32', pipe: seams(extra) });
  handles.push(handle);
  return handle;
};
/** A release removes the lock, then its takeover guard: the folder is settled only once both are gone. */
const lockReleased = (lock: string): void => expect([existsSync(lock), existsSync(`${lock}${FILE_LOCK_TAKEOVER_GUARD_SUFFIX}`)]).toEqual([false, false]);
const address = (pipeName: string): string => seams().listenAt?.(pipeName) ?? pipeName;
const foreignEndpoint = (): PipeEndpoint => ({ v: 1, pipeName: newPipeName(), key: newPipeKey(), pid: process.pid + 1, processStartTime: 1_700_000_000_000 });

describe('the MCP pipe rendezvous, Windows rules on every OS (#963)', () => {
  beforeEach(() => {
    home = realpathSync.native(mkdtempSync(join(tmpdir(), 'xez-pipe-any-')));
    // Socket files go below this folder, so it must leave room for a Unix socket path from any checkout.
    sockets = realpathSync.native(mkdtempSync(join(socketTempRoot('/xps-XXXXXX/0123456789ab.sock'.length), 'xps-')));
    env = { XEZ_HOME: home };
    project.root = join(home, 'alpha');
    mkdirSync(project.root);
    foreignStart = null;
  });
  afterEach(async () => {
    const closing = handles.length > 0;
    for (const handle of handles.splice(0)) handle.close();
    for (const server of servers.splice(0)) server.close();
    // A close removes its files under the pipe lock, after it returns: wait until that lock is gone.
    if (closing) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await vi.waitFor(() => lockReleased(files().lock), { timeout: 15_000 });
    }
    rmSync(home, { ...TEST_DIR_RM_OPTIONS, maxRetries: 10, retryDelay: 100 });
    rmSync(sockets, TEST_DIR_RM_OPTIONS);
  });

  it('writes the endpoint, then the marker, and admits only a client that proves the key', async () => {
    const handle = await listen();
    const endpoint = readPipeEndpoint(files().endpoint);
    if (typeof endpoint === 'string') throw new Error(`endpoint ${endpoint}`);
    expect(endpoint).toMatchObject({ v: 1, pipeName: handle.path, pid: process.pid, processStartTime: OWN_START });
    expect(readPipeMarker(files().marker)).toBe(handle.path);

    const good = createConnection(address(handle.path));
    const hello = await pipeHello(good, { key: Buffer.from(endpoint.key, 'hex'), pipeName: handle.path }, 5_000);
    expect(hello.ok).toBe(true);
    good.destroy();

    // #980: the engine now authenticates the client too, so a wrong key fails the client's own
    // `auth` step and the engine drops the connection – the bridge sees it close, not a foreign MAC.
    const bad = createConnection(address(handle.path));
    const refused = await pipeHello(bad, { key: Buffer.from(newPipeKey(), 'hex'), pipeName: handle.path }, 5_000);
    expect(refused).toEqual({ ok: false, failure: 'closed' });
    bad.destroy();
  });

  it('refuses a second start in the same process while it serves, and starts again once closed', async () => {
    const first = await listen();
    await expect(listen()).rejects.toThrow(MCP_ALREADY_SERVING);
    handles.splice(0).forEach((h) => h.close());
    const second = await listen();
    expect(second.path).not.toBe(first.path);
  });

  it('refuses a live foreign endpoint and replaces a stale one', async () => {
    const live = foreignEndpoint();
    mkdirSync(files().dir, { recursive: true });
    writePipeFiles(files(), live);
    foreignStart = live.processStartTime;
    await expect(listen()).rejects.toThrow(MCP_ALREADY_SERVING);
    expect(readPipeMarker(files().marker)).toBe(live.pipeName);

    foreignStart = null;
    const handle = await listen();
    expect(readPipeMarker(files().marker)).toBe(handle.path);
    expect(handle.path).not.toBe(live.pipeName);
  });

  it('a pid now running with another start time is stale too', async () => {
    const stale = foreignEndpoint();
    mkdirSync(files().dir, { recursive: true });
    writePipeFiles(files(), stale);
    foreignStart = stale.processStartTime + 1;
    const handle = await listen();
    expect(readPipeMarker(files().marker)).toBe(handle.path);
  });

  it('a folder that is not private, or an unknown own start time, stops the start before anything listens', async () => {
    await expect(listen({ ensurePrivateDir: async () => ({ ok: false, reason: 'not-private', message: 'the MCP folder is not private' }) }))
      .rejects.toThrow('the MCP folder is not private');
    await expect(listen({ ensurePrivateDir: async (dir) => (await mkdir(dir, { recursive: true }), { ok: true }) }))
      .rejects.toThrow('could not read its own start time');
    expect(readPipeMarker(files().marker)).toBe('missing');
  });

  // #980: an elevated engine makes and judges the administrators-only %ProgramData% folder, never
  // the user's, creating its whole chain in the script. Node never creates a file there: the
  // endpoint and marker ARE the files `createAdminFiles` made (owned by Administrators from their
  // first moment), written in place and renamed over the old ones.
  it('an elevated engine listens from the administrators-only folder, its files created by createAdminFiles', async () => {
    const ensured: Array<{ dir: string; options: unknown }> = [];
    const admin = pipeFiles(join(home, 'ipc-admin'), project.id, true, adminChain());
    const created: Array<{ path: string; ino: number; finalsExisted: boolean }> = [];
    const handle = await listen({
      elevated: () => true,
      ensurePrivateDir: async (dir, _deps, options) => (ensured.push({ dir, options }), okEnsure(dir)),
      createAdminFiles: async (paths) => {
        const finalsExisted = existsSync(admin.endpoint) || existsSync(admin.marker);
        const made = await createEmpty(paths);
        for (const path of paths) created.push({ path, ino: statSync(path).ino, finalsExisted });
        return made;
      },
    });
    expect(ensured).toEqual([{ dir: admin.dir, options: { startTimeOf: process.pid, elevated: true, adminChain: adminChain() } }]);
    expect(readPipeMarker(admin.marker)).toBe(handle.path);
    expect(readPipeEndpoint(admin.endpoint)).toMatchObject({ pipeName: handle.path, pid: process.pid });
    // One call, endpoint then marker, before either file existed – and those very files are now in place.
    expect(created.map((c) => c.path)).toEqual([expect.stringMatching(/\.key\.\d+\.[0-9a-f]{8}\.tmp$/), expect.stringMatching(/\.pipe\.\d+\.[0-9a-f]{8}\.tmp$/)]);
    expect(created.every((c) => !c.finalsExisted)).toBe(true);
    expect([statSync(admin.endpoint).ino, statSync(admin.marker).ino]).toEqual(created.map((c) => c.ino));
    expect(readdirSync(admin.dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(existsSync(files().dir)).toBe(false);
    handles.splice(0).forEach((h) => h.close());
    await vi.waitFor(() => lockReleased(admin.lock), { timeout: 15_000 });
  });

  it('an elevated engine that cannot create its files owned by Administrators does not start, and leaves nothing behind (#980)', async () => {
    const admin = pipeFiles(join(home, 'ipc-admin'), project.id, true, adminChain());
    // The script made the first file, then failed on the second (a token that may not name Administrators).
    const halfway = async (paths: readonly string[]) => (writeFileSync(paths[0]!, '', { flag: 'wx' }), false);
    await expect(listen({ elevated: () => true, createAdminFiles: halfway })).rejects.toThrow(ADMIN_FILES_FAILED);
    expect([existsSync(admin.endpoint), existsSync(admin.marker)]).toEqual([false, false]);
    expect(readdirSync(admin.dir).filter((name) => name !== `${project.id}.lock`)).toEqual([]);
    await vi.waitFor(() => lockReleased(admin.lock), { timeout: 15_000 });
  });

  it('an engine without administrator rights asks for the user folder exactly as before #980', async () => {
    const ensured: Array<{ dir: string; options: unknown }> = [];
    await listen({ ensurePrivateDir: async (dir, _deps, options) => (ensured.push({ dir, options }), okEnsure(dir)) });
    expect(ensured).toEqual([{ dir: files().dir, options: { startTimeOf: process.pid } }]);
  });

  it('waits for the pipe lock and says so when another start holds it', async () => {
    mkdirSync(files().dir, { recursive: true });
    const held = await acquireFileLock(files().lock, { waitMs: 1_000 });
    expect(held.acquired).toBe(true);
    try {
      await expect(listen()).rejects.toThrow('another xezar is starting or stopping MCP for this project');
    } finally {
      if (held.acquired) await held.release();
    }
  }, 30_000);

  // win32-skip(#976): a Windows pipe name cannot be held by another server the way a socket path can
  it.runIf(!onWindows)('gives up after three names that are all in use', async () => {
    const taken = join(sockets, 'taken.sock');
    const squat = createServer(() => {});
    servers.push(squat);
    await new Promise<void>((resolve) => squat.listen(taken, resolve));
    const listenAt = vi.fn(() => taken);
    await expect(listen({ listenAt })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(listenAt).toHaveBeenCalledTimes(3);
    expect(readPipeMarker(files().marker)).toBe('missing');
  });

  it('close removes the files only while they still name its own pipe', async () => {
    const first = await listen();
    handles.splice(0).forEach((h) => h.close());
    await vi.waitFor(() => expect(readPipeMarker(files().marker)).toBe('missing'), { timeout: 15_000 });
    expect(readPipeEndpoint(files().endpoint)).toBe('missing');

    const second = await listen();
    const other = foreignEndpoint();
    writePipeFiles(files(), other);
    handles.splice(0).forEach((h) => h.close());
    // Give the close's lock-guarded removal time to run, then check it left another pipe's files.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await acquireFileLock(files().lock, { waitMs: 10_000 }).then((l) => (l.acquired ? l.release() : undefined));
    expect(readPipeMarker(files().marker)).toBe(other.pipeName);
    expect(JSON.parse(readFileSync(files().endpoint, 'utf8')).pipeName).toBe(other.pipeName);
    expect(second.path).not.toBe(first.path);
  });
});
