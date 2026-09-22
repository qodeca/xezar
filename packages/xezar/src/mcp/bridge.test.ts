import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HEALTH_TOOL, runBridge, type ServiceTarget } from './bridge.ts';
import { LineFramer, encodeFrame } from './ipc.ts';
import { SERVER_CAPABILITIES } from './protocol.ts';
import { listenMcpSocket, type McpServiceHandle } from './service.ts';
import { recordOwnListen } from '../server/instance-liveness.ts';
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

async function service(tools: readonly McpTool[] = [], sessions?: { codexAnnounced?: (key: string, value: { threadId: string }) => void }): Promise<McpServiceHandle> {
  const handle = await listenMcpSocket({ project, version: '1.2.3', tools, env, ...(sessions ? { sessions: { opened: () => {}, closed: () => {}, ...sessions } } : {}) });
  handles.push(handle);
  return handle;
}

/** An in-process bridge with a tiny JSON-RPC client in front of it. */
function bridge(opts: {
  tools?: readonly McpTool[];
  target: () => Promise<ServiceTarget>;
  timeoutMs?: number;
  onSessionOpen?: Parameters<typeof runBridge>[0]['onSessionOpen'];
}) {
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
    ...(opts.onSessionOpen ? { onSessionOpen: opts.onSessionOpen } : {}),
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
    // Valid JSON that the message schema rejects (a non-string method) is an invalid request, not a
    // crash: it answers -32600 and the bridge keeps serving. Covers the schema-reject branch.
    b.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 123 })}\n`);
    expect((await b.waitFor((m) => (m.error as { code?: number } | undefined)?.code === -32600)).error).toMatchObject({ code: -32600 });
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
  it('announces the Codex thread from `_meta.threadId` alone — configured exactly as `runMcpCommand` configures it', async () => {
    // Codex 0.154.0 spawns its MCP servers with a filtered environment (no CODEX_HOME), and
    // `runMcpCommand` passes the bridge nothing else: the thread id IS the whole announcement, so the
    // bridge here gets no environment at all, as in production (#374 round 3, blocker 2).
    const announcements: unknown[] = [];
    const svc = await service([echoProject], { codexAnnounced: (_key, value) => announcements.push(value) });
    const b = bridge({ tools: [echoProject], target: socketTarget(svc.path) });
    await b.request('tools/call', { name: 'echo_project', arguments: { text: 'ok' }, _meta: { threadId: 'thread-1', progressToken: 1 } });
    await b.request('tools/call', { name: 'echo_project', arguments: { text: 'ok' }, _meta: { threadId: '' } });
    await b.request('tools/call', { name: 'echo_project', arguments: { text: 'ok' }, _meta: { threadId: 'x'.repeat(201) } });
    await b.request('tools/call', { name: 'echo_project', arguments: { text: 'ok' } });
    expect(announcements).toEqual([{ threadId: 'thread-1' }]);
  });
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

  // #819 item 8. Break: the health data dropping the address (the bridge's schema strips an unknown
  // key), or the service sending one it never recorded.
  it('carries the cockpit address the person opens, once the service recorded a real listen', async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    try {
      recordOwnListen(listener, true);
      const port = (listener.address() as { port: number }).port;
      const svc = await service();
      const res = await bridge({ target: socketTarget(svc.path) }).request('tools/call', { name: 'health' });
      expect(res.result).toMatchObject({ structuredContent: { status: 'running', cockpitUrl: `http://127.0.0.1:${port}/p/alpha/` } });
      expect(text(res)).toBe(`xezar 1.2.3 is running for project Alpha (alpha). The person opens its cockpit at http://127.0.0.1:${port}/p/alpha/.`);
    } finally {
      recordOwnListen(null, true);
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  // #838 F. Break: `health` reading the recorded address without the hosted re-check the other
  // three readers apply, so a process that turned hosted after its listen still hands it out.
  it('omits the cockpit address once this process runs hosted, even with one recorded', async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const savedRemote = process.env.XEZ_REMOTE;
    try {
      recordOwnListen(listener, true);
      process.env.XEZ_REMOTE = '1';
      const svc = await service();
      const res = await bridge({ target: socketTarget(svc.path) }).request('tools/call', { name: 'health' });
      expect(res.result).toMatchObject({ structuredContent: { status: 'running' } });
      expect((res.result as { structuredContent: Record<string, unknown> }).structuredContent).not.toHaveProperty('cockpitUrl');
      expect(text(res)).toBe('xezar 1.2.3 is running for project Alpha (alpha).');
    } finally {
      if (savedRemote === undefined) delete process.env.XEZ_REMOTE;
      else process.env.XEZ_REMOTE = savedRemote;
      recordOwnListen(null, true);
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
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

describe('the session-open report the `xezar mcp` audit record reads (#306 part 2)', () => {
  type Report = Parameters<NonNullable<Parameters<typeof runBridge>[0]['onSessionOpen']>>[0];

  it('reports the owner grant, an occupied project and an unavailable target with its snake-cased status', async () => {
    const reports: Report[] = [];
    const onSessionOpen = (outcome: Report) => reports.push(outcome);

    const svc = await service();
    await bridge({ target: socketTarget(svc.path), onSessionOpen }).request('tools/call', { name: 'health' });

    const occupied = await scriptedService(
      'occupied',
      () => '',
      (req) => encodeFrame({ v: req.v, id: req.id, ok: false, error: { code: 'project-occupied', message: 'taken' } }),
    );
    await bridge({ target: socketTarget(occupied), onSessionOpen }).request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'audit', version: '1' },
    });

    await bridge({ target: async () => ({ kind: 'unavailable', status: 'not-registered', message: 'Not a project.' }), onSessionOpen }).request(
      'tools/call',
      { name: 'health' },
    );
    await bridge({ target: socketTarget(join(home, 'ipc', 'nobody.sock')), onSessionOpen }).request('tools/call', { name: 'health' });

    expect(reports).toEqual([
      { kind: 'owner' },
      { kind: 'refused', reason: 'project_occupied' },
      { kind: 'refused', reason: 'not_registered' },
      { kind: 'refused', reason: 'not_running' },
    ]);
  });

  it('an unrecognised status reads as unavailable, and a throwing observer never changes the session', async () => {
    const reports: Report[] = [];
    // A status outside the typed set (an older or newer service) still reads as `unavailable`.
    const odd = async () => ({ kind: 'unavailable', status: 'Not A Slug!', message: 'odd' }) as unknown as ServiceTarget;
    await bridge({ target: odd, onSessionOpen: (o) => reports.push(o) }).request('tools/call', { name: 'health' });
    expect(reports).toEqual([{ kind: 'refused', reason: 'unavailable' }]);

    const svc = await service();
    const b = bridge({
      target: socketTarget(svc.path),
      onSessionOpen: () => {
        throw new Error('observer failed');
      },
    });
    const res = await b.request('tools/call', { name: 'health' });
    expect(res.result).toMatchObject({ structuredContent: { status: 'running' } });
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

describe('Claude Code channel handshake (#374)', () => {
  it('advertises claude/channel to a claude-code client, and tells it what a channel event is', async () => {
    // RED against: not reading clientInfo.name, or not advertising the channel to Claude Code.
    const b = bridge({ target: socketTarget('/nonexistent') });
    const init = await b.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.270' } });
    expect(init.result).toMatchObject({ capabilities: { tools: { listChanged: false }, experimental: { 'claude/channel': {} } } });
    const instructions = String((init.result as { instructions?: string }).instructions);
    expect(instructions).toContain('<channel source="xezar"');
    // #439: pushes are promised only once the session is attached; the pull is the fallback.
    expect(instructions).toContain('Once this session is attached, events from xezar are pushed to it as `<channel source="xezar" …>` messages');
    expect(instructions).toContain('While nothing is attached, read them with the `leader_events` tool');
    // #450: the leader attaches itself over MCP and acks the cursor a pushed message names; no HTTP call.
    expect(instructions).toContain('Attach this session with `leader_events` action `attach`');
    expect(instructions).toContain('acknowledge it with `leader_events` action `ack` and the cursor the message names; no read is needed');
    expect(instructions).not.toMatch(/POST \/api\/v1|mcp\/leader|127\.0\.0\.1/);
    expect(instructions).not.toContain('Events from xezar arrive as');
    b.input.end();
    await b.done;
  });

  it('keeps the complete non-Claude initialize answer byte-identical to the main constant', async () => {
    // #460 § 4: the compaction recovery is part of every variant, so it is part of this byte pin too.
    const baseInstructions = 'xezar runs AI agent tasks for the one project this session was started in. Call `health` to check that the xezar cockpit is running for it. A project leader works through these tools only, never the cockpit UI and never the HTTP API. This session receives no pushed events until it is attached. Attach this session with `leader_events` action `attach` so events are pushed to it, and check it with action `status`. Until it is attached, read events with the `leader_events` tool. After context compaction, call `leader_events` with action `read` and no cursor before relying on prior pushes. It replays retained events after your last explicit acknowledgement, including events pushed but not acknowledged. Read every page using nextCursor while hasMore is true. Deduplicate by eventId, reconcile current task state, then acknowledge only the events you have accounted for. A transport receipt is not an acknowledgement. Delivery is at-least-once within retained durable state, not exactly-once. If the journal reports a gap, reconcile the returned current state before acknowledging resumeCursor. Do not poll while idle.';
    const b = bridge({ target: socketTarget('/nonexistent') });
    const init = await b.request('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'codex' } });
    expect(JSON.stringify(init.result)).toBe(JSON.stringify({ protocolVersion: '2025-11-25', capabilities: SERVER_CAPABILITIES, serverInfo: { name: 'xezar', title: 'xezar', version: '1.2.3' }, instructions: baseInstructions }));
    b.input.end(); await b.done;
  });

  it('never advertises the channel to another client, keeping its handshake as it was', async () => {
    // RED against: advertising the channel to every client.
    const b = bridge({ target: socketTarget('/nonexistent') });
    const init = await b.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'codex', version: '1' } });
    expect(init.result).toMatchObject({ capabilities: SERVER_CAPABILITIES });
    expect('experimental' in (init.result as { capabilities: Record<string, unknown> }).capabilities).toBe(false);
    b.input.end();
    await b.done;
  });
});

describe('the leader/push service→bridge frame (#374)', () => {
  /**
   * A raw unix-socket server standing in for the service, so a test can send an arbitrary
   * `leader/push` frame down the bridge's own connection and read what it announced in `session/open`.
   */
  async function rawServer(): Promise<{
    path: string;
    opened: Promise<Record<string, unknown>>;
    push: (frame: Record<string, unknown>) => void;
    replies: Record<string, unknown>[];
    close: () => void;
  }> {
    const dir = mkdtempSync('/tmp/xzbp-');
    const path = join(dir, 's.sock');
    let peer: import('node:net').Socket | undefined;
    const replies: Record<string, unknown>[] = [];
    let resolveOpened: (params: Record<string, unknown>) => void;
    const opened = new Promise<Record<string, unknown>>((r) => (resolveOpened = r));
    const server = createServer((socket) => {
      peer = socket;
      const framer = new LineFramer(
        (line) => {
          const msg = JSON.parse(line) as { id: number; method?: string; params?: Record<string, unknown>; ok?: boolean };
          if (msg.method === 'session/open') {
            resolveOpened(msg.params ?? {});
            socket.write(encodeFrame({ v: 2, id: msg.id, ok: true, result: { owner: true } }));
          } else if (msg.ok !== undefined) {
            replies.push(msg);
          }
        },
        () => {},
      );
      socket.on('data', (c: Buffer) => framer.push(c));
    });
    await new Promise<void>((r) => server.listen(path, r));
    handles.push({ close: () => server.close() });
    return {
      path,
      opened,
      push: (frame) => peer?.write(encodeFrame(frame)),
      replies,
      close: () => {
        peer?.destroy();
        server.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it.each(['failure', 'backpressure', 'closed'] as const)('confirms channel stdout completion: %s', async (mode) => {
    const svc = await rawServer();
    const input = new PassThrough();
    let complete: ((error?: Error | null) => void) | undefined;
    let initialized = false;
    const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
      const frame = JSON.parse(String(chunk)) as { method?: string };
      if (frame.method === 'notifications/claude/channel') complete = callback;
      else { initialized = true; callback(); }
    } });
    const done = runBridge({ input, output, version: 'test', tools: [], resolveTarget: socketTarget(svc.path) });
    try {
      input.write(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'claude-code' } } }));
      await expect.poll(() => initialized).toBe(true);
      if (mode === 'closed') output.end();
      svc.push({ v: 2, id: 88, method: 'leader/push', params: { content: 'event' } });
      if (mode !== 'closed') {
        await expect.poll(() => complete !== undefined).toBe(true);
        expect(svc.replies).toEqual([]);
        complete?.(mode === 'failure' ? new Error('simulated async EPIPE') : undefined);
      }
      await expect.poll(() => svc.replies.length).toBe(1);
      expect(svc.replies[0]).toMatchObject(mode === 'backpressure'
        ? { ok: true, result: { pushed: true } }
        : { ok: false, error: { code: 'push-failed' } });
    } finally { input.end(); await done; svc.close(); }
  });

  it('turns an inbound leader/push into a notifications/claude/channel message and confirms it', async () => {
    // RED against: the bridge not writing the channel notification, or not replying pushed:true.
    const svc = await rawServer();
    const b = bridge({ target: socketTarget(svc.path) });
    await b.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.270' } });
    // The bridge opened the session and announced it understands leader/push and which client it is.
    expect(await svc.opened).toEqual({ leaderPush: true, clientName: 'claude-code' });

    svc.push({ v: 2, id: 4242, method: 'leader/push', params: { content: 'XEZAR-EVENT', meta: { source_app: 'xezar', last_seq: '7' } } });
    const note = await b.waitFor((m) => m.method === 'notifications/claude/channel');
    expect(note.params).toEqual({ content: 'XEZAR-EVENT', meta: { source_app: 'xezar', last_seq: '7' } });
    // …and the bridge confirmed the write back to the service.
    await new Promise((r) => setTimeout(r, 30));
    expect(svc.replies).toContainEqual({ v: 2, id: 4242, ok: true, result: { pushed: true } });
    b.input.end();
    await b.done;
    svc.close();
  });

  it('refuses a leader/push with no content, and never writes a channel message for it', async () => {
    // RED against: the bridge writing a malformed channel notification instead of refusing.
    const svc = await rawServer();
    const b = bridge({ target: socketTarget(svc.path) });
    await b.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.270' } });
    await svc.opened;
    svc.push({ v: 2, id: 5, method: 'leader/push', params: { meta: {} } });
    await new Promise((r) => setTimeout(r, 30));
    expect(svc.replies).toContainEqual({ v: 2, id: 5, ok: false, error: { code: 'invalid-params', message: 'leader/push needs content' } });
    expect(b.messages.some((m) => m.method === 'notifications/claude/channel')).toBe(false);
    b.input.end();
    await b.done;
    svc.close();
  });

  it('refuses a service→bridge request whose method it does not know, and writes no channel message', async () => {
    // RED against: the bridge failing every call in flight (parsing the request as a bad response) or
    // crashing on an unknown inbound method, instead of answering it as unknown-method.
    const svc = await rawServer();
    const b = bridge({ target: socketTarget(svc.path) });
    await b.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.270' } });
    await svc.opened;
    svc.push({ v: 2, id: 7, method: 'leader/unheard-of', params: {} });
    await new Promise((r) => setTimeout(r, 30));
    expect(svc.replies).toContainEqual({ v: 2, id: 7, ok: false, error: { code: 'unknown-method', message: 'unknown method: leader/unheard-of' } });
    expect(b.messages.some((m) => m.method === 'notifications/claude/channel')).toBe(false);
    b.input.end();
    await b.done;
    svc.close();
  });
});

/**
 * #450 — the bridge registers the Claude Code channel from what the service ANSWERED at `session/open`
 * (§ 2.3 table), tells the service on every later open what it registered, and writes one notice when
 * the service closes an owner session whose channel is registered. A stand-in service scripts the
 * `session/open` answer and can drop the connection or fence the session.
 */
describe('push capability at the handshake (#450)', () => {
  async function pushService(grant: (open: number) => Record<string, unknown>) {
    const path = join(home, `push-${Math.random().toString(36).slice(2, 8)}.sock`);
    const opens: Record<string, unknown>[] = [];
    const peers: import('node:net').Socket[] = [];
    const control = { expire: false };
    const server: Server = createServer((socket) => {
      peers.push(socket);
      const framer = new LineFramer((line) => {
        const req = JSON.parse(line) as { v: number; id: number; method?: string; params?: Record<string, unknown> };
        if (req.method === 'session/open') {
          opens.push(req.params ?? {});
          socket.write(encodeFrame({ v: req.v, id: req.id, ok: true, result: grant(opens.length) }));
        } else if (req.method === 'health' && control.expire) {
          control.expire = false;
          socket.write(encodeFrame({ v: req.v, id: req.id, ok: false, error: { code: 'session-expired', message: 'fenced' } }));
          setTimeout(() => socket.destroy(), 20);
        } else if (req.method === 'health') {
          socket.write(encodeFrame({ v: req.v, id: req.id, ok: true, result: { ipcVersion: 2, xezarVersion: '1.2.3', project: { id: project.id, name: project.name } } }));
        }
      }, () => {});
      socket.on('data', (c: Buffer) => framer.push(c));
    });
    await new Promise<void>((r) => server.listen(path, r));
    handles.push({ close: () => server.close() });
    return { path, opens, control, dropOwner: () => peers.at(-1)?.destroy() };
  }
  const claudeInit = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.270' } };
  const notices = (b: ReturnType<typeof bridge>) => b.messages.filter((m) => m.method === 'notifications/claude/channel');
  const settle = () => new Promise((r) => setTimeout(r, 60));

  it('T-14: a service that can push gets the channel registered and the channel instructions', async () => {
    // RED against: always passing `channel: false` — the channel is never registered.
    const svc = await pushService(() => ({ owner: true, canPush: true }));
    const b = bridge({ target: socketTarget(svc.path) });
    const init = await b.request('initialize', claudeInit);
    expect(init.result).toMatchObject({ capabilities: { experimental: { 'claude/channel': {} } } });
    expect(String((init.result as { instructions: string }).instructions)).toContain('Once this session is attached, events from xezar are pushed to it');
    b.input.end(); await b.done;
  });

  it('T-15: a service that answers it cannot push gets no channel, and instructions naming its reason', async () => {
    // RED against: advertising on the client name alone (the code before #450).
    const svc = await pushService(() => ({ owner: true, canPush: false, pushUnavailable: { code: 'hosted-mode', message: 'This xezar runs in hosted mode.' } }));
    const b = bridge({ target: socketTarget(svc.path) });
    const init = await b.request('initialize', claudeInit);
    expect('experimental' in (init.result as { capabilities: Record<string, unknown> }).capabilities).toBe(false);
    const instructions = String((init.result as { instructions: string }).instructions);
    expect(instructions).toContain('xezar cannot push events to this session: This xezar runs in hosted mode.');
    expect(instructions).not.toContain('<channel source="xezar"');
    b.input.end(); await b.done;
  });

  it('T-16 (#439): a service that answers without canPush is older, so no channel and the older-service reason', async () => {
    // RED against: reading an absent `canPush` as true.
    const svc = await pushService(() => ({ owner: true }));
    const b = bridge({ target: socketTarget(svc.path) });
    const init = await b.request('initialize', claudeInit);
    expect('experimental' in (init.result as { capabilities: Record<string, unknown> }).capabilities).toBe(false);
    expect(String((init.result as { instructions: string }).instructions)).toContain(
      'xezar cannot push events to this session: The running xezar is older than this bridge and cannot push events to it.',
    );
    b.input.end(); await b.done;
  });

  it('T-17 (default-path pin, green before #450): a service that is not running keeps today’s channel and instructions', async () => {
    // RED against: gating the channel on `canPush === true` alone, which would silently remove the
    // "Claude Code started before the cockpit" path.
    const b = bridge({ target: socketTarget(join(home, 'not-running.sock')) });
    const init = await b.request('initialize', claudeInit);
    expect(init.result).toMatchObject({ capabilities: { experimental: { 'claude/channel': {} } } });
    expect(String((init.result as { instructions: string }).instructions)).toContain('Once this session is attached, events from xezar are pushed to it');
    b.input.end(); await b.done;
  });

  it('T-20: the first session/open omits channelAdvertised, and every later one says what the handshake registered', async () => {
    // RED against: sending it on the first open, or sending a value the handshake did not register.
    for (const canPush of [true, false]) {
      const svc = await pushService(() => ({ owner: true, canPush }));
      const b = bridge({ target: socketTarget(svc.path) });
      await b.request('initialize', claudeInit);
      expect(svc.opens[0]).toEqual({ leaderPush: true, clientName: 'claude-code' });
      svc.dropOwner();
      await settle();
      await b.request('tools/call', { name: 'health' }); // answered session-expired; a new session opens
      await expect.poll(() => svc.opens.length).toBe(2);
      expect(svc.opens[1]).toEqual({ leaderPush: true, clientName: 'claude-code', channelAdvertised: canPush });
      b.input.end(); await b.done;
    }
  });

  it('T-19: the service closing a registered owner session writes exactly one notice, re-armed by the next session', async () => {
    // RED against: dropping the one-shot flag (a second notice for one loss) or never re-arming it.
    const svc = await pushService(() => ({ owner: true, canPush: true }));
    const b = bridge({ target: socketTarget(svc.path) });
    await b.request('initialize', claudeInit);
    svc.dropOwner();
    await expect.poll(() => notices(b).length).toBe(1);
    expect(notices(b)[0]!.params).toMatchObject({
      meta: { source_app: 'xezar', project_id: project.id, notice: 'service-disconnected' },
      content: expect.stringContaining('call leader_events with action status, and attach again if it says this session is not attached'),
    });
    // The session is lost: a call reopens it (answered session-expired), and nothing more is written.
    await b.request('tools/call', { name: 'health' });
    await settle();
    expect(notices(b)).toHaveLength(1);
    // The next session lost is a new loss: one more notice.
    await expect.poll(() => svc.opens.length).toBe(2);
    svc.dropOwner();
    await expect.poll(() => notices(b).length).toBe(2);
    b.input.end(); await b.done;
  });

  it('T-19: no notice when the channel was not registered, when the client closed, or when the session was fenced', async () => {
    // RED against: removing the `channelAdvertised` check (a notice to a client with no channel).
    const noChannel = await pushService(() => ({ owner: true, canPush: false, pushUnavailable: { code: 'client-unknown', message: 'unknown.' } }));
    const b1 = bridge({ target: socketTarget(noChannel.path) });
    await b1.request('initialize', claudeInit);
    noChannel.dropOwner();
    await settle();
    expect(notices(b1)).toHaveLength(0);
    b1.input.end(); await b1.done;

    // Fenced: the service answers session-expired and then closes; the bridge already dropped the session.
    const fenced = await pushService(() => ({ owner: true, canPush: true }));
    const b2 = bridge({ target: socketTarget(fenced.path) });
    await b2.request('initialize', claudeInit);
    fenced.control.expire = true;
    await b2.request('tools/call', { name: 'health' });
    await settle();
    expect(notices(b2)).toHaveLength(0);
    b2.input.end(); await b2.done;

    // The client closed first: closing the connection is the bridge's own act, not the service stopping.
    const closing = await pushService(() => ({ owner: true, canPush: true }));
    const b3 = bridge({ target: socketTarget(closing.path) });
    await b3.request('initialize', claudeInit);
    b3.input.end(); await b3.done;
    closing.dropOwner();
    await settle();
    expect(notices(b3)).toHaveLength(0);
  });
});
