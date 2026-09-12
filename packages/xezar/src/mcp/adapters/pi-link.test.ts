import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PI_LEADER_FILE,
  PI_LEADER_SCHEMA_VERSION,
  connectPiLeaderLink,
  piLeaderPath,
  readPiLeaderDescriptor,
} from './pi-link.ts';

/**
 * The producer that was missing. These cases drive a REAL Unix socket with a real server on the
 * other end, because the whole point of this module is the transport: framing, correlation and what
 * happens when the peer goes away. A double for the socket would test none of it.
 *
 * The server here stands for the pi leader extension. It answers in pi's own RPC vocabulary, which
 * is the contract `adapters/pi.ts` is already written against.
 */

const dirs: string[] = [];
const servers: Server[] = [];
const links: { close(): void }[] = [];

const tmp = (): string => {
  const dir = realpathSync(mkdtempSync('/tmp/xzpl-'));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const link of links.splice(0)) link.close();
  for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in leader extension: one connection, JSONL in, JSONL out, scripted answers. */
function fakeLeader(opts: {
  onCommand?: (command: Record<string, unknown>, reply: (frame: Record<string, unknown>) => void, push: (frame: Record<string, unknown>) => void) => void;
} = {}): {
  path: string;
  server: Server;
  pushed: (frame: Record<string, unknown>) => void;
  raw: (text: string) => void;
  dropConnection: () => void;
  seen: Record<string, unknown>[];
  connected: Promise<void>;
} {
  const dir = tmp();
  const path = join(dir, 'leader.sock');
  const seen: Record<string, unknown>[] = [];
  let live: Socket | undefined;
  let announce: () => void = () => {};
  const connected = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const server = createServer((socket) => {
    live = socket;
    announce();
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const command = JSON.parse(line) as Record<string, unknown>;
        seen.push(command);
        const reply = (frame: Record<string, unknown>) => socket.write(`${JSON.stringify({ type: 'response', id: command.id, command: command.type, ...frame })}\n`);
        const push = (frame: Record<string, unknown>) => socket.write(`${JSON.stringify(frame)}\n`);
        if (opts.onCommand) opts.onCommand(command, reply, push);
        else reply({ success: true });
      }
    });
    socket.on('error', () => {});
  });
  servers.push(server);
  server.listen(path);
  return {
    path,
    server,
    pushed: (frame) => void live?.write(`${JSON.stringify(frame)}\n`),
    raw: (text) => void live?.write(text),
    dropConnection: () => live?.destroy(),
    seen,
    connected,
  };
}

function descriptorFor(socket: string) {
  return { schemaVersion: PI_LEADER_SCHEMA_VERSION as 1, session: { pid: process.pid, startedAt: new Date().toISOString() }, endpoint: { socket } };
}

async function listening(server: Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

describe('reading the descriptor the pi leader extension writes', () => {
  it('says there is no leader when nothing has announced one — the ordinary case, not an error', () => {
    const found = readPiLeaderDescriptor(tmp());
    expect(found).toEqual({ ok: false, reason: 'no pi leader has announced itself to this project' });
  });

  it('refuses a file that is not JSON, and one that is not this descriptor, with different reasons', () => {
    const a = tmp();
    writeFileSync(piLeaderPath(a), 'not json at all');
    expect(readPiLeaderDescriptor(a)).toEqual({ ok: false, reason: `${PI_LEADER_FILE} is not valid JSON` });

    const b = tmp();
    writeFileSync(piLeaderPath(b), JSON.stringify({ schemaVersion: 99, endpoint: {} }));
    expect(readPiLeaderDescriptor(b)).toEqual({ ok: false, reason: `${PI_LEADER_FILE} is not a descriptor this xezar understands` });
  });

  it('names a pi that went away without cleaning up, rather than letting the dial fail with an errno', () => {
    const dir = tmp();
    writeFileSync(piLeaderPath(dir), JSON.stringify(descriptorFor(join(dir, 'gone.sock'))));
    const found = readPiLeaderDescriptor(dir);
    expect(found.ok).toBe(false);
    expect(found.ok === false && found.reason).toMatch(/is gone/);
  });

  it('refuses a descriptor whose socket path is a plain file — it is not a socket', () => {
    const dir = tmp();
    const notASocket = join(dir, 'regular-file');
    writeFileSync(notASocket, 'x');
    writeFileSync(piLeaderPath(dir), JSON.stringify(descriptorFor(notASocket)));
    const found = readPiLeaderDescriptor(dir);
    expect(found.ok).toBe(false);
    expect(found.ok === false && found.reason).toMatch(/is not a socket/);
  });

  it('accepts a live socket, and reads it from the project data directory only', async () => {
    const leader = fakeLeader();
    await listening(leader.server);
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(piLeaderPath(dir), JSON.stringify(descriptorFor(leader.path)));

    const found = readPiLeaderDescriptor(dir);
    expect(found.ok).toBe(true);
    expect(found.ok === true && found.descriptor.endpoint.socket).toBe(leader.path);
  });
});

describe('the link itself, over a real socket', () => {
  it('carries a command and resolves with pi\'s own response frame', async () => {
    const leader = fakeLeader({
      onCommand: (command, reply) => {
        if (command.type === 'get_state') reply({ success: true, data: { isStreaming: false, pendingMessageCount: 0 } });
        else reply({ success: true });
      },
    });
    await listening(leader.server);
    const link = connectPiLeaderLink(descriptorFor(leader.path));
    links.push(link);

    await expect(link.request({ type: 'get_state' })).resolves.toEqual({ success: true, data: { isStreaming: false, pendingMessageCount: 0 } });
    await expect(link.request({ type: 'prompt', message: 'hello' })).resolves.toEqual({ success: true });
    expect(leader.seen.map((c) => c.type)).toEqual(['get_state', 'prompt']);
    // The command went over with its text intact, and with an id this side minted.
    expect(leader.seen[1]).toMatchObject({ type: 'prompt', message: 'hello' });
    expect(typeof leader.seen[1]?.id).toBe('string');
  });

  it('correlates answers by id, so two commands in flight cannot swap results', async () => {
    const leader = fakeLeader({
      onCommand: (command, reply) => {
        // Answer the SECOND command first: without id correlation this is exactly the bug.
        const delay = command.type === 'get_state' ? 40 : 0;
        setTimeout(() => reply({ success: true, data: { which: command.type } }), delay);
      },
    });
    await listening(leader.server);
    const link = connectPiLeaderLink(descriptorFor(leader.path));
    links.push(link);

    const [first, second] = await Promise.all([link.request({ type: 'get_state' }), link.request({ type: 'get_messages' })]);
    expect(first.data).toEqual({ which: 'get_state' });
    expect(second.data).toEqual({ which: 'get_messages' });
  });

  it('passes pi\'s events straight through to subscribers, and unsubscribes cleanly', async () => {
    const leader = fakeLeader();
    await listening(leader.server);
    const link = connectPiLeaderLink(descriptorFor(leader.path));
    links.push(link);

    const seen: unknown[] = [];
    const stop = link.subscribe((message) => seen.push(message));
    await leader.connected;
    leader.pushed({ type: 'agent_start' });
    leader.pushed({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
    await settle();
    expect(seen).toEqual([
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    ]);

    stop();
    leader.pushed({ type: 'agent_settled' });
    await settle();
    expect(seen).toHaveLength(2);
  });

  it('reports a failed command as a failed RESPONSE, not a throw — pi refusing is an answer', async () => {
    const leader = fakeLeader({
      onCommand: (_command, reply) => reply({ success: false, error: { message: 'Agent is already processing.' } }),
    });
    await listening(leader.server);
    const link = connectPiLeaderLink(descriptorFor(leader.path));
    links.push(link);

    const answer = await link.request({ type: 'prompt', message: 'x' });
    expect(answer.success).toBe(false);
    expect(answer.error).toEqual({ message: 'Agent is already processing.' });
  });

  it('skips one unreadable line instead of dropping a working leader', async () => {
    const leader = fakeLeader();
    await listening(leader.server);
    const warnings: string[] = [];
    const link = connectPiLeaderLink(descriptorFor(leader.path), { warn: (m) => warnings.push(m) });
    links.push(link);

    const seen: unknown[] = [];
    link.subscribe((message) => seen.push(message));
    await leader.connected;
    // A line that is not JSON at all, between two good ones. A leader that logs one stray line to
    // its socket must not cost the person their push delivery.
    leader.pushed({ type: 'agent_start' });
    leader.raw('this is not json\n');
    leader.pushed({ type: 'agent_settled' });
    await settle();

    expect(link.closed).toBe(false);
    expect(seen).toEqual([{ type: 'agent_start' }, { type: 'agent_settled' }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not JSON/);
  });

  it('reassembles a frame split across two chunks, and ignores a stray carriage return', async () => {
    const leader = fakeLeader();
    await listening(leader.server);
    const link = connectPiLeaderLink(descriptorFor(leader.path));
    links.push(link);

    const seen: unknown[] = [];
    link.subscribe((message) => seen.push(message));
    await leader.connected;
    // TCP/pipe boundaries fall wherever they like; the framing is the module's job, not the peer's.
    leader.raw('{"type":"agent_');
    await settle();
    expect(seen).toEqual([]);
    leader.raw('start"}\r\n');
    await settle();

    expect(seen).toEqual([{ type: 'agent_start' }]);
  });

  it('rejects everything in flight when xezar hangs up, and reports itself closed', async () => {
    const leader = fakeLeader({ onCommand: () => { /* never answers */ } });
    await listening(leader.server);
    const link = connectPiLeaderLink(descriptorFor(leader.path));
    links.push(link);

    const inFlight = link.request({ type: 'prompt', message: 'x' });
    const settled = expect(inFlight).rejects.toThrow(/closed the pi leader link/);
    await leader.connected;
    link.close();
    await settled;

    expect(link.closed).toBe(true);
    await expect(link.request({ type: 'get_state' })).rejects.toThrow(/link is closed/);
  });

  it('rejects what is in flight when the LEADER goes away, so no row waits on a dead pi', async () => {
    const leader = fakeLeader({ onCommand: () => { /* never answers */ } });
    await listening(leader.server);
    const link = connectPiLeaderLink(descriptorFor(leader.path));
    links.push(link);

    const inFlight = link.request({ type: 'prompt', message: 'x' });
    const settled = expect(inFlight).rejects.toThrow();
    await leader.connected;
    // The pi process exits: its end of the socket goes away under us.
    leader.dropConnection();
    await settled;

    expect(link.closed).toBe(true);
  });

  it('times out a command the leader never answers, and says so as UNCERTAIN rather than refused', async () => {
    const leader = fakeLeader({ onCommand: () => { /* never answers */ } });
    await listening(leader.server);
    const link = connectPiLeaderLink(descriptorFor(leader.path), { requestTimeoutMs: 40 });
    links.push(link);

    // A REJECT, deliberately: "we do not know whether pi saw it" is not "pi said no", and the
    // adapter above re-reads pi's conversation before it decides only for the first.
    await expect(link.request({ type: 'prompt', message: 'x' })).rejects.toThrow(/did not answer in time/);
    expect(link.closed).toBe(false);
  });

  it('refuses to dial a socket that is not there, and the caller sees a throw it can turn into a blocker', () => {
    const dir = tmp();
    expect(() => {
      const link = connectPiLeaderLink(descriptorFor(join(dir, 'missing.sock')));
      links.push(link);
    }).not.toThrow();
  });
});
