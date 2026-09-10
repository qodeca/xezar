import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const handles: Array<{ close(): void }> = [];

beforeEach(() => {
  home = mkdtempSync('/tmp/xzb-');
  env = { XEZ_HOME: home };
});
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  rmSync(home, { recursive: true, force: true });
});

const project = { id: 'alpha', name: 'Alpha', root: '/work/alpha' };

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
  it('negotiates the revision and advertises tools only, without touching the service', async () => {
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
    b.input.write(encodeFrame({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect((await b.request('ping')).result).toEqual({});
    // An empty registry still lists the built-in health tool.
    expect((await b.request('tools/list')).result).toEqual({ tools: [HEALTH_TOOL] });
    expect(resolved).toBe(0);
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
