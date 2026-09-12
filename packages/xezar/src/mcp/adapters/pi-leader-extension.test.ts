import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import extension, { __internals } from '../../../scripts/pi-leader-extension.ts';

/**
 * The shipped pi leader extension (`scripts/pi-leader-extension.ts`).
 *
 * It is 400 lines that run inside somebody else's editor with that person's full permissions, and it
 * shipped with no test at all for one round of review (QA on #358, finding 3). It is MCP
 * functionality, so the MCP floor applies to it — the root `test:coverage:mcp` include names it.
 *
 * These cases drive the REAL extension: the real default export, a fake `pi` API standing only for
 * the vendor surface, and a REAL Unix socket with a real client on the other end. `TMPDIR` is pinned
 * per case so the socket's containing directory is a path this file can inspect — which is the whole
 * point of the first group.
 */

const dirs: string[] = [];
const shutdowns: (() => void)[] = [];
const openSockets: Socket[] = [];
let realTmpDir: string | undefined;

const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  dirs.push(dir);
  return dir;
};

/**
 * Pin `TMPDIR` for ONE case, and never leak it.
 *
 * This is load-bearing and it already cost a CI failure. `--project server` runs every file in one
 * worker process on a 2-core CI runner, so a `TMPDIR` this file leaves behind is a `TMPDIR` every
 * later file inherits — and `runs/agent-tmpdir.ts` deliberately FAILS a run whose temp directory
 * does not work, so a leak surfaced as `acceptance-parity` reporting a task `failed` instead of
 * `running`, in a suite that has nothing to do with pi. Most cases here need no pin at all: the
 * socket's real path comes back in the descriptor and can be inspected wherever it is.
 */
const pinTmpDir = (dir: string): void => {
  process.env.TMPDIR = dir;
};

/**
 * The self-check for the leak above: whatever `TMPDIR` this file inherited must be exactly what it
 * leaves behind. `afterAll` runs after every `afterEach`, so a single case that escapes the restore
 * fails HERE — in this file, by name — instead of somewhere in `acceptance-parity` an hour later.
 */
let ambientTmpDir: string | undefined;
let ambientWasSet = false;

beforeAll(() => {
  ambientTmpDir = process.env.TMPDIR;
  ambientWasSet = 'TMPDIR' in process.env;
});

afterAll(() => {
  expect('TMPDIR' in process.env).toBe(ambientWasSet);
  expect(process.env.TMPDIR).toBe(ambientTmpDir);
});

beforeEach(() => {
  realTmpDir = process.env.TMPDIR;
});

afterEach(() => {
  // The restore comes FIRST and cannot be skipped: an exception from a teardown below used to jump
  // over it and poison every later test file in this worker.
  try {
    if (realTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = realTmpDir;
  } finally {
    for (const socket of openSockets.splice(0)) {
      try {
        socket.destroy();
      } catch { /* a socket already gone is not a cleanup failure */ }
    }
    for (const shutdown of shutdowns.splice(0)) {
      try {
        shutdown();
      } catch { /* one extension's teardown must not abandon the rest of the cleanup */ }
    }
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch { /* a leftover temporary directory harms nothing */ }
    }
  }
});

/** Only what the extension actually touches, so a change in pi's surface shows up as a type error. */
let sessionSeq = 0;

function fakePi(over: { isIdle?: () => boolean; hasPendingMessages?: () => boolean; branch?: unknown[] } = {}) {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const sent: { content: unknown; options?: { deliverAs?: string } }[] = [];
  const project = tmp('xzext-proj-');
  mkdirSync(join(project, '.local', 'xezar'), { recursive: true });
  // A session id of its own per case, as real pi has (a UUID). Cases here share the host's real
  // temporary directory, so a fixed id would make them all fight over one socket path.
  const sessionId = `sess-${process.pid}-${++sessionSeq}`;
  const ctx = {
    cwd: project,
    sessionManager: {
      getSessionId: () => sessionId,
      getCwd: () => project,
      getBranch: () => (over.branch ?? []) as never,
    },
    isIdle: over.isIdle ?? (() => true),
    hasPendingMessages: over.hasPendingMessages ?? (() => false),
  };
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendUserMessage(content: unknown, options?: { deliverAs?: 'steer' | 'followUp' }) {
      sent.push(options === undefined ? { content } : { content, options });
    },
  };
  return {
    pi,
    ctx,
    sent,
    project,
    dataDir: join(project, '.local', 'xezar'),
    sessionId,
    async start() {
      for (const handler of handlers.get('session_start') ?? []) await handler({ type: 'session_start' }, ctx);
    },
    shutdown() {
      for (const handler of handlers.get('session_shutdown') ?? []) void handler({ type: 'session_shutdown' }, ctx);
    },
    emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) void handler(payload, ctx);
    },
    handlerCount(event: string) {
      return (handlers.get(event) ?? []).length;
    },
  };
}

/**
 * Boot the real extension under a SHORT pinned `TMPDIR`.
 *
 * The pin is not cosmetic. A Unix socket path is capped at ~104 bytes, and this repo's own task
 * temporary directory (`.local/xezar/tmp/<runId>`) is already 78 of them, so the ambient value here
 * leaves no room for `<dir>/leader.sock` and the extension correctly opens nothing. Pinning it short
 * is what lets these cases exercise the socket at all — and `pinTmpDir` plus the `afterEach` restore
 * are what stop that pin reaching any other file.
 */
async function boot(over: Parameters<typeof fakePi>[0] = {}) {
  const harness = fakePi(over);
  pinTmpDir(tmp('xzt-'));
  extension(harness.pi as never);
  shutdowns.push(() => harness.shutdown());
  await harness.start();
  return harness;
}

function descriptorOf(harness: { dataDir: string }): { endpoint: { socket: string }; session: { sessionId?: string } } {
  return JSON.parse(readFileSync(join(harness.dataDir, 'pi-leader.json'), 'utf8'));
}

/** One client on the extension's socket, speaking pi's RPC framing. */
function client(path: string) {
  const socket = createConnection({ path });
  openSockets.push(socket);
  socket.setEncoding('utf8');
  const frames: Record<string, unknown>[] = [];
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.trim()) frames.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const connected = new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', (err) => reject(err));
  });
  return {
    socket,
    frames,
    connected,
    send: (command: Record<string, unknown>) => socket.write(`${JSON.stringify(command)}\n`),
    raw: (text: string) => socket.write(text),
    async ask(command: Record<string, unknown>, id = 'q1') {
      socket.write(`${JSON.stringify({ ...command, id })}\n`);
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const found = frames.find((f) => f.type === 'response' && f.id === id);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no response for ${id}`);
    },
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe('the socket is kept away from other local accounts', () => {
  /**
   * THE NAMED BREAK for this group is `makePrivateSocketDir` returning
   * `{ dir: tmpdir(), socket: join(tmpdir(), 'xez-pi-<id>.sock') }` — the shipped behaviour of the
   * first version, which a QA measured as world-reachable on Linux (`/tmp`, mode 1777, socket 0755).
   * Every assertion below fails against that.
   */
  it('puts the socket inside a 0700 directory, not straight into the temporary directory', async () => {
    const harness = await boot();
    const socketPath = descriptorOf(harness).endpoint.socket;

    const parent = join(socketPath, '..');
    const stat = lstatSync(parent);
    expect(stat.isDirectory()).toBe(true);
    // Nothing for group, nothing for other. This is the assertion the old code failed.
    expect(stat.mode & 0o777).toBe(0o700);
    // And it is a directory of its OWN, not the shared temporary directory itself — which is what
    // the old code returned, and what makes the mode above meaningless.
    expect(realpathSync(parent)).not.toBe(realpathSync(process.env.TMPDIR as string));
    expect(lstatSync(socketPath).isSocket()).toBe(true);
  });

  it('still does so when TMPDIR is a world-writable directory, which is Linux\'s default', async () => {
    // The exact condition that hid the defect: a sticky, world-writable parent.
    const shared = tmp('xzext-shared-');
    const { chmodSync } = await import('node:fs');
    chmodSync(shared, 0o1777);
    pinTmpDir(shared);
    const harness = fakePi();
    extension(harness.pi as never);
    shutdowns.push(() => harness.shutdown());
    await harness.start();

    const socketPath = descriptorOf(harness).endpoint.socket;
    expect(lstatSync(join(socketPath, '..')).mode & 0o777).toBe(0o700);
    // The private directory is a child of the world-writable one, which is safe because /tmp-style
    // stickiness stops another user removing or renaming it.
    expect(realpathSync(join(socketPath, '..', '..'))).toBe(realpathSync(shared));
  });

  it('refuses to adopt a symlink planted at its directory path, and opens nothing', () => {
    const tmpRoot = tmp('xzext-tmp-');
    pinTmpDir(tmpRoot);
    const elsewhere = tmp('xzext-attacker-');
    symlinkSync(elsewhere, join(tmpRoot, 'xez-pi-planted'));

    // `rmSync` removes the symlink and `mkdirSync` then makes a real directory, so the attacker's
    // target is never written into. The point is that the path used afterwards is not the symlink.
    const place = __internals.makePrivateSocketDir('planted');
    expect(place).toBeDefined();
    // A directory of its own, never the shared root, and never the planted link.
    expect(realpathSync(place!.dir)).not.toBe(realpathSync(tmpRoot));
    expect(realpathSync(place!.dir)).not.toBe(realpathSync(elsewhere));
    expect(lstatSync(place!.dir).isSymbolicLink()).toBe(false);
    expect(lstatSync(place!.dir).isDirectory()).toBe(true);
    expect(lstatSync(place!.dir).mode & 0o777).toBe(0o700);
    expect(existsSync(join(elsewhere, 'leader.sock'))).toBe(false);
  });

  it('gives up rather than falling back to a shared path when it cannot make the directory', () => {
    const tmpRoot = tmp('xzext-tmp-');
    pinTmpDir(tmpRoot);
    // A plain FILE where the directory has to go, which `rmSync` clears — so to make this
    // unrecoverable the parent itself is read-only.
    const { chmodSync } = require('node:fs') as typeof import('node:fs');
    chmodSync(tmpRoot, 0o500);
    try {
      expect(__internals.makePrivateSocketDir('cannot-make')).toBeUndefined();
    } finally {
      chmodSync(tmpRoot, 0o700);
    }
  });

  it('removes the whole private directory on shutdown, leaving nothing behind', async () => {
    const harness = await boot();
    const socketPath = descriptorOf(harness).endpoint.socket;
    const dir = realpathSync(join(socketPath, '..'));
    // The directory it removes must be its OWN, never the shared temporary root — removing that
    // would take every other program's temporary files with it.
    const shared = realpathSync(join(dir, '..'));
    expect(dir).not.toBe(shared);
    expect(existsSync(dir)).toBe(true);

    harness.shutdown();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(shared)).toBe(true);
    expect(existsSync(join(harness.dataDir, 'pi-leader.json'))).toBe(false);
  });
});

describe('announcing itself to xezar', () => {
  it('writes a descriptor naming the live socket, at mode 0600', async () => {
    const harness = await boot();
    const path = join(harness.dataDir, 'pi-leader.json');
    expect(lstatSync(path).mode & 0o777).toBe(0o600);

    const descriptor = descriptorOf(harness);
    expect(descriptor).toMatchObject({ schemaVersion: 1, session: { sessionId: harness.sessionId } });
    expect(lstatSync(descriptor.endpoint.socket).isSocket()).toBe(true);
  });

  it('does nothing at all outside a xezar project — no socket, no descriptor', async () => {
    pinTmpDir(tmp('xzt-'));
    const plain = tmp('xzext-notaproject-');
    const harness = fakePi();
    extension(harness.pi as never);
    shutdowns.push(() => harness.shutdown());
    // A cwd with no `.local/xezar` anywhere above it.
    (harness.ctx as { cwd: string }).cwd = plain;
    (harness.ctx.sessionManager as { getCwd: () => string }).getCwd = () => plain;
    await harness.start();

    expect(existsSync(join(plain, 'pi-leader.json'))).toBe(false);
    expect(existsSync(join(harness.dataDir, 'pi-leader.json'))).toBe(false);
  });

  it('finds the project from a subdirectory, so pi need not be started at the root', () => {
    const project = tmp('xzext-walk-');
    mkdirSync(join(project, '.local', 'xezar'), { recursive: true });
    const deep = join(project, 'packages', 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(__internals.findProjectDataDir(deep)).toBe(join(project, '.local', 'xezar'));
    expect(__internals.findProjectDataDir(tmp('xzext-nowhere-'))).toBeUndefined();
  });

  it('never lets a session id become a path of its own', () => {
    const bad = { sessionManager: { getSessionId: () => '../../etc/passwd' } } as never;
    expect(__internals.safeSessionId(bad)).toBe('etcpasswd');
    const throws = { sessionManager: { getSessionId: () => { throw new Error('no session'); } } } as never;
    expect(__internals.safeSessionId(throws)).toBe(`pid-${process.pid}`);
  });

  it('survives a session teardown and rebuild, which pi does on /new and /reload', async () => {
    const harness = await boot();
    const first = descriptorOf(harness).endpoint.socket;
    harness.shutdown();
    expect(existsSync(first)).toBe(false);

    await harness.start();
    const second = descriptorOf(harness).endpoint.socket;
    expect(lstatSync(second).isSocket()).toBe(true);
    const c = client(second);
    await c.connected;
    await expect(c.ask({ type: 'get_state' })).resolves.toMatchObject({ success: true });
  });
});

describe('the commands xezar sends', () => {
  it('answers get_state with pi\'s real idle and queue state', async () => {
    let idle = true;
    let pending = false;
    const harness = await boot({ isIdle: () => idle, hasPendingMessages: () => pending });
    const c = client(descriptorOf(harness).endpoint.socket);
    await c.connected;

    await expect(c.ask({ type: 'get_state' }, 'a')).resolves.toMatchObject({
      success: true,
      data: { isStreaming: false, pendingMessageCount: 0 },
    });

    idle = false;
    pending = true;
    await expect(c.ask({ type: 'get_state' }, 'b')).resolves.toMatchObject({
      success: true,
      // A truthful lower bound: the extension API answers "any queued" as a boolean, and this never
      // claims a count it does not know. xezar only asks whether it is above zero.
      data: { isStreaming: true, pendingMessageCount: 1 },
    });
  });

  it('sends a prompt when pi is idle, and starts a turn through pi\'s own API', async () => {
    const harness = await boot({ isIdle: () => true });
    const c = client(descriptorOf(harness).endpoint.socket);
    await c.connected;

    await expect(c.ask({ type: 'prompt', message: 'EVENT-1' })).resolves.toMatchObject({ success: true });
    expect(harness.sent).toEqual([{ content: 'EVENT-1' }]);
  });

  it('refuses a plain prompt while pi is busy, in real pi\'s own words, and sends nothing', async () => {
    const harness = await boot({ isIdle: () => false });
    const c = client(descriptorOf(harness).endpoint.socket);
    await c.connected;

    const answer = await c.ask({ type: 'prompt', message: 'EVENT-1' });
    expect(answer.success).toBe(false);
    // xezar's adapter matches on this text to fall back to `steer`; it must stay pi's wording.
    expect(JSON.stringify(answer.error)).toContain('Agent is already processing');
    // And nothing reached pi: `sendUserMessage` would have failed into pi's error channel, not here.
    expect(harness.sent).toEqual([]);
  });

  it('steers with deliverAs steer, which is the only way into a running turn', async () => {
    const harness = await boot({ isIdle: () => false });
    const c = client(descriptorOf(harness).endpoint.socket);
    await c.connected;

    await expect(c.ask({ type: 'steer', message: 'EVENT-2' })).resolves.toMatchObject({ success: true });
    expect(harness.sent).toEqual([{ content: 'EVENT-2', options: { deliverAs: 'steer' } }]);
  });

  it('returns the conversation\'s user messages in order, for the never-twice check', async () => {
    const branch = [
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      { type: 'model_change', message: undefined },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
      // `UserMessage.content` is `string | array` in pi's own types; both are real.
      { type: 'message', message: { role: 'user', content: 'second as a bare string' } },
    ];
    const harness = await boot({ branch });
    const c = client(descriptorOf(harness).endpoint.socket);
    await c.connected;

    const answer = await c.ask({ type: 'get_messages' });
    expect(answer).toMatchObject({ success: true });
    expect((answer.data as { messages: unknown[] }).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'second as a bare string' }] },
    ]);
  });

  it('refuses a command it does not implement by name, rather than staying silent', async () => {
    const harness = await boot();
    const c = client(descriptorOf(harness).endpoint.socket);
    await c.connected;

    const answer = await c.ask({ type: 'abort' });
    expect(answer.success).toBe(false);
    expect(JSON.stringify(answer.error)).toContain('abort');
    const bare = await c.ask({}, 'z');
    expect(bare.success).toBe(false);
  });

  it('turns a throw from pi into a failed response, never a dropped connection', async () => {
    const harness = await boot();
    (harness.pi as { sendUserMessage: (c: unknown) => void }).sendUserMessage = () => {
      throw new Error('pi is gone');
    };
    const c = client(descriptorOf(harness).endpoint.socket);
    await c.connected;

    const answer = await c.ask({ type: 'prompt', message: 'x' });
    expect(answer.success).toBe(false);
    expect(JSON.stringify(answer.error)).toContain('pi is gone');
    expect(c.socket.destroyed).toBe(false);
  });

  it('skips a line that is not JSON and keeps answering', async () => {
    const harness = await boot();
    const c = client(descriptorOf(harness).endpoint.socket);
    await c.connected;

    c.raw('this is not json\n');
    await expect(c.ask({ type: 'get_state' })).resolves.toMatchObject({ success: true });
  });

  it('reassembles a command split across two writes, and tolerates a trailing carriage return', async () => {
    const harness = await boot();
    const c = client(descriptorOf(harness).endpoint.socket);
    await c.connected;

    c.raw('{"id":"split","type":"get_st');
    await settle();
    expect(c.frames).toEqual([]);
    c.raw('ate"}\r\n');
    await settle();
    expect(c.frames.some((f) => f.id === 'split' && f.success === true)).toBe(true);
  });

  it('reads the conversation as empty rather than throwing when pi refuses to list it', async () => {
    const harness = await boot();
    (harness.ctx.sessionManager as { getBranch: () => never }).getBranch = () => {
      throw new Error('session gone');
    };
    const c = client(descriptorOf(harness).endpoint.socket);
    await c.connected;

    await expect(c.ask({ type: 'get_messages' })).resolves.toMatchObject({ success: true, data: { messages: [] } });
  });
});

describe('the events it forwards', () => {
  it('forwards exactly the four the adapter needs, with the message when there is one', async () => {
    const harness = await boot();
    const c = client(descriptorOf(harness).endpoint.socket);
    await c.connected;
    await settle();

    const message = { role: 'user', content: [{ type: 'text', text: 'xezar-event:1' }] };
    harness.emit('agent_start', { type: 'agent_start' });
    harness.emit('message_start', { type: 'message_start', message });
    harness.emit('message_end', { type: 'message_end', message });
    harness.emit('agent_settled', { type: 'agent_settled' });
    await settle();

    expect(c.frames.filter((f) => f.type !== 'response')).toEqual([
      { type: 'agent_start' },
      { type: 'message_start', message },
      { type: 'message_end', message },
      { type: 'agent_settled' },
    ]);
  });

  it('registers its pi handlers ONCE, however many times xezar connects', async () => {
    const harness = await boot();
    const before = harness.handlerCount('message_start');
    const a = client(descriptorOf(harness).endpoint.socket);
    await a.connected;
    const b = client(descriptorOf(harness).endpoint.socket);
    await b.connected;
    await settle();

    // pi's `on` has no unsubscribe, so a per-connection subscription would leak into the person's
    // pi on every attach. The count must not move.
    expect(harness.handlerCount('message_start')).toBe(before);

    harness.emit('message_start', { type: 'message_start', message: { role: 'user', content: [] } });
    await settle();
    // Both live sockets see it exactly once each.
    expect(a.frames.filter((f) => f.type === 'message_start')).toHaveLength(1);
    expect(b.frames.filter((f) => f.type === 'message_start')).toHaveLength(1);
  });

  it('stops writing to a socket that has gone, and does not throw doing it', async () => {
    const harness = await boot();
    const c = client(descriptorOf(harness).endpoint.socket);
    await c.connected;
    await settle();
    c.socket.destroy();
    await settle();

    expect(() => harness.emit('agent_start', { type: 'agent_start' })).not.toThrow();
  });
});

describe('when it cannot open its socket at all', () => {
  it('announces nothing rather than a descriptor naming a socket that does not listen', async () => {
    // A Unix socket path is capped at ~104 bytes, so a deep enough temporary directory makes the
    // bind fail for real — the same class as a full disk or a sandbox that forbids sockets.
    const root = tmp('xzext-long-');
    const deep = join(root, 'a'.repeat(60), 'b'.repeat(60));
    mkdirSync(deep, { recursive: true });
    pinTmpDir(deep);

    const harness = fakePi();
    extension(harness.pi as never);
    shutdowns.push(() => harness.shutdown());
    await harness.start();

    // No descriptor: xezar then reports "no pi leader has announced itself", which is the honest
    // answer, instead of dialling a path that answers nothing.
    expect(existsSync(join(harness.dataDir, 'pi-leader.json'))).toBe(false);
  });

  it('drops a peer that sends an endless line instead of growing its buffer for ever', async () => {
    const harness = await boot();
    const c = client(descriptorOf(harness).endpoint.socket);
    await c.connected;

    // Over a megabyte with no newline in it at all.
    c.raw('x'.repeat(1_100_000));
    const deadline = Date.now() + 3000;
    while (!c.socket.destroyed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(c.socket.destroyed).toBe(true);
  });
});

describe('the pure helpers', () => {
  it('stops walking up after a bounded number of levels, instead of for ever', () => {
    const root = tmp('xzext-deep-');
    // Deeper than the walk's own limit, with no `.local/xezar` anywhere in it.
    const deep = join(root, ...Array.from({ length: 45 }, (_, i) => `d${i}`));
    mkdirSync(deep, { recursive: true });
    expect(__internals.findProjectDataDir(deep)).toBeUndefined();
  });


  it('reads text out of both content shapes and ignores everything else', () => {
    expect(__internals.textOf('plain')).toEqual([{ type: 'text', text: 'plain' }]);
    expect(__internals.textOf([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }])).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
    expect(__internals.textOf(undefined)).toEqual([]);
    expect(__internals.textOf(42)).toEqual([]);
  });

  it('writes the descriptor atomically and leaves no temporary file behind', () => {
    const dir = tmp('xzext-desc-');
    const path = join(dir, 'pi-leader.json');
    __internals.writeDescriptor(path, { socket: '/tmp/x/leader.sock', sessionId: 's1' });
    expect(__internals.readDescriptor(path)).toMatchObject({ schemaVersion: 1, endpoint: { socket: '/tmp/x/leader.sock' } });
    expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
  });

  it('does not throw when the descriptor cannot be written at all', () => {
    const dir = tmp('xzext-ro-');
    const path = join(dir, 'nope', 'deeper', 'pi-leader.json');
    writeFileSync(join(dir, 'blocker'), 'x');
    // A path whose parent is a FILE: mkdir fails, and the extension must stay quiet about it.
    expect(() => __internals.writeDescriptor(join(dir, 'blocker', 'pi-leader.json'), { socket: '/s', sessionId: 's' })).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });
});
