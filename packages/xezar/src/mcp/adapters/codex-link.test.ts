import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { CODEX_CONTROL_SOCKET, connectCodexLeader, validateControlSocket } from './codex-link.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('the shared Codex app-server link', () => {
  it('uses the private Unix socket, verifies the loaded cwd-bound thread, and resumes it without turns', async () => {
    const home = realpathSync(mkdtempSync('/tmp/xzcl-'));
    dirs.push(home);
    const control = join(home, 'app-server-control');
    mkdirSync(control, { mode: 0o700 });
    chmodSync(control, 0o700);
    const socket = join(home, CODEX_CONTROL_SOCKET);
    const server = createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (client) => client.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as { id: number; method: string };
      if (request.method === 'thread/read') client.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-1' } }));
      if (request.method === 'thread/error') {
        client.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { message: 'request refused' } }));
        return;
      }
      if (request.method === 'thread/empty') {
        client.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }));
        return;
      }
      const result = request.method === 'initialize' ? { codexHome: home }
        : request.method === 'thread/list' ? { data: [{ id: 'thread-1', cwd: realpathSync(home) }] }
        : request.method === 'thread/loaded/list' ? { data: ['thread-1'] }
        : request.method === 'thread/resume' ? { thread: { id: 'thread-1' } } : {};
      client.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    }));
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const connected = await connectCodexLeader({ codexHome: home, threadId: 'thread-1' }, home);
      expect(connected.threadId).toBe('thread-1');
      const notices: unknown[] = [];
      connected.link.subscribe((notice) => notices.push(notice));
      await connected.link.request('thread/read', { threadId: 'thread-1' });
      expect(notices).toHaveLength(1);
      await expect(connected.link.request('thread/error', {})).rejects.toThrow('request refused');
      await expect(connected.link.request('thread/empty', {})).resolves.toEqual({});
      connected.link.close();
      await expect(connected.link.request('thread/read', { threadId: 'thread-1' })).rejects.toThrow('connection is closed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects the obsolete object-shaped loaded-thread response instead of accepting a false positive', async () => {
    const home = realpathSync(mkdtempSync('/tmp/xzcl-old-shape-'));
    dirs.push(home);
    const control = join(home, 'app-server-control');
    mkdirSync(control, { mode: 0o700 });
    const socket = join(home, CODEX_CONTROL_SOCKET);
    const server = createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (client) => client.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as { id: number; method: string };
      const result = request.method === 'initialize' ? { codexHome: home }
        : request.method === 'thread/list' ? { data: [{ id: 'thread-1', cwd: home }] }
        : request.method === 'thread/loaded/list' ? { data: [{ id: 'thread-1' }] } : {};
      client.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    }));
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      await expect(connectCodexLeader({ codexHome: home, threadId: 'thread-1' }, home)).rejects.toThrow('not loaded');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refuses a non-socket endpoint', () => {
    const path = realpathSync(mkdtempSync('/tmp/xzcl-file-'));
    dirs.push(path);
    expect(() => validateControlSocket(path)).toThrow('not a Unix socket');
  });

  it('refuses a socket beneath a non-private directory before it dials', async () => {
    const home = realpathSync(mkdtempSync('/tmp/xzcl-private-'));
    dirs.push(home);
    const control = join(home, 'app-server-control');
    mkdirSync(control, { mode: 0o700 });
    const socket = join(home, CODEX_CONTROL_SOCKET);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    chmodSync(control, 0o755);
    try {
      await expect(connectCodexLeader({ codexHome: home, threadId: 'thread-1' }, home)).rejects.toThrow('not private');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('closes its own link when the server reports the announced thread as unloaded', async () => {
    const home = realpathSync(mkdtempSync('/tmp/xzcl-stale-'));
    dirs.push(home);
    const control = join(home, 'app-server-control');
    mkdirSync(control, { mode: 0o700 });
    const socket = join(home, CODEX_CONTROL_SOCKET);
    const server = createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (client) => client.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as { id: number; method: string };
      const result = request.method === 'initialize' ? { codexHome: home }
        : request.method === 'thread/list' ? { threads: [{ id: 'thread-1', cwd: realpathSync(home) }] }
        : { data: [] };
      client.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    }));
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      await expect(connectCodexLeader({ codexHome: home, threadId: 'thread-1' }, home)).rejects.toThrow('not loaded');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects a server whose initialized home or resumed thread does not match the owner announcement', async () => {
    const home = realpathSync(mkdtempSync('/tmp/xzcl-mismatch-'));
    dirs.push(home);
    const control = join(home, 'app-server-control');
    mkdirSync(control, { mode: 0o700 });
    const socket = join(home, CODEX_CONTROL_SOCKET);
    const server = createServer();
    const wss = new WebSocketServer({ server });
    let wrongHome = true;
    wss.on('connection', (client) => client.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as { id: number; method: string };
      const result = request.method === 'initialize' ? { codexHome: wrongHome ? join(home, '..') : home }
        : request.method === 'thread/list' ? { data: [{ thread: { id: 'thread-1', cwd: realpathSync(home) } }] }
        : request.method === 'thread/loaded/list' ? { data: ['thread-1'] }
        : { threadId: 'wrong-thread' };
      client.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    }));
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      await expect(connectCodexLeader({ codexHome: home, threadId: 'thread-1' }, home)).rejects.toThrow('CODEX_HOME');
      wrongHome = false;
      await expect(connectCodexLeader({ codexHome: home, threadId: 'thread-1' }, home)).rejects.toThrow('different thread');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
