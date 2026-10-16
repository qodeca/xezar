/**
 * The Qwen Code inbox sender (#1045) against a socket that speaks Qwen Code 0.25.2's cross-session
 * protocol: an `auth` line, a `user` frame, and a receipt on the frame's `from` socket.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shortTmpRoot, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { QwenMessenger, isQwenClientName, qwenInboxFrom, receiptAddress } from './qwen-messaging.ts';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** `answer` decides each receipt; `null` sends none. */
async function inbox(answer: (index: number) => string | null) {
  const dir = realpathSync(mkdtempSync(join(shortTmpRoot(), 'xqm-')));
  const path = join(dir, 'inbox.sock');
  const frames: Array<Record<string, unknown>> = [];
  let index = 0;
  const server: Server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>;
        buffer = buffer.slice(at + 1);
        frames.push(frame);
        if (frame.type !== 'user') continue;
        const status = answer(index++);
        if (status === null || typeof frame.from !== 'string') continue;
        const back = createConnection({ path: frame.from });
        back.on('error', () => undefined);
        back.end(`${JSON.stringify({ msgV: 1, type: 'control', status, origMsgId: frame.msgId, reason: status === 'dropped' ? 'rate-limited' : undefined })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  cleanups.push(() => rmSync(dir, TEST_DIR_RM_OPTIONS));
  return { path, frames };
}

function messenger(path: string, opts: { receiptTimeoutMs?: number; burst?: number; now?: () => number } = {}) {
  const m = new QwenMessenger({ inbox: { socketPath: path, token: 'tok' }, ...opts });
  cleanups.push(() => m.close());
  return m;
}

describe('QwenMessenger', () => {
  it('authenticates with the child token, then sends one user frame named xezar, and resolves on delivered', async () => {
    const box = await inbox(() => 'delivered');
    await messenger(box.path).send('hello');
    expect(box.frames[0]).toEqual({ msgV: 1, type: 'auth', token: 'tok' });
    expect(box.frames[1]).toMatchObject({ msgV: 1, type: 'user', fromName: 'xezar', message: { role: 'user', content: 'hello' } });
    expect(String(box.frames[1]!.msgId)).toMatch(/^xz-/);
    expect(typeof box.frames[1]!.from).toBe('string');
  });

  it('treats held and dropped as not handed over, naming the receipt', async () => {
    const box = await inbox((i) => (i === 0 ? 'held' : 'dropped'));
    const m = messenger(box.path);
    await expect(m.send('one')).rejects.toThrow(/did not take the message \(held\)/);
    await expect(m.send('two')).rejects.toThrow(/\(dropped: rate-limited\)/);
  });

  it('fails when no receipt comes, and when the inbox is not there', async () => {
    const box = await inbox(() => null);
    await expect(messenger(box.path, { receiptTimeoutMs: 200 }).send('x')).rejects.toThrow(/\(timeout\)/);
    await expect(messenger(join(shortTmpRoot(), 'no-such-inbox.sock')).send('x')).rejects.toThrow(/could not reach the Qwen Code session's inbox/);
  });

  it('refuses at once once the burst is spent, and sends again after the refill', async () => {
    const box = await inbox(() => 'delivered');
    let now = 1_000;
    const m = messenger(box.path, { burst: 2, now: () => now });
    await m.send('a');
    await m.send('b');
    await expect(m.send('c')).rejects.toThrow(/faster than it accepts messages/);
    expect(box.frames.filter((f) => f.type === 'user')).toHaveLength(2);
    now += 2_000;
    await m.send('c');
    expect(box.frames.filter((f) => f.type === 'user').map((f) => (f.message as { content: string }).content)).toEqual(['a', 'b', 'c']);
  });
});

describe('Qwen Code identity and inbox', () => {
  it('knows Qwen Code by its MCP client-name prefix, whatever the server is called', () => {
    expect(isQwenClientName('qwen-cli-mcp-client-xezar')).toBe(true);
    expect(isQwenClientName('qwen-cli-mcp-client-my-cockpit')).toBe(true);
    expect(isQwenClientName('qwen-cli-mcp-client-')).toBe(false);
    expect(isQwenClientName('claude-code')).toBe(false);
    expect(isQwenClientName(undefined)).toBe(false);
  });

  it('needs both variables Qwen Code gives its children', () => {
    expect(qwenInboxFrom({ QWEN_CODE_MESSAGING_SOCKET: '/s', QWEN_CODE_MESSAGING_TOKEN: 't' })).toEqual({ socketPath: '/s', token: 't' });
    expect(qwenInboxFrom({ QWEN_CODE_MESSAGING_SOCKET: '/s' })).toBeUndefined();
    expect(qwenInboxFrom({ QWEN_CODE_MESSAGING_TOKEN: 't' })).toBeUndefined();
    expect(qwenInboxFrom({ QWEN_CODE_MESSAGING_SOCKET: ' ', QWEN_CODE_MESSAGING_TOKEN: 't' })).toBeUndefined();
  });

  it('listens for receipts on a socket in a private folder, and on a named pipe on Windows', () => {
    expect(receiptAddress('/tmp/x', 'id', 'linux')).toBe(join('/tmp/x', 'r.sock'));
    expect(receiptAddress('/tmp/x', 'id', 'win32')).toBe('\\\\.\\pipe\\xezar-qwen-receipt-id');
  });
});
