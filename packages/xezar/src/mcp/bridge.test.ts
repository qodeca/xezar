import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HEALTH_TOOL, runBridge, type ServiceTarget } from './bridge.ts';
import { LineFramer, encodeFrame } from './ipc.ts';
import { SERVER_CAPABILITIES } from './protocol.ts';
import { listenMcpSocket, type McpServiceHandle } from './service.ts';
import { defineTool, textResult, type McpTool } from './tool.ts';

// A short home under /tmp, never the per-worker sandbox: the sandbox sits under the task's
// TMPDIR, which is already past the 104-byte socket limit on macOS (D-01 E5, § 9.5).
let home: string;
let env: NodeJS.ProcessEnv;
let project: { id: string; name: string; root: string };
const handles: Array<{ close(): void }> = [];

beforeEach(() => {
  home = mkdtempSync('/tmp/xzb-');
  env = { XEZ_HOME: home };
  // A real folder: the service keeps the project's MCP owner claim in its `.local/xezar` (#302).
  project = { id: 'alpha', name: 'Alpha', root: join(home, 'alpha') };
  mkdirSync(project.root);
});
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  rmSync(home, { recursive: true, force: true });
});

const echoProject = defineTool({
  name: 'echo_project',
  description: 'Echo text with the bound project id.',
  inputSchema: z.object({ text: z.string().max(10) }),
  async call(args, ctx) {
    return textResult(`${args.text} from ${ctx.project.id}`);
  },
});

const boom = defineTool({
  name: 'boom',
  description: 'Always throws.',
  inputSchema: z.object({}),
  async call() {
    throw new Error('token=ghp_secret123 leaked');
  },
});

async function service(tools: readonly McpTool[] = []): Promise<McpServiceHandle> {
  const handle = await listenMcpSocket({ project, version: '1.2.3', tools, env });
  handles.push(handle);
  return handle;
}

/** An in-process bridge with a tiny JSON-RPC client in front of it. */
function bridge(opts: { tools?: readonly McpTool[]; target: () => Promise<ServiceTarget>; timeoutMs?: number }) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<Record<string, unknown>> = [];
  const listeners = new Set<() => void>();
  const framer = new LineFramer(
    (line) => {
      messages.push(JSON.parse(line) as Record<string, unknown>);
      for (const l of listeners) l();
    },
    () => {},
  );
  output.on('data', (c: Buffer) => framer.push(c));
  const done = runBridge({
    input,
    output,
    version: '1.2.3',
    tools: opts.tools ?? [],
    resolveTarget: opts.target,
    ...(opts.timeoutMs ? { requestTimeoutMs: opts.timeoutMs } : {}),
  });
  const waitFor = (match: (m: Record<string, unknown>) => boolean) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const check = () => {
        const found = messages.find(match);
        if (found) {
          listeners.delete(check);
          resolve(found);
        }
      };
      listeners.add(check);
      check();
    });
  let nextId = 100;
  const request = async (method: string, params?: unknown) => {
    const id = nextId++;
    input.write(encodeFrame({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
    return waitFor((m) => m.id === id);
  };
  return { input, messages, waitFor, request, done };
}

const socketTarget = (path: string): (() => Promise<ServiceTarget>) => async () => ({
  kind: 'socket',
  path,
  project: { id: project.id, name: project.name },
});
const text = (m: Record<string, unknown>) =>
  ((m.result as { content: Array<{ text: string }> }).content[0]?.text ?? '');

describe('bridge handshake (D-01 § 1.6, N-07)', () => {
  it('negotiates the revision and advertises tools only; with no service the handshake still succeeds', async () => {
    let resolved = 0;
    const b = bridge({ target: async () => ((resolved += 1), socketTarget('/nonexistent')()) });
    for (const version of ['2025-06-18', '2025-11-25']) {
      const init = await b.request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '1' } });
      expect(init.result).toMatchObject({
        protocolVersion: version,
        capabilities: SERVER_CAPABILITIES,
        serverInfo: { name: 'xezar', version: '1.2.3' },
      });
    }
    // `initialize` is where a session acquires the project (D-02.6, #302), so it does look for the
    // service — and a service that is not there leaves the handshake healthy (N-07).
    expect(resolved).toBe(2);
    b.input.write(encodeFrame({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect((await b.request('ping')).result).toEqual({});
    // An empty registry still lists the built-in health tool.
    expect((await b.request('tools/list')).result).toEqual({ tools: [HEALTH_TOOL] });
    // Neither `ping` nor `tools/list` touches the service.
    expect(resolved).toBe(2);
    // The notification got no answer: every message so far is a response to a request.
    expect(b.messages.every((m) => typeof m.id === 'number')).toBe(true);
    b.input.end();
    await b.done;
  });

  it('answers protocol errors in JSON-RPC terms and keeps serving', async () => {
    const b = bridge({ target: socketTarget('/nonexistent') });
    b.input.write('not json\n');
    expect((await b.waitFor((m) => m.id === null)).error).toMatchObject({ code: -32700 });
    expect((await b.request('resources/list')).error).toMatchObject({ code: -32601 });
    expect((await b.request('initialize', {})).error).toMatchObject({ code: -32602 });
    expect((await b.request('tools/call', { name: 'nope' })).error).toMatchObject({ code: -32602 });
    expect((await b.request('ping')).result).toEqual({});
  });

  it('lists registry tools with the JSON Schema derived from their zod input', async () => {
    const b = bridge({ tools: [echoProject], target: socketTarget('/nonexistent') });
    const listed = (await b.request('tools/list')).result as { tools: Array<Record<string, unknown>> };
    expect(listed.tools.map((t) => t.name)).toEqual(['health', 'echo_project']);
    expect(listed.tools[1]?.inputSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string', maxLength: 10 } },
      required: ['text'],
    });
  });
});

describe('bridge → service over the project socket', () => {
  it('reports health, binding the project from the socket and never from arguments', async () => {
    const svc = await service();
    const b = bridge({ target: socketTarget(svc.path) });
    const res = await b.request('tools/call', { name: 'health', arguments: { projectId: 'beta' } });
    expect(res.result).toMatchObject({
      structuredContent: { status: 'running', xezarVersion: '1.2.3', project: { id: 'alpha', name: 'Alpha' } },
    });
    expect((res.result as { isError?: boolean }).isError).toBeUndefined();
    expect(text(res)).toBe('xezar 1.2.3 is running for project Alpha (alpha).');
  });

  it('runs registry tools in the service with the bound project, validating arguments first', async () => {
    const svc = await service([echoProject, boom]);
    const b = bridge({ tools: [echoProject, boom], target: socketTarget(svc.path) });
    const ok = await b.request('tools/call', { name: 'echo_project', arguments: { text: 'hi', projectId: 'beta' } });
    expect(text(ok)).toBe('hi from alpha');
    const invalid = await b.request('tools/call', { name: 'echo_project', arguments: { text: 'far too long text' } });
    expect(invalid.result).toMatchObject({ isError: true });
    expect(text(invalid)).toMatch(/^Invalid arguments for echo_project: text:/);
    // F-15: an exception's text never reaches the tool response.
    const thrown = await b.request('tools/call', { name: 'boom' });
    expect(thrown.result).toMatchObject({ isError: true });
    expect(JSON.stringify(thrown)).not.toContain('ghp_secret123');
  });

  it('fails fast and readably when the service is not running (D-01 § 5)', async () => {
    const b = bridge({ target: socketTarget(join(home, 'ipc', 'alpha.sock')) });
    const started = Date.now();
    const res = await b.request('tools/call', { name: 'health' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.result).toMatchObject({ isError: true, structuredContent: { status: 'not-running' } });
    expect(text(res)).toMatch(/^xezar is not running for project Alpha \(alpha\)\. Start the cockpit/);
  });

  it('passes an unavailable target straight through as the tool result', async () => {
    const b = bridge({ target: async () => ({ kind: 'unavailable', status: 'not-registered', message: 'Not a project.' }) });
    const res = await b.request('tools/call', { name: 'health' });
    expect(res.result).toEqual({
      content: [{ type: 'text', text: 'Not a project.' }],
      structuredContent: { status: 'not-registered' },
      isError: true,
    });
  });

  it('answers a hung service with a timeout result instead of hanging', async () => {
    const path = join(home, 'hung.sock');
    const hung: Server = createServer(() => {}); // accepts, never answers
    await new Promise<void>((r) => hung.listen(path, r));
    handles.push({ close: () => hung.close() });
    const b = bridge({ target: socketTarget(path), timeoutMs: 150 });
    const res = await b.request('tools/call', { name: 'health' });
    expect(res.result).toMatchObject({ isError: true, structuredContent: { status: 'timeout' } });
  });

  it('never tells the model to blindly retry a call whose connection closed mid-flight', async () => {
    // A write that passed the fence still finishes in the service, so "call again" could run it twice.
    const path = join(home, 'drops.sock');
    const drops: Server = createServer((socket) => {
      const framer = new LineFramer((line) => {
        const req = JSON.parse(line) as { v: number; id: number; method: string };
        if (req.method === 'session/open') socket.write(encodeFrame({ v: req.v, id: req.id, ok: true, result: { owner: true } }));
        else socket.destroy();
      }, () => {});
      socket.on('data', (c: Buffer) => framer.push(c));
    });
    await new Promise<void>((r) => drops.listen(path, r));
    handles.push({ close: () => drops.close() });
    const b = bridge({ target: socketTarget(path) });
    await b.request('initialize', { protocolVersion: '2025-06-18' });
    const res = await b.request('tools/call', { name: 'health' });
    expect(res.result).toMatchObject({ isError: true, structuredContent: { status: 'unreachable' } });
    expect(text(res)).toMatch(/whether this call ran is unknown/);
    expect(text(res)).not.toMatch(/call again to check/i);
  });

  it('still answers initialize when looking for the service throws', async () => {
    const b = bridge({ target: () => Promise.reject(new Error('registry exploded')) });
    const res = await b.request('initialize', { protocolVersion: '2025-06-18' });
    expect(res.result).toMatchObject({ serverInfo: { name: 'xezar' } });
  });

  it('refuses legibly across bridge protocol versions', async () => {
    const svc = await service();
    const answer = await new Promise<string>((resolve) => {
      const socket = createConnection(svc.path, () => socket.write(encodeFrame({ v: 99, id: 7, method: 'health' })));
      socket.once('data', (c) => {
        resolve(String(c));
        socket.destroy();
      });
    });
    expect(JSON.parse(answer)).toMatchObject({
      id: 7,
      ok: false,
      error: { code: 'version-mismatch' },
      serviceVersion: '1.2.3',
    });
  });
});

/**
 * A stand-in service that grants `session/open` (unless told otherwise) and answers every other
 * request with whatever `answer` returns — a raw line, so a reply the bridge cannot parse is
 * expressible too.
 */
async function scriptedService(
  name: string,
  answer: (req: { v: number; id: number; method: string }) => string,
  sessionOpen?: (req: { v: number; id: number }) => string,
): Promise<string> {
  const path = join(home, `${name}.sock`);
  const server: Server = createServer((socket) => {
    const framer = new LineFramer((line) => {
      const req = JSON.parse(line) as { v: number; id: number; method: string };
      if (req.method === 'session/open') {
        socket.write(sessionOpen ? sessionOpen(req) : encodeFrame({ v: req.v, id: req.id, ok: true, result: { owner: true } }));
      } else {
        socket.write(answer(req));
      }
    }, () => {});
    socket.on('data', (c: Buffer) => framer.push(c));
  });
  await new Promise<void>((r) => server.listen(path, r));
  handles.push({ close: () => server.close() });
  return path;
}

/**
 * D-01 § 5: every way of not reaching xezar reaches the leader as an ordinary tool result that names
 * WHICH way, because each needs a different remedy — start the cockpit, run as the right user, or
 * align the versions. A mapping that collapsed two of them would send someone to fix the wrong thing,
 * so each case asserts the status AND the remedy text, and the ones beside it must not match.
 */
describe('bridge — each unreachable or refusing service reads as its own failure (D-01 § 5)', () => {
  it('reads a stale socket left by a dead cockpit (ECONNREFUSED) as not running', async () => {
    const path = join(home, 'stale.sock');
    execFileSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`]);
    expect(statSync(path).isSocket()).toBe(true);
    const b = bridge({ target: socketTarget(path) });
    const res = await b.request('tools/call', { name: 'health' });
    expect(res.result).toMatchObject({ isError: true, structuredContent: { status: 'not-running' } });
    expect(text(res)).toMatch(/^xezar is not running for project Alpha \(alpha\)\. Start the cockpit/);
  });

  // Root ignores socket permissions, so the refusal cannot be provoked there.
  it.skipIf(process.getuid?.() === 0)('reads a socket this user may not open (EACCES) as permission denied, never as not running', async () => {
    const svc = await service();
    chmodSync(svc.path, 0o000);
    const b = bridge({ target: socketTarget(svc.path) });
    const res = await b.request('tools/call', { name: 'health' });
    expect(res.result).toMatchObject({ isError: true, structuredContent: { status: 'refused' } });
    expect(text(res)).toBe(
      "xezar's socket for project Alpha (alpha) refused this user (permission denied). The bridge must run as the same user as the cockpit.",
    );
  });

  it('reads an answer it cannot parse as a version mismatch naming this bridge, not as a crash', async () => {
    const path = await scriptedService('garbled', () => '{"surprise":true}\n');
    const b = bridge({ target: socketTarget(path) });
    const res = await b.request('tools/call', { name: 'health' });
    expect(res.result).toMatchObject({ isError: true, structuredContent: { status: 'version-mismatch' } });
    expect(text(res)).toBe(
      'xezar for project Alpha (alpha) answered in a format this bridge (xezar 1.2.3) does not understand. Run the bridge and the cockpit from the same xezar version.',
    );
  });

  it("names BOTH versions when the service refuses the bridge's protocol version", async () => {
    const path = await scriptedService('newer', (req) =>
      encodeFrame({ v: req.v, id: req.id, ok: false, error: { code: 'version-mismatch', message: 'v99 only' }, serviceVersion: '9.9.9' }),
    );
    const b = bridge({ target: socketTarget(path) });
    const res = await b.request('tools/call', { name: 'health' });
    expect(res.result).toMatchObject({ isError: true, structuredContent: { status: 'version-mismatch' } });
    expect(text(res)).toBe(
      'The running xezar (9.9.9) and this bridge (xezar 1.2.3) speak different bridge protocols. Run both from the same xezar version.',
    );
  });

  it("passes any other refusal on with the service's own reason, as refused", async () => {
    const path = await scriptedService('locked', (req) =>
      encodeFrame({ v: req.v, id: req.id, ok: false, error: { code: 'internal', message: 'the run index is locked' } }),
    );
    const b = bridge({ target: socketTarget(path) });
    const res = await b.request('tools/call', { name: 'health' });
    expect(res.result).toMatchObject({ isError: true, structuredContent: { status: 'refused' } });
    expect(text(res)).toBe('xezar refused the request: the run index is locked');
  });

  it('never treats a session/open answer without the owner grant as ownership', async () => {
    let served = 0;
    const path = await scriptedService(
      'no-grant',
      () => ((served += 1), ''),
      (req) => encodeFrame({ v: req.v, id: req.id, ok: true, result: { owner: false } }),
    );
    const b = bridge({ target: socketTarget(path), timeoutMs: 500 });
    const res = await b.request('tools/call', { name: 'health' });
    expect(res.result).toMatchObject({ isError: true, structuredContent: { status: 'version-mismatch' } });
    expect(text(res)).toBe('xezar answered session/open with an unexpected shape.');
    // The call never ran under a session that does not own the project.
    expect(served).toBe(0);
  });
});

describe('service socket lifecycle (N-07)', () => {
  it('creates the directory 0700 and the socket 0600, and removes the socket on close', async () => {
    const svc = await service();
    expect(statSync(join(home, 'ipc')).mode & 0o777).toBe(0o700);
    expect(statSync(svc.path).mode & 0o777).toBe(0o600);
    svc.close();
    expect(existsSync(svc.path)).toBe(false);
  });

  it('replaces a stale socket left by a dead cockpit', async () => {
    // A process that exits without closing its listener leaves the socket file
    // behind — exactly what a crashed cockpit leaves.
    const path = join(home, 'ipc', 'alpha.sock');
    mkdirSync(join(home, 'ipc'), { mode: 0o700 });
    execFileSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`]);
    expect(statSync(path).isSocket()).toBe(true);
    const second = await service();
    expect(second.path).toBe(path);
  });

  it('never steals a live socket from another cockpit serving the same project', async () => {
    await service();
    await expect(listenMcpSocket({ project, version: '1', tools: [], env })).rejects.toThrow(
      'another xezar is already serving this project over MCP',
    );
  });

  it('leaves a file that is not a socket alone', async () => {
    const svc = await service();
    svc.close();
    writeFileSync(svc.path, 'not mine');
    await expect(listenMcpSocket({ project, version: '1', tools: [], env })).rejects.toThrow(/is not a socket/);
  });
});
